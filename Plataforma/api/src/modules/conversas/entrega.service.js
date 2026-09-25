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
async function gravarComInsistencia(tenantId, mensagemId, resultado, erro) {
  const ESPERAS_MS = [0, 300, 1000, 3000];
  for (let i = 0; i < ESPERAS_MS.length; i++) {
    if (ESPERAS_MS[i] > 0) await new Promise((r) => setTimeout(r, ESPERAS_MS[i]));
    try {
      await repo.gravarEntrega(tenantId, mensagemId, resultado);
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
 * Respostas de atendente que estavam SAINDO quando o servidor caiu.
 *
 * A mensagem e gravada antes da entrega (o atendente nunca perde o que
 * mandou); se o processo morre no meio do envio, ela fica sem "entregue" e sem
 * "falhou" — a tela a mostra como enviada, sem selo e sem botao Reenviar. Foi o
 * que aconteceu com o audio que derrubou o servidor. Chamado no boot, antes de
 * qualquer envio: nada pode estar saindo nesse instante.
 *
 * So as ultimas 24 h: mensagens mais antigas que isso vem de antes de a
 * entrega ser registrada, e ganhar um "Reenviar" agora seria so ruido.
 *
 * @returns {Promise<number>} quantas foram marcadas
 */
export async function marcarEntregasInterrompidas({ agora = new Date() } = {}) {
  const n = await repo.marcarEntregasSemResultado({
    desde: new Date(agora.getTime() - JANELA_INTERROMPIDAS_MS),
    ate: agora,
    // Pode ter saido antes da queda: o texto pede para conferir antes de reenviar.
    erroEnvio: 'O servidor reiniciou durante o envio. Confira no celular se a mensagem chegou antes de reenviar.'
  });
  if (n > 0) log.warn({ mensagens: n }, 'Respostas de atendente sem resultado de entrega marcadas como nao entregues');
  return n;
}

/**
 * Tenta entregar uma resposta de atendente ao canal de origem.
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

  const { mensagem: m, conversa, leadTelefone, instanciaChave, instanciaRemovida, autorNome } = linha;

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

  if (emAndamento.has(m.id)) throw new Conflito('Esta mensagem já está sendo enviada.');
  emAndamento.add(m.id);

  let erro = null;
  let idExterno = null;
  // Achada ANTES do try (fica visivel la embaixo, no evento de log); so o
  // CALCULO dela agora acontece DENTRO — se `chaveDaUltimaEntrada` falhar no
  // banco, isso precisa contar como falha de envio, nao escapar sem marcar
  // nada (o que deixava `emAndamento` travado pra sempre nessa mensagem).
  let chave = instanciaChave ?? null;

  try {
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
      const r = await adaptador.enviar({
        tenantId,
        instanciaChave: chave,
        destino: leadTelefone,
        ...(await corpoDoEnvio(m, assinaturaAtendente ? autorNome : null))
      });
      idExterno = r?.idExterno ?? null;
    } catch (err) {
      erro = String(err?.message ?? err).slice(0, 300);
      log.warn({ err, tenantId, conversationId }, 'Falha ao entregar resposta do atendente');
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
    await gravarComInsistencia(tenantId, m.id, resultado, erro);
  } finally {
    emAndamento.delete(m.id);
  }

  if (erro) {
    registrarEvento(tenantId, {
      chave,
      nivel: 'erro',
      tipo: 'envio',
      mensagem: `Resposta para ${mascarar(leadTelefone)} não foi entregue: ${erro}`
    });
    return { entregue: false, erro };
  }

  if (reenvio) {
    registrarEvento(tenantId, {
      chave,
      nivel: 'sucesso',
      tipo: 'envio',
      mensagem: `Resposta para ${mascarar(leadTelefone)} entregue no reenvio.`
    });
  }
  return { entregue: true };
}
