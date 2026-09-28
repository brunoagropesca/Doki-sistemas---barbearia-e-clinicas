import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { db, dbReal, emTransacao } from '../../db/client.js';
import { aiCalls, aiCallsMensais, auditLogs, teamNotifications, tenants } from '../../db/schema/index.js';
import { FUSO_PADRAO, instanteDeLocal, partesNoFuso } from '../../core/datetime.js';
import { comContexto } from '../../core/logger.js';

const log = comContexto({ modulo: 'retencao' });

/**
 * Prazo de validade dos registros — o que so cresce e ninguem mais le linha a
 * linha:
 *
 *   ai_calls (uma linha por chamada de IA, a tabela que mais cresce): o
 *     DETALHE fica ~90 dias; cada mes INTEIRO mais velho que isso vira uma
 *     linha de totais em `ai_calls_mensais` (origem, agente, provedor, modelo).
 *     So mes inteiro: um mes nunca fica metade em detalhe, metade em total —
 *     os relatorios por mes e por ANO continuam exatos.
 *   audit_logs: 2 anos por ANO CHEIO — o ano de 2026 inteiro fica ate
 *     31/12/2028 (em 2029 sai). Relatorio e auditoria sao por ano.
 *   notificacoes da equipe ja fechadas: 30 dias.
 *
 * Roda na passada semanal (relogio do backup, ver dados/backups.js). Sempre no
 * banco REAL. Os anos e meses sao os do fuso da empresa (o mesmo do relatorio).
 */

export const DIAS_DE_DETALHE_IA = 90;
export const ANOS_DE_AUDITORIA = 2;
export const DIAS_DE_NOTIFICACAO_FECHADA = 30;

const doisDigitos = (n) => String(n).padStart(2, '0');

/** 'AAAA-MM' do instante, no fuso. */
function mesDe(instante, fuso) {
  const { ano, mes } = partesNoFuso(instante, fuso);
  return `${ano}-${doisDigitos(mes)}`;
}

/** Primeiro instante do mes 'AAAA-MM' e do seguinte, no fuso. */
function limitesDoMes(mes, fuso) {
  const [ano, m] = mes.split('-').map(Number);
  const seguinte = m === 12 ? `${ano + 1}-01` : `${ano}-${doisDigitos(m + 1)}`;
  return { ini: instanteDeLocal(`${mes}-01`, '00:00', fuso), fim: instanteDeLocal(`${seguinte}-01`, '00:00', fuso), seguinte };
}

// ---------------------------------------------------------------------------
// Chamadas de IA: detalhe -> totais do mes
// ---------------------------------------------------------------------------

/**
 * Consolida em totais mensais os meses inteiros com mais de 90 dias, e apaga o
 * detalhe deles. Cada mes numa transacao: soma e apaga juntos, ou nada.
 *
 * @returns {Promise<{ meses: number, linhasApagadas: number }>}
 */
export async function consolidarUsoDeIaAntigo({ agora = Date.now() } = {}) {
  let meses = 0;
  let linhasApagadas = 0;
  for (const { id: tenantId, fusoHorario } of await dbReal.select({ id: tenants.id, fusoHorario: tenants.fusoHorario }).from(tenants)) {
    const fuso = fusoHorario || FUSO_PADRAO;
    // Mes que contem o limite dos 90 dias: dele em diante, o detalhe fica.
    const corte = limitesDoMes(mesDe(agora - DIAS_DE_DETALHE_IA * 86_400_000, fuso), fuso).ini;
    const [{ maisAntiga }] = await dbReal
      .select({ maisAntiga: sql`min(${aiCalls.createdAt})`.as('mais_antiga') })
      .from(aiCalls)
      .where(and(eq(aiCalls.tenantId, tenantId), lt(aiCalls.createdAt, new Date(corte))));
    if (maisAntiga == null) continue;

    for (let mes = mesDe(Number(maisAntiga), fuso); ; ) {
      const { ini, fim, seguinte } = limitesDoMes(mes, fuso);
      if (ini >= corte) break;
      const noMes = and(eq(aiCalls.tenantId, tenantId), gte(aiCalls.createdAt, new Date(ini)), lt(aiCalls.createdAt, new Date(fim)));

      const apagadas = await emTransacao(async (tx) => {
        const grupos = await tx
          .select({
            origem: aiCalls.origem,
            agentKey: sql`coalesce(${aiCalls.agentKey}, '')`.as('agent_key'),
            provedor: aiCalls.provedor,
            modelo: aiCalls.modelo,
            chamadas: sql`count(*)`.as('chamadas'),
            sucessos: sql`sum(case when ${aiCalls.sucesso} = 1 then 1 else 0 end)`.as('sucessos'),
            tokensEntrada: sql`sum(${aiCalls.tokensEntrada})`.as('tokens_entrada'),
            tokensSaida: sql`sum(${aiCalls.tokensSaida})`.as('tokens_saida'),
            latencia: sql`sum(case when ${aiCalls.sucesso} = 1 then ${aiCalls.latenciaMs} else 0 end)`.as('latencia')
          })
          .from(aiCalls)
          .where(noMes)
          .groupBy(aiCalls.origem, sql`coalesce(${aiCalls.agentKey}, '')`, aiCalls.provedor, aiCalls.modelo);

        for (const g of grupos) {
          const valores = {
            chamadas: Number(g.chamadas),
            sucessos: Number(g.sucessos),
            tokensEntrada: Number(g.tokensEntrada),
            tokensSaida: Number(g.tokensSaida),
            latenciaSomaSucessoMs: Number(g.latencia)
          };
          // Somar (e nao trocar): se o mes ja tinha totais, as linhas novas se juntam.
          await tx
            .insert(aiCallsMensais)
            .values({ tenantId, mes, origem: g.origem, agentKey: g.agentKey, provedor: g.provedor, modelo: g.modelo, ...valores })
            .onConflictDoUpdate({
              target: [aiCallsMensais.tenantId, aiCallsMensais.mes, aiCallsMensais.origem, aiCallsMensais.agentKey, aiCallsMensais.provedor, aiCallsMensais.modelo],
              set: Object.fromEntries(Object.keys(valores).map((k) => [k, sql`${aiCallsMensais[k]} + ${valores[k]}`]))
            });
        }
        const r = await tx.delete(aiCalls).where(noMes);
        return r.rowsAffected ?? 0;
      });
      if (apagadas) meses += 1;
      linhasApagadas += apagadas;
      mes = seguinte;
    }
  }
  if (linhasApagadas) log.info({ meses, linhasApagadas }, 'Chamadas de IA antigas consolidadas em totais mensais');
  return { meses, linhasApagadas };
}

/**
 * Os totais mensais que caem num periodo, no formato de "grupos" (o mesmo
 * que o relatorio monta com o detalhe). Mes inteiro dentro do periodo entra
 * inteiro; mes pego pela metade entra PROPORCIONAL aos dias cobertos — e a
 * resposta avisa (`estimado`), porque ai o numero e uma estimativa.
 *
 * @returns {Promise<{ grupos: object[], estimado: boolean }>}
 */
export async function usoDeIaMensalNoPeriodo(tenantId, iniMs, fimMs, fuso = FUSO_PADRAO) {
  // `db` (e nao dbReal): quem le e o relatorio, que segue o banco da requisicao
  // — no modo demonstracao, os totais da demonstracao.
  const linhas = await db.select().from(aiCallsMensais).where(eq(aiCallsMensais.tenantId, tenantId));
  let estimado = false;
  const grupos = [];
  for (const l of linhas) {
    const { ini, fim } = limitesDoMes(l.mes, fuso);
    const sobreposto = Math.min(fim, fimMs) - Math.max(ini, iniMs);
    if (sobreposto <= 0) continue;
    const fator = Math.min(1, sobreposto / (fim - ini));
    if (fator < 0.999) estimado = true;
    const vezes = (n) => Math.round(n * fator);
    grupos.push({
      origem: l.origem,
      agentKey: l.agentKey || null,
      provedor: l.provedor,
      modelo: l.modelo,
      chamadas: vezes(l.chamadas),
      sucessos: vezes(l.sucessos),
      tokensEntrada: vezes(l.tokensEntrada),
      tokensSaida: vezes(l.tokensSaida),
      latenciaSomaSucessoMs: vezes(l.latenciaSomaSucessoMs)
    });
  }
  return { grupos, estimado };
}

// ---------------------------------------------------------------------------
// Auditoria e notificacoes
// ---------------------------------------------------------------------------

/**
 * Tira a auditoria mais velha que 2 anos CHEIOS e as notificacoes fechadas ha
 * mais de 30 dias. Notificacao aberta nunca sai (e trabalho pendente).
 *
 * @returns {Promise<{ auditoria: number, notificacoes: number }>}
 */
export async function expurgarRegistros({ agora = Date.now() } = {}) {
  let auditoria = 0;
  let notificacoes = 0;
  for (const { id: tenantId, fusoHorario } of await dbReal.select({ id: tenants.id, fusoHorario: tenants.fusoHorario }).from(tenants)) {
    const fuso = fusoHorario || FUSO_PADRAO;
    // Em 2026: fica 2024, 2025 e 2026 (o ano corrente + 2 anos cheios); sai ate 2023.
    const { ano } = partesNoFuso(agora, fuso);
    const inicioDoMaisAntigoQueFica = instanteDeLocal(`${ano - ANOS_DE_AUDITORIA}-01-01`, '00:00', fuso);
    const a = await dbReal
      .delete(auditLogs)
      .where(and(eq(auditLogs.tenantId, tenantId), lt(auditLogs.createdAt, new Date(inicioDoMaisAntigoQueFica))));
    auditoria += a.rowsAffected ?? 0;
  }
  const n = await dbReal
    .delete(teamNotifications)
    .where(and(isNotNull(teamNotifications.fechadaEm), lt(teamNotifications.fechadaEm, new Date(agora - DIAS_DE_NOTIFICACAO_FECHADA * 86_400_000))));
  notificacoes += n.rowsAffected ?? 0;
  if (auditoria || notificacoes) log.info({ auditoria, notificacoes }, 'Registros antigos expurgados');
  return { auditoria, notificacoes };
}

/** A passada semanal inteira: consolida o uso de IA e expurga o resto. */
export async function aplicarRetencao({ agora = Date.now() } = {}) {
  const ia = await consolidarUsoDeIaAntigo({ agora });
  const registros = await expurgarRegistros({ agora });
  return { ia, ...registros };
}
