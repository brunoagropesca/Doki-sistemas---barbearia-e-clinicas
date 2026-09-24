import { and, asc, count, countDistinct, desc, eq, gte, inArray, isNull, notExists, sql, sum } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { appointments, serviceHistory, RESULTADOS_ATENDIMENTO } from '../../db/schema/scheduling.js';
import { services } from '../../db/schema/catalog.js';
import { professionals } from '../../db/schema/crm.js';
import { tenants } from '../../db/schema/tenants.js';
import { ID } from '../../core/ids.js';
import { comContexto } from '../../core/logger.js';
import { FUSO_PADRAO, dataNoFuso, diaDaSemana, partesNoFuso, somarDias } from '../../core/datetime.js';
import { formatarBRL } from '../../core/money.js';

const log = comContexto({ modulo: 'historico' });

/**
 * Historico de atendimentos encerrados.
 *
 * Hoje so COLETA (e alimenta as metricas da ficha do profissional); o painel
 * de analise vem depois e vai ler desta tabela. Por isso a gravacao e
 * cuidadosa com o que so existe no momento — ver o schema `serviceHistory`.
 */

async function fusoDe(tenantId) {
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { fusoHorario: true } });
  return t?.fusoHorario || FUSO_PADRAO;
}

/**
 * Grava o desfecho de um agendamento que acabou de encerrar.
 *
 * Idempotente: o indice unico por agendamento faz a segunda chamada nao
 * gravar nada. Nunca lanca — o historico e apoio, e concluir o atendimento
 * do cliente nao pode falhar por causa dele.
 *
 * @returns {Promise<boolean>} se gravou uma linha nova
 */
export async function registrarDesfecho(tenantId, appointmentId) {
  try {
    const [linha] = await db
      .select({ a: appointments, servico: services, profissional: professionals })
      .from(appointments)
      .leftJoin(services, eq(services.id, appointments.serviceId))
      .leftJoin(professionals, eq(professionals.id, appointments.professionalId))
      .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId)))
      .limit(1);

    if (!linha || !RESULTADOS_ATENDIMENTO.includes(linha.a.status)) return false;

    const a = linha.a;
    const fuso = await fusoDe(tenantId);
    const dataLocal = dataNoFuso(a.inicioEm, fuso);
    const concluido = a.status === 'concluido';

    // Primeira visita: nenhum atendimento concluido deste cliente antes.
    let clienteNovo = false;
    if (concluido) {
      const [anterior] = await db
        .select({ id: serviceHistory.id })
        .from(serviceHistory)
        .where(
          and(
            eq(serviceHistory.tenantId, tenantId),
            eq(serviceHistory.leadId, a.leadId),
            eq(serviceHistory.resultado, 'concluido')
          )
        )
        .limit(1);
      clienteNovo = !anterior;
    }

    const preco = a.precoCentavos ?? 0;
    const desconto = a.descontoCentavos ?? 0;

    const inseridas = await db
      .insert(serviceHistory)
      .values({
        id: ID.historico(),
        tenantId,
        appointmentId: a.id,
        resultado: a.status,
        professionalId: a.professionalId,
        professionalNome: linha.profissional?.nome ?? 'Profissional removido',
        serviceId: a.serviceId,
        serviceNome: linha.servico?.nome ?? 'Servico removido',
        serviceCategoria: linha.servico?.categoria ?? 'Geral',
        leadId: a.leadId,
        clienteNovo,
        precoCentavos: preco,
        descontoCentavos: desconto,
        // Cancelado e falta nao entram no caixa.
        valorCentavos: concluido ? Math.max(0, preco - desconto) : 0,
        precoTabelaCentavos: linha.servico?.precoCentavos ?? preco,
        duracaoMinutos: Math.round((a.fimEm.getTime() - a.inicioEm.getTime()) / 60_000),
        inicioEm: a.inicioEm,
        encerradoEm: a.concluidoEm ?? a.canceladoEm ?? a.updatedAt ?? new Date(),
        dataLocal,
        diaSemana: diaDaSemana(dataLocal),
        horaLocal: partesNoFuso(a.inicioEm, fuso).hora,
        antecedenciaHoras: a.createdAt
          ? Math.max(0, Math.round((a.inicioEm.getTime() - a.createdAt.getTime()) / 3_600_000))
          : null,
        origem: a.criadoPor,
        responsavelUserId: a.responsavelUserId,
        conversationId: a.conversationId,
        humor: a.humorAtendimento,
        motivoCancelamento: a.motivoCancelamento
      })
      .onConflictDoNothing({ target: serviceHistory.appointmentId })
      .returning({ id: serviceHistory.id });

    return inseridas.length > 0;
  } catch (err) {
    log.warn({ err, tenantId, appointmentId }, 'Nao foi possivel gravar o historico do atendimento');
    return false;
  }
}

/**
 * Preenche o historico com os agendamentos encerrados que ainda nao estao nele.
 *
 * Roda no boot: cobre os atendimentos encerrados antes desta tabela existir.
 * Vai do mais antigo ao mais novo para "cliente novo" sair certo.
 */
export async function sincronizarHistorico() {
  const faltando = await db
    .select({ id: appointments.id, tenantId: appointments.tenantId })
    .from(appointments)
    .where(
      and(
        inArray(appointments.status, RESULTADOS_ATENDIMENTO),
        isNull(appointments.deletedAt),
        notExists(
          db.select({ x: sql`1` }).from(serviceHistory).where(eq(serviceHistory.appointmentId, appointments.id))
        )
      )
    )
    .orderBy(asc(appointments.inicioEm));

  let gravados = 0;
  for (const a of faltando) {
    if (await registrarDesfecho(a.tenantId, a.id)) gravados += 1;
  }
  if (gravados > 0) log.info({ gravados }, 'Historico de atendimentos preenchido com encerramentos antigos');
  return gravados;
}

/**
 * Metricas resumidas do profissional para a ficha dele.
 *
 * @param {object} [opcoes]
 * @param {number} [opcoes.dias]  janela em dias ate hoje; 0 = desde sempre
 */
export async function metricasDoProfissional(tenantId, professionalId, { dias = 30 } = {}) {
  const fuso = await fusoDe(tenantId);
  const hoje = dataNoFuso(Date.now(), fuso);
  const desde = dias > 0 ? somarDias(hoje, -(dias - 1)) : null;

  const doProfissional = and(
    eq(serviceHistory.tenantId, tenantId),
    eq(serviceHistory.professionalId, professionalId),
    desde ? gte(serviceHistory.dataLocal, desde) : undefined
  );
  const concluidos = and(doProfissional, eq(serviceHistory.resultado, 'concluido'));

  const [[resumo], [porResultado], [maisFeito], [ultimo]] = await Promise.all([
    db
      .select({
        atendimentos: count(),
        faturamento: sum(serviceHistory.valorCentavos),
        clientes: countDistinct(serviceHistory.leadId),
        clientesNovos: sql`COALESCE(SUM(CASE WHEN ${serviceHistory.clienteNovo} THEN 1 ELSE 0 END), 0)`,
        minutos: sum(serviceHistory.duracaoMinutos)
      })
      .from(serviceHistory)
      .where(concluidos),
    db
      .select({
        faltas: sql`COALESCE(SUM(CASE WHEN ${serviceHistory.resultado} = 'faltou' THEN 1 ELSE 0 END), 0)`,
        cancelados: sql`COALESCE(SUM(CASE WHEN ${serviceHistory.resultado} = 'cancelado' THEN 1 ELSE 0 END), 0)`,
        encerrados: count()
      })
      .from(serviceHistory)
      .where(doProfissional),
    db
      .select({ nome: serviceHistory.serviceNome, vezes: count() })
      .from(serviceHistory)
      .where(concluidos)
      .groupBy(serviceHistory.serviceNome)
      .orderBy(desc(count()))
      .limit(1),
    db
      .select({ inicioEm: serviceHistory.inicioEm })
      .from(serviceHistory)
      .where(and(eq(serviceHistory.tenantId, tenantId), eq(serviceHistory.professionalId, professionalId), eq(serviceHistory.resultado, 'concluido')))
      .orderBy(desc(serviceHistory.inicioEm))
      .limit(1)
  ]);

  const [proximos] = await db
    .select({ total: count() })
    .from(appointments)
    .where(
      and(
        eq(appointments.tenantId, tenantId),
        eq(appointments.professionalId, professionalId),
        inArray(appointments.status, ['pendente', 'confirmado', 'em_andamento']),
        gte(appointments.inicioEm, new Date()),
        isNull(appointments.deletedAt)
      )
    );

  const atendimentos = Number(resumo?.atendimentos ?? 0);
  const faturamento = Number(resumo?.faturamento ?? 0);
  const clientes = Number(resumo?.clientes ?? 0);
  const clientesNovos = Number(resumo?.clientesNovos ?? 0);
  const encerrados = Number(porResultado?.encerrados ?? 0);
  const faltas = Number(porResultado?.faltas ?? 0);
  const ticket = atendimentos > 0 ? Math.round(faturamento / atendimentos) : 0;

  return {
    periodo: { dias, desde, ate: hoje },
    atendimentos,
    faturamentoCentavos: faturamento,
    faturamentoFormatado: formatarBRL(faturamento),
    ticketMedioCentavos: ticket,
    ticketMedioFormatado: formatarBRL(ticket),
    horasTrabalhadas: Math.round(Number(resumo?.minutos ?? 0) / 6) / 10,
    clientes,
    clientesNovos,
    clientesRecorrentes: Math.max(0, clientes - clientesNovos),
    faltas,
    cancelados: Number(porResultado?.cancelados ?? 0),
    taxaFaltaPercentual: encerrados > 0 ? Math.round((faltas / encerrados) * 100) : 0,
    servicoMaisFeito: maisFeito ? { nome: maisFeito.nome, vezes: Number(maisFeito.vezes) } : null,
    ultimoAtendimentoEm: ultimo?.inicioEm?.getTime() ?? null,
    proximosAgendados: Number(proximos?.total ?? 0)
  };
}
