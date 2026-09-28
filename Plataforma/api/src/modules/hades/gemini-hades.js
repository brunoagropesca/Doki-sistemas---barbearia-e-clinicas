import { env } from '../../config/env.js';
import { exigirConteudo, requisitar } from '../../ai/providers/base.js';
import { gemini } from '../../ai/providers/gemini.js';

/**
 * A conexao do Hades com o Google Gemini.
 *
 * Mesma estrutura do provedor do sistema (ai/providers/gemini.js: papeis
 * "model"/"user", mensagens repetidas fundidas, prompt de sistema a parte),
 * mas PROPRIA: chave do Hades, sem cascata, e com a pesquisa do Google
 * ligada (`google_search`) para trazer tendencias do ramo com as fontes.
 */

const BASE = env.GEMINI_BASE_URL.replace(/\/+$/, '');

function paraContents(mensagens) {
  const contents = [];
  for (const m of mensagens) {
    const role = m.papel === 'assistant' ? 'model' : 'user';
    const ultimo = contents.at(-1);
    if (ultimo?.role === role) ultimo.parts[0].text += `\n${m.conteudo}`;
    else contents.push({ role, parts: [{ text: m.conteudo }] });
  }
  return contents;
}

/**
 * Uma resposta do Hades.
 * @returns {Promise<{ texto: string, fontes: {titulo: string, url: string}[], buscas: string[], modelo: string, tokens: object }>}
 */
export async function gerarHades({ apiKey, modelo, systemPrompt, mensagens, temperatura = 0.7, pesquisaWeb = true, timeoutMs = 60_000 }) {
  const nomeModelo = modelo.startsWith('models/') ? modelo : `models/${modelo}`;
  const url = `${BASE}/${nomeModelo}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const dados = await requisitar(url, {
    provedor: 'gemini',
    modelo,
    timeoutMs,
    corpo: {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: paraContents(mensagens),
      // A pesquisa do Google: o proprio Gemini decide quando buscar.
      tools: pesquisaWeb ? [{ google_search: {} }] : undefined,
      generationConfig: { temperature: temperatura, maxOutputTokens: 4096 }
    }
  });

  const candidato = dados.candidates?.[0];
  const texto = (candidato?.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();

  // De onde veio o que ele pesquisou (para mostrar as fontes na conversa).
  const meta = candidato?.groundingMetadata ?? {};
  const vistas = new Set();
  const fontes = (meta.groundingChunks ?? [])
    .map((c) => c.web)
    .filter((w) => w?.uri && !vistas.has(w.uri) && vistas.add(w.uri))
    .slice(0, 8)
    .map((w) => ({ titulo: w.title || w.uri, url: w.uri }));

  const r = exigirConteudo(
    {
      texto,
      chamadasDeFerramenta: [],
      motivoParada: candidato?.finishReason === 'MAX_TOKENS' ? 'limite' : 'normal',
      tokens: { entrada: dados.usageMetadata?.promptTokenCount ?? 0, saida: dados.usageMetadata?.candidatesTokenCount ?? 0 },
      modelo
    },
    { provedor: 'gemini', modelo }
  );
  return { texto: r.texto, fontes, buscas: meta.webSearchQueries ?? [], modelo, tokens: r.tokens };
}

/** Modelos que a chave do Hades enxerga (ou null se nao deu para perguntar). */
export function listarModelosHades(apiKey) {
  return gemini.listarModelos({ apiKey });
}

/**
 * Sem modelo escolhido: o melhor "flash" (rapido e bom de conversa) mais novo
 * que a chave tiver — nada de lite, embedding, imagem, audio ou tempo real.
 */
export function modeloPadrao(lista) {
  const versao = (nome) => Number((nome.match(/gemini-(\d+(?:\.\d+)?)/) ?? [])[1] ?? 0);
  const candidatos = (lista ?? [])
    .map((m) => m.nome)
    .filter((n) => /gemini-\d/.test(n) && !/lite|embedding|image|tts|audio|live|vision|aqa|exp/i.test(n));
  const flash = candidatos.filter((n) => /flash/.test(n));
  const escolhidos = (flash.length ? flash : candidatos).sort((a, b) => versao(b) - versao(a) || a.length - b.length);
  return escolhidos[0] ?? null;
}
