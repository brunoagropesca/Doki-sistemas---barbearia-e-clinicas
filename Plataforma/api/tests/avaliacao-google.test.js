import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { abrirACasa, criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { receberMensagem, recarregarAgrupador, registrarAdaptador } from '../src/channels/gateway.js';
import { aguardarAvaliacoes } from '../src/automacao/avaliacaoGoogle.js';

/**
 * Avaliacao do Google (funcao da Sofia): ao finalizar, 1º balao escrito pela
 * IA (agradecimento + pedido), 2º balao so o link. Cliente frustrado nao
 * recebe; desligada ou sem link, nada sai; cada atendimento pede uma vez.
 *
 * WhatsApp e IA de mentira. Telefones proprios (5592900098xxx). A linha da
 * Sofia e restaurada no fim — a configuracao dela vale para a suite toda.
 */

let app;
let tenantId;
let cab;
let db;
let s;
let sofiaAntes;
let telefone = 5592900098000;

const LINK = 'https://g.page/r/barbearia-teste/review';
const enviados = [];
let seq = 0;
registrarAdaptador('whatsapp', {
  async enviar({ destino, texto }) {
    enviados.push({ destino, texto });
    return { idExterno: `aval_${++seq}` };
  },
  async conectar() {
    return { conectando: true };
  },
  async desconectar() {
    return { ok: true };
  },
  estaConectada: () => true
});

// O que a "IA" responde a qualquer chamada. `null` = fora do ar.
let respostaDaIa = 'Valeu demais, João! Se curtiu o corte, deixa sua avaliação no Google? https://link-que-a-ia-inventou.com';
const fetchOriginal = globalThis.fetch;

const configurar = (avaliacaoGoogle) =>
  app.inject({ method: 'PUT', url: '/api/ia/agentes/atendente', headers: cab, payload: { config: { avaliacaoGoogle } } });

/** Uma conversa nova (a Sofia responde a um "oi") e o que o cliente recebeu dela. */
async function conversaNova() {
  const numero = String(++telefone);
  const r = await receberMensagem({ tenantId, canal: 'whatsapp', instanciaChave: 'W1', remetente: numero, texto: 'Oi, cortei aí hoje', nome: 'João Teste' });
  return { numero, id: r.conversationId };
}

async function finalizar(id) {
  const r = await app.inject({ method: 'POST', url: `/api/conversas/${id}/finalizar`, headers: cab, payload: {} });
  assert.equal(r.statusCode, 200, r.body);
  await aguardarAvaliacoes();
}

const recebidos = (numero) => enviados.filter((e) => e.destino === numero).map((e) => e.texto);

before(async () => {
  ({ app } = await criarAppDeTeste());
  await abrirACasa();
  const dono = await entrar(app);
  cab = dono.cabecalho;
  tenantId = dono.usuario.tenantId;

  ({ db } = await import('../src/db/client.js'));
  s = await import('../src/db/schema/index.js');
  sofiaAntes = (await db.select().from(s.agentProfiles)).filter((a) => a.tenantId === tenantId && a.chave === 'atendente');

  await db.insert(s.aiProviders).values({
    id: 'aip_avaliacao',
    tenantId,
    provedor: 'ollama',
    habilitado: true,
    prioridade: 0,
    baseUrl: 'http://ia-avaliacao.local/v1',
    modelos: [{ nome: 'modelo-falso', ativo: true }]
  });
  globalThis.fetch = async (url, opcoes) => {
    if (!String(url).startsWith('http://ia-avaliacao.local')) return fetchOriginal(url, opcoes);
    if (respostaDaIa === null) return { ok: false, status: 503, json: async () => ({}), text: async () => 'fora do ar' };
    const dados = { choices: [{ message: { content: respostaDaIa }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } };
    return { ok: true, status: 200, json: async () => dados, text: async () => JSON.stringify(dados) };
  };

  const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
  await atendimento.salvarConfiguracao(tenantId, { modo: 'ia', agrupamentoSegundos: 0 });
  recarregarAgrupador(tenantId);
});

after(async () => {
  globalThis.fetch = fetchOriginal;
  await db.delete(s.aiProviders).where(eq(s.aiProviders.id, 'aip_avaliacao'));
  const atuais = (await db.select().from(s.agentProfiles)).filter((a) => a.tenantId === tenantId && a.chave === 'atendente');
  for (const a of atuais) await db.delete(s.agentProfiles).where(eq(s.agentProfiles.id, a.id));
  if (sofiaAntes.length) await db.insert(s.agentProfiles).values(sofiaAntes);
  await app?.close();
});

describe('configuracao', () => {
  it('link que nao abre e recusado; ligar sem link pode (a tela avisa)', async () => {
    const torto = await configurar({ ativo: true, link: 'g.page/sem-https', mensagem: '' });
    assert.equal(torto.statusCode, 422);
    assert.match(torto.json().erro?.mensagem ?? torto.body, /https:\/\//);

    const semLink = await configurar({ ativo: true, link: '', mensagem: '' });
    assert.equal(semLink.statusCode, 200, semLink.body);
  });

  it('e so da Sofia: na Atena e recusada', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/ia/agentes/atena',
      headers: cab,
      payload: { config: { avaliacaoGoogle: { ativo: true, link: LINK } } }
    });
    assert.equal(r.statusCode, 422);
  });

  it('ligada SEM link: finalizar nao manda nada', async () => {
    await configurar({ ativo: true, link: '', mensagem: '' });
    const { numero, id } = await conversaNova();
    const antes = recebidos(numero).length;
    await finalizar(id);
    assert.equal(recebidos(numero).length, antes);
  });
});

describe('ao finalizar', () => {
  it('dois baloes: o pedido escrito pela IA (sem link) e depois so o link', async () => {
    await configurar({ ativo: true, link: LINK, mensagem: 'Obrigado pela visita! Avalia a gente no Google?' });
    const { numero, id } = await conversaNova();
    const antes = recebidos(numero).length;
    await finalizar(id);

    const novos = recebidos(numero).slice(antes);
    assert.equal(novos.length, 2, JSON.stringify(novos));
    assert.match(novos[0], /avaliação no Google/);
    assert.doesNotMatch(novos[0], /https?:\/\//, 'link que a IA escreveu sai do 1º balao');
    assert.equal(novos[1], LINK);

    // Gravados na conversa, marcados — o livechat mostra o que foi.
    const conversa = await app.inject({ method: 'GET', url: `/api/conversas/${id}/mensagens`, headers: cab });
    const marcadas = (conversa.json().mensagens ?? conversa.json().itens ?? []).filter((m) => m.metadados?.avaliacaoGoogle);
    assert.equal(marcadas.length, 2);
  });

  it('cliente FRUSTRADO nao recebe', async () => {
    const { numero, id } = await conversaNova();
    await db.update(s.conversations).set({ humor: 'frustrado' }).where(eq(s.conversations.id, id));
    const antes = recebidos(numero).length;
    await finalizar(id);
    assert.equal(recebidos(numero).length, antes);
  });

  it('desligada: nada sai', async () => {
    await configurar({ ativo: false, link: LINK, mensagem: '' });
    const { numero, id } = await conversaNova();
    const antes = recebidos(numero).length;
    await finalizar(id);
    assert.equal(recebidos(numero).length, antes);
    await configurar({ ativo: true, link: LINK, mensagem: '' });
  });

  it('reaberta e finalizada de novo: nao pede duas vezes', async () => {
    const { numero, id } = await conversaNova();
    await finalizar(id);
    const depoisDoPrimeiro = recebidos(numero).length;

    const r = await app.inject({ method: 'POST', url: `/api/conversas/${id}/reabrir`, headers: cab });
    assert.equal(r.statusCode, 200, r.body);
    await finalizar(id);
    assert.equal(recebidos(numero).length, depoisDoPrimeiro);
  });

  it('IA fora do ar: vai a mensagem base como esta, e o link depois', async () => {
    await configurar({ ativo: true, link: LINK, mensagem: 'Valeu! Deixa 5 estrelas pra gente?' });
    const { numero, id } = await conversaNova();
    const antes = recebidos(numero).length;
    respostaDaIa = null;
    try {
      await finalizar(id);
    } finally {
      respostaDaIa = 'Valeu demais, João! Se curtiu o corte, deixa sua avaliação no Google?';
    }
    assert.deepEqual(recebidos(numero).slice(antes), ['Valeu! Deixa 5 estrelas pra gente?', LINK]);
  });
});
