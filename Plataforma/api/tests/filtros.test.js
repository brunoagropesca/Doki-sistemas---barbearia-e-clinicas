import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

/**
 * Os quatro filtros da mesa: Todos, Humano, Fila e Sofia.
 *
 *   TODOS   o que e MEU (com a IA ou com gente). So o dono ve tudo.
 *   HUMANO  atendidos por uma pessoa — so vira humano quando ela ESCREVE.
 *   FILA    o que a IA jogou para um humano. Sem dono: todos veem (para pegar).
 *           Ja atribuida: so o dono da conversa (e o dono da empresa).
 *   SOFIA   atendimento so da IA, sem dono. Todos veem: e a vitrine de onde
 *           um atendente "pesca" um cliente.
 *
 * O teste monta uma mesa com um caso de cada tipo e confere, para cada pessoa,
 * exatamente quais conversas aparecem em cada filtro.
 */

let app;
let dono;
let ana;
let bruno;
const ctx = { c: {} };

async function criarUsuario(nome, username) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/usuarios',
    headers: dono.cabecalho,
    payload: { nome, username, senha: 'trocar@123', cargo: 'atendente' }
  });
  assert.equal(res.statusCode, 201, res.body);
  return entrar(app, username, 'trocar@123');
}

/** Abre uma conversa de um cliente novo e ja a poe no estado pedido. */
async function conversa(rotulo, { status = 'bot', dono: donoDela = null } = {}) {
  const conv = await import('../src/modules/conversas/conversas.service.js');
  const leads = await import('../src/modules/leads/leads.service.js');

  const telefone = `551195${String(1000000 + ctx.n++).slice(-7)}`;
  const lead = await leads.encontrarOuCriarPorTelefone(ctx.tenantId, telefone, `Cliente ${rotulo}`);
  const id = await conv.encontrarOuAbrir(ctx.tenantId, { leadId: lead.id, canal: 'whatsapp' });
  await conv.registrarRecebida(ctx.tenantId, id, { conteudo: 'Oi' });

  await ctx.db
    .update(ctx.s.conversations)
    .set({ status, assignedUserId: donoDela?.usuario.id ?? null })
    .where(eq(ctx.s.conversations.id, id));

  ctx.c[rotulo] = id;
  return id;
}

/** Que rotulos (dos que criamos) aparecem para esta pessoa neste filtro? */
async function ve(quem, filtro) {
  const itens = (
    await app.inject({ method: 'GET', url: `/api/conversas?filtro=${filtro}&limite=100`, headers: quem.cabecalho })
  ).json().itens;

  const ids = new Set(itens.map((c) => c.id));
  return Object.entries(ctx.c)
    .filter(([, id]) => ids.has(id))
    .map(([rotulo]) => rotulo)
    .sort();
}

const conversaDe = async (id) =>
  (await ctx.db.select().from(ctx.s.conversations).where(eq(ctx.s.conversations.id, id)))[0];

before(async () => {
  ({ app } = await criarAppDeTeste());
  dono = await entrar(app);
  ctx.tenantId = dono.usuario.tenantId;
  ctx.n = 0;
  ctx.db = (await import('../src/db/client.js')).db;
  ctx.s = await import('../src/db/schema/index.js');

  ana = await criarUsuario('Ana', 'ana');
  bruno = await criarUsuario('Bruno', 'bruno');

  // Uma mesa com um caso de cada tipo.
  await conversa('sofia-livre', { status: 'bot' }); //           IA, sem dono
  await conversa('sofia-da-ana', { status: 'bot', dono: ana }); // IA, mas ja e dela (ex: a IA marcou horario)
  await conversa('humana-da-ana', { status: 'humana', dono: ana });
  await conversa('humana-do-bruno', { status: 'humana', dono: bruno });
  await conversa('fila-livre', { status: 'na_fila' }); //         esperando alguem pegar
  await conversa('fila-da-ana', { status: 'na_fila', dono: ana }); // atribuida, aguardando a primeira mensagem
});

after(async () => {
  await app?.close();
});

describe('SOFIA — a vitrine da IA', () => {
  it('todos veem o atendimento da IA que ainda nao tem dono', async () => {
    for (const quem of [ana, bruno, dono]) {
      assert.deepEqual(await ve(quem, 'sofia'), ['sofia-livre']);
    }
  });

  it('o que ja tem dono sai da vitrine, mesmo com a Sofia ainda conduzindo', async () => {
    for (const quem of [ana, bruno, dono]) {
      assert.ok(!(await ve(quem, 'sofia')).includes('sofia-da-ana'));
    }
  });
});

describe('FILA — o que a IA jogou para um humano', () => {
  it('sem dono, todos veem (para pegar); atribuida, so quem e dono', async () => {
    assert.deepEqual(await ve(ana, 'fila'), ['fila-da-ana', 'fila-livre']);
    assert.deepEqual(await ve(bruno, 'fila'), ['fila-livre'], 'a fila atribuida a Ana nao aparece para Bruno');
  });

  it('o dono da empresa ve a fila inteira', async () => {
    assert.deepEqual(await ve(dono, 'fila'), ['fila-da-ana', 'fila-livre']);
  });
});

describe('HUMANO — atendidos por uma pessoa', () => {
  it('cada um ve os seus; o dono ve todos', async () => {
    assert.deepEqual(await ve(ana, 'humano'), ['humana-da-ana']);
    assert.deepEqual(await ve(bruno, 'humano'), ['humana-do-bruno']);
    assert.deepEqual(await ve(dono, 'humano'), ['humana-da-ana', 'humana-do-bruno']);
  });
});

describe('TODOS — o que e meu', () => {
  it('o atendente ve so o que e dele, com a IA ou com gente', async () => {
    assert.deepEqual(await ve(ana, 'todos'), ['fila-da-ana', 'humana-da-ana', 'sofia-da-ana']);
    assert.deepEqual(await ve(bruno, 'todos'), ['humana-do-bruno']);
  });

  it('a vitrine e a fila comum NAO entram no "Todos" de um atendente', async () => {
    for (const quem of [ana, bruno]) {
      const vistas = await ve(quem, 'todos');
      assert.ok(!vistas.includes('sofia-livre'));
      assert.ok(!vistas.includes('fila-livre'));
    }
  });

  it('so o dono ve tudo', async () => {
    assert.deepEqual(await ve(dono, 'todos'), [
      'fila-da-ana',
      'fila-livre',
      'humana-da-ana',
      'humana-do-bruno',
      'sofia-da-ana',
      'sofia-livre'
    ]);
  });
});

describe('pescar: assumir da vitrine', () => {
  it('assumir leva a conversa para o meu Todos, mas NAO a torna humana', async () => {
    const id = ctx.c['sofia-livre'];
    const r = await app.inject({ method: 'POST', url: `/api/conversas/${id}/assumir`, headers: bruno.cabecalho });
    assert.equal(r.statusCode, 200, r.body);

    const c = await conversaDe(id);
    assert.equal(c.assignedUserId, bruno.usuario.id);
    assert.equal(c.status, 'bot', 'so vira humana quando ele escrever');

    assert.ok(!(await ve(ana, 'sofia')).includes('sofia-livre'), 'saiu da vitrine');
    assert.ok((await ve(bruno, 'todos')).includes('sofia-livre'), 'entrou no Todos de Bruno');
    assert.ok(!(await ve(bruno, 'humano')).includes('sofia-livre'), 'ainda nao e humana');
  });

  it('escrever a torna humana', async () => {
    const id = ctx.c['sofia-livre'];
    const r = await app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/mensagens`,
      headers: bruno.cabecalho,
      payload: { conteudo: 'Oi! Sou o Bruno, vou cuidar de voce.' }
    });
    assert.equal(r.statusCode, 201, r.body);

    assert.equal((await conversaDe(id)).status, 'humana');
    assert.ok((await ve(bruno, 'humano')).includes('sofia-livre'));
  });

  it('dois atendentes pescando o mesmo cliente: o segundo ouve que ja foi pego', async () => {
    const id = await conversa('disputada', { status: 'bot' });

    const primeiro = await app.inject({ method: 'POST', url: `/api/conversas/${id}/assumir`, headers: ana.cabecalho });
    assert.equal(primeiro.statusCode, 200);

    const segundo = await app.inject({ method: 'POST', url: `/api/conversas/${id}/assumir`, headers: bruno.cabecalho });
    assert.equal(segundo.statusCode, 409);
    assert.match(segundo.json().erro.mensagem, /ja esta atendendo/i);
  });
});

describe('a fila atribuida', () => {
  it('quando o atendente escreve, sai da Fila e vai para Humano', async () => {
    const id = ctx.c['fila-da-ana'];
    assert.ok((await ve(ana, 'fila')).includes('fila-da-ana'));

    const r = await app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/mensagens`,
      headers: ana.cabecalho,
      payload: { conteudo: 'Oi, voce pediu para falar com alguem?' }
    });
    assert.equal(r.statusCode, 201, r.body);

    assert.ok(!(await ve(ana, 'fila')).includes('fila-da-ana'));
    assert.ok((await ve(ana, 'humano')).includes('fila-da-ana'));
  });

  it('a distribuicao respeita o dono que a conversa ja tem', async () => {
    const id = await conversa('fila-com-dono', { status: 'na_fila', dono: ana });
    const conversas = await import('../src/modules/conversas/conversas.service.js');

    const r = await conversas.distribuir(ctx.tenantId, id);
    assert.equal(r.atribuida, true);
    assert.equal(r.motivo, 'ja_tem_dono');
    assert.equal((await conversaDe(id)).assignedUserId, ana.usuario.id, 'nao troca de atendente no meio');
  });

  it('a distribuicao atribui mas NAO torna humana', async () => {
    await ctx.db.update(ctx.s.users).set({ statusPresenca: 'offline' }).where(eq(ctx.s.users.tenantId, ctx.tenantId));
    await app.inject({ method: 'PATCH', url: '/api/auth/presenca', headers: bruno.cabecalho, payload: { statusPresenca: 'online' } });

    const id = await conversa('fila-a-distribuir', { status: 'na_fila' });
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const r = await conversas.distribuir(ctx.tenantId, id);

    assert.equal(r.atribuida, true);
    assert.equal(r.atendente.id, bruno.usuario.id);
    assert.equal((await conversaDe(id)).status, 'na_fila', 'aguarda a primeira mensagem dele; a IA segue calada');
  });
});

describe('transferir mantem o tipo de atendimento', () => {
  const transferir = (quem, id, para) =>
    app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/transferir`,
      headers: quem.cabecalho,
      payload: { paraUserId: para.usuario.id }
    });

  it('uma conversa humana continua humana com quem recebeu', async () => {
    const id = ctx.c['humana-da-ana'];
    assert.equal((await transferir(ana, id, bruno)).statusCode, 200);

    const c = await conversaDe(id);
    assert.equal(c.assignedUserId, bruno.usuario.id);
    assert.equal(c.status, 'humana');
  });

  it('uma conversa da Sofia continua com a Sofia', async () => {
    const id = ctx.c['sofia-da-ana'];
    assert.equal((await transferir(ana, id, bruno)).statusCode, 200);

    const c = await conversaDe(id);
    assert.equal(c.assignedUserId, bruno.usuario.id);
    assert.equal(c.status, 'bot', 'transferir troca DE QUEM e, nao de que tipo de atendimento e');
  });
});

describe('validacao', () => {
  it('recusa um filtro que nao existe', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/conversas?filtro=qualquer', headers: ana.cabecalho });
    assert.equal(r.statusCode, 400);
  });
});
