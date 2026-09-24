import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { quickReplies } from '../../db/schema/index.js';
import { ID } from '../../core/ids.js';

const ativas = (tenantId, userId) =>
  and(eq(quickReplies.tenantId, tenantId), eq(quickReplies.userId, userId), isNull(quickReplies.deletedAt));

export function listarRespostas(tenantId, userId) {
  return db.select().from(quickReplies).where(ativas(tenantId, userId)).orderBy(asc(quickReplies.atalho));
}

export async function buscarResposta(tenantId, userId, id) {
  const [linha] = await db
    .select()
    .from(quickReplies)
    .where(and(ativas(tenantId, userId), eq(quickReplies.id, id)));
  return linha ?? null;
}

export async function buscarPorAtalho(tenantId, userId, atalho) {
  const [linha] = await db
    .select()
    .from(quickReplies)
    .where(and(ativas(tenantId, userId), eq(quickReplies.atalho, atalho)));
  return linha ?? null;
}

export async function criarResposta(tenantId, userId, { atalho, texto }) {
  const id = ID.respostaRapida();
  await db.insert(quickReplies).values({ id, tenantId, userId, atalho, texto });
  return buscarResposta(tenantId, userId, id);
}

export async function atualizarResposta(tenantId, userId, id, dados) {
  await db.update(quickReplies).set(dados).where(and(ativas(tenantId, userId), eq(quickReplies.id, id)));
  return buscarResposta(tenantId, userId, id);
}

export async function apagarResposta(tenantId, userId, id) {
  await db
    .update(quickReplies)
    .set({ deletedAt: new Date() })
    .where(and(ativas(tenantId, userId), eq(quickReplies.id, id)));
}
