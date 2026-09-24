import { comContexto } from '../core/logger.js';
import { ETAPAS_ATENDIMENTO, HUMORES } from '../db/schema/conversations.js';
import { gerar } from './cascade.js';

const log = comContexto({ modulo: 'humor' });

/**
 * Leitura de humor do cliente.
 *
 * Quem faz e a Sofia — e a frente do atendimento, ela e quem "escuta" o
 * cliente. Mas a leitura NAO sai na mesma chamada em que ela responde: pedir
 * ao mesmo modelo que converse e classifique ao mesmo tempo estraga as duas
 * coisas. A resposta ao cliente ganha um pedaco de JSON no meio, e a
 * classificacao sai enviesada pelo tom que ela acabou de escolher.
 *
 * Entao e uma chamada propria, curta e barata: temperatura zero, poucos
 * tokens, so o fim da conversa. Ela roda DEPOIS que o cliente ja recebeu a
 * resposta, e falhar nela nunca pode atrapalhar o atendimento — por isso quem
 * chama trata como enfeite, nunca como pre-requisito.
 *
 * A MESMA chamada tambem diz em que etapa do funil a conversa esta. Ler o humor
 * ja exige entender a conversa inteira; pedir a etapa junto custa dez tokens de
 * saida, enquanto uma chamada so para isso custaria centenas de entrada. E o
 * que pega o que as regras do funil nao veem — o cliente que recebeu horarios e
 * ficou de pensar, por exemplo.
 *
 * Os quatro estados sao os mesmos que o CRM ja guardava no lead:
 *
 *   satisfeito — contente, agradecendo, elogiando
 *   neutro     — objetivo, so resolvendo o que precisa
 *   duvida     — confuso, inseguro, perguntando de novo a mesma coisa
 *   frustrado  — irritado, reclamando, ameacando desistir
 */

const INSTRUCOES = [
  'Voce analisa conversas de atendimento e devolve SOMENTE um JSON, sem texto em volta,',
  'sem markdown e sem blocos de codigo.',
  '',
  'Formato exato:',
  '{"humor":"satisfeito|neutro|duvida|frustrado","etapa":"novo|entendendo|orcamento|aguardando","resumo":"..."}',
  '',
  'humor = como o CLIENTE esta se sentindo agora, no fim da conversa:',
  '- satisfeito: contente, agradecendo, elogiando, animado com o agendamento',
  '- neutro: objetivo, sem emocao aparente, so resolvendo o que precisa',
  '- duvida: confuso, inseguro, repetindo a pergunta, pedindo explicacao',
  '- frustrado: irritado, reclamando, cobrando, falando em desistir ou cancelar',
  '',
  'etapa = ate onde a negociacao chegou:',
  '- novo: so cumprimentos, ainda nao disse o que quer',
  '- entendendo: descobrindo servico, profissional ou preferencia',
  '- orcamento: precos ou horarios concretos ja foram informados',
  '- aguardando: ha uma proposta especifica e o cliente vai decidir ou confirmar',
  '',
  'resumo = UMA frase (no maximo 140 caracteres) dizendo em que pe esta o atendimento',
  'agora e o que falta. Escreva para o atendente humano que vai assumir, em portugues',
  'do Brasil. Nao invente nada que nao esteja na conversa.'
].join('\n');

/** Corta o JSON de dentro de qualquer enfeite que o modelo tenha posto em volta. */
function extrairJson(texto) {
  const limpo = String(texto ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  const inicio = limpo.indexOf('{');
  const fim = limpo.lastIndexOf('}');
  if (inicio === -1 || fim <= inicio) return null;

  try {
    return JSON.parse(limpo.slice(inicio, fim + 1));
  } catch {
    return null;
  }
}

/**
 * Le o humor do cliente a partir das ultimas mensagens.
 *
 * @param {object} p
 * @param {string} p.tenantId
 * @param {{papel: string, conteudo: string}[]} p.historico  dialogo recente, em ordem
 * @param {string} [p.leadNome]
 * @param {string} [p.conversationId]
 * @param {object[]} [p.provedores]   injetado nos testes
 * @returns {Promise<{humor: string, etapa: string|null, resumo: string}|null>} null quando nao deu para ler
 */
export async function lerHumor({ tenantId, historico, leadNome, conversationId = null, provedores = null }) {
  const dialogo = (historico ?? [])
    .filter((m) => m.conteudo?.trim())
    .slice(-10)
    .map((m) => `${m.papel === 'user' ? 'CLIENTE' : 'ATENDIMENTO'}: ${m.conteudo.trim()}`)
    .join('\n');

  // Uma mensagem solta ("oi") nao diz humor nenhum. Classificar assim mesmo
  // so produziria "neutro" caro.
  if (dialogo.length < 40) return null;

  const r = await gerar({
    tenantId,
    origem: 'humor',
    conversationId,
    systemPrompt: INSTRUCOES,
    mensagens: [
      {
        papel: 'user',
        conteudo: `Conversa com ${leadNome || 'o cliente'}:\n\n${dialogo}\n\nDevolva o JSON.`
      }
    ],
    temperatura: 0,
    maxTokens: 170,
    timeoutMs: 12_000,
    provedores
  });

  const dados = extrairJson(r?.texto);
  if (!dados) {
    log.warn({ tenantId, conversationId, texto: r?.texto?.slice(0, 120) }, 'Leitura de humor sem JSON valido');
    return null;
  }

  const humor = String(dados.humor ?? '').toLowerCase().trim();
  if (!HUMORES.includes(humor)) {
    log.warn({ tenantId, conversationId, humor }, 'Humor fora da lista conhecida');
    return null;
  }

  const etapa = String(dados.etapa ?? '').toLowerCase().trim();

  return {
    humor,
    // Etapa desconhecida nao invalida a leitura de humor: so nao move o cartao.
    etapa: ETAPAS_ATENDIMENTO.includes(etapa) ? etapa : null,
    resumo: String(dados.resumo ?? '').trim().slice(0, 300)
  };
}
