import { comContexto } from '../core/logger.js';
import { gerar } from './cascade.js';

const log = comContexto({ modulo: 'resumo' });

/**
 * Resumo final de um atendimento.
 *
 * Escrito quando a sessao e finalizada, para a proxima pessoa que atender este
 * cliente saber em 5 segundos o que aconteceu — sem reler 40 mensagens. Vai
 * para a OS e para o historico do cliente.
 *
 * Pensado para custar pouco: uma unica chamada, sem ferramentas, com so o
 * dialogo (ultimas 30 mensagens) e um teto curto de saida. A Atena so o faz
 * quando ninguem escreveu resumo na mao — atendente que escreveu o dele nao
 * gasta um centavo.
 */

const INSTRUCOES = [
  'Voce escreve o resumo final de um atendimento para a equipe da empresa.',
  'Escreva em portugues do Brasil, em NO MAXIMO 3 frases curtas, sem emojis e sem markdown.',
  'Diga: o que o cliente queria, o que ficou combinado (servico, data, hora, valor, se houver)',
  'e o que ficou pendente ou o motivo de nao ter avancado. Se nada foi combinado, diga isso.',
  'Nao invente nada que nao esteja na conversa. Devolva SOMENTE o texto do resumo.'
].join('\n');

/**
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} p.conversationId
 * @param {string} [p.leadNome]
 * @param {{direcao: string, autorTipo: string, conteudo: string}[]} p.mensagens em ordem cronologica
 * @param {object[]} [p.provedores] injetado nos testes
 * @returns {Promise<string|null>} null quando nao deu para resumir
 */
export async function gerarResumoFinal({ tenantId, conversationId, leadNome, mensagens, provedores = null }) {
  const dialogo = (mensagens ?? [])
    .filter((m) => m.autorTipo !== 'sistema' && m.conteudo?.trim())
    .slice(-30)
    .map((m) => `${m.direcao === 'entrada' ? 'CLIENTE' : 'ATENDIMENTO'}: ${m.conteudo.trim().slice(0, 400)}`)
    .join('\n');

  // Sem conversa de verdade nao ha o que resumir. Resumir "oi" so gasta.
  if (dialogo.length < 60) return null;

  try {
    const r = await gerar({
      tenantId,
      origem: 'resumo',
      conversationId,
      systemPrompt: INSTRUCOES,
      mensagens: [
        { papel: 'user', conteudo: `Conversa com ${leadNome || 'o cliente'}:\n\n${dialogo}\n\nEscreva o resumo.` }
      ],
      temperatura: 0.2,
      maxTokens: 220,
      timeoutMs: 10_000,
      provedores
    });

    const texto = String(r?.texto ?? '').trim().replace(/^["']|["']$/g, '');
    return texto ? texto.slice(0, 600) : null;
  } catch (err) {
    // Finalizar um atendimento nunca pode falhar porque o resumo falhou.
    log.warn({ err, tenantId, conversationId }, 'Nao foi possivel escrever o resumo final');
    return null;
  }
}
