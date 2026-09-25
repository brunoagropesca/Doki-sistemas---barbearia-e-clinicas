import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { professionals } from '../../db/schema/crm.js';
import { tenants } from '../../db/schema/tenants.js';
import { dataNoFuso, horaNoFuso, somarDias, FUSO_PADRAO } from '../../core/datetime.js';
import { rotuloDaData } from '../../core/datas-naturais.js';
import { expedienteDoDia } from '../agenda/disponibilidade.js';

/** Quantos dias a frente procurar a proxima abertura (uma semana + folga). */
const DIAS_PROCURA = 8;

/**
 * A casa esta aberta AGORA? E quando abre de novo?
 *
 * Sai da jornada dos profissionais ativos — a MESMA que a agenda usa: aberta
 * = pelo menos um deles esta no expediente agora. Nao existe um "horario da
 * loja" separado, que a empresa teria de manter em dois lugares (e que
 * divergiria da agenda na primeira mudanca de escala).
 *
 * Serve para nao prometer "um instante" as 23h: fora do expediente o cliente
 * fica sabendo QUANDO alguem responde, e a Sofia continua ajudando.
 *
 * @param {string} tenantId
 * @param {number} [agora]  instante em ms (injetavel nos testes)
 * @returns {Promise<{ aberta: boolean, proximaAbertura: string|null }>}
 *   `proximaAbertura` pronto para o cliente: "amanhã às 09:00",
 *   "segunda-feira às 09:00". Null se ninguem trabalha nos proximos dias.
 */
export async function expedienteDaEmpresa(tenantId, agora = Date.now()) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  const fuso = tenant?.fusoHorario || FUSO_PADRAO;
  const equipe = await db
    .select({ jornada: professionals.jornada })
    .from(professionals)
    .where(and(eq(professionals.tenantId, tenantId), eq(professionals.ativo, true), isNull(professionals.deletedAt)));

  const hoje = dataNoFuso(agora, fuso);
  let proxima = null;

  for (let i = 0; i < DIAS_PROCURA; i++) {
    const data = somarDias(hoje, i);
    for (const p of equipe) {
      for (const faixa of expedienteDoDia(p.jornada, data, fuso)) {
        if (faixa.inicio <= agora && agora < faixa.fim) return { aberta: true, proximaAbertura: null };
        if (faixa.inicio > agora && (!proxima || faixa.inicio < proxima)) proxima = faixa.inicio;
      }
    }
    // Achou abertura neste dia: nenhum dia seguinte abre antes dela.
    if (proxima) break;
  }

  if (!proxima) return { aberta: false, proximaAbertura: null };
  // "amanhã, sexta-feira, 26/09" -> "amanhã"; "segunda-feira, 28/09" -> "segunda-feira".
  const dia = rotuloDaData(dataNoFuso(proxima, fuso), hoje).split(',')[0];
  return { aberta: false, proximaAbertura: `${dia} às ${horaNoFuso(proxima, fuso)}` };
}
