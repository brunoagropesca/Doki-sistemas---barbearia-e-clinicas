import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { dataNoFuso, somarDias } from '../src/core/datetime.js';

/**
 * Privacidade do atendimento entre atendentes.
 *
 * A regra que estes testes protegem: cada atendente ve o que e dele, e quem
 * acompanha a equipe inteira (por padrao, so o dono) ve tudo. A parte que mais
 * importa NAO e a lista ficar bonita — e o atendente nao conseguir ler nem
 * alterar o atendimento do colega mesmo sabendo o id. Por isso quase todo
 * teste aqui tenta o acesso direto, nao so a listagem.
 */

const FUSO = 'America/Sao_Paulo';

let app;
let dono;
let ana; // atendente
let bruno; // outro atendente
const ctx = {};

function proximaSegunda() {
  let data = dataNoFuso(Date.now(), FUSO);
  for (let i = 0; i < 14; i++) {
    data = somarDias(data, 1);
    const [a, m, d] = data.split('-').map(Number);
    if (new Date(Date.UTC(a, m - 1, d)).getUTCDay() === 1) return data;
  }
  throw new Error('sem segunda-feira');
}
const SEGUNDA = proximaSegunda();

/** Cria um atendente novo e ja entra com ele. */
async function criarUsuario(nome, username, cargo = 'atendente') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/usuarios',
    headers: dono.cabecalho,
    payload: { nome, username, senha: 'trocar@123', cargo }
  });
  assert.equal(res.statusCode, 201, res.body);
  return entrar(app, username, 'trocar@123');
}

/** Abre uma conversa nova, como o gateway faria. */
async function novaConversa() {
  const conv = await import('../src/modules/conversas/conversas.service.js');
  const leads = await import('../src/modules/leads/leads.service.js');

  // Um cliente NOVO a cada conversa: reaproveitar os do seed pegaria uma
  // conversa que outro teste deixou aberta e ja atribuida a alguem.
  const telefone = `551197${String(1000000 + ctx.proximo++).slice(-7)}`;
  const lead = await leads.encontrarOuCriarPorTelefone(ctx.tenantId, telefone, `Cliente Privacidade ${ctx.proximo}`);

  const id = await conv.encontrarOuAbrir(ctx.tenantId, { leadId: lead.id, canal: 'whatsapp' });
  await conv.registrarRecebida(ctx.tenantId, id, { conteudo: 'Oi, queria marcar um horario' });
  return { id, lead };
}

const listar = async (quem, filtro = 'ativas') =>
  (await app.inject({ method: 'GET', url: `/api/conversas?filtro=${filtro}`, headers: quem.cabecalho })).json().itens;

const assumir = (quem, id) =>
  app.inject({ method: 'POST', url: `/api/conversas/${id}/assumir`, headers: quem.cabecalho });

const configurar = (dados) =>
  app.inject({ method: 'PUT', url: '/api/equipe/configuracao', headers: dono.cabecalho, payload: dados });

const presenca = (quem, statusPresenca) =>
  app.inject({ method: 'PATCH', url: '/api/auth/presenca', headers: quem.cabecalho, payload: { statusPresenca } });

before(async () => {
  ({ app } = await criarAppDeTeste());
  dono = await entrar(app);
  ctx.tenantId = dono.usuario.tenantId;
  ctx.proximo = 0;

  ana = await criarUsuario('Ana Atendente', 'ana');
  bruno = await criarUsuario('Bruno Atendente', 'bruno');
});

after(async () => {
  await app?.close();
});

describe('conversas: cada atendente ve o que e dele', () => {
  it('a conversa na fila aparece para todos — e dali que sai o trabalho', async () => {
    const { id } = await novaConversa();
    ctx.daFila = id;

    for (const quem of [ana, bruno, dono]) {
      const vistas = await listar(quem);
      assert.ok(vistas.some((c) => c.id === id), 'conversa sem dono precisa ser visivel a todos');
    }
  });

  it('assumida por Ana, some da lista de Bruno e continua para o dono', async () => {
    const r = await assumir(ana, ctx.daFila);
    assert.equal(r.statusCode, 200, r.body);

    assert.ok((await listar(ana)).some((c) => c.id === ctx.daFila));
    assert.ok(!(await listar(bruno)).some((c) => c.id === ctx.daFila), 'Bruno nao pode ver o atendimento de Ana');
    assert.ok((await listar(dono)).some((c) => c.id === ctx.daFila), 'o dono acompanha a equipe inteira');
  });

  /**
   * O teste que de fato importa: esconder da lista e cosmetico se o acesso
   * direto continuar funcionando.
   */
  it('Bruno nao le a conversa de Ana nem sabendo o id', async () => {
    const detalhe = await app.inject({ method: 'GET', url: `/api/conversas/${ctx.daFila}`, headers: bruno.cabecalho });
    assert.equal(detalhe.statusCode, 404, 'deve responder como se nao existisse');

    const msgs = await app.inject({
      method: 'GET',
      url: `/api/conversas/${ctx.daFila}/mensagens`,
      headers: bruno.cabecalho
    });
    assert.equal(msgs.statusCode, 404);
  });

  it('e nao escreve nela: responder, finalizar, anotar e mover etapa', async () => {
    const tentativas = [
      ['POST', `/api/conversas/${ctx.daFila}/mensagens`, { conteudo: 'oi' }],
      ['POST', `/api/conversas/${ctx.daFila}/finalizar`, {}],
      ['PATCH', `/api/conversas/${ctx.daFila}/anotacoes`, { texto: 'xx' }],
      ['PATCH', `/api/conversas/${ctx.daFila}/etapa`, { etapa: 'orcamento' }],
      ['POST', `/api/conversas/${ctx.daFila}/lida`, {}]
    ];

    for (const [method, url, payload] of tentativas) {
      const r = await app.inject({ method, url, headers: bruno.cabecalho, payload });
      assert.ok(r.statusCode === 404 || r.statusCode === 403, `${method} ${url} devolveu ${r.statusCode}`);
    }
  });

  it('o dono continua podendo agir na conversa de qualquer um', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/conversas/${ctx.daFila}/anotacoes`,
      headers: dono.cabecalho,
      payload: { texto: 'Conferido pelo dono.' }
    });
    assert.equal(r.statusCode, 200, r.body);
  });

  it('as metricas do atendente sao as dele, nao as da empresa', async () => {
    const numeros = async (quem) =>
      (await app.inject({ method: 'GET', url: '/api/conversas/metricas?dias=30', headers: quem.cabecalho })).json();

    const doDono = await numeros(dono);
    const deBruno = await numeros(bruno);

    assert.ok(doDono.total > deBruno.total, 'o dono soma a equipe inteira');
  });
});

describe('transferencia', () => {
  it('Ana passa o atendimento para Bruno e ele troca de mao', async () => {
    const { id } = await novaConversa();
    await assumir(ana, id);

    const destinos = (
      await app.inject({ method: 'GET', url: '/api/conversas/destinos', headers: ana.cabecalho })
    ).json().atendentes;

    assert.ok(destinos.some((d) => d.id === bruno.usuario.id), 'Bruno devia estar entre os destinos');
    assert.ok(!destinos.some((d) => d.id === ana.usuario.id), 'ninguem transfere para si mesmo');

    const r = await app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/transferir`,
      headers: ana.cabecalho,
      payload: { paraUserId: bruno.usuario.id, motivo: 'Cliente do Bruno' }
    });
    assert.equal(r.statusCode, 200, r.body);

    assert.ok((await listar(bruno)).some((c) => c.id === id), 'agora e de Bruno');
    assert.ok(!(await listar(ana)).some((c) => c.id === id), 'e saiu da vista de Ana');

    // Quem transferiu perde o acesso na hora — inclusive por id.
    const depois = await app.inject({ method: 'GET', url: `/api/conversas/${id}`, headers: ana.cabecalho });
    assert.equal(depois.statusCode, 404);
  });
});

describe('agenda: o recorte vale para os horarios', () => {
  const marcar = async (quem, hora) => {
    const { servicos } = (await app.inject({ method: 'GET', url: '/api/servicos', headers: dono.cabecalho })).json();
    const servico = servicos.find((s) => s.profissionais.length > 0);
    const { itens } = (await app.inject({ method: 'GET', url: '/api/leads?limite=3', headers: dono.cabecalho })).json();

    const r = await app.inject({
      method: 'POST',
      url: '/api/agenda',
      headers: quem.cabecalho,
      payload: {
        leadId: itens[0].id,
        serviceId: servico.id,
        professionalId: servico.profissionais[0].id,
        data: SEGUNDA,
        hora
      }
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json().agendamento;
  };

  const agendaDe = async (quem) =>
    (await app.inject({ method: 'GET', url: `/api/agenda?data=${SEGUNDA}`, headers: quem.cabecalho })).json()
      .agendamentos;

  it('quem marcou ve o horario; o colega nao; o dono ve', async () => {
    const os = await marcar(ana, '09:00');
    ctx.osDaAna = os.id;
    ctx.professionalId = os.professionalId;

    assert.ok((await agendaDe(ana)).some((a) => a.id === os.id));
    assert.ok(!(await agendaDe(bruno)).some((a) => a.id === os.id), 'Bruno nao ve o que Ana marcou');
    assert.ok((await agendaDe(dono)).some((a) => a.id === os.id));
  });

  it('Bruno nao abre nem altera a OS de Ana pelo id', async () => {
    const abrir = await app.inject({ method: 'GET', url: `/api/agenda/${ctx.osDaAna}`, headers: bruno.cabecalho });
    assert.equal(abrir.statusCode, 404);

    const mudar = await app.inject({
      method: 'PATCH',
      url: `/api/agenda/${ctx.osDaAna}/status`,
      headers: bruno.cabecalho,
      payload: { status: 'cancelado' }
    });
    assert.equal(mudar.statusCode, 404, 'nao pode cancelar o atendimento do colega');
  });

  /**
   * O barbeiro nao marca nada, mas a agenda do dia e dele. O vinculo do login
   * com o cadastro de profissional e o que faz esse caso funcionar.
   */
  it('o profissional ve os horarios que VAI EXECUTAR, mesmo marcados por outro', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/profissionais/${ctx.professionalId}`,
      headers: dono.cabecalho,
      payload: { userId: bruno.usuario.id }
    });
    assert.equal(r.statusCode, 200, r.body);

    assert.ok(
      (await agendaDe(bruno)).some((a) => a.id === ctx.osDaAna),
      'o horario e executado por Bruno: ele precisa ver'
    );

    // Desfaz, para nao contaminar os testes seguintes.
    await app.inject({
      method: 'PATCH',
      url: `/api/profissionais/${ctx.professionalId}`,
      headers: dono.cabecalho,
      payload: { userId: null }
    });
  });

  it('o faturamento do painel tambem e recortado', async () => {
    const metricas = async (quem) =>
      (await app.inject({ method: 'GET', url: `/api/agenda/metricas?data=${SEGUNDA}`, headers: quem.cabecalho })).json();

    assert.ok((await metricas(dono)).total >= 1);
    assert.equal((await metricas(bruno)).total, 0, 'Bruno nao soma o que nao e dele');
  });

  it('o quadro de atendimentos segue o mesmo recorte', async () => {
    const cartoes = async (quem) => {
      const q = (
        await app.inject({ method: 'GET', url: `/api/quadro?data=${SEGUNDA}`, headers: quem.cabecalho })
      ).json();
      return q.colunas.flatMap((c) => c.cartoes);
    };

    assert.ok((await cartoes(dono)).some((c) => c.agendamentoId === ctx.osDaAna));
    assert.ok(!(await cartoes(bruno)).some((c) => c.agendamentoId === ctx.osDaAna));
  });
});

describe('configuracao da privacidade', () => {
  it('no modo padrao, nem o administrador ve o atendimento dos outros', async () => {
    ctx.admin = await criarUsuario('Gerente Teste', 'gerente', 'admin');

    const { id } = await novaConversa();
    await assumir(ana, id);
    ctx.conversaDaAna = id;

    assert.ok(!(await listar(ctx.admin)).some((c) => c.id === id), 'o padrao e o mais fechado: so o dono');
  });

  it('em "Dono e administradores", o administrador passa a ver', async () => {
    const r = await configurar({ privacidade: 'gerencia' });
    assert.equal(r.statusCode, 200, r.body);

    assert.ok((await listar(ctx.admin)).some((c) => c.id === ctx.conversaDaAna));
    assert.ok(!(await listar(bruno)).some((c) => c.id === ctx.conversaDaAna), 'atendente continua fora');
  });

  it('em "Equipe inteira", todo mundo ve tudo', async () => {
    await configurar({ privacidade: 'aberto' });
    assert.ok((await listar(bruno)).some((c) => c.id === ctx.conversaDaAna));

    await configurar({ privacidade: 'dono' });
    assert.ok(!(await listar(bruno)).some((c) => c.id === ctx.conversaDaAna), 'voltou a fechar');
  });

  it('so o dono muda esta configuracao', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/equipe/configuracao',
      headers: ctx.admin.cabecalho,
      payload: { privacidade: 'aberto' }
    });
    assert.equal(r.statusCode, 403, 'quem e vigiado nao decide a regra da vigilancia');
  });
});

describe('distribuicao', () => {
  it('no modo manual, a conversa espera na fila em vez de cair em alguem', async () => {
    await configurar({ distribuicaoAutomatica: false });
    await presenca(ana, 'online');
    await presenca(bruno, 'online');

    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const { id } = await novaConversa();

    const r = await conversas.distribuir(ctx.tenantId, id);
    assert.equal(r.atribuida, false);
    assert.equal(r.motivo, 'manual');
    assert.equal(r.conversa.status, 'na_fila');
  });

  it('o botao "Distribuir" funciona mesmo no modo manual', async () => {
    const { id } = await novaConversa();
    const r = await app.inject({ method: 'POST', url: `/api/conversas/${id}/distribuir`, headers: dono.cabecalho });

    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().atribuida, true, 'clique explicito vence a configuracao');
  });

  it('no rodizio, a vez circula em vez de cair sempre no mesmo', async () => {
    await configurar({ distribuicaoAutomatica: true, criterioDistribuicao: 'rodizio' });
    const conversas = await import('../src/modules/conversas/conversas.service.js');

    const recebeu = [];
    for (let i = 0; i < 4; i++) {
      const { id } = await novaConversa();
      const r = await conversas.distribuir(ctx.tenantId, id);
      if (r.atribuida) recebeu.push(r.atendente.id);
    }

    assert.ok(recebeu.length >= 2, 'precisa ter distribuido');
    assert.ok(new Set(recebeu).size > 1, 'o rodizio nao pode entregar tudo para a mesma pessoa');
  });

  it('quem esta ausente so recebe quando a empresa permite', async () => {
    await configurar({ criterioDistribuicao: 'menos_carregado', distribuirSomenteOnline: true });

    // Todos do banco, nao so os deste teste: o seed cria outros usuarios, e
    // um deles online faria o teste passar por engano.
    const { db } = await import('../src/db/client.js');
    const { users } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    await db.update(users).set({ statusPresenca: 'ausente' }).where(eq(users.tenantId, ctx.tenantId));

    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const { id } = await novaConversa();
    assert.equal((await conversas.distribuir(ctx.tenantId, id)).atribuida, false, 'todos ausentes: ninguem recebe');

    await configurar({ distribuirSomenteOnline: false });
    const { id: outra } = await novaConversa();
    assert.equal((await conversas.distribuir(ctx.tenantId, outra)).atribuida, true, 'agora ausentes recebem');
  });
});
