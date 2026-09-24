import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { somarDias, dataNoFuso } from '../src/core/datetime.js';

/**
 * Historico de atendimentos encerrados e as metricas da ficha do profissional.
 *
 * O historico e a base do futuro painel: o que importa guardar aqui e que ele
 * e gravado no encerramento, uma vez so, com os valores daquele momento.
 */

let app;
let cab;
let tenantId;
const ctx = {};

const JORNADA = {
  dias: Object.fromEntries(['0', '1', '2', '3', '4', '5', '6'].map((d) => [d, [{ inicio: '08:00', fim: '20:00' }]])),
  intervaloMinutos: 30
};

async function agendar(leadId, data, hora) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agenda',
    headers: cab,
    payload: { leadId, serviceId: ctx.servico.id, professionalId: ctx.prof.id, data, hora }
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().agendamento.id;
}

async function status(id, novo, extra = {}) {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/agenda/${id}/status`,
    headers: cab,
    payload: { status: novo, ...extra }
  });
  assert.equal(res.statusCode, 200, res.body);
}

const metricas = async (dias = 0) =>
  (
    await app.inject({ method: 'GET', url: `/api/profissionais/${ctx.prof.id}/metricas?dias=${dias}`, headers: cab })
  ).json().metricas;

before(async () => {
  ({ app } = await criarAppDeTeste());
  const l = await entrar(app);
  cab = l.cabecalho;
  tenantId = l.usuario.tenantId;

  const { servicos } = (await app.inject({ method: 'GET', url: '/api/servicos', headers: cab })).json();
  ctx.servico = servicos.find((s) => s.nome === 'Corte Social');

  const criado = await app.inject({
    method: 'POST',
    url: '/api/profissionais',
    headers: cab,
    payload: {
      nome: 'Profissional Historico',
      jornada: JORNADA,
      servicos: [{ serviceId: ctx.servico.id, precoCentavos: 5000 }]
    }
  });
  assert.equal(criado.statusCode, 201, criado.body);
  ctx.prof = criado.json().profissional;

  const leads = await import('../src/modules/leads/leads.service.js');
  ctx.ana = await leads.encontrarOuCriarPorTelefone(tenantId, '5511944440001', 'Ana Historico');
  ctx.bruno = await leads.encontrarOuCriarPorTelefone(tenantId, '5511944440002', 'Bruno Historico');
});

after(async () => {
  await app?.close();
});

describe('historico de atendimentos', () => {
  it('grava concluido, falta e cancelamento com a foto do momento', async () => {
    const dia = somarDias(dataNoFuso(Date.now()), 3);

    const a1 = await agendar(ctx.ana.id, dia, '09:00');
    const a2 = await agendar(ctx.ana.id, dia, '10:00');
    const b1 = await agendar(ctx.bruno.id, dia, '11:00');
    const b2 = await agendar(ctx.bruno.id, dia, '14:00');

    await status(a1, 'confirmado');
    await status(a1, 'concluido');
    await status(a2, 'confirmado');
    await status(a2, 'concluido');
    await status(b1, 'faltou');
    await status(b2, 'cancelado', { motivo: 'viajou' });

    const { db } = await import('../src/db/client.js');
    const { serviceHistory } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const linhas = await db.select().from(serviceHistory).where(eq(serviceHistory.professionalId, ctx.prof.id));

    assert.equal(linhas.length, 4);
    const primeira = linhas.find((l) => l.appointmentId === a1);
    assert.equal(primeira.resultado, 'concluido');
    assert.equal(primeira.valorCentavos, 5000, 'preco proprio do profissional');
    assert.equal(primeira.precoTabelaCentavos, ctx.servico.precoCentavos);
    assert.equal(primeira.serviceNome, 'Corte Social');
    assert.equal(primeira.professionalNome, 'Profissional Historico');
    assert.equal(primeira.dataLocal, dia);
    assert.equal(primeira.horaLocal, 9);
    assert.equal(primeira.clienteNovo, true);
    assert.equal(linhas.find((l) => l.appointmentId === a2).clienteNovo, false, 'segunda visita da Ana');

    const cancelado = linhas.find((l) => l.appointmentId === b2);
    assert.equal(cancelado.valorCentavos, 0);
    assert.equal(cancelado.motivoCancelamento, 'viajou');
  });

  it('nao duplica: registrar de novo o mesmo agendamento nao grava outra linha', async () => {
    const { registrarDesfecho, sincronizarHistorico } = await import('../src/modules/historico/historico.service.js');
    const { db } = await import('../src/db/client.js');
    const { serviceHistory } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');

    const [uma] = await db.select().from(serviceHistory).where(eq(serviceHistory.professionalId, ctx.prof.id)).limit(1);
    assert.equal(await registrarDesfecho(tenantId, uma.appointmentId), false);
    await sincronizarHistorico();

    const linhas = await db.select().from(serviceHistory).where(eq(serviceHistory.professionalId, ctx.prof.id));
    assert.equal(linhas.length, 4);
  });

  it('as metricas da ficha saem do historico', async () => {
    const m = await metricas(0);
    assert.equal(m.atendimentos, 2);
    assert.equal(m.faturamentoCentavos, 10000);
    assert.equal(m.ticketMedioCentavos, 5000);
    assert.equal(m.clientes, 1);
    assert.equal(m.clientesNovos, 1);
    assert.equal(m.faltas, 1);
    assert.equal(m.cancelados, 1);
    assert.equal(m.taxaFaltaPercentual, 25);
    assert.deepEqual(m.servicoMaisFeito, { nome: 'Corte Social', vezes: 2 });
  });

  it('atendente nao ve as metricas (tem faturamento)', async () => {
    const { cabecalho } = await entrar(app, 'recepcao');
    const res = await app.inject({ method: 'GET', url: `/api/profissionais/${ctx.prof.id}/metricas`, headers: cabecalho });
    assert.equal(res.statusCode, 403);
  });
});
