import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { abrirACasa, criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { Agrupador } from '../src/modules/atendimento/agrupador.js';
import { COMANDOS_DO_MENU, fluxoPadrao, iaConduzindo, passoDoFluxo } from '../src/modules/atendimento/fluxo.js';

let app;
let tenantId;
let cabDono;

/** Substitui a cascata de IA por um dublê, para testar sem chave nem rede. */
async function comIaFalsa(roteiro, fn) {
  const cascade = await import('../src/ai/cascade.js');
  const original = cascade.gerar;

  let chamada = 0;
  // Trocamos a exportacao do modulo em tempo de execucao. Funciona porque
  // `agente.js` chama `gerar` atraves do objeto do modulo.
  const modulo = await import('../src/ai/agente.js');

  const provedor = {
    impl: {
      nome: 'falso',
      async gerar({ modelo }) {
        const passo = roteiro[Math.min(chamada++, roteiro.length - 1)];
        if (passo.erro) {
          const { ErroDeProvedor } = await import('../src/ai/providers/base.js');
          throw new ErroDeProvedor(passo.erro, { provedor: 'falso', reTentavel: true });
        }
        return {
          texto: passo.texto ?? '',
          chamadasDeFerramenta: passo.ferramentas ?? [],
          tokens: { entrada: 5, saida: 5 },
          modelo
        };
      }
    },
    apiKey: 'x',
    modelos: ['modelo-falso']
  };

  return fn(provedor);
}

before(async () => {
  const criado = await criarAppDeTeste();
  await abrirACasa();
  app = criado.app;
  ({ cabecalho: cabDono } = await entrar(app));

  const { db } = await import('../src/db/client.js');
  const { tenants } = await import('../src/db/schema/index.js');
  const [t] = await db.select().from(tenants);
  tenantId = t.id;
});

after(async () => {
  await app?.close();
});

describe('deteccao de opcao do menu', () => {
  const fluxo = fluxoPadrao();
  const servicos = { listarServicos: async () => 'LISTA' };
  const passo = (texto) => passoDoFluxo(fluxo, null, texto, servicos);

  it('reconhece numero puro e variacoes', async () => {
    for (const entrada of ['1', '#1', 'opcao 1']) {
      const r = await passo(entrada);
      assert.equal(r?.caminho.at(-1), 'Ver serviços e preços', `falhou para: ${entrada}`);
    }
  });

  it('reconhece saudacao como pedido de menu', async () => {
    for (const entrada of ['oi', 'Ola', 'BOM DIA', 'menu', 'voltar']) {
      const r = await passo(entrada);
      assert.match(r?.baloes[0] ?? '', /Digite o número/, `falhou: ${entrada}`);
    }
  });

  it('reconhece atalhos que a recepcao ouve o dia inteiro', async () => {
    assert.equal((await passo('precos')).baloes[0], 'LISTA');
    assert.equal((await passo('atendente')).transferir, true);
  });

  it('numero fora da faixa e erro de digitacao, nao linguagem livre', async () => {
    const r = await passo('9');
    assert.ok(r, 'nao pode cair na IA');
    assert.match(r.baloes[0], /Não entendi essa opção/);
  });

  /**
   * E este `null` que dispara o transbordo para a IA no modo hibrido.
   * O sistema antigo tentava adivinhar a intencao por palavras-chave e
   * errava dos dois lados.
   */
  it('linguagem livre NAO casa com o menu', async () => {
    for (const frase of [
      'quero dar um trato no visual',
      'da pra encaixar amanha de tarde?',
      'quanto tempo voces ficam abertos?'
    ]) {
      assert.equal(await passo(frase), null, `casou indevidamente: ${frase}`);
    }
  });
});

describe('agrupador de mensagens picotadas', () => {
  it('junta mensagens seguidas num turno so', async () => {
    const ag = new Agrupador({ janelaMs: 50 });

    const resultados = await Promise.all([
      ag.enfileirar('cliente1', 'oi'),
      ag.enfileirar('cliente1', 'tudo bem?'),
      ag.enfileirar('cliente1', 'queria marcar um horario')
    ]);

    const processar = resultados.filter((r) => r.processar);
    assert.equal(processar.length, 1, 'apenas UM dos chamadores pode processar o lote');
    assert.equal(processar[0].texto, 'oi\ntudo bem?\nqueria marcar um horario');
    assert.equal(processar[0].quantidade, 3);
  });

  /**
   * No sistema antigo, todos os chamadores recebiam a resposta e precisavam
   * conferir uma flag `isBatchLeader` para decidir se enviavam. Quem
   * esquecesse mandava a mesma resposta quatro vezes.
   */
  it('quem nao e o ultimo nao recebe nada para enviar', async () => {
    const ag = new Agrupador({ janelaMs: 30 });

    const resultados = await Promise.all([
      ag.enfileirar('cliente2', 'a'),
      ag.enfileirar('cliente2', 'b')
    ]);

    assert.equal(resultados[0].processar, false);
    assert.equal(resultados[0].texto, undefined, 'nao pode nem existir texto para enviar por engano');
    assert.equal(resultados[1].processar, true);
  });

  it('clientes diferentes nao se misturam', async () => {
    const ag = new Agrupador({ janelaMs: 30 });

    const [a, b] = await Promise.all([
      ag.enfileirar('clienteA', 'mensagem do A'),
      ag.enfileirar('clienteB', 'mensagem do B')
    ]);

    assert.equal(a.texto, 'mensagem do A');
    assert.equal(b.texto, 'mensagem do B');
  });

  it('janela zero desliga o agrupamento', async () => {
    const ag = new Agrupador({ janelaMs: 0 });
    const r = await ag.enfileirar('c', 'imediata');
    assert.equal(r.processar, true);
    assert.equal(r.quantidade, 1);
  });

  /**
   * Sem teto, um cliente que digita sem parar reiniciaria o relogio pra
   * sempre e nunca seria atendido.
   */
  it('respeita o tempo maximo de espera', async () => {
    const ag = new Agrupador({ janelaMs: 1000, tempoMaximoMs: 60 });

    const inicio = Date.now();
    const p = ag.enfileirar('teimoso', 'primeira');
    // Continua digitando, reiniciando a janela.
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 15));
      ag.enfileirar('teimoso', `mais ${i}`);
    }

    await p;
    assert.ok(Date.now() - inicio < 500, 'o teto precisa cortar a espera infinita');
  });
});

describe('modos de atendimento', () => {
  async function definirModo(modo) {
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    await atendimento.salvarConfiguracao(tenantId, { modo });
  }

  async function novaConversa(texto = 'oi') {
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const { db } = await import('../src/db/client.js');
    const { leads } = await import('../src/db/schema/index.js');
    const todos = await db.select().from(leads);
    const lead = todos[Math.floor(Math.random() * todos.length)];

    const id = await conversas.encontrarOuAbrir(tenantId, { leadId: lead.id });
    await conversas.registrarRecebida(tenantId, id, { conteudo: texto });
    return { conversationId: id, leadId: lead.id, leadNome: lead.nome };
  }

  it('modo menu responde opcao sem gastar IA', async () => {
    await definirModo('menu');
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    const ctx = await novaConversa('1');

    const r = await atendimento.responder({ tenantId, ...ctx, texto: '1' });

    assert.equal(r.respondidoPor, 'menu');
    assert.equal(r.detalhes.custoIa, 0);
    assert.match(r.baloes.join('\n'), /Corte Social|servicos e valores/i);
  });

  /** No modo so-menu, linguagem livre nunca aciona IA. */
  it('modo menu NAO chama IA para linguagem livre', async () => {
    await definirModo('menu');
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    const ctx = await novaConversa('quero dar um trato no visual');

    const r = await atendimento.responder({ tenantId, ...ctx, texto: 'quero dar um trato no visual' });

    assert.equal(r.respondidoPor, 'menu');
    assert.equal(r.detalhes.custoIa, 0);
  });

  it('modo hibrido usa o menu para numero', async () => {
    await definirModo('hibrido');
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    const ctx = await novaConversa('1');

    const r = await atendimento.responder({ tenantId, ...ctx, texto: '1' });
    assert.equal(r.respondidoPor, 'menu');
  });

  it('o menu lista os servicos REAIS do banco, nao uma lista fixa', async () => {
    await definirModo('menu');
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    const ctx = await novaConversa('1');

    const r = await atendimento.responder({ tenantId, ...ctx, texto: '1' });
    const texto = r.baloes.join('\n');

    // Vieram do seed, com os precos do seed.
    assert.match(texto, /Corte Degrade/);
    assert.match(texto, /R\$\s*55,00/);
    assert.match(texto, /40 min/);
  });

  it('pedir atendente coloca a conversa na fila', async () => {
    await definirModo('hibrido');
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const ctx = await novaConversa('4');

    const r = await atendimento.responder({ tenantId, ...ctx, texto: '4' });

    assert.equal(r.transferido, true);

    const conversa = await conversas.obter(tenantId, ctx.conversationId);
    assert.equal(conversa.status, 'na_fila');
  });

  /**
   * Quando a IA nao responde, o sistema antigo mandava uma saudacao generica
   * fingindo sucesso — no meio de uma negociacao de horario.
   */
  it('IA indisponivel transborda para humano em vez de fingir que respondeu', async () => {
    await definirModo('ia');
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    const conversas = await import('../src/modules/conversas/conversas.service.js');

    // Nenhum provedor esta configurado neste banco de teste, entao a cascata
    // falha de verdade — exatamente o cenario real de cota estourada.
    const ctx = await novaConversa('quanto custa o corte?');
    const r = await atendimento.responder({ tenantId, ...ctx, texto: 'quanto custa o corte?' });

    assert.equal(r.respondidoPor, 'fallback_humano');
    assert.equal(r.transferido, true);
    assert.ok(!/assistente virtual/i.test(r.baloes.join(' ')), 'nao pode ser saudacao generica');
    assert.match(r.baloes.join(' '), /atendente/i);

    const conversa = await conversas.obter(tenantId, ctx.conversationId);
    assert.equal(conversa.status, 'na_fila', 'o cliente precisa ir pra fila humana');
  });
});

/**
 * BUG reproduzido: no hibrido, depois que a Sofia assumia, o menu roubava as
 * respostas do cliente — "2" (o 2º horario que ela ofereceu) virava a opcao 2
 * do menu, "15" dava "nao entendi" + menu, "bom dia" reabria as boas-vindas.
 */
describe('hibrido: com a Sofia conduzindo, o menu nao intercepta', () => {
  let atendimento;
  let conversasRepo;
  let ctx;
  let chamadasIa = 0;

  // Dublê da IA: sempre "responde" oferecendo dois horarios, como a Sofia faria.
  const provedores = [
    {
      impl: {
        nome: 'falso',
        async gerar({ modelo }) {
          chamadasIa++;
          return { texto: 'Tenho 14:00 ou 15:00. Qual fica melhor?', chamadasDeFerramenta: [], tokens: { entrada: 5, saida: 5 }, modelo };
        }
      },
      apiKey: 'x',
      modelos: ['modelo-falso']
    }
  ];
  const falar = (texto) => atendimento.responder({ tenantId, ...ctx, texto, provedores });
  const estado = () => conversasRepo.lerEstadoMenu(tenantId, ctx.conversationId);

  before(async () => {
    atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    conversasRepo = await import('../src/modules/conversas/conversas.repo.js');
    await atendimento.salvarConfiguracao(tenantId, { modo: 'hibrido' });

    // Cliente e conversa proprios deste teste (telefone so dele).
    const leads = await import('../src/modules/leads/leads.service.js');
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const lead = await leads.criar(tenantId, { nome: 'Hibrido Teste', telefone: '5511955507701' });
    const conversationId = await conversas.encontrarOuAbrir(tenantId, { leadId: lead.id });
    ctx = { conversationId, leadId: lead.id, leadNome: lead.nome };
  });

  it('cliente novo: "oi" mostra o menu e "1" e opcao do menu', async () => {
    assert.equal((await falar('oi')).respondidoPor, 'menu');
    const um = await falar('1');
    assert.equal(um.respondidoPor, 'menu', 'sem a Sofia conduzindo, numero continua sendo do menu');
    assert.match(um.baloes.join('\n'), /Corte/);
  });

  it('a opcao do menu que passa para a Sofia ja deixa a conversa com ela', async () => {
    // No menu padrao, "2 = Agendar um horario" e um passo "Sofia".
    const dois = await falar('2');
    assert.equal(dois.respondidoPor, 'menu');
    assert.equal(dois.detalhes.entregouParaIa, true);
    assert.equal((await estado())?.conduz, 'ia', 'antes o estado ficava vazio aqui');
  });

  it('com a Sofia conduzindo, "2", "15" e "bom dia" vao para ela', async () => {
    const antes = chamadasIa;
    assert.equal((await falar('queria marcar um corte amanha')).respondidoPor, 'ia');
    for (const texto of ['2', '15', 'Bom dia!']) {
      const r = await falar(texto);
      assert.equal(r.respondidoPor, 'ia', `"${texto}" e resposta a Sofia, nao opcao do menu`);
    }
    assert.equal(chamadasIa - antes, 4, 'as quatro mensagens chegaram na IA');
    assert.equal((await estado())?.conduz, 'ia');
  });

  it('"menu" traz o menu de volta e o "1" seguinte e opcao do menu', async () => {
    const menu = await falar('menu');
    assert.equal(menu.respondidoPor, 'menu');
    assert.notEqual((await estado())?.conduz, 'ia', 'pediu o menu: o menu volta a mandar');
    assert.equal((await falar('1')).respondidoPor, 'menu');
  });

  it('depois de 61 min parado, "bom dia" volta a mostrar o menu', async () => {
    await conversasRepo.gravarEstadoMenu(tenantId, ctx.conversationId, { conduz: 'ia', em: Date.now() - 61 * 60_000 });
    assert.equal((await falar('bom dia')).respondidoPor, 'menu');
  });

  it('iaConduzindo: so vale com estado recente e sem comando de menu', () => {
    const fluxo = fluxoPadrao();
    const recente = { conduz: 'ia', em: Date.now() };
    assert.equal(iaConduzindo(fluxo, recente, '2'), true);
    assert.equal(iaConduzindo(fluxo, recente, 'bom dia'), true, 'saudacao nao e comando de menu');
    for (const comando of COMANDOS_DO_MENU) assert.equal(iaConduzindo(fluxo, recente, comando), false, comando);
    assert.equal(iaConduzindo(fluxo, recente, 'Início!'), false, 'normaliza acento e pontuacao');
    assert.equal(iaConduzindo(fluxo, { no: 'inicio', pilha: [], em: Date.now() }, '2'), false, 'estado de menu');
    assert.equal(iaConduzindo(fluxo, null, '2'), false, 'sem estado, o menu decide');
  });

  it('o modo so-menu continua igual: mesmo marcado, a Sofia nunca e chamada', async () => {
    await atendimento.salvarConfiguracao(tenantId, { modo: 'menu' });
    try {
      await conversasRepo.gravarEstadoMenu(tenantId, ctx.conversationId, { conduz: 'ia', em: Date.now() });
      const antes = chamadasIa;
      assert.equal((await falar('2')).respondidoPor, 'menu');
      assert.equal(chamadasIa, antes);
    } finally {
      await atendimento.salvarConfiguracao(tenantId, { modo: 'hibrido' });
    }
  });

  it('o simulador aceita o estado "a Sofia conduz" (sem `no`) e o "menu" o desfaz', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/ia/simular',
      headers: cabDono,
      payload: { mensagem: 'menu', modo: 'hibrido', menuEstado: { conduz: 'ia', em: Date.now() } }
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().respondidoPor, 'menu');
    assert.ok(r.json().menuEstado?.no, 'devolve o estado de menu para a tela');
  });
});

describe('configuracao do atendimento', () => {
  it('le e grava o modo', async () => {
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');

    await atendimento.salvarConfiguracao(tenantId, { modo: 'hibrido', agrupamentoSegundos: 12 });
    const cfg = await atendimento.obterConfiguracao(tenantId);

    assert.equal(cfg.modo, 'hibrido');
    assert.equal(cfg.agrupamentoSegundos, 12);
    assert.deepEqual(cfg.modosDisponiveis, ['menu', 'hibrido', 'ia']);
  });

  it('usa o menu padrao quando a empresa nao montou o dela', async () => {
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    const cfg = await atendimento.obterConfiguracao(tenantId);

    const inicio = cfg.menu.fluxo.nodes.find((n) => n.id === cfg.menu.fluxo.inicio);
    assert.ok(inicio.data.options.length >= 4);
  });
});
