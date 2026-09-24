import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { dataNoFuso, somarDias } from '../src/core/datetime.js';

let app;
let cab;
let ctx = {};

/** Uma segunda-feira futura — dia em que os dois profissionais do seed atendem. */
function proximaSegunda() {
  let data = dataNoFuso(Date.now(), 'America/Sao_Paulo');
  for (let i = 0; i < 14; i++) {
    data = somarDias(data, 1);
    const [a, m, d] = data.split('-').map(Number);
    if (new Date(Date.UTC(a, m - 1, d)).getUTCDay() === 1) return data;
  }
  throw new Error('Nao achei uma segunda-feira');
}

const SEGUNDA = proximaSegunda();

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cab } = await entrar(app));

  // Descobre os ids criados pelo seed para montar os cenarios.
  const { db } = await import('../src/db/client.js');
  const { services, professionals, leads } = await import('../src/db/schema/index.js');

  const [svcs, profs, lds] = await Promise.all([
    db.select().from(services),
    db.select().from(professionals),
    db.select().from(leads)
  ]);

  ctx.carlos = profs.find((p) => p.nome.startsWith('Carlos'));
  ctx.julia = profs.find((p) => p.nome.startsWith('Julia'));
  ctx.corteSocial = svcs.find((s) => s.nome === 'Corte Social'); // 30 min
  ctx.corteBarba = svcs.find((s) => s.nome === 'Corte + Barba'); // 70 min, 10 de folga
  ctx.lead = lds[0];
  ctx.lead2 = lds[1];
});

after(async () => {
  await app?.close();
});

describe('horarios livres', () => {
  it('devolve os horarios do dia com preco e duracao', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agenda/horarios-livres?data=${SEGUNDA}&professionalId=${ctx.carlos.id}&serviceId=${ctx.corteSocial.id}`,
      headers: cab
    });

    assert.equal(res.statusCode, 200);
    const corpo = res.json();
    assert.equal(corpo.duracaoMinutos, 30);
    assert.equal(corpo.precoCentavos, 4500);
    assert.ok(corpo.horarios.length > 0);
    assert.equal(corpo.horarios[0].hora, '09:00');
  });

  /**
   * Julia so trabalha de terca a sabado. O sistema antigo ofereceria os
   * mesmos horarios fixos para ela na segunda.
   */
  it('nao oferece horario em dia que o profissional nao trabalha', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agenda/horarios-livres?data=${SEGUNDA}&professionalId=${ctx.julia.id}&serviceId=${ctx.corteSocial.id}`,
      headers: cab
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().horarios.length, 0);
  });

  it('recusa profissional que nao executa o servico', async () => {
    // Julia nao faz "Corte + Barba" (categoria Combo).
    const res = await app.inject({
      method: 'GET',
      url: `/api/agenda/horarios-livres?data=${SEGUNDA}&professionalId=${ctx.julia.id}&serviceId=${ctx.corteBarba.id}`,
      headers: cab
    });

    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /nao executa/i);
  });

  it('usa o preco proprio do profissional quando existe', async () => {
    const degrade = (await import('../src/db/client.js')).db;
    const { services } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const [svc] = await degrade.select().from(services).where(eq(services.nome, 'Corte Degrade'));

    // Carlos cobra o padrao (5500); Julia tem preco proprio (6500).
    const terca = somarDias(SEGUNDA, 1);

    const comCarlos = await app.inject({
      method: 'GET',
      url: `/api/agenda/horarios-livres?data=${terca}&professionalId=${ctx.carlos.id}&serviceId=${svc.id}`,
      headers: cab
    });
    const comJulia = await app.inject({
      method: 'GET',
      url: `/api/agenda/horarios-livres?data=${terca}&professionalId=${ctx.julia.id}&serviceId=${svc.id}`,
      headers: cab
    });

    assert.equal(comCarlos.json().precoCentavos, 5500);
    assert.equal(comJulia.json().precoCentavos, 6500);
  });
});

describe('criar agendamento', () => {
  it('cria e congela o preco do servico', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agenda',
      headers: cab,
      payload: {
        leadId: ctx.lead.id,
        serviceId: ctx.corteSocial.id,
        professionalId: ctx.carlos.id,
        data: SEGUNDA,
        hora: '09:00'
      }
    });

    assert.equal(res.statusCode, 201);
    const ag = res.json().agendamento;

    assert.equal(ag.status, 'confirmado');
    assert.equal(ag.precoCentavos, 4500);
    assert.equal(ag.horaInicio, '09:00');
    assert.equal(ag.horaFim, '09:30', 'o fim sai da duracao do servico, nao do palpite do usuario');
    assert.equal(ag.data, SEGUNDA);

    ctx.agendamentoId = ag.id;
  });

  /**
   * A corrida de marcacao: a tela de dois atendentes mostra 09:00 livre,
   * os dois clicam. O segundo precisa receber conflito, nao um agendamento
   * fantasma por cima do primeiro.
   */
  it('recusa marcar por cima de um horario ja ocupado', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agenda',
      headers: cab,
      payload: {
        leadId: ctx.lead2.id,
        serviceId: ctx.corteSocial.id,
        professionalId: ctx.carlos.id,
        data: SEGUNDA,
        hora: '09:00'
      }
    });

    assert.equal(res.statusCode, 409);
    assert.match(res.json().erro.mensagem, /agendamento/i);
  });

  it('o horario ocupado some da lista de livres', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agenda/horarios-livres?data=${SEGUNDA}&professionalId=${ctx.carlos.id}&serviceId=${ctx.corteSocial.id}`,
      headers: cab
    });

    const horas = res.json().horarios.map((h) => h.hora);
    assert.ok(!horas.includes('09:00'));
    assert.ok(horas.includes('09:30'));
  });

  it('recusa horario fora do expediente', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agenda',
      headers: cab,
      payload: {
        leadId: ctx.lead2.id,
        serviceId: ctx.corteSocial.id,
        professionalId: ctx.carlos.id,
        data: SEGUNDA,
        hora: '22:00'
      }
    });

    assert.equal(res.statusCode, 409);
    assert.match(res.json().erro.mensagem, /expediente/i);
  });

  it('permite encaixe fora do expediente quando pedido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agenda',
      headers: cab,
      payload: {
        leadId: ctx.lead2.id,
        serviceId: ctx.corteSocial.id,
        professionalId: ctx.carlos.id,
        data: SEGUNDA,
        hora: '22:00',
        encaixe: true
      }
    });

    assert.equal(res.statusCode, 201);
  });

  it('recusa agendar no passado', async () => {
    const ontem = somarDias(dataNoFuso(Date.now(), 'America/Sao_Paulo'), -1);

    const res = await app.inject({
      method: 'POST',
      url: '/api/agenda',
      headers: cab,
      payload: {
        leadId: ctx.lead.id,
        serviceId: ctx.corteSocial.id,
        professionalId: ctx.carlos.id,
        data: ontem,
        hora: '10:00'
      }
    });

    assert.equal(res.statusCode, 422);
  });

  it('recusa hora mal formatada', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agenda',
      headers: cab,
      payload: {
        leadId: ctx.lead.id,
        serviceId: ctx.corteSocial.id,
        professionalId: ctx.carlos.id,
        data: SEGUNDA,
        hora: '9h'
      }
    });

    assert.equal(res.statusCode, 400);
  });
});

describe('ciclo de vida do status', () => {
  it('segue o caminho normal ate concluido', async () => {
    const id = ctx.agendamentoId;

    const emAndamento = await app.inject({
      method: 'PATCH',
      url: `/api/agenda/${id}/status`,
      headers: cab,
      payload: { status: 'em_andamento' }
    });
    assert.equal(emAndamento.statusCode, 200);

    const concluido = await app.inject({
      method: 'PATCH',
      url: `/api/agenda/${id}/status`,
      headers: cab,
      payload: { status: 'concluido' }
    });
    assert.equal(concluido.statusCode, 200);
    assert.equal(concluido.json().agendamento.status, 'concluido');
  });

  /**
   * Sem esta trava, um atendimento concluido voltaria para pendente e o
   * faturamento do mes mudaria sozinho.
   */
  it('nao deixa um agendamento concluido voltar atras', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agenda/${ctx.agendamentoId}/status`,
      headers: cab,
      payload: { status: 'pendente' }
    });

    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /nao pode virar/i);
  });

  it('o detalhe da OS traz o contexto do cliente, as vendas e a linha do tempo', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/agenda/${ctx.agendamentoId}`, headers: cab });
    assert.equal(res.statusCode, 200, res.body);
    const a = res.json().agendamento;
    assert.ok(a.duracaoMinutos > 0);
    assert.ok(a.confirmadoEm, 'passou por confirmado');
    assert.ok(a.concluidoEm);
    const c = a.contexto.cliente;
    assert.equal(typeof c.visitas, 'number', 'visitas ANTERIORES (sem contar esta OS)');
    assert.ok(Array.isArray(c.tags));
    assert.ok(Array.isArray(a.contexto.vendas));
  });

  it('nao deixa remarcar um agendamento concluido', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agenda/${ctx.agendamentoId}/remarcar`,
      headers: cab,
      payload: { hora: '15:00' }
    });

    assert.equal(res.statusCode, 422);
  });

  it('cancelar guarda o motivo', async () => {
    const criado = await app.inject({
      method: 'POST',
      url: '/api/agenda',
      headers: cab,
      payload: {
        leadId: ctx.lead.id,
        serviceId: ctx.corteSocial.id,
        professionalId: ctx.carlos.id,
        data: SEGUNDA,
        hora: '11:00'
      }
    });

    const id = criado.json().agendamento.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agenda/${id}/status`,
      headers: cab,
      payload: { status: 'cancelado', motivo: 'Cliente avisou que nao vem' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().agendamento.status, 'cancelado');

    // Cancelado libera o horario de volta.
    const livres = await app.inject({
      method: 'GET',
      url: `/api/agenda/horarios-livres?data=${SEGUNDA}&professionalId=${ctx.carlos.id}&serviceId=${ctx.corteSocial.id}`,
      headers: cab
    });
    assert.ok(livres.json().horarios.map((h) => h.hora).includes('11:00'));
  });
});

describe('remarcar', () => {
  it('move para outro horario livre', async () => {
    const criado = await app.inject({
      method: 'POST',
      url: '/api/agenda',
      headers: cab,
      payload: {
        leadId: ctx.lead2.id,
        serviceId: ctx.corteSocial.id,
        professionalId: ctx.carlos.id,
        data: SEGUNDA,
        hora: '14:00'
      }
    });
    const id = criado.json().agendamento.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agenda/${id}/remarcar`,
      headers: cab,
      payload: { hora: '15:00' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().agendamento.horaInicio, '15:00');
  });

  /**
   * Ao mudar so o profissional, o proprio agendamento nao pode aparecer
   * como conflito consigo mesmo.
   */
  it('nao conflita consigo mesmo ao remarcar', async () => {
    const terca = somarDias(SEGUNDA, 1);

    const criado = await app.inject({
      method: 'POST',
      url: '/api/agenda',
      headers: cab,
      payload: {
        leadId: ctx.lead.id,
        serviceId: ctx.corteSocial.id,
        professionalId: ctx.carlos.id,
        data: terca,
        hora: '16:00'
      }
    });
    const id = criado.json().agendamento.id;

    // Remarca para o MESMO horario, so trocando de profissional.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agenda/${id}/remarcar`,
      headers: cab,
      payload: { professionalId: ctx.julia.id }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().agendamento.profissionalNome, 'Julia Rocha');
  });
});

describe('detalhes e metricas', () => {
  it('recusa desconto maior que o valor do servico', async () => {
    const criado = await app.inject({
      method: 'POST',
      url: '/api/agenda',
      headers: cab,
      payload: {
        leadId: ctx.lead.id,
        serviceId: ctx.corteSocial.id,
        professionalId: ctx.carlos.id,
        data: SEGUNDA,
        hora: '16:30'
      }
    });
    const id = criado.json().agendamento.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/agenda/${id}`,
      headers: cab,
      payload: { descontoCentavos: 99999 }
    });

    assert.equal(res.statusCode, 422);
  });

  it('o faturamento conta so o que foi concluido', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agenda/metricas?data=${SEGUNDA}`,
      headers: cab
    });

    assert.equal(res.statusCode, 200);
    const m = res.json();
    assert.equal(m.concluidos, 1);
    assert.equal(m.faturamentoCentavos, 4500, 'cancelado e pendente nao entram no faturamento');
    assert.ok(m.cancelados >= 1);
  });
});

describe('permissao', () => {
  it('atendente cria agendamento', async () => {
    const { cabecalho } = await entrar(app, 'recepcao');
    const res = await app.inject({
      method: 'POST',
      url: '/api/agenda',
      headers: cabecalho,
      payload: {
        leadId: ctx.lead.id,
        serviceId: ctx.corteSocial.id,
        professionalId: ctx.carlos.id,
        data: SEGUNDA,
        hora: '17:00'
      }
    });
    assert.equal(res.statusCode, 201);
  });

  it('atendente NAO exclui agendamento', async () => {
    const { cabecalho } = await entrar(app, 'recepcao');
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agenda/${ctx.agendamentoId}`,
      headers: cabecalho
    });
    assert.equal(res.statusCode, 403);
  });

  it('sem login nao ve a agenda', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agenda' });
    assert.equal(res.statusCode, 401);
  });
});
