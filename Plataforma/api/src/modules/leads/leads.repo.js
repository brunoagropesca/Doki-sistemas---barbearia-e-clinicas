import { and, count, desc, eq, gte, inArray, isNull, like, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { leads, professionals } from '../../db/schema/crm.js';
import { appointments } from '../../db/schema/scheduling.js';
import { conversations } from '../../db/schema/conversations.js';
import { services } from '../../db/schema/catalog.js';
import { users } from '../../db/schema/auth.js';
import { ID } from '../../core/ids.js';

/**
 * Acesso ao banco para leads.
 *
 * TODA consulta aqui comeca filtrando por `tenantId`. Nao e opcional e nao e
 * por educacao: e o que impede os clientes de uma empresa aparecerem na tela
 * de outra. Por isso `tenantId` e o primeiro parametro de toda funcao — fica
 * dificil esquecer quando ele esta na cara.
 */

/** Condicao base: da empresa certa e nao excluido. */
const base = (tenantId) => and(eq(leads.tenantId, tenantId), isNull(leads.deletedAt));

export function buscarPorId(tenantId, id) {
  return db.query.leads.findFirst({ where: and(base(tenantId), eq(leads.id, id)) });
}

/**
 * Procura por telefone aceitando as variantes com e sem o nono digito.
 *
 * E aqui que o cliente que voltou por outro formato de numero e reconhecido,
 * em vez de virar um cadastro novo.
 */
export function buscarPorTelefone(tenantId, variantes) {
  const lista = Array.isArray(variantes) ? variantes : [variantes];
  if (lista.length === 0) return null;
  return db.query.leads.findFirst({
    where: and(base(tenantId), inArray(leads.telefone, lista))
  });
}

/**
 * Procura por telefone INCLUINDO quem esta na lixeira.
 *
 * Existe por causa do indice unico de telefone, que nao sabe de exclusao
 * logica: um cadastro excluido continua ocupando o numero. Sem esta busca, o
 * cliente que foi excluido e voltou a escrever nao seria encontrado (a busca
 * normal esconde excluidos) nem poderia ser criado (o banco recusaria o
 * telefone repetido) — ele simplesmente nao conseguiria mais ser atendido.
 */
export function buscarPorTelefoneComExcluidos(tenantId, variantes) {
  const lista = Array.isArray(variantes) ? variantes : [variantes];
  if (lista.length === 0) return null;
  return db.query.leads.findFirst({
    where: and(eq(leads.tenantId, tenantId), inArray(leads.telefone, lista))
  });
}

export async function criar(tenantId, dados) {
  const registro = { id: ID.lead(), tenantId, ...dados };
  await db.insert(leads).values(registro);
  return buscarPorId(tenantId, registro.id);
}

export async function atualizar(tenantId, id, dados) {
  await db.update(leads).set(dados).where(and(base(tenantId), eq(leads.id, id)));
  return buscarPorId(tenantId, id);
}

/** Exclusao logica — o registro vai pra lixeira, nao some. */
export async function excluir(tenantId, id) {
  const r = await db.update(leads).set({ deletedAt: new Date() }).where(and(base(tenantId), eq(leads.id, id)));
  return (r.rowsAffected ?? 0) > 0;
}

export async function restaurar(tenantId, id, dados = {}) {
  await db
    .update(leads)
    .set({ deletedAt: null, ...dados })
    .where(and(eq(leads.tenantId, tenantId), eq(leads.id, id)));
  return buscarPorId(tenantId, id);
}

/**
 * Lista leads com os numeros de cada um (quantos agendamentos, quanto gastou).
 *
 * O ponto importante: os agregados saem em UMA consulta, com junção e
 * agrupamento. A alternativa ingenua — listar os leads e depois, pra cada um,
 * perguntar ao banco quantos agendamentos tem — faz 1 + N consultas. Com 500
 * leads na tela, sao 501 idas ao banco em vez de 1. E a causa mais comum de
 * tela de CRM que demora cinco segundos pra abrir.
 */
export async function listar(tenantId, filtros = {}) {
  const {
    busca,
    tag,
    responsavelId,
    diasInativo,
    gastoMinimoCentavos,
    aceitaCampanha,
    novosDias,
    semAgendamento,
    minimoConcluidos,
    comFaltas,
    iaAtiva,
    limite = 50,
    cursor,
    ordem = 'recentes'
  } = filtros;

  const condicoes = [base(tenantId)];

  if (busca) {
    const termo = `%${busca.trim()}%`;
    condicoes.push(or(like(leads.nome, termo), like(leads.telefone, termo), like(leads.observacoes, termo)));
  }
  if (responsavelId) condicoes.push(eq(leads.responsavelId, responsavelId));
  if (typeof aceitaCampanha === 'boolean') condicoes.push(eq(leads.aceitaCampanha, aceitaCampanha));
  if (typeof iaAtiva === 'boolean') condicoes.push(eq(leads.iaAtiva, iaAtiva));

  if (novosDias) {
    condicoes.push(gte(leads.createdAt, new Date(Date.now() - Number(novosDias) * 86_400_000)));
  }

  // A etiqueta esta num campo JSON. Buscar por texto e aceitavel porque a
  // lista e curta; as aspas em volta evitam que "vip" case com "vip-ouro".
  if (tag) condicoes.push(like(leads.tags, `%"${tag}"%`));

  if (diasInativo) {
    const corte = new Date(Date.now() - Number(diasInativo) * 86_400_000);
    condicoes.push(or(lte(leads.ultimoContatoEm, corte), isNull(leads.ultimoContatoEm)));
  }

  // Paginacao por cursor: pedimos "os proximos depois deste id".
  // Como os ids sao ordenaveis por tempo, isso funciona sem OFFSET — e OFFSET
  // fica mais lento conforme a pagina avanca, porque o banco precisa contar e
  // descartar tudo que veio antes.
  if (cursor) condicoes.push(sql`${leads.id} < ${cursor}`);

  const gastoTotal = sql`COALESCE(SUM(CASE WHEN ${appointments.status} = 'concluido'
      THEN ${appointments.precoCentavos} - ${appointments.descontoCentavos} ELSE 0 END), 0)`;
  const totalConcluidos = sql`COALESCE(SUM(CASE WHEN ${appointments.status} = 'concluido' THEN 1 ELSE 0 END), 0)`;
  const totalFaltas = sql`COALESCE(SUM(CASE WHEN ${appointments.status} = 'faltou' THEN 1 ELSE 0 END), 0)`;

  /**
   * Filtros que dependem da SOMA (quanto gastou, quantas vezes veio) entram no
   * HAVING, nao no WHERE: no WHERE o banco ainda nao juntou os agendamentos do
   * lead, entao a conta nao existe. Ficam numa lista so para varios poderem
   * valer ao mesmo tempo ("recorrente E que nunca faltou").
   */
  const apos = [];
  if (gastoMinimoCentavos) apos.push(gte(gastoTotal, gastoMinimoCentavos));
  if (minimoConcluidos) apos.push(gte(totalConcluidos, minimoConcluidos));
  if (comFaltas === true) apos.push(gte(totalFaltas, 1));
  if (semAgendamento === true) apos.push(eq(count(appointments.id), 0));

  const linhas = await db
    .select({
      lead: leads,
      responsavelNome: sql`NULL`.as('responsavel_nome'),
      totalAgendamentos: count(appointments.id),
      concluidos: totalConcluidos.as('concluidos'),
      faltas: totalFaltas.as('faltas'),
      gastoTotalCentavos: gastoTotal.as('gasto_total_centavos'),
      ultimoAgendamentoEm: sql`MAX(${appointments.inicioEm})`.as('ultimo_agendamento_em')
    })
    .from(leads)
    .leftJoin(appointments, and(eq(appointments.leadId, leads.id), isNull(appointments.deletedAt)))
    .where(and(...condicoes))
    .groupBy(leads.id)
    .having(apos.length ? and(...apos) : undefined)
    .orderBy(ordem === 'nome' ? leads.nome : desc(leads.id))
    .limit(Math.min(limite, 200) + 1); // +1 para saber se existe proxima pagina

  const temMais = linhas.length > Math.min(limite, 200);
  const pagina = temMais ? linhas.slice(0, -1) : linhas;

  return {
    itens: pagina,
    proximoCursor: temMais ? pagina[pagina.length - 1].lead.id : null
  };
}

/**
 * UM lead com os mesmos numeros que a lista mostra (e a etapa dele).
 *
 * A ficha precisa do que `listar` calcula — quantas vezes veio, quanto gastou,
 * quantas faltou. Sem isto, a busca por id devolvia so a linha do cadastro e a
 * ficha exibia "0 atendimentos / R$ 0,00" ao lado de um historico cheio: dois
 * lugares da mesma tela discordando sobre o mesmo cliente.
 */
export async function buscarComResumo(tenantId, id) {
  const gastoTotal = sql`COALESCE(SUM(CASE WHEN ${appointments.status} = 'concluido'
      THEN ${appointments.precoCentavos} - ${appointments.descontoCentavos} ELSE 0 END), 0)`;

  const [linha] = await db
    .select({
      lead: leads,
      totalAgendamentos: count(appointments.id),
      concluidos: sql`COALESCE(SUM(CASE WHEN ${appointments.status} = 'concluido' THEN 1 ELSE 0 END), 0)`.as('concluidos'),
      faltas: sql`COALESCE(SUM(CASE WHEN ${appointments.status} = 'faltou' THEN 1 ELSE 0 END), 0)`.as('faltas'),
      gastoTotalCentavos: gastoTotal.as('gasto_total_centavos'),
      ultimoAgendamentoEm: sql`MAX(${appointments.inicioEm})`.as('ultimo_agendamento_em')
    })
    .from(leads)
    .leftJoin(appointments, and(eq(appointments.leadId, leads.id), isNull(appointments.deletedAt)))
    .where(and(base(tenantId), eq(leads.id, id)))
    .groupBy(leads.id);

  return linha ?? null;
}

/**
 * As etiquetas que existem de verdade nesta empresa, com quantos leads cada uma.
 *
 * As etiquetas sao inventadas por quem usa — nao ha lista fixa para oferecer
 * na tela. Esta consulta as descobre a partir dos proprios cadastros.
 *
 * `json_each` abre o vetor JSON de cada lead em uma linha por etiqueta, e a
 * contagem acontece no banco. A alternativa seria trazer as etiquetas de
 * todos os contatos e contar em memoria — o que fica caro exatamente quando a
 * base cresce, que e quando o filtro passa a ser necessario.
 */
export async function contarEtiquetas(tenantId) {
  const linhas = await db.all(sql`
    SELECT je.value AS etiqueta, COUNT(*) AS total
    FROM ${leads}, json_each(${leads.tags}) je
    WHERE ${leads.tenantId} = ${tenantId} AND ${leads.deletedAt} IS NULL
    GROUP BY je.value
    ORDER BY total DESC, je.value ASC
  `);

  return linhas.map((l) => ({ nome: String(l.etiqueta), total: Number(l.total) || 0 }));
}

/** Historico completo de um lead: agendamentos e conversas. */
export async function historico(tenantId, leadId) {
  const [agendamentos, conversas] = await Promise.all([
    db
      .select({
        id: appointments.id,
        conversationId: appointments.conversationId,
        inicioEm: appointments.inicioEm,
        status: appointments.status,
        fimEm: appointments.fimEm,
        precoCentavos: appointments.precoCentavos,
        descontoCentavos: appointments.descontoCentavos,
        profissionalNome: professionals.nome,
        servicoNome: services.nome
      })
      .from(appointments)
      .leftJoin(professionals, eq(professionals.id, appointments.professionalId))
      .leftJoin(services, eq(services.id, appointments.serviceId))
      .where(and(eq(appointments.tenantId, tenantId), eq(appointments.leadId, leadId), isNull(appointments.deletedAt)))
      .orderBy(desc(appointments.inicioEm))
      .limit(50),

    db
      .select({
        id: conversations.id,
        canal: conversations.canal,
        status: conversations.status,
        ultimaMensagemEm: conversations.ultimaMensagemEm,
        ultimaMensagemPreview: conversations.ultimaMensagemPreview,
        resumo: conversations.resumo,
        // O que faz o atendimento valer como registro de historico mesmo
        // quando nao virou agendamento nenhum.
        humor: conversations.humor,
        humorResumo: conversations.humorResumo,
        anotacoesHumanas: conversations.anotacoesHumanas,
        finalizadaEm: conversations.finalizadaEm,
        iniciadaEm: conversations.createdAt,
        totalMensagensCliente: conversations.totalMensagensCliente,
        atendenteNome: users.nome
      })
      .from(conversations)
      .leftJoin(users, eq(users.id, conversations.assignedUserId))
      .where(and(eq(conversations.tenantId, tenantId), eq(conversations.leadId, leadId), isNull(conversations.deletedAt)))
      .orderBy(desc(conversations.ultimaMensagemEm))
      .limit(20)
  ]);

  return { agendamentos, conversas };
}

/** Atualiza varios leads de uma vez (aplicar etiqueta, ligar/desligar IA). */
export async function atualizarEmLote(tenantId, ids, dados) {
  if (!ids?.length) return 0;
  const r = await db.update(leads).set(dados).where(and(base(tenantId), inArray(leads.id, ids)));
  return r.rowsAffected ?? 0;
}

export function listarPorIds(tenantId, ids) {
  if (!ids?.length) return [];
  return db.query.leads.findMany({ where: and(base(tenantId), inArray(leads.id, ids)) });
}
