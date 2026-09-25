import { mascarar } from '../../core/phone.js';
import { comContexto } from '../../core/logger.js';
import { registrarEvento } from '../eventos.js';
import { transcreverAudio } from '../../ai/transcricao.js';
import { funcaoLigada } from '../../modules/funcoes/funcoes.js';
import { licencaBloqueada } from '../../licenca/licenca.js';
import { EXTENSOES_DOCUMENTO, salvarAnexo, salvarAudio } from '../../modules/equipe/arquivos.js';

const log = comContexto({ modulo: 'whatsapp' });

/**
 * O que o WhatsApp faz com cada tipo de evento que chega.
 *
 * Fica separado do adaptador (que cuida da conexao) por um motivo pratico:
 * aqui nao existe nenhuma importacao do Baileys. Cada funcao recebe o `sock`
 * pronto, entao os testes entregam um socket de mentira e conferem o que o
 * sistema FEZ com uma ligacao ou uma mensagem, sem celular nem rede.
 */

/** O que o cliente recebe quando a ligacao dele e recusada. */
export const MENSAGEM_CHAMADA_PADRAO =
  'Olá! Este número atende somente por mensagem de texto. Escreva o que você precisa por aqui que respondemos em instantes. 😊';

/** Preferencias de cada conexao. Tudo desligado ate alguem ligar. */
export const CONFIG_PADRAO = Object.freeze({
  rejeitarChamadas: false,
  marcarComoLida: false,
  sincronizarContatos: true,
  mensagemChamada: MENSAGEM_CHAMADA_PADRAO
});

/**
 * Preferencias efetivas de uma conexao: o que esta salvo por cima do padrao.
 *
 * Confere o TIPO de cada campo em vez de confiar no JSON do banco — uma
 * configuracao antiga ou editada na mao com `"rejeitarChamadas": "sim"` viraria
 * "ligado" por ser um texto nao vazio, e recusaria ligacoes sem ninguem ter
 * pedido.
 */
export function configEfetiva(config) {
  const c = config && typeof config === 'object' ? config : {};
  const texto = typeof c.mensagemChamada === 'string' ? c.mensagemChamada.trim() : '';

  return {
    rejeitarChamadas: c.rejeitarChamadas === true,
    marcarComoLida: c.marcarComoLida === true,
    // Ao contrario das outras, esta vem LIGADA: e o comportamento que o sistema
    // sempre teve. So um `false` de verdade a desliga.
    sincronizarContatos: c.sincronizarContatos !== false,
    mensagemChamada: texto || MENSAGEM_CHAMADA_PADRAO
  };
}

/** '5511999887766@s.whatsapp.net' ou '5511999887766:12@s.whatsapp.net' -> numero. */
function numeroDoJid(jid) {
  return String(jid ?? '').split('@')[0].split(':')[0];
}

/** Rotulo seguro para o console: nunca o numero inteiro. */
function rotuloDe(jid) {
  const numero = numeroDoJid(jid);
  return numero.length >= 8 ? mascarar(numero) : 'contato';
}

// ============================================================================
// LIGACOES
// ============================================================================

/** Uma pessoa que liga 5 vezes seguidas nao recebe 5 textos iguais. */
const INTERVALO_AVISO_MS = 10 * 60_000;

/** O WhatsApp pode repetir o mesmo aviso de ligacao; cada uma so vale uma vez. */
const VALIDADE_ID_MS = 5 * 60_000;

/**
 * Cria o tratador de ligacoes de UMA conexao.
 *
 * Ligacao de voz nao e atendimento: o numero da empresa e atendido por texto,
 * e uma chamada tocando no celular do dono so atrapalha. Quando a opcao esta
 * ligada, recusamos a chamada e avisamos o cliente por escrito — sem o aviso
 * ele acharia que o numero esta fora do ar.
 *
 * @param {object} p
 * @param {object} p.sock                    socket do Baileys (ou um de mentira)
 * @param {string} p.tenantId
 * @param {string} p.chave                   'W1'
 * @param {() => Promise<object>} p.lerConfig  le a config na hora (vale sem reconectar)
 * @param {() => number} [p.agora]
 */
export function criarTratadorDeChamadas({ sock, tenantId, chave, lerConfig, agora = Date.now }) {
  const idsVistos = new Map(); // idDaChamada -> instante
  const avisados = new Map(); // quem ligou -> instante do ultimo aviso

  const podar = () => {
    const t = agora();
    for (const [id, quando] of idsVistos) if (t - quando > VALIDADE_ID_MS) idsVistos.delete(id);
    for (const [quem, quando] of avisados) if (t - quando > INTERVALO_AVISO_MS) avisados.delete(quem);
  };

  const evento = (nivel, mensagem) => registrarEvento(tenantId, { chave, nivel, tipo: 'chamada', mensagem });

  return async function tratarChamadas(chamadas) {
    for (const chamada of chamadas ?? []) {
      // Nunca lanca: um evento de ligacao mal formado nao pode derrubar o
      // processo (erro dentro de callback assincrono de biblioteca vira
      // "promise rejeitada sem tratamento", e o servidor encerra).
      try {
        // So o toque inicial interessa; 'ringing', 'timeout', 'terminate'...
        // sao a mesma ligacao mudando de estado.
        if (chamada?.status !== 'offer' || chamada.isGroup) continue;
        if (!chamada.id || !chamada.from) continue;

        podar();
        if (idsVistos.has(chamada.id)) continue;
        idsVistos.set(chamada.id, agora());

        const tipo = chamada.isVideo ? 'vídeo' : 'voz';
        const quem = rotuloDe(chamada.callerPn ?? chamada.from);
        const config = configEfetiva(await lerConfig());

        if (!config.rejeitarChamadas) {
          evento('info', `Chamada de ${tipo} de ${quem} (não recusada: a opção está desligada).`);
          continue;
        }

        await sock.rejectCall(chamada.id, chamada.from);
        evento('sucesso', `Chamada de ${tipo} de ${quem} recusada automaticamente.`);
        log.info({ tenantId, chave }, 'Chamada recusada automaticamente');

        const chaveAviso = numeroDoJid(chamada.callerPn ?? chamada.from);
        if (avisados.has(chaveAviso)) continue;
        avisados.set(chaveAviso, agora());

        try {
          await sock.sendMessage(chamada.callerPn ?? chamada.from, { text: config.mensagemChamada });
          evento('info', `Aviso por texto enviado a ${quem}.`);
        } catch (err) {
          evento('aviso', `Chamada recusada, mas o aviso por texto para ${quem} não saiu: ${err.message}`);
        }
      } catch (err) {
        evento('erro', `Falha ao tratar uma chamada: ${err.message}`);
        log.warn({ err, tenantId, chave }, 'Falha ao tratar chamada');
      }
    }
  };
}

// ============================================================================
// MENSAGENS RECEBIDAS
// ============================================================================

/**
 * Tira os "envelopes" do WhatsApp: mensagem temporaria (ephemeral), de
 * visualizacao unica, documento com legenda e mensagem editada.
 *
 * O Baileys NAO faz isso ao receber (o `normalizeMessageContent` dele so e
 * usado no envio). Sem isto, o texto de quem usa mensagens temporarias
 * chegava "vazio" e era descartado: o cliente falava sozinho. A regra e a
 * mesma do Baileys, escrita aqui para este arquivo continuar sem importa-lo
 * (e testavel sem ele).
 */
export function desembrulhar(m) {
  let atual = m;
  // 5 niveis cobrem os casos reais (ex.: temporaria + visualizacao unica).
  for (let i = 0; i < 5 && atual; i++) {
    const dentro =
      atual.ephemeralMessage ||
      atual.viewOnceMessage ||
      atual.viewOnceMessageV2 ||
      atual.viewOnceMessageV2Extension ||
      atual.documentWithCaptionMessage ||
      atual.editedMessage;
    if (!dentro?.message) break;
    atual = dentro.message;
  }
  // Mensagem editada: o texto novo vem dentro do protocolMessage.
  return atual?.protocolMessage?.editedMessage ?? atual;
}

/** Extrai o texto de uma mensagem, qualquer que seja o formato. */
export function extrairTexto(msg) {
  const m = desembrulhar(msg?.message);
  if (!m) return null;

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    null
  );
}

/**
 * Descobre o numero de telefone de quem escreveu.
 *
 * O WhatsApp esta migrando os contatos para um identificador interno (LID,
 * `...@lid`) que NAO e telefone. Quando ele vem, o telefone real costuma vir
 * junto em `remoteJidAlt`. Sem um telefone nao ha como achar o cliente no CRM,
 * entao devolvemos null e quem chamou registra o motivo.
 */
export async function telefoneDoRemetente(sock, msg) {
  const jid = msg?.key?.remoteJid ?? '';

  if (jid.endsWith('@s.whatsapp.net')) return numeroDoJid(jid);

  if (jid.endsWith('@lid')) {
    const alt = msg.key.remoteJidAlt;
    if (typeof alt === 'string' && alt.endsWith('@s.whatsapp.net')) return numeroDoJid(alt);

    try {
      const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
      if (typeof pn === 'string' && pn.includes('@s.whatsapp.net')) return numeroDoJid(pn);
    } catch {
      /* sem mapeamento: cai no null abaixo */
    }
  }

  return null;
}

/**
 * Baixa e guarda um audio recebido, e prepara a transcricao (quem a roda e o
 * gateway, depois de gravar a mensagem).
 *
 * Devolve sempre o que conseguiu: se a transcricao falhar, o audio continua
 * gravado e toca no livechat — perder o recado do cliente porque a IA nao
 * respondeu seria o pior dos mundos. `null` so quando nem baixar deu certo.
 *
 * @returns {Promise<{tipo: 'audio', url: string, transcricao: null, transcrever: Function|null, duracaoSegundos: number|null}|null>}
 */
async function prepararAudio({ tenantId, chave, msg, audio, telefone, baixarMidia, transcrever, salvar }) {
  let bytes;
  try {
    bytes = await baixarMidia(msg);
  } catch (err) {
    log.warn({ err, tenantId, chave }, 'Nao foi possivel baixar o audio do WhatsApp');
    registrarEvento(tenantId, {
      chave,
      nivel: 'erro',
      tipo: 'mensagem',
      mensagem: `Não consegui baixar o áudio de ${rotuloDe(telefone)}.`
    });
    return null;
  }

  const mimetype = audio.mimetype || 'audio/ogg';

  let url;
  try {
    ({ url } = await salvar(bytes, mimetype));
  } catch (err) {
    log.warn({ err, tenantId, chave }, 'Nao foi possivel guardar o audio recebido');
    registrarEvento(tenantId, {
      chave,
      nivel: 'erro',
      tipo: 'mensagem',
      mensagem: `Não consegui guardar o áudio de ${rotuloDe(telefone)}.`
    });
    return null;
  }

  // A transcricao NAO roda aqui: vai para o gateway como uma chamada pronta.
  // Ele grava o audio primeiro (o balao aparece com "Transcrevendo..."),
  // transcreve e so entao a Sofia le o texto. `transcreverAudio` nunca lanca.
  // Transcricao desligada pelo DEV: sem texto, o gateway manda para a fila humana.
  // Licenca vencida tambem nao transcreve: seria gasto de IA sem ninguem responder.
  const podeTranscrever = !licencaBloqueada() && (await funcaoLigada(tenantId, 'transcricao_audio'));

  return {
    tipo: 'audio',
    url,
    transcricao: null,
    transcrever: podeTranscrever
      ? (detalhe) => transcrever({ tenantId, bytes, mimetype, nomeArquivo: url.split('/').pop(), conversationId: null, detalhe })
      : null,
    // O WhatsApp ja informa a duracao: usar a dele evita que a tela precise
    // baixar o arquivo inteiro so para desenhar a barra do player.
    duracaoSegundos: Number.isFinite(audio.seconds) ? audio.seconds : null
  };
}

/**
 * Figurinha, localizacao e cartao de contato: nao ha arquivo a guardar, mas
 * ha significado — vira uma linha de texto na conversa (ou null).
 */
function textoDeOutroTipo(c) {
  if (c.stickerMessage) return '🙂 Figurinha';
  const local = c.locationMessage || c.liveLocationMessage;
  if (local) return `📍 Localização: https://maps.google.com/?q=${local.degreesLatitude},${local.degreesLongitude}`;
  if (c.contactMessage) return `👤 Contato: ${c.contactMessage.displayName || 'sem nome'}`;
  return null;
}

/** Os mesmos rotulos que o livechat ja reconhece para anexos sem legenda. */
const ROTULOS_ARQUIVO = { imagem: '📷 Foto', video: '🎥 Vídeo' };
export const ROTULO_ARQUIVO_FALHOU = '📎 Arquivo (não foi possível baixar — peça para reenviar)';

/**
 * Baixa e guarda foto, video ou documento recebido.
 *
 * Usa as MESMAS regras dos anexos do livechat (`salvarAnexo`: tipos aceitos,
 * 16 MB, extensao sempre das tabelas internas). Falhou (download, tipo nao
 * aceito)? Devolve um rotulo mesmo assim: a mensagem entra na conversa e o
 * atendente sabe que o cliente mandou algo — e pede para reenviar.
 */
async function prepararArquivo({ tenantId, chave, msg, arquivo, telefone, baixarMidia, salvarArquivo, legenda }) {
  const mimetype = String(arquivo.mimetype || 'application/octet-stream').split(';')[0].trim();
  // Documento e reconhecido pela extensao do nome. PDF sem nome (acontece)
  // ganha a extensao do proprio tipo, senao o comprovante seria recusado.
  const extensaoDoTipo = Object.keys(EXTENSOES_DOCUMENTO).find((ext) => EXTENSOES_DOCUMENTO[ext] === mimetype);
  const nome = arquivo.fileName || (extensaoDoTipo ? `arquivo.${extensaoDoTipo}` : '');
  try {
    const bytes = await baixarMidia(msg);
    const salvo = await salvarArquivo(`data:${mimetype};base64,${Buffer.from(bytes).toString('base64')}`, nome);
    return {
      tipo: salvo.tipo,
      url: salvo.url,
      semLegenda: !legenda,
      rotulo: ROTULOS_ARQUIVO[salvo.tipo] ?? `📄 ${salvo.nomeArquivo}`,
      metadados: { nomeArquivo: salvo.nomeArquivo, mimetype: salvo.mimetype, bytes: salvo.bytes, legenda: legenda ?? null }
    };
  } catch (err) {
    log.warn({ err, tenantId, chave }, 'Nao foi possivel guardar o arquivo recebido');
    registrarEvento(tenantId, {
      chave,
      nivel: 'erro',
      tipo: 'mensagem',
      mensagem: `Não consegui guardar o arquivo de ${rotuloDe(telefone)}.`
    });
    return { tipo: 'texto', semLegenda: !legenda, rotulo: ROTULO_ARQUIVO_FALHOU };
  }
}

/**
 * Processa uma mensagem que chegou no WhatsApp.
 *
 * @param {object} p
 * @param {object} p.sock
 * @param {string} p.tenantId
 * @param {string} p.chave
 * @param {object} p.msg                     mensagem no formato do Baileys
 * @param {() => Promise<object>} p.lerConfig
 * @param {(m: object) => Promise<any>} p.receber   normalmente `gateway.receberMensagem`
 * @param {(msg: object) => Promise<Buffer>} [p.baixarMidia]  injetado pelo adaptador (Baileys)
 * @param {Function} [p.transcrever]  trocado nos testes, para nao chamar a API de verdade
 * @param {Function} [p.salvar]       idem, para nao escrever arquivo no disco do teste
 * @param {Function} [p.salvarArquivo] como `salvarAnexo` (foto, video, documento); trocavel nos testes
 */
export async function processarMensagem({
  sock,
  tenantId,
  chave,
  msg,
  lerConfig,
  receber,
  baixarMidia = null,
  transcrever = transcreverAudio,
  salvar = salvarAudio,
  salvarArquivo = salvarAnexo
}) {
  // `fromMe` sao as mensagens que NOS enviamos, ecoadas de volta. Processa-las
  // faria o sistema responder a si mesmo, em laco infinito.
  if (msg?.key?.fromMe) return { ignorada: 'propria' };

  const jid = msg?.key?.remoteJid ?? '';

  // Grupos (@g.us), listas de transmissao e o status (@broadcast) ficam de
  // fora. Atendimento e conversa individual; responder num grupo com 200
  // pessoas seria constrangedor e possivelmente caro.
  const individual = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
  if (!individual) return { ignorada: 'nao_individual' };

  const telefone = await telefoneDoRemetente(sock, msg);
  if (!telefone) {
    registrarEvento(tenantId, {
      chave,
      nivel: 'aviso',
      tipo: 'mensagem',
      mensagem: 'Mensagem de um contato sem número visível (identificador interno do WhatsApp) foi ignorada.'
    });
    return { ignorada: 'sem_telefone' };
  }

  const texto = extrairTexto(msg);

  /**
   * Audio: baixa e guarda ANTES de entregar ao atendimento; a transcricao
   * vai junto, pronta, e o gateway a roda depois de mostrar o balao.
   *
   * O recado de voz e a forma mais comum de escrever numa barbearia — "oi,
   * queria marcar pra sexta" em seis segundos. Sem isto, a mensagem chegava e
   * era descartada: o cliente falava sozinho.
   *
   * `midia` vai para o gateway mesmo quando a transcricao falha: o audio fica
   * guardado e toca no livechat, e la o gateway decide chamar uma pessoa.
   */
  let midia = null;
  // Sem os envelopes (temporaria, visualizacao unica...), o conteudo de verdade.
  const conteudo = desembrulhar(msg.message) ?? {};
  const audio = conteudo.audioMessage;

  if (!texto && audio && baixarMidia) {
    midia = await prepararAudio({ tenantId, chave, msg, audio, telefone, baixarMidia, transcrever, salvar });
  }

  /**
   * Foto, video e documento — com ou sem legenda (foto do corte de
   * referencia, comprovante de PIX em PDF). Antes eram DESCARTADOS: nao
   * entravam na conversa e ninguem via. Agora ficam guardados e aparecem no
   * livechat; sem legenda, o gateway chama uma pessoa (a IA nao ve o arquivo).
   */
  const arquivo = conteudo.imageMessage || conteudo.videoMessage || conteudo.documentMessage;
  if (arquivo && baixarMidia) {
    midia = await prepararArquivo({ tenantId, chave, msg, arquivo, telefone, baixarMidia, salvarArquivo, legenda: texto });
  }

  // Figurinha, localizacao, contato: viram texto. A figurinha e so registrada
  // (`soRegistrar`): a Sofia respondendo "🙂 Figurinha" nao faz sentido.
  const outroTipo = !texto && !midia ? textoDeOutroTipo(conteudo) : null;
  if (outroTipo && conteudo.stickerMessage) midia = { tipo: 'texto', soRegistrar: true };

  if (!texto && !midia && !outroTipo) {
    // Nada que se possa mostrar (reacao, aviso de protocolo...). O console
    // ainda registra se era um audio que nao deu para baixar.
    if (audio) {
      registrarEvento(tenantId, {
        chave,
        nivel: 'aviso',
        tipo: 'mensagem',
        mensagem: `Áudio de ${rotuloDe(telefone)} não pôde ser baixado.`
      });
    }
    return { ignorada: 'sem_texto' };
  }

  // "Marcar como lida" roda em paralelo com o atendimento e nunca o atrasa: a
  // resposta da IA pode demorar segundos, e o cliente nao deveria ficar sem os
  // tiques azuis por causa disso. Falhar aqui nao impede o atendimento.
  let leitura = null;
  let config = configEfetiva(null);
  try {
    config = configEfetiva(await lerConfig());
    if (config.marcarComoLida) {
      leitura = Promise.resolve(sock.readMessages([msg.key])).catch((err) => {
        log.debug({ err, tenantId, chave }, 'Nao foi possivel marcar como lida');
      });
    }
  } catch (err) {
    log.debug({ err }, 'Nao foi possivel ler a configuracao para marcar como lida');
  }

  registrarEvento(tenantId, {
    chave,
    nivel: 'info',
    tipo: 'mensagem',
    mensagem: `${midia?.tipo === 'audio' ? 'Áudio recebido' : midia?.url ? 'Arquivo recebido' : 'Mensagem recebida'} de ${rotuloDe(telefone)}.`
  });

  const resultado = await receber({
    tenantId,
    canal: 'whatsapp',
    instanciaChave: chave,
    remetente: telefone,
    midia,
    // Ligada (padrao), o nome do perfil do WhatsApp entra no cadastro de quem
    // ainda esta como "Contato WhatsApp" (o CRM nunca sobrescreve um nome que
    // alguem ja digitou). Desligada, o cadastro so recebe o rotulo generico.
    nomeRemetente: config.sincronizarContatos ? msg.pushName : undefined,
    // A foto do perfil segue a mesma chave do nome: quem desligou a
    // sincronizacao de contatos nao quer NADA do perfil no cadastro.
    sincronizarPerfil: config.sincronizarContatos,
    /**
     * Num audio, o que o cliente "escreveu" e a TRANSCRICAO.
     *
     * Ela entra como o texto da mensagem — e nao so no campo `transcricao` —
     * para que tudo que ja existe continue funcionando sem remendo: a previa da
     * conversa na lista, a busca e, principalmente, o historico que vai para a
     * Sofia. Sem transcricao, entra um rotulo curto so para a mensagem existir
     * na conversa; quem cuida disso e o gateway, que chama uma pessoa.
     */
    texto: texto ?? midia?.transcricao ?? midia?.rotulo ?? outroTipo ?? '🎤 Áudio',
    idExterno: msg.key.id
  });

  await leitura;
  return { processada: true, resultado };
}
