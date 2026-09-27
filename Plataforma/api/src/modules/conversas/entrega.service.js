import { readFile } from 'node:fs/promises';
import { Conflito, NaoEncontrado, RegraDeNegocio, SemPermissao } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { mascarar } from '../../core/phone.js';
import { obterAdaptador } from '../../channels/gateway.js';
import { registrarEvento } from '../../channels/eventos.js';
import { caminhoDe } from '../equipe/arquivos.js';
import * as repo from './conversas.repo.js';
import { podeAgir } from './conversas.service.js';
import { assinar, obterConfiguracao } from '../equipe/equipe.config.js';

const log = comContexto({ modulo: 'entrega' });

/**
 * Entrega ao cliente das respostas escritas pelo atendente.
 *
 * Gravar a resposta na mesa de atendimento NAO a envia: durante um tempo o
 * atendente escrevia, a mensagem aparecia na tela dele com cara de enviada, e
 * o cliente nunca recebia nada. Aqui a gravacao e a entrega sao dois passos
 * separados de proposito:
 *
 *   1. a mensagem e gravada (o atendente nunca perde o que digitou);
 *   2. tentamos entrega-la ao canal, e o resultado — entregue ou o motivo da
 *      falha — fica gravado na propria mensagem.
 *
 * Se falhar (WhatsApp desconectado, numero invalido), a tela mostra o motivo e
 * um botao "Reenviar", em vez de fingir que deu certo.
 *
 * Uma queda de segundos da conexao nao vira falha: a entrega espera a conexao
 * voltar e repete sozinha o que COM CERTEZA nao saiu (ver `entregarMensagem`).
 * A fase fica gravada na mensagem (`metadados.entregaFase`), e e ela que diz,
 * num reinicio, se da para retomar ou se pode ter chegado.
 */

/** Mensagens sendo enviadas agora — dois cliques em "Reenviar" nao mandam duas vezes. */
const emAndamento = new Set();

/**
 * Le do disco o arquivo que `conversas.service.js` ja guardou ao preparar a
 * resposta (o balao no livechat mostra esse MESMO arquivo). O nome e um UUID
 * sorteado na gravacao, nunca algo vindo de fora: `caminhoDe` recusa qualquer
 * coisa que tente escapar da pasta publica.
 */
async function lerArquivoSalvo(midiaUrl) {
  const nome = String(midiaUrl ?? '').replace('/api/arquivos/', '');
  const destino = caminhoDe(nome);
  if (!destino) throw new Error('Arquivo da mensagem não encontrado.');
  return readFile(destino);
}

/**
 * O que o adaptador do canal recebe para cada tipo de mensagem.
 *
 * `assinatura` (nome do atendente, quando a empresa liga em Equipe >
 * Atendentes > Privacidade) vai no topo do texto ou da legenda. Audio e
 * anexo sem legenda nao tem onde escrever: saem sem.
 */
async function corpoDoEnvio(m, assinatura) {
  if (m.tipo === 'audio') return { audio: await lerArquivoSalvo(m.midiaUrl) };
  if (m.tipo === 'imagem' || m.tipo === 'video' || m.tipo === 'documento') {
    const legenda = m.metadados?.legenda;
    return {
      midia: {
        tipo: m.tipo,
        bytes: await lerArquivoSalvo(m.midiaUrl),
        mimetype: m.metadados?.mimetype,
        nomeArquivo: m.metadados?.nomeArquivo,
        legenda: legenda ? assinar(assinatura, legenda) : undefined
      }
    };
  }
  return { texto: assinar(assinatura, m.conteudo) };
}

/**
 * Grava o resultado da entrega, insistindo se o banco estiver ocupado.
 *
 * O SQLite so aceita UM escritor por vez (`db/client.js`); em rajada de
 * mensagens chegando (ou uma campanha disparando ao mesmo tempo) a escrita
 * pode falhar mais de uma vez seguida. Cada tentativa espera mais que a
 * anterior. Se mesmo assim nao conseguir, so entao desiste e loga um erro —
 * a mensagem fica com o resultado real (entregue ou nao) apenas na memoria
 * do processo, o que e melhor que nada mas pode se perder se o servidor cair
 * nesse meio-tempo.
 */
async function gravarComInsistencia(tenantId, mensagemId, resultado, erro, conversationId = null) {
  const ESPERAS_MS = [0, 300, 1000, 3000];
  for (let i = 0; i < ESPERAS_MS.length; i++) {
    if (ESPERAS_MS[i] > 0) await new Promise((r) => setTimeout(r, ESPERAS_MS[i]));
    try {
      await repo.gravarEntrega(tenantId, mensagemId, resultado, conversationId);
      return;
    } catch (err) {
      if (i === ESPERAS_MS.length - 1) {
        log.error({ err, mensagemId, enviada: !erro }, 'Nao foi possivel gravar o resultado da entrega');
      }
    }
  }
}

/** Quanto tempo para tras o boot procura entregas interrompidas. */
const JANELA_INTERROMPIDAS_MS = 24 * 3_600_000;

/**
 * Fases em que a mensagem com CERTEZA ainda nao tinha saido: na fila,
 * esperando a conexao ou subindo a midia. "enviando" (ou sem fase, de antes
 * deste registro existir) e ambiguo: pode ter chegado ao cliente.
 */
const FASES_ANTES_DE_SAIR = ['fila', 'aguardando_conexao', 'subindo'];

/** Interrompida ha pouco, ainda com o atendente: volta para a fila sozinha. */
const RETOMAR_ATE_MS = 10 * 60_000;

const ERRO_AMBIGUO = 'O servidor reiniciou durante o envio. Confira no celular se a mensagem chegou antes de reenviar.';
const ERRO_NAO_SAIU = 'O servidor reiniciou antes do envio: a mensagem não chegou ao cliente. Pode reenviar.';

/**
 * Respostas de atendente que estavam SAINDO quando o servidor caiu.
 *
 * A mensagem e gravada antes da entrega (o atendente nunca perde o que
 * mandou); se o processo morre no meio, ela fica sem "entregue" e sem
 * "falhou". Chamado no boot, antes de qualquer envio. Pela fase gravada:
 *   - nao tinha saido, ha menos de 10 min, conversa ainda com o atendente:
 *     `aoRetomar` a devolve para a fila (o cliente recebe, sem ninguem clicar);
 *   - nao tinha saido, mas velha ou conversa ja em outro estado: "nao
 *     chegou, pode reenviar" — um texto velho chegando sozinho seria fora de contexto;
 *   - pode ter saido: pede para conferir no celular antes de reenviar.
 *
 * So as ultimas 24 h: mensagens mais antigas vem de antes de a entrega ser
 * registrada, e ganhar um "Reenviar" agora seria so ruido.
 *
 * @returns {Promise<number>} quantas foram marcadas como nao entregues
 */
export async function marcarEntregasInterrompidas({ agora = new Date(), aoRetomar = null } = {}) {
  const pendentes = await repo.listarEntregasSemResultado({
    desde: new Date(agora.getTime() - JANELA_INTERROMPIDAS_MS),
    ate: agora
  });

  let marcadas = 0;
  for (const p of pendentes) {
    const naoSaiuAinda = FASES_ANTES_DE_SAIR.includes(p.metadados?.entregaFase);
    const recente = agora.getTime() - new Date(p.createdAt).getTime() <= RETOMAR_ATE_MS;
    if (aoRetomar && naoSaiuAinda && recente && p.conversaStatus === 'humana') {
      aoRetomar(p);
      continue;
    }
    await repo.gravarEntrega(p.tenantId, p.id, { erroEnvio: naoSaiuAinda ? ERRO_NAO_SAIU : ERRO_AMBIGUO });
    marcadas += 1;
  }
  if (marcadas > 0) log.warn({ mensagens: marcadas }, 'Respostas de atendente sem resultado de entrega marcadas como nao entregues');
  return marcadas;
}

/**
 * Ajustes de tempo da entrega. Os testes encurtam (ninguem espera 1 minuto
 * num teste); em producao ficam os padroes.
 */
export const tempos = {
  /** Conexao fora: quanto esperar ela voltar antes de desistir. */
  aguardarConexaoMs: 60_000,
  /** Novas tentativas quando a mensagem com certeza nao saiu. */
  esperasNovaTentativaMs: [3_000, 10_000],
  /** De quanto em quanto tempo olhar se a conexao voltou. */
  checarConexaoMs: 1_000,
  /** Quanto a tela espera o resultado antes de ouvir "enviando" (null = ate o fim). */
  esperaNaTelaMs: 8_000
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera a conexao voltar (no maximo `aguardarConexaoMs`). Uma queda do
 * WhatsApp costuma durar segundos (a reconexao automatica tenta em 2 s): antes,
 * a mensagem falhava na hora e o atendente tinha de reenviar na mao.
 */
async function aguardarConexao(adaptador, tenantId, chave) {
  if (typeof adaptador.estaConectada !== 'function') return true;
  const limite = Date.now() + tempos.aguardarConexaoMs;
  while (!adaptador.estaConectada(tenantId, chave)) {
    if (Date.now() >= limite) return false;
    await dormir(tempos.checarConexaoMs);
  }
  return true;
}

/**
 * Fila por conversa: as respostas saem na ORDEM em que foram escritas. Sem
 * ela, um texto escrito depois de uma foto passaria na frente enquanto a foto
 * sobe (ou espera a conexao voltar).
 */
const filas = new Map();

function naFilaDaConversa(conversationId, tarefa) {
  const anterior = filas.get(conversationId) ?? Promise.resolve();
  const atual = anterior.then(tarefa);
  const cauda = atual.catch(() => {});
  filas.set(conversationId, cauda);
  cauda.then(() => {
    if (filas.get(conversationId) === cauda) filas.delete(conversationId);
  });
  return atual;
}

/** Entregas em andamento (para os testes e o desligamento esperarem). */
export function aguardarEntregas() {
  return Promise.all([...filas.values()]);
}

/**
 * Tenta entregar uma resposta de atendente ao canal de origem.
 *
 * Entra na fila da conversa e, la dentro:
 *   1. conexao fora? espera ela voltar (ate 1 min) — "aguardando conexao";
 *   2. envia, gravando a fase (subindo a midia / enviando);
 *   3. falhou com CERTEZA de que nao saiu (conexao caiu, midia nao subiu)?
 *      tenta de novo sozinha, ate 3 vezes. Falha ambigua (pode ter chegado)
 *      nunca e repetida sozinha: o cliente receberia duas vezes.
 * O resultado fica gravado na mensagem e as telas sao avisadas.
 *
 * @param {string} tenantId
 * @param {string} conversationId
 * @param {string} mensagemId
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.reenvio]   e uma nova tentativa pedida por alguem
 * @param {object} [opcoes.usuario]    quem pediu o reenvio (para checar a permissao)
 * @returns {Promise<{ entregue: boolean, erro?: string, jaEntregue?: boolean }>}
 */
export async function entregarMensagem(tenantId, conversationId, mensagemId, { reenvio = false, usuario } = {}) {
  const linha = await repo.buscarMensagemParaEntrega(tenantId, conversationId, mensagemId);
  if (!linha) throw new NaoEncontrado('Mensagem');

  const { mensagem: m, conversa } = linha;

  if (m.direcao !== 'saida' || m.autorTipo !== 'humano') {
    throw new RegraDeNegocio('Só respostas de atendente podem ser enviadas por aqui.');
  }

  // Ja chegou ao cliente: reenviar duplicaria a mensagem na conversa dele.
  if (m.entregueEm) return { entregue: true, jaEntregue: true };

  if (reenvio) {
    if (!m.erroEnvio) throw new RegraDeNegocio('Esta mensagem não falhou; não há o que reenviar.');
    if (usuario && !(await podeAgir(tenantId, conversa, usuario))) {
      throw new SemPermissao('Esta conversa está com outro atendente.');
    }
    // Um texto velho nao pode aparecer no celular do cliente depois que a
    // conversa foi encerrada ou devolvida para a IA: chegaria fora de contexto,
    // no meio de outra conversa.
    if (conversa.status === 'finalizada') {
      throw new RegraDeNegocio('Esta conversa foi finalizada. Reabra para continuar.');
    }
    if (conversa.status !== 'humana') {
      throw new RegraDeNegocio('Esta conversa não está mais com um atendente; a mensagem não será reenviada.');
    }
  }

  // Marcado JA (antes da fila): dois cliques em "Reenviar" nao mandam duas vezes.
  if (emAndamento.has(m.id)) throw new Conflito('Esta mensagem já está sendo enviada.');
  emAndamento.add(m.id);

  // "Na fila" gravado ao ENTRAR nela (nao quando chega a vez): se o servidor
  // cair enquanto ela espera outra mensagem da conversa sair, o boot sabe que
  // esta nao saiu. Num reenvio, isto tambem tira o "nao entregue" do balao.
  try {
    await repo.marcarFaseEntrega(tenantId, conversationId, m.id, 'fila');
  } catch (err) {
    emAndamento.delete(m.id);
    throw err;
  }

  return naFilaDaConversa(conversationId, async () => {
    try {
      return await entregarAgora(tenantId, conversationId, linha, { reenvio });
    } finally {
      emAndamento.delete(m.id);
    }
  });
}

/** O trabalho de verdade, ja na vez desta mensagem na fila da conversa. */
async function entregarAgora(tenantId, conversationId, linha, { reenvio }) {
  const { mensagem: m, conversa, leadTelefone, instanciaChave, instanciaRemovida, autorNome } = linha;

  let erro = null;
  let idExterno = null;
  let tentativas = 0;
  // Achada ANTES do try (fica visivel la embaixo, no evento de log); so o
  // CALCULO dela acontece DENTRO — se `chaveDaUltimaEntrada` falhar no
  // banco, isso precisa contar como falha de envio, nao escapar sem marcar.
  let chave = instanciaChave ?? null;
  const fase = (f) => repo.marcarFaseEntrega(tenantId, conversationId, m.id, f);

  try {
    // A conexao vem da conversa; se ela nao tem, da ultima mensagem que o
    // cliente mandou. Nao existe "conta padrao": responder por um numero
    // que o cliente nunca viu seria pior do que avisar que nao deu.
    if (!chave) chave = await repo.chaveDaUltimaEntrada(tenantId, conversationId);
    if (instanciaRemovida) throw new Error('A conexão desta conversa foi removida.');
    if (!chave) throw new Error('Não foi possível descobrir por qual número esta conversa acontece.');

    const adaptador = obterAdaptador(conversa.canal);
    if (!adaptador?.enviar) throw new Error(`O canal "${conversa.canal}" não está conectado.`);
    if (!leadTelefone) throw new Error('O cliente não tem telefone cadastrado.');

    const { assinaturaAtendente } = await obterConfiguracao(tenantId);
    const corpo = await corpoDoEnvio(m, assinaturaAtendente ? autorNome : null);

    // Ja esperou a conexao o tempo todo e ela nao voltou: tentar de novo so
    // faria o atendente esperar outro minuto.
    let conexaoNaoVoltou = false;
    for (;;) {
      tentativas += 1;
      try {
        if (typeof adaptador.estaConectada === 'function' && !adaptador.estaConectada(tenantId, chave)) {
          await fase('aguardando_conexao');
          registrarEvento(tenantId, {
            chave,
            nivel: 'aviso',
            tipo: 'envio',
            mensagem: `Resposta para ${mascarar(leadTelefone)} aguardando a conexão voltar.`
          });
          // Nao voltou a tempo: o adaptador responde "nao esta conectada"
          // (erro que com certeza nao saiu) e cai no tratamento abaixo.
          conexaoNaoVoltou = !(await aguardarConexao(adaptador, tenantId, chave));
        }
        const r = await adaptador.enviar({ tenantId, instanciaChave: chave, destino: leadTelefone, ...corpo, aoFase: fase });
        idExterno = r?.idExterno ?? null;
        break;
      } catch (err) {
        const espera = tempos.esperasNovaTentativaMs[tentativas - 1];
        // So repete o que com certeza nao saiu.
        if (err?.naoSaiu && espera !== undefined && !conexaoNaoVoltou) {
          log.warn({ err: err.message, tenantId, conversationId, tentativa: tentativas }, 'Entrega nao saiu; tentando de novo');
          await fase('fila');
          await dormir(espera);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    erro = String(err?.message ?? err).slice(0, 300);
    log.warn({ err, tenantId, conversationId, tentativas }, 'Falha ao entregar resposta do atendente');
  }

  // Se o envio JA aconteceu, falhar ao gravar o resultado nao pode virar
  // "nao entregue" (o atendente reenviaria e o cliente receberia duas vezes).
  //
  // Sem ISTO gravado, a mensagem fica invisivel: nao mostra "nao entregue"
  // nem o botao Reenviar, e passa para sempre por uma resposta normal que
  // nunca chegou. Por isso insistimos bastante (o SQLite as vezes fica
  // ocupado por um instante com varias mensagens chegando juntas) antes de
  // desistir e so entao registrar no log.
  const resultado = erro ? { erroEnvio: erro } : { entregueEm: new Date(), externalId: idExterno };
  await gravarComInsistencia(tenantId, m.id, resultado, erro, conversationId);

  if (erro) {
    registrarEvento(tenantId, {
      chave,
      nivel: 'erro',
      tipo: 'envio',
      mensagem: `Resposta para ${mascarar(leadTelefone)} não foi entregue: ${erro}`
    });
    return { entregue: false, erro };
  }

  if (reenvio || tentativas > 1) {
    registrarEvento(tenantId, {
      chave,
      nivel: 'sucesso',
      tipo: 'envio',
      mensagem: `Resposta para ${mascarar(leadTelefone)} entregue${reenvio ? ' no reenvio' : ` na ${tentativas}ª tentativa`}.`
    });
  }
  return { entregue: true };
}

/**
 * Entrega esperando o resultado so ate `tempos.esperaNaTelaMs`.
 *
 * Envio normal (texto, foto com a conexao de pe) termina bem antes e a tela
 * recebe o resultado como sempre. Se a conexao caiu e a entrega esta
 * esperando ela voltar (ate 1 min), o atendente nao fica com o envio preso:
 * recebe `{ pendente: true }`, o balao mostra "enviando…"/"aguardando
 * conexão…" e o resultado chega depois pelo tempo real.
 *
 * Erros de regra (nao encontrada, "ja esta sendo enviada"...) chegam antes
 * do prazo e sobem normalmente. Falha inesperada DEPOIS do prazo: `aoFalhar`
 * (a rota usa para marcar a mensagem, senao ela ficaria sem resultado).
 */
export async function entregarComEspera(tenantId, conversationId, mensagemId, opcoes = {}, aoFalhar = null) {
  const tarefa = entregarMensagem(tenantId, conversationId, mensagemId, opcoes);
  if (tempos.esperaNaTelaMs == null) return tarefa;

  let timer;
  const prazo = new Promise((resolver) => {
    timer = setTimeout(() => resolver(null), tempos.esperaNaTelaMs);
  });
  const r = await Promise.race([tarefa, prazo]).finally(() => clearTimeout(timer));
  if (r) return r;

  tarefa.catch((err) => {
    log.error({ err, tenantId, conversationId, mensagemId }, 'Entrega em segundo plano falhou sem gravar resultado');
    aoFalhar?.(err);
  });
  return { entregue: false, pendente: true };
}
