import { and, eq } from 'drizzle-orm';
import { db, emDemonstracao } from '../db/client.js';
import { RegraDeNegocio } from '../core/errors.js';
import { channelInstances } from '../db/schema/conversations.js';
import { comContexto } from '../core/logger.js';
import { mascarar, normalizarTelefone } from '../core/phone.js';
import { colorir, negrito, resumir, separador, textoDoCliente, ver } from '../core/painel.js';
import * as leads from '../modules/leads/leads.service.js';
import * as conversas from '../modules/conversas/conversas.service.js';
import * as atendimento from '../modules/atendimento/atendimento.service.js';
import { notificarEncaminhamento } from '../modules/notificacoes/notificacoes.service.js';
import { licencaBloqueada } from '../licenca/licenca.js';
import { Agrupador } from '../modules/atendimento/agrupador.js';
import * as campanhas from '../modules/campanhas/campanhas.service.js';

const log = comContexto({ modulo: 'gateway' });

/**
 * Gateway de mensagens.
 *
 * Porta unica de entrada: WhatsApp, Telegram e qualquer canal futuro chegam
 * aqui no mesmo formato. Tudo o que e especifico de cada canal (como ler o
 * QR Code, como o JID e formado) fica no adaptador do canal; o gateway so
 * conhece "chegou texto de um numero".
 *
 * A sequencia e sempre a mesma:
 *   1. identificar o cliente (criando o cadastro se for a primeira vez)
 *   2. achar ou abrir a conversa
 *   3. gravar a mensagem recebida
 *   4. decidir se respondemos — e quem responde
 *   5. gravar e enviar a resposta
 *
 * O passo 3 acontece ANTES do 4 de proposito: mesmo que a IA falhe, ou o
 * processo caia, a mensagem do cliente ja esta salva e visivel na mesa de
 * atendimento. Perder a resposta e um problema; perder a pergunta do cliente
 * e inaceitavel.
 */

/** Adaptadores registrados, por nome de canal. */
const adaptadores = new Map();

export function registrarAdaptador(canal, adaptador) {
  adaptadores.set(canal, adaptador);
  log.info({ canal }, 'Adaptador de canal registrado');
}

/**
 * Na DEMONSTRACAO nada sai para o mundo real: responder um cliente ficticio
 * nao pode virar uma mensagem de verdade pelo numero da empresa (a conexao W1
 * da demonstracao tem o mesmo nome da real). Os envios dao certo "de mentira"
 * e conectar/parear e recusado.
 */
const ADAPTADOR_DEMONSTRACAO = Object.freeze({
  enviar: async () => ({ idExterno: `demo_${Date.now()}` }),
  fotoDePerfil: async () => null,
  conectar: async () => {
    throw new RegraDeNegocio('Na demonstração nenhum WhatsApp é conectado de verdade. Saia da demonstração para conectar o número da empresa.');
  },
  desconectar: async () => {}
});

export function obterAdaptador(canal) {
  if (emDemonstracao()) return ADAPTADOR_DEMONSTRACAO;
  return adaptadores.get(canal) ?? null;
}

/**
 * Um agrupador por empresa: a janela de espera e configuravel por cliente.
 *
 * O mapa guarda a PROMESSA do agrupador, nao o agrupador pronto. A diferenca
 * importa: montar o agrupador exige ler a configuracao no banco, o que leva
 * um instante. Se guardassemos so o resultado, tres mensagens chegando juntas
 * consultariam o mapa antes de qualquer uma preencher, e cada uma criaria o
 * SEU proprio agrupador — com buffers separados, o agrupamento nunca
 * aconteceria justamente no caso que ele existe para resolver.
 *
 * Guardando a promessa, a primeira chamada ocupa a vaga imediatamente e as
 * outras duas esperam por ela.
 */
const agrupadores = new Map();

function agrupadorDe(tenantId) {
  if (!agrupadores.has(tenantId)) {
    const promessa = atendimento
      .obterConfiguracao(tenantId)
      .then((cfg) => new Agrupador({ janelaMs: (cfg.agrupamentoSegundos ?? 8) * 1000 }))
      .catch((err) => {
        // Nao deixa uma falha de leitura envenenar a vaga para sempre.
        agrupadores.delete(tenantId);
        throw err;
      });

    agrupadores.set(tenantId, promessa);
  }
  return agrupadores.get(tenantId);
}

/** Zera o agrupador da empresa — chamado quando a configuracao muda. */
export function recarregarAgrupador(tenantId) {
  const pendente = agrupadores.get(tenantId);
  agrupadores.delete(tenantId);
  Promise.resolve(pendente)
    .then((ag) => ag?.liberarTudo())
    .catch(() => {});
}

/**
 * Um turno de resposta por vez em cada conversa.
 *
 * O agrupador junta o que chega ANTES de a IA comecar. Mas a IA leva de 3 a 20
 * segundos; se o cliente escrevia nesse meio tempo, o proximo lote ficava
 * pronto e rodava EM PARALELO, sem ver a resposta que ainda estava sendo
 * escrita — o cliente recebia duas respostas que nao conversavam entre si (e,
 * numa marcacao, duas acoes na agenda). Aqui o turno seguinte espera o
 * anterior terminar e so entao le o historico, ja com a resposta dele.
 *
 * Em memoria: vale para este processo (a API roda num processo so). A trava e
 * POR CONVERSA — clientes diferentes continuam sendo atendidos em paralelo.
 */
const turnos = new Map();

/** De quanto em quanto tempo o "digitando..." e reenviado enquanto a IA pensa. */
const RENOVAR_DIGITANDO_MS = 8000;

function naVezDaConversa(chave, tarefa) {
  const anterior = turnos.get(chave) ?? Promise.resolve();
  // Um turno que falhou nao pode travar os seguintes: o proximo roda mesmo assim.
  const atual = anterior.catch(() => {}).then(tarefa);
  const guardado = atual.catch(() => {});
  turnos.set(chave, guardado);
  // Sem turno na fila, a chave sai do mapa (nao cresce para sempre).
  guardado.then(() => {
    if (turnos.get(chave) === guardado) turnos.delete(chave);
  });
  return atual;
}

/**
 * Processa uma mensagem recebida de qualquer canal.
 *
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} p.canal              'whatsapp' | 'telegram'
 * @param {string} p.instanciaChave     qual conexao recebeu ('W1')
 * @param {string} p.remetente          telefone ou id no canal
 * @param {string} [p.nomeRemetente]    nome do perfil, quando o canal informa
 * @param {string} p.texto
 * @param {string} [p.idExterno]        id da mensagem no canal (deduplicacao)
 * @param {object} [p.midia]            { tipo, url, transcricao }
 * @param {boolean} [p.sincronizarPerfil] o canal autoriza copiar foto do perfil
 */
export async function receberMensagem({
  tenantId,
  canal = 'whatsapp',
  instanciaChave = 'W1',
  remetente,
  nomeRemetente,
  texto,
  idExterno,
  midia,
  sincronizarPerfil = false
}) {
  const conteudo = String(texto ?? '').trim();
  if (!conteudo) return { ignorada: true, motivo: 'Mensagem vazia' };

  // --- 1. Identificar o cliente ---
  let telefone;
  try {
    telefone = canal === 'whatsapp' ? normalizarTelefone(remetente) : `${canal}:${remetente}`;
  } catch (err) {
    log.warn({ canal, remetente, erro: err.message }, 'Remetente com identificador invalido');
    return { ignorada: true, motivo: 'Identificador do remetente invalido' };
  }

  const lead = await leads.encontrarOuCriarPorTelefone(
    tenantId,
    telefone,
    nomeRemetente?.trim() || `Contato ${canal}`
  );

  /**
   * Foto do perfil do WhatsApp — SEMPRE depois de o cliente ser atendido.
   *
   * Ela e enfeite de cadastro: nao pode custar um milissegundo da resposta
   * nem disputar o banco com a gravacao da conversa. Esta primeira versao
   * rodava aqui, no meio do caminho, e o efeito apareceu na suite de testes:
   * respostas atrasavam o bastante para chegar fora de hora. Por isso e
   * chamada nos pontos de saida, e nunca antes deles.
   *
   * Barata quando nao ha o que fazer: `sincronizarFoto` desiste na hora se a
   * foto ja foi buscada nos ultimos dias.
   */
  const guardarFotoDoPerfil = async () => {
    if (!sincronizarPerfil) return;
    const adaptadorDoCanal = obterAdaptador(canal);
    if (!adaptadorDoCanal?.fotoDePerfil) return;

    await leads
      .sincronizarFoto(tenantId, lead.id, () =>
        adaptadorDoCanal.fotoDePerfil({ tenantId, instanciaChave, telefone })
      )
      .catch(() => {});
  };

  /**
   * Resposta a campanha — tambem so na saida, e sem esperar.
   *
   * Se o cliente recebeu campanha nos ultimos dias, a mensagem conta como
   * resposta (e uma IA classifica se ha interesse ou recusa). Nao segura o
   * atendimento: a classificacao e contabilidade, nao conversa.
   */
  const contarRespostaDeCampanha = (textoCliente) => {
    campanhas.registrarResposta(tenantId, lead.id, textoCliente).catch((err) => {
      log.warn({ err, leadId: lead.id }, 'Falha ao registrar resposta de campanha');
    });
  };

  // --- 2. Conversa ---
  const instancia = await db.query.channelInstances.findFirst({
    where: and(eq(channelInstances.tenantId, tenantId), eq(channelInstances.chave, instanciaChave))
  });

  const conversationId = await conversas.encontrarOuAbrir(tenantId, {
    leadId: lead.id,
    canal,
    channelInstanceId: instancia?.id ?? null
  });

  // --- 3. Gravar a mensagem recebida (antes de qualquer decisao) ---
  const registro = await conversas.registrarRecebida(tenantId, conversationId, {
    conteudo,
    externalId: idExterno,
    tipo: midia?.tipo ?? 'texto',
    midiaUrl: midia?.url,
    transcricao: midia?.transcricao,
    metadados: {
      canal,
      instanciaChave,
      // A duracao vem do proprio canal. Guardar aqui deixa o player desenhar a
      // barra na hora, sem o navegador precisar baixar o audio para medir.
      ...(midia?.duracaoSegundos ? { duracaoSegundos: midia.duracaoSegundos } : {}),
      // Foto/video/documento: nome, tipo, tamanho e legenda — o livechat mostra o anexo.
      ...(midia?.metadados ?? {})
    }
  });

  if (registro.duplicada) {
    return { duplicada: true, conversationId };
  }

  log.info(
    { tenantId, canal, de: mascarar(telefone), conversationId },
    `Mensagem recebida: "${conteudo.slice(0, 60)}"`
  );

  separador();
  ver(
    'cliente',
    `${negrito(lead.nome)}  ${textoDoCliente(conteudo)}`,
    `${instanciaChave} · ${mascarar(telefone)}${midia?.tipo && midia.tipo !== 'texto' ? ` · ${midia.tipo}` : ''}`
  );

  // --- 4. Decidir se respondemos ---

  // Licenca vencida: a mensagem ja esta gravada (nada se perde), mas o
  // sistema nao responde nem distribui ate a licenca ser renovada.
  if (licencaBloqueada()) {
    ver('aviso', 'licenca vencida: mensagem gravada, sem resposta automatica');
    return { conversationId, respondido: false, motivo: 'licenca_bloqueada' };
  }

  const conversa = await conversas.obter(tenantId, conversationId);

  // Na fila, mas a Sofia volta a ajudar (casa fechada ou fila parada): ela
  // responde sabendo que o cliente espera uma pessoa. Ver sofiaAjudaNaFila.
  let aguardandoHumano = false;

  // Humano assumiu: a IA fica em silencio. Nada e mais constrangedor do que
  // uma resposta automatica caindo no meio de uma conversa com uma pessoa.
  // A excecao e o atendente que SUMIU (ha horas sem escrever): o cliente nao
  // pode falar sozinho para sempre. A conversa continua dele (horarios,
  // historico) — so a Sofia volta a responder.
  if (conversa.status === 'humana' && (await atendimento.atendenteSumiu(tenantId, conversa))) {
    await conversas.devolverParaIaAutomatico(tenantId, conversationId);
    log.info({ tenantId, conversationId }, 'Atendente sem responder ha horas; a Sofia volta a atender');
    ver('sistema', 'atendente sem responder há horas: a Sofia volta a atender esta conversa');
  } else if (conversa.status === 'humana') {
    log.debug({ conversationId }, 'Conversa com atendente humano; automacao em silencio');
    ver('sistema', 'conversa com atendente humano: a IA fica em silencio');
    await guardarFotoDoPerfil();
    contarRespostaDeCampanha(conteudo);
    return { conversationId, respondido: false, motivo: 'atendimento_humano' };
  }

  // Ja esta na fila esperando alguem: nao reenviar "ja estou chamando" a cada
  // mensagem que o cliente mandar enquanto espera. So que, com a casa fechada
  // ou a fila parada, ninguem vai aparecer logo: ai a Sofia ajuda no que puder.
  if (conversa.status === 'na_fila' && (await atendimento.sofiaAjudaNaFila(tenantId, conversa))) {
    aguardandoHumano = true;
    ver('sistema', 'cliente na fila sem ninguém assumir: a Sofia volta a ajudar enquanto espera');
  } else if (conversa.status === 'na_fila') {
    ver('sistema', 'cliente ja esta na fila: aguardando um atendente assumir');
    await guardarFotoDoPerfil();
    contarRespostaDeCampanha(conteudo);
    return { conversationId, respondido: false, motivo: 'aguardando_humano' };
  }

  /**
   * Audio que ninguem conseguiu transcrever.
   *
   * A IA responderia no escuro: ela nao ouve o arquivo, so leria o rotulo
   * "🎤 Áudio" e inventaria um assunto. Entao vale a mesma regra de quando a IA
   * falha — o cliente fala com gente. O audio ja esta gravado e toca no
   * livechat, entao quem assumir so precisa apertar o play.
   */
  if (midia?.tipo === 'audio' && !midia.transcricao) {
    await conversas.enviarParaFila(tenantId, conversationId);
    await conversas.distribuir(tenantId, conversationId).catch((err) => {
      log.warn({ err, conversationId }, 'Nao foi possivel distribuir a conversa do audio nao transcrito');
    });
    await notificarEncaminhamento(tenantId, conversationId, {
      motivo: 'O cliente mandou um audio que nao foi transcrito: ouca no livechat.'
    });
    log.info({ tenantId, conversationId }, 'Audio sem transcricao; conversa enviada para a fila');
    ver('aviso', 'áudio não transcrito: conversa enviada para a fila humana', 'alguém precisa ouvir');
    await guardarFotoDoPerfil();
    contarRespostaDeCampanha(conteudo);
    return { conversationId, respondido: false, motivo: 'audio_sem_transcricao' };
  }

  // Figurinha: fica registrada na conversa, mas ninguem responde a ela — a
  // Sofia devolvendo "🙂 Figurinha" soaria estranho.
  if (midia?.soRegistrar) {
    ver('sistema', 'figurinha recebida: registrada, sem resposta automática');
    await guardarFotoDoPerfil();
    return { conversationId, respondido: false, motivo: 'so_registrar' };
  }

  /**
   * Foto, video ou documento SEM legenda (comprovante, foto de referencia).
   *
   * A IA nao ve o arquivo — responderia no escuro. Quem precisa olhar e uma
   * pessoa: vai para a fila, com um aviso curto ao cliente de que chegou (fora
   * do horario, dizendo quando a equipe volta). Com legenda, segue o fluxo
   * normal: a Sofia responde o que o cliente escreveu.
   */
  if (midia?.semLegenda && ['imagem', 'video', 'documento', 'texto'].includes(midia.tipo)) {
    const aviso = await atendimento.avisoDeMidiaRecebida(tenantId);
    await conversas.enviarParaFila(tenantId, conversationId);
    await conversas.distribuir(tenantId, conversationId).catch((err) => {
      log.warn({ err, conversationId }, 'Nao foi possivel distribuir a conversa do arquivo sem texto');
    });
    await notificarEncaminhamento(tenantId, conversationId, {
      motivo: 'O cliente enviou um arquivo sem texto: confira no livechat.'
    });

    let erroEnvio = null;
    let idExternoSaida = null;
    try {
      const r = await obterAdaptador(canal)?.enviar?.({ tenantId, instanciaChave, destino: telefone, texto: aviso });
      idExternoSaida = r?.idExterno ?? null;
    } catch (err) {
      erroEnvio = err.message;
      log.error({ err, canal, conversationId }, 'Falha ao entregar o aviso de arquivo recebido');
    }
    // Gravado mesmo se o envio falhou: o atendente ve o que o cliente deveria ter recebido.
    await conversas.registrarEnviada(tenantId, conversationId, {
      conteudo: aviso,
      autorTipo: 'ia',
      externalId: idExternoSaida,
      erroEnvio,
      metadados: { motivo: 'midia_sem_texto' }
    });

    log.info({ tenantId, conversationId }, 'Arquivo sem texto; conversa enviada para a fila');
    ver('aviso', 'arquivo sem texto: conversa enviada para a fila humana', 'alguém precisa olhar');
    await guardarFotoDoPerfil();
    return { conversationId, respondido: true, transferido: true, motivo: 'midia_sem_texto' };
  }

  /**
   * IA desligada para ESTE cliente.
   *
   * Diferente de desligar a IA do canal: aqui alguem decidiu que esta pessoa
   * fala so com gente. Entao a conversa nao fica muda — vai para a fila e
   * (se a distribuicao automatica estiver ligada) cai com um atendente.
   *
   * Nas mensagens seguintes a conversa ja esta 'na_fila' e o retorno acima
   * cuida delas: ninguem e distribuido duas vezes.
   */
  if (lead.iaAtiva === false) {
    await conversas.enviarParaFila(tenantId, conversationId);
    await conversas.distribuir(tenantId, conversationId).catch((err) => {
      log.warn({ err, conversationId }, 'Nao foi possivel distribuir a conversa com IA desligada');
    });
    await notificarEncaminhamento(tenantId, conversationId, {
      motivo: 'Este cliente e atendido so por pessoas (IA desligada para ele).'
    });
    log.info({ tenantId, conversationId }, 'IA desligada para este cliente; conversa enviada para a fila');
    ver('sistema', 'IA desligada para este cliente: conversa enviada para a fila humana');
    await guardarFotoDoPerfil();
    contarRespostaDeCampanha(conteudo);
    return { conversationId, respondido: false, motivo: 'ia_desligada_para_o_cliente' };
  }

  if (instancia && instancia.iaHabilitada === false) {
    ver('sistema', `IA desligada neste numero (${instanciaChave}): ninguem responde automaticamente`);
    contarRespostaDeCampanha(conteudo);
    return { conversationId, respondido: false, motivo: 'ia_desligada_neste_canal' };
  }

  // --- 4b. Agrupar mensagens picotadas ---
  const agrupador = await agrupadorDe(tenantId);
  // O id vai junto: quem responde precisa saber quais mensagens formam o turno.
  const lote = await agrupador.enfileirar(`${tenantId}:${conversationId}`, conteudo, { id: registro.id });

  // Outra mensagem chegou depois desta: ela cuida do lote. Nao ha flag para
  // esquecer de checar — simplesmente nao ha o que fazer aqui.
  if (!lote.processar) {
    return { conversationId, respondido: false, motivo: 'agrupada' };
  }

  // --- 5. Responder (um turno por vez nesta conversa) ---
  return naVezDaConversa(`${tenantId}:${conversationId}`, () =>
    responderLote({ tenantId, canal, instanciaChave, telefone, lead, conversationId, lote, guardarFotoDoPerfil, contarRespostaDeCampanha, aguardandoHumano })
  );
}

/**
 * Responde um lote de mensagens do cliente. Roda SEMPRE dentro de
 * `naVezDaConversa`: quando comeca, o turno anterior desta conversa ja terminou.
 */
async function responderLote({ tenantId, canal, instanciaChave, telefone, lead, conversationId, lote, guardarFotoDoPerfil, contarRespostaDeCampanha, aguardandoHumano = false }) {
  // Enquanto esperava a vez, o turno anterior pode ter passado a conversa para
  // uma pessoa (fila ou atendente). Ai a IA nao fala mais nada: a decisao do
  // passo 4 foi tomada antes, com a conversa ainda na mao da IA. A excecao e a
  // fila em que a Sofia ja tinha sido chamada a ajudar (aguardandoHumano).
  const agora = await conversas.obter(tenantId, conversationId);
  const podeResponder = agora.status === 'bot' || (aguardandoHumano && agora.status === 'na_fila');
  if (!podeResponder) {
    ver('sistema', 'o turno anterior passou a conversa para uma pessoa: a IA nao responde este lote');
    await guardarFotoDoPerfil();
    contarRespostaDeCampanha(lote.texto);
    return { conversationId, respondido: false, motivo: agora.status === 'humana' ? 'atendimento_humano' : 'aguardando_humano' };
  }

  // Historico SEM as mensagens do proprio lote (elas vao juntas no texto) e sem
  // o que o cliente mandou depois (e do proximo turno).
  const historicoAnterior = await atendimento.historicoAntesDoLote(
    tenantId,
    conversationId,
    (lote.metas ?? []).map((m) => m.id)
  );

  /**
   * "digitando..." enquanto a IA pensa. Com a espera do agrupador (8 s) mais a
   * IA (3-20 s), o cliente olhava uma tela parada e mandava "??". O WhatsApp
   * apaga o aviso sozinho depois de uns segundos, entao ele e renovado ate a
   * resposta ficar pronta. `?.`: outros canais (e os adaptadores de teste) nao
   * tem presenca — e ela e enfeite, nunca atrasa nem derruba a resposta.
   */
  const adaptadorDoCanal = obterAdaptador(canal);
  // Protegido: um adaptador cuja presenca rejeite nao pode virar erro solto.
  const presenca = (estado) =>
    Promise.resolve(adaptadorDoCanal?.presenca?.({ tenantId, instanciaChave, destino: telefone, estado })).catch(() => {});
  const digitar = () => presenca('composing');
  digitar();
  const renovarDigitando = setInterval(digitar, RENOVAR_DIGITANDO_MS);
  // Nao segura o processo aberto (desligamento, fim dos testes).
  renovarDigitando.unref?.();

  const resposta = await atendimento.responder({
    tenantId,
    conversationId,
    leadId: lead.id,
    leadNome: lead.nome,
    texto: lote.texto,
    historico: historicoAnterior,
    aguardandoHumano
  }).finally(() => {
    clearInterval(renovarDigitando);
    presenca('paused');
  });

  const enviados = [];

  for (const [i, balao] of resposta.baloes.entries()) {
    let erroEnvio = null;
    let idExternoSaida = null;

    const adaptador = obterAdaptador(canal);
    if (adaptador?.enviar) {
      try {
        const r = await adaptador.enviar({ tenantId, instanciaChave, destino: telefone, texto: balao });
        idExternoSaida = r?.idExterno ?? null;
      } catch (err) {
        erroEnvio = err.message;
        log.error({ err, canal, conversationId }, 'Falha ao entregar mensagem ao canal');
      }
    }

    // Grava mesmo quando o envio falhou: o atendente precisa ver na tela o
    // que a IA tentou dizer e que nao chegou.
    await conversas.registrarEnviada(tenantId, conversationId, {
      conteudo: balao,
      autorTipo: resposta.respondidoPor === 'menu' ? 'menu' : 'ia',
      externalId: idExternoSaida,
      erroEnvio,
      metadados: { ...resposta.detalhes, balao: i + 1, totalBaloes: resposta.baloes.length }
    });

    enviados.push({ texto: balao, erroEnvio });

    const autor = resposta.respondidoPor === 'menu' ? 'menu' : 'sofia';
    ver(
      autor,
      `${erroEnvio ? colorir('erro', 'NAO ENTREGUE ') : ''}${resumir(balao, 150)}`,
      `${resposta.baloes.length > 1 ? `balao ${i + 1}/${resposta.baloes.length} · ` : ''}${
        erroEnvio ? resumir(erroEnvio, 60) : `enviado por ${instanciaChave}`
      }`
    );

    // Pausa curta entre baloes: imita o ritmo de quem digita, e evita que o
    // WhatsApp trate uma rajada de mensagens como comportamento de robo.
    if (i < resposta.baloes.length - 1) {
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  // Leitura de humor: depois de o cliente ja ter recebido tudo, para nao
  // adicionar latencia a resposta. Nunca lanca.
  const humor = await atendimento.avaliarHumor({
    tenantId,
    conversationId,
    leadNome: lead.nome,
    historico: [...historicoAnterior, { papel: 'user', conteudo: lote.texto }]
  });

  if (resposta.transferido) {
    ver('humano', 'conversa entregue para a fila humana', resposta.detalhes?.motivoTransferencia ? `motivo: ${resumir(resposta.detalhes.motivoTransferencia, 80)}` : undefined);
  }

  await guardarFotoDoPerfil();
  // O lote inteiro: com mensagens picotadas, a resposta e o conjunto delas.
  contarRespostaDeCampanha(lote.texto);

  // Cliente pediu humano: tenta achar quem esta livre agora — e avisa quem
  // recebeu (ou a equipe, se ficou na fila). Cliente frustrado vira
  // notificacao urgente, que so sai da tela de quem a recebeu atendendo.
  if (resposta.transferido) {
    await conversas.distribuir(tenantId, conversationId).catch((err) => {
      log.warn({ err, conversationId }, 'Nao foi possivel distribuir a conversa');
    });
    await notificarEncaminhamento(tenantId, conversationId, {
      motivo: resposta.detalhes?.motivoTransferencia ?? '',
      clienteFrustrado: resposta.detalhes?.clienteFrustrado
    });
  }

  return {
    conversationId,
    respondido: true,
    respondidoPor: resposta.respondidoPor,
    transferido: Boolean(resposta.transferido),
    baloes: enviados,
    humor: humor?.humor ?? null,
    detalhes: resposta.detalhes,
    agrupadas: lote.quantidade
  };
}

/**
 * Envia uma mensagem avulsa por um canal (usado pela mesa e pelas campanhas).
 *
 * `digitandoMs`: mostra "digitando..." ao cliente por esse tempo antes de a
 * mensagem chegar. As campanhas usam para o envio ter o ritmo de uma pessoa.
 */
export async function enviarMensagem({ tenantId, canal = 'whatsapp', instanciaChave = 'W1', destino, texto, digitandoMs = 0 }) {
  const adaptador = obterAdaptador(canal);
  if (!adaptador?.enviar) {
    throw new Error(`Canal "${canal}" nao esta conectado.`);
  }
  return adaptador.enviar({ tenantId, instanciaChave, destino, texto, digitandoMs });
}
