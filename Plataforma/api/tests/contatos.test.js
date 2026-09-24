import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { receberMensagem, registrarAdaptador } from '../src/channels/gateway.js';

/**
 * A ficha do contato e os filtros de CRM.
 *
 * Tres coisas sao testadas aqui porque as tres mudam o que a empresa VE e o
 * que o cliente RECEBE:
 *
 *   - os filtros inteligentes, que definem quem entra numa campanha;
 *   - a chave de IA por cliente, que decide se um robo ou uma pessoa responde;
 *   - a foto do perfil do WhatsApp, que e copiada de fora para dentro.
 */

let app;
let tenantId;
let dono;
let ctx = {};

/** Cria um contato direto no banco, com o historico que o teste precisa. */
async function contato(nome, { telefone, criadoHa = 0, iaAtiva = true, aceitaCampanha = true } = {}) {
  const leads = await import('../src/modules/leads/leads.service.js');
  const lead = await leads.criar(tenantId, {
    nome,
    telefone: telefone ?? `5511${String(970000000 + ctx.n++).slice(-9)}`,
    iaAtiva,
    aceitaCampanha
  });

  if (criadoHa) {
    await ctx.db
      .update(ctx.s.leads)
      .set({ createdAt: new Date(Date.now() - criadoHa * 86_400_000) })
      .where(eq(ctx.s.leads.id, lead.id));
  }
  return lead;
}

/** Marca um agendamento ja no estado final desejado (concluido, faltou...). */
async function agendamento(leadId, { status, precoCentavos = 5000 }) {
  const { ID } = await import('../src/core/ids.js');
  const [prof] = await ctx.db.select().from(ctx.s.professionals);
  const [serv] = await ctx.db.select().from(ctx.s.services);

  const id = ID.agendamento();
  await ctx.db.insert(ctx.s.appointments).values({
    id,
    tenantId,
    leadId,
    professionalId: prof.id,
    serviceId: serv.id,
    inicioEm: new Date(Date.now() - 86_400_000),
    fimEm: new Date(Date.now() - 86_400_000 + 1_800_000),
    status,
    precoCentavos,
    descontoCentavos: 0
  });
  return id;
}

/** Quais dos contatos criados por este teste o filtro devolve. */
async function filtrar(query) {
  const r = await app.inject({ method: 'GET', url: `/api/leads?${query}&limite=200`, headers: dono.cabecalho });
  assert.equal(r.statusCode, 200, r.body);
  const nomes = r.json().itens.map((c) => c.nome);
  return nomes.filter((n) => n.startsWith('Zt ')).sort();
}

before(async () => {
  ({ app } = await criarAppDeTeste());
  dono = await entrar(app);
  tenantId = dono.usuario.tenantId;
  ctx.n = 0;
  ctx.db = (await import('../src/db/client.js')).db;
  ctx.s = await import('../src/db/schema/index.js');

  ctx.novo = await contato('Zt Novo');
  ctx.antigo = await contato('Zt Antigo', { criadoHa: 60 });
  ctx.fiel = await contato('Zt Fiel', { criadoHa: 60 });
  ctx.faltoso = await contato('Zt Faltoso', { criadoHa: 60 });
  ctx.semIa = await contato('Zt Sem IA', { criadoHa: 60, iaAtiva: false });

  await agendamento(ctx.fiel.id, { status: 'concluido', precoCentavos: 9000 });
  await agendamento(ctx.fiel.id, { status: 'concluido', precoCentavos: 9000 });
  await agendamento(ctx.faltoso.id, { status: 'faltou' });
});

after(async () => {
  await app?.close();
});

describe('filtros inteligentes de CRM', () => {
  it('novos: so quem entrou nos ultimos dias', async () => {
    assert.deepEqual(await filtrar('novosDias=7'), ['Zt Novo']);
  });

  it('nunca agendou: quem so existe no cadastro', async () => {
    assert.deepEqual(await filtrar('semAgendamento=true'), ['Zt Antigo', 'Zt Novo', 'Zt Sem IA']);
  });

  it('recorrentes: a partir de N atendimentos concluidos', async () => {
    assert.deepEqual(await filtrar('minimoConcluidos=2'), ['Zt Fiel']);
    assert.deepEqual(await filtrar('minimoConcluidos=3'), []);
  });

  it('faltosos: quem ja deixou de aparecer', async () => {
    assert.deepEqual(await filtrar('comFaltas=true'), ['Zt Faltoso']);
  });

  it('por gasto: separa quem ja deixou dinheiro', async () => {
    assert.deepEqual(await filtrar('gastoMinimoCentavos=10000'), ['Zt Fiel']);
  });

  it('por IA ligada ou desligada', async () => {
    assert.deepEqual(await filtrar('iaAtiva=false'), ['Zt Sem IA']);
  });

  /**
   * O caso que interessa para campanha: cruzar duas perguntas. Sem isso a
   * pessoa filtraria "recorrentes", exportaria, e conferiria na planilha
   * quem aceita receber.
   */
  it('os filtros se somam, em vez de um substituir o outro', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/leads/${ctx.fiel.id}`,
      headers: dono.cabecalho,
      payload: { aceitaCampanha: false }
    });

    assert.deepEqual(await filtrar('minimoConcluidos=1&aceitaCampanha=true'), []);
    assert.deepEqual(await filtrar('minimoConcluidos=1&aceitaCampanha=false'), ['Zt Fiel']);
  });
});

describe('etiquetas', () => {
  it('a lista de etiquetas sai dos proprios cadastros, com a contagem', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');

    await leads.atualizar(tenantId, ctx.fiel.id, { tags: ['vip', 'barba'] });
    await leads.atualizar(tenantId, ctx.faltoso.id, { tags: ['vip'] });

    const r = await app.inject({ method: 'GET', url: '/api/leads/etiquetas', headers: dono.cabecalho });
    assert.equal(r.statusCode, 200, r.body);

    const etiquetas = r.json().etiquetas;
    const vip = etiquetas.find((e) => e.nome === 'vip');
    const barba = etiquetas.find((e) => e.nome === 'barba');

    assert.equal(vip.total, 2);
    assert.equal(barba.total, 1);
    assert.ok(etiquetas.indexOf(vip) < etiquetas.indexOf(barba), 'a mais usada vem primeiro');
  });

  it('filtrar por etiqueta traz so quem a tem', async () => {
    assert.deepEqual(await filtrar('tag=barba'), ['Zt Fiel']);
    assert.deepEqual(await filtrar('tag=vip'), ['Zt Faltoso', 'Zt Fiel']);
  });

  it('a etiqueta sai da lista quando ninguem mais a usa', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    await leads.atualizar(tenantId, ctx.fiel.id, { tags: ['vip'] });

    const r = await app.inject({ method: 'GET', url: '/api/leads/etiquetas', headers: dono.cabecalho });
    assert.ok(!r.json().etiquetas.some((e) => e.nome === 'barba'));
  });
});

describe('acoes em massa', () => {
  it('desliga a IA de varios contatos de uma vez', async () => {
    const ids = [ctx.novo.id, ctx.antigo.id];
    const r = await app.inject({
      method: 'POST',
      url: '/api/leads/lote',
      headers: dono.cabecalho,
      payload: { ids, iaAtiva: false }
    });

    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().afetados, 2);
    assert.deepEqual(await filtrar('iaAtiva=false'), ['Zt Antigo', 'Zt Novo', 'Zt Sem IA']);

    // Devolve como estava, para nao contaminar os testes seguintes.
    await app.inject({
      method: 'POST',
      url: '/api/leads/lote',
      headers: dono.cabecalho,
      payload: { ids, iaAtiva: true }
    });
  });

  it('recusa um lote que nao diz o que fazer', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/leads/lote',
      headers: dono.cabecalho,
      payload: { ids: [ctx.novo.id] }
    });
    assert.equal(r.statusCode, 400);
  });
});

describe('ficha de cadastro', () => {
  it('guarda o endereco junto do resto do cadastro', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: `/api/leads/${ctx.novo.id}`,
      headers: dono.cabecalho,
      payload: { endereco: 'Rua das Flores, 123 - Centro' }
    });

    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().lead.endereco, 'Rua das Flores, 123 - Centro');
  });
});

describe('a ficha mostra os mesmos numeros da lista', () => {
  it('detalhe traz visitas, gasto e faltas — nao so o cadastro', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');

    const naLista = (await leads.listar(tenantId, { busca: 'Zt Fiel' })).itens[0];
    const naFicha = await leads.obter(tenantId, ctx.fiel.id);

    assert.equal(naFicha.concluidos, naLista.concluidos);
    assert.equal(naFicha.concluidos, 2);
    assert.equal(naFicha.gastoTotalCentavos, 18000);
    assert.equal(naFicha.gastoTotalFormatado, naLista.gastoTotalFormatado);
  });

  it('quem nunca veio aparece zerado, e nao em branco', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const ficha = await leads.obter(tenantId, ctx.antigo.id);

    assert.equal(ficha.concluidos, 0);
    assert.equal(ficha.faltas, 0);
    // O separador que o Intl usa nao e um espaco comum: comparamos pelo formato.
    assert.match(ficha.gastoTotalFormatado, /^R\$\s0,00$/);
  });
});

describe('historico na ficha: agendamentos e atendimentos', () => {
  it('cada agendamento diz QUAL servico foi, e nao so o profissional', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const [serv] = await ctx.db.select().from(ctx.s.services);
    const ficha = await leads.obter(tenantId, ctx.fiel.id);

    assert.ok(ficha.historico.agendamentos.length >= 2);
    for (const a of ficha.historico.agendamentos) {
      assert.equal(a.servicoNome, serv.nome);
      assert.ok(a.fimEm, 'o fim do horario vem junto, para a ficha mostrar a faixa');
    }
  });

  it('as conversas do cliente viram o historico de atendimentos, com resumo e anotacoes', async () => {
    const { ID } = await import('../src/core/ids.js');
    const leads = await import('../src/modules/leads/leads.service.js');
    const cliente = await contato('Zt Atendido');
    const agora = Date.now();

    await ctx.db.insert(ctx.s.conversations).values([
      {
        id: ID.conversa(),
        tenantId,
        leadId: cliente.id,
        status: 'finalizada',
        resumo: 'Pediu o preço do corte e marcou para sábado.',
        anotacoesHumanas: 'Prefere o fim da tarde.',
        ultimaMensagemEm: new Date(agora - 86_400_000),
        finalizadaEm: new Date(agora - 86_000_000)
      },
      {
        id: ID.conversa(),
        tenantId,
        leadId: cliente.id,
        status: 'bot',
        ultimaMensagemEm: new Date(agora)
      }
    ]);

    const { conversas } = (await leads.obter(tenantId, cliente.id)).historico;
    assert.equal(conversas.length, 2);
    // O mais recente primeiro: o atendimento em curso no topo.
    assert.equal(conversas[0].status, 'bot');
    assert.equal(conversas[1].resumo, 'Pediu o preço do corte e marcou para sábado.');
    assert.equal(conversas[1].anotacoesHumanas, 'Prefere o fim da tarde.');
    assert.ok(conversas[1].finalizadaEm);
  });
});

describe('foto do perfil do WhatsApp', () => {
  /** Substitui o `fetch` global pelo que o teste quiser devolver. */
  async function comFetch(resposta, funcao) {
    const original = globalThis.fetch;
    globalThis.fetch = async () => resposta();
    try {
      return await funcao();
    } finally {
      globalThis.fetch = original;
    }
  }

  const pngDeUmPixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  const imagemOk = () =>
    new Response(pngDeUmPixel, { status: 200, headers: { 'content-type': 'image/png' } });

  it('baixa a foto e guarda o ARQUIVO, nao o link que expira', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const alvo = await contato('Zt Com Foto');

    const r = await comFetch(imagemOk, () =>
      leads.sincronizarFoto(tenantId, alvo.id, async () => 'https://wa.exemplo/foto.jpg?assinatura=abc')
    );

    assert.equal(r.ok, true);
    assert.match(r.fotoUrl, /^\/api\/arquivos\/lead-/);

    const salvo = await leads.obter(tenantId, alvo.id);
    assert.equal(salvo.fotoUrl, r.fotoUrl);
    assert.ok(!salvo.fotoUrl.includes('wa.exemplo'), 'o link assinado do WhatsApp nunca vai para o banco');
  });

  it('nao pergunta de novo a cada mensagem de quem nao tem foto', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const alvo = await contato('Zt Sem Foto');

    let perguntas = 0;
    const perguntar = async () => {
      perguntas++;
      return null;
    };

    assert.equal((await leads.sincronizarFoto(tenantId, alvo.id, perguntar)).motivo, 'sem_foto');
    assert.equal((await leads.sincronizarFoto(tenantId, alvo.id, perguntar)).motivo, 'recente');
    assert.equal(perguntas, 1, 'a segunda tentativa nem chega a perguntar ao WhatsApp');
  });

  it('recusa o que nao e imagem (uma pagina de erro nao vira foto)', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const alvo = await contato('Zt Foto Ruim');

    const r = await comFetch(
      () => new Response('<html>erro</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => leads.sincronizarFoto(tenantId, alvo.id, async () => 'https://wa.exemplo/erro')
    );

    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'download_falhou');
    assert.equal((await leads.obter(tenantId, alvo.id)).fotoUrl, null);
  });

  it('a foto aparece na mesa de atendimento junto da conversa', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const conversas = await import('../src/modules/conversas/conversas.service.js');

    const alvo = await contato('Zt Foto no Chat');
    const foto = await comFetch(imagemOk, () =>
      leads.sincronizarFoto(tenantId, alvo.id, async () => 'https://wa.exemplo/foto.jpg')
    );

    const id = await conversas.encontrarOuAbrir(tenantId, { leadId: alvo.id, canal: 'whatsapp' });
    const conversa = await conversas.obter(tenantId, id, dono.usuario);

    assert.equal(conversa.leadFotoUrl, foto.fotoUrl);
  });
});

describe('a foto entra sozinha quando o cliente escreve', () => {
  it('depois de atender, o cadastro fica com a foto do WhatsApp', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const telefone = '5511977005566';
    let pedidas = 0;

    registrarAdaptador('whatsapp', {
      async enviar() {
        return { idExterno: 'foto_1' };
      },
      estaConectada: () => true,
      async fotoDePerfil() {
        pedidas++;
        return 'https://wa.exemplo/perfil.png';
      }
    });

    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64'
        ),
        { status: 200, headers: { 'content-type': 'image/png' } }
      );

    try {
      await receberMensagem({
        tenantId,
        canal: 'whatsapp',
        remetente: telefone,
        texto: 'Bom dia',
        idExterno: 'ct-foto-1',
        sincronizarPerfil: true
      });
    } finally {
      globalThis.fetch = original;
    }

    const { itens } = await leads.listar(tenantId, { busca: telefone });
    assert.equal(pedidas, 1);
    assert.match(itens[0].fotoUrl ?? '', /^\/api\/arquivos\/lead-/);
  });

  it('sem autorizacao do canal, a foto nao e buscada', async () => {
    let pedidas = 0;
    registrarAdaptador('whatsapp', {
      async enviar() {
        return { idExterno: 'foto_2' };
      },
      estaConectada: () => true,
      async fotoDePerfil() {
        pedidas++;
        return 'https://wa.exemplo/perfil.png';
      }
    });

    await receberMensagem({
      tenantId,
      canal: 'whatsapp',
      remetente: '5511977007788',
      texto: 'Oi',
      idExterno: 'ct-foto-2'
      // sem `sincronizarPerfil`: a conexao esta com "sincronizar contatos" desligado
    });

    assert.equal(pedidas, 0);
  });
});

describe('IA desligada para um cliente', () => {
  const enviados = [];

  before(() => {
    registrarAdaptador('whatsapp', {
      async enviar({ destino, texto }) {
        enviados.push({ destino, texto });
        return { idExterno: `ct_${enviados.length}` };
      },
      estaConectada: () => true,
      // O adaptador sabe buscar foto, mas so deve ser chamado quando o canal
      // autoriza sincronizar o perfil.
      fotoDePerfil: async () => null
    });
  });

  it('a mensagem dele vai para a fila humana, e a IA nao responde', async () => {
    enviados.length = 0;
    const telefone = '5511977001122';
    await contato('Zt So Humano', { telefone, iaAtiva: false });

    const r = await receberMensagem({
      tenantId,
      canal: 'whatsapp',
      remetente: telefone,
      texto: 'Oi, quero marcar um horario',
      idExterno: 'ct-msg-1'
    });

    assert.equal(r.respondido, false);
    assert.equal(r.motivo, 'ia_desligada_para_o_cliente');
    assert.equal(enviados.length, 0, 'nenhuma resposta automatica sai para este cliente');

    const [conversa] = await ctx.db
      .select()
      .from(ctx.s.conversations)
      .where(eq(ctx.s.conversations.id, r.conversationId));

    assert.ok(['na_fila', 'humana'].includes(conversa.status), `esperava fila, veio ${conversa.status}`);
  });

  it('religando a IA, o atendimento automatico volta', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const telefone = '5511977003344';
    const alvo = await contato('Zt Volta a IA', { telefone, iaAtiva: false });

    await leads.atualizar(tenantId, alvo.id, { iaAtiva: true });

    const r = await receberMensagem({
      tenantId,
      canal: 'whatsapp',
      remetente: telefone,
      texto: 'Oi',
      idExterno: 'ct-msg-2'
    });

    assert.notEqual(r.motivo, 'ia_desligada_para_o_cliente');
  });
});
