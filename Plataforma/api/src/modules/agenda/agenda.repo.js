import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { appointments } from '../../db/schema/scheduling.js';
import { leads, professionals, scheduleBlocks } from '../../db/schema/crm.js';
import { products, services } from '../../db/schema/catalog.js';
import { productSales, serviceHistory } from '../../db/schema/scheduling.js';
import { professionalServices } from '../../db/schema/catalog.js';
import { conversations } from '../../db/schema/conversations.js';
import { users } from '../../db/schema/auth.js';
import { tenants } from '../../db/schema/tenants.js';
import { ID } from '../../core/ids.js';
import { emitir, EVENTOS } from '../../core/eventos.js';

/** Condicao base: da empresa certa e nao excluido. */
const base = (tenantId) => and(eq(appointments.tenantId, tenantId), isNull(appointments.deletedAt));

/**
 * Recorte de privacidade na AGENDA.
 *
 * Aqui "meu atendimento" quer dizer tres coisas ao mesmo tempo, e todas contam:
 *
 *   1. eu vou EXECUTAR (sou o profissional do horario) — o caso do barbeiro;
 *   2. eu MARQUEI — o caso da recepcionista, que agenda para os outros;
 *   3. nasceu de uma CONVERSA MINHA — o horario que fechei no chat, mesmo que
 *      quem atenda na cadeira seja outra pessoa.
 *
 * Sem a terceira, o atendente fecharia um horario e ele sumiria da vista dele
 * no instante seguinte.
 */
function somenteDoEscopo(escopo) {
  if (!escopo || escopo.tudo) return undefined;

  const termos = [
    eq(appointments.responsavelUserId, escopo.userId),
    eq(appointments.criadoPorUserId, escopo.userId),
    sql`EXISTS (SELECT 1 FROM ${conversations} WHERE ${conversations.id} = ${appointments.conversationId}
        AND ${conversations.assignedUserId} = ${escopo.userId})`
  ];

  if (escopo.professionalIds?.length) {
    termos.unshift(inArray(appointments.professionalId, escopo.professionalIds));
  }

  return or(...termos);
}

/** Campos do agendamento + nomes relacionados, para nao precisar de consulta extra. */
const selecaoCompleta = {
  agendamento: appointments,
  leadNome: leads.nome,
  leadTelefone: leads.telefone,
  servicoNome: services.nome,
  servicoDuracao: services.duracaoMinutos,
  profissionalNome: professionals.nome,
  profissionalCor: professionals.cor,
  conversaStatus: conversations.status,
  responsavelNome: users.nome
};

function comRelacionados(consulta) {
  return consulta
    .from(appointments)
    .leftJoin(leads, eq(leads.id, appointments.leadId))
    .leftJoin(services, eq(services.id, appointments.serviceId))
    .leftJoin(professionals, eq(professionals.id, appointments.professionalId))
    .leftJoin(conversations, eq(conversations.id, appointments.conversationId))
    .leftJoin(users, eq(users.id, appointments.responsavelUserId));
}

export function buscarTenant(tenantId) {
  return db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
}

/**
 * O que ajuda quem vai atender, alem da OS em si: quem e o cliente na casa
 * (visitas, ultima vez, quanto ja gastou, etiquetas e observacoes) e o que
 * foi vendido junto deste atendimento.
 */
export async function contextoDaOS(tenantId, a) {
  const [lead] = await db
    .select({ tags: leads.tags, observacoes: leads.observacoes, createdAt: leads.createdAt })
    .from(leads)
    .where(and(eq(leads.tenantId, tenantId), eq(leads.id, a.leadId)))
    .limit(1);

  // Historico do cliente SEM esta OS: "visitas anteriores" e o que interessa.
  const [hist] = await db
    .select({
      visitas: sql`sum(case when ${serviceHistory.resultado} = 'concluido' then 1 else 0 end)`,
      faltas: sql`sum(case when ${serviceHistory.resultado} = 'faltou' then 1 else 0 end)`,
      gastoCentavos: sql`coalesce(sum(${serviceHistory.valorCentavos}), 0)`,
      ultimaVisita: sql`max(case when ${serviceHistory.resultado} = 'concluido' then ${serviceHistory.dataLocal} end)`
    })
    .from(serviceHistory)
    .where(
      and(
        eq(serviceHistory.tenantId, tenantId),
        eq(serviceHistory.leadId, a.leadId),
        or(isNull(serviceHistory.appointmentId), ne(serviceHistory.appointmentId, a.id))
      )
    );

  const vendas = await db
    .select({ produto: products.nome, quantidade: productSales.quantidade, totalCentavos: productSales.totalCentavos })
    .from(productSales)
    .innerJoin(products, eq(products.id, productSales.productId))
    .where(and(eq(productSales.tenantId, tenantId), eq(productSales.appointmentId, a.id), isNull(productSales.deletedAt)));

  const [criador] = a.criadoPorUserId
    ? await db.select({ nome: users.nome }).from(users).where(eq(users.id, a.criadoPorUserId)).limit(1)
    : [];

  return {
    cliente: {
      desde: lead?.createdAt?.getTime() ?? null,
      tags: lead?.tags ?? [],
      observacoes: lead?.observacoes || null,
      visitas: Number(hist?.visitas ?? 0),
      faltas: Number(hist?.faltas ?? 0),
      gastoCentavos: Number(hist?.gastoCentavos ?? 0),
      ultimaVisita: hist?.ultimaVisita ?? null
    },
    vendas,
    criadoPorNome: criador?.nome ?? null
  };
}

export async function buscarPorId(tenantId, id) {
  const [linha] = await comRelacionados(db.select(selecaoCompleta))
    .where(and(base(tenantId), eq(appointments.id, id)))
    .limit(1);
  return linha ?? null;
}

/**
 * Lista agendamentos de um periodo.
 *
 * O filtro por periodo usa `inicioEm >= inicio AND inicioEm < fim`, com o fim
 * EXCLUSIVO. Usar `<=` no limite superior incluiria um agendamento marcado
 * exatamente à meia-noite do dia seguinte, e ele apareceria em dois dias.
 */
export async function listar(
  tenantId,
  { inicioEm, fimEm, professionalId, status, leadId, responsavelUserId, incluirArquivados = false, escopo }
) {
  const condicoes = [base(tenantId), somenteDoEscopo(escopo)].filter(Boolean);

  if (inicioEm) condicoes.push(gte(appointments.inicioEm, new Date(inicioEm)));
  if (fimEm) condicoes.push(lt(appointments.inicioEm, new Date(fimEm)));
  if (professionalId) condicoes.push(eq(appointments.professionalId, professionalId));
  if (leadId) condicoes.push(eq(appointments.leadId, leadId));
  if (responsavelUserId) condicoes.push(eq(appointments.responsavelUserId, responsavelUserId));
  if (status?.length) condicoes.push(inArray(appointments.status, status));
  if (!incluirArquivados) condicoes.push(isNull(appointments.arquivadoEm));

  return comRelacionados(db.select(selecaoCompleta))
    .where(and(...condicoes))
    .orderBy(asc(appointments.inicioEm));
}

/**
 * Busca os periodos ja ocupados de um profissional num intervalo.
 *
 * Traz so `inicio` e `fim` porque e tudo que o calculo de disponibilidade
 * precisa — puxar a linha inteira seria desperdicio, ja que essa consulta
 * roda toda vez que alguem abre a tela de agendar.
 *
 * Agendamentos cancelados e faltas NAO contam como ocupado: o horario
 * voltou a ficar livre.
 */
export async function periodosOcupados(tenantId, professionalId, inicioEm, fimEm, { ignorarId = null } = {}) {
  const condicoes = [
    base(tenantId),
    eq(appointments.professionalId, professionalId),
    // Sobreposicao: comeca antes do fim da janela E termina depois do inicio.
    lt(appointments.inicioEm, new Date(fimEm)),
    gte(appointments.fimEm, new Date(inicioEm)),
    inArray(appointments.status, ['pendente', 'confirmado', 'em_andamento', 'concluido'])
  ];

  // Ao remarcar, o proprio agendamento nao pode bloquear a si mesmo.
  if (ignorarId) condicoes.push(ne(appointments.id, ignorarId));

  const linhas = await db
    .select({ inicio: appointments.inicioEm, fim: appointments.fimEm })
    .from(appointments)
    .where(and(...condicoes));

  return linhas.map((l) => ({ inicio: l.inicio.getTime(), fim: l.fim.getTime() }));
}

/** Bloqueios de agenda: do profissional ou da empresa inteira (feriado). */
export async function bloqueios(tenantId, professionalId, inicioEm, fimEm) {
  const linhas = await db
    .select({ inicio: scheduleBlocks.inicioEm, fim: scheduleBlocks.fimEm, motivo: scheduleBlocks.motivo })
    .from(scheduleBlocks)
    .where(
      and(
        eq(scheduleBlocks.tenantId, tenantId),
        lt(scheduleBlocks.inicioEm, new Date(fimEm)),
        gte(scheduleBlocks.fimEm, new Date(inicioEm)),
        or(eq(scheduleBlocks.professionalId, professionalId), isNull(scheduleBlocks.professionalId))
      )
    );

  return linhas.map((l) => ({ inicio: l.inicio.getTime(), fim: l.fim.getTime(), motivo: l.motivo }));
}

export function buscarProfissional(tenantId, id) {
  return db.query.professionals.findFirst({
    where: and(
      eq(professionals.tenantId, tenantId),
      eq(professionals.id, id),
      eq(professionals.ativo, true),
      isNull(professionals.deletedAt)
    )
  });
}

export function buscarServico(tenantId, id) {
  return db.query.services.findFirst({
    where: and(
      eq(services.tenantId, tenantId),
      eq(services.id, id),
      eq(services.ativo, true),
      isNull(services.deletedAt)
    )
  });
}

/**
 * Preco e duracao efetivos: o profissional pode ter valores proprios.
 * Devolve null quando ele nao executa aquele servico.
 */
export async function vinculoProfissionalServico(tenantId, professionalId, serviceId) {
  return db.query.professionalServices.findFirst({
    where: and(
      eq(professionalServices.tenantId, tenantId),
      eq(professionalServices.professionalId, professionalId),
      eq(professionalServices.serviceId, serviceId)
    )
  });
}

/**
 * O cliente JA tem este mesmo horario marcado (mesmo profissional, mesmo
 * instante, ainda valido)? Serve para `criar` ser idempotente.
 */
export async function buscarIgual(tenantId, { leadId, professionalId, inicioEm }) {
  const [linha] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        base(tenantId),
        eq(appointments.leadId, leadId),
        eq(appointments.professionalId, professionalId),
        eq(appointments.inicioEm, new Date(inicioEm)),
        inArray(appointments.status, ['pendente', 'confirmado', 'em_andamento'])
      )
    )
    .limit(1);
  return linha ?? null;
}

export async function criar(tenantId, dados, tx = db) {
  const registro = { id: ID.agendamento(), tenantId, ...dados };
  await tx.insert(appointments).values(registro);
  emitir(EVENTOS.AGENDA, { tenantId, id: registro.id });
  return registro.id;
}

export async function atualizar(tenantId, id, dados, tx = db) {
  await tx.update(appointments).set(dados).where(and(base(tenantId), eq(appointments.id, id)));
  emitir(EVENTOS.AGENDA, { tenantId, id });
  return buscarPorId(tenantId, id);
}

export async function excluir(tenantId, id) {
  const r = await db.update(appointments).set({ deletedAt: new Date() }).where(and(base(tenantId), eq(appointments.id, id)));
  emitir(EVENTOS.AGENDA, { tenantId, id });
  return (r.rowsAffected ?? 0) > 0;
}

/**
 * Numeros do periodo para o painel.
 *
 * Feito em UMA consulta com `SUM(CASE WHEN ...)` em vez de uma consulta por
 * status. Seis idas ao banco viram uma.
 */
export async function metricas(tenantId, inicioEm, fimEm, escopo, { professionalIds, serviceIds } = {}) {
  const conta = (status) =>
    sql`COALESCE(SUM(CASE WHEN ${appointments.status} = ${status} THEN 1 ELSE 0 END), 0)`;

  const [linha] = await db
    .select({
      total: sql`COUNT(*)`.as('total'),
      pendentes: conta('pendente').as('pendentes'),
      confirmados: conta('confirmado').as('confirmados'),
      emAndamento: conta('em_andamento').as('em_andamento'),
      concluidos: conta('concluido').as('concluidos'),
      cancelados: conta('cancelado').as('cancelados'),
      faltas: conta('faltou').as('faltas'),
      faturamentoCentavos: sql`COALESCE(SUM(CASE WHEN ${appointments.status} = 'concluido'
        THEN ${appointments.precoCentavos} - ${appointments.descontoCentavos} ELSE 0 END), 0)`.as('faturamento')
    })
    .from(appointments)
    .where(
      and(
        base(tenantId),
        somenteDoEscopo(escopo),
        gte(appointments.inicioEm, new Date(inicioEm)),
        lt(appointments.inicioEm, new Date(fimEm)),
        professionalIds?.length ? inArray(appointments.professionalId, professionalIds) : undefined,
        serviceIds?.length ? inArray(appointments.serviceId, serviceIds) : undefined
      )
    );

  return Object.fromEntries(Object.entries(linha ?? {}).map(([k, v]) => [k, Number(v) || 0]));
}

/** Arquiva em massa o que ja passou e nao esta mais ativo. */
export async function arquivarEncerrados(tenantId, anteriorA) {
  const r = await db
    .update(appointments)
    .set({ arquivadoEm: new Date() })
    .where(
      and(
        base(tenantId),
        isNull(appointments.arquivadoEm),
        lt(appointments.fimEm, new Date(anteriorA)),
        inArray(appointments.status, ['concluido', 'cancelado', 'faltou'])
      )
    );
  return r.rowsAffected ?? 0;
}

export function buscarLead(tenantId, leadId) {
  return db.query.leads.findFirst({
    where: and(eq(leads.tenantId, tenantId), eq(leads.id, leadId), isNull(leads.deletedAt))
  });
}

export { selecaoCompleta };

/** OS ainda nao encerradas que nasceram de uma sessao de atendimento. */
export function vinculadasAConversa(tenantId, conversationId) {
  return db
    .select()
    .from(appointments)
    .where(and(base(tenantId), eq(appointments.conversationId, conversationId)));
}

/**
 * O horario marcado de cada uma de varias conversas, de uma vez.
 *
 * Existe para o quadro: sem isto, montar oito colunas com trinta cartoes
 * custaria trinta consultas — uma por conversa — so para escrever "marcado
 * para quinta as 14h" no rodape do cartao.
 */
export async function porConversas(tenantId, conversationIds) {
  if (!conversationIds?.length) return [];

  return db
    .select({
      id: appointments.id,
      conversationId: appointments.conversationId,
      inicioEm: appointments.inicioEm,
      status: appointments.status,
      servicoNome: services.nome
    })
    .from(appointments)
    .leftJoin(services, eq(services.id, appointments.serviceId))
    .where(
      and(
        base(tenantId),
        inArray(appointments.conversationId, conversationIds),
        inArray(appointments.status, ['pendente', 'confirmado', 'em_andamento'])
      )
    )
    .orderBy(asc(appointments.inicioEm));
}

export function buscarConversa(tenantId, id) {
  return db.query.conversations.findFirst({
    where: and(eq(conversations.tenantId, tenantId), eq(conversations.id, id), isNull(conversations.deletedAt))
  });
}

/**
 * Quando a conversa muda de mao, os horarios ainda por acontecer vao junto.
 * Concluidos, cancelados e faltas ficam com quem os atendeu: sao historico.
 */
export async function transferirResponsavel(tenantId, conversationId, userId) {
  await db
    .update(appointments)
    .set({ responsavelUserId: userId })
    .where(
      and(
        base(tenantId),
        eq(appointments.conversationId, conversationId),
        inArray(appointments.status, ['pendente', 'confirmado', 'em_andamento'])
      )
    );
  emitir(EVENTOS.AGENDA, { tenantId, id: conversationId });
}

/** Ha horario ainda por acontecer ligado a esta conversa? */
export async function temAbertaDaConversa(tenantId, conversationId) {
  const [linha] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        base(tenantId),
        eq(appointments.conversationId, conversationId),
        inArray(appointments.status, ['pendente', 'confirmado', 'em_andamento'])
      )
    )
    .limit(1);
  return Boolean(linha);
}

/** A conversa mais recente de um cliente: onde o atendente vai falar com ele. */
export function conversaMaisRecenteDoLead(tenantId, leadId) {
  return db.query.conversations.findFirst({
    where: and(
      eq(conversations.tenantId, tenantId),
      eq(conversations.leadId, leadId),
      isNull(conversations.deletedAt)
    ),
    orderBy: desc(conversations.ultimaMensagemEm)
  });
}
