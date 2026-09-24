import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiCalls, aiProviders } from '../db/schema/ai.js';
import { ID } from '../core/ids.js';
import { env } from '../config/env.js';
import { comContexto } from '../core/logger.js';
import { decifrar } from '../core/crypto.js';
import { colorir, resumir, ver } from '../core/painel.js';

const log = comContexto({ modulo: 'transcricao' });

/**
 * Transcricao de audio: o que o cliente falou, em texto.
 *
 * Existe porque o WhatsApp de barbearia e clinica e cheio de audio — "oi, queria
 * marcar um horario pra sexta" dito em 6 segundos. Sem transcrever, a Sofia fica
 * cega: a mensagem chega, mas ela nao tem o que ler.
 *
 * NAO usa a cascata de `cascade.js`. A cascata conversa (`/chat/completions`,
 * ferramentas, historico); transcrever e outro tipo de chamada, com outra rota e
 * outro formato. Forcar as duas no mesmo lugar deixaria o `gerar` cheio de "se
 * for audio, entao...". Aqui e uma cascata propria e curta, com a MESMA ideia:
 * tenta o melhor, cai para o reserva, e nunca lanca.
 *
 * Ordem:
 *   1. Groq Whisper — modelo feito so para isto. Rapido, barato e bom em
 *      portugues.
 *   2. Gemini — multimodal: o audio vai junto do prompt. Reserva para quando o
 *      Groq estiver fora ou sem cota.
 *
 * As chaves sao as MESMAS que a empresa ja cadastrou na tela de Cascata: quem
 * tem Groq ou Gemini ligado ja tem transcricao, sem configurar nada novo.
 */

/** Modelo de transcricao do Groq. O "turbo" e varias vezes mais rapido e custa menos. */
const MODELO_GROQ = 'whisper-large-v3-turbo';

/**
 * Modelo do Gemini usado como reserva.
 *
 * Fixo, e nao o primario da empresa: o primario pode ser um modelo que nem
 * aceita audio (o catalogo do Gemini mistura texto, imagem e voz), e ai a
 * reserva falharia justamente quando e necessaria.
 */
const MODELO_GEMINI = 'models/gemini-2.5-flash';

/** Instrucao do reserva. Pedimos SO o texto: qualquer enfeite viraria fala do cliente. */
const PROMPT_GEMINI =
  'Transcreva EXATAMENTE o que a pessoa fala neste áudio, em português do Brasil. ' +
  'Responda apenas com a transcrição, sem aspas, sem comentários e sem descrever ruídos. ' +
  'Se não houver fala audível, responda exatamente: (sem fala)';

/** O modelo nao ouviu fala nenhuma — audio mudo, barulho, toque sem querer. */
const SEM_FALA = /^\(?\s*sem fala\s*\)?\.?$/i;

/** Teto de tempo por tentativa. Audio de WhatsApp e curto; passou disso, algo travou. */
const TIMEOUT_MS = 30_000;

/**
 * Teto de tamanho aceito para transcrever.
 *
 * Audio de WhatsApp raramente passa de 1 MB. O limite existe porque mandar um
 * arquivo de 20 MB para a API custa caro e demora — e quem manda isso quase
 * sempre e um encaminhamento, nao um recado para a barbearia.
 */
export const LIMITE_BYTES = 8 * 1024 * 1024;

/** Le a chave de um provedor habilitado da empresa. `null` = nao da para usar. */
async function provedorPronto(tenantId, nome) {
  const [linha] = await db
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.tenantId, tenantId), eq(aiProviders.provedor, nome), eq(aiProviders.habilitado, true)))
    .orderBy(asc(aiProviders.prioridade))
    .limit(1);

  if (!linha) return null;
  const apiKey = linha.apiKeyCifrada ? decifrar(linha.apiKeyCifrada) : null;
  if (!apiKey) return null;

  return { apiKey, baseUrl: linha.baseUrl };
}

/** Faz a chamada com prazo. Sem isto, uma chamada travada segura a resposta ao cliente. */
async function comPrazo(fn) {
  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    return await fn(controle.signal);
  } finally {
    clearTimeout(prazo);
  }
}

/** Groq: rota dedicada de transcricao, com o arquivo em multipart. */
async function viaGroq({ apiKey, baseUrl, bytes, mimetype, nomeArquivo }) {
  const raiz = (baseUrl || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');

  const formulario = new FormData();
  formulario.append('file', new Blob([bytes], { type: mimetype }), nomeArquivo);
  formulario.append('model', MODELO_GROQ);
  // Dizer que e portugues melhora bastante o resultado: sem isto o Whisper as
  // vezes "ouve" espanhol num audio curto e devolve a frase toda errada.
  formulario.append('language', 'pt');
  formulario.append('response_format', 'text');
  // Zero = a transcricao mais literal possivel. Nao queremos criatividade aqui.
  formulario.append('temperature', '0');

  const res = await comPrazo((signal) =>
    fetch(`${raiz}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formulario,
      signal
    })
  );

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }

  return { texto: (await res.text()).trim(), modelo: MODELO_GROQ };
}

/** Gemini: o audio vai embutido no proprio pedido, em base64. */
async function viaGemini({ apiKey, bytes, mimetype }) {
  const raiz = env.GEMINI_BASE_URL.replace(/\/+$/, '');

  const res = await comPrazo((signal) =>
    fetch(`${raiz}/${MODELO_GEMINI}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: PROMPT_GEMINI },
              { inline_data: { mime_type: mimetype, data: Buffer.from(bytes).toString('base64') } }
            ]
          }
        ],
        generationConfig: { temperature: 0, maxOutputTokens: 1000 }
      }),
      signal
    })
  );

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }

  const dados = await res.json();
  const texto = (dados.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();

  return { texto, modelo: MODELO_GEMINI };
}

/**
 * Transcreve um audio. NUNCA lanca.
 *
 * Falhar aqui nao pode derrubar o atendimento: o audio ja chegou e ja vai ser
 * gravado na conversa de um jeito ou de outro. Quem chama decide o que fazer
 * com o `null` — no gateway, a conversa vai para a fila humana, para uma pessoa
 * ouvir o que a maquina nao conseguiu.
 *
 * @param {object} p
 * @param {string} p.tenantId
 * @param {Buffer|Uint8Array} p.bytes
 * @param {string} [p.mimetype]
 * @param {string} [p.nomeArquivo]   so para o multipart do Groq
 * @param {string} [p.conversationId] para o registro de custo
 * @returns {Promise<{texto: string, provedor: string, modelo: string}|null>}
 */
export async function transcreverAudio({
  tenantId,
  bytes,
  mimetype = 'audio/ogg',
  nomeArquivo = 'audio.ogg',
  conversationId = null
}) {
  if (!bytes?.length) return null;

  if (bytes.length > LIMITE_BYTES) {
    log.warn({ tenantId, bytes: bytes.length }, 'Audio grande demais para transcrever');
    ver('aviso', 'áudio grande demais para transcrever', `${Math.round(bytes.length / 1024)} KB`);
    return null;
  }

  const inicio = Date.now();
  const tentativas = [];

  // A ordem e proposital: o Whisper e feito para isto; o Gemini e a rede.
  const candidatos = [
    { nome: 'groq', executar: viaGroq },
    { nome: 'gemini', executar: viaGemini }
  ];

  for (const candidato of candidatos) {
    const pronto = await provedorPronto(tenantId, candidato.nome);
    if (!pronto) continue;

    try {
      const { texto, modelo } = await candidato.executar({ ...pronto, bytes, mimetype, nomeArquivo });

      // Audio sem fala nao e falha de provedor: tentar o proximo so gastaria
      // dinheiro para ouvir o mesmo silencio.
      if (!texto || SEM_FALA.test(texto)) {
        await registrar({ tenantId, conversationId, provedor: candidato.nome, modelo, sucesso: true, latenciaMs: Date.now() - inicio, tentativas });
        log.info({ tenantId, provedor: candidato.nome }, 'Audio sem fala audivel');
        ver('aviso', 'áudio sem fala audível', `${candidato.nome}/${modelo}`);
        return null;
      }

      await registrar({ tenantId, conversationId, provedor: candidato.nome, modelo, sucesso: true, latenciaMs: Date.now() - inicio, tentativas });

      ver(
        'tool',
        `${colorir('cliente', 'áudio')} transcrito: "${resumir(texto, 110)}"`,
        `${candidato.nome}/${modelo} · ${Date.now() - inicio}ms · ${Math.round(bytes.length / 1024)} KB`
      );

      return { texto, provedor: candidato.nome, modelo };
    } catch (err) {
      tentativas.push({ provedor: candidato.nome, erro: err.message });
      log.warn({ err, tenantId, provedor: candidato.nome }, 'Provedor nao transcreveu o audio');
      ver('aviso', `${candidato.nome} não transcreveu o áudio`, resumir(err.message, 90));
    }
  }

  await registrar({
    tenantId,
    conversationId,
    provedor: 'nenhum',
    modelo: 'nenhum',
    sucesso: false,
    latenciaMs: Date.now() - inicio,
    tentativas,
    erro: tentativas.at(-1)?.erro ?? 'Nenhum provedor de transcricao disponivel'
  });

  return null;
}

/** Registro de custo, como o da cascata. Falhar aqui nunca derruba o atendimento. */
async function registrar({ tenantId, conversationId, provedor, modelo, sucesso, latenciaMs, tentativas, erro }) {
  try {
    await db.insert(aiCalls).values({
      id: ID.provedorIa().replace('aip', 'call'),
      tenantId,
      origem: 'transcricao',
      agentKey: null,
      conversationId,
      provedor,
      modelo,
      sucesso,
      latenciaMs,
      // Transcricao nao cobra por token, e sim por segundo de audio. Deixar
      // zero e honesto: melhor um campo vazio do que um numero inventado.
      tokensEntrada: 0,
      tokensSaida: 0,
      tentativas: tentativas ?? [],
      erro: erro ?? null
    });
  } catch (err) {
    log.error({ err }, 'Falha ao registrar a chamada de transcricao');
  }
}
