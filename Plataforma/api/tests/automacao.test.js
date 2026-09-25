import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar, instanteDeHoje } from './helpers/ambiente.js';
import { ErroDeProvedor } from '../src/ai/providers/base.js';
import { consultarAtena } from '../src/ai/atena.js';
import { etapaDoFato } from '../src/automacao/funil.js';
import { executarComando } from '../src/automacao/comando.js';
import { fecharDiaSeForHora } from '../src/automacao/rotinas.js';
import { emitir, EVENTOS, totalAssinantes } from '../src/core/eventos.js';
import { dataNoFuso, somarDias } from '../src/core/datetime.js';

/**
 * A Atena trabalhando por conta propria.
 *
 * Nenhum teste chama um modelo de verdade: um provedor de mentira segue um
 * roteiro, e o resto — regras, banco, permissoes — roda de verdade. O foco e
 * o que o dono da empresa espera: o quadro anda sozinho, o resumo aparece, o
 * dia fecha, e NADA disso acontece quando ele desligou a permissao.
 */

const FUSO = 'America/Sao_Paulo';

let app;
let cab;
let tenantId;
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

function provedorFalso(roteiro) {
  const chamadas = [];
  let i = 0;
  const impl = {
    nome: 'falso',
    async gerar({ modelo, systemPrompt, mensagens, ferramentas }) {
      chamadas.push({ systemPrompt, ferramentas: (ferramentas ?? []).map((f) => f.nome), mensagens: mensagens.map((m) => ({ ...m })) });
      const passo = roteiro[Math.min(i++, roteiro.length - 1)];
      if (passo.erro) throw new ErroDeProvedor(passo.erro, { provedor: 'falso', modelo, reTentavel: true });
      return { texto: passo.texto ?? '', chamadasDeFerramenta: passo.ferramentas ?? [], tokens: { entrada: 10, saida: 5 }, modelo };
    }
  };
  return { provedores: [{ impl, apiKey: 'x', modelos: ['m'] }], chamadas };
}

/** Espera uma condicao que depende de uma automacao em segundo plano. */
async function esperar(condicao, { tentativas = 40, passoMs = 25 } = {}) {
  for (let i = 0; i < tentativas; i++) {
    if (await condicao()) return true;
    await new Promise((r) => setTimeout(r, passoMs));
  }
  return false;
}

const salvarAtena = (dados) =>
  app.inject({ method: 'PUT', url: '/api/ia/agentes/atena', headers: cab, payload: dados });

const TODAS = ['catalogo', 'horarios', 'criar', 'editar', 'cancelar', 'funil', 'resumo', 'rotina', 'historico'];

async function novaConversa() {
  const conv = await import('../src/modules/conversas/conversas.service.js');
  const { db } = await import('../src/db/client.js');
  const { leads, channelInstances } = await import('../src/db/schema/index.js');

  const todos = await db.select().from(leads);
  const lead = todos[ctx.proximo++ % todos.length];
  const [canal] = await db.select().from(channelInstances);

  const id = await conv.encontrarOuAbrir(tenantId, { leadId: lead.id, canal: 'whatsapp', channelInstanceId: canal.id });
  await conv.registrarRecebida(tenantId, id, { conteudo: 'Oi, queria cortar o cabelo na segunda de manha com o Carlos' });
  return { id, lead };
}

const etapaDe = async (id) => (await app.inject({ method: 'GET', url: `/api/conversas/${id}`, headers: cab })).json().conversa.etapaAtendimento;

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cab, usuario: ctx.usuario } = await entrar(app));
  tenantId = ctx.usuario.tenantId;
  ctx.proximo = 0;

  const { db } = await import('../src/db/client.js');
  const s = await import('../src/db/schema/index.js');
  const [t] = await db.select().from(s.tenants);
  tenantId = t.id;
  ctx.db = db;
  ctx.s = s;

  // O seed nao liga os grupos novos; a empresa liga na Central de IA.
  const r = await salvarAtena({ ferramentas: TODAS });
  assert.equal(r.statusCode, 200, r.body);
});

after(async () => {
  await app?.close();
});

describe('funil: as regras que movem o cartao', () => {
  it('cada fato da Atena corresponde a uma etapa', () => {
    assert.equal(etapaDoFato('listar_servicos', { servicos: [] }), 'entendendo');
    assert.equal(etapaDoFato('consultar_horarios', { horariosLivres: ['09:00'] }), 'orcamento');
    // Consulta que voltou vazia nao e orcamento: nao havia o que oferecer.
    assert.equal(etapaDoFato('consultar_horarios', { horariosLivres: [] }), null);
    // Erro nao e fato.
    assert.equal(etapaDoFato('listar_servicos', { erro: 'x' }), null);
    assert.equal(etapaDoFato('cancelar_agendamento', { sucesso: true }), null);
  });

  it('a Atena consulta horarios e o cartao avanca sozinho, sem ninguem mandar', async () => {
    const { id } = await novaConversa();
    assert.equal(await etapaDe(id), 'novo');

    const falso = provedorFalso([
      { ferramentas: [{ nome: 'consultar_horarios', argumentos: { servicoId: 'Corte Social', profissionalId: 'Carlos', data: SEGUNDA } }] },
      { texto: 'Horarios livres: 09:00, 09:30.' }
    ]);

    await consultarAtena({
      tenantId, pedido: 'horarios?', leadId: ctx.usuario && (await ctx.db.select().from(ctx.s.leads))[0].id,
      fuso: FUSO, conversationId: id, provedores: falso.provedores
    });

    assert.ok(await esperar(async () => (await etapaDe(id)) === 'orcamento'), 'o cartao devia ter ido para "orcamento"');
  });

  it('so avanca, nunca recua', async () => {
    const { id } = await novaConversa();
    const { avancarEtapa } = await import('../src/automacao/funil.js');

    assert.equal(await avancarEtapa(tenantId, id, 'aguardando'), true);
    // Um fato "menor" chega depois: o cartao nao pode voltar.
    assert.equal(await avancarEtapa(tenantId, id, 'entendendo'), false);
    assert.equal(await etapaDe(id), 'aguardando');
  });

  it('com a permissao desligada, a Atena nao mexe no quadro', async () => {
    await salvarAtena({ ferramentas: TODAS.filter((g) => g !== 'funil') });
    try {
      const { id } = await novaConversa();
      const { avancarEtapa } = await import('../src/automacao/funil.js');

      assert.equal(await avancarEtapa(tenantId, id, 'orcamento'), false);
      assert.equal(await etapaDe(id), 'novo', 'a empresa desligou; a Atena obedece, mesmo sendo regra e nao modelo');
    } finally {
      await salvarAtena({ ferramentas: TODAS });
    }
  });

  it('nao mexe em conversa ja finalizada', async () => {
    const { id } = await novaConversa();
    await app.inject({ method: 'POST', url: `/api/conversas/${id}/finalizar`, headers: cab, payload: { resumo: 'ok' } });

    const { avancarEtapa } = await import('../src/automacao/funil.js');
    assert.equal(await avancarEtapa(tenantId, id, 'orcamento'), false);
  });
});

describe('resumo automatico ao finalizar', () => {
  const finalizarComIa = async (id, texto) => {
    const conv = await import('../src/modules/conversas/conversas.service.js');
    const falso = provedorFalso([{ texto }]);
    await conv.finalizar(tenantId, id, {}, { ...ctx.usuario }, { provedores: falso.provedores });
    return { falso, conversa: await conv.obter(tenantId, id) };
  };

  it('a Atena escreve o resumo quando ninguem escreveu', async () => {
    const { id } = await novaConversa();
    const { falso, conversa } = await finalizarComIa(id, 'Cliente quer corte na segunda; nenhum horario foi fechado.');

    assert.equal(conversa.status, 'finalizada');
    assert.match(conversa.resumo, /corte na segunda/i);
    assert.equal(falso.chamadas.length, 1, 'uma unica chamada de IA');
  });

  it('o resumo digitado por gente tem preferencia e nao gasta IA', async () => {
    const { id } = await novaConversa();
    const conv = await import('../src/modules/conversas/conversas.service.js');
    const falso = provedorFalso([{ texto: 'NAO DEVIA SER USADO' }]);

    await conv.finalizar(tenantId, id, { resumo: 'Resumo do atendente.' }, { ...ctx.usuario }, { provedores: falso.provedores });

    assert.equal((await conv.obter(tenantId, id)).resumo, 'Resumo do atendente.');
    assert.equal(falso.chamadas.length, 0);
  });

  it('o resumo vai para a OS junto com o encerramento', async () => {
    const { id, lead } = await novaConversa();
    const osId = `apt_auto_${Math.random().toString(36).slice(2)}`;
    const [svc] = await ctx.db.select().from(ctx.s.services);
    const [prof] = await ctx.db.select().from(ctx.s.professionals);
    await ctx.db.insert(ctx.s.appointments).values({
      id: osId, tenantId, leadId: lead.id, serviceId: svc.id, professionalId: prof.id, conversationId: id,
      inicioEm: new Date(instanteDeHoje(-3600_000)), fimEm: new Date(instanteDeHoje(-3600_000) + 1800_000), status: 'em_andamento', precoCentavos: 4500
    });

    await finalizarComIa(id, 'Corte social feito com o Carlos; cliente satisfeito.');

    const os = (await app.inject({ method: 'GET', url: `/api/agenda/${osId}`, headers: cab })).json().agendamento;
    assert.match(os.resumoAtendimento, /Corte social feito/);
    assert.equal(os.status, 'concluido');
  });

  it('desligado nas permissoes: finaliza sem resumo e sem gastar IA', async () => {
    await salvarAtena({ ferramentas: TODAS.filter((g) => g !== 'resumo') });
    try {
      const { id } = await novaConversa();
      const { falso, conversa } = await finalizarComIa(id, 'NAO DEVIA SER USADO');
      assert.equal(conversa.status, 'finalizada');
      assert.equal(conversa.resumo, null);
      assert.equal(falso.chamadas.length, 0);
    } finally {
      await salvarAtena({ ferramentas: TODAS });
    }
  });

  it('se a IA falha, o atendimento finaliza do mesmo jeito', async () => {
    const { id } = await novaConversa();
    const conv = await import('../src/modules/conversas/conversas.service.js');
    const falso = provedorFalso([{ erro: 'HTTP 429: cota excedida' }]);

    await conv.finalizar(tenantId, id, {}, { ...ctx.usuario }, { provedores: falso.provedores });
    assert.equal((await conv.obter(tenantId, id)).status, 'finalizada');
  });
});

describe('o quadro depois de finalizar', () => {
  const quadro = async () => (await app.inject({ method: 'GET', url: '/api/quadro', headers: cab })).json();
  const cartoesDa = (q, conversationId) => q.colunas.flatMap((c) => c.cartoes).filter((c) => c.conversationId === conversationId);

  it('conversa sem horario marcado sai do quadro ao finalizar', async () => {
    const { id } = await novaConversa();
    assert.equal(cartoesDa(await quadro(), id).length, 1);

    await app.inject({ method: 'POST', url: `/api/conversas/${id}/finalizar`, headers: cab, payload: { resumo: 'Sem interesse.' } });
    assert.equal(cartoesDa(await quadro(), id).length, 0, 'finalizou sem OS: nao ha o que mostrar');
  });

  it('com OS marcada para hoje, continua como cartao da OS, na coluna do status', async (t) => {
    // Precisa de uma OS que AINDA vai acontecer HOJE. Ate 23:50 da; nos
    // ultimos minutos do dia nao existe esse horario, e o teste nao se aplica.
    const fimDeHoje = new Date(`${dataNoFuso(Date.now(), FUSO)}T23:50:00-03:00`).getTime();
    const inicio = Math.min(Date.now() + 3600_000, fimDeHoje);
    if (inicio - Date.now() < 5 * 60_000) return t.skip('perto da meia-noite: nao ha horario futuro hoje');

    const { id, lead } = await novaConversa();
    const [svc] = await ctx.db.select().from(ctx.s.services);
    const [prof] = await ctx.db.select().from(ctx.s.professionals);
    await ctx.db.insert(ctx.s.appointments).values({
      id: `apt_q_${Math.random().toString(36).slice(2)}`, tenantId, leadId: lead.id, serviceId: svc.id, professionalId: prof.id,
      conversationId: id, inicioEm: new Date(inicio), fimEm: new Date(inicio + 5 * 60_000),
      status: 'confirmado', precoCentavos: 4500
    });

    await app.inject({ method: 'POST', url: `/api/conversas/${id}/finalizar`, headers: cab, payload: { resumo: 'Fechado.' } });

    const restantes = cartoesDa(await quadro(), id);
    assert.equal(restantes.length, 1);
    assert.equal(restantes[0].tipo, 'os');
    assert.equal(restantes[0].coluna, 'confirmado', 'a OS ainda vai acontecer: fica em Confirmados');
  });
});

describe('rotina: a Atena fecha o dia sozinha', () => {
  /** Uma hora local de "depois do fechamento" (23:30) no dia de hoje. */
  const noite = () => {
    const hoje = dataNoFuso(Date.now(), FUSO);
    return new Date(`${hoje}T23:30:00-03:00`).getTime();
  };
  const manha = () => new Date(`${dataNoFuso(Date.now(), FUSO)}T09:00:00-03:00`).getTime();

  it('antes do horario, nao faz nada', async () => {
    assert.equal(await fecharDiaSeForHora(tenantId, manha()), null);
  });

  it('sem a permissao "Fechar o dia sozinha", nao faz nada mesmo na hora', async () => {
    await salvarAtena({ ferramentas: TODAS.filter((g) => g !== 'rotina') });
    try {
      assert.equal(await fecharDiaSeForHora(tenantId, noite()), null);
    } finally {
      await salvarAtena({ ferramentas: TODAS });
    }
  });

  it('na hora, fecha o dia: arquiva o que terminou e encerra conversa ociosa', async () => {
    const { id: ociosa } = await novaConversa();
    // Parada ha 8 horas: ninguem responde ha muito tempo.
    await ctx.db
      .update(ctx.s.conversations)
      .set({ ultimaMensagemEm: new Date(Date.now() - 8 * 3_600_000) })
      .where((await import('drizzle-orm')).eq(ctx.s.conversations.id, ociosa));

    const { id: recente } = await novaConversa(); // acabou de chegar: nao pode ser fechada

    const r = await fecharDiaSeForHora(tenantId, noite());
    assert.ok(r, 'devia ter fechado');
    assert.ok(r.ociosasFinalizadas >= 1, 'a conversa parada devia ter sido finalizada');

    const status = async (id) => (await app.inject({ method: 'GET', url: `/api/conversas/${id}`, headers: cab })).json().conversa.status;
    assert.equal(await status(ociosa), 'finalizada');
    assert.notEqual(await status(recente), 'finalizada', 'conversa recente nunca e fechada pela rotina');
  });

  it('fecha UMA vez por dia, mesmo se o relogio disparar de novo', async () => {
    assert.equal(await fecharDiaSeForHora(tenantId, noite()), null, 'ja fechou hoje');
  });

  /**
   * BUG reproduzido: a rotina finalizava a conversa parada e, junto, CONCLUIA
   * a OS cujo horario ja tinha passado — o cliente que faltou virava
   * "concluido" e entrava no faturamento e na comissao. A rotina nao sabe se
   * ele veio: a OS fica aberta para uma pessoa decidir.
   */
  it('encerrar a conversa ociosa NAO conclui a OS que ja passou (pode ter sido falta)', async () => {
    const { eq, and } = await import('drizzle-orm');
    const leads = await import('../src/modules/leads/leads.service.js');
    const conv = await import('../src/modules/conversas/conversas.service.js');

    // Cliente e conversa proprios deste teste.
    const lead = await leads.criar(tenantId, { nome: 'Faltou Teste', telefone: '5511955509901' });
    const id = await conv.encontrarOuAbrir(tenantId, { leadId: lead.id });
    await conv.registrarRecebida(tenantId, id, { conteudo: 'Pode ser as 10h amanha' });
    await ctx.db
      .update(ctx.s.conversations)
      .set({ status: 'bot', ultimaMensagemEm: new Date(Date.now() - 8 * 3_600_000) })
      .where(eq(ctx.s.conversations.id, id));

    // OS marcada pela Sofia, confirmada, com o horario ja passado.
    const osId = `apt_falta_${Math.random().toString(36).slice(2)}`;
    const [svc] = await ctx.db.select().from(ctx.s.services);
    const [prof] = await ctx.db.select().from(ctx.s.professionals);
    const inicio = instanteDeHoje(-2 * 3_600_000);
    await ctx.db.insert(ctx.s.appointments).values({
      id: osId, tenantId, leadId: lead.id, serviceId: svc.id, professionalId: prof.id, conversationId: id,
      inicioEm: new Date(inicio), fimEm: new Date(inicio + 1_800_000), status: 'confirmado', criadoPor: 'ia', precoCentavos: 4500
    });

    // O dia ja foi fechado no teste anterior: apaga a marca para a rotina rodar de novo.
    await ctx.db
      .delete(ctx.s.settings)
      .where(and(eq(ctx.s.settings.tenantId, tenantId), eq(ctx.s.settings.chave, 'fechamento_ultimo')));
    const quaseMeiaNoite = new Date(`${dataNoFuso(Date.now(), FUSO)}T23:59:00-03:00`).getTime();
    const r = await fecharDiaSeForHora(tenantId, quaseMeiaNoite);
    assert.ok(r, 'devia ter fechado');

    assert.equal((await conv.obter(tenantId, id)).status, 'finalizada', 'a conversa parada foi encerrada');
    const os = (await app.inject({ method: 'GET', url: `/api/agenda/${osId}`, headers: cab })).json().agendamento;
    assert.equal(os.status, 'confirmado', 'a rotina nao sabe se o cliente veio: nao conclui');
    assert.equal(os.concluidoEm, null);
  });
});

describe('comando direto a Atena', () => {
  it('a Atena executa o pedido do atendente e o registro fica na conversa', async () => {
    const { id } = await novaConversa();
    const falso = provedorFalso([
      { ferramentas: [{ nome: 'consultar_horarios', argumentos: { servicoId: 'Corte Social', data: SEGUNDA } }] },
      { texto: 'Segunda ha horarios livres com Carlos e Julia.' }
    ]);

    const r = await executarComando({
      tenantId, conversationId: id, comando: 'ver horarios de segunda', usuario: { nome: 'Recepcao' }, provedores: falso.provedores
    });

    assert.match(r.resposta, /horarios livres/i);
    assert.ok(r.ferramentas.some((f) => f.nome === 'consultar_horarios' && f.ok));

    // O pedido chegou a ela com o autor identificado.
    assert.match(falso.chamadas[0].mensagens[0].conteudo, /atendente Recepcao/);

    // Ficou registrado na conversa, como aviso de sistema (o cliente nunca ve).
    const { mensagens } = (await app.inject({ method: 'GET', url: `/api/conversas/${id}/mensagens`, headers: cab })).json();
    const aviso = mensagens.find((m) => m.metadados?.atena);
    assert.ok(aviso, 'o comando devia ficar registrado na conversa');
    assert.equal(aviso.autorTipo, 'sistema');
    assert.match(aviso.conteudo, /Recepcao/);
  });

  it('obedece as permissoes: o que a empresa desligou continua desligado', async () => {
    await salvarAtena({ ferramentas: ['catalogo'] });
    try {
      const { id } = await novaConversa();
      const falso = provedorFalso([{ texto: 'ok' }]);
      await executarComando({ tenantId, conversationId: id, comando: 'cancela tudo', usuario: { nome: 'Dono' }, provedores: falso.provedores });

      // A Atena so recebeu as ferramentas de catalogo: nao ha como cancelar.
      assert.deepEqual(falso.chamadas[0].ferramentas.sort(), ['listar_profissionais', 'listar_servicos']);
    } finally {
      await salvarAtena({ ferramentas: TODAS });
    }
  });

  it('recusa comando em conversa finalizada e comando vazio', async () => {
    const { id } = await novaConversa();
    await app.inject({ method: 'POST', url: `/api/conversas/${id}/finalizar`, headers: cab, payload: { resumo: 'x' } });

    await assert.rejects(
      executarComando({ tenantId, conversationId: id, comando: 'remarca', usuario: { nome: 'A' } }),
      /finalizada/i
    );
    await assert.rejects(executarComando({ tenantId, conversationId: id, comando: '  ', usuario: { nome: 'A' } }), /Diga o que/i);
  });

  it('a rota exige login', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/atena/comando', payload: { conversationId: 'x', comando: 'y' } });
    assert.equal(res.statusCode, 401);
  });
});

describe('ferramentas por nome (menos voltas, menos tokens)', () => {
  const chamarTool = async (roteiro) => {
    const r = await consultarAtena({
      tenantId, pedido: 'p', leadId: (await ctx.db.select().from(ctx.s.leads))[0].id, fuso: FUSO,
      provedores: provedorFalso(roteiro).provedores
    });
    return r.trace.ferramentas[0].resultado;
  };

  it('consulta horarios pelo NOME do servico e do profissional, sem listar antes', async () => {
    const r = await chamarTool([
      { ferramentas: [{ nome: 'consultar_horarios', argumentos: { servicoId: 'corte social', profissionalId: 'carlos', data: SEGUNDA } }] },
      { texto: 'ok' }
    ]);
    assert.equal(r.profissional, 'Carlos Mendes');
    assert.ok(r.horariosLivres.length > 0);
  });

  it('sem profissional, devolve todos numa chamada so', async () => {
    const r = await chamarTool([
      { ferramentas: [{ nome: 'consultar_horarios', argumentos: { servicoId: 'Corte Social', data: SEGUNDA } }] },
      { texto: 'ok' }
    ]);
    assert.ok(Array.isArray(r.porProfissional) || r.profissional, 'devia trazer os profissionais que fazem o servico');
  });

  it('nome ambiguo vira pergunta, nunca um servico escolhido no chute', async () => {
    const r = await chamarTool([
      { ferramentas: [{ nome: 'consultar_horarios', argumentos: { servicoId: 'corte', data: SEGUNDA } }] },
      { texto: 'ok' }
    ]);
    assert.match(r.erro, /pode ser:/);
  });

  it('listar_servicos vem sem ids e mais curto', async () => {
    const r = await chamarTool([{ ferramentas: [{ nome: 'listar_servicos', argumentos: {} }] }, { texto: 'ok' }]);
    const texto = JSON.stringify(r);
    assert.doesNotMatch(texto, /svc_|prof_/, 'ids so gastam tokens: o modelo trabalha com nomes');
    assert.ok(r.servicos[0].preco);
  });

  it('catalogo editado aparece na hora (cache invalidado)', async () => {
    const antes = await chamarTool([{ ferramentas: [{ nome: 'listar_servicos', argumentos: { busca: 'pezinho' } }] }, { texto: 'ok' }]);
    const { servicos } = (await app.inject({ method: 'GET', url: '/api/servicos', headers: cab })).json();
    const pezinho = servicos.find((s) => s.nome === 'Pezinho');

    const patch = await app.inject({ method: 'PATCH', url: `/api/servicos/${pezinho.id}`, headers: cab, payload: { precoCentavos: 3333 } });
    assert.equal(patch.statusCode, 200);

    const depois = await chamarTool([{ ferramentas: [{ nome: 'listar_servicos', argumentos: { busca: 'pezinho' } }] }, { texto: 'ok' }]);
    assert.notEqual(antes.servicos[0].preco, depois.servicos[0].preco);
    assert.match(depois.servicos[0].preco, /33,33/);
  });
});

describe('tempo real (SSE)', () => {
  it('a tela recebe o aviso quando uma conversa muda', async () => {
    const porta = await app.listen({ port: 0, host: '127.0.0.1' }).then((u) => new URL(u).port);
    const controle = new AbortController();

    const res = await fetch(`http://127.0.0.1:${porta}/api/eventos`, { headers: cab, signal: controle.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(totalAssinantes(), 1);

    const leitor = res.body.getReader();
    const dec = new TextDecoder();
    let recebido = '';
    const ler = (async () => {
      while (!recebido.includes('conversa.mudou')) {
        const { value, done } = await leitor.read();
        if (done) break;
        recebido += dec.decode(value);
      }
    })();

    emitir(EVENTOS.CONVERSA, { tenantId, id: 'conv_x' });
    await Promise.race([ler, new Promise((_, rej) => setTimeout(() => rej(new Error('nenhum aviso chegou')), 2000))]);

    assert.match(recebido, /event: conversa\.mudou/);
    // O canal so avisa: nenhum dado trafega por ele.
    assert.doesNotMatch(recebido, /conv_x/);

    controle.abort();
    await esperar(() => totalAssinantes() === 0);
    assert.equal(totalAssinantes(), 0, 'desconectou: nao pode vazar assinante');
  });

  it('nao entrega aviso de outra empresa', async () => {
    const recebidos = [];
    const { assinar } = await import('../src/core/eventos.js');
    const cancelar = assinar('tnt_outra_empresa', (e) => recebidos.push(e));

    emitir(EVENTOS.CONVERSA, { tenantId, id: 'x' });
    await new Promise((r) => setTimeout(r, 150));
    cancelar();

    assert.equal(recebidos.length, 0);
  });

  it('exige login', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/eventos' });
    assert.equal(res.statusCode, 401);
  });
});
