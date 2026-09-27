import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq, desc } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { ErroDeProvedor } from '../src/ai/providers/base.js';
import { consultarAtena } from '../src/ai/atena.js';
import { LIMITE_ESCRITAS } from '../src/ai/tools/atena.tools.js';
import { responder } from '../src/modules/atendimento/atendimento.service.js';
import { somarDias, dataNoFuso } from '../src/core/datetime.js';

/**
 * A Atena como agente de IA.
 *
 * Nenhum teste chama um modelo de verdade: um provedor de mentira segue um
 * ROTEIRO (o que cada chamada de modelo "decide"), e o resto — as ferramentas,
 * o banco, as travas — roda de verdade. O que se testa e o que importa: dado
 * que o modelo decidiu X, o sistema faz a coisa certa e barra a errada.
 */

const FUSO = 'America/Sao_Paulo';

let app;
let cab;
let tenantId;
let ctx = {};

/** Proxima segunda-feira: dia em que Carlos atende (09:00-18:00). */
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

/**
 * Provedor de mentira que segue um roteiro e REGISTRA o que recebeu.
 * Cada passo: { texto } | { ferramentas: [{nome, argumentos}] } | { erro }
 */
function provedorFalso(roteiro) {
  const chamadas = [];
  let i = 0;

  const impl = {
    nome: 'falso',
    async gerar({ modelo, systemPrompt, mensagens, ferramentas }) {
      chamadas.push({
        systemPrompt,
        ferramentas: (ferramentas ?? []).map((f) => f.nome),
        // Copia: o laco de conversa continua empurrando mensagens no mesmo array.
        mensagens: mensagens.map((m) => ({ ...m }))
      });

      const passo = roteiro[Math.min(i++, roteiro.length - 1)];
      if (passo.erro) throw new ErroDeProvedor(passo.erro, { provedor: 'falso', modelo, reTentavel: true });

      return {
        texto: passo.texto ?? '',
        chamadasDeFerramenta: passo.ferramentas ?? [],
        tokens: { entrada: 10, saida: 5 },
        modelo
      };
    }
  };

  return { provedores: [{ impl, apiKey: 'x', modelos: ['modelo-falso'] }], chamadas };
}

/** Cria um agendamento pela API (o caminho normal), para os testes terem o que mexer. */
async function criarAgendamento({ leadId, hora, professionalId = ctx.carlos.id, serviceId = ctx.corteSocial.id }) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agenda',
    headers: cab,
    payload: { leadId, serviceId, professionalId, data: SEGUNDA, hora }
  });
  assert.equal(res.statusCode, 201, `falha ao preparar agendamento: ${res.body}`);
  return res.json().agendamento;
}

const buscarAgendamento = async (id) =>
  (await app.inject({ method: 'GET', url: `/api/agenda/${id}`, headers: cab }));

/** Roda a Atena direto (sem a Sofia) com um roteiro. */
const pedirAAtena = (roteiro, extra = {}) => {
  const falso = provedorFalso(roteiro);
  return consultarAtena({
    tenantId,
    pedido: 'pedido de teste',
    leadId: ctx.lead1.id,
    leadNome: ctx.lead1.nome,
    fuso: FUSO,
    provedores: falso.provedores,
    ...extra
  }).then((r) => ({ ...r, chamadas: falso.chamadas }));
};

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cab } = await entrar(app));

  const { db } = await import('../src/db/client.js');
  const s = await import('../src/db/schema/index.js');

  const [t] = await db.select().from(s.tenants);
  tenantId = t.id;

  const [profs, svcs, lds] = await Promise.all([
    db.select().from(s.professionals),
    db.select().from(s.services),
    db.select().from(s.leads)
  ]);

  ctx.carlos = profs.find((p) => p.nome.startsWith('Carlos'));
  ctx.corteSocial = svcs.find((x) => x.nome === 'Corte Social');
  ctx.lead1 = lds[0];
  ctx.lead2 = lds[1];
  ctx.db = db;
  ctx.s = s;
});

after(async () => {
  await app?.close();
});

// ============================================================================

describe('Sofia delega a Atena', () => {
  /**
   * Regra nova (prompt 10): a Sofia le direto e MARCA direto — mas so por
   * reservar_horario, que so aceita o que foi ofertado. Remarcar e cancelar
   * (mexer no que ja existe) continuam pela Atena. Nenhuma ferramenta de
   * escrita da Atena fica exposta a ela.
   */
  it('a Sofia le direto, marca so por reservar_horario e o resto passa pela Atena', async () => {
    const falso = provedorFalso([{ texto: 'Oi! Como posso ajudar?' }]);

    await responder({
      tenantId, conversationId: null, leadId: ctx.lead1.id, leadNome: 'Marcos',
      texto: 'oi tudo bem?', simulacao: true, modoOverride: 'ia', provedores: falso.provedores
    });

    assert.deepEqual(falso.chamadas[0].ferramentas.sort(), [
      'consultar_agendamentos_do_cliente',
      'consultar_atena',
      'consultar_horarios',
      'consultar_varios_servicos',
      'reservar_horario',
      'transferir_para_humano'
    ]);
    const escritas = ['criar_agendamento', 'agendar_varios_servicos', 'remarcar_agendamento', 'cancelar_agendamento', 'excluir_agendamento'];
    assert.ok(!falso.chamadas[0].ferramentas.some((f) => escritas.includes(f)), 'nenhuma escrita da Atena exposta a Sofia');
    assert.match(falso.chamadas[0].systemPrompt, /MARCAR: reservar_horario/);
    assert.match(falso.chamadas[0].systemPrompt, /REMARCAR ou CANCELAR: consultar_atena/);
  });

  /**
   * A mudanca de arquitetura: consultar horario era Sofia -> modelo da Atena
   * (2 a 4 chamadas) -> ferramenta. Agora e Sofia -> ferramenta. Mesmas
   * permissoes, mesmo resultado, sem o modelo no meio.
   */
  it('consultar horarios nao acorda o modelo da Atena', async () => {
    const falso = provedorFalso([
      { ferramentas: [{ nome: 'consultar_horarios', argumentos: { servicoId: 'Corte Social', profissionalId: 'Carlos', data: SEGUNDA } }] },
      { texto: 'Tenho segunda às 09:00 e às 09:30. Qual prefere?' }
    ]);

    const r = await responder({
      tenantId, conversationId: null, leadId: ctx.lead1.id, leadNome: 'Marcos',
      texto: 'tem horario segunda com o carlos?', simulacao: true, modoOverride: 'ia', provedores: falso.provedores
    });

    assert.equal(falso.chamadas.length, 2, 'duas chamadas de modelo, ambas da Sofia');
    assert.equal(r.detalhes.atena.length, 0, 'a Atena nem foi chamada');
    assert.equal(r.detalhes.consultas.length, 1, 'a consulta direta aparece nos bastidores');
    assert.ok(r.detalhes.consultas[0].resultado.horariosLivres.length > 0, 'resultado real da agenda');
  });

  it('as consultas diretas respeitam as permissoes da Atena', async () => {
    const { obterAgente, salvarAgente } = await import('../src/modules/ia/ia.service.js');
    const antes = (await obterAgente(tenantId, 'atena')).ferramentas;
    await salvarAgente(tenantId, 'atena', { ferramentas: antes.filter((g) => g !== 'horarios') });
    try {
      const falso = provedorFalso([{ texto: 'Oi!' }]);
      await responder({
        tenantId, conversationId: null, leadId: ctx.lead1.id, leadNome: 'Marcos',
        texto: 'oi', simulacao: true, modoOverride: 'ia', provedores: falso.provedores
      });
      assert.ok(!falso.chamadas[0].ferramentas.includes('consultar_horarios'), 'horarios desligado para a Atena = desligado para a Sofia');
      assert.ok(falso.chamadas[0].ferramentas.includes('consultar_atena'));
    } finally {
      await salvarAgente(tenantId, 'atena', { ferramentas: antes });
    }
  });

  it('a pergunta passa pela Atena e a resposta volta para a Sofia', async () => {
    const falso = provedorFalso([
      // 1. Sofia decide delegar
      { ferramentas: [{ nome: 'consultar_atena', argumentos: { pedido: 'Quais serviços existem e quanto custam?' } }] },
      // 2. Atena raciocina e consulta o catalogo
      { ferramentas: [{ nome: 'listar_servicos', argumentos: {} }] },
      // 3. Atena relata
      { texto: 'Corte Social: R$ 45,00 (30 min). Corte Degrade: R$ 55,00 (40 min).' },
      // 4. Sofia responde ao cliente
      { texto: 'O corte social sai por *R$ 45,00*!' }
    ]);

    const r = await responder({
      tenantId, conversationId: null, leadId: ctx.lead1.id, leadNome: 'Marcos',
      texto: 'quanto custa cortar o cabelo?', simulacao: true, modoOverride: 'ia', provedores: falso.provedores
    });

    assert.equal(r.respondidoPor, 'ia');
    assert.match(r.baloes.join(' '), /R\$ 45,00/);

    // A Atena foi chamada de verdade, com o proprio prompt e as proprias ferramentas.
    const [chamadaAtena] = falso.chamadas.filter((c) => c.ferramentas.includes('listar_servicos'));
    assert.ok(chamadaAtena, 'a Atena precisa ter rodado com as ferramentas de dados');
    assert.match(chamadaAtena.systemPrompt, /Atena/);
    assert.match(chamadaAtena.systemPrompt, /NUNCA invente/);

    // O pedido chegou a ela em linguagem natural.
    assert.equal(chamadaAtena.mensagens[0].conteudo, 'Quais serviços existem e quanto custam?');
  });

  it('os bastidores mostram o que a Atena consultou no banco', async () => {
    const falso = provedorFalso([
      { ferramentas: [{ nome: 'consultar_atena', argumentos: { pedido: 'precos?' } }] },
      { ferramentas: [{ nome: 'listar_servicos', argumentos: {} }] },
      { texto: 'Lista de servicos.' },
      { texto: 'Pronto!' }
    ]);

    const r = await responder({
      tenantId, conversationId: null, leadId: ctx.lead1.id, leadNome: 'Marcos',
      texto: 'precos?', simulacao: true, modoOverride: 'ia', provedores: falso.provedores
    });

    assert.equal(r.detalhes.atena.length, 1);
    const trace = r.detalhes.atena[0];
    assert.equal(trace.pedido, 'precos?');
    assert.equal(trace.ferramentas[0].nome, 'listar_servicos');
    assert.equal(trace.ferramentas[0].resultado.servicos.length, 5, 'o resultado real do banco precisa estar no rastro');
  });

  /**
   * A Sofia so precisa da resposta. Devolver o rastro gastaria tokens e a
   * tentaria a repassar detalhes internos ao cliente.
   */
  it('o rastro interno da Atena NAO volta para a Sofia', async () => {
    const falso = provedorFalso([
      { ferramentas: [{ nome: 'consultar_atena', argumentos: { pedido: 'x' } }] },
      { ferramentas: [{ nome: 'listar_servicos', argumentos: {} }] },
      { texto: 'Resposta da Atena.' },
      { texto: 'Ok!' }
    ]);

    await responder({
      tenantId, conversationId: null, leadId: ctx.lead1.id, leadNome: 'Marcos',
      texto: 'x', simulacao: true, modoOverride: 'ia', provedores: falso.provedores
    });

    const ultimaDaSofia = falso.chamadas.at(-1);
    const resultadoDaTool = ultimaDaSofia.mensagens.find((m) => m.papel === 'tool');
    assert.deepEqual(Object.keys(JSON.parse(resultadoDaTool.conteudo)), ['resposta']);
  });

  it('se a Atena falha, a Sofia recebe a ordem de NAO inventar dados', async () => {
    const falso = provedorFalso([
      { ferramentas: [{ nome: 'consultar_atena', argumentos: { pedido: 'horarios?' } }] },
      { erro: 'provedor fora do ar' }, // a Atena nao consegue responder
      { texto: 'Vou verificar e ja te falo!' }
    ]);

    const r = await responder({
      tenantId, conversationId: null, leadId: ctx.lead1.id, leadNome: 'Marcos',
      texto: 'tem horario amanha?', simulacao: true, modoOverride: 'ia', provedores: falso.provedores
    });

    const resultado = falso.chamadas.at(-1).mensagens.find((m) => m.papel === 'tool');
    assert.match(JSON.parse(resultado.conteudo).erro, /NÃO informe preços nem horários/);
    assert.ok(r.detalhes.atena[0].erro, 'a falha da Atena precisa aparecer nos bastidores');
  });
});

// ============================================================================

/**
 * A Sofia RESERVA direto, com a trava de "oferta".
 *
 * Antes: marcar 1 servico = 4 chamadas da Sofia + 2 da Atena (um modelo que
 * nem via a conversa). Agora: a Sofia executa a mesma ferramenta da Atena, mas
 * so para um horario que as consultas DESTA conversa mostraram. Conversa de
 * verdade (no banco): as ofertas ficam nela, entao o 2º turno — outra chamada
 * de `responder`, como apos um reinicio — ainda as encontra.
 */
describe('a Sofia reserva direto o que foi ofertado', () => {
  let conversationId;
  let lead;

  const turno = async (texto, roteiro, extra = {}) => {
    const falso = provedorFalso(roteiro);
    const r = await responder({
      tenantId, conversationId, leadId: lead.id, leadNome: lead.nome,
      texto, modoOverride: 'ia', provedores: falso.provedores, ...extra
    });
    return { r, chamadas: falso.chamadas };
  };
  const agendamentosDoLead = async () =>
    (await ctx.db.select().from(ctx.s.appointments)).filter((a) => a.leadId === lead.id && !a.deletedAt);
  const consultarCarlos = (texto = 'tem horario segunda com o carlos?') =>
    turno(texto, [
      { ferramentas: [{ nome: 'consultar_horarios', argumentos: { servicoId: 'Corte Social', profissionalId: 'Carlos', data: SEGUNDA } }] },
      { texto: 'Tenho alguns horários na segunda. Qual prefere?' }
    ]);
  const reservar = (argumentos) =>
    turno('pode ser esse', [{ ferramentas: [{ nome: 'reservar_horario', argumentos }] }, { texto: 'Pronto!' }]);

  before(async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    lead = await leads.criar(tenantId, { nome: 'Reserva Direta', telefone: '5511955540001' });
    conversationId = await conversas.encontrarOuAbrir(tenantId, { leadId: lead.id });
  });

  // As reservas daqui ocupam horarios de segunda com o Carlos que os testes
  // seguintes da Atena esperam livres: saem ao fim do bloco.
  after(async () => {
    const { eq } = await import('drizzle-orm');
    await ctx.db.delete(ctx.s.appointments).where(eq(ctx.s.appointments.leadId, lead.id));
  });

  it('consulta + reserva do horario ofertado: 1 agendamento e NENHUMA chamada da Atena', async () => {
    const consulta = await consultarCarlos();
    const [hora] = consulta.r.detalhes.consultas[0].resultado.horariosLivres;

    const reserva = await reservar({ servicos: ['Corte Social'], profissional: 'Carlos', data: SEGUNDA, hora });
    const feito = reserva.r.detalhes.consultas.find((c) => c.nome === 'reservar_horario');
    assert.equal(feito.resultado.sucesso, true, JSON.stringify(feito.resultado));

    const doLead = await agendamentosDoLead();
    assert.equal(doLead.length, 1);
    assert.equal(doLead[0].professionalId, ctx.carlos.id);
    assert.equal(doLead[0].conversationId, conversationId, 'a OS fica presa a esta conversa, como quando a Atena marcava');

    // As contas do prompt: 2 chamadas da Sofia por turno, zero da Atena.
    assert.equal(consulta.chamadas.length + reserva.chamadas.length, 4);
    assert.equal(consulta.r.detalhes.atena.length + reserva.r.detalhes.atena.length, 0);
  });

  it('hora que nao foi ofertada: recusa, e nada e gravado', async () => {
    const antes = (await agendamentosDoLead()).length;
    await consultarCarlos();
    const r = await reservar({ servicos: ['Corte Social'], profissional: 'Carlos', data: SEGUNDA, hora: '06:10' });
    const tentativa = r.r.detalhes.consultas.find((c) => c.nome === 'reservar_horario');
    assert.match(tentativa.resultado.erro, /não veio de uma consulta desta conversa/);
    assert.equal((await agendamentosDoLead()).length, antes);
  });

  it('oferta vencida (mais de 2 h): recusa', async () => {
    const consulta = await consultarCarlos();
    const horas = consulta.r.detalhes.consultas[0].resultado.horariosLivres;
    const livre = horas.at(-1);
    const { eq } = await import('drizzle-orm');
    const [conv] = await ctx.db.select().from(ctx.s.conversations).where(eq(ctx.s.conversations.id, conversationId));
    const velhas = conv.ofertasHorario.map((o) => ({ ...o, em: Date.now() - 2 * 3_600_000 - 60_000 }));
    await ctx.db.update(ctx.s.conversations).set({ ofertasHorario: velhas }).where(eq(ctx.s.conversations.id, conversationId));

    const r = await reservar({ servicos: ['Corte Social'], profissional: 'Carlos', data: SEGUNDA, hora: livre });
    assert.match(r.r.detalhes.consultas.find((c) => c.nome === 'reservar_horario').resultado.erro, /não veio de uma consulta/);
  });

  it('varios servicos: reserva a sequencia ofertada, todos juntos', async () => {
    const antes = (await agendamentosDoLead()).length;
    const DOIS = ['Corte Social', 'Barba Terapia'];
    const consulta = await turno('corte e barba na segunda?', [
      { ferramentas: [{ nome: 'consultar_varios_servicos', argumentos: { servicos: DOIS, data: SEGUNDA } }] },
      { texto: 'Tenho opções. Qual prefere?' }
    ]);
    const resultado = consulta.r.detalhes.consultas[0].resultado;
    const inicio = (resultado.opcoes[0] ?? resultado.proximaDataComVaga?.opcoes?.[0]).inicio;
    const data = resultado.opcoes.length ? SEGUNDA : resultado.proximaDataComVaga.data;

    const r = await reservar({ servicos: DOIS, data, hora: inicio });
    const feito = r.r.detalhes.consultas.find((c) => c.nome === 'reservar_horario');
    assert.equal(feito.resultado.sucesso, true, JSON.stringify(feito.resultado));
    assert.equal((await agendamentosDoLead()).length, antes + 2);
  });

  /**
   * "Marcar horario" e interruptor DA SOFIA (antes era o "criar" da Atena,
   * sem a tela dizer). Desligado, a ferramenta nem e oferecida — e se o modelo
   * tentar assim mesmo, nada e gravado.
   */
  it('interruptor "Marcar horario" da Sofia desligado: nem e oferecido, nada gravado', async () => {
    const { obterAgente, salvarAgente } = await import('../src/modules/ia/ia.service.js');
    const antesSofia = await obterAgente(tenantId, 'atendente');
    const linhaAntes = (await ctx.db.select().from(ctx.s.agentProfiles)).find((a) => a.chave === 'atendente' && a.tenantId === tenantId);
    await salvarAgente(tenantId, 'atendente', { ferramentas: antesSofia.ferramentas.filter((g) => g !== 'reservar') });
    try {
      const antes = (await agendamentosDoLead()).length;
      const consulta = await consultarCarlos();
      assert.ok(!consulta.chamadas[0].ferramentas.includes('reservar_horario'), 'a Sofia nem recebe a ferramenta');
      assert.match(consulta.chamadas[0].systemPrompt, /MARCAR: você não marca/, 'e o prompt diz o caminho: uma pessoa');

      const hora = consulta.r.detalhes.consultas[0].resultado.horariosLivres.at(-2);
      await reservar({ servicos: ['Corte Social'], profissional: 'Carlos', data: SEGUNDA, hora });
      assert.equal((await agendamentosDoLead()).length, antes, 'nada marcado');
    } finally {
      // Volta EXATAMENTE como estava: os testes seguintes conferem a Sofia de
      // quem nunca mexeu nos interruptores dela (derivados da Atena).
      if (linhaAntes) {
        await ctx.db.update(ctx.s.agentProfiles).set({ ferramentas: linhaAntes.ferramentas, config: linhaAntes.config }).where(eq(ctx.s.agentProfiles.id, linhaAntes.id));
      } else {
        await ctx.db.delete(ctx.s.agentProfiles).where(eq(ctx.s.agentProfiles.chave, 'atendente'));
      }
    }
  });

  /**
   * O roteiro do prompt 10, medido: marcar 1 servico pelo caminho ANTIGO
   * (Sofia -> consultar_atena -> modelo da Atena -> criar_agendamento) contra
   * o NOVO (Sofia -> reservar_horario). Mesmo resultado; o antigo custa as 2
   * chamadas da Atena a mais.
   */
  it('contagem de chamadas de IA para marcar 1 servico: antes 4 Sofia + 2 Atena, agora 4 Sofia + 0 Atena', async () => {
    const quem = (chamadas) => ({
      sofia: chamadas.filter((c) => c.ferramentas.includes('reservar_horario')).length,
      atena: chamadas.filter((c) => !c.ferramentas.includes('reservar_horario')).length
    });

    // ANTES: consulta direta + pedido a Atena.
    const c1 = await consultarCarlos();
    const [horaAntigo, horaNovo] = c1.r.detalhes.consultas[0].resultado.horariosLivres.slice(-2);
    const antigo = await turno('pode ser', [
      { ferramentas: [{ nome: 'consultar_atena', argumentos: { pedido: `Marcar Corte Social com o Carlos em ${SEGUNDA} às ${horaAntigo}.` } }] },
      { ferramentas: [{ nome: 'criar_agendamento', argumentos: { servicoId: 'Corte Social', profissionalId: 'Carlos', data: SEGUNDA, hora: horaAntigo } }] },
      { texto: 'FEITO: Corte Social marcado.' },
      { texto: 'Pronto, marcado!' }
    ]);
    const antes = { sofia: quem(c1.chamadas).sofia + quem(antigo.chamadas).sofia, atena: quem(antigo.chamadas).atena };

    // DEPOIS: consulta direta + reserva direta.
    const c2 = await consultarCarlos();
    const novo = await reservar({ servicos: ['Corte Social'], profissional: 'Carlos', data: SEGUNDA, hora: horaNovo });
    const depois = { sofia: quem(c2.chamadas).sofia + quem(novo.chamadas).sofia, atena: quem(novo.chamadas).atena };

    assert.deepEqual(antes, { sofia: 4, atena: 2 });
    assert.deepEqual(depois, { sofia: 4, atena: 0 });
    // Os dois marcaram de verdade.
    const horas = (await agendamentosDoLead()).map((a) => a.inicioEm.getTime());
    assert.equal(new Set(horas).size, horas.length);
    assert.ok(novo.r.detalhes.consultas.find((c) => c.nome === 'reservar_horario').resultado.sucesso);
  });

  it('simulador em modo seguro (sem escrita): reservar nao grava', async () => {
    const antes = (await agendamentosDoLead()).length;
    const consulta = await consultarCarlos();
    const hora = consulta.r.detalhes.consultas[0].resultado.horariosLivres.at(-3);
    const r = await turno('esse', [
      { ferramentas: [{ nome: 'reservar_horario', argumentos: { servicos: ['Corte Social'], profissional: 'Carlos', data: SEGUNDA, hora } }] },
      { texto: 'Esse horário está livre!' }
    ], { permitirEscrita: false, simulacao: true });
    assert.match(r.r.detalhes.consultas.find((c) => c.nome === 'reservar_horario').resultado.erro, /simulação/i);
    assert.equal((await agendamentosDoLead()).length, antes);
  });
});

describe('a Atena escreve no banco de verdade', () => {
  it('cria um agendamento e ele existe na agenda', async () => {
    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'consultar_horarios', argumentos: { servicoId: ctx.corteSocial.id, profissionalId: ctx.carlos.id, data: SEGUNDA } }] },
      { ferramentas: [{ nome: 'criar_agendamento', argumentos: { servicoId: ctx.corteSocial.id, profissionalId: ctx.carlos.id, data: SEGUNDA, hora: '09:00' } }] },
      { texto: 'Agendado para 09:00.' }
    ]);

    const criacao = r.trace.ferramentas.find((f) => f.nome === 'criar_agendamento').resultado;
    assert.equal(criacao.sucesso, true);

    const res = await buscarAgendamento(criacao.agendamento.id);
    assert.equal(res.statusCode, 200);
    const ag = res.json().agendamento;

    assert.equal(ag.leadId, ctx.lead1.id, 'precisa ficar no cliente DA CONVERSA');
    assert.equal(ag.horaInicio, '09:00');
    assert.equal(ag.criadoPor, 'ia', 'a origem IA precisa ficar registrada');
    assert.equal(r.trace.escritas, 1);
  });

  it('a acao entra na auditoria como "Atena (IA)"', async () => {
    const [log] = await ctx.db
      .select().from(ctx.s.auditLogs)
      .where(eq(ctx.s.auditLogs.acao, 'agendamento.criar'))
      .orderBy(desc(ctx.s.auditLogs.createdAt)).limit(1);

    assert.equal(log.userNome, 'Atena (IA)');
  });

  /** A regra "nao marcar por cima" vive na agenda; a Atena nao tem caminho paralelo. */
  it('NAO consegue marcar por cima de um horario ocupado', async () => {
    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'criar_agendamento', argumentos: { servicoId: ctx.corteSocial.id, profissionalId: ctx.carlos.id, data: SEGUNDA, hora: '09:00' } }] },
      { texto: 'Nao foi possivel.' }
    ], { leadId: ctx.lead2.id, leadNome: ctx.lead2.nome });

    const resultado = r.trace.ferramentas[0].resultado;
    assert.match(resultado.erro, /agendamento/i, 'o conflito precisa voltar para a Atena poder sugerir outro horario');
  });

  it('argumentos invalidos do modelo nao chegam ao banco', async () => {
    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'criar_agendamento', argumentos: { servicoId: ctx.corteSocial.id, profissionalId: ctx.carlos.id, data: SEGUNDA, hora: '9h da manha' } }] },
      { texto: 'ok' }
    ]);

    assert.match(r.trace.ferramentas[0].resultado.erro, /HH:MM/);
  });

  it('remarca e devolve o novo horario', async () => {
    const ag = await criarAgendamento({ leadId: ctx.lead1.id, hora: '10:00' });

    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'remarcar_agendamento', argumentos: { agendamentoId: ag.id, hora: '11:00' } }] },
      { texto: 'Remarcado.' }
    ]);

    assert.equal(r.trace.ferramentas[0].resultado.agendamento.hora, '11:00');
    assert.equal((await buscarAgendamento(ag.id)).json().agendamento.horaInicio, '11:00');
  });

  it('remarcar tambem respeita conflito', async () => {
    const ocupado = await criarAgendamento({ leadId: ctx.lead2.id, hora: '13:00' });
    const meu = await criarAgendamento({ leadId: ctx.lead1.id, hora: '14:00' });

    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'remarcar_agendamento', argumentos: { agendamentoId: meu.id, hora: '13:00' } }] },
      { texto: 'Conflito.' }
    ]);

    assert.match(r.trace.ferramentas[0].resultado.erro, /agendamento/i);
    assert.equal((await buscarAgendamento(meu.id)).json().agendamento.horaInicio, '14:00', 'nada pode ter mudado');
    assert.ok(ocupado.id);
  });

  it('cancela mantendo o registro e o motivo', async () => {
    const ag = await criarAgendamento({ leadId: ctx.lead1.id, hora: '15:00' });

    await pedirAAtena([
      { ferramentas: [{ nome: 'cancelar_agendamento', argumentos: { agendamentoId: ag.id, motivo: 'Cliente viajou' } }] },
      { texto: 'Cancelado.' }
    ]);

    const depois = (await buscarAgendamento(ag.id)).json().agendamento;
    assert.equal(depois.status, 'cancelado', 'cancelar preserva o registro');
  });

  it('exclui um agendamento pendente: some da agenda', async () => {
    const ag = await criarAgendamento({ leadId: ctx.lead1.id, hora: '16:00' });

    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'excluir_agendamento', argumentos: { agendamentoId: ag.id } }] },
      { texto: 'Excluido.' }
    ]);

    assert.equal(r.trace.ferramentas[0].resultado.sucesso, true);
    assert.equal((await buscarAgendamento(ag.id)).statusCode, 404);
  });

  it('atualiza a observacao da OS', async () => {
    const ag = await criarAgendamento({ leadId: ctx.lead1.id, hora: '16:30' });

    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'atualizar_agendamento', argumentos: { agendamentoId: ag.id, observacoes: 'Alergico a alcool' } }] },
      { texto: 'Anotado.' }
    ]);

    assert.equal(r.trace.ferramentas[0].resultado.agendamento.observacoes, 'Alergico a alcool');
  });
});

// ============================================================================

describe('as travas que uma IA com acesso de escrita precisa ter', () => {
  /**
   * Um cliente malicioso (ou um modelo confuso) pode tentar mexer no
   * agendamento de OUTRA pessoa. A trava de escopo impede, mesmo que o modelo
   * conheca um id valido.
   */
  it('ESCOPO: nao cancela agendamento de outro cliente', async () => {
    const alheio = await criarAgendamento({ leadId: ctx.lead2.id, hora: '09:30' });

    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'cancelar_agendamento', argumentos: { agendamentoId: alheio.id } }] },
      { texto: 'Nao consegui.' }
    ]); // a conversa e do lead1

    assert.match(r.trace.ferramentas[0].resultado.erro, /entre os deste cliente/);
    assert.equal((await buscarAgendamento(alheio.id)).json().agendamento.status, 'confirmado', 'o do outro cliente nao pode ter sido tocado');
  });

  it('ESCOPO: nao exclui nem remarca agendamento de outro cliente', async () => {
    const alheio = await criarAgendamento({ leadId: ctx.lead2.id, hora: '12:00' });

    const r = await pedirAAtena([
      { ferramentas: [
        { nome: 'excluir_agendamento', argumentos: { agendamentoId: alheio.id } },
        { nome: 'remarcar_agendamento', argumentos: { agendamentoId: alheio.id, hora: '12:30' } }
      ] },
      { texto: 'Nao consegui.' }
    ]);

    for (const f of r.trace.ferramentas) assert.ok(f.resultado.erro, `${f.nome} nao pode ter funcionado`);
    const depois = (await buscarAgendamento(alheio.id)).json().agendamento;
    assert.equal(depois.horaInicio, '12:00');
    assert.equal(depois.status, 'confirmado');
  });

  /** Concluido ja e faturamento: apagar mudaria o relatorio do mes. */
  it('NAO exclui agendamento concluido (e faturamento)', async () => {
    const ag = await criarAgendamento({ leadId: ctx.lead1.id, hora: '17:00' });
    await app.inject({ method: 'PATCH', url: `/api/agenda/${ag.id}/status`, headers: cab, payload: { status: 'concluido' } });

    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'excluir_agendamento', argumentos: { agendamentoId: ag.id } }] },
      { texto: 'Nao posso.' }
    ]);

    assert.match(r.trace.ferramentas[0].resultado.erro, /concluido|Peça a um atendente/i);
    assert.equal((await buscarAgendamento(ag.id)).statusCode, 200, 'o agendamento concluido precisa continuar la');
  });

  /**
   * Conceder desconto por conversa de WhatsApp e o tipo de coisa que um
   * cliente insistente arrancaria de um modelo prestativo.
   */
  it('NAO consegue dar desconto, mesmo que o modelo tente', async () => {
    const ag = await criarAgendamento({ leadId: ctx.lead1.id, hora: '17:30' });

    await pedirAAtena([
      // O modelo tenta passar um campo que a ferramenta nao declara.
      { ferramentas: [{ nome: 'atualizar_agendamento', argumentos: { agendamentoId: ag.id, observacoes: 'x', descontoCentavos: 4000 } }] },
      { texto: 'ok' }
    ]);

    const depois = (await buscarAgendamento(ag.id)).json().agendamento;
    assert.equal(depois.descontoCentavos, 0, 'o desconto nao pode ter sido aplicado');
    assert.equal(depois.observacoes, 'x', 'mas a observacao (permitida) foi gravada');
  });

  /** Um modelo em laco poderia cancelar a agenda inteira do cliente. */
  it('TETO: recusa alteracoes alem do limite por pedido', async () => {
    const ag = await criarAgendamento({ leadId: ctx.lead1.id, hora: '11:30' });

    const seis = Array.from({ length: LIMITE_ESCRITAS + 1 }, (_, i) => ({
      nome: 'atualizar_agendamento',
      argumentos: { agendamentoId: ag.id, observacoes: `versao ${i}` }
    }));

    const r = await pedirAAtena([{ ferramentas: seis }, { texto: 'ok' }]);

    const recusadas = r.trace.ferramentas.filter((f) => f.resultado.erro);
    assert.equal(recusadas.length, 1, 'so a alteracao acima do teto pode ser recusada');
    assert.match(recusadas[0].resultado.erro, /Limite/);
  });

  it('MODO SOMENTE LEITURA: as ferramentas de escrita nem existem', async () => {
    const antes = (await app.inject({ method: 'GET', url: `/api/agenda?data=${SEGUNDA}`, headers: cab })).json().agendamentos.length;

    const r = await pedirAAtena(
      [
        { ferramentas: [{ nome: 'criar_agendamento', argumentos: { servicoId: ctx.corteSocial.id, profissionalId: ctx.carlos.id, data: SEGUNDA, hora: '18:00' } }] },
        { texto: 'ok' }
      ],
      { permitirEscrita: false }
    );

    assert.ok(!r.chamadas[0].ferramentas.includes('criar_agendamento'), 'a ferramenta nao pode nem ser oferecida ao modelo');
    assert.match(r.trace.ferramentas[0].resultado.erro, /nao existe/);
    assert.match(r.chamadas[0].systemPrompt, /SOMENTE LEITURA/);

    const depois = (await app.inject({ method: 'GET', url: `/api/agenda?data=${SEGUNDA}`, headers: cab })).json().agendamentos.length;
    assert.equal(depois, antes, 'nada pode ter sido criado');
  });
});

// ============================================================================

describe('permissoes configuradas na tela', () => {
  const salvarAtena = (dados) =>
    app.inject({ method: 'PUT', url: '/api/ia/agentes/atena', headers: cab, payload: dados });

  const TODAS = ['catalogo', 'horarios', 'criar', 'editar', 'cancelar', 'funil', 'resumo', 'rotina', 'historico'];

  it('desligar um grupo remove as ferramentas dele', async () => {
    await salvarAtena({ ferramentas: ['catalogo'] });

    const r = await pedirAAtena([{ texto: 'so catalogo' }]);
    assert.deepEqual(r.chamadas[0].ferramentas.sort(), ['listar_profissionais', 'listar_servicos']);

    await salvarAtena({ ferramentas: TODAS });
  });

  it('sem nenhuma permissao, nem chama o modelo (e manda a Sofia nao inventar)', async () => {
    await salvarAtena({ ferramentas: [] });

    const r = await pedirAAtena([{ texto: 'nao deveria rodar' }]);

    assert.equal(r.chamadas.length, 0, 'nao faz sentido gastar uma chamada sem ferramenta nenhuma');
    assert.equal(r.trace.semPermissoes, true);
    assert.match(r.resposta, /Não informe preços/);

    await salvarAtena({ ferramentas: TODAS });
  });

  it('recusa uma permissao que nao existe', async () => {
    const res = await salvarAtena({ ferramentas: ['catalogo', 'apagar_tudo'] });
    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /apagar_tudo/);
  });

  it('Atena desativada: a Sofia perde a delegacao e e avisada', async () => {
    await salvarAtena({ ativo: false });
    const falso = provedorFalso([{ texto: 'Vou chamar alguem.' }]);

    await responder({
      tenantId, conversationId: null, leadId: ctx.lead1.id, leadNome: 'Marcos',
      texto: 'quanto custa?', simulacao: true, modoOverride: 'ia', provedores: falso.provedores
    });

    assert.deepEqual(falso.chamadas[0].ferramentas, ['transferir_para_humano']);
    assert.match(falso.chamadas[0].systemPrompt, /DESATIVADA/);

    await salvarAtena({ ativo: true });
  });

  /**
   * Preco e publico: com a Atena desligada (e ate sem a permissao "catalogo"),
   * a Sofia continua recebendo o catalogo. Antes "quanto custa o corte?" virava
   * transferencia para humano.
   */
  it('Atena desativada: o catalogo continua no prompt e a regra manda usa-lo para preco', async () => {
    const { obterAgente, salvarAgente } = await import('../src/modules/ia/ia.service.js');
    const permissoes = (await obterAgente(tenantId, 'atena')).ferramentas;
    await salvarAgente(tenantId, 'atena', { ativo: false, ferramentas: permissoes.filter((g) => g !== 'catalogo') });
    try {
      const falso = provedorFalso([{ texto: 'O corte social sai por R$ 45,00.' }]);
      await responder({
        tenantId, conversationId: null, leadId: ctx.lead1.id, leadNome: 'Marcos',
        texto: 'quanto custa o corte?', simulacao: true, modoOverride: 'ia', provedores: falso.provedores
      });
      const prompt = falso.chamadas[0].systemPrompt;
      assert.match(prompt, /CATALOGO \(dados verificados/);
      assert.match(prompt, /DESATIVADA\. Preços: use o CATALOGO abaixo/);
      assert.match(prompt, /Horários e\s+agendamentos você NÃO consegue ver nem marcar/);
    } finally {
      await salvarAgente(tenantId, 'atena', { ativo: true, ferramentas: permissoes });
    }
  });

  describe('texto de fabrica antigo da Sofia', () => {
    const promptDa = async (texto) => {
      const falso = provedorFalso([{ texto: 'Oi!' }]);
      await responder({
        tenantId, conversationId: null, leadId: ctx.lead1.id, leadNome: 'Marcos',
        texto, simulacao: true, modoOverride: 'ia', provedores: falso.provedores
      });
      return falso.chamadas[0].systemPrompt;
    };

    it('gravado no banco e nunca editado: a Sofia recebe o texto atual', async () => {
      const { salvarAgente } = await import('../src/modules/ia/ia.service.js');
      const { AGENTES_PADRAO, PROMPTS_ANTIGOS } = await import('../src/ai/agentes-padrao.js');
      await salvarAgente(tenantId, 'atendente', { systemPrompt: PROMPTS_ANTIGOS.atendente[0] });
      try {
        const prompt = await promptDa('oi');
        assert.ok(prompt.includes(AGENTES_PADRAO.atendente.systemPrompt), 'vale o texto atual');
        assert.doesNotMatch(prompt, /você consulta a Atena/, 'a instrucao contraditoria saiu');
      } finally {
        await salvarAgente(tenantId, 'atendente', { systemPrompt: AGENTES_PADRAO.atendente.systemPrompt });
      }
    });

    it('editado pela empresa: o texto dela e preservado', async () => {
      const { salvarAgente } = await import('../src/modules/ia/ia.service.js');
      const { AGENTES_PADRAO, PROMPTS_ANTIGOS } = await import('../src/ai/agentes-padrao.js');
      // Parte do texto antigo + um acrescimo da empresa: NAO e identico, fica como esta.
      const editado = `${PROMPTS_ANTIGOS.atendente[0]} Sempre chame o cliente de "querido".`;
      await salvarAgente(tenantId, 'atendente', { systemPrompt: editado });
      try {
        const prompt = await promptDa('oi');
        assert.ok(prompt.includes(editado), 'o que a empresa escreveu nunca e tocado');
      } finally {
        await salvarAgente(tenantId, 'atendente', { systemPrompt: AGENTES_PADRAO.atendente.systemPrompt });
      }
    });
  });

  it('Sofia desativada: nao chama o modelo, vai para uma pessoa', async () => {
    await app.inject({ method: 'PUT', url: '/api/ia/agentes/atendente', headers: cab, payload: { ativo: false } });
    const falso = provedorFalso([{ texto: 'nao deveria rodar' }]);

    const r = await responder({
      tenantId, conversationId: null, leadId: ctx.lead1.id, leadNome: 'Marcos',
      texto: 'oi', simulacao: true, modoOverride: 'ia', provedores: falso.provedores
    });

    assert.equal(r.respondidoPor, 'fallback_humano');
    assert.equal(falso.chamadas.length, 0, 'ela esta desligada: nao pode gastar IA contra a decisao da empresa');

    await app.inject({ method: 'PUT', url: '/api/ia/agentes/atendente', headers: cab, payload: { ativo: true } });
  });

  /**
   * Um banco criado antes da Atena virar agente nao tem a linha dela.
   * Desativa-la nao pode criar uma Atena sem instrucoes e sem permissoes.
   */
  it('agente que nunca foi salvo herda os valores de fabrica', async () => {
    await ctx.db.delete(ctx.s.agentProfiles).where(eq(ctx.s.agentProfiles.chave, 'atena'));

    const antes = (await app.inject({ method: 'GET', url: '/api/ia/agentes', headers: cab })).json();
    const atenaPadrao = antes.agentes.find((a) => a.chave === 'atena');
    assert.equal(atenaPadrao.padrao, true);
    assert.deepEqual(atenaPadrao.ferramentas.sort(), [...TODAS].sort());

    await salvarAtena({ ativo: false });
    const depois = (await app.inject({ method: 'GET', url: '/api/ia/agentes', headers: cab })).json();
    const atena = depois.agentes.find((a) => a.chave === 'atena');

    assert.equal(atena.ativo, false);
    assert.ok(atena.systemPrompt.includes('Atena'), 'nao pode ter perdido as instrucoes');
    assert.equal(atena.ferramentas.length, TODAS.length, 'nem as permissoes');

    await salvarAtena({ ativo: true });
  });

  it('a listagem traz o catalogo de permissoes e os tons', async () => {
    const corpo = (await app.inject({ method: 'GET', url: '/api/ia/agentes', headers: cab })).json();

    assert.equal(corpo.permissoesAtena.length, TODAS.length);
    assert.ok(corpo.permissoesAtena.every((p) => p.chave && p.rotulo && p.descricao));
    assert.ok(corpo.tons.some((t) => t.chave === 'acolhedor'));
    assert.deepEqual(corpo.agentes.slice(0, 2).map((a) => a.chave), ['atendente', 'atena'], 'frente primeiro, bastidores depois');
  });
});

/**
 * Interruptores POR AGENTE.
 *
 * A Sofia ganhou ferramentas proprias, mas elas obedeciam aos interruptores
 * da Atena (sem a tela dizer). Agora cada agente tem os dele: os da Sofia
 * valem para a Sofia; a Atena desligada so tira dela o "pedir a Atena".
 * Quem nunca mexeu nos interruptores da Sofia continua como estava (derivado
 * da Atena) — os testes acima cobrem esse caso.
 */
describe('cada agente com os interruptores do que ele usa', () => {
  const ia = () => import('../src/modules/ia/ia.service.js');
  const ferramentasDaSofiaAgora = async (texto = 'tem horario?') => {
    const falso = provedorFalso([{ texto: 'Oi!' }]);
    await responder({
      tenantId, conversationId: null, leadId: ctx.lead1.id, leadNome: 'Marcos',
      texto, simulacao: true, modoOverride: 'ia', provedores: falso.provedores
    });
    return { ferramentas: falso.chamadas[0].ferramentas.sort(), prompt: falso.chamadas[0].systemPrompt };
  };

  /** Roda `fn` e devolve Sofia e Atena EXATAMENTE como estavam. */
  async function comAgentesRestaurados(fn) {
    const antes = (await ctx.db.select().from(ctx.s.agentProfiles)).filter((a) => a.tenantId === tenantId);
    try {
      await fn();
    } finally {
      await ctx.db.delete(ctx.s.agentProfiles).where(eq(ctx.s.agentProfiles.tenantId, tenantId));
      if (antes.length) await ctx.db.insert(ctx.s.agentProfiles).values(antes);
    }
  }

  it('a listagem traz os interruptores da Sofia e o que ela tem sempre', async () => {
    const corpo = (await app.inject({ method: 'GET', url: '/api/ia/agentes', headers: cab })).json();
    assert.deepEqual(corpo.permissoesSofia.grupos.map((g) => g.chave), ['horarios', 'agendamentos', 'reservar', 'atena', 'informacoes']);
    assert.ok(corpo.permissoesSofia.grupos.every((g) => g.rotulo && g.descricao));
    assert.deepEqual(corpo.permissoesSofia.fixas.map((f) => f.chave), ['transferir', 'catalogo']);
  });

  it('interruptores da Sofia valem por si: com a Atena desligada ela so perde o "pedir a Atena"', async () => {
    await comAgentesRestaurados(async () => {
      const { salvarAgente } = await ia();
      await salvarAgente(tenantId, 'atendente', { ferramentas: ['horarios', 'agendamentos', 'reservar', 'atena', 'informacoes'] });
      await salvarAgente(tenantId, 'atena', { ativo: false });

      const { ferramentas } = await ferramentasDaSofiaAgora();
      assert.deepEqual(ferramentas, [
        'consultar_agendamentos_do_cliente',
        'consultar_horarios',
        'consultar_varios_servicos',
        'reservar_horario',
        'transferir_para_humano'
      ]);
    });
  });

  it('o "criar" desligado NA ATENA nao tira a reserva da Sofia (sao interruptores de agentes diferentes)', async () => {
    await comAgentesRestaurados(async () => {
      const { salvarAgente } = await ia();
      await salvarAgente(tenantId, 'atendente', { ferramentas: ['horarios', 'reservar'] });
      await salvarAgente(tenantId, 'atena', { ferramentas: ['catalogo'] });

      const { ferramentas } = await ferramentasDaSofiaAgora();
      assert.ok(ferramentas.includes('reservar_horario'));
      assert.ok(ferramentas.includes('consultar_horarios'));
    });
  });

  it('sem "Consultar horarios": nem consulta nem reserva, e o prompt manda para uma pessoa', async () => {
    await comAgentesRestaurados(async () => {
      const { salvarAgente } = await ia();
      await salvarAgente(tenantId, 'atendente', { ferramentas: ['agendamentos', 'reservar', 'atena'] });

      const { ferramentas, prompt } = await ferramentasDaSofiaAgora();
      assert.ok(!ferramentas.includes('consultar_horarios') && !ferramentas.includes('consultar_varios_servicos'));
      assert.ok(!ferramentas.includes('reservar_horario'), 'reservar so marca o que a consulta ofereceu');
      assert.match(prompt, /Horários livres você NÃO consegue ver: para marcar, use transferir_para_humano/);
      assert.match(prompt, /REMARCAR ou CANCELAR: consultar_atena/);
    });
  });

  it('sem "Pedir a Atena": remarcar e cancelar vao para uma pessoa', async () => {
    await comAgentesRestaurados(async () => {
      const { salvarAgente } = await ia();
      await salvarAgente(tenantId, 'atendente', { ferramentas: ['horarios', 'agendamentos', 'reservar'] });

      const { ferramentas, prompt } = await ferramentasDaSofiaAgora();
      assert.ok(!ferramentas.includes('consultar_atena'));
      assert.match(prompt, /MARCAR: reservar_horario/);
      assert.match(prompt, /REMARCAR ou CANCELAR: use transferir_para_humano/);
    });
  });

  it('tudo desligado: sobra so "passar para um atendente", e o preco continua (catalogo)', async () => {
    await comAgentesRestaurados(async () => {
      const { salvarAgente } = await ia();
      await salvarAgente(tenantId, 'atendente', { ferramentas: [] });

      const { ferramentas, prompt } = await ferramentasDaSofiaAgora('quanto custa?');
      assert.deepEqual(ferramentas, ['transferir_para_humano']);
      assert.match(prompt, /agenda está DESATIVADA\. Preços: use o CATALOGO abaixo/);
    });
  });

  it('o interruptor DEV "Agente de agenda" desligado continua tirando toda a agenda da Sofia', async () => {
    const { definirFuncao } = await import('../src/modules/funcoes/funcoes.js');
    await comAgentesRestaurados(async () => {
      const { salvarAgente } = await ia();
      await salvarAgente(tenantId, 'atendente', { ferramentas: ['horarios', 'agendamentos', 'reservar', 'atena', 'informacoes'] });
      await definirFuncao(tenantId, 'agente_atena', false);
      try {
        const { ferramentas } = await ferramentasDaSofiaAgora();
        assert.deepEqual(ferramentas, ['transferir_para_humano'], 'trava de plataforma: a Sofia nao mexe na agenda');
      } finally {
        await definirFuncao(tenantId, 'agente_atena', true);
      }
    });
  });

  it('permissao da Sofia que nao existe e recusada', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/ia/agentes/atendente', headers: cab, payload: { ferramentas: ['horarios', 'apagar_tudo'] } });
    assert.equal(r.statusCode, 422);
    assert.match(r.json().erro.mensagem, /apagar_tudo/);
  });
});
