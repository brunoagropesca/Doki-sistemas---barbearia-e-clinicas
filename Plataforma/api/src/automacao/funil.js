import { ETAPAS_ATENDIMENTO } from '../db/schema/conversations.js';
import { comContexto } from '../core/logger.js';
import { negrito, ver } from '../core/painel.js';
import { atenaPermite } from '../ai/permissoes.js';
import * as conversas from '../modules/conversas/conversas.service.js';

const log = comContexto({ modulo: 'funil' });

/**
 * O funil de atendimento, conduzido pela Atena.
 *
 * As etapas de conversa (novo, entendendo, orcamento, aguardando) sao
 * CONSEQUENCIA de fatos que o sistema ja observa: a Atena listou os servicos,
 * consultou horarios, o cliente ficou de responder. Pedir a um modelo que
 * "lembre de mover o cartao" custa tokens e falha quando ele esquece — e ele
 * esquecia, era por isso que o quadro andava "as vezes".
 *
 * Entao a regra vive no codigo e roda toda vez, sem custo. A Atena continua
 * sendo quem conduz: as regras disparam a partir do que ELA fez, e so agem se
 * a permissao "Manter o quadro em dia" estiver ligada na configuracao dela.
 *
 * REGRA DE OURO: so avanca, nunca recua. Um cliente que ja recebeu orcamento e
 * volta a perguntar o preco de outro servico continua em `orcamento`. Recuar
 * faria o cartao pular de coluna a cada mensagem e a equipe pararia de
 * confiar no quadro. Quem quiser mover para tras arrasta o cartao na mao.
 */

const posicao = (etapa) => ETAPAS_ATENDIMENTO.indexOf(etapa);

/** Ferramentas que indicam "a Atena esta descobrindo o que o cliente quer". */
const CONSULTAS_DE_ENTENDIMENTO = new Set([
  'listar_servicos',
  'listar_profissionais',
  'consultar_dados_do_cliente',
  'consultar_agendamentos_do_cliente'
]);

/**
 * Que etapa um fato da Atena representa? `null` = nao move nada.
 *
 * @param {string} ferramenta
 * @param {object} resultado o que a ferramenta devolveu
 */
export function etapaDoFato(ferramenta, resultado) {
  if (!resultado || resultado.erro) return null;

  if (CONSULTAS_DE_ENTENDIMENTO.has(ferramenta)) return 'entendendo';

  // Horarios de verdade oferecidos = o cliente ja tem uma proposta na mao.
  // Consulta que voltou vazia nao e orcamento: nao havia o que oferecer.
  if (ferramenta === 'consultar_horarios' && (resultado.horariosLivres?.length > 0 || resultado.porProfissional?.length > 0)) {
    return 'orcamento';
  }
  if (ferramenta === 'consultar_varios_servicos' && resultado.opcoes?.length > 0) return 'orcamento';

  return null;
}

/**
 * Avanca a conversa para `alvo`, se isso for um avanco e a Atena puder.
 *
 * @returns {Promise<boolean>} true se o cartao andou
 */
export async function avancarEtapa(tenantId, conversationId, alvo, { origem = 'regra' } = {}) {
  if (!conversationId || posicao(alvo) < 0) return false;

  if (!(await atenaPermite(tenantId, 'funil'))) return false;

  const conversa = await conversas.obter(tenantId, conversationId).catch(() => null);
  if (!conversa || conversa.status === 'finalizada') return false;

  // So para frente.
  if (posicao(alvo) <= posicao(conversa.etapaAtendimento)) return false;

  await conversas.moverEtapa(
    tenantId,
    conversationId,
    alvo,
    { usuario: { nome: 'Atena (IA)' }, origem }
  );

  log.debug({ tenantId, conversationId, de: conversa.etapaAtendimento, para: alvo, origem }, 'Cartao avancou');
  ver(
    'atena',
    `moveu o cartao no quadro: ${conversa.etapaAtendimento} → ${negrito(alvo)}`,
    origem
  );
  return true;
}

/** Reage a uma ferramenta da Atena que acabou de executar. */
export async function aoExecutarFerramenta({ tenantId, conversationId, nome, resultado }) {
  const alvo = etapaDoFato(nome, resultado);
  if (alvo) await avancarEtapa(tenantId, conversationId, alvo, { origem: `regra:${nome}` });
}
