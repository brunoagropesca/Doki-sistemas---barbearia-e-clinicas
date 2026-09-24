import { env } from '../../config/env.js';
import { exigirConteudo, requisitar } from './base.js';

/**
 * Google Gemini.
 *
 * A API do Gemini tem tres particularidades que este arquivo esconde do
 * resto do sistema:
 *  1. O papel do assistente se chama "model", nao "assistant".
 *  2. Mensagens consecutivas do mesmo papel precisam ser fundidas, senao a
 *     API recusa.
 *  3. O prompt de sistema vai num campo separado (`systemInstruction`).
 */

const BASE = env.GEMINI_BASE_URL.replace(/\/+$/, '');

/** Converte nosso formato de mensagens para o do Gemini, fundindo repetidos. */
function paraContents(mensagens) {
  const contents = [];

  for (const m of mensagens) {
    // Resultado de ferramenta volta como uma fala do usuario, rotulada.
    if (m.papel === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ text: `[Resultado da ferramenta ${m.ferramentaNome}]\n${m.conteudo}` }]
      });
      continue;
    }

    const role = m.papel === 'assistant' ? 'model' : 'user';
    const ultimo = contents.at(-1);

    if (ultimo?.role === role) {
      ultimo.parts[0].text += `\n${m.conteudo}`;
    } else {
      contents.push({ role, parts: [{ text: m.conteudo }] });
    }
  }

  return contents;
}

/** Nosso formato de ferramenta -> declaracao de funcao do Gemini. */
function paraFunctionDeclarations(ferramentas) {
  if (!ferramentas?.length) return undefined;

  return [
    {
      functionDeclarations: ferramentas.map((f) => ({
        name: f.nome,
        description: f.descricao,
        parameters: f.parametros
      }))
    }
  ];
}

export const gemini = {
  nome: 'gemini',

  /** Modelos tentados em ordem quando a empresa nao escolheu um. */
  modelosPadrao: [
    'models/gemini-2.5-flash',
    'models/gemini-2.0-flash',
    'models/gemini-1.5-flash'
  ],

  async gerar({ apiKey, modelo, systemPrompt, mensagens, ferramentas, temperatura = 0.7, maxTokens = 800, timeoutMs = 20_000 }) {
    const nomeModelo = modelo.startsWith('models/') ? modelo : `models/${modelo}`;
    const url = `${BASE}/${nomeModelo}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const dados = await requisitar(url, {
      provedor: 'gemini',
      modelo,
      timeoutMs,
      corpo: {
        systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents: paraContents(mensagens),
        tools: paraFunctionDeclarations(ferramentas),
        generationConfig: { temperature: temperatura, maxOutputTokens: maxTokens }
      }
    });

    const candidato = dados.candidates?.[0];
    const partes = candidato?.content?.parts ?? [];

    const texto = partes
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim();

    const chamadasDeFerramenta = partes
      .filter((p) => p.functionCall)
      .map((p) => ({ nome: p.functionCall.name, argumentos: p.functionCall.args ?? {} }));

    return exigirConteudo(
      {
        texto,
        chamadasDeFerramenta,
        // MAX_TOKENS = o texto foi cortado no teto de saida. Nos modelos que
        // "pensam" antes de responder, o pensamento consome esse teto.
        motivoParada: candidato?.finishReason === 'MAX_TOKENS' ? 'limite' : 'normal',
        tokens: {
          entrada: dados.usageMetadata?.promptTokenCount ?? 0,
          saida: dados.usageMetadata?.candidatesTokenCount ?? 0
        },
        modelo
      },
      { provedor: 'gemini', modelo }
    );
  },

  /**
   * Lista os modelos que a chave consegue usar, com nome de exibicao e limites.
   *
   * A API pagina o resultado (padrao: 50 por pagina). Seguimos as paginas ate
   * o fim — sem isso o catalogo pararia em 50 e os modelos mais novos, que
   * costumam vir por ultimo, nunca apareceriam.
   *
   * Devolve `null` quando a consulta FALHA (chave invalida, sem rede), e nao
   * uma lista vazia. A diferenca importa: lista vazia significaria "esta chave
   * nao enxerga modelo nenhum" e apagaria o catalogo salvo; `null` significa
   * "nao consegui perguntar", e quem chamou mantem o que ja tinha.
   */
  async listarModelos({ apiKey, timeoutMs = 15_000 }) {
    const encontrados = [];
    let pagina = '';

    try {
      for (let i = 0; i < 10; i++) {
        const controle = new AbortController();
        const prazo = setTimeout(() => controle.abort(), timeoutMs);

        let res;
        try {
          const url = `${BASE}/models?pageSize=100&key=${encodeURIComponent(apiKey)}${pagina ? `&pageToken=${encodeURIComponent(pagina)}` : ''}`;
          res = await fetch(url, { signal: controle.signal });
        } finally {
          clearTimeout(prazo);
        }

        if (!res.ok) return null;

        const dados = await res.json();
        for (const m of dados.models ?? []) {
          if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
          encontrados.push({
            nome: m.name,
            nomeExibicao: m.displayName ?? null,
            limiteEntrada: m.inputTokenLimit ?? null,
            limiteSaida: m.outputTokenLimit ?? null
          });
        }

        if (!dados.nextPageToken) break;
        pagina = dados.nextPageToken;
      }
    } catch {
      return null;
    }

    return encontrados;
  }
};
