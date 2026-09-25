import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { enviarLembretesSeForHora } from '../src/automacao/rotinas.js';
import { dataNoFuso, somarDias } from '../src/core/datetime.js';

/**
 * Lembrete de vespera: o que mais reduz falta numa barbearia.
 *
 * O canal e um `enviar` de mentira (a rotina o recebe por injecao, como as
 * campanhas): anota o que "saiu" ou falha quando o teste manda. O relogio e
 * o `agora` passado a rotina — os horarios sao marcados para o dia seguinte a
 * esse "agora", entao o teste nao depende da hora em que a suite roda.
 */

const FUSO = 'America/Sao_Paulo';
let app;
let cab;
let tenantId;
let db;
let s;
const saidas = [];
let canalFalha = false;
const enviar = async (dados) => {
  if (canalFalha) throw new Error('WhatsApp desconectado');
  saidas.push(dados);
  return { idExterno: `lemb_${saidas.length}` };
};

const hoje = () => dataNoFuso(Date.now(), FUSO);
const as = (hora) => new Date(`${hoje()}T${hora}:00-03:00`).getTime();
const amanhaAs = (hora) => new Date(`${somarDias(hoje(), 1)}T${hora}:00-03:00`);
const ctx = {};

/** OS de amanha, direto no banco (a agenda real ja tem testes proprios). */
async function osAmanha({ lead, hora, servico = ctx.servico, status = 'confirmado' }) {
  const id = `apt_lemb_${Math.random().toString(36).slice(2)}`;
  const inicio = amanhaAs(hora);
  await db.insert(s.appointments).values({
    id, tenantId, leadId: lead.id, serviceId: servico.id, professionalId: ctx.prof.id,
    inicioEm: inicio, fimEm: new Date(inicio.getTime() + 30 * 60_000), status, precoCentavos: 4500
  });
  return id;
}

const lembreteDe = async (id) => (await db.select().from(s.appointments).where(eq(s.appointments.id, id)))[0].lembreteEnviadoEm;
const configurar = (dados) => app.inject({ method: 'PUT', url: '/api/atendimento/configuracao', headers: cab, payload: dados });

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cab } = await entrar(app));
  ({ db } = await import('../src/db/client.js'));
  s = await import('../src/db/schema/index.js');
  [{ id: tenantId }] = await db.select().from(s.tenants);
  [ctx.prof] = await db.select().from(s.professionals);
  [ctx.servico, ctx.outro] = await db.select().from(s.services);

  // Clientes proprios deste arquivo.
  const leads = await import('../src/modules/leads/leads.service.js');
  ctx.ana = await leads.criar(tenantId, { nome: 'Ana Lembrete', telefone: '5511955530001' });
  ctx.bruno = await leads.criar(tenantId, { nome: 'Bruno Lembrete', telefone: '5511955530002' });
  ctx.caio = await leads.criar(tenantId, { nome: 'Caio Cancelou', telefone: '5511955530003' });

  ctx.osAna1 = await osAmanha({ lead: ctx.ana, hora: '10:00' });
  ctx.osAna2 = await osAmanha({ lead: ctx.ana, hora: '10:30', servico: ctx.outro });
  ctx.osBruno = await osAmanha({ lead: ctx.bruno, hora: '15:00', status: 'pendente' });
  ctx.osCaio = await osAmanha({ lead: ctx.caio, hora: '11:00', status: 'cancelado' });
});

after(async () => {
  await app?.close();
});

describe('lembrete de vespera', () => {
  it('desligado por padrao: nada sai, mesmo na hora', async () => {
    const cfg = (await app.inject({ method: 'GET', url: '/api/atendimento/configuracao', headers: cab })).json();
    assert.equal(cfg.lembreteAtivo, false, 'mandar mensagem ao cliente e decisao do dono');
    assert.equal(await enviarLembretesSeForHora(tenantId, { enviar, agora: as('20:00') }), null);
    assert.equal(saidas.length, 0);
  });

  it('ligado, mas antes do horario: nada sai', async () => {
    assert.equal((await configurar({ lembreteAtivo: true, lembreteHora: '18:00' })).statusCode, 200);
    assert.equal(await enviarLembretesSeForHora(tenantId, { enviar, agora: as('17:00') }), null);
    assert.equal(saidas.length, 0);
  });

  it('na hora: UMA mensagem por cliente, com todos os horarios dele', async () => {
    const r = await enviarLembretesSeForHora(tenantId, { enviar, agora: as('18:30') });
    assert.equal(r.enviados, 2, 'Ana (2 horarios) e Bruno — o cancelado fica de fora');
    assert.equal(r.falhas, 0);

    const paraAna = saidas.filter((x) => x.destino === '5511955530001');
    assert.equal(paraAna.length, 1, 'corte e o outro servico no mesmo lembrete');
    assert.match(paraAna[0].texto, /^Oi, Ana!/);
    const prof = ctx.prof.nome.split(' ')[0];
    assert.ok(
      paraAna[0].texto.includes(`${ctx.servico.nome} às 10:00 com ${prof}; ${ctx.outro.nome} às 10:30 com ${prof}`),
      paraAna[0].texto
    );
    assert.equal(paraAna[0].digitandoMs, 1500);
    assert.equal(saidas.filter((x) => x.destino === '5511955530003').length, 0, 'horario cancelado nao recebe lembrete');

    assert.ok(await lembreteDe(ctx.osAna1));
    assert.ok(await lembreteDe(ctx.osAna2));
    assert.ok(await lembreteDe(ctx.osBruno));
    assert.equal(await lembreteDe(ctx.osCaio), null);

    // Fica no fio da conversa do cliente, marcado como lembrete.
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const [conversa] = await db.select().from(s.conversations).where(eq(s.conversations.leadId, ctx.ana.id));
    const { mensagens } = await conversas.mensagens(tenantId, conversa.id);
    assert.ok(mensagens.some((m) => m.direcao === 'saida' && m.metadados?.tipo === 'lembrete' && m.conteudo === paraAna[0].texto));
  });

  it('rodar de novo (proximo minuto, servidor reiniciado) nao manda outra vez', async () => {
    const antes = saidas.length;
    const r = await enviarLembretesSeForHora(tenantId, { enviar, agora: as('18:31') });
    assert.equal(r.enviados, 0);
    assert.equal(saidas.length, antes);
  });

  it('canal fora do ar: nao marca, e manda quando o canal volta', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const davi = await leads.criar(tenantId, { nome: 'Davi Lembrete', telefone: '5511955530004' });
    const os = await osAmanha({ lead: davi, hora: '09:00' });

    canalFalha = true;
    const falhou = await enviarLembretesSeForHora(tenantId, { enviar, agora: as('18:40') });
    assert.equal(falhou.enviados, 0);
    assert.equal(falhou.falhas, 1);
    assert.equal(await lembreteDe(os), null, 'sem envio, sem marca');

    canalFalha = false;
    const voltou = await enviarLembretesSeForHora(tenantId, { enviar, agora: as('18:41') });
    assert.equal(voltou.enviados, 1);
    assert.ok(await lembreteDe(os));
    assert.equal(saidas.filter((x) => x.destino === '5511955530004').length, 1);
  });

  it('a rota recusa horario invalido', async () => {
    assert.equal((await configurar({ lembreteHora: '25:00' })).statusCode, 400);
  });
});
