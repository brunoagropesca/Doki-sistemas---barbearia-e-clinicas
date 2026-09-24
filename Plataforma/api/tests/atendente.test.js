import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { dataNoFuso, somarDias } from '../src/core/datetime.js';

/**
 * A vida de um atendente no livechat: quem e responsavel por quem.
 *
 * O caso central deste arquivo: a IA fecha um horario com um cliente. Ate ali a
 * conversa era de ninguem (a Sofia atendia), e portanto visivel a todos. Se
 * nada acontecesse no momento da marcacao, o cliente que acabou de confirmar
 * ficaria exposto a equipe inteira — ou sem ninguem cuidando dele ate o dia do
 * servico. Estes testes garantem que a marcacao da IA sempre tem um dono, que a
 * Sofia segue conversando, e que so o dono (e o dono da empresa) enxerga.
 */

const FUSO = 'America/Sao_Paulo';

let app;
let dono;
let ana;
let bruno;
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

/** PNG de 1x1, em data URL. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const USUARIO_ATENA = { nome: 'Atena (IA)' };

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

const presenca = (quem, statusPresenca) =>
  app.inject({ method: 'PATCH', url: '/api/auth/presenca', headers: quem.cabecalho, payload: { statusPresenca } });

async function novaConversa() {
  const conv = await import('../src/modules/conversas/conversas.service.js');
  const leads = await import('../src/modules/leads/leads.service.js');

  // Um cliente NOVO a cada conversa: reaproveitar um do seed pegaria a conversa
  // que outro teste deixou aberta (e atribuida a outro atendente).
  const telefone = `551198${String(1000000 + ctx.proximo++).slice(-7)}`;
  const lead = await leads.encontrarOuCriarPorTelefone(ctx.tenantId, telefone, `Cliente Teste ${ctx.proximo}`);

  const id = await conv.encontrarOuAbrir(ctx.tenantId, { leadId: lead.id, canal: 'whatsapp' });
  await conv.registrarRecebida(ctx.tenantId, id, { conteudo: 'Oi, quero marcar um corte' });
  return { id, lead };
}

/** A IA marca um horario, exatamente como a ferramenta da Atena faz. */
async function iaMarca({ conversationId, leadId, hora, professionalId }) {
  const agenda = await import('../src/modules/agenda/agenda.service.js');
  return agenda.criar(
    ctx.tenantId,
    {
      leadId,
      serviceId: ctx.servico.id,
      professionalId: professionalId ?? ctx.profissional.id,
      data: SEGUNDA,
      hora,
      status: 'confirmado',
      conversationId
    },
    { origem: 'ia', usuario: USUARIO_ATENA }
  );
}

const conversaDe = async (id) =>
  (await ctx.db.select().from(ctx.s.conversations).where(eq(ctx.s.conversations.id, id)))[0];

const listar = async (quem, query = 'filtro=ativas') =>
  (await app.inject({ method: 'GET', url: `/api/conversas?${query}`, headers: quem.cabecalho })).json().itens;

before(async () => {
  ({ app } = await criarAppDeTeste());
  dono = await entrar(app);
  ctx.tenantId = dono.usuario.tenantId;
  ctx.proximo = 0;

  ctx.db = (await import('../src/db/client.js')).db;
  ctx.s = await import('../src/db/schema/index.js');

  ana = await criarUsuario('Ana Atendente', 'ana');
  bruno = await criarUsuario('Bruno Atendente', 'bruno');
  // O seed ja traz outros usuarios (a recepcao...) e alguns podem estar online:
  // os testes so falam de Ana e Bruno, entao os demais ficam fora da roda.
  await ctx.db.update(ctx.s.users).set({ statusPresenca: 'offline' }).where(eq(ctx.s.users.tenantId, ctx.tenantId));
  await presenca(ana, 'online');
  await presenca(bruno, 'online');

  const { servicos } = (await app.inject({ method: 'GET', url: '/api/servicos', headers: dono.cabecalho })).json();
  ctx.servico = servicos.find((s) => s.profissionais.length > 0);
  ctx.profissional = ctx.servico.profissionais[0];
});

after(async () => {
  await app?.close();
});

describe('a IA marca um horario: a conversa ganha dono, a Sofia continua', () => {
  it('atribui a um atendente sem tirar a conversa da IA', async () => {
    const { id, lead } = await novaConversa();
    const os = await iaMarca({ conversationId: id, leadId: lead.id, hora: '09:00' });

    const conversa = await conversaDe(id);
    assert.ok(conversa.assignedUserId, 'a conversa precisa ter um dono depois que a IA marcou');
    assert.ok(
      [ana.usuario.id, bruno.usuario.id].includes(conversa.assignedUserId),
      'o dono sai da equipe de atendentes'
    );
    assert.equal(conversa.status, 'bot', 'a Sofia continua conduzindo: so ganhou um dono');
    assert.equal(os.responsavelUserId, conversa.assignedUserId, 'o horario e do mesmo atendente');

    ctx.dono1 = conversa.assignedUserId === ana.usuario.id ? ana : bruno;
    ctx.outro1 = conversa.assignedUserId === ana.usuario.id ? bruno : ana;
    ctx.conversa1 = id;
    ctx.os1 = os.id;
  });

  it('o responsavel ve a conversa e o horario; o outro atendente nao ve nenhum dos dois', async () => {
    assert.ok((await listar(ctx.dono1)).some((c) => c.id === ctx.conversa1));
    assert.ok(!(await listar(ctx.outro1)).some((c) => c.id === ctx.conversa1), 'a privacidade vale mesmo com a Sofia ativa');

    const direto = await app.inject({ method: 'GET', url: `/api/conversas/${ctx.conversa1}`, headers: ctx.outro1.cabecalho });
    assert.equal(direto.statusCode, 404);

    const os = await app.inject({ method: 'GET', url: `/api/agenda/${ctx.os1}`, headers: ctx.outro1.cabecalho });
    assert.equal(os.statusCode, 404);

    assert.ok((await listar(dono)).some((c) => c.id === ctx.conversa1), 'o dono ve tudo');
  });

  it('uma conversa que ja tem dono nao muda de dono quando a IA marca outro horario', async () => {
    const { id, lead } = await novaConversa();
    const primeiro = await iaMarca({ conversationId: id, leadId: lead.id, hora: '10:00' });
    const segundo = await iaMarca({ conversationId: id, leadId: lead.id, hora: '11:00' });

    assert.equal(segundo.responsavelUserId, primeiro.responsavelUserId);
    assert.equal((await conversaDe(id)).assignedUserId, primeiro.responsavelUserId);
  });

  it('marcacao recusada NAO deixa a conversa atribuida', async () => {
    const { id, lead } = await novaConversa();

    // 09:00 ja esta ocupado (primeiro teste deste bloco).
    await assert.rejects(iaMarca({ conversationId: id, leadId: lead.id, hora: '09:00' }), /ocupad|conflit|hor/i);

    assert.equal((await conversaDe(id)).assignedUserId, null, 'sem horario, sem dono: continua na fila comum');
  });

  it('sem ninguem online, ainda assim escolhe alguem — de preferencia um atendente', async () => {
    await presenca(ana, 'offline');
    await presenca(bruno, 'offline');
    await ctx.db.update(ctx.s.users).set({ statusPresenca: 'offline' }).where(eq(ctx.s.users.tenantId, ctx.tenantId));

    const { id, lead } = await novaConversa();
    const os = await iaMarca({ conversationId: id, leadId: lead.id, hora: '14:00' });

    assert.ok(os.responsavelUserId, 'um horario fechado nunca fica sem responsavel');
    assert.notEqual(os.responsavelUserId, dono.usuario.id, 'o dono da empresa nao herda o atendimento se ha atendentes');

    await presenca(ana, 'online');
    await presenca(bruno, 'online');
  });

  it('um atendente que marca a mao fica com o proprio horario', async () => {
    const { itens } = (await app.inject({ method: 'GET', url: '/api/leads?limite=3', headers: dono.cabecalho })).json();
    const r = await app.inject({
      method: 'POST',
      url: '/api/agenda',
      headers: ana.cabecalho,
      payload: {
        leadId: itens[0].id,
        serviceId: ctx.servico.id,
        professionalId: ctx.profissional.id,
        data: SEGUNDA,
        hora: '15:00'
      }
    });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().agendamento.responsavelUserId, ana.usuario.id);
  });
});

describe('agendamentos do atendente', () => {
  const meus = async (quem, query = '') =>
    (await app.inject({ method: 'GET', url: `/api/agenda/atendente${query}`, headers: quem.cabecalho })).json().agendamentos;

  it('lista o que e dele, com a conversa para falar com o cliente', async () => {
    const lista = await meus(ctx.dono1);
    const item = lista.find((a) => a.id === ctx.os1);

    assert.ok(item, 'o horario marcado pela IA aparece para o responsavel');
    assert.equal(item.conversaId, ctx.conversa1, 'aponta para a conversa do cliente');
    assert.equal(item.criadoPor, 'ia');
  });

  it('nao mostra o horario dos colegas', async () => {
    assert.ok(!(await meus(ctx.outro1)).some((a) => a.id === ctx.os1));
  });

  it('um atendente que pede a lista de outro recebe a propria', async () => {
    const lista = await meus(ctx.outro1, `?atendenteId=${ctx.dono1.usuario.id}`);
    assert.ok(!lista.some((a) => a.id === ctx.os1), 'nao pode espiar a lista do colega pelo parametro');
  });

  it('o dono da empresa consulta a lista de qualquer atendente', async () => {
    const lista = await meus(dono, `?atendenteId=${ctx.dono1.usuario.id}`);
    assert.ok(lista.some((a) => a.id === ctx.os1));
  });

  it('so mostra o que ainda vai acontecer', async () => {
    const os = await ctx.db.select().from(ctx.s.appointments).where(eq(ctx.s.appointments.id, ctx.os1));
    await ctx.db.update(ctx.s.appointments).set({ status: 'concluido' }).where(eq(ctx.s.appointments.id, ctx.os1));

    assert.ok(!(await meus(ctx.dono1)).some((a) => a.id === ctx.os1), 'concluido ja aconteceu');

    await ctx.db.update(ctx.s.appointments).set({ status: os[0].status }).where(eq(ctx.s.appointments.id, ctx.os1));
  });

  it('a transferencia leva o horario junto', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/conversas/${ctx.conversa1}/transferir`,
      headers: ctx.dono1.cabecalho,
      payload: { paraUserId: ctx.outro1.usuario.id, motivo: 'Cliente dele' }
    });
    assert.equal(r.statusCode, 200, r.body);

    assert.ok((await meus(ctx.outro1)).some((a) => a.id === ctx.os1), 'agora o horario e de quem herdou');
    assert.ok(!(await meus(ctx.dono1)).some((a) => a.id === ctx.os1), 'e saiu de quem passou');
  });
});

describe('devolver para a IA', () => {
  it('com horario por acontecer, o cliente continua sendo do atendente', async () => {
    const { id, lead } = await novaConversa();
    const os = await iaMarca({ conversationId: id, leadId: lead.id, hora: '16:00' });
    const responsavel = os.responsavelUserId;
    const quem = responsavel === ana.usuario.id ? ana : bruno;

    const r = await app.inject({ method: 'POST', url: `/api/conversas/${id}/devolver`, headers: quem.cabecalho });
    assert.equal(r.statusCode, 200, r.body);

    const conversa = await conversaDe(id);
    assert.equal(conversa.status, 'bot');
    assert.equal(conversa.assignedUserId, responsavel, 'ha horario marcado: continua sendo dele');
  });

  it('sem horario, solta a conversa como sempre', async () => {
    const { id } = await novaConversa();
    await app.inject({ method: 'POST', url: `/api/conversas/${id}/assumir`, headers: ana.cabecalho });
    await app.inject({ method: 'POST', url: `/api/conversas/${id}/devolver`, headers: ana.cabecalho });

    assert.equal((await conversaDe(id)).assignedUserId, null);
  });
});

describe('atendimentos finalizados por dia e por atendente', () => {
  const hoje = () => dataNoFuso(Date.now(), FUSO);
  const finalizar = (quem, id) =>
    app.inject({ method: 'POST', url: `/api/conversas/${id}/finalizar`, headers: quem.cabecalho, payload: { resumo: 'Concluido.' } });

  before(async () => {
    const { id } = await novaConversa();
    ctx.deAna = id;
    await app.inject({ method: 'POST', url: `/api/conversas/${id}/assumir`, headers: ana.cabecalho });
    await finalizar(ana, id);

    const { id: outra } = await novaConversa();
    ctx.deBruno = outra;
    await app.inject({ method: 'POST', url: `/api/conversas/${outra}/assumir`, headers: bruno.cabecalho });
    await finalizar(bruno, outra);
  });

  it('por padrao (hoje), traz so as finalizadas daquele atendente', async () => {
    const lista = await listar(ana, `filtro=finalizadas&dia=${hoje()}&atendenteId=${ana.usuario.id}`);

    assert.ok(lista.some((c) => c.id === ctx.deAna));
    assert.ok(!lista.some((c) => c.id === ctx.deBruno), 'as do colega nao entram');
  });

  it('outro dia nao traz nada de hoje', async () => {
    const ontem = somarDias(hoje(), -1);
    const lista = await listar(ana, `filtro=finalizadas&dia=${ontem}&atendenteId=${ana.usuario.id}`);
    assert.ok(!lista.some((c) => c.id === ctx.deAna));
  });

  it('atendente que pede as finalizadas de outro recebe as proprias', async () => {
    const lista = await listar(bruno, `filtro=finalizadas&dia=${hoje()}&atendenteId=${ana.usuario.id}`);

    assert.ok(!lista.some((c) => c.id === ctx.deAna), 'nao le o historico do colega');
    assert.ok(lista.some((c) => c.id === ctx.deBruno));
  });

  it('o dono consulta o dia de qualquer atendente', async () => {
    const lista = await listar(dono, `filtro=finalizadas&dia=${hoje()}&atendenteId=${ana.usuario.id}`);
    assert.ok(lista.some((c) => c.id === ctx.deAna));
    assert.ok(!lista.some((c) => c.id === ctx.deBruno));
  });

  it('recusa data em formato invalido', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/conversas?filtro=finalizadas&dia=ontem', headers: ana.cabecalho });
    assert.equal(r.statusCode, 400, 'formato invalido e erro de validacao');
  });
});

describe('presenca ao sair', () => {
  const presencaDe = async (userId) =>
    (await ctx.db.select().from(ctx.s.users).where(eq(ctx.s.users.id, userId)))[0].statusPresenca;

  it('quem sai do sistema fica offline', async () => {
    const carlos = await criarUsuario('Carlos Saida', 'carlos');
    await presenca(carlos, 'online');
    assert.equal(await presencaDe(carlos.usuario.id), 'online');

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: carlos.cabecalho });
    assert.equal(await presencaDe(carlos.usuario.id), 'offline');
  });

  it('mas continua online se tem outra sessao aberta', async () => {
    const dani = await criarUsuario('Dani Duas Sessoes', 'dani');
    const segunda = await entrar(app, 'dani', 'trocar@123');
    await presenca(dani, 'online');

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: dani.cabecalho });
    assert.equal(await presencaDe(dani.usuario.id), 'online', 'o celular dela ainda esta aberto');

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: segunda.cabecalho });
    assert.equal(await presencaDe(dani.usuario.id), 'offline');
  });
});

describe('foto do perfil', () => {
  it('a pessoa troca a propria foto e o arquivo fica acessivel', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/auth/foto', headers: ana.cabecalho, payload: { foto: PNG } });
    assert.equal(r.statusCode, 200, r.body);

    const url = r.json().usuario.avatar;
    assert.match(url, /^\/api\/arquivos\/perfil-/);
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 200);

    ctx.fotoAntiga = url;
  });

  it('trocar apaga a antiga do disco', async () => {
    await app.inject({ method: 'PUT', url: '/api/auth/foto', headers: ana.cabecalho, payload: { foto: PNG } });
    assert.equal((await app.inject({ method: 'GET', url: ctx.fotoAntiga })).statusCode, 404, 'a antiga nao fica acumulando');
  });

  it('remover volta para a inicial do nome', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/auth/foto', headers: ana.cabecalho, payload: { remover: true } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().usuario.avatar, null);
  });

  it('recusa arquivo que nao e imagem', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/auth/foto',
      headers: ana.cabecalho,
      payload: { foto: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' }
    });
    assert.equal(r.statusCode, 422);
  });

  it('exige login', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/auth/foto', payload: { foto: PNG } });
    assert.equal(r.statusCode, 401);
  });
});
