import { comContexto } from '../core/logger.js';
import { gerar } from './cascade.js';
import { executarFerramenta } from './tools/registry.js';
import { cinza, colorir, negrito, nomeDoAgente, resumir, ver } from '../core/painel.js';

const log = comContexto({ modulo: 'ia-agente' });

/**
 * O laco de conversa com ferramentas.
 *
 * Funciona assim:
 *   1. Manda a conversa para o modelo, junto com a lista de ferramentas.
 *   2. Se o modelo responder texto, acabou.
 *   3. Se ele pedir uma ferramenta, executamos, devolvemos o resultado
 *      e voltamos ao passo 1.
 *
 * O limite de voltas existe porque modelo entra em loop: ele consulta
 * horarios, nao gosta do resultado, consulta de novo, indefinidamente. Sem
 * teto, uma conversa consome a cota da empresa inteira em minutos.
 */

const MAX_VOLTAS = 5;

/**
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} p.systemPrompt
 * @param {import('./providers/base.js').Mensagem[]} p.mensagens
 * @param {object[]} p.ferramentas
 * @param {object} [p.contexto]   objeto mutavel que as ferramentas podem marcar
 */
export async function conversar({
  tenantId,
  systemPrompt,
  mensagens,
  ferramentas = [],
  contexto = {},
  temperatura = 0.7,
  maxTokens = 800,
  origem = 'atendimento',
  agentKey = null,
  conversationId = null,
  maxVoltas = MAX_VOLTAS,
  provedores = null,
  /**
   * Recusa texto cortado no meio (ver `gerar`).
   *
   * Vale para quem escreve o que o CLIENTE le — a Sofia. A Atena fica de
   * fora de proposito: ela relata para a Sofia, o proprio prompt pede
   * resposta curta e factual, e "ok" ou "Cancelado" sao respostas inteiras
   * dela. Cobrar ponto final ali custaria uma chamada extra a cada relato.
   */
  exigirRespostaCompleta = false
}) {
  const historico = [...mensagens];
  const ferramentasUsadas = [];
  let ultimaResposta = null;
  /**
   * Chamadas (nome + argumentos) ja feitas em voltas anteriores.
   *
   * Nos testes reais a Atena repetiu a MESMA consulta quatro vezes seguidas
   * ate o limite: o resultado nao muda, so a conta sobe. Uma volta feita so de
   * repeticoes encerra o laco na hora. Escrever algo zera a lista — depois de
   * marcar, consultar de novo e legitimo (o resultado mudou).
   */
  const jaFeitas = new Set();
  const chaveDa = (c) => `${c.nome}:${JSON.stringify(c.argumentos ?? {})}`;
  let repetiu = false;

  let voltasFeitas = 0;
  for (let volta = 0; volta < maxVoltas; volta++) {
    voltasFeitas = volta + 1;
    const resposta = await gerar({
      tenantId,
      origem,
      agentKey,
      conversationId,
      systemPrompt,
      mensagens: historico,
      ferramentas,
      temperatura,
      maxTokens,
      provedores,
      exigirRespostaCompleta
    });

    ultimaResposta = resposta;

    if (!resposta.chamadasDeFerramenta?.length) {
      /**
       * O modelo respondeu com o MARCADOR que nos mesmos pusemos no historico.
       *
       * Quando uma chamada de ferramenta vem sem texto, gravamos no historico
       * "[Consultando: nome]" so para a conversa nao ter dois turnos seguidos do
       * mesmo lado. Modelos imitam o que veem: as vezes o relato final da Atena
       * saia exatamente "[Consultando: mover_etapa_atendimento]" — e a Sofia,
       * sem saber que o horario JA TINHA sido marcado, pedia de novo.
       *
       * Um marcador nao e resposta: pedimos o relato de verdade. Se nao der mais
       * volta, montamos o relato com o que as ferramentas devolveram — que e o
       * fato, e melhor do que devolver o marcador.
       */
      if (/^\s*\[Consultando:/i.test(resposta.texto ?? '') && ferramentasUsadas.length > 0) {
        if (volta < maxVoltas - 1) {
          historico.push({ papel: 'assistant', conteudo: resposta.texto });
          historico.push({
            papel: 'user',
            conteudo: 'Escreva agora, em texto normal e sem colchetes, o relato final do que as ferramentas devolveram.'
          });
          continue;
        }
        resposta.texto = ferramentasUsadas
          .map((f) => `${f.nome}: ${JSON.stringify(f.resultado)}`)
          .join('\n');
      }

      return {
        texto: resposta.texto,
        ferramentasUsadas,
        provedor: resposta.provedor,
        modelo: resposta.modelo,
        latenciaMs: resposta.latenciaMs,
        voltas: volta + 1,
        contexto
      };
    }

    const chaves = resposta.chamadasDeFerramenta.map(chaveDa);
    if (chaves.every((k) => jaFeitas.has(k))) {
      repetiu = true;
      log.warn({ tenantId, origem, ferramentas: chaves }, 'Modelo repetiu as mesmas chamadas; encerrando o laco');
      ver('aviso', `${nomeDoAgente(agentKey, origem).nome} repetiu a mesma consulta: parando para nao gastar a toa`);
      break;
    }

    // O modelo pediu ferramentas. Executamos todas as da rodada em paralelo —
    // consultar precos e consultar horarios sao independentes, nao ha motivo
    // para uma esperar a outra.
    const resultados = await Promise.all(
      resposta.chamadasDeFerramenta.map(async (chamada) => {
        const resultado = await executarFerramenta(ferramentas, chamada, contexto);
        ferramentasUsadas.push({ nome: chamada.nome, argumentos: chamada.argumentos, resultado });
        return { chamada, resultado };
      })
    );

    // Painel: cada ferramenta que rodou, com o que devolveu. A consultar_atena
    // fica de fora — a conversa Sofia -> Atena tem linha propria, mais rica.
    for (const { chamada, resultado } of resultados) {
      if (chamada.nome === 'consultar_atena') continue;
      const { ator, nome } = nomeDoAgente(agentKey, origem);
      const falhou = resultado?.erro;
      ver(
        'tool',
        `${colorir(ator, nome)} ${negrito(chamada.nome)}${cinza(`(${resumir(JSON.stringify(chamada.argumentos ?? {}), 90)})`)}`,
        falhou ? `erro: ${resumir(resultado.erro, 90)}` : `→ ${resumir(JSON.stringify(resultado), 100)}`
      );
    }

    const escreveu = resposta.chamadasDeFerramenta.some((c) => ferramentas.find((f) => f.nome === c.nome)?.escrita);
    if (escreveu) jaFeitas.clear();
    for (const k of chaves) jaFeitas.add(k);

    // A fala do assistente (mesmo vazia) precisa entrar no historico antes
    // dos resultados, senao a conversa fica com dois "usuarios" seguidos e
    // alguns provedores recusam.
    historico.push({
      papel: 'assistant',
      conteudo: resposta.texto || `[Consultando: ${resposta.chamadasDeFerramenta.map((c) => c.nome).join(', ')}]`
    });

    for (const { chamada, resultado } of resultados) {
      historico.push({
        papel: 'tool',
        ferramentaNome: chamada.nome,
        conteudo: JSON.stringify(resultado)
      });
    }

    // Uma ferramenta pediu transferencia para humano: nao faz sentido
    // continuar conversando com o modelo.
    if (contexto.transferirParaHumano?.solicitado) {
      return {
        texto: resposta.texto || '',
        ferramentasUsadas,
        provedor: resposta.provedor,
        modelo: resposta.modelo,
        latenciaMs: resposta.latenciaMs,
        voltas: volta + 1,
        contexto
      };
    }
  }

  if (!repetiu) log.warn({ tenantId, voltas: maxVoltas }, 'Laco de ferramentas atingiu o limite');

  return {
    texto:
      ultimaResposta?.texto ||
      'Vou verificar isso com mais calma e já te respondo. Só um instante!',
    ferramentasUsadas,
    provedor: ultimaResposta?.provedor,
    modelo: ultimaResposta?.modelo,
    voltas: voltasFeitas,
    limiteAtingido: true,
    /**
     * O modelo NAO chegou a uma resposta: o texto acima e o de reserva.
     *
     * Quem chama precisa saber, porque o texto de reserva e uma promessa
     * ("ja te respondo") que ninguem vai cumprir. A Atena troca por um relato
     * do que as ferramentas devolveram; a Sofia passa o cliente a uma pessoa.
     */
    semResposta: !ultimaResposta?.texto,
    repetiu,
    contexto
  };
}

/**
 * Divide a resposta em ate 3 baloes de WhatsApp.
 *
 * Mensagem longa em bloco unico cansa quem le no celular. O modelo e instruido
 * a marcar as quebras com [BALAO]; quando ele nao marca, dividimos por
 * paragrafo. O teto de 3 e rigido: mais que isso parece spam e o WhatsApp
 * penaliza numero que dispara muitas mensagens seguidas.
 */
export function dividirEmBaloes(texto, maximo = 3) {
  const limpo = String(texto ?? '')
    // Marcador que o modelo escreveu pela metade ("amanh[AO]mas", visto num
    // teste real): colchete com 2 a 8 MAIUSCULAS e so vale como quebra. Sem
    // flag `i` de proposito: "[manhã]" no meio do texto continua texto.
    .replace(/\[[A-ZÀ-Ý]{2,8}\]/g, '[BALAO]')
    .trim();
  if (!limpo) return [];

  const marcador = /\s*\[(?:bal[aã]o|pausa|quebra)\]\s*/gi;

  if (marcador.test(limpo)) {
    const partes = limpo.split(marcador).map((p) => p.trim()).filter(Boolean);
    return condensar(partes, maximo);
  }

  // Mensagem curta continua inteira: quebrar "Oi! Tudo bem?" em dois baloes
  // e pior do que deixar em um.
  if (limpo.length < 180 && !limpo.includes('\n\n')) return [limpo];

  const paragrafos = limpo.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  if (paragrafos.length >= 2) return condensar(paragrafos, maximo);

  return [limpo];
}

/** Junta o excedente no ultimo balao, preservando o inicio e o fim. */
function condensar(partes, maximo) {
  if (partes.length <= maximo) return partes;
  return [...partes.slice(0, maximo - 1), partes.slice(maximo - 1).join('\n\n')];
}
