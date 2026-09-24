import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar, instanteDeHoje } from './helpers/ambiente.js';
import { lerHumor } from '../src/ai/humor.js';
import { ErroDeProvedor } from '../src/ai/providers/base.js';

/**
 * Quadro de atendimento, leitura de humor e fechamento do dia.
 *
 * O fio que amarra os tres: um cartao e o mesmo atendimento em momentos
 * diferentes — conversa, depois OS. Os testes aqui existem sobretudo para
 * garantir que ele nao aparece duas vezes e que o fechamento do dia nao
 * inventa faturamento.
 */

let app;
let cabDono;
let dono;
const ctx = {};

/** Provedor de mentira: devolve sempre o mesmo texto. */
function provedorFalso(texto) {
  return {
    impl: {
      nome: 'falso',
      async gerar({ modelo }) {
        if (texto instanceof Error) throw new ErroDeProvedor(texto.message, { provedor: 'falso', modelo });
        return { texto, chamadasDeFerramenta: [], tokens: { entrada: 5, saida: 5 }, modelo };
      }
    },
    apiKey: 'falsa',
    modelos: ['falso-1']
  };
}

async function abrirConversa(texto = 'Oi, queria marcar um corte') {
  const service = await import('../src/modules/conversas/conversas.service.js');
  const { db } = await import('../src/db/client.js');
  const { leads, channelInstances } = await import('../src/db/schema/index.js');

  const todos = await db.select().from(leads);
  const lead = todos[ctx.proximoLead++ % todos.length];
  const [canal] = await db.select().from(channelInstances);

  const id = await service.encontrarOuAbrir(ctx.tenantId, {
    leadId: lead.id,
    canal: 'whatsapp',
    channelInstanceId: canal.id
  });
  await service.registrarRecebida(ctx.tenantId, id, { conteudo: texto });
  return { conversationId: id, lead };
}

/** Cria uma OS ligada (ou nao) a uma conversa, num instante escolhido. */
async function criarOs({ conversationId = null, leadId, inicioEm, status = 'confirmado' }) {
  const { db } = await import('../src/db/client.js');
  const { appointments, services, professionals } = await import('../src/db/schema/index.js');
  const [svc] = await db.select().from(services);
  const [prof] = await db.select().from(professionals);

  const id = `apt_q_${Math.random().toString(36).slice(2)}`;
  await db.insert(appointments).values({
    id,
    tenantId: ctx.tenantId,
    leadId,
    serviceId: svc.id,
    professionalId: prof.id,
    conversationId,
    inicioEm: new Date(inicioEm),
    fimEm: new Date(inicioEm + 30 * 60000),
    status,
    precoCentavos: 5000
  });
  return id;
}

/** Hoje no fuso da empresa — o mesmo dia que o quadro usa por padrao. */
function hoje() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

before(async () => {
  const criado = await criarAppDeTeste();
  app = criado.app;

  const l = await entrar(app);
  cabDono = l.cabecalho;
  dono = l.usuario;
  ctx.tenantId = dono.tenantId;
  ctx.proximoLead = 0;
});

after(async () => {
  await app?.close();
});

describe('quadro de atendimento', () => {
  it('traz as oito colunas, da conversa ate o cancelamento', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/quadro', headers: cabDono });
    assert.equal(res.statusCode, 200);

    const chaves = res.json().colunas.map((c) => c.chave);
    assert.deepEqual(chaves, [
      'novo',
      'entendendo',
      'orcamento',
      'aguardando',
      'confirmado',
      'em_andamento',
      'concluido',
      'cancelado'
    ]);
  });

  it('conversa sem horario marcado vira cartao na etapa dela', async () => {
    const { conversationId } = await abrirConversa('Bom dia!');

    const mover = await app.inject({
      method: 'PATCH',
      url: `/api/conversas/${conversationId}/etapa`,
      headers: cabDono,
      payload: { etapa: 'orcamento' }
    });
    assert.equal(mover.statusCode, 200);

    const quadro = (await app.inject({ method: 'GET', url: '/api/quadro', headers: cabDono })).json();
    const coluna = quadro.colunas.find((c) => c.chave === 'orcamento');

    const cartao = coluna.cartoes.find((c) => c.conversationId === conversationId);
    assert.ok(cartao, 'o cartao devia estar na coluna de orcamento');
    assert.equal(cartao.tipo, 'conversa');
  });

  /**
   * O caso que mais importa: o mesmo atendimento nao pode ocupar duas
   * colunas — uma pela conversa aberta, outra pela OS do dia.
   */
  it('conversa com OS no dia aparece so como cartao da OS', async () => {
    const { conversationId, lead } = await abrirConversa('Quero marcar hoje');
    const osId = await criarOs({
      conversationId,
      leadId: lead.id,
      inicioEm: instanteDeHoje(3600_000),
      status: 'confirmado'
    });

    const quadro = (await app.inject({ method: 'GET', url: '/api/quadro', headers: cabDono })).json();
    const todos = quadro.colunas.flatMap((c) => c.cartoes);

    const daConversa = todos.filter((c) => c.conversationId === conversationId);
    assert.equal(daConversa.length, 1, 'um atendimento, um cartao');
    assert.equal(daConversa[0].tipo, 'os');
    assert.equal(daConversa[0].agendamentoId, osId);
    assert.equal(daConversa[0].coluna, 'confirmado');

    ctx.osConfirmada = osId;
    ctx.conversaComOs = conversationId;
  });

  it('arrastar o cartao muda o status da OS', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/quadro/mover',
      headers: cabDono,
      payload: { cartaoId: `os:${ctx.osConfirmada}`, coluna: 'em_andamento' }
    });

    assert.equal(res.statusCode, 200);
    const cartao = res
      .json()
      .colunas.find((c) => c.chave === 'em_andamento')
      .cartoes.find((c) => c.agendamentoId === ctx.osConfirmada);
    assert.ok(cartao, 'o cartao devia ter ido para Em execucao');

    const os = (await app.inject({ method: 'GET', url: `/api/agenda/${ctx.osConfirmada}`, headers: cabDono })).json();
    assert.equal(os.agendamento.status, 'em_andamento');
  });

  it('recusa jogar uma conversa sem horario nas colunas de execucao', async () => {
    const { conversationId } = await abrirConversa('So uma duvida');

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/quadro/mover',
      headers: cabDono,
      payload: { cartaoId: `conversa:${conversationId}`, coluna: 'em_andamento' }
    });

    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /horario marcado/i);
  });

  it('nao devolve uma OS para as etapas de conversa', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/quadro/mover',
      headers: cabDono,
      payload: { cartaoId: `os:${ctx.osConfirmada}`, coluna: 'entendendo' }
    });

    assert.equal(res.statusCode, 422);
  });
});

describe('cartao pisca quando o cliente espera uma PESSOA', () => {
  const cartaoDa = async (conversationId) => {
    const quadro = (await app.inject({ method: 'GET', url: '/api/quadro', headers: cabDono })).json();
    return quadro.colunas.flatMap((c) => c.cartoes).find((c) => c.conversationId === conversationId);
  };

  const mudarStatus = async (conversationId, status) => {
    const { db } = await import('../src/db/client.js');
    const { conversations } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    await db.update(conversations).set({ status }).where(eq(conversations.id, conversationId));
  };

  const mensagem = async (conversationId, { direcao, autorTipo, emMs }) => {
    const { db } = await import('../src/db/client.js');
    const { messages } = await import('../src/db/schema/index.js');
    await db.insert(messages).values({
      id: `msg_q_${Math.random().toString(36).slice(2)}`,
      tenantId: ctx.tenantId,
      conversationId,
      direcao,
      autorTipo,
      tipo: 'texto',
      conteudo: 'x',
      createdAt: new Date(emMs)
    });
  };

  it('conversa com a Sofia nao pisca: a IA responde sozinha', async () => {
    const { conversationId } = await abrirConversa('Oi');
    assert.equal((await cartaoDa(conversationId)).precisaDeGente, undefined);
  });

  it('na fila humana, ninguem assumiu: pisca', async () => {
    const { conversationId } = await abrirConversa('Quero falar com alguem');
    await mudarStatus(conversationId, 'na_fila');
    assert.equal((await cartaoDa(conversationId)).precisaDeGente, 'na_fila');
  });

  it('com atendente: pisca enquanto a ultima mensagem for do cliente, e para quando ele responde', async () => {
    const { conversationId } = await abrirConversa('Oi');
    await mudarStatus(conversationId, 'humana');
    const agora = Date.now();

    await mensagem(conversationId, { direcao: 'entrada', autorTipo: 'lead', emMs: agora + 1000 });
    assert.equal((await cartaoDa(conversationId)).precisaDeGente, 'sem_resposta');

    // Aviso de sistema ("transferido para...") nao e resposta ao cliente.
    await mensagem(conversationId, { direcao: 'saida', autorTipo: 'sistema', emMs: agora + 2000 });
    assert.equal((await cartaoDa(conversationId)).precisaDeGente, 'sem_resposta');

    await mensagem(conversationId, { direcao: 'saida', autorTipo: 'humano', emMs: agora + 3000 });
    assert.equal((await cartaoDa(conversationId)).precisaDeGente, undefined);
  });
});

describe('fechamento do dia', () => {
  it('arquiva o que encerrou, finaliza a sessao e deixa o resto para decidir', async () => {
    const { conversationId, lead } = await abrirConversa('Obrigado!');
    const concluida = await criarOs({
      conversationId,
      leadId: lead.id,
      inicioEm: instanteDeHoje(-7200_000),
      status: 'concluido'
    });
    const aberta = await criarOs({
      leadId: lead.id,
      inicioEm: instanteDeHoje(-3600_000),
      status: 'confirmado'
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/quadro/fechar-dia',
      headers: cabDono,
      payload: { data: hoje() }
    });

    assert.equal(res.statusCode, 200);
    const r = res.json();

    assert.ok(r.arquivadas >= 1);
    assert.ok(r.conversasFinalizadas >= 1);

    // A OS confirmada que ninguem encerrou NAO vira faturamento sozinha.
    assert.ok(r.pendentes.some((p) => p.id === aberta), 'a confirmada devia voltar como pendente');

    const daConcluida = (
      await app.inject({ method: 'GET', url: `/api/agenda/${concluida}`, headers: cabDono })
    ).json().agendamento;
    assert.ok(daConcluida.arquivadoEm, 'a concluida devia ter sido arquivada');

    const conversa = (
      await app.inject({ method: 'GET', url: `/api/conversas/${conversationId}`, headers: cabDono })
    ).json().conversa;
    assert.equal(conversa.status, 'finalizada');

    const daAberta = (
      await app.inject({ method: 'GET', url: `/api/agenda/${aberta}`, headers: cabDono })
    ).json().agendamento;
    assert.equal(daAberta.status, 'confirmado');
    assert.equal(daAberta.arquivadoEm, null);
  });

  it('arquivar uma OS que ainda vai acontecer e recusado', async () => {
    const { lead } = await abrirConversa('Semana que vem');
    const futura = await criarOs({
      leadId: lead.id,
      inicioEm: Date.now() + 5 * 86400_000,
      status: 'confirmado'
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/agenda/${futura}/arquivar`,
      headers: cabDono,
      payload: {}
    });

    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /encerrado/i);
  });
});

describe('leitura de humor', () => {
  const dialogo = [
    { papel: 'user', conteudo: 'Ja e a terceira vez que eu peco pra remarcar e ninguem responde' },
    { papel: 'assistant', conteudo: 'Desculpe pela demora! Vou verificar agora mesmo.' },
    { papel: 'user', conteudo: 'Se for assim eu prefiro cancelar tudo' }
  ];

  it('entende o JSON do modelo e aceita so os quatro estados', async () => {
    const r = await lerHumor({
      tenantId: ctx.tenantId,
      historico: dialogo,
      leadNome: 'Joao',
      provedores: [provedorFalso('{"humor":"frustrado","resumo":"Cliente esperando remarcacao ha dias."}')]
    });

    assert.equal(r.humor, 'frustrado');
    assert.match(r.resumo, /remarcacao/i);
  });

  it('aceita o JSON mesmo vindo embrulhado em markdown', async () => {
    const r = await lerHumor({
      tenantId: ctx.tenantId,
      historico: dialogo,
      provedores: [provedorFalso('```json\n{"humor":"neutro","resumo":"Resolvendo."}\n```')]
    });

    assert.equal(r.humor, 'neutro');
  });

  it('devolve nulo quando o modelo inventa um humor fora da lista', async () => {
    const r = await lerHumor({
      tenantId: ctx.tenantId,
      historico: dialogo,
      provedores: [provedorFalso('{"humor":"furioso","resumo":"..."}')]
    });

    assert.equal(r, null);
  });

  it('nao chama o modelo por uma conversa curta demais para ter humor', async () => {
    let chamou = false;
    const provedor = provedorFalso('{"humor":"neutro","resumo":"x"}');
    const gerarOriginal = provedor.impl.gerar;
    provedor.impl.gerar = async (...args) => {
      chamou = true;
      return gerarOriginal(...args);
    };

    const r = await lerHumor({
      tenantId: ctx.tenantId,
      historico: [{ papel: 'user', conteudo: 'oi' }],
      provedores: [provedor]
    });

    assert.equal(r, null);
    assert.equal(chamou, false, 'nao pode gastar uma chamada com "oi"');
  });

  it('grava o humor na conversa e espelha no cadastro do cliente', async () => {
    const { conversationId, lead } = await abrirConversa('Adorei o atendimento de ontem!');
    const service = await import('../src/modules/conversas/conversas.service.js');

    await service.registrarHumor(ctx.tenantId, conversationId, {
      humor: 'satisfeito',
      resumo: 'Cliente elogiou o atendimento.',
      numeroDaMensagem: 1
    });

    const conversa = (
      await app.inject({ method: 'GET', url: `/api/conversas/${conversationId}`, headers: cabDono })
    ).json().conversa;
    assert.equal(conversa.humor, 'satisfeito');
    assert.match(conversa.humorResumo, /elogiou/i);

    const doLead = (await app.inject({ method: 'GET', url: `/api/leads/${lead.id}`, headers: cabDono })).json();
    assert.equal(doLead.lead.humor, 'satisfeito');
  });
});

describe('anotacoes do atendimento', () => {
  it('anotacao de gente e resumo da IA chegam separados na OS', async () => {
    const { conversationId, lead } = await abrirConversa('Pode ser as 15h?');
    const osId = await criarOs({
      conversationId,
      leadId: lead.id,
      inicioEm: instanteDeHoje(-3600_000),
      status: 'em_andamento'
    });

    const service = await import('../src/modules/conversas/conversas.service.js');
    await service.registrarHumor(ctx.tenantId, conversationId, { humor: 'satisfeito', resumo: 'Tudo certo.' });

    await app.inject({
      method: 'PATCH',
      url: `/api/conversas/${conversationId}/anotacoes`,
      headers: cabDono,
      payload: { texto: 'Cliente pediu maquina 2 nas laterais.' }
    });

    await app.inject({
      method: 'POST',
      url: `/api/conversas/${conversationId}/finalizar`,
      headers: cabDono,
      payload: { resumo: 'Corte feito, cliente satisfeito.' }
    });

    const os = (await app.inject({ method: 'GET', url: `/api/agenda/${osId}`, headers: cabDono })).json().agendamento;

    assert.equal(os.resumoAtendimento, 'Corte feito, cliente satisfeito.');
    assert.match(os.anotacoesAtendimento, /maquina 2/i);
    assert.equal(os.humorAtendimento, 'satisfeito');
    assert.equal(os.status, 'concluido', 'o horario ja tinha comecado');
  });
});
