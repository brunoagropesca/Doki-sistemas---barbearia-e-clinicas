import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { auditLogs } from '../../db/schema/auth.js';
import { ID } from '../../core/ids.js';
import { logger } from '../../core/logger.js';

/**
 * Trilha de auditoria.
 *
 * Responde perguntas que, no sistema antigo, simplesmente nao tinham resposta:
 * "quem apagou o cadastro da dona Maria?", "quem mudou o preco do corte?",
 * "quem transferiu essa conversa e por que?".
 *
 * Decisao importante: gravar auditoria NUNCA derruba a operacao. Se a escrita
 * do log falhar, a exclusao do lead que o usuario pediu ainda acontece — o
 * erro vai pro log da aplicacao. Auditoria e importante, mas nao e mais
 * importante que o sistema funcionar.
 */
export async function registrarAuditoria({ tenantId, usuario, acao, entidade, entidadeId, dados, ip }) {
  try {
    await db.insert(auditLogs).values({
      id: ID.auditoria(),
      tenantId,
      userId: usuario?.id ?? null,
      userNome: usuario?.nome ?? 'sistema',
      acao,
      entidade,
      entidadeId: entidadeId ?? null,
      dados: dados ?? {},
      ip: ip ?? null
    });
  } catch (err) {
    logger.error({ err, acao, entidade, entidadeId }, 'Falha ao gravar auditoria');
  }
}

/** Lista o historico de uma entidade especifica. */
export function historicoDaEntidade(tenantId, entidade, entidadeId, limite = 50) {
  return db.query.auditLogs.findMany({
    where: and(
      eq(auditLogs.tenantId, tenantId),
      eq(auditLogs.entidade, entidade),
      eq(auditLogs.entidadeId, entidadeId)
    ),
    orderBy: desc(auditLogs.createdAt),
    limit: limite
  });
}

/** Lista as acoes recentes da empresa inteira. */
export function recentes(tenantId, limite = 100) {
  return db.query.auditLogs.findMany({
    where: eq(auditLogs.tenantId, tenantId),
    orderBy: desc(auditLogs.createdAt),
    limit: limite
  });
}
