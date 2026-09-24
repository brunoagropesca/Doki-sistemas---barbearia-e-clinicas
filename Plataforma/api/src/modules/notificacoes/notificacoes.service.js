import { Conflito, NaoEncontrado, RegraDeNegocio } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { quemAtendeAFila } from '../equipe/distribuidor.js';
import * as conversas from '../conversas/conversas.service.js';
import * as conversasRepo from '../conversas/conversas.repo.js';
import * as repo from './notificacoes.repo.js';
import { funcaoLigada } from '../funcoes/funcoes.js';

const log = comContexto({ modulo: 'notificacoes' });

/**
 * Notificacoes de atendimento: "a IA passou um cliente para voce".
 *
 * Duas intensidades:
 *
 *   NORMAL  — o cliente pediu uma pessoa, a IA nao soube responder, etc. Aparece
 *             no canto da tela e some sozinha depois de alguns segundos (ou no "x").
 *   URGENTE — cliente frustrado. Nao some sozinha nem no "x": so sai quando
 *             alguem clica em "Atender" (ou atende a conversa pelo livechat).
 *             Cliente irritado esperando e o pior cenario do atendimento; a
 *             notificacao nao pode ser varrida para baixo do tapete.
 */

/**
 * Chamado quando a IA encaminha um cliente.
 *
 * Com a conversa distribuida, notifica so quem a recebeu. Sem dono (ninguem
 * disponivel, ou distribuicao manual), notifica quem atende a fila — o
 * primeiro a clicar em "Atender" leva.
 */
export async function notificarEncaminhamento(tenantId, conversationId, { motivo, clienteFrustrado = false } = {}) {
  try {
    if (!(await funcaoLigada(tenantId, 'notificacoes_encaminhamento'))) return [];
    const linha = await conversasRepo.buscarPorId(tenantId, conversationId);
    if (!linha) return [];

    // A leitura de humor tambem conta: a Sofia pode nao ter marcado, mas a
    // conversa ja estava classificada como frustrada.
    // So conta se a leitura de humor estiver ligada: com ela desligada, o humor
    // guardado e velho e nao pode decidir urgencia hoje.
    const humorValido = await funcaoLigada(tenantId, 'leitura_humor');
    const urgente = Boolean(clienteFrustrado) || (humorValido && linha.conversa.humor === 'frustrado');

    const dono = linha.conversa.assignedUserId;
    const userIds = dono ? [dono] : (await quemAtendeAFila(tenantId)).map((a) => a.id);

    // Um encaminhamento novo substitui o anterior da mesma conversa.
    await repo.fecharDaConversa(tenantId, conversationId);
    const criadas = await repo.criar(tenantId, {
      userIds,
      conversationId,
      leadNome: linha.leadNome,
      motivo,
      urgente
    });

    log.info({ tenantId, conversationId, urgente, notificados: userIds.length }, 'Encaminhamento da IA notificado');
    return criadas;
  } catch (err) {
    // Notificar e apoio: nunca derruba o atendimento do cliente.
    log.warn({ err, tenantId, conversationId }, 'Nao foi possivel notificar o encaminhamento');
    return [];
  }
}

export async function minhas(usuario) {
  if (!(await funcaoLigada(usuario.tenantId, 'notificacoes_encaminhamento'))) return [];
  return repo.abertasDe(usuario.tenantId, usuario.id);
}

/**
 * "Atender": assume a conversa e fecha a notificacao de todo mundo.
 *
 * Se outra pessoa chegou antes, a notificacao sai mesmo assim (nao ha mais o
 * que atender) e quem clicou fica sabendo quem pegou.
 */
export async function atender(usuario, id) {
  const n = await repo.buscarAbertaDe(usuario.tenantId, usuario.id, id);
  if (!n) throw new NaoEncontrado('Notificacao');

  try {
    const conversa = await conversas.assumir(usuario.tenantId, n.conversationId, usuario);
    return { ok: true, conversationId: n.conversationId, conversa };
  } catch (err) {
    if (err instanceof Conflito || err instanceof NaoEncontrado || err instanceof RegraDeNegocio) {
      await repo.fechar(usuario.tenantId, n.id);
    }
    throw err;
  }
}

/** O "x". Nao vale para a urgente: essa so sai atendendo. */
export async function fechar(usuario, id) {
  const n = await repo.buscarAbertaDe(usuario.tenantId, usuario.id, id);
  if (!n) throw new NaoEncontrado('Notificacao');
  if (n.urgente) throw new RegraDeNegocio('Cliente frustrado: esta notificacao so sai quando alguem atender.');
  await repo.fechar(usuario.tenantId, n.id);
  return { ok: true };
}
