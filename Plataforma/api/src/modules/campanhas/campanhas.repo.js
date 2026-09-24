import { and, asc, count, desc, eq, gte, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { campaigns, campaignTargets } from '../../db/schema/campaigns.js';
import { conversations, messages } from '../../db/schema/conversations.js';
import { leads } from '../../db/schema/crm.js';
import { appointments } from '../../db/schema/scheduling.js';
import { services } from '../../db/schema/catalog.js';
import { professionals } from '../../db/schema/crm.js';
import { ID } from '../../core/ids.js';

const base = (tenantId) => and(eq(campaigns.tenantId, tenantId), isNull(campaigns.deletedAt));

export function buscarPorId(tenantId, id) {
  return db.query.campaigns.findFirst({ where: and(base(tenantId), eq(campaigns.id, id)) });
}

export function listar(tenantId) {
  return db.query.campaigns.findMany({
    where: base(tenantId),
    orderBy: desc(campaigns.createdAt),
    limit: 100
  });
}

export async function criar(tenantId, dados) {
  const registro = { id: ID.campanha(), tenantId, ...dados };
  await db.insert(campaigns).values(registro);
  return buscarPorId(tenantId, registro.id);
}

export async function atualizar(tenantId, id, dados) {
  await db.update(campaigns).set(dados).where(and(base(tenantId), eq(campaigns.id, id)));
  return buscarPorId(tenantId, id);
}

export async function excluir(tenantId, id) {
  await db.update(campaigns).set({ deletedAt: new Date() }).where(and(base(tenantId), eq(campaigns.id, id)));
  return { ok: true };
}

/**
 * Campanhas de TODAS as empresas num status — so para o boot.
 *
 * Quando a API reinicia no meio de um disparo (ou de uma geracao), o laco que
 * rodava em memoria morre junto. Esta consulta acha o que ficou pela metade
 * para retomar sozinho, sem ninguem precisar lembrar de clicar em "iniciar".
 */
export function listarEmStatus(status) {
  return db.query.campaigns.findMany({
    where: and(inArray(campaigns.status, status), isNull(campaigns.deletedAt))
  });
}

/**
 * Contagem de alvos por status de VARIAS campanhas numa consulta so.
 *
 * A lista mostra a barra de progresso de cada campanha; perguntar campanha
 * por campanha faria uma ida ao banco por linha, a cada atualizacao da tela.
 */
export async function contarPorStatusDeVarias(tenantId, ids) {
  if (!ids.length) return {};
  const linhas = await db
    .select({ campaignId: campaignTargets.campaignId, status: campaignTargets.status, n: count() })
    .from(campaignTargets)
    .where(and(eq(campaignTargets.tenantId, tenantId), inArray(campaignTargets.campaignId, ids)))
    .groupBy(campaignTargets.campaignId, campaignTargets.status);

  const mapa = {};
  for (const l of linhas) {
    mapa[l.campaignId] ??= {};
    mapa[l.campaignId][l.status] = Number(l.n);
  }
  return mapa;
}

/**
 * Contexto de cada lead para a IA escrever uma mensagem pessoal.
 *
 * Tudo numa consulta so, com subconsultas. A versao ingenua — buscar os leads
 * e depois, para cada um, perguntar o ultimo servico — faria 1+N idas ao banco.
 * Numa campanha de 300 pessoas, 301 consultas antes de escrever a primeira
 * mensagem.
 */
export async function contextoDosLeads(tenantId, leadIds) {
  if (!leadIds?.length) return [];

  const ultimoAgendamento = db
    .select({
      leadId: appointments.leadId,
      ultimoEm: sql`MAX(${appointments.inicioEm})`.as('ultimo_em')
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.tenantId, tenantId),
        eq(appointments.status, 'concluido'),
        isNull(appointments.deletedAt)
      )
    )
    .groupBy(appointments.leadId)
    .as('ultimo');

  return db
    .select({
      id: leads.id,
      nome: leads.nome,
      telefone: leads.telefone,
      observacoes: leads.observacoes,
      tags: leads.tags,
      origem: leads.origem,
      humor: leads.humor,
      aceitaCampanha: leads.aceitaCampanha,
      ultimaCampanhaEm: leads.ultimaCampanhaEm,
      totalFaltas: sql`(
        SELECT COUNT(*) FROM ${appointments}
        WHERE ${appointments.leadId} = ${leads.id}
          AND ${appointments.status} = 'faltou'
          AND ${appointments.deletedAt} IS NULL
      )`.as('total_faltas'),
      // Quem ja tem horario marcado nao pode receber "que tal agendar?" —
      // e o erro que mais denuncia mensagem automatica.
      proximoAgendamentoEm: sql`(
        SELECT MIN(${appointments.inicioEm}) FROM ${appointments}
        WHERE ${appointments.leadId} = ${leads.id}
          AND ${appointments.status} IN ('pendente', 'confirmado')
          AND ${appointments.inicioEm} >= ${Date.now()}
          AND ${appointments.deletedAt} IS NULL
      )`.as('proximo_agendamento_em'),
      ultimoAgendamentoEm: ultimoAgendamento.ultimoEm,
      totalConcluidos: sql`(
        SELECT COUNT(*) FROM ${appointments}
        WHERE ${appointments.leadId} = ${leads.id}
          AND ${appointments.status} = 'concluido'
          AND ${appointments.deletedAt} IS NULL
      )`.as('total_concluidos'),
      gastoTotalCentavos: sql`(
        SELECT COALESCE(SUM(${appointments.precoCentavos} - ${appointments.descontoCentavos}), 0)
        FROM ${appointments}
        WHERE ${appointments.leadId} = ${leads.id}
          AND ${appointments.status} = 'concluido'
          AND ${appointments.deletedAt} IS NULL
      )`.as('gasto_total'),
      ultimoServico: sql`(
        SELECT ${services.nome} FROM ${appointments}
        JOIN ${services} ON ${services.id} = ${appointments.serviceId}
        WHERE ${appointments.leadId} = ${leads.id}
          AND ${appointments.status} = 'concluido'
          AND ${appointments.deletedAt} IS NULL
        ORDER BY ${appointments.inicioEm} DESC LIMIT 1
      )`.as('ultimo_servico'),
      profissionalPreferido: sql`(
        SELECT ${professionals.nome} FROM ${appointments}
        JOIN ${professionals} ON ${professionals.id} = ${appointments.professionalId}
        WHERE ${appointments.leadId} = ${leads.id}
          AND ${appointments.status} = 'concluido'
          AND ${appointments.deletedAt} IS NULL
        GROUP BY ${professionals.id}
        ORDER BY COUNT(*) DESC LIMIT 1
      )`.as('profissional_preferido')
    })
    .from(leads)
    .leftJoin(ultimoAgendamento, eq(ultimoAgendamento.leadId, leads.id))
    .where(and(eq(leads.tenantId, tenantId), inArray(leads.id, leadIds), isNull(leads.deletedAt)));
}

// ============================================================================
// ALVOS
// ============================================================================

export async function criarAlvos(tenantId, campaignId, alvos) {
  if (!alvos.length) return 0;

  await db.insert(campaignTargets).values(
    alvos.map((a) => ({
      id: ID.alvo(),
      tenantId,
      campaignId,
      ...a
    }))
  );

  return alvos.length;
}

export function listarAlvos(tenantId, campaignId, { status, limite = 500 } = {}) {
  const condicoes = [eq(campaignTargets.tenantId, tenantId), eq(campaignTargets.campaignId, campaignId)];
  if (status?.length) condicoes.push(inArray(campaignTargets.status, status));

  return db.query.campaignTargets.findMany({
    where: and(...condicoes),
    orderBy: asc(campaignTargets.createdAt),
    limit: limite
  });
}

/**
 * Tira do publico quem nao esta mais na lista.
 *
 * So apaga alvo que ainda nao saiu: o que ja foi enviado e historia e fica.
 */
export async function removerAlvosForaDe(tenantId, campaignId, leadIdsMantidos) {
  const condicoes = [
    eq(campaignTargets.tenantId, tenantId),
    eq(campaignTargets.campaignId, campaignId),
    inArray(campaignTargets.status, ['aguardando', 'pendente', 'aprovada'])
  ];
  if (leadIdsMantidos.length) condicoes.push(notInArray(campaignTargets.leadId, leadIdsMantidos));

  const r = await db.delete(campaignTargets).where(and(...condicoes));
  return r.rowsAffected ?? 0;
}

export async function leadIdsDaCampanha(tenantId, campaignId) {
  const linhas = await db
    .select({ leadId: campaignTargets.leadId })
    .from(campaignTargets)
    .where(and(eq(campaignTargets.tenantId, tenantId), eq(campaignTargets.campaignId, campaignId)));
  return linhas.map((l) => l.leadId);
}

export async function excluirAlvo(tenantId, id) {
  await db.delete(campaignTargets).where(and(eq(campaignTargets.tenantId, tenantId), eq(campaignTargets.id, id)));
}

/** Muda o status de todos os alvos da campanha que estao num dos status dados. */
export async function mudarStatusDosAlvos(tenantId, campaignId, deStatus, dados) {
  const r = await db
    .update(campaignTargets)
    .set(dados)
    .where(
      and(
        eq(campaignTargets.tenantId, tenantId),
        eq(campaignTargets.campaignId, campaignId),
        inArray(campaignTargets.status, deStatus)
      )
    );
  return r.rowsAffected ?? 0;
}

/**
 * As ultimas mensagens trocadas com o cliente, da mais antiga para a mais nova.
 *
 * E aqui que mora a "nuance" do atendimento: o resumo diz "perguntou preco de
 * luzes"; as mensagens dizem que ele achou caro e ia pensar. A IA da campanha
 * le as duas coisas.
 */
export async function ultimasMensagensDoLead(tenantId, leadId, limite = 10) {
  const linhas = await db
    .select({ direcao: messages.direcao, autorTipo: messages.autorTipo, conteudo: messages.conteudo, em: messages.createdAt })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(conversations.leadId, leadId),
        isNull(conversations.deletedAt)
      )
    )
    .orderBy(desc(messages.id))
    .limit(limite);

  return linhas.reverse();
}

/**
 * O alvo de campanha que uma mensagem recebida pode estar respondendo.
 *
 * So conta envio recente: um "oi" que chega um mes depois nao e resposta a
 * campanha, e contar como tal inflaria o numero de respostas.
 */
export function alvoAguardandoResposta(tenantId, leadId, desdeEm) {
  return db.query.campaignTargets.findFirst({
    where: and(
      eq(campaignTargets.tenantId, tenantId),
      eq(campaignTargets.leadId, leadId),
      eq(campaignTargets.status, 'enviada'),
      gte(campaignTargets.enviadoEm, new Date(desdeEm))
    ),
    orderBy: desc(campaignTargets.enviadoEm)
  });
}

export function buscarAlvo(tenantId, id) {
  return db.query.campaignTargets.findFirst({
    where: and(eq(campaignTargets.tenantId, tenantId), eq(campaignTargets.id, id))
  });
}

export async function atualizarAlvo(tenantId, id, dados) {
  await db
    .update(campaignTargets)
    .set(dados)
    .where(and(eq(campaignTargets.tenantId, tenantId), eq(campaignTargets.id, id)));
}

/**
 * Pega o proximo alvo para enviar E o marca como 'enviando', numa so operacao.
 *
 * O `WHERE status = 'aprovada'` no UPDATE e a trava: se dois processos
 * tentarem pegar o mesmo alvo, so um consegue mudar o status, e o outro
 * recebe zero linhas afetadas. Sem isso, o cliente receberia a mensagem duas
 * vezes — que e como um numero de WhatsApp vira spam e e bloqueado.
 */
export async function reservarProximoAlvo(tenantId, campaignId) {
  const candidato = await db.query.campaignTargets.findFirst({
    where: and(
      eq(campaignTargets.tenantId, tenantId),
      eq(campaignTargets.campaignId, campaignId),
      eq(campaignTargets.status, 'aprovada')
    ),
    orderBy: asc(campaignTargets.createdAt)
  });

  if (!candidato) return null;

  const r = await db
    .update(campaignTargets)
    .set({ status: 'enviando' })
    .where(and(eq(campaignTargets.id, candidato.id), eq(campaignTargets.status, 'aprovada')));

  // Outro processo pegou primeiro.
  if ((r.rowsAffected ?? 0) === 0) return null;

  return candidato;
}

/** Quantos ja foram enviados hoje — alimenta o limite diario anti-bloqueio. */
export async function enviadosDesde(tenantId, campaignId, desdeEm) {
  const [linha] = await db
    .select({ n: count() })
    .from(campaignTargets)
    .where(
      and(
        eq(campaignTargets.tenantId, tenantId),
        eq(campaignTargets.campaignId, campaignId),
        sql`${campaignTargets.enviadoEm} >= ${desdeEm}`
      )
    );
  return Number(linha?.n) || 0;
}

export async function contarPorStatus(tenantId, campaignId) {
  const linhas = await db
    .select({ status: campaignTargets.status, n: count() })
    .from(campaignTargets)
    .where(and(eq(campaignTargets.tenantId, tenantId), eq(campaignTargets.campaignId, campaignId)))
    .groupBy(campaignTargets.status);

  return Object.fromEntries(linhas.map((l) => [l.status, Number(l.n)]));
}

/** Devolve alvos ainda 'enviando' de uma execucao interrompida. */
export async function destravarPendentes(tenantId, campaignId) {
  const r = await db
    .update(campaignTargets)
    .set({ status: 'aprovada' })
    .where(
      and(
        eq(campaignTargets.tenantId, tenantId),
        eq(campaignTargets.campaignId, campaignId),
        eq(campaignTargets.status, 'enviando')
      )
    );
  return r.rowsAffected ?? 0;
}

/** Acha o alvo mais recente enviado para um lead — usado ao classificar resposta. */
export function ultimoAlvoDoLead(tenantId, leadId) {
  return db.query.campaignTargets.findFirst({
    where: and(
      eq(campaignTargets.tenantId, tenantId),
      eq(campaignTargets.leadId, leadId),
      eq(campaignTargets.status, 'enviada')
    ),
    orderBy: desc(campaignTargets.enviadoEm)
  });
}
