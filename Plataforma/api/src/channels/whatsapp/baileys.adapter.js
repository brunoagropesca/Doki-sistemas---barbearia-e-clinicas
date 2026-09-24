import { existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { channelInstances } from '../../db/schema/conversations.js';
import { comContexto } from '../../core/logger.js';
import { normalizarTelefone } from '../../core/phone.js';
import { receberMensagem, registrarAdaptador } from '../gateway.js';
import { registrarEvento } from '../eventos.js';
import { criarTratadorDeChamadas, processarMensagem } from './handlers.js';

const log = comContexto({ modulo: 'whatsapp' });

/** O Baileys e barulhento: silenciamos o log dele e ficamos com o nosso. */
const silencioso = pino({ level: 'silent' });

/**
 * Adaptador do WhatsApp via Baileys.
 *
 * O Baileys conecta como se fosse o WhatsApp Web: a pessoa le um QR Code com
 * o celular e a sessao fica salva em disco. Tudo que e especifico dessa
 * biblioteca mora neste arquivo (e no `handlers.js`) — o gateway so sabe
 * "chegou texto de um numero" e "envie este texto para aquele numero".
 *
 * Essa fronteira importa: se um dia o Baileys quebrar (ele acompanha um
 * protocolo nao-oficial e muda com frequencia) ou a empresa migrar para a
 * API oficial do WhatsApp Business, troca-se este arquivo e nada mais.
 *
 * REGRA DE OURO DESTE ARQUIVO: nenhum callback do Baileys pode lancar.
 * Os eventos dele chegam por `EventEmitter`, que nao espera nem trata a
 * promessa que o callback devolve. Uma falha solta (banco ocupado ao gravar o
 * QR, por exemplo) viraria "promise rejeitada sem tratamento" — e o `main.js`
 * encerra o processo inteiro nesse caso, derrubando TODAS as contas e o
 * atendimento por causa de uma so. Por isso cada callback passa por `guardar`.
 */

/**
 * Conexoes vivas (ou em andamento), por `tenantId:chave`.
 *
 * Cada registro e uma "geracao" da conexao. Quando ela e substituida (o
 * usuario desconectou, ou uma reconexao criou outro socket), a geracao antiga
 * sai do mapa — e todo evento que ela ainda dispare e reconhecido como velho e
 * ignorado. Sem isso, o "fechou" de um socket antigo apagaria o registro do
 * novo e agendaria uma reconexao que ninguem pediu.
 */
const conexoes = new Map();

/** Reconexoes agendadas, para poder cancelar quando alguem desconecta de proposito. */
const reconexoes = new Map();

/** Quantas quedas seguidas, para o intervalo crescer (2s, 4s, 8s... ate 60s). */
const tentativas = new Map();

const chaveDe = (tenantId, instanciaChave) => `${tenantId}:${instanciaChave}`;

/** Intervalo entre tentativas de reconexao: dobra a cada queda, com teto de 1 minuto. */
export function atrasoDeReconexao(tentativa) {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, tentativa - 1));
}

/**
 * Pontos de troca para os testes.
 *
 * `fabrica` monta o socket: a real fala com o WhatsApp, a de teste devolve um
 * socket de mentira. `agendar` e o relogio da reconexao. `baixarMidia` entrega
 * os bytes de um audio sem rede — a funcao real precisa das chaves de
 * criptografia de uma mensagem de verdade do WhatsApp — e `transcrever` evita
 * chamar a API de transcricao de verdade.
 */
export const ganchosDeTeste = { fabrica: null, agendar: null, baixarMidia: null, transcrever: null };

/** Pasta onde ficam as credenciais. Equivalem a estar logado na conta. */
function caminhoDeAuth(tenantId, instanciaChave) {
  return resolve(env.WHATSAPP_AUTH_DIR, tenantId, instanciaChave);
}

function pastaDeAuth(tenantId, instanciaChave) {
  const caminho = caminhoDeAuth(tenantId, instanciaChave);
  mkdirSync(caminho, { recursive: true });
  return caminho;
}

/** Ha sessao salva para esta conta? (Reconectar sem ela so geraria QR de novo.) */
function temSessaoSalva(tenantId, instanciaChave) {
  return existsSync(resolve(caminhoDeAuth(tenantId, instanciaChave), 'creds.json'));
}

async function atualizarInstancia(tenantId, instanciaChave, campos) {
  await db
    .update(channelInstances)
    .set(campos)
    .where(
      and(
        eq(channelInstances.tenantId, tenantId),
        eq(channelInstances.chave, instanciaChave),
        isNull(channelInstances.deletedAt)
      )
    );
}

/** Le a configuracao da conexao na hora — assim mudar uma opcao vale sem reconectar. */
async function lerConfig(tenantId, instanciaChave) {
  const linha = await db.query.channelInstances.findFirst({
    columns: { config: true },
    where: and(
      eq(channelInstances.tenantId, tenantId),
      eq(channelInstances.chave, instanciaChave),
      isNull(channelInstances.deletedAt)
    )
  });
  return linha?.config ?? {};
}

/**
 * Executa um callback assincrono sem deixar nenhuma falha escapar.
 * Veja "REGRA DE OURO" no topo do arquivo.
 */
function guardar(contexto, funcao) {
  return (...args) => {
    Promise.resolve()
      .then(() => funcao(...args))
      .catch((err) => log.error({ err, ...contexto }, 'Falha ao tratar evento do WhatsApp'));
  };
}

/** Espera uma promessa por no maximo `ms`; nao trava se o WhatsApp nao responder. */
function comPrazo(promessa, ms) {
  let timer;
  const prazo = new Promise((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(new Error('O WhatsApp nao respondeu a tempo.')), ms);
    timer.unref?.();
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(timer));
}

/** Monta o socket real. E o unico trecho que fala com a biblioteca. */
async function criarSocketReal({ tenantId, instanciaChave }) {
  const pasta = pastaDeAuth(tenantId, instanciaChave);
  const { state, saveCreds } = await useMultiFileAuthState(pasta);

  // Versao do protocolo: o WhatsApp recusa versoes muito antigas. Buscar a
  // mais nova e melhor esforco — se a rede falhar, usa a que veio na biblioteca.
  let version;
  try {
    const r = await comPrazo(fetchLatestBaileysVersion(), 5_000);
    if (r?.version) version = r.version;
  } catch {
    /* segue com a versao embutida */
  }

  const sock = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    // O Baileys e barulhento: em nivel normal ele despeja o protocolo inteiro
    // no terminal. Silenciamos e registramos so o que importa.
    logger: silencioso,
    // Nao marcamos presenca "online" permanente: isso faz o WhatsApp do dono
    // parar de notificar no celular dele.
    markOnlineOnConnect: false,
    // O historico antigo nao interessa (a IA nao pode responder conversa velha).
    syncFullHistory: false,
    browser: ['Plataforma Atendimento', 'Chrome', '1.0.0']
  });

  return { sock, state, saveCreds };
}

const evento = (tenantId, chave, nivel, mensagem, tipo = 'conexao') =>
  registrarEvento(tenantId, { chave, nivel, tipo, mensagem });

function cancelarReconexao(id) {
  const timer = reconexoes.get(id);
  if (timer) clearTimeout(timer);
  reconexoes.delete(id);
}

/** Encerra o socket sem lancar, qualquer que seja o estado dele. */
function encerrarSocket(sock) {
  try {
    sock?.end?.(undefined);
  } catch (err) {
    log.debug({ err }, 'Erro ao encerrar socket (ignorado)');
  }
}

/**
 * Conecta (ou reconecta) uma instancia.
 *
 * Devolve assim que a conexao comeca — o QR Code chega depois, por evento, e
 * e gravado no banco para a tela buscar. Esperar o QR aqui deixaria a
 * requisicao HTTP pendurada por segundos.
 */
export async function conectar(tenantId, instanciaChave = 'W1', { automatica = false } = {}) {
  const id = chaveDe(tenantId, instanciaChave);

  if (conexoes.has(id)) {
    log.debug({ id }, 'Instancia ja conectada ou conectando');
    return { jaAtiva: true };
  }

  cancelarReconexao(id);

  // O registro entra no mapa ANTES de qualquer `await`. Duas chamadas quase
  // simultaneas (dois cliques em "Conectar", ou a reconexao automatica no
  // mesmo instante) sao serializadas pelo `conexoes.has` acima; se o registro
  // so entrasse depois de montar o socket, as duas passariam pela checagem e
  // abririam dois sockets para a mesma conta — o WhatsApp derruba um dos dois
  // com "conexao substituida", e cada um derruba o outro em ciclo.
  const registro = { tenantId, instanciaChave, sock: null, aberta: false, encerrando: false, qrGerados: 0 };
  conexoes.set(id, registro);

  let montado;
  try {
    // Marca "conectando" so quando uma conexao nova de fato comeca (a chamada
    // que so encontra uma conexao viva nao passa por aqui). Numa reconexao
    // automatica a mensagem da queda continua visivel; num pedido manual, o
    // erro antigo sai de cena.
    await atualizarInstancia(tenantId, instanciaChave, {
      status: 'conectando',
      qrCode: null,
      qrExpiraEm: null,
      ...(automatica ? {} : { ultimoErro: null })
    });

    montado = await (ganchosDeTeste.fabrica ?? criarSocketReal)({ tenantId, instanciaChave });
  } catch (err) {
    if (conexoes.get(id) === registro) conexoes.delete(id);
    evento(tenantId, instanciaChave, 'erro', `Não foi possível iniciar a conexão: ${err.message}`);
    await atualizarInstancia(tenantId, instanciaChave, { status: 'erro', ultimoErro: err.message }).catch(() => {});
    throw err;
  }

  const { sock, state, saveCreds } = montado;
  registro.sock = sock;

  // Alguem mandou desconectar enquanto o socket era montado.
  if (registro.encerrando) {
    encerrarSocket(sock);
    return { cancelada: true };
  }

  sock.ev.on('creds.update', guardar({ id }, () => saveCreds()));

  sock.ev.on(
    'connection.update',
    guardar({ id }, (ev) => aoMudarConexao(registro, state, ev))
  );

  sock.ev.on(
    'messages.upsert',
    guardar({ id }, async ({ messages, type }) => {
      if (conexoes.get(id) !== registro) return;

      // 'notify' = mensagem chegando agora. Os outros tipos sao sincronizacao
      // de historico; processa-los faria a IA responder conversas antigas.
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
          await processarMensagem({
            sock,
            tenantId,
            chave: instanciaChave,
            msg,
            lerConfig: () => lerConfig(tenantId, instanciaChave),
            receber: receberMensagem,
            /**
             * Baixa o arquivo de uma mensagem de midia (o audio do cliente).
             *
             * Fica aqui, e nao no `handlers.js`, porque so este arquivo conhece
             * o Baileys: e o que mantem os handlers testaveis sem celular nem
             * rede. O `reuploadRequest` cobre o caso do WhatsApp ter tirado o
             * arquivo do ar — ele pede ao aparelho para mandar de novo.
             */
            baixarMidia:
              ganchosDeTeste.baixarMidia ??
              ((mensagem) =>
                downloadMediaMessage(mensagem, 'buffer', {}, { logger: silencioso, reuploadRequest: sock.updateMediaMessage })),
            ...(ganchosDeTeste.transcrever ? { transcrever: ganchosDeTeste.transcrever } : {})
          });
        } catch (err) {
          evento(tenantId, instanciaChave, 'erro', `Falha ao processar uma mensagem recebida: ${err.message}`, 'mensagem');
          log.error({ err, id }, 'Falha ao processar mensagem recebida');
        }
      }
    })
  );

  const tratarChamadas = criarTratadorDeChamadas({
    sock,
    tenantId,
    chave: instanciaChave,
    lerConfig: () => lerConfig(tenantId, instanciaChave)
  });

  sock.ev.on(
    'call',
    guardar({ id }, (chamadas) => {
      if (conexoes.get(id) !== registro) return;
      return tratarChamadas(chamadas);
    })
  );

  return { conectando: true };
}

/**
 * Reage a uma mudanca de estado da conexao: QR, aberta ou fechada.
 */
async function aoMudarConexao(registro, state, { connection, lastDisconnect, qr }) {
  const { tenantId, instanciaChave } = registro;
  const id = chaveDe(tenantId, instanciaChave);

  // Evento de uma geracao que ja foi substituida ou encerrada.
  if (conexoes.get(id) !== registro) return;

  if (qr) {
    registro.qrGerados += 1;

    // Guardamos como imagem pronta: a tela so precisa exibir.
    const dataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
    await atualizarInstancia(tenantId, instanciaChave, {
      status: 'aguardando_qr',
      qrCode: dataUrl,
      // O primeiro QR vale ~60s; os seguintes, ~20s. A tela usa isto pra saber
      // quando esperar um novo em vez de mostrar um codigo morto.
      qrExpiraEm: new Date(Date.now() + (registro.qrGerados === 1 ? 60_000 : 20_000))
    });

    if (registro.qrGerados === 1) {
      evento(tenantId, instanciaChave, 'info', 'QR Code gerado. Leia pelo WhatsApp do celular.', 'qr');
    }
    log.info({ id }, 'QR Code gerado — leia pelo WhatsApp do celular');
  }

  if (connection === 'open') {
    registro.aberta = true;
    tentativas.delete(id);

    const numero = registro.sock?.user?.id?.split(':')[0] ?? null;
    await atualizarInstancia(tenantId, instanciaChave, {
      status: 'conectado',
      identificador: numero,
      nomePerfil: registro.sock?.user?.name ?? null,
      qrCode: null,
      qrExpiraEm: null,
      ultimoErro: null,
      conectadoEm: new Date()
    });

    evento(tenantId, instanciaChave, 'sucesso', 'WhatsApp conectado.');
    log.info({ id }, 'WhatsApp conectado');
    return;
  }

  if (connection === 'close') {
    registro.aberta = false;
    conexoes.delete(id);
    await aoFecharConexao(registro, state, lastDisconnect);
  }
}

/**
 * Decide o que fazer quando a conexao fecha.
 *
 * Nem toda queda merece reconexao. Reconectar as cegas e o que transforma um
 * problema simples num laco infinito de tentativas — e num numero de WhatsApp
 * marcado como suspeito por ficar batendo na porta.
 */
async function aoFecharConexao(registro, state, lastDisconnect) {
  const { tenantId, instanciaChave } = registro;
  const id = chaveDe(tenantId, instanciaChave);

  // O Baileys usa erros no formato Boom, que carregam o codigo em
  // `output.statusCode`. Lemos direto em vez de importar @hapi/boom:
  // ele e dependencia transitiva do Baileys, e depender de dependencia
  // de terceiro quebra sem aviso quando eles trocam de biblioteca.
  const motivo = lastDisconnect?.error?.output?.statusCode;
  const detalhe = lastDisconnect?.error?.message ?? null;
  const jaPareada = Boolean(state?.creds?.me);

  const parar = async ({ status, mensagem, nivel = 'erro', apagarSessao = false }) => {
    await atualizarInstancia(tenantId, instanciaChave, {
      status,
      ultimoErro: mensagem,
      qrCode: null,
      qrExpiraEm: null
    });
    if (apagarSessao) {
      await rm(caminhoDeAuth(tenantId, instanciaChave), { recursive: true, force: true }).catch(() => {});
    }
    tentativas.delete(id);
    evento(tenantId, instanciaChave, nivel, mensagem);
    log.warn({ id, motivo }, mensagem);
  };

  // A pessoa desconectou pelo celular ("Aparelhos conectados"). As credenciais
  // nao servem mais; reconectar com elas entraria num laco de erro.
  if (motivo === DisconnectReason.loggedOut) {
    return parar({
      status: 'desconectado',
      mensagem: 'A sessão foi encerrada pelo celular. É preciso ler o QR Code de novo.',
      nivel: 'aviso',
      apagarSessao: true
    });
  }

  // A mesma conta foi aberta em outro lugar. Se reconectassemos, os dois
  // lados se derrubariam para sempre, um de cada vez.
  if (motivo === DisconnectReason.connectionReplaced) {
    return parar({
      status: 'erro',
      mensagem: 'Esta conta foi aberta em outro computador ou sistema. Clique em Conectar para retomar por aqui.'
    });
  }

  // Sessao corrompida ou incompativel: nao ha como consertar reconectando.
  if (motivo === DisconnectReason.badSession || motivo === DisconnectReason.multideviceMismatch) {
    return parar({
      status: 'desconectado',
      mensagem: 'A sessão salva ficou inválida. É preciso ler o QR Code de novo.',
      apagarSessao: true
    });
  }

  // Conta restrita pelo WhatsApp: insistir so piora.
  if (motivo === DisconnectReason.forbidden) {
    return parar({
      status: 'erro',
      mensagem: 'O WhatsApp recusou esta conta (acesso proibido). Verifique o número no celular.'
    });
  }

  // O socket foi encerrado por nossa causa logo apos o pareamento: o WhatsApp
  // exige abrir uma conexao nova assim que o QR e lido. E o fluxo normal, nao um erro.
  if (motivo === DisconnectReason.restartRequired) {
    evento(tenantId, instanciaChave, 'info', 'Conta pareada. Reiniciando a conexão...');
    return agendarReconexao(tenantId, instanciaChave, 0);
  }

  // Ninguem leu o QR Code a tempo: o Baileys desiste sozinho depois de umas
  // seis rodadas. Reconectar geraria QR novo para sempre, sem ninguem olhando.
  if (!jaPareada) {
    return parar({
      status: 'desconectado',
      mensagem: 'O QR Code expirou sem ser lido. Clique em Conectar para gerar outro.',
      nivel: 'aviso'
    });
  }

  // Queda de rede ou instabilidade do WhatsApp: tenta voltar, com intervalo
  // crescente para nao martelar o servidor.
  const n = (tentativas.get(id) ?? 0) + 1;
  tentativas.set(id, n);
  const atraso = atrasoDeReconexao(n);

  await atualizarInstancia(tenantId, instanciaChave, {
    status: 'conectando',
    ultimoErro: `Conexão caiu${detalhe ? ` (${detalhe})` : ''}. Nova tentativa em ${Math.round(atraso / 1000)}s.`,
    qrCode: null,
    qrExpiraEm: null
  });
  evento(tenantId, instanciaChave, 'aviso', `Conexão caiu. Tentativa ${n} de reconexão em ${Math.round(atraso / 1000)}s.`);
  log.warn({ id, motivo, tentativa: n }, 'Conexao caiu; reconectando');

  agendarReconexao(tenantId, instanciaChave, atraso);
}

function agendarReconexao(tenantId, instanciaChave, atraso) {
  const id = chaveDe(tenantId, instanciaChave);
  cancelarReconexao(id);

  const executar = () => {
    reconexoes.delete(id);
    conectar(tenantId, instanciaChave, { automatica: true }).catch((err) => {
      // Falhou ate em montar o socket: entra de novo no ciclo, com o atraso maior.
      log.error({ err, id }, 'Falha ao reconectar');
      const n = (tentativas.get(id) ?? 0) + 1;
      tentativas.set(id, n);
      agendarReconexao(tenantId, instanciaChave, atrasoDeReconexao(n));
    });
  };

  if (ganchosDeTeste.agendar) {
    reconexoes.set(id, ganchosDeTeste.agendar(executar, atraso));
    return;
  }

  const timer = setTimeout(executar, atraso);
  // Um timer de reconexao nao pode, sozinho, impedir o processo de encerrar.
  timer.unref?.();
  reconexoes.set(id, timer);
}

/**
 * Foto e video vao como MIDIA (aparecem na conversa do cliente, com previa);
 * o resto vai como documento, com o nome original — e o que o cliente ve e salva.
 */
function conteudoDeMidia({ tipo, bytes, mimetype, nomeArquivo, legenda }) {
  const caption = legenda || undefined;
  if (tipo === 'imagem') return { image: bytes, caption, mimetype };
  if (tipo === 'video') return { video: bytes, caption, mimetype };
  return { document: bytes, mimetype: mimetype || 'application/octet-stream', fileName: nomeArquivo || 'arquivo', caption };
}

/**
 * Envia uma mensagem de texto, um audio (mensagem de voz) ou um anexo.
 *
 * `audio` chega ja em ogg/opus — `conversas.service.js` faz essa conversao
 * antes de guardar o arquivo, entao aqui e so repassar os bytes. `ptt: true`
 * e o que faz o WhatsApp desenhar a bolha de MICROFONE com a onda sonora, em
 * vez de um anexo de audio generico — e o mesmo formato que o proprio app
 * grava, entao o cliente nem percebe que nao foi gravado por uma pessoa ali.
 *
 * Com `digitandoMs`, o cliente ve "digitando..." (ou "gravando audio..." para
 * PTT) por esse tempo antes de a mensagem chegar — o que uma pessoa de
 * verdade mostraria. E enfeite: se o aviso de presenca falhar, a mensagem sai
 * do mesmo jeito.
 */
export async function enviar({ tenantId, instanciaChave = 'W1', destino, texto, audio, midia, digitandoMs = 0 }) {
  const conexao = conexoes.get(chaveDe(tenantId, instanciaChave));

  if (!conexao?.aberta) {
    throw new Error(`A conexão "${instanciaChave}" do WhatsApp não está conectada.`);
  }

  const numero = normalizarTelefone(destino);
  const jid = `${numero}@s.whatsapp.net`;

  if (digitandoMs > 0 && conexao.sock.sendPresenceUpdate) {
    try {
      await conexao.sock.presenceSubscribe?.(jid);
      await conexao.sock.sendPresenceUpdate(audio ? 'recording' : 'composing', jid);
      await new Promise((r) => setTimeout(r, digitandoMs));
      await conexao.sock.sendPresenceUpdate('paused', jid);
    } catch (err) {
      log.debug({ err: err.message }, 'Nao foi possivel mostrar "digitando"; enviando assim mesmo');
    }
  }

  const conteudo = audio
    ? { audio, mimetype: 'audio/ogg; codecs=opus', ptt: true }
    : midia
      ? conteudoDeMidia(midia)
      : { text: texto };

  // Sem prazo, uma conexao "meio morta" deixaria o atendente esperando para
  // sempre. Se estourar, a mensagem PODE ter saido: o texto diz para conferir
  // no celular antes de reenviar (senao o cliente recebe duas vezes).
  let r;
  try {
    r = await comPrazo(conexao.sock.sendMessage(jid, conteudo), 30_000);
  } catch (err) {
    if (/a tempo/.test(err.message)) {
      throw new Error('O WhatsApp não confirmou o envio. Confira no celular se a mensagem saiu antes de reenviar.');
    }
    throw err;
  }
  return { idExterno: r?.key?.id ?? null };
}

/**
 * URL da foto de perfil de um numero, ou null.
 *
 * O WhatsApp so entrega a foto de quem deixou o perfil visivel; para os
 * demais a chamada simplesmente falha, e isso NAO e erro — e a resposta
 * "esta pessoa nao mostra a foto". Por isso devolvemos null em vez de lancar:
 * quem chamou esta enfeitando um cadastro, nao fazendo algo essencial.
 *
 * A URL devolvida e assinada e expira em poucas horas. Ela serve para baixar
 * a imagem AGORA; guardar o link no banco daria uma foto quebrada amanha.
 */
export async function fotoDePerfil({ tenantId, instanciaChave = 'W1', telefone }) {
  const conexao = conexoes.get(chaveDe(tenantId, instanciaChave));
  if (!conexao?.aberta) return null;

  const jid = `${normalizarTelefone(telefone)}@s.whatsapp.net`;

  try {
    const url = await comPrazo(conexao.sock.profilePictureUrl(jid, 'image'), 10_000);
    return typeof url === 'string' && url.startsWith('http') ? url : null;
  } catch {
    // Perfil sem foto, restrito a contatos, ou conexao instavel.
    return null;
  }
}

/**
 * Desconecta. `sair: true` invalida a sessao (e exige novo QR Code); sem ele a
 * sessao fica salva e da para voltar com um clique.
 */
export async function desconectar(tenantId, instanciaChave = 'W1', { sair = false } = {}) {
  const id = chaveDe(tenantId, instanciaChave);
  cancelarReconexao(id);
  tentativas.delete(id);

  const registro = conexoes.get(id);

  if (registro) {
    // Marca e tira do mapa ANTES de fechar: o evento "fechou" que o socket vai
    // disparar agora e reconhecido como de uma geracao encerrada e nao agenda
    // reconexao. (Sem isto, "desconectar" religava sozinho 5 segundos depois.)
    registro.encerrando = true;
    conexoes.delete(id);

    if (registro.sock) {
      try {
        if (sair) await comPrazo(registro.sock.logout(), 8_000);
        else encerrarSocket(registro.sock);
      } catch (err) {
        log.debug({ err, id }, 'Erro ao encerrar socket (ignorado)');
        encerrarSocket(registro.sock);
      }
    }
  }

  if (sair) {
    await rm(caminhoDeAuth(tenantId, instanciaChave), { recursive: true, force: true }).catch(() => {});
  }

  await atualizarInstancia(tenantId, instanciaChave, {
    status: 'desconectado',
    qrCode: null,
    qrExpiraEm: null,
    ultimoErro: null,
    ...(sair ? { identificador: null, nomePerfil: null, conectadoEm: null } : {})
  });

  evento(
    tenantId,
    instanciaChave,
    'aviso',
    sair ? 'Conta desconectada e sessão encerrada. Será preciso ler o QR Code de novo.' : 'Conexão encerrada. A sessão continua salva.'
  );

  return { ok: true };
}

/** A conexao esta aberta e pronta para enviar? */
export function estaConectada(tenantId, instanciaChave = 'W1') {
  return conexoes.get(chaveDe(tenantId, instanciaChave))?.aberta === true;
}

/**
 * Reconecta no boot as instancias que estavam em uso.
 *
 * Sem isto, todo reinicio do servidor exigiria que alguem lesse o QR de novo
 * em cada numero — inviavel para um sistema que roda sozinho.
 *
 * Conta como "em uso" quem estava conectado, tentando conectar ou com erro
 * (uma queda de rede no momento em que o servidor caiu nao pode aposentar a
 * conta) e ainda tem sessao salva. Quem foi DESCONECTADO de proposito fica
 * desconectado.
 */
export async function reconectarInstanciasSalvas() {
  // Um QR Code que ficou gravado de antes do reinicio nao serve mais (o socket
  // que o gerou morreu junto com o processo). Sem esta limpeza a tela mostraria
  // para sempre um QR morto, "aguardando leitura".
  await db
    .update(channelInstances)
    .set({ status: 'desconectado', qrCode: null, qrExpiraEm: null })
    .where(and(eq(channelInstances.canal, 'whatsapp'), eq(channelInstances.status, 'aguardando_qr')));

  const salvas = await db
    .select()
    .from(channelInstances)
    .where(
      and(
        eq(channelInstances.canal, 'whatsapp'),
        eq(channelInstances.ativo, true),
        isNull(channelInstances.deletedAt),
        inArray(channelInstances.status, ['conectado', 'conectando', 'erro'])
      )
    );

  for (const instancia of salvas) {
    if (!temSessaoSalva(instancia.tenantId, instancia.chave)) {
      await atualizarInstancia(instancia.tenantId, instancia.chave, {
        status: 'desconectado',
        ultimoErro: 'A sessão salva não foi encontrada. É preciso ler o QR Code de novo.'
      }).catch(() => {});
      continue;
    }

    try {
      await conectar(instancia.tenantId, instancia.chave, { automatica: true });
      evento(instancia.tenantId, instancia.chave, 'info', 'Reconectando a sessão salva ao iniciar o sistema.');
    } catch (err) {
      log.warn({ err, chave: instancia.chave }, 'Nao foi possivel reconectar a instancia');
    }
  }
}

/**
 * Encerra todas as conexoes sem apagar sessao — usado no desligamento.
 * Fecha os sockets antes do banco: um evento de "fechou" chegando depois
 * tentaria gravar num banco que ja nao existe.
 */
export function encerrarTodas() {
  for (const timer of reconexoes.values()) clearTimeout(timer);
  reconexoes.clear();

  for (const [id, registro] of conexoes) {
    registro.encerrando = true;
    encerrarSocket(registro.sock);
    conexoes.delete(id);
  }
  tentativas.clear();
}

/** Registra este adaptador no gateway. */
export function instalarAdaptadorWhatsapp() {
  registrarAdaptador('whatsapp', { enviar, conectar, desconectar, estaConectada, fotoDePerfil });
}
