import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq, and, isNull } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { ErroDeProvedor } from '../src/ai/providers/base.js';
import { z } from 'zod';
import { conversar } from '../src/ai/agente.js';
import { definirFerramenta } from '../src/ai/tools/registry.js';
import { responder } from '../src/modules/atendimento/atendimento.service.js';
import { dataNoFuso, somarDias } from '../src/core/datetime.js';

/**
 * Regressoes de um teste real: o dono do sistema conversou pelo WhatsApp como
 * cliente, pediu 10:30 e:
 *
 *   1. a IA disse "ja foi reservado" — mas a primeira execucao HAVIA marcado; a
 *      Sofia disparou o mesmo pedido duas vezes e a segunda encontrou o horario
 *      ocupado pela primeira. Alem disso a Atena respondeu "[Consultando: ...]"
 *      (o marcador que nos mesmos pusemos no historico) em vez do relato;
 *   2. o atendimento foi atribuido ao DONO da empresa, porque era o unico
 *      "online" entre os elegiveis.
 *
 * Cada teste abaixo reproduz uma dessas causas isoladamente.
 */

const FUSO = 'America/Sao_Paulo';

let app;
let dono;
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

/** Provedor de mentira que segue um roteiro e registra o que recebeu. */
function provedorFalso(roteiro) {
  let i = 0;
  const chamadas = [];
  const impl = {
    nome: 'falso',
    async gerar({ modelo, mensagens, ferramentas }) {
      chamadas.push({ ferramentas: (ferramentas ?? []).map((f) => f.nome), mensagens: mensagens.map((m) => ({ ...m })) });
      const passo = roteiro[Math.min(i++, roteiro.length - 1)];
      if (passo.erro) throw new ErroDeProvedor(passo.erro, { provedor: 'falso', modelo, reTentavel: true });
      return { texto: passo.texto ?? '', chamadasDeFerramenta: passo.ferramentas ?? [], tokens: { entrada: 1, saida: 1 }, modelo };
    }
  };
  return { provedores: [{ impl, apiKey: 'x', modelos: ['m'] }], chamadas };
}

async function novoLead(sufixo) {
  const leads = await import('../src/modules/leads/leads.service.js');
  return leads.encontrarOuCriarPorTelefone(ctx.tenantId, `551194${String(1000000 + sufixo).slice(-7)}`, `Cliente Regressao ${sufixo}`);
}

async function agendamentosDe(leadId) {
  return ctx.db
    .select()
    .from(ctx.s.appointments)
    .where(and(eq(ctx.s.appointments.leadId, leadId), isNull(ctx.s.appointments.deletedAt)));
}

before(async () => {
  ({ app } = await criarAppDeTeste());
  dono = await entrar(app);
  ctx.tenantId = dono.usuario.tenantId;
  ctx.db = (await import('../src/db/client.js')).db;
  ctx.s = await import('../src/db/schema/index.js');
  ctx.agenda = await import('../src/modules/agenda/agenda.service.js');
  ctx.conversas = await import('../src/modules/conversas/conversas.service.js');

  const { servicos } = (await app.inject({ method: 'GET', url: '/api/servicos', headers: dono.cabecalho })).json();
  ctx.servico = servicos.find((s) => s.nome === 'Barba Terapia') ?? servicos.find((s) => s.profissionais.length > 0);
  ctx.profissional = ctx.servico.profissionais[0];
  ctx.n = 0;
});

after(async () => {
  await app?.close();
});

describe('1. o mesmo pedido chamado duas vezes no mesmo turno', () => {
  /**
   * A Sofia emite DUAS chamadas identicas a consultar_atena na mesma resposta.
   * Antes da correcao a Atena rodava duas vezes: a primeira marcava, a segunda
   * achava o horario ocupado e respondia "ja foi reservado".
   */
  it('a Atena roda UMA vez e a Sofia recebe o resultado real', async () => {
    const lead = await novoLead(ctx.n++);
    const pedido = `Agendar Barba Terapia com Carlos para o cliente no dia ${SEGUNDA} as 10:30.`;

    const falso = provedorFalso([
      // Sofia: dispara o mesmo pedido duas vezes, em paralelo.
      {
        ferramentas: [
          { nome: 'consultar_atena', argumentos: { pedido } },
          { nome: 'consultar_atena', argumentos: { pedido } }
        ]
      },
      // Atena: marca de verdade.
      {
        ferramentas: [
          {
            nome: 'criar_agendamento',
            argumentos: { servicoId: ctx.servico.nome, profissionalId: ctx.profissional.nome, data: SEGUNDA, hora: '10:30' }
          }
        ]
      },
      { texto: 'Agendamento confirmado para as 10:30.' },
      // Sofia: responde ao cliente.
      { texto: 'Pronto! Marquei as 10:30.' }
    ]);

    const r = await responder({
      tenantId: ctx.tenantId,
      conversationId: null,
      leadId: lead.id,
      leadNome: lead.nome,
      texto: '10:30',
      simulacao: true,
      modoOverride: 'ia',
      provedores: falso.provedores
    });

    assert.equal(r.detalhes.atena.length, 1, 'o mesmo pedido nao pode executar duas vezes');
    assert.match(r.baloes.join(' '), /10:30/);
    assert.doesNotMatch(r.baloes.join(' '), /reservado|indispon/i, 'nao pode dizer que o horario nao existe');

    const marcados = await agendamentosDe(lead.id);
    assert.equal(marcados.length, 1, 'um pedido, um agendamento');
  });
});

describe('2. o modelo devolve o marcador "[Consultando: ...]" como resposta', () => {
  const ferramenta = definirFerramenta({
    nome: 'consultar_horarios',
    descricao: 'x',
    argumentos: z.object({}),
    async executar() {
      return { horariosLivres: ['09:00', '10:30'] };
    }
  });

  it('pede o relato de verdade em vez de aceitar o marcador', async () => {
    const falso = provedorFalso([
      { ferramentas: [{ nome: 'consultar_horarios', argumentos: {} }] },
      { texto: '[Consultando: mover_etapa_atendimento]' }, // o eco que aconteceu
      { texto: 'Os horarios livres sao 09:00 e 10:30.' }
    ]);

    const r = await conversar({
      tenantId: ctx.tenantId,
      systemPrompt: 'x',
      mensagens: [{ papel: 'user', conteudo: 'horarios?' }],
      ferramentas: [ferramenta],
      provedores: falso.provedores
    });

    assert.equal(r.texto, 'Os horarios livres sao 09:00 e 10:30.');
    assert.doesNotMatch(r.texto, /Consultando/);
  });

  it('sem voltas sobrando, monta o relato com o que as ferramentas devolveram', async () => {
    const falso = provedorFalso([
      { ferramentas: [{ nome: 'consultar_horarios', argumentos: {} }] },
      { texto: '[Consultando: consultar_horarios]' }
    ]);

    const r = await conversar({
      tenantId: ctx.tenantId,
      systemPrompt: 'x',
      mensagens: [{ papel: 'user', conteudo: 'horarios?' }],
      ferramentas: [ferramenta],
      maxVoltas: 2,
      provedores: falso.provedores
    });

    assert.doesNotMatch(r.texto, /^\[Consultando/, 'um marcador nunca pode chegar a Sofia como se fosse resposta');
    assert.match(r.texto, /10:30/, 'o fato (o que a ferramenta devolveu) e melhor que o marcador');
  });

  it('texto normal com colchetes no meio nao e confundido com o marcador', async () => {
    const falso = provedorFalso([
      { ferramentas: [{ nome: 'consultar_horarios', argumentos: {} }] },
      { texto: 'Horarios [manha]: 09:00.' }
    ]);

    const r = await conversar({
      tenantId: ctx.tenantId,
      systemPrompt: 'x',
      mensagens: [{ papel: 'user', conteudo: 'horarios?' }],
      ferramentas: [ferramenta],
      provedores: falso.provedores
    });

    assert.equal(r.texto, 'Horarios [manha]: 09:00.');
    assert.equal(r.voltas, 2, 'nenhuma volta extra');
  });
});

describe('3. marcar de novo o que ja esta marcado', () => {
  const dados = (lead, hora) => ({
    leadId: lead.id,
    serviceId: ctx.servico.id,
    professionalId: ctx.profissional.id,
    data: SEGUNDA,
    hora,
    status: 'confirmado'
  });

  it('devolve o horario que o cliente ja tem, em vez de "horario ocupado"', async () => {
    const lead = await novoLead(ctx.n++);
    const primeiro = await ctx.agenda.criar(ctx.tenantId, dados(lead, '11:00'), { usuario: dono.usuario });
    const segundo = await ctx.agenda.criar(ctx.tenantId, dados(lead, '11:00'), { usuario: dono.usuario });

    assert.equal(segundo.id, primeiro.id, 'e o mesmo horario, nao um novo');
    assert.equal(segundo.jaExistia, true);
    assert.equal((await agendamentosDe(lead.id)).length, 1);
  });

  it('outro cliente no mesmo horario continua sendo conflito de verdade', async () => {
    const outro = await novoLead(ctx.n++);
    await assert.rejects(
      ctx.agenda.criar(ctx.tenantId, dados(outro, '11:00'), { usuario: dono.usuario }),
      /ocupad|conflit|hor/i,
      'a protecao contra dois clientes no mesmo horario nao pode ter enfraquecido'
    );
  });

  it('um horario cancelado NAO conta como ja marcado', async () => {
    const lead = await novoLead(ctx.n++);
    const primeiro = await ctx.agenda.criar(ctx.tenantId, dados(lead, '12:00'), { usuario: dono.usuario });
    await ctx.agenda.mudarStatus(ctx.tenantId, primeiro.id, 'cancelado', { usuario: dono.usuario, motivo: 'teste' });

    const novo = await ctx.agenda.criar(ctx.tenantId, dados(lead, '12:00'), { usuario: dono.usuario });
    assert.notEqual(novo.id, primeiro.id, 'remarcar depois de cancelar cria um horario novo');
    assert.equal(novo.jaExistia, undefined);
  });
});

describe('4. o atendimento cai no dono da empresa', () => {
  async function presencas(mapa) {
    for (const [username, presenca] of Object.entries(mapa)) {
      await ctx.db
        .update(ctx.s.users)
        .set({ statusPresenca: presenca })
        .where(and(eq(ctx.s.users.tenantId, ctx.tenantId), eq(ctx.s.users.username, username)));
    }
  }
  const cargoDe = async (userId) =>
    (await ctx.db.select().from(ctx.s.users).where(eq(ctx.s.users.id, userId)))[0].cargo;

  async function iaMarca(hora) {
    const lead = await novoLead(ctx.n++);
    const id = await ctx.conversas.encontrarOuAbrir(ctx.tenantId, { leadId: lead.id, canal: 'whatsapp' });
    await ctx.conversas.registrarRecebida(ctx.tenantId, id, { conteudo: 'quero marcar' });
    const os = await ctx.agenda.criar(
      ctx.tenantId,
      { leadId: lead.id, serviceId: ctx.servico.id, professionalId: ctx.profissional.id, data: SEGUNDA, hora, status: 'confirmado', conversationId: id },
      { origem: 'ia', usuario: { nome: 'Atena (IA)' } }
    );
    return { os, conversa: await ctx.conversas.obter(ctx.tenantId, id) };
  }

  it('dono ONLINE e atendentes offline: o horario vai para um atendente, nao para o dono', async () => {
    // Exatamente o cenario do teste real.
    await presencas({ dono: 'online', recepcao: 'offline' });

    const { os, conversa } = await iaMarca('14:00');

    assert.notEqual(os.responsavelUserId, dono.usuario.id, 'o dono nao recebe atendimento automaticamente');
    assert.equal(await cargoDe(os.responsavelUserId), 'atendente');
    assert.equal(conversa.assignedUserId, os.responsavelUserId);
    assert.equal(conversa.status, 'bot', 'a Sofia segue conduzindo');
  });

  it('a fila tambem nao cai no dono: sem atendente online, a conversa espera', async () => {
    await presencas({ dono: 'online', recepcao: 'offline' });

    const lead = await novoLead(ctx.n++);
    const id = await ctx.conversas.encontrarOuAbrir(ctx.tenantId, { leadId: lead.id, canal: 'whatsapp' });
    await ctx.conversas.registrarRecebida(ctx.tenantId, id, { conteudo: 'quero um atendente' });
    await ctx.conversas.enviarParaFila(ctx.tenantId, id);

    const r = await ctx.conversas.distribuir(ctx.tenantId, id);
    assert.equal(r.atribuida, false, 'so o dono esta online, e ele nao entra na roda');
    assert.equal(r.conversa.status, 'na_fila');
  });

  it('com um atendente online, e ele quem recebe — mesmo com o dono online tambem', async () => {
    await presencas({ dono: 'online', recepcao: 'online' });

    const { os } = await iaMarca('15:00');
    assert.equal(await cargoDe(os.responsavelUserId), 'atendente');
  });

  it('a empresa pode INCLUIR a gerencia na roda (escolha explicita)', async () => {
    await presencas({ dono: 'online', recepcao: 'offline' });
    const r = await app.inject({
      method: 'PUT',
      url: '/api/equipe/configuracao',
      headers: dono.cabecalho,
      payload: { distribuirParaGerencia: true }
    });
    assert.equal(r.statusCode, 200, r.body);

    const lead = await novoLead(ctx.n++);
    const id = await ctx.conversas.encontrarOuAbrir(ctx.tenantId, { leadId: lead.id, canal: 'whatsapp' });
    await ctx.conversas.registrarRecebida(ctx.tenantId, id, { conteudo: 'quero um atendente' });
    await ctx.conversas.enviarParaFila(ctx.tenantId, id);

    const dist = await ctx.conversas.distribuir(ctx.tenantId, id);
    assert.equal(dist.atribuida, true);
    assert.equal(dist.atendente.id, dono.usuario.id, 'agora o dono esta na roda');

    await app.inject({ method: 'PUT', url: '/api/equipe/configuracao', headers: dono.cabecalho, payload: { distribuirParaGerencia: false } });
  });

  it('empresa SEM nenhum atendente: a gerencia assume, em vez de o horario ficar sem responsavel', async () => {
    await presencas({ dono: 'online' });
    // Desativa todos os atendentes.
    await ctx.db
      .update(ctx.s.users)
      .set({ ativo: false })
      .where(and(eq(ctx.s.users.tenantId, ctx.tenantId), eq(ctx.s.users.cargo, 'atendente')));

    const { os } = await iaMarca('16:00');
    assert.ok(os.responsavelUserId, 'um horario fechado nunca fica sem responsavel');
    assert.equal(await cargoDe(os.responsavelUserId), 'owner');

    await ctx.db
      .update(ctx.s.users)
      .set({ ativo: true })
      .where(and(eq(ctx.s.users.tenantId, ctx.tenantId), eq(ctx.s.users.cargo, 'atendente')));
  });
});
