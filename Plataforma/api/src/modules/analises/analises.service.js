import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tenants } from '../../db/schema/tenants.js';
import { users } from '../../db/schema/auth.js';
import { leads, professionals } from '../../db/schema/crm.js';
import { products, stockMovements } from '../../db/schema/catalog.js';
import { appointments, productSales, serviceHistory } from '../../db/schema/scheduling.js';
import { conversations, messages } from '../../db/schema/conversations.js';
import { campaigns, campaignTargets } from '../../db/schema/campaigns.js';
import { aiCalls } from '../../db/schema/ai.js';
import { RegraDeNegocio } from '../../core/errors.js';
import { FUSO_PADRAO, dataNoFuso, diaDaSemana, fimDoDia, inicioDoDia, somarDias } from '../../core/datetime.js';

/**
 * Dashboard do dono: tudo o que o sistema registra, num relatorio so.
 *
 * Fontes:
 *   - `service_history`  — cada atendimento ENCERRADO (concluido, cancelado,
 *     faltou), ja com dia da semana e hora locais gravados: a base de
 *     faturamento, mapa de calor, servicos, profissionais e clientes;
 *   - `product_sales`    — vendas de produto no balcao;
 *   - `appointments`     — o que foi marcado no periodo e o que vem pela frente;
 *   - `conversations` / `messages` — o atendimento no WhatsApp;
 *   - `campaign_targets` — campanhas;  `ai_calls` — uso e custo da IA.
 *
 * Todo numero do resumo vem com o do periodo ANTERIOR de mesmo tamanho, para a
 * tela mostrar a variacao. As contas sao feitas aqui, em JS, sobre as linhas do
 * periodo: o volume de uma barbearia (centenas a poucos milhares por mes) e
 * pequeno, e fazer em JS deixa a conta de fuso horario num lugar so.
 */

const MAX_DIAS = 400;
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// ============================================================================
// PERIODO
// ============================================================================

/**
 * `de`/`ate` inclusivos (YYYY-MM-DD, no fuso da empresa). Sem eles, os
 * ultimos `dias` terminando hoje.
 */
export function resolverPeriodo({ de, ate, dias = 30 }, fuso = FUSO_PADRAO) {
  const hoje = dataNoFuso(Date.now(), fuso);
  const fim = ate ?? hoje;
  const inicio = de ?? somarDias(fim, -(Number(dias) - 1));
  if (inicio > fim) throw new RegraDeNegocio('A data inicial vem depois da final.');

  const total = contarDias(inicio, fim);
  if (total > MAX_DIAS) throw new RegraDeNegocio(`Escolha um período de até ${MAX_DIAS} dias.`);

  const { antInicio, antFim } = periodoAnterior(inicio, fim, total);
  return {
    de: inicio,
    ate: fim,
    dias: total,
    anterior: { de: antInicio, ate: antFim },
    // Limites em instante (ms): [inicio, fim) — fim exclusivo.
    ini: inicioDoDia(inicio, fuso),
    fimMs: fimDoDia(fim, fuso),
    antIni: inicioDoDia(antInicio, fuso),
    antFimMs: fimDoDia(antFim, fuso)
  };
}

/**
 * O periodo de comparacao. Regra geral: os `total` dias logo antes.
 * Periodo que comeca no dia 1 e fica dentro de um mes ("Este mes", "agosto
 * inteiro"): compara com os MESMOS dias do mes anterior — 1 a 24/09 contra
 * 1 a 24/08, nao contra 08/08 a 31/08 (que misturaria o fim de um mes com o
 * comeco do outro). Mes inteiro compara com o mes anterior inteiro.
 */
function periodoAnterior(inicio, fim, total) {
  if (inicio.endsWith('-01') && inicio.slice(0, 7) === fim.slice(0, 7)) {
    const antInicio = `${somarDias(inicio, -1).slice(0, 7)}-01`;
    const ultimoDoAnterior = somarDias(inicio, -1);
    const mesInteiro = somarDias(fim, 1).endsWith('-01');
    const mesmoDia = `${antInicio.slice(0, 8)}${fim.slice(8)}`;
    const antFim = mesInteiro || mesmoDia > ultimoDoAnterior ? ultimoDoAnterior : mesmoDia;
    return { antInicio, antFim };
  }
  const antFim = somarDias(inicio, -1);
  return { antInicio: somarDias(antFim, -(total - 1)), antFim };
}

function contarDias(de, ate) {
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Dia e hora locais de um instante — um formatador so, reaproveitado (e o que custa caro). */
function relogio(fuso) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false
  });
  return (instante) => {
    const p = {};
    for (const { type, value } of fmt.formatToParts(new Date(instante))) p[type] = value;
    const data = `${p.year}-${p.month}-${p.day}`;
    return { data, dia: diaDaSemana(data), hora: Number(p.hour) % 24 };
  };
}

const matriz = () => Array.from({ length: 7 }, () => Array(24).fill(0));
const pct = (parte, todo) => (todo > 0 ? Math.round((parte / todo) * 1000) / 10 : 0);
const media = (lista) => (lista.length ? lista.reduce((s, v) => s + v, 0) / lista.length : null);

/** Soma por chave: `agrupar(linhas, l => l.x, l => l.valor)`. */
function agrupar(linhas, chave, valor = () => 1) {
  const m = new Map();
  for (const l of linhas) {
    const k = chave(l);
    if (k == null) continue;
    m.set(k, (m.get(k) ?? 0) + valor(l));
  }
  return m;
}

// ============================================================================
// O RELATORIO
// ============================================================================

export async function relatorio(tenantId, filtros = {}) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  const fuso = tenant?.fusoHorario || FUSO_PADRAO;
  const p = resolverPeriodo(filtros, fuso);
  const local = relogio(fuso);
  const agora = Date.now();

  const noPeriodo = (col, ini, fim) => and(gte(col, new Date(ini)), lt(col, new Date(fim)));

  const [
    historico,
    historicoAnt,
    vendas,
    vendasAnt,
    novosLeads,
    novosLeadsAnt,
    totalLeads,
    conversasP,
    conversasAnt,
    entradas,
    marcados,
    proximos,
    alvos,
    campanhasP,
    chamadasIa,
    produtos,
    perdas,
    profissionais,
    equipe,
    historicoGeral,
    primeiros
  ] = await Promise.all([
    db.select().from(serviceHistory).where(and(eq(serviceHistory.tenantId, tenantId), gte(serviceHistory.dataLocal, p.de), lte(serviceHistory.dataLocal, p.ate))),
    db
      .select({ resultado: serviceHistory.resultado, valorCentavos: serviceHistory.valorCentavos, leadId: serviceHistory.leadId, clienteNovo: serviceHistory.clienteNovo, duracaoMinutos: serviceHistory.duracaoMinutos, descontoCentavos: serviceHistory.descontoCentavos })
      .from(serviceHistory)
      .where(and(eq(serviceHistory.tenantId, tenantId), gte(serviceHistory.dataLocal, p.anterior.de), lte(serviceHistory.dataLocal, p.anterior.ate))),
    db
      .select({
        id: productSales.id,
        productId: productSales.productId,
        quantidade: productSales.quantidade,
        totalCentavos: productSales.totalCentavos,
        vendidoEm: productSales.vendidoEm,
        vendedorId: productSales.vendidoPorUserId,
        leadId: productSales.leadId
      })
      .from(productSales)
      .where(and(eq(productSales.tenantId, tenantId), isNull(productSales.deletedAt), noPeriodo(productSales.vendidoEm, p.ini, p.fimMs))),
    db
      .select({ quantidade: productSales.quantidade, totalCentavos: productSales.totalCentavos })
      .from(productSales)
      .where(and(eq(productSales.tenantId, tenantId), isNull(productSales.deletedAt), noPeriodo(productSales.vendidoEm, p.antIni, p.antFimMs))),
    db
      .select({ id: leads.id, origem: leads.origem, createdAt: leads.createdAt })
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), isNull(leads.deletedAt), noPeriodo(leads.createdAt, p.ini, p.fimMs))),
    db
      .select({ c: sql`count(*)` })
      .from(leads)
      .where(and(eq(leads.tenantId, tenantId), isNull(leads.deletedAt), noPeriodo(leads.createdAt, p.antIni, p.antFimMs))),
    db.select({ c: sql`count(*)` }).from(leads).where(and(eq(leads.tenantId, tenantId), isNull(leads.deletedAt))),
    db
      .select({
        id: conversations.id,
        status: conversations.status,
        assignedUserId: conversations.assignedUserId,
        assumidaEm: conversations.assumidaEm,
        primeiraRespostaSegundos: conversations.primeiraRespostaSegundos,
        totalMensagensCliente: conversations.totalMensagensCliente,
        totalMensagensIa: conversations.totalMensagensIa,
        totalMensagensHumano: conversations.totalMensagensHumano,
        humor: conversations.humor,
        createdAt: conversations.createdAt,
        finalizadaEm: conversations.finalizadaEm
      })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), isNull(conversations.deletedAt), noPeriodo(conversations.createdAt, p.ini, p.fimMs))),
    db
      .select({ c: sql`count(*)` })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenantId), isNull(conversations.deletedAt), noPeriodo(conversations.createdAt, p.antIni, p.antFimMs))),
    // Mensagens que os CLIENTES mandaram: quando a demanda chega.
    db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(conversations.tenantId, tenantId), eq(messages.direcao, 'entrada'), noPeriodo(messages.createdAt, p.ini, p.fimMs))),
    // Horarios MARCADOS no periodo (quando alguem agendou, nao quando acontece).
    db
      .select({
        id: appointments.id,
        criadoPor: appointments.criadoPor,
        inicioEm: appointments.inicioEm,
        createdAt: appointments.createdAt,
        conversationId: appointments.conversationId,
        status: appointments.status
      })
      .from(appointments)
      .where(and(eq(appointments.tenantId, tenantId), isNull(appointments.deletedAt), noPeriodo(appointments.createdAt, p.ini, p.fimMs))),
    db
      .select({ inicioEm: appointments.inicioEm, precoCentavos: appointments.precoCentavos, descontoCentavos: appointments.descontoCentavos })
      .from(appointments)
      .where(
        and(
          eq(appointments.tenantId, tenantId),
          isNull(appointments.deletedAt),
          inArray(appointments.status, ['pendente', 'confirmado']),
          noPeriodo(appointments.inicioEm, agora, agora + 7 * 86_400_000)
        )
      ),
    db
      .select({ campaignId: campaignTargets.campaignId, status: campaignTargets.status, classificacao: campaignTargets.classificacao, respondidoEm: campaignTargets.respondidoEm })
      .from(campaignTargets)
      .where(and(eq(campaignTargets.tenantId, tenantId), noPeriodo(campaignTargets.enviadoEm, p.ini, p.fimMs))),
    db
      .select({ id: campaigns.id, nome: campaigns.nome, status: campaigns.status, totalAlvos: campaigns.totalAlvos })
      .from(campaigns)
      .where(eq(campaigns.tenantId, tenantId)),
    db
      .select({
        agentKey: aiCalls.agentKey,
        origem: aiCalls.origem,
        provedor: aiCalls.provedor,
        modelo: aiCalls.modelo,
        sucesso: aiCalls.sucesso,
        latenciaMs: aiCalls.latenciaMs,
        tokensEntrada: aiCalls.tokensEntrada,
        tokensSaida: aiCalls.tokensSaida
      })
      .from(aiCalls)
      .where(and(eq(aiCalls.tenantId, tenantId), noPeriodo(aiCalls.createdAt, p.ini, p.fimMs))),
    db.select().from(products).where(and(eq(products.tenantId, tenantId), isNull(products.deletedAt))),
    db
      .select({ productId: stockMovements.productId, quantidade: stockMovements.quantidade })
      .from(stockMovements)
      .where(and(eq(stockMovements.tenantId, tenantId), eq(stockMovements.tipo, 'perda'), noPeriodo(stockMovements.createdAt, p.ini, p.fimMs))),
    db.select().from(professionals).where(and(eq(professionals.tenantId, tenantId), isNull(professionals.deletedAt))),
    db.select({ id: users.id, nome: users.nome, cargo: users.cargo }).from(users).where(eq(users.tenantId, tenantId)),
    // Todo o historico de atendimentos concluidos, por cliente: base de
    // "clientes em risco" e da frequencia de retorno (nao so do periodo).
    db
      .select({ leadId: serviceHistory.leadId, dataLocal: serviceHistory.dataLocal, valorCentavos: serviceHistory.valorCentavos })
      .from(serviceHistory)
      .where(and(eq(serviceHistory.tenantId, tenantId), eq(serviceHistory.resultado, 'concluido'), isNotNull(serviceHistory.leadId))),
    // Desde quando o sistema tem movimento: o 1o atendimento e a 1a conversa.
    Promise.all([
      db.select({ v: sql`min(${serviceHistory.dataLocal})` }).from(serviceHistory).where(eq(serviceHistory.tenantId, tenantId)),
      db.select({ v: sql`min(${conversations.createdAt})` }).from(conversations).where(eq(conversations.tenantId, tenantId))
    ])
  ]);

  // Comparar com um periodo em que o sistema ainda nao existia da variacoes
  // absurdas ("+7.000%"). Se o anterior comeca antes do 1o registro, a tela
  // mostra "sem base" em vez da porcentagem.
  const [[{ v: primeiroAtend }], [{ v: primeiraConversa }]] = primeiros;
  const inicioDosDados = [primeiroAtend, primeiraConversa != null ? dataNoFuso(Number(primeiraConversa), fuso) : null]
    .filter(Boolean)
    .sort()[0] ?? null;
  const anteriorCompleto = inicioDosDados != null && inicioDosDados <= p.anterior.de;

  const concluidos = historico.filter((h) => h.resultado === 'concluido');
  const faltas = historico.filter((h) => h.resultado === 'faltou');
  const cancelados = historico.filter((h) => h.resultado === 'cancelado');
  const nomeUsuario = new Map(equipe.map((u) => [u.id, u.nome]));
  const produtoPorId = new Map(produtos.map((pr) => [pr.id, pr]));

  // --------------------------------------------------------------------------
  // RESUMO (com o periodo anterior)
  // --------------------------------------------------------------------------
  function resumoDe(hist, vend, novos, conv) {
    const conc = hist.filter((h) => h.resultado === 'concluido');
    const servicos = conc.reduce((s, h) => s + h.valorCentavos, 0);
    const produtosV = vend.reduce((s, v) => s + v.totalCentavos, 0);
    const encerrados = hist.length;
    const falt = hist.filter((h) => h.resultado === 'faltou').length;
    const canc = hist.filter((h) => h.resultado === 'cancelado').length;
    const clientes = new Set(conc.map((h) => h.leadId).filter(Boolean));
    return {
      faturamentoCentavos: servicos + produtosV,
      servicosCentavos: servicos,
      produtosCentavos: produtosV,
      atendimentos: conc.length,
      ticketMedioCentavos: conc.length ? Math.round(servicos / conc.length) : 0,
      clientesAtendidos: clientes.size,
      clientesNovos: conc.filter((h) => h.clienteNovo).length,
      novosContatos: novos,
      itensVendidos: vend.reduce((s, v) => s + v.quantidade, 0),
      faltas: falt,
      cancelados: canc,
      taxaFalta: pct(falt, encerrados),
      taxaCancelamento: pct(canc, encerrados),
      descontosCentavos: conc.reduce((s, h) => s + (h.descontoCentavos ?? 0), 0),
      horasTrabalhadas: Math.round(conc.reduce((s, h) => s + Math.max(0, h.duracaoMinutos), 0) / 6) / 10,
      conversas: conv
    };
  }

  const resumo = resumoDe(historico, vendas, novosLeads.length, conversasP.length);
  const resumoAnterior = resumoDe(historicoAnt, vendasAnt, Number(novosLeadsAnt[0]?.c ?? 0), Number(conversasAnt[0]?.c ?? 0));

  // --------------------------------------------------------------------------
  // SERIE NO TEMPO (dia; semana ou mes em periodos longos)
  // --------------------------------------------------------------------------
  const granularidade = p.dias <= 62 ? 'dia' : p.dias <= 190 ? 'semana' : 'mes';
  const baldeDe = (data) => {
    if (granularidade === 'dia') return data;
    if (granularidade === 'mes') return `${data.slice(0, 7)}-01`;
    // Semana comeca na segunda.
    const d = diaDaSemana(data);
    return somarDias(data, -((d + 6) % 7));
  };
  // Cada balde vai de `inicio` a `fim` DENTRO do periodo: a semana que
  // comeca antes dele nao aparece como "22/06" num periodo que abre em 27/06.
  // `parcial`: o balde tem menos dias que uma semana/mes cheio — a tela avisa,
  // para a primeira e a ultima barra nao parecerem uma queda de movimento.
  const baldes = [];
  const balde = new Map();
  for (let d = p.de; d <= p.ate; d = somarDias(d, 1)) {
    const chave = baldeDe(d);
    let b = balde.get(chave);
    if (!b) {
      b = { inicio: d, fim: d, dias: 0, parcial: false, servicosCentavos: 0, produtosCentavos: 0, atendimentos: 0, novosClientes: 0 };
      balde.set(chave, b);
      baldes.push(b);
    }
    b.fim = d;
    b.dias += 1;
  }
  for (const b of baldes) {
    const cheio = granularidade === 'semana' ? 7 : granularidade === 'mes' ? contarDias(`${b.inicio.slice(0, 7)}-01`, somarDias(`${somarDias(`${b.inicio.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1)) : 1;
    b.parcial = b.dias < cheio;
  }
  for (const h of concluidos) {
    const b = balde.get(baldeDe(h.dataLocal));
    if (!b) continue;
    b.servicosCentavos += h.valorCentavos;
    b.atendimentos += 1;
    if (h.clienteNovo) b.novosClientes += 1;
  }
  const horaVenda = new Map(vendas.map((v) => [v.id, local(v.vendidoEm)]));
  for (const v of vendas) {
    const b = balde.get(baldeDe(horaVenda.get(v.id).data));
    if (b) b.produtosCentavos += v.totalCentavos;
  }

  // --------------------------------------------------------------------------
  // MAPAS DE CALOR (dia da semana x hora)
  // --------------------------------------------------------------------------
  const calor = {
    atendimentos: matriz(),
    faturamento: matriz(),
    faltas: matriz(),
    mensagens: matriz(),
    vendas: matriz()
  };
  for (const h of historico) {
    if (h.resultado === 'concluido') {
      calor.atendimentos[h.diaSemana][h.horaLocal] += 1;
      calor.faturamento[h.diaSemana][h.horaLocal] += h.valorCentavos;
    } else {
      calor.faltas[h.diaSemana][h.horaLocal] += 1;
    }
  }
  for (const m of entradas) {
    const l = local(m.createdAt);
    calor.mensagens[l.dia][l.hora] += 1;
  }
  for (const v of vendas) {
    const l = horaVenda.get(v.id);
    calor.faturamento[l.dia][l.hora] += v.totalCentavos;
    calor.vendas[l.dia][l.hora] += v.quantidade;
  }

  // --------------------------------------------------------------------------
  // MAPAS DE CALOR DO MES E DO ANO (o seletor ao lado do titulo, na tela)
  //   mes: semana do mes (dias 1-7, 8-14, 15-21, 22-28, 29-31) x dia da semana
  //        -> "o comeco do mes (salario) enche mais que o fim?"
  //   ano: mes (jan-dez) x dia da semana -> sazonalidade, e em que dias.
  // Mesmos registros e metricas do mapa da semana; colunas por dia da semana
  // (0 = domingo; a tela ordena segunda primeiro).
  // --------------------------------------------------------------------------
  const VISOES = {
    mes: { linhas: ['1 a 7', '8 a 14', '15 a 21', '22 a 28', '29 a 31'], linhaDe: (data) => Math.min(4, Math.floor((Number(data.slice(8, 10)) - 1) / 7)) },
    ano: { linhas: ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'], linhaDe: (data) => Number(data.slice(5, 7)) - 1 }
  };
  const visoes = {};
  for (const [nome, v] of Object.entries(VISOES)) {
    const nova = () => Array.from({ length: v.linhas.length }, () => Array(7).fill(0));
    const m = { atendimentos: nova(), faturamento: nova(), faltas: nova(), mensagens: nova(), vendas: nova() };
    for (const h of historico) {
      const l = v.linhaDe(h.dataLocal);
      if (h.resultado === 'concluido') {
        m.atendimentos[l][h.diaSemana] += 1;
        m.faturamento[l][h.diaSemana] += h.valorCentavos;
      } else {
        m.faltas[l][h.diaSemana] += 1;
      }
    }
    for (const e of entradas) {
      const l = local(e.createdAt);
      m.mensagens[v.linhaDe(l.data)][l.dia] += 1;
    }
    for (const venda of vendas) {
      const l = horaVenda.get(venda.id);
      m.faturamento[v.linhaDe(l.data)][l.dia] += venda.totalCentavos;
      m.vendas[v.linhaDe(l.data)][l.dia] += venda.quantidade;
    }
    const picoDe = (mat) => {
      let melhor = null;
      mat.forEach((linha, li) => linha.forEach((val, dia) => { if (val > 0 && (!melhor || val > melhor.valor)) melhor = { linha: li, coluna: dia, valor: val }; }));
      return melhor;
    };
    visoes[nome] = {
      linhas: v.linhas,
      ...m,
      picos: Object.fromEntries(Object.entries(m).map(([k, mat]) => [k, picoDe(mat)])),
      porLinha: Object.fromEntries(Object.entries(m).map(([k, mat]) => [k, mat.map((linha) => linha.reduce((a, b) => a + b, 0))])),
      porColuna: Object.fromEntries(Object.entries(m).map(([k, mat]) => [k, Array.from({ length: 7 }, (_, d) => mat.reduce((a, linha) => a + linha[d], 0))]))
    };
  }

  const pico = (m) => {
    let melhor = null;
    m.forEach((linha, d) => linha.forEach((v, h) => { if (v > 0 && (!melhor || v > melhor.valor)) melhor = { dia: d, hora: h, valor: v }; }));
    return melhor ? { ...melhor, rotulo: `${DIAS[melhor.dia]} às ${String(melhor.hora).padStart(2, '0')}h` } : null;
  };
  const porDiaSemana = (m) => m.map((linha) => linha.reduce((s, v) => s + v, 0));
  const porHora = (m) => Array.from({ length: 24 }, (_, h) => m.reduce((s, linha) => s + linha[h], 0));

  // --------------------------------------------------------------------------
  // SERVICOS E CATEGORIAS
  // --------------------------------------------------------------------------
  const servicos = [...agrupar(concluidos, (h) => h.serviceNome).keys()]
    .map((nome) => {
      const doServ = concluidos.filter((h) => h.serviceNome === nome);
      const valor = doServ.reduce((s, h) => s + h.valorCentavos, 0);
      return {
        nome,
        categoria: doServ[0].serviceCategoria,
        quantidade: doServ.length,
        faturamentoCentavos: valor,
        ticketMedioCentavos: Math.round(valor / doServ.length),
        descontosCentavos: doServ.reduce((s, h) => s + (h.descontoCentavos ?? 0), 0),
        duracaoMediaMin: Math.round(media(doServ.map((h) => Math.max(0, h.duracaoMinutos)))),
        participacao: pct(valor, resumo.servicosCentavos),
        faltas: faltas.filter((h) => h.serviceNome === nome).length
      };
    })
    .sort((a, b) => b.faturamentoCentavos - a.faturamentoCentavos);

  const categorias = [...agrupar(concluidos, (h) => h.serviceCategoria, (h) => h.valorCentavos)]
    .map(([nome, valor]) => ({
      nome,
      faturamentoCentavos: valor,
      quantidade: concluidos.filter((h) => h.serviceCategoria === nome).length,
      participacao: pct(valor, resumo.servicosCentavos)
    }))
    .sort((a, b) => b.faturamentoCentavos - a.faturamentoCentavos);

  // --------------------------------------------------------------------------
  // PROFISSIONAIS (com ocupacao da jornada)
  // --------------------------------------------------------------------------
  const minutosDaJornada = (jornada) => {
    const porDia = [0, 1, 2, 3, 4, 5, 6].map((d) =>
      (jornada?.dias?.[d] ?? []).reduce((s, f) => {
        const [hi, mi] = f.inicio.split(':').map(Number);
        const [hf, mf] = f.fim.split(':').map(Number);
        return s + Math.max(0, hf * 60 + mf - (hi * 60 + mi));
      }, 0)
    );
    let total = 0;
    for (let d = p.de; d <= p.ate; d = somarDias(d, 1)) total += porDia[diaDaSemana(d)];
    return total;
  };

  const idsProf = new Set([...profissionais.filter((pr) => pr.ativo).map((pr) => pr.id), ...historico.map((h) => h.professionalId).filter(Boolean)]);
  const profissionaisOut = [...idsProf]
    .map((id) => {
      const cad = profissionais.find((pr) => pr.id === id);
      const doProf = historico.filter((h) => h.professionalId === id);
      const conc = doProf.filter((h) => h.resultado === 'concluido');
      const valor = conc.reduce((s, h) => s + h.valorCentavos, 0);
      const minutos = conc.reduce((s, h) => s + Math.max(0, h.duracaoMinutos), 0);
      const disponivel = cad ? minutosDaJornada(cad.jornada) : 0;
      return {
        id,
        nome: cad?.nome ?? doProf[0]?.professionalNome ?? 'Profissional removido',
        cor: cad?.cor ?? '#888888',
        ativo: cad?.ativo ?? false,
        atendimentos: conc.length,
        faturamentoCentavos: valor,
        ticketMedioCentavos: conc.length ? Math.round(valor / conc.length) : 0,
        clientes: new Set(conc.map((h) => h.leadId).filter(Boolean)).size,
        clientesNovos: conc.filter((h) => h.clienteNovo).length,
        horasTrabalhadas: Math.round(minutos / 6) / 10,
        horasDisponiveis: Math.round(disponivel / 6) / 10,
        ocupacao: pct(minutos, disponivel),
        faltas: doProf.filter((h) => h.resultado === 'faltou').length,
        cancelados: doProf.filter((h) => h.resultado === 'cancelado').length,
        participacao: pct(valor, resumo.servicosCentavos)
      };
    })
    .sort((a, b) => b.faturamentoCentavos - a.faturamentoCentavos);

  // --------------------------------------------------------------------------
  // PRODUTOS E ESTOQUE
  // --------------------------------------------------------------------------
  const produtosOut = produtos
    .map((pr) => {
      const doProd = vendas.filter((v) => v.productId === pr.id);
      const qtd = doProd.reduce((s, v) => s + v.quantidade, 0);
      const receita = doProd.reduce((s, v) => s + v.totalCentavos, 0);
      const custo = (pr.custoCentavos ?? 0) * qtd;
      return {
        id: pr.id,
        nome: pr.nome,
        categoria: pr.categoria,
        ativo: pr.ativo,
        vendidos: qtd,
        faturamentoCentavos: receita,
        lucroCentavos: receita - custo,
        margem: pct(receita - custo, receita),
        estoque: pr.estoque,
        estoqueMinimo: pr.estoqueMinimo,
        abaixoDoMinimo: pr.ativo && pr.estoque <= pr.estoqueMinimo,
        perdas: perdas.filter((m) => m.productId === pr.id).reduce((s, m) => s + Math.abs(m.quantidade), 0),
        participacao: pct(receita, resumo.produtosCentavos)
      };
    })
    .sort((a, b) => b.faturamentoCentavos - a.faturamentoCentavos || b.vendidos - a.vendidos);

  const ativosProd = produtos.filter((pr) => pr.ativo);
  const estoque = {
    itens: ativosProd.reduce((s, pr) => s + Math.max(0, pr.estoque), 0),
    valorVendaCentavos: ativosProd.reduce((s, pr) => s + Math.max(0, pr.estoque) * pr.precoCentavos, 0),
    valorCustoCentavos: ativosProd.reduce((s, pr) => s + Math.max(0, pr.estoque) * (pr.custoCentavos ?? 0), 0),
    abaixoDoMinimo: produtosOut.filter((pr) => pr.abaixoDoMinimo).length,
    semEstoque: ativosProd.filter((pr) => pr.estoque <= 0).length
  };
  const lucroProdutos = produtosOut.reduce((s, pr) => s + pr.lucroCentavos, 0);

  const vendedores = [...agrupar(vendas, (v) => v.vendedorId ?? 'sem', (v) => v.totalCentavos)]
    .map(([id, valor]) => ({
      nome: id === 'sem' ? 'Não identificado' : nomeUsuario.get(id) ?? 'Usuário removido',
      faturamentoCentavos: valor,
      itens: vendas.filter((v) => (v.vendedorId ?? 'sem') === id).reduce((s, v) => s + v.quantidade, 0)
    }))
    .sort((a, b) => b.faturamentoCentavos - a.faturamentoCentavos);

  // --------------------------------------------------------------------------
  // CLIENTES
  // --------------------------------------------------------------------------
  const porCliente = new Map();
  for (const h of historicoGeral) {
    if (!porCliente.has(h.leadId)) porCliente.set(h.leadId, []);
    porCliente.get(h.leadId).push(h);
  }
  const hoje = dataNoFuso(agora, fuso);
  const intervalos = [];
  const emRiscoIds = [];
  for (const [leadId, visitas] of porCliente) {
    const datas = [...new Set(visitas.map((v) => v.dataLocal))].sort();
    for (let i = 1; i < datas.length; i++) intervalos.push(contarDias(datas[i - 1], datas[i]) - 1);
    // Cliente fiel (2+ visitas) que sumiu: 45 dias sem voltar.
    const ultima = datas.at(-1);
    if (datas.length >= 2 && contarDias(ultima, hoje) - 1 > 45) {
      emRiscoIds.push({ leadId, ultima, visitas: datas.length, gasto: visitas.reduce((s, v) => s + v.valorCentavos, 0) });
    }
  }

  const gastoNoPeriodo = [...agrupar(concluidos, (h) => h.leadId, (h) => h.valorCentavos)];
  for (const v of vendas) {
    if (!v.leadId) continue;
    const i = gastoNoPeriodo.findIndex(([id]) => id === v.leadId);
    if (i >= 0) gastoNoPeriodo[i][1] += v.totalCentavos;
    else gastoNoPeriodo.push([v.leadId, v.totalCentavos]);
  }
  const topIds = gastoNoPeriodo.sort((a, b) => b[1] - a[1]).slice(0, 10);
  emRiscoIds.sort((a, b) => b.gasto - a.gasto);
  const riscoTop = emRiscoIds.slice(0, 10);

  const idsNomes = [...new Set([...topIds.map(([id]) => id), ...riscoTop.map((r) => r.leadId)])];
  const nomesLeads = idsNomes.length
    ? new Map((await db.select({ id: leads.id, nome: leads.nome, telefone: leads.telefone }).from(leads).where(inArray(leads.id, idsNomes))).map((l) => [l.id, l]))
    : new Map();

  const clientes = {
    base: Number(totalLeads[0]?.c ?? 0),
    novosContatos: novosLeads.length,
    porOrigem: [...agrupar(novosLeads, (l) => l.origem || 'whatsapp')].map(([origem, total]) => ({ origem, total })).sort((a, b) => b.total - a.total),
    atendidos: resumo.clientesAtendidos,
    primeiraVisita: resumo.clientesNovos,
    recorrentes: Math.max(0, resumo.clientesAtendidos - new Set(concluidos.filter((h) => h.clienteNovo).map((h) => h.leadId)).size),
    frequenciaRetornoDias: intervalos.length ? Math.round(media(intervalos)) : null,
    emRisco: emRiscoIds.length,
    top: topIds.map(([id, valor]) => ({
      id,
      nome: nomesLeads.get(id)?.nome ?? 'Cliente removido',
      gastoCentavos: valor,
      visitas: concluidos.filter((h) => h.leadId === id).length
    })),
    risco: riscoTop.map((r) => ({
      id: r.leadId,
      nome: nomesLeads.get(r.leadId)?.nome ?? 'Cliente removido',
      ultimaVisita: r.ultima,
      diasSemVir: contarDias(r.ultima, hoje) - 1,
      visitas: r.visitas,
      gastoTotalCentavos: r.gasto
    })),
    humor: [...agrupar(historico.filter((h) => h.humor), (h) => h.humor)].map(([humor, total]) => ({ humor, total }))
  };

  // --------------------------------------------------------------------------
  // AGENDA
  // --------------------------------------------------------------------------
  const antecedencias = marcados.filter((a) => a.createdAt).map((a) => (a.inicioEm.getTime() - a.createdAt.getTime()) / 3_600_000).filter((h) => h >= 0);
  const agenda = {
    marcados: marcados.length,
    porOrigem: [...agrupar(marcados, (a) => a.criadoPor)].map(([origem, total]) => ({ origem, total, participacao: pct(total, marcados.length) })).sort((a, b) => b.total - a.total),
    antecedenciaMediaHoras: antecedencias.length ? Math.round(media(antecedencias)) : null,
    viaConversa: marcados.filter((a) => a.conversationId).length,
    proximos7Dias: proximos.length,
    receitaPrevista7DiasCentavos: proximos.reduce((s, a) => s + Math.max(0, (a.precoCentavos ?? 0) - (a.descontoCentavos ?? 0)), 0),
    motivosCancelamento: [...agrupar(cancelados.filter((h) => h.motivoCancelamento?.trim()), (h) => h.motivoCancelamento.trim())]
      .map(([motivo, total]) => ({ motivo, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6)
  };

  // --------------------------------------------------------------------------
  // ATENDIMENTO NO WHATSAPP
  // --------------------------------------------------------------------------
  const primeiras = conversasP.map((c) => c.primeiraRespostaSegundos).filter((s) => s != null);
  const soIa = conversasP.filter((c) => c.status === 'finalizada' && !c.assignedUserId && !c.assumidaEm && c.totalMensagensHumano === 0);
  const comAgendamento = new Set(marcados.map((a) => a.conversationId).filter(Boolean));
  const atendimento = {
    conversas: conversasP.length,
    finalizadas: conversasP.filter((c) => c.status === 'finalizada').length,
    abertasAgora: conversasP.filter((c) => c.status !== 'finalizada').length,
    porStatus: [...agrupar(conversasP, (c) => c.status)].map(([status, total]) => ({ status, total })),
    resolvidasSoPelaIa: soIa.length,
    taxaResolucaoIa: pct(soIa.length, conversasP.filter((c) => c.status === 'finalizada').length),
    passaramPorPessoa: conversasP.filter((c) => c.assumidaEm || c.totalMensagensHumano > 0).length,
    primeiraRespostaMediaSeg: primeiras.length ? Math.round(media(primeiras)) : null,
    mensagens: {
      clientes: conversasP.reduce((s, c) => s + c.totalMensagensCliente, 0),
      ia: conversasP.reduce((s, c) => s + c.totalMensagensIa, 0),
      equipe: conversasP.reduce((s, c) => s + c.totalMensagensHumano, 0)
    },
    conversao: pct(conversasP.filter((c) => comAgendamento.has(c.id)).length, conversasP.length),
    humor: [...agrupar(conversasP.filter((c) => c.humor), (c) => c.humor)].map(([humor, total]) => ({ humor, total })),
    porAtendente: [...agrupar(conversasP.filter((c) => c.assignedUserId), (c) => c.assignedUserId)]
      .map(([id, total]) => {
        const deles = conversasP.filter((c) => c.assignedUserId === id);
        const prim = deles.map((c) => c.primeiraRespostaSegundos).filter((s) => s != null);
        return {
          nome: nomeUsuario.get(id) ?? 'Usuário removido',
          conversas: total,
          finalizadas: deles.filter((c) => c.status === 'finalizada').length,
          mensagens: deles.reduce((s, c) => s + c.totalMensagensHumano, 0),
          primeiraRespostaMediaSeg: prim.length ? Math.round(media(prim)) : null
        };
      })
      .sort((a, b) => b.conversas - a.conversas)
  };

  // --------------------------------------------------------------------------
  // CAMPANHAS E IA
  // --------------------------------------------------------------------------
  const campanhasOut = campanhasP
    .map((c) => {
      const deles = alvos.filter((a) => a.campaignId === c.id);
      const respostas = deles.filter((a) => a.respondidoEm).length;
      return {
        nome: c.nome,
        status: c.status,
        enviadas: deles.length,
        respostas,
        taxaResposta: pct(respostas, deles.length),
        interessados: deles.filter((a) => a.classificacao === 'interessado').length,
        recusas: deles.filter((a) => a.classificacao === 'recusa').length
      };
    })
    .filter((c) => c.enviadas > 0)
    .sort((a, b) => b.enviadas - a.enviadas);

  const respostasCamp = alvos.filter((a) => a.respondidoEm).length;
  const campanhas = {
    enviadas: alvos.length,
    respostas: respostasCamp,
    taxaResposta: pct(respostasCamp, alvos.length),
    interessados: alvos.filter((a) => a.classificacao === 'interessado').length,
    recusas: alvos.filter((a) => a.classificacao === 'recusa').length,
    lista: campanhasOut
  };

  const okIa = chamadasIa.filter((c) => c.sucesso);
  const ia = {
    chamadas: chamadasIa.length,
    falhas: chamadasIa.length - okIa.length,
    taxaSucesso: pct(okIa.length, chamadasIa.length),
    tokensEntrada: chamadasIa.reduce((s, c) => s + c.tokensEntrada, 0),
    tokensSaida: chamadasIa.reduce((s, c) => s + c.tokensSaida, 0),
    latenciaMediaMs: okIa.length ? Math.round(media(okIa.map((c) => c.latenciaMs))) : null,
    porModelo: [...agrupar(chamadasIa, (c) => `${c.provedor} · ${c.modelo}`)]
      .map(([modelo, total]) => {
        const deles = chamadasIa.filter((c) => `${c.provedor} · ${c.modelo}` === modelo);
        return { modelo, chamadas: total, falhas: deles.filter((c) => !c.sucesso).length, tokens: deles.reduce((s, c) => s + c.tokensEntrada + c.tokensSaida, 0) };
      })
      .sort((a, b) => b.chamadas - a.chamadas),
    porAgente: [...agrupar(chamadasIa, (c) => c.agentKey ?? c.origem)].map(([agente, total]) => ({ agente, chamadas: total })).sort((a, b) => b.chamadas - a.chamadas)
  };

  return {
    periodo: { de: p.de, ate: p.ate, dias: p.dias, anterior: { ...p.anterior, completo: anteriorCompleto }, inicioDosDados, fuso, granularidade },
    resumo,
    resumoAnterior,
    serie: baldes,
    calor: {
      ...calor,
      picos: Object.fromEntries(Object.entries(calor).map(([k, m]) => [k, pico(m)])),
      porDiaSemana: Object.fromEntries(Object.entries(calor).map(([k, m]) => [k, porDiaSemana(m)])),
      porHora: Object.fromEntries(Object.entries(calor).map(([k, m]) => [k, porHora(m)])),
      visoes
    },
    servicos,
    categorias,
    profissionais: profissionaisOut,
    produtos: { lista: produtosOut, estoque, lucroCentavos: lucroProdutos, vendedores },
    clientes,
    agenda,
    atendimento,
    campanhas,
    ia
  };
}
