import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

/**
 * Presenca = painel aberto.
 *
 * Bug reproduzido: so o botao "Sair" punha a pessoa offline. Quem fechava o
 * navegador continuava "online" e recebia, no dia seguinte, o cliente que
 * pedia uma pessoa. Aqui o prazo e curto (200 ms) para o teste nao esperar
 * os 5 minutos de verdade.
 */

const PRAZO = 200;
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

let app;
let dono;
let presenca;
const ctx = {};

async function criarAtendente(nome, username) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/usuarios',
    headers: dono.cabecalho,
    payload: { nome, username, senha: 'trocar@123', cargo: 'atendente' }
  });
  assert.equal(r.statusCode, 201, r.body);
  return entrar(app, username, 'trocar@123');
}

const escolher = (quem, statusPresenca) =>
  app.inject({ method: 'PATCH', url: '/api/auth/presenca', headers: quem.cabecalho, payload: { statusPresenca } });

async function presencaDe(quem) {
  const { db } = await import('../src/db/client.js');
  const { users } = await import('../src/db/schema/index.js');
  const { eq } = await import('drizzle-orm');
  const [u] = await db.select({ s: users.statusPresenca }).from(users).where(eq(users.id, quem.usuario.id));
  return u.s;
}

before(async () => {
  ({ app } = await criarAppDeTeste());
  dono = await entrar(app);
  ctx.tenantId = dono.usuario.tenantId;
  presenca = await import('../src/modules/equipe/presenca.js');
  ctx.dani = await criarAtendente('Dani Presenca', 'dani.presenca');
});

beforeEach(async () => {
  presenca._zerarPresenca();
  assert.equal((await escolher(ctx.dani, 'online')).statusCode, 200);
});

after(async () => {
  presenca._zerarPresenca();
  await app?.close();
});

describe('presenca acompanha o painel aberto', () => {
  it('com duas abas, fechar uma nao muda nada; fechar a ultima tira da distribuicao', async () => {
    const id = ctx.dani.usuario.id;
    await presenca.painelAberto(ctx.tenantId, id);
    await presenca.painelAberto(ctx.tenantId, id);

    presenca.painelFechado(ctx.tenantId, id, { aposMs: PRAZO });
    await esperar(PRAZO * 2);
    assert.equal(await presencaDe(ctx.dani), 'online', 'ainda ha uma aba aberta');

    presenca.painelFechado(ctx.tenantId, id, { aposMs: PRAZO });
    assert.equal(await presencaDe(ctx.dani), 'online', 'antes do prazo, nada muda (pode ser so um recarregar)');
    await esperar(PRAZO * 2);
    assert.equal(await presencaDe(ctx.dani), 'ausente');
  });

  it('reabrir o painel volta para online', async () => {
    const id = ctx.dani.usuario.id;
    await presenca.painelAberto(ctx.tenantId, id);
    presenca.painelFechado(ctx.tenantId, id, { aposMs: PRAZO });
    await esperar(PRAZO * 2);
    assert.equal(await presencaDe(ctx.dani), 'ausente');

    await presenca.painelAberto(ctx.tenantId, id);
    assert.equal(await presencaDe(ctx.dani), 'online');
  });

  it('reabrir antes do prazo cancela a saida (queda rapida de internet)', async () => {
    const id = ctx.dani.usuario.id;
    await presenca.painelAberto(ctx.tenantId, id);
    presenca.painelFechado(ctx.tenantId, id, { aposMs: PRAZO });
    await presenca.painelAberto(ctx.tenantId, id);
    await esperar(PRAZO * 2);
    assert.equal(await presencaDe(ctx.dani), 'online');
  });

  it('quem escolheu "ausente" na mao continua ausente: o sistema nao decide por ele', async () => {
    const id = ctx.dani.usuario.id;
    assert.equal((await escolher(ctx.dani, 'ausente')).statusCode, 200);

    await presenca.painelAberto(ctx.tenantId, id);
    presenca.painelFechado(ctx.tenantId, id, { aposMs: PRAZO });
    await esperar(PRAZO * 2);
    await presenca.painelAberto(ctx.tenantId, id);

    assert.equal(await presencaDe(ctx.dani), 'ausente', 'nao virou online sozinho');
  });

  it('servidor reiniciado: quem segue online sem painel aberto vira ausente, e volta ao abrir', async () => {
    const id = ctx.dani.usuario.id;
    await presenca.marcarAusentesSemPainel();
    assert.equal(await presencaDe(ctx.dani), 'ausente');

    await presenca.painelAberto(ctx.tenantId, id);
    assert.equal(await presencaDe(ctx.dani), 'online');
  });

  it('ligado de verdade: abrir o /api/eventos (o painel) conta como presenca', async () => {
    await presenca.marcarAusentesSemPainel();
    assert.equal(await presencaDe(ctx.dani), 'ausente');

    const endereco = await app.listen({ port: 0, host: '127.0.0.1' });
    const parar = new AbortController();
    try {
      const r = await fetch(`${endereco}/api/eventos`, { headers: ctx.dani.cabecalho, signal: parar.signal });
      assert.equal(r.status, 200);
      await r.body.getReader().read(); // chegou o "conectado"
      await esperar(50);
      assert.equal(await presencaDe(ctx.dani), 'online', 'a aba aberta devolveu a pessoa para online');
    } finally {
      parar.abort();
    }
  });

  /**
   * O efeito que importa: o cliente que pede uma pessoa nao cai com quem ja
   * foi embora — espera na fila. Quando a atendente volta, ela recebe.
   */
  it('quem fechou o painel nao recebe cliente: a conversa espera na fila', async () => {
    const id = ctx.dani.usuario.id;
    const r = await app.inject({
      method: 'PUT',
      url: '/api/equipe/configuracao',
      headers: dono.cabecalho,
      payload: { distribuicaoAutomatica: true, distribuirSomenteOnline: true }
    });
    assert.equal(r.statusCode, 200, r.body);

    // So a Dani online: se alguem recebe, e ela.
    const { db } = await import('../src/db/client.js');
    const { users } = await import('../src/db/schema/index.js');
    const { and, eq, ne } = await import('drizzle-orm');
    await db.update(users).set({ statusPresenca: 'ausente' }).where(and(eq(users.tenantId, ctx.tenantId), ne(users.id, id)));

    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const leads = await import('../src/modules/leads/leads.service.js');
    const novaConversa = async (n) => {
      const lead = await leads.encontrarOuCriarPorTelefone(ctx.tenantId, `55119640${String(1000 + n)}`, `Cliente Presenca ${n}`);
      const conv = await conversas.encontrarOuAbrir(ctx.tenantId, { leadId: lead.id, canal: 'whatsapp' });
      await conversas.registrarRecebida(ctx.tenantId, conv, { conteudo: 'Quero falar com uma pessoa' });
      return conv;
    };

    // Fechou o navegador e o prazo passou.
    await presenca.painelAberto(ctx.tenantId, id);
    presenca.painelFechado(ctx.tenantId, id, { aposMs: PRAZO });
    await esperar(PRAZO * 2);

    const enquantoFora = await conversas.distribuir(ctx.tenantId, await novaConversa(1));
    assert.equal(enquantoFora.atribuida, false, 'ninguem no plantao: fica na fila');
    assert.equal(enquantoFora.conversa.status, 'na_fila');

    // Voltou: a proxima e dela.
    await presenca.painelAberto(ctx.tenantId, id);
    const depois = await conversas.distribuir(ctx.tenantId, await novaConversa(2));
    assert.equal(depois.atribuida, true);
    assert.equal(depois.atendente.id, id);
  });

  it('quem esta com o painel aberto nao e tocado ao reiniciar', async () => {
    await presenca.painelAberto(ctx.tenantId, ctx.dani.usuario.id);
    await presenca.marcarAusentesSemPainel();
    assert.equal(await presencaDe(ctx.dani), 'online');
  });
});
