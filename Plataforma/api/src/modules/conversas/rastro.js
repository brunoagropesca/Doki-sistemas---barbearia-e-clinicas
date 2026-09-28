import { and, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { dbReal } from '../../db/client.js';
import { messages } from '../../db/schema/conversations.js';
import { comContexto } from '../../core/logger.js';

const log = comContexto({ modulo: 'rastro-ia' });

/**
 * Rastro da IA antigo vira resumo.
 *
 * O primeiro balao de cada resposta da Sofia (e do menu) guarda o rastro
 * completo: consultas com os RESULTADOS inteiros (agenda do dia, precos),
 * pedidos a Atena, estado do menu. Serve para entender o que acabou de
 * acontecer; depois de 3 meses ninguem depura aquela resposta, e o rastro so
 * pesa no banco (era a maior parte dos metadados da IA).
 *
 * Fica o RESUMO — quem respondeu, com qual modelo, quais ferramentas, quantas
 * voltas — e o que a propria conversa usa (balao, motivo da transferencia,
 * avaliacao do Google). Mensagens de cliente e de atendente nunca sao tocadas:
 * la estao canal, audio, anexo e transcricao.
 */

export const DIAS_DE_RASTRO_COMPLETO = 90;

/** O que sobrevive a compactacao (tudo pequeno, e o que alguem ainda le). */
const FICA = [
  'modo',
  'provedor',
  'modelo',
  'voltas',
  'opcao',
  'balao',
  'totalBaloes',
  'motivo',
  'motivoTransferencia',
  'clienteFrustrado',
  'avaliacaoGoogle',
  'erro'
];

/** Metadados de uma mensagem da IA -> o resumo que fica. */
export function resumirRastro(metadados) {
  const m = metadados ?? {};
  const resumo = { rastroCompactado: true };
  for (const chave of FICA) if (m[chave] !== undefined) resumo[chave] = m[chave];
  // Ferramentas: so os NOMES (o rastro guardava argumentos e resultados).
  if (Array.isArray(m.ferramentas) && m.ferramentas.length) resumo.ferramentas = m.ferramentas.map((f) => (typeof f === 'string' ? f : f?.nome)).filter(Boolean);
  return resumo;
}

/**
 * Compacta o rastro das mensagens da IA/menu com mais de 90 dias. Em lotes,
 * para nao segurar o banco de uma vez so. Banco REAL: a demonstracao nao entra.
 *
 * @returns {Promise<{ compactadas: number }>}
 */
export async function compactarRastrosAntigos({ agora = Date.now(), dias = DIAS_DE_RASTRO_COMPLETO, lote = 500 } = {}) {
  const antesDe = new Date(agora - dias * 24 * 3_600_000);
  // So quem ainda tem o que pesa: consultas, Atena ou ferramentas detalhadas.
  const pesado = or(
    isNotNull(sql`json_extract(${messages.metadados}, '$.consultas')`),
    isNotNull(sql`json_extract(${messages.metadados}, '$.atena')`),
    isNotNull(sql`json_extract(${messages.metadados}, '$.menuEstado')`),
    isNotNull(sql`json_extract(${messages.metadados}, '$.caminho')`)
  );
  let compactadas = 0;
  for (;;) {
    const linhas = await dbReal
      .select({ id: messages.id, metadados: messages.metadados })
      .from(messages)
      .where(and(inArray(messages.autorTipo, ['ia', 'menu']), lt(messages.createdAt, antesDe), pesado))
      .limit(lote);
    if (!linhas.length) break;
    for (const { id, metadados } of linhas) {
      await dbReal.update(messages).set({ metadados: resumirRastro(metadados) }).where(sql`${messages.id} = ${id}`);
    }
    compactadas += linhas.length;
    if (linhas.length < lote) break;
  }
  if (compactadas) log.info({ compactadas, dias }, 'Rastro da IA antigo compactado');
  return { compactadas };
}
