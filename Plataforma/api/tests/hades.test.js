import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { env } from '../src/config/env.js';

/**
 * Hades — assistente administrativo do dono, a parte do resto do sistema:
 * chave propria (nunca devolvida a tela), so dono/DEV, desligavel pelo DEV,
 * Gemini com pesquisa do Google e um resumo do negocio no contexto.
 *
 * O Google e de mentira: o fetch para a API do Gemini e interceptado.
 */

let app;
let cab;
const CHAVE = 'AIzaTesteDoHades1234567890XYZ9';
const BASE = env.GEMINI_BASE_URL.replace(/\/+$/, '');
const fetchOriginal = globalThis.fetch;
const chamadas = [];

const resposta = {
  candidates: [
    {
      content: { parts: [{ text: 'Seu **sábado** está cheio. Sugiro uma promoção na terça à tarde.' }] },
      finishReason: 'STOP',
      groundingMetadata: {
        webSearchQueries: ['tendências barbearia 2026'],
        groundingChunks: [
          { web: { uri: 'https://exemplo.com/tendencias', title: 'Tendências do setor' } },
          { web: { uri: 'https://exemplo.com/tendencias', title: 'Repetida' } }
        ]
      }
    }
  ],
  usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 40 }
};

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cab } = await entrar(app));
  globalThis.fetch = async (url, opcoes) => {
    const u = String(url);
    if (!u.startsWith(BASE)) return fetchOriginal(url, opcoes);
    chamadas.push({ url: u, corpo: opcoes?.body ? JSON.parse(opcoes.body) : null });
    const json = u.includes('/models?')
      ? {
          models: [
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
          ]
        }
      : resposta;
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
  };
});

beforeEach(() => {
  chamadas.length = 0;
});

after(async () => {
  globalThis.fetch = fetchOriginal;
  await app?.close();
});

const put = (payload, c = cab) => app.inject({ method: 'PUT', url: '/api/hades/config', headers: c, payload });
const conversar = (mensagens, c = cab) => app.inject({ method: 'POST', url: '/api/hades/conversar', headers: c, payload: { mensagens } });

describe('configuração', () => {
  it('sem chave: conversar explica o que falta', async () => {
    const r = await conversar([{ papel: 'user', conteudo: 'oi' }]);
    assert.equal(r.statusCode, 422);
    assert.match(r.json().erro.mensagem, /chave de API/);
  });

  it('guarda a chave cifrada e NUNCA a devolve (só o final)', async () => {
    const r = await put({ apiKey: CHAVE });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().config.temChave, true);
    assert.equal(r.json().config.chaveFinal, CHAVE.slice(-4));
    assert.ok(!r.body.includes(CHAVE));
    const lida = await app.inject({ method: 'GET', url: '/api/hades/config', headers: cab });
    assert.ok(!lida.body.includes(CHAVE));
    // Nem no banco em texto puro.
    const { db } = await import('../src/db/client.js');
    const { settings } = await import('../src/db/schema/ai.js');
    const linhas = await db.select().from(settings);
    assert.ok(!JSON.stringify(linhas).includes(CHAVE));
  });

  it('só o dono (e o DEV): atendente recebe 403', async () => {
    const { cabecalho } = await entrar(app, 'recepcao');
    assert.equal((await app.inject({ method: 'GET', url: '/api/hades/config', headers: cabecalho })).statusCode, 403);
    assert.equal((await conversar([{ papel: 'user', conteudo: 'oi' }], cabecalho)).statusCode, 403);
  });

  it('o DEV desliga (agente_hades): para o dono, tudo some (404)', async () => {
    const { definirFuncao } = await import('../src/modules/funcoes/funcoes.js');
    const { tenantId } = (await entrar(app)).usuario;
    await definirFuncao(tenantId, 'agente_hades', false);
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/api/hades/config', headers: cab })).statusCode, 404);
    } finally {
      await definirFuncao(tenantId, 'agente_hades', true);
    }
  });
});

describe('conversa', () => {
  it('sem modelo escolhido, usa o melhor "flash" que a chave enxerga (nada de lite)', async () => {
    await put({ modelo: null, pesquisaWeb: true });
    const r = await conversar([{ papel: 'user', conteudo: 'Como foi o mês?' }]);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().modelo, 'models/gemini-3.5-flash');
  });

  it('manda a pesquisa do Google, o resumo do negócio e devolve texto + fontes sem repetir', async () => {
    const r = await conversar([
      { papel: 'user', conteudo: 'oi' },
      { papel: 'assistant', conteudo: 'Olá!' },
      { papel: 'user', conteudo: 'Que promoção faço?' }
    ]);
    assert.equal(r.statusCode, 200, r.body);
    const corpo = r.json();
    assert.match(corpo.texto, /promoção/);
    assert.deepEqual(corpo.fontes, [{ titulo: 'Tendências do setor', url: 'https://exemplo.com/tendencias' }]);
    assert.deepEqual(corpo.buscas, ['tendências barbearia 2026']);

    const enviada = chamadas.find((c) => c.url.includes(':generateContent')).corpo;
    assert.deepEqual(enviada.tools, [{ google_search: {} }]);
    const sistema = enviada.systemInstruction.parts[0].text;
    assert.match(sistema, /RESUMO DO NEGÓCIO/);
    assert.match(sistema, /Faturamento: R\$/);
    assert.match(sistema, /Não invente/);
    // Papeis do Gemini: "model" para o assistente.
    assert.deepEqual(enviada.contents.map((c) => c.role), ['user', 'model', 'user']);
  });

  it('pesquisa na internet desligada: sem a ferramenta do Google', async () => {
    await put({ pesquisaWeb: false });
    await conversar([{ papel: 'user', conteudo: 'oi' }]);
    const enviada = chamadas.find((c) => c.url.includes(':generateContent')).corpo;
    assert.equal(enviada.tools, undefined);
    await put({ pesquisaWeb: true });
  });

  it('Hades desligado na configuração: não conversa', async () => {
    await put({ ativo: false });
    const r = await conversar([{ papel: 'user', conteudo: 'oi' }]);
    assert.equal(r.statusCode, 422);
    await put({ ativo: true });
  });

  it('a última mensagem precisa ser a pergunta do dono', async () => {
    const r = await conversar([{ papel: 'assistant', conteudo: 'oi' }]);
    assert.equal(r.statusCode, 400);
  });
});
