import { and, asc, count, eq, gt, isNull, lt, ne, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sessions, teamAlerts, users } from '../../db/schema/auth.js';
import { conversations } from '../../db/schema/conversations.js';
import { EVENTOS, emitir } from '../../core/eventos.js';
import { tenants } from '../../db/schema/tenants.js';
import { settings } from '../../db/schema/ai.js';
import { ID } from '../../core/ids.js';

/**
 * Camada de acesso ao banco para autenticacao.
 *
 * A divisao em tres camadas (rota -> servico -> repositorio) existe por um
 * motivo pratico: no sistema antigo, `db.mjs` tinha 4.200 linhas e misturava
 * SQL com regra de negocio. Trocar de banco, ou testar uma regra sem subir o
 * banco, era impossivel.
 *
 * Aqui o repositorio SO fala com o banco. Nao decide nada, nao valida nada,
 * nao levanta erro de negocio. Isso e trabalho do servico.
 */

/** Busca um usuario pelo login, dentro de uma empresa. */
export function buscarPorUsername(tenantId, username) {
  return db.query.users.findFirst({
    where: and(
      eq(users.tenantId, tenantId),
      eq(users.username, username.toLowerCase().trim()),
      isNull(users.deletedAt)
    )
  });
}

/**
 * Busca o usuario pelo login sem saber a empresa.
 *
 * Usado na tela de login, onde a pessoa digita so usuario e senha.
 * Enquanto houver uma empresa so, isso resolve. Quando forem varias, a tela
 * passa a pedir tambem o identificador da empresa (o `slug`) e esta funcao
 * some — por isso ela esta isolada aqui, e nao espalhada pelo sistema.
 */
export async function buscarPorUsernameGlobal(username) {
  const encontrados = await db
    .select({
      usuario: users,
      tenantAtivo: tenants.ativo
    })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(eq(users.username, username.toLowerCase().trim()), isNull(users.deletedAt)))
    .limit(2);

  // Login ambiguo (mesmo usuario em duas empresas) exige informar a empresa.
  if (encontrados.length !== 1) return null;
  if (!encontrados[0].tenantAtivo) return null;

  return encontrados[0].usuario;
}

/** Resolve o identificador de URL da empresa ('barbearia-do-ze') no id dela. */
export function buscarTenantPorSlug(slug) {
  return db.query.tenants.findFirst({
    where: and(eq(tenants.slug, String(slug).toLowerCase().trim()), eq(tenants.ativo, true))
  });
}

export function buscarUsuarioPorId(id) {
  return db.query.users.findFirst({
    where: and(eq(users.id, id), isNull(users.deletedAt))
  });
}

export async function criarUsuario(dados) {
  const registro = {
    id: ID.usuario(),
    ...dados,
    username: dados.username.toLowerCase().trim()
  };
  await db.insert(users).values(registro);
  return buscarUsuarioPorId(registro.id);
}

export async function atualizarUsuario(id, dados) {
  await db.update(users).set(dados).where(eq(users.id, id));
  return buscarUsuarioPorId(id);
}

/**
 * Apaga o usuario DE VERDADE (nao e exclusao logica). So para o DEV, que nao
 * deve deixar rastro: sessoes, respostas rapidas e avisos vao junto em
 * cascata, e o que apontava para ele (auditoria, mensagens) fica sem autor.
 */
export async function apagarUsuarioDefinitivo(id) {
  await db.delete(users).where(and(eq(users.id, id), eq(users.cargo, 'dev')));
}

/** Apaga os DEV sem nenhuma sessao valida, criados antes de `criadosAntesDe`. */
export async function apagarDevsSemSessao(criadosAntesDe) {
  const devs = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.cargo, 'dev'), lt(users.createdAt, criadosAntesDe)));

  let removidos = 0;
  for (const { id } of devs) {
    if (await temSessaoValida(id)) continue;
    await apagarUsuarioDefinitivo(id);
    removidos += 1;
  }
  return removidos;
}

/** Quantos donos ativos a empresa tem — usado para nunca deixa-la sem nenhum. */
export async function contarDonosAtivos(tenantId) {
  const [linha] = await db
    .select({ total: count() })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.cargo, 'owner'), eq(users.ativo, true), isNull(users.deletedAt)));
  return linha?.total ?? 0;
}

/**
 * Conversas em atendimento com esta pessoa voltam para a fila.
 * @returns {Promise<number>} quantas foram devolvidas
 */
export async function devolverConversasParaFila(tenantId, userId) {
  const resultado = await db
    .update(conversations)
    .set({ status: 'na_fila', assignedUserId: null, assumidaEm: null })
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.assignedUserId, userId),
        eq(conversations.status, 'humana')
      )
    );
  const total = resultado.rowsAffected ?? 0;
  if (total > 0) emitir(EVENTOS.CONVERSA, { tenantId });
  return total;
}

export async function registrarLogin(userId) {
  await db.update(users).set({ ultimoLoginEm: new Date() }).where(eq(users.id, userId));
}

// ============================================================================
// SESSOES
// ============================================================================

export async function criarSessao({ tenantId, userId, tokenHash, expiraEm, userAgent, ip }) {
  const registro = {
    id: ID.sessao(),
    tenantId,
    userId,
    tokenHash,
    expiraEm,
    userAgent: userAgent?.slice(0, 255) ?? null,
    ip: ip ?? null
  };
  await db.insert(sessions).values(registro);
  return registro;
}

/**
 * Busca a sessao valida de um token, junto com o usuario dono dela.
 *
 * Todas as condicoes de validade estao nesta consulta, e nao espalhadas em
 * `if` depois: nao expirou, nao foi revogada, o usuario existe, esta ativo e
 * nao foi excluido. Uma condicao esquecida aqui e uma porta aberta, entao
 * elas ficam todas juntas, onde da pra ler de uma vez.
 */
export async function buscarSessaoValida(tokenHash) {
  const agora = new Date();

  const [linha] = await db
    .select({ sessao: sessions, usuario: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        gt(sessions.expiraEm, agora),
        isNull(sessions.revogadaEm),
        eq(users.ativo, true),
        isNull(users.deletedAt)
      )
    )
    .limit(1);

  return linha ?? null;
}

export async function marcarUso(sessaoId) {
  await db.update(sessions).set({ ultimoUsoEm: new Date() }).where(eq(sessions.id, sessaoId));
}

export async function revogarSessao(tokenHash) {
  await db.update(sessions).set({ revogadaEm: new Date() }).where(eq(sessions.tokenHash, tokenHash));
}

/** O usuario ainda tem alguma sessao aberta (outro navegador, o celular)? */
export async function temSessaoValida(userId) {
  const [linha] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiraEm, new Date()), isNull(sessions.revogadaEm)))
    .limit(1);
  return Boolean(linha);
}

/** Derruba todas as sessoes de um usuario — usado ao trocar senha ou desativar. */
export async function revogarTodasDoUsuario(userId) {
  await db
    .update(sessions)
    .set({ revogadaEm: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revogadaEm)));
}

/**
 * Remove sessoes que ja nao servem pra nada.
 *
 * Sem isto a tabela cresce pra sempre. O sistema antigo tinha 18 sessoes
 * acumuladas com 4 usuarios — em producao, com meses de uso, viram dezenas
 * de milhares de linhas mortas atrasando cada login.
 */
export async function limparSessoesExpiradas() {
  const agora = new Date();
  // Sessoes revogadas ficam 30 dias antes de sumir: se houver suspeita de
  // acesso indevido, o rastro de quando a sessao foi criada e de onde ainda
  // esta la pra investigar.
  const corteRevogadas = new Date(agora.getTime() - 30 * 86_400_000);

  const resultado = await db
    .delete(sessions)
    .where(or(lt(sessions.expiraEm, agora), lt(sessions.revogadaEm, corteRevogadas)));

  return resultado.rowsAffected ?? 0;
}

// ============================================================================
// AVISOS DA GERENCIA
// ============================================================================

export async function criarAviso({ tenantId, userId, deUserId, deNome, mensagem }) {
  const registro = { id: ID.aviso(), tenantId, userId, deUserId, deNome, mensagem };
  await db.insert(teamAlerts).values(registro);
  return db.query.teamAlerts.findFirst({ where: eq(teamAlerts.id, registro.id) });
}

/** Avisos que a pessoa ainda nao confirmou, do mais antigo para o mais novo. */
export function avisosPendentes(tenantId, userId) {
  return db.query.teamAlerts.findMany({
    where: and(
      eq(teamAlerts.tenantId, tenantId),
      eq(teamAlerts.userId, userId),
      isNull(teamAlerts.lidoEm),
      isNull(teamAlerts.canceladoEm)
    ),
    orderBy: asc(teamAlerts.createdAt)
  });
}

/**
 * Marca como lido. O filtro por destinatario esta na propria consulta: um
 * atendente nao consegue confirmar (e sumir com) o aviso de outro.
 * @returns {Promise<boolean>} se havia um aviso pendente dele com esse id
 */
export async function marcarAvisoLido(tenantId, userId, id) {
  const resultado = await db
    .update(teamAlerts)
    .set({ lidoEm: new Date() })
    .where(
      and(
        eq(teamAlerts.id, id),
        eq(teamAlerts.tenantId, tenantId),
        eq(teamAlerts.userId, userId),
        isNull(teamAlerts.lidoEm),
        isNull(teamAlerts.canceladoEm)
      )
    );
  return (resultado.rowsAffected ?? 0) > 0;
}

/**
 * Cancela os avisos ainda nao lidos da empresa (avisos desligados pelo DEV).
 * Cancelar e nao "marcar lido": a hora de leitura e a prova de que a pessoa
 * confirmou, e ninguem confirmou estes.
 */
export async function cancelarAvisosPendentes(tenantId) {
  const r = await db
    .update(teamAlerts)
    .set({ canceladoEm: new Date() })
    .where(and(eq(teamAlerts.tenantId, tenantId), isNull(teamAlerts.lidoEm), isNull(teamAlerts.canceladoEm)));
  return r.rowsAffected ?? 0;
}

// ============================================================================
// SENHA DE FABRICA EM INSTALACOES ANTIGAS (ver marcarSenhasDeFabrica)
// ============================================================================

const MARCA_SENHAS_CONFERIDAS = 'auth.senhas_de_fabrica_conferidas';

/** Empresas cujos logins ainda nao foram conferidos contra a senha de fabrica. */
export async function empresasSemConferenciaDeSenha() {
  const todas = await db.select({ id: tenants.id }).from(tenants);
  const conferidas = new Set(
    (await db.select({ tenantId: settings.tenantId }).from(settings).where(eq(settings.chave, MARCA_SENHAS_CONFERIDAS))).map(
      (l) => l.tenantId
    )
  );
  return todas.map((t) => t.id).filter((id) => !conferidas.has(id));
}

/** Logins da empresa que hoje NAO estao provisorios (o dev fica de fora: nasce com senha propria). */
export function loginsComSenhaDefinitiva(tenantId) {
  return db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.senhaProvisoria, false), ne(users.cargo, 'dev'), isNull(users.deletedAt)));
}

export async function marcarSenhasConferidas(tenantId) {
  await db
    .insert(settings)
    .values({ tenantId, chave: MARCA_SENHAS_CONFERIDAS, valor: { em: new Date().toISOString() } })
    .onConflictDoNothing();
}
