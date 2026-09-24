import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

let app;
let cabDono;
let cabRecepcao;

const CHAVE = 'AIzaSyD-chave-secreta-de-exemplo-9876';

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cabDono } = await entrar(app));
  ({ cabecalho: cabRecepcao } = await entrar(app, 'recepcao'));
});

after(async () => {
  await app?.close();
});

describe('a chave de API nunca sai do servidor', () => {
  it('salva a chave e devolve so os 4 ultimos digitos', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/ia/provedores/gemini',
      headers: cabDono,
      payload: { apiKey: CHAVE, modeloPadrao: 'models/gemini-2.5-flash', habilitado: true }
    });

    assert.equal(res.statusCode, 200);
    const p = res.json().provedor;

    assert.equal(p.temChave, true);
    assert.equal(p.chaveSufixo, '••••9876');
    assert.ok(!res.body.includes(CHAVE), 'a chave nao pode voltar na resposta');
  });

  /**
   * A falha exata do sistema antigo: `GET /api/ai/status` espalhava a linha
   * do banco com `...p`, levando `api_key` em texto puro — sem exigir login.
   */
  it('a listagem nao vaza a chave em nenhum campo', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ia/provedores', headers: cabDono });

    assert.equal(res.statusCode, 200);
    assert.ok(!res.body.includes(CHAVE), 'vazou a chave na listagem');
    assert.ok(!res.body.includes('apiKeyCifrada'), 'nem o campo cifrado deve aparecer');
    assert.ok(!/AIzaSy/.test(res.body));
  });

  it('a chave fica cifrada no banco, nao em texto puro', async () => {
    const { db } = await import('../src/db/client.js');
    const { aiProviders } = await import('../src/db/schema/index.js');
    const [linha] = await db.select().from(aiProviders);

    assert.ok(linha.apiKeyCifrada);
    assert.ok(!linha.apiKeyCifrada.includes(CHAVE), 'a chave esta em texto puro no banco');
    assert.ok(linha.apiKeyCifrada.startsWith('v1.'));

    // E ainda assim o servidor consegue recuperar a chave quando precisa.
    const { decifrar } = await import('../src/core/crypto.js');
    assert.equal(decifrar(linha.apiKeyCifrada), CHAVE);
  });

  it('manter a chave ao salvar outros campos (a tela nunca a recebe de volta)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/ia/provedores/gemini',
      headers: cabDono,
      payload: { prioridade: 1 } // sem apiKey
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().provedor.temChave, true, 'a chave nao pode sumir por salvar outro campo');
    assert.equal(res.json().provedor.prioridade, 1);
  });
});

describe('permissao nas rotas de IA', () => {
  it('sem login nao ve configuracao de IA', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ia/provedores' });
    assert.equal(res.statusCode, 401);
  });

  it('atendente NAO ve as chaves', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ia/provedores', headers: cabRecepcao });
    assert.equal(res.statusCode, 403);
  });

  it('atendente NAO configura provedor', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/ia/provedores/groq',
      headers: cabRecepcao,
      payload: { apiKey: 'gsk_tentativa_de_invasao_123' }
    });
    assert.equal(res.statusCode, 403);
  });

  it('atendente PODE ler o perfil do agente', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ia/agentes', headers: cabRecepcao });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().agentes.length >= 1);
  });
});

describe('validacao de configuracao', () => {
  /**
   * Habilitar sem chave faria a cascata pular o provedor em silencio — e a
   * empresa acharia que esta com IA ligada ate o primeiro cliente reclamar.
   */
  it('nao deixa habilitar provedor sem chave', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/ia/provedores/openai',
      headers: cabDono,
      payload: { habilitado: true }
    });

    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /chave de API/i);
  });

  it('ollama pode ser habilitado sem chave (roda local)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/ia/provedores/ollama',
      headers: cabDono,
      payload: { habilitado: true, modeloPadrao: 'llama3.2' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().provedor.habilitado, true);
    assert.equal(res.json().provedor.precisaChave, false);
  });

  it('recusa provedor desconhecido', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/ia/provedores/skynet',
      headers: cabDono,
      payload: { apiKey: 'chave-qualquer-123' }
    });

    assert.equal(res.statusCode, 422);
  });

  it('recusa chave curta demais', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/ia/provedores/groq',
      headers: cabDono,
      payload: { apiKey: 'abc' }
    });

    assert.equal(res.statusCode, 400);
  });

  it('lista tambem os provedores ainda nao configurados', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ia/provedores', headers: cabDono });
    const { disponiveis } = res.json();

    assert.ok(Array.isArray(disponiveis));
    assert.ok(disponiveis.some((d) => d.provedor === 'openai' || d.provedor === 'groq'));
  });
});

describe('perfis de agente', () => {
  it('guarda a temperatura sem erro de ponto flutuante', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/ia/agentes/atendente',
      headers: cabDono,
      payload: { temperatura: 0.7, nome: 'Sofia' }
    });

    assert.equal(res.statusCode, 200);
    // Guardado como 700 (inteiro), devolvido como 0.7 exato — nao 0.6999999.
    assert.equal(res.json().agente.temperatura, 0.7);
  });

  it('cria um agente novo quando a chave nao existe', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/ia/agentes/classificador_humor',
      headers: cabDono,
      payload: { nome: 'Classificador', systemPrompt: 'Classifique o humor do cliente.', temperatura: 0.1 }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().agente.chave, 'classificador_humor');
    assert.equal(res.json().agente.temperatura, 0.1);
  });

  it('recusa temperatura fora do intervalo', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/ia/agentes/atendente',
      headers: cabDono,
      payload: { temperatura: 9 }
    });

    assert.equal(res.statusCode, 400);
  });
});

describe('uso e custo', () => {
  it('resume o consumo dos ultimos dias', async () => {
    // Gera algumas chamadas com provedor de mentira.
    const { gerar } = await import('../src/ai/cascade.js');
    const { db } = await import('../src/db/client.js');
    const { tenants } = await import('../src/db/schema/index.js');
    const [t] = await db.select().from(tenants);

    const falso = {
      impl: {
        nome: 'gemini',
        async gerar({ modelo }) {
          return { texto: 'ok', chamadasDeFerramenta: [], tokens: { entrada: 100, saida: 50 }, modelo };
        }
      },
      apiKey: 'x',
      modelos: ['models/gemini-2.5-flash']
    };

    for (let i = 0; i < 3; i++) {
      await gerar({ tenantId: t.id, mensagens: [{ papel: 'user', conteudo: 'oi' }], provedores: [falso] });
    }

    const res = await app.inject({ method: 'GET', url: '/api/ia/uso?dias=7', headers: cabDono });

    assert.equal(res.statusCode, 200);
    const u = res.json();

    assert.ok(u.total >= 3);
    assert.ok(u.sucessos >= 3);
    assert.equal(u.tokensEntrada >= 300, true);
    assert.ok(u.porProvedor.some((p) => p.provedor === 'gemini'));
  });

  it('atendente NAO ve o consumo', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ia/uso', headers: cabRecepcao });
    assert.equal(res.statusCode, 403);
  });
});
