import { exigirConteudo, requisitar } from './base.js';

/**
 * Provedores que falam o dialeto da OpenAI.
 *
 * Groq, OpenAI e Ollama expoem a MESMA rota (`/chat/completions`) com o mesmo
 * formato. Um arquivo atende os tres — muda so a URL base e a chave.
 *
 * O sistema antigo tambem reaproveitava essa chamada, mas o proposito estava
 * escondido dentro de uma funcao generica chamada `callOpenAICompatible` no
 * meio da cascata. Aqui isso e um provedor de primeira classe, com a mesma
 * interface dos demais.
 */

function paraMessages(systemPrompt, mensagens) {
  const lista = [];
  if (systemPrompt) lista.push({ role: 'system', content: systemPrompt });

  for (const m of mensagens) {
    if (m.papel === 'tool') {
      lista.push({
        role: 'user',
        content: `[Resultado da ferramenta ${m.ferramentaNome}]\n${m.conteudo}`
      });
      continue;
    }
    lista.push({ role: m.papel === 'assistant' ? 'assistant' : 'user', content: m.conteudo });
  }

  return lista;
}

function paraTools(ferramentas) {
  if (!ferramentas?.length) return undefined;
  return ferramentas.map((f) => ({
    type: 'function',
    function: { name: f.nome, description: f.descricao, parameters: f.parametros }
  }));
}

/** Modelos que a API lista mas que nao conversam: voz, moderacao, embeddings, imagem. */
const NAO_E_CONVERSA = /whisper|orpheus|tts|guard|safeguard|embed|moderation|dall-e|image|audio|realtime|transcribe|allam/i;

/** Monta um provedor a partir da URL base — e assim que nascem groq/openai/ollama. */
function criarProvedorCompativel({ nome, baseUrlPadrao, modelosPadrao, precisaChave = true, sufixoDaRota = '' }) {
  return {
    nome,
    modelosPadrao,
    precisaChave,

    /**
     * Lista os modelos de CONVERSA que a chave enxerga (GET /models).
     * `null` = nao consegui perguntar (mantem o catalogo salvo).
     */
    async listarModelos({ apiKey, baseUrl, timeoutMs = 15_000 }) {
      let raiz = (baseUrl || baseUrlPadrao).replace(/\/+$/, '');
      if (sufixoDaRota && !raiz.endsWith(sufixoDaRota)) raiz += sufixoDaRota;

      const controle = new AbortController();
      const prazo = setTimeout(() => controle.abort(), timeoutMs);
      try {
        const res = await fetch(`${raiz}/models`, {
          headers: { Authorization: `Bearer ${apiKey || 'local'}` },
          signal: controle.signal
        });
        if (!res.ok) return null;
        const dados = await res.json();
        return (dados.data ?? [])
          .filter((m) => m.id && m.active !== false && !NAO_E_CONVERSA.test(m.id))
          .map((m) => ({
            nome: m.id,
            nomeExibicao: null,
            limiteEntrada: m.context_window ?? null,
            limiteSaida: m.max_completion_tokens ?? null
          }));
      } catch {
        return null;
      } finally {
        clearTimeout(prazo);
      }
    },

    async gerar({ apiKey, baseUrl, modelo, systemPrompt, mensagens, ferramentas, temperatura = 0.7, maxTokens = 800, timeoutMs = 20_000 }) {
      let raiz = (baseUrl || baseUrlPadrao).replace(/\/+$/, '');

      // O Ollama serve a API compativel em `/v1`, mas as pessoas informam so
      // o endereco da maquina (`http://localhost:11434`) — e e assim que a
      // documentacao dele mostra. Completamos aqui para nao mandar a chamada
      // para uma rota que nao existe.
      if (sufixoDaRota && !raiz.endsWith(sufixoDaRota)) raiz += sufixoDaRota;

      const dados = await requisitar(`${raiz}/chat/completions`, {
        provedor: nome,
        modelo,
        timeoutMs,
        cabecalhos: { Authorization: `Bearer ${apiKey || 'local'}` },
        corpo: {
          model: modelo,
          messages: paraMessages(systemPrompt, mensagens),
          tools: paraTools(ferramentas),
          temperature: temperatura,
          max_tokens: maxTokens
        }
      });

      const escolha = dados.choices?.[0]?.message;
      // 'length' = o texto foi cortado no teto de tokens. Quem chama decide se
      // isso e aceitavel; no atendimento, nao e — o cliente receberia meia frase.
      const motivoParada = dados.choices?.[0]?.finish_reason === 'length' ? 'limite' : 'normal';

      const chamadasDeFerramenta = (escolha?.tool_calls ?? []).map((t) => {
        let argumentos = {};
        try {
          // O modelo devolve os argumentos como TEXTO JSON, e as vezes esse
          // texto vem malformado. Um JSON quebrado nao pode derrubar o
          // atendimento: tratamos como ferramenta sem argumentos.
          argumentos = JSON.parse(t.function?.arguments || '{}');
        } catch {
          argumentos = {};
        }
        return { nome: t.function?.name, argumentos };
      });

      return exigirConteudo(
        {
          texto: (escolha?.content ?? '').trim(),
          chamadasDeFerramenta,
          motivoParada,
          tokens: {
            entrada: dados.usage?.prompt_tokens ?? 0,
            saida: dados.usage?.completion_tokens ?? 0
          },
          modelo
        },
        { provedor: nome, modelo }
      );
    }
  };
}

export const groq = criarProvedorCompativel({
  nome: 'groq',
  baseUrlPadrao: 'https://api.groq.com/openai/v1',
  modelosPadrao: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']
});

export const openai = criarProvedorCompativel({
  nome: 'openai',
  baseUrlPadrao: 'https://api.openai.com/v1',
  modelosPadrao: ['gpt-4o-mini', 'gpt-4o']
});

export const ollama = criarProvedorCompativel({
  nome: 'ollama',
  baseUrlPadrao: 'http://localhost:11434',
  modelosPadrao: ['llama3.2'],
  // Roda na propria maquina: nao ha chave para configurar.
  precisaChave: false,
  sufixoDaRota: '/v1'
});
