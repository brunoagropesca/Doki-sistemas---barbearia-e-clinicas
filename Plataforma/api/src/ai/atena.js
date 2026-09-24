import { dataNoFuso } from '../core/datetime.js';
import { rotuloDaData } from '../core/datas-naturais.js';
import { comContexto } from '../core/logger.js';
import { conversar } from './agente.js';
import { ferramentasDaAtena } from './tools/atena.tools.js';
import { obterAgente } from '../modules/ia/ia.service.js';

const log = comContexto({ modulo: 'atena' });

/**
 * A Atena como agente de IA.
 *
 * A Sofia nao consulta o banco: ela DELEGA. Quando o cliente pergunta um
 * preco ou pede um horario, a Sofia manda um pedido em linguagem natural
 * ("o cliente quer Corte Degrade com o Carlos amanha de tarde") e a Atena —
 * outra chamada de modelo, com prompt, temperatura e ferramentas proprias —
 * raciocina sobre o pedido, consulta e altera o banco, e devolve um relato
 * factual do que encontrou ou fez.
 *
 * Isso e o que o sistema antigo prometia e nao entregava: la a "Atena" era
 * uma cadeia de `if` sobre palavras-chave, apesar de o banco ter um campo
 * `model` para ela que nenhum codigo lia.
 *
 * Cada pedido e uma conversa nova para a Atena. Ela nao tem o historico do
 * WhatsApp — so o que a Sofia escreveu no pedido. E proposital: mantem a
 * Atena barata, previsivel, e obriga a Sofia a ser explicita sobre o que quer.
 */

function montarSystemPrompt({ agente, nomeEmpresa, fuso, leadNome, permitirEscrita }) {
  /**
   * A ORDEM importa para o custo.
   *
   * Provedores como o Gemini reaproveitam (e cobram menos por) o inicio do
   * prompt quando ele e IDENTICO entre chamadas. Por isso o que muda a cada
   * pedido — data, nome do cliente — vai por ultimo: o bloco fixo de
   * instrucoes fica na frente, igual em todas as chamadas.
   */
  const hoje = dataNoFuso(Date.now(), fuso);

  return [
    agente.systemPrompt.trim(),
    '',
    'REGRAS:',
    '1. So enxergue e altere dados DO CLIENTE DESTA CONVERSA.',
    '2. NUNCA invente preço, horário ou disponibilidade: tudo vem de ferramenta.',
    '3. As ferramentas aceitam NOMES ("Corte Social", "Carlos") e DATAS como o cliente falou',
    '   ("sexta", "dia 25", "amanhã"): não converta nem liste antes. Sem profissional = todos.',
    '4. 2 ou mais serviços na mesma visita: consultar_varios_servicos e agendar_varios_servicos',
    '   (marca todos ou nenhum). Nunca marque um por um.',
    '5. Pedido com serviço, profissional, data e hora: marque DIRETO, sem consultar antes (a',
    '   marcação já recusa horário ocupado). Recusou? Aí consulte e relate as OPÇÕES.',
    '   Faltou dado? Diga qual.',
    '6. Prefira cancelar a excluir. Nunca altere preço ou desconto.',
    '7. Erro de ferramenta: NÃO repita a mesma chamada. Relate o erro e a alternativa mais próxima.',
    '',
    'RESPOSTA para a Sofia (não para o cliente): curta, sem emojis, só as linhas que couberem:',
    'FEITO: o que foi marcado/alterado (dia por extenso, hora, profissional, valor).',
    'NÃO FEITO: o que não deu e por quê.',
    'OPÇÕES: horários ou datas para oferecer.',
    'FALTA: o dado que o cliente precisa informar.',
    'Repasse todo "aviso" que a ferramenta trouxer.',
    '',
    `Empresa: ${nomeEmpresa}. Cliente: ${leadNome ?? 'ainda não identificado'}.`,
    // So o dia de hoje: o resto do calendario e conta das ferramentas, nao do
    // modelo (e nao custa token em toda chamada).
    `Hoje é ${rotuloDaData(hoje, hoje).replace(/^hoje, /, '')}/${hoje.slice(0, 4)} (fuso ${fuso}).`,
    permitirEscrita ? '' : 'MODO SOMENTE LEITURA: consulte, mas não crie, altere nem exclua nada.'
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/**
 * Relato montado em codigo quando a Atena nao concluiu: o que cada ferramenta
 * devolveu (sem repetir as iguais) e o que a Sofia deve fazer com isso.
 */
export function relatoSemConclusao(ferramentasUsadas) {
  const vistos = new Set();
  const linhas = [];
  for (const f of ferramentasUsadas) {
    const resultado = f.resultado ?? {};
    const texto = resultado.erro ? `erro: ${resultado.erro}` : JSON.stringify(resultado);
    const chave = `${f.nome}|${texto}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    linhas.push(`- ${f.nome}: ${texto.length > 400 ? `${texto.slice(0, 400)}…` : texto}`);
  }

  const feitos = ferramentasUsadas.filter((f) => f.resultado?.sucesso);
  return [
    feitos.length ? 'NÃO CONCLUÍ o pedido inteiro, mas algo FOI FEITO (ver "sucesso" abaixo).' : 'NÃO FEITO: não consegui concluir o pedido.',
    ...(linhas.length ? ['O que as consultas devolveram:', ...linhas] : ['Nenhuma consulta deu resultado.']),
    'Não prometa retorno ao cliente: explique o que for possível, pergunte o dado que falta ou ofereça um atendente.'
  ].join('\n');
}

/**
 * Faz um pedido a Atena.
 *
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} p.pedido               o que a Sofia quer saber ou fazer
 * @param {string|null} p.leadId          cliente da conversa (escopo das escritas)
 * @param {string} [p.leadNome]
 * @param {string} p.fuso
 * @param {string} [p.nomeEmpresa]
 * @param {string} [p.conversationId]
 * @param {boolean} [p.permitirEscrita]   false no simulador em modo seguro
 * @param {object[]} [p.provedores]       injetado nos testes
 * @returns {Promise<{ resposta: string, trace: object }>}
 */
export async function consultarAtena({
  tenantId,
  pedido,
  leadId,
  leadNome,
  fuso,
  nomeEmpresa = 'nossa empresa',
  conversationId = null,
  permitirEscrita = true,
  provedores = null
}) {
  const agente = await obterAgente(tenantId, 'atena');

  const ferramentas = ferramentasDaAtena({
    tenantId,
    fuso,
    leadId,
    conversationId,
    permitirEscrita,
    grupos: agente.ferramentas
  });

  const trace = { pedido, ferramentas: [], provedor: null, modelo: null, latenciaMs: null, voltas: 0 };

  // Nenhuma permissao ligada: nao ha o que raciocinar. Responder sem chamar
  // o modelo poupa uma chamada e evita a IA "improvisar" sem ferramenta.
  if (ferramentas.length === 0) {
    trace.semPermissoes = true;
    return {
      resposta:
        'Estou sem nenhuma permissão habilitada nas configurações e não consigo consultar nem alterar nada. ' +
        'Não informe preços ou horários ao cliente; ofereça chamar um atendente.',
      trace
    };
  }

  const contexto = { escritas: 0 };

  /**
   * Por que a Atena SEMPRE relata com o modelo, mesmo numa consulta simples.
   *
   * Ja tentamos devolver o resultado cru da ferramenta e pular essa segunda
   * chamada (economizava ~1.200 tokens). Deu errado: a volta extra e onde o
   * modelo JULGA se os dados respondem ao PEDIDO. A Sofia pediu "agende as
   * 9h" e a Atena so tinha consulta (modo leitura, ou permissao desligada) — sem
   * o relato "nao consigo agendar, aqui estao os horarios", a Sofia recebia
   * dados que nao eram a resposta e repetia o pedido ate o limite de voltas,
   * gastando mais do que se economizou.
   */
  const r = await conversar({
    tenantId,
    conversationId,
    origem: 'atena',
    agentKey: 'atena',
    systemPrompt: montarSystemPrompt({ agente, nomeEmpresa, fuso, leadNome, permitirEscrita }),
    mensagens: [{ papel: 'user', conteudo: pedido }],
    ferramentas,
    contexto,
    temperatura: agente.temperatura,
    maxTokens: agente.maxTokens,
    // Consultar, agir e relatar sao tres chamadas; a quarta e folga. Cada volta
    // reenvia todo o contexto, entao o teto tambem e um teto de custo.
    maxVoltas: 4,
    provedores
  });

  /**
   * A Atena nao chegou a um relato (limite de voltas, ou repetiu a mesma
   * consulta). O laco devolve uma frase de reserva escrita para CLIENTE —
   * "ja te respondo" — e foi ela que, no teste real, virou "a Atena pediu um
   * instante" na boca da Sofia, uma promessa que ninguem cumpriu.
   *
   * No lugar, a Sofia recebe os FATOS: o que as ferramentas devolveram e a
   * ordem de nao prometer retorno. Sem chamada extra de modelo.
   */
  if (r.semResposta) {
    r.texto = relatoSemConclusao(r.ferramentasUsadas);
    trace.semConclusao = true;
    log.warn({ tenantId, conversationId, ferramentas: r.ferramentasUsadas.map((f) => f.nome), repetiu: r.repetiu }, 'Atena nao concluiu o pedido');
  }

  trace.ferramentas = r.ferramentasUsadas.map((f) => ({
    nome: f.nome,
    argumentos: f.argumentos,
    resultado: f.resultado
  }));
  trace.provedor = r.provedor;
  trace.modelo = r.modelo;
  trace.latenciaMs = r.latenciaMs;
  trace.voltas = r.voltas;
  trace.escritas = contexto.escritas;
  // O que ela devolveu a Sofia. Sem isto, os bastidores mostram as consultas
  // da Atena mas nao a conclusao dela — e quem esta depurando um atendimento
  // fica sem saber se ela respondeu, o que respondeu, ou se ficou muda.
  trace.resposta = r.texto;

  log.info(
    { tenantId, ferramentas: trace.ferramentas.map((f) => f.nome), escritas: contexto.escritas },
    'Atena respondeu ao pedido'
  );

  return { resposta: r.texto, trace };
}

