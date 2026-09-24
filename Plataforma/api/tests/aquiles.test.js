import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { priorizarModelo } from '../src/ai/cascade.js';
import { promptDoRedator } from '../src/modules/campanhas/campanhas.service.js';

/**
 * Aquiles: o agente que escreve as mensagens das campanhas.
 *
 * O que se prova aqui: ele existe de fabrica, e configuravel como a Sofia e
 * a Atena, o modelo escolhido para ele e REALMENTE o primeiro a ser chamado,
 * e o que a pessoa configura (exemplos, voz da Sofia, ousadia) chega ao
 * pedido feito ao modelo.
 */

let app;
let cab;
let cabRecepcao;

const salvar = (dados, chave = 'aquiles', cabecalho = cab) =>
  app.inject({ method: 'PUT', url: `/api/ia/agentes/${chave}`, headers: cabecalho, payload: dados });

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cab } = await entrar(app));
  ({ cabecalho: cabRecepcao } = await entrar(app, 'recepcao'));
});

after(async () => {
  // Devolve o Aquiles ao estado de fabrica para os outros arquivos.
  await salvar({ ativo: true, modeloPreferido: null, config: { exemplos: [], herdarSofia: false } });
  await app?.close();
});

describe('o agente Aquiles', () => {
  it('existe de fabrica, ligado, sem exemplos e sem herdar a Sofia', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ia/agentes', headers: cab });
    const aquiles = res.json().agentes.find((a) => a.chave === 'aquiles');

    assert.ok(aquiles, 'o Aquiles precisa aparecer na lista de agentes');
    assert.equal(aquiles.ativo, true);
    assert.deepEqual(aquiles.config, { exemplos: [], herdarSofia: false });
    assert.ok(aquiles.temperatura >= 0.8, 'quem puxa assunto precisa variar: temperatura alta de fabrica');
    assert.match(aquiles.systemPrompt, /Aquiles/);
  });

  it('salva exemplos de estilo, herdar a Sofia e o modelo preferido', async () => {
    const res = await salvar({
      config: { exemplos: ['  E ai, sumido! A cadeira ta com saudade.  ', ''], herdarSofia: true },
      modeloPreferido: 'groq:qwen/qwen3.8-27b',
      temperatura: 1
    });

    assert.equal(res.statusCode, 200, res.body);
    const a = res.json().agente;
    assert.deepEqual(a.config.exemplos, ['E ai, sumido! A cadeira ta com saudade.'], 'limpa espacos e descarta vazios');
    assert.equal(a.config.herdarSofia, true);
    assert.equal(a.modeloPreferido, 'groq:qwen/qwen3.8-27b');
  });

  it('salvar so o modelo nao apaga os exemplos', async () => {
    const res = await salvar({ temperatura: 0.95 });
    assert.deepEqual(res.json().agente.config.exemplos, ['E ai, sumido! A cadeira ta com saudade.']);
  });

  it('recusa mais de 5 exemplos e exemplo gigante', async () => {
    const muitos = await salvar({ config: { exemplos: ['a', 'b', 'c', 'd', 'e', 'f'] } });
    assert.equal(muitos.statusCode, 422);

    const grande = await salvar({ config: { exemplos: ['x'.repeat(601)] } });
    assert.equal(grande.statusCode, 422);
  });

  it('recusa modelo preferido sem provedor', async () => {
    const res = await salvar({ modeloPreferido: 'qwen-sem-provedor' });
    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /provedor:modelo/);
  });

  it('atendente nao configura o Aquiles', async () => {
    const res = await salvar({ temperatura: 0.1 }, 'aquiles', cabRecepcao);
    assert.equal(res.statusCode, 403);
  });
});

describe('o modelo preferido vai na frente da cascata', () => {
  const lista = [
    { provedor: 'gemini', modelos: ['gemini-a', 'gemini-b'] },
    { provedor: 'groq', modelos: ['llama', 'qwen'] }
  ];

  it('o provedor e o modelo escolhidos viram a primeira tentativa, e o resto fica de reserva', () => {
    const r = priorizarModelo(lista, 'groq:qwen');
    assert.equal(r[0].provedor, 'groq');
    assert.deepEqual(r[0].modelos, ['qwen', 'llama']);
    assert.equal(r[1].provedor, 'gemini', 'a cascata continua atras, como reserva');
  });

  it('modelo que nao esta na fila entra mesmo assim', () => {
    assert.deepEqual(priorizarModelo(lista, 'groq:novo-modelo')[0].modelos, ['novo-modelo', 'llama', 'qwen']);
  });

  it('nome de modelo com ":" (Ollama) funciona', () => {
    const r = priorizarModelo([{ provedor: 'ollama', modelos: [] }], 'ollama:llama3:8b');
    assert.deepEqual(r[0].modelos, ['llama3:8b']);
  });

  it('provedor desligado ou sem preferencia: cascata intacta', () => {
    assert.equal(priorizarModelo(lista, 'openai:gpt'), lista);
    assert.equal(priorizarModelo(lista, null), lista);
  });
});

describe('o que chega ao modelo', () => {
  const campanha = { objetivo: 'Chamar de volta quem sumiu' };
  const aquiles = {
    systemPrompt: 'Voce e o Aquiles.',
    config: { exemplos: ['E ai, sumido!', 'Bora cortar esse cabelo?'], herdarSofia: true }
  };
  const sofia = { nome: 'Sofia', tom: 'acolhedor', systemPrompt: 'Voce e a Sofia, carinhosa e direta.' };

  it('leva a persona, os exemplos, a voz da Sofia e a ousadia', () => {
    const p = promptDoRedator({
      campanha,
      iaConfig: { ousadia: 'ousada' },
      nomeEmpresa: 'Barbearia',
      redator: { aquiles, sofia }
    });

    assert.match(p, /Voce e o Aquiles/);
    assert.match(p, /E ai, sumido!/);
    assert.match(p, /Bora cortar esse cabelo\?/);
    assert.match(p, /NUNCA copie/, 'os exemplos sao de estilo, nao de conteudo');
    assert.match(p, /carinhosa e direta/);
    assert.match(p, /Acolhedor/);
    assert.match(p, /Ousadia: alta/);
    assert.match(p, /ate 2 emoji/);
    assert.match(p, /Chamar de volta quem sumiu/);
    assert.match(p, /vi que/, 'as regras fixas continuam valendo');
  });

  it('sem herdar a Sofia e sem exemplos, nada disso aparece', () => {
    const p = promptDoRedator({
      campanha,
      iaConfig: {},
      nomeEmpresa: 'Barbearia',
      redator: { aquiles: { systemPrompt: 'Aquiles.', config: { exemplos: [] } }, sofia: null }
    });
    assert.doesNotMatch(p, /VOZ DA CASA/);
    assert.doesNotMatch(p, /EXEMPLOS/);
    assert.match(p, /Ousadia: equilibrada/);
  });
});

describe('Aquiles desligado', () => {
  it('a campanha avisa em vez de gerar textos de reserva', async () => {
    const { db } = await import('../src/db/client.js');
    const schema = await import('../src/db/schema/index.js');
    const [canal] = await db.select().from(schema.channelInstances);

    const lead = (
      await app.inject({ method: 'POST', url: '/api/leads', headers: cab, payload: { nome: 'Cliente Aquiles', telefone: '11912340777' } })
    ).json().lead;
    const c = (
      await app.inject({ method: 'POST', url: '/api/campanhas', headers: cab, payload: { nome: 'Sem Aquiles', channelInstanceId: canal.id } })
    ).json().campanha;
    await app.inject({ method: 'PATCH', url: `/api/campanhas/${c.id}`, headers: cab, payload: { objetivo: 'Teste' } });
    await app.inject({ method: 'PUT', url: `/api/campanhas/${c.id}/publico`, headers: cab, payload: { leadIds: [lead.id] } });

    await salvar({ ativo: false });
    const res = await app.inject({ method: 'POST', url: `/api/campanhas/${c.id}/gerar`, headers: cab });
    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /Aquiles/);

    const previa = await app.inject({ method: 'POST', url: `/api/campanhas/${c.id}/previa`, headers: cab, payload: {} });
    assert.equal(previa.statusCode, 422);

    await salvar({ ativo: true });
  });
});
