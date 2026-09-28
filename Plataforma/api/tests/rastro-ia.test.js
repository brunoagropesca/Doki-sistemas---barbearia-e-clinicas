import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { abrirACasa, criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { receberMensagem, recarregarAgrupador, registrarAdaptador } from '../src/channels/gateway.js';

/**
 * Rastro da IA enxuto.
 *
 * Antes cada balao da Sofia gravava o rastro inteiro da resposta (consultas
 * com resultados, Atena, ferramentas) — o mesmo em todos, ~6x o texto. Agora
 * so o 1o balao o guarda, e depois de 90 dias ele vira um resumo.
 *
 * WhatsApp e IA de mentira (como em assinatura.test.js). Telefones proprios
 * (5592900055xxx).
 */

let app;
let tenantId;
let db;
let s;
const fetchOriginal = globalThis.fetch;
const adaptadorFalso = {
  async enviar() {
    return { idExterno: `rastro_${Math.random()}` };
  },
  async conectar() {
    return { conectando: true };
  },
  async desconectar() {
    return { ok: true };
  },
  estaConectada: () => true
};

const mensagensDaIa = async (conversationId) => {
  const { and, asc, eq } = await import('drizzle-orm');
  return db
    .select()
    .from(s.messages)
    .where(and(eq(s.messages.conversationId, conversationId), eq(s.messages.autorTipo, 'ia')))
    .orderBy(asc(s.messages.createdAt));
};

before(async () => {
  ({ app } = await criarAppDeTeste());
  await abrirACasa();
  const dono = await entrar(app);
  tenantId = dono.usuario.tenantId;
  registrarAdaptador('whatsapp', adaptadorFalso);
  ({ db } = await import('../src/db/client.js'));
  s = await import('../src/db/schema/index.js');

  await db.insert(s.aiProviders).values({
    id: 'aip_rastro',
    tenantId,
    provedor: 'ollama',
    habilitado: true,
    prioridade: 0,
    baseUrl: 'http://ia-rastro.local/v1',
    modelos: [{ nome: 'modelo-falso', ativo: true }]
  });
  globalThis.fetch = async (url, opcoes) => {
    if (!String(url).startsWith('http://ia-rastro.local')) return fetchOriginal(url, opcoes);
    const dados = {
      choices: [{ message: { content: 'Oi! Tenho horário sexta.[BALAO]Pode ser às 15h?[BALAO]Me avisa!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 }
    };
    return { ok: true, status: 200, json: async () => dados, text: async () => JSON.stringify(dados) };
  };
  const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
  await atendimento.salvarConfiguracao(tenantId, { modo: 'ia', agrupamentoSegundos: 0 });
  recarregarAgrupador(tenantId);
});

after(async () => {
  globalThis.fetch = fetchOriginal;
  const { eq } = await import('drizzle-orm');
  await db.delete(s.aiProviders).where(eq(s.aiProviders.id, 'aip_rastro'));
  await app?.close();
});

describe('rastro so no primeiro balao', () => {
  it('resposta com 3 baloes: o 1o tem o rastro, os outros so a posicao', async (t) => {
    const r = await receberMensagem({ tenantId, remetente: '5592900055001', texto: 'tem horário sexta?', idExterno: 'rastro-in-1' });
    const ia = await mensagensDaIa(r.conversationId);
    assert.equal(ia.length, 3);

    assert.equal(ia[0].metadados.balao, 1);
    assert.equal(ia[0].metadados.totalBaloes, 3);
    assert.ok(ia[0].metadados.provedor, 'o rastro (quem respondeu) fica no 1o');
    assert.deepEqual(ia[1].metadados, { balao: 2, totalBaloes: 3 });
    assert.deepEqual(ia[2].metadados, { balao: 3, totalBaloes: 3 });

    const agora = ia.reduce((t, m) => t + JSON.stringify(m.metadados).length, 0);
    const antes = 3 * JSON.stringify({ ...ia[0].metadados }).length; // como era: o mesmo rastro em cada balao
    t.diagnostic(`metadados desta resposta: antes ${antes} bytes, agora ${agora} bytes`);
    assert.ok(agora < antes);
  });
});

describe('rastro antigo vira resumo', () => {
  it('100 dias: fica so o resumo; 10 dias: intacto; cliente e atendente nunca', async (t) => {
    const { eq } = await import('drizzle-orm');
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const leads = await import('../src/modules/leads/leads.service.js');
    const repo = await import('../src/modules/conversas/conversas.repo.js');
    const { compactarRastrosAntigos } = await import('../src/modules/conversas/rastro.js');

    const lead = await leads.encontrarOuCriarPorTelefone(tenantId, '5592900055002', 'Cliente Rastro');
    const conversationId = await conversas.encontrarOuAbrir(tenantId, { leadId: lead.id });
    const rastro = {
      modo: 'hibrido',
      provedor: 'gemini',
      modelo: 'models/gemini-2.5-flash',
      voltas: 2,
      ferramentas: ['consultar_horarios'],
      consultas: [{ nome: 'consultar_horarios', argumentos: { data: 'sexta' }, resultado: { horariosLivres: Array(40).fill('09:00') } }],
      atena: [{ pedido: 'x', trace: 'y'.repeat(300) }],
      balao: 1,
      totalBaloes: 2,
      motivoTransferencia: 'cliente pediu pessoa'
    };
    const criar = async (autorTipo, metadados, dias) => {
      const id = await repo.registrarMensagem(tenantId, conversationId, { direcao: autorTipo === 'lead' ? 'entrada' : 'saida', autorTipo, tipo: 'texto', conteudo: 'x', metadados });
      await db.update(s.messages).set({ createdAt: new Date(Date.now() - dias * 24 * 3_600_000) }).where(eq(s.messages.id, id));
      return id;
    };
    const velha = await criar('ia', rastro, 100);
    const nova = await criar('ia', rastro, 10);
    const doCliente = await criar('lead', { canal: 'whatsapp', consultas: ['nao e da IA'] }, 100);
    const doAtendente = await criar('humano', { legenda: 'foto', consultas: ['nao e da IA'] }, 100);

    const ler = async (id) => (await db.select().from(s.messages).where(eq(s.messages.id, id)))[0].metadados;
    const antes = JSON.stringify(await ler(velha)).length;

    const r = await compactarRastrosAntigos();
    assert.ok(r.compactadas >= 1);

    assert.deepEqual(await ler(velha), {
      rastroCompactado: true,
      modo: 'hibrido',
      provedor: 'gemini',
      modelo: 'models/gemini-2.5-flash',
      voltas: 2,
      balao: 1,
      totalBaloes: 2,
      motivoTransferencia: 'cliente pediu pessoa',
      ferramentas: ['consultar_horarios']
    });
    assert.deepEqual(await ler(nova), rastro, '10 dias: intacto');
    assert.ok((await ler(doCliente)).consultas, 'mensagem de cliente nao e tocada');
    assert.ok((await ler(doAtendente)).legenda, 'mensagem de atendente nao e tocada');

    const depois = JSON.stringify(await ler(velha)).length;
    t.diagnostic(`rastro de 100 dias: antes ${antes} bytes, depois ${depois} bytes`);
    assert.equal((await compactarRastrosAntigos()).compactadas, 0, 'rodar de novo nao faz nada');
  });
});
