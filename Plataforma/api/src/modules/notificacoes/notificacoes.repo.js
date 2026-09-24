import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { teamNotifications } from '../../db/schema/conversations.js';
import { ID } from '../../core/ids.js';
import { emitir, EVENTOS } from '../../core/eventos.js';

/**
 * Acesso ao banco das notificacoes de atendimento.
 *
 * Fica separado do servico porque a CONVERSA tambem precisa fechar
 * notificacoes (quando alguem assume ou responde) e o servico de notificacoes
 * depende do de conversas — importar o servico de la criaria um ciclo.
 */

const abertas = (tenantId) => and(eq(teamNotifications.tenantId, tenantId), isNull(teamNotifications.fechadaEm));

export async function criar(tenantId, { userIds, conversationId, leadNome, motivo, urgente }) {
  if (userIds.length === 0) return [];
  const linhas = userIds.map((userId) => ({
    id: ID.notificacao(),
    tenantId,
    userId,
    conversationId,
    leadNome: leadNome ?? null,
    motivo: motivo ?? '',
    urgente: Boolean(urgente)
  }));
  await db.insert(teamNotifications).values(linhas);
  for (const userId of userIds) emitir(EVENTOS.NOTIFICACAO, { tenantId, userId });
  return linhas;
}

/** As abertas desta pessoa: urgentes primeiro, depois da mais antiga para a mais nova. */
export function abertasDe(tenantId, userId) {
  return db.query.teamNotifications.findMany({
    where: and(abertas(tenantId), eq(teamNotifications.userId, userId)),
    orderBy: [desc(teamNotifications.urgente), asc(teamNotifications.createdAt)]
  });
}

export function buscarAbertaDe(tenantId, userId, id) {
  return db.query.teamNotifications.findFirst({
    where: and(abertas(tenantId), eq(teamNotifications.userId, userId), eq(teamNotifications.id, id))
  });
}

export async function fechar(tenantId, id) {
  await db.update(teamNotifications).set({ fechadaEm: new Date() }).where(and(abertas(tenantId), eq(teamNotifications.id, id)));
}

/** Fecha todas as abertas da empresa (as notificacoes foram desligadas pelo DEV). */
export async function fecharTodas(tenantId) {
  const r = await db.update(teamNotifications).set({ fechadaEm: new Date() }).where(abertas(tenantId));
  if ((r.rowsAffected ?? 0) > 0) emitir(EVENTOS.NOTIFICACAO, { tenantId });
  return r.rowsAffected ?? 0;
}

/**
 * Alguem atendeu a conversa: a notificacao dela sai da tela de TODO mundo.
 * Chamado pela conversa ao ser assumida ou respondida por uma pessoa.
 */
export async function fecharDaConversa(tenantId, conversationId) {
  const resultado = await db
    .update(teamNotifications)
    .set({ fechadaEm: new Date() })
    .where(and(abertas(tenantId), eq(teamNotifications.conversationId, conversationId)));
  if ((resultado.rowsAffected ?? 0) > 0) emitir(EVENTOS.NOTIFICACAO, { tenantId });
}
