import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import {
  LIMITES,
  comLigacao,
  converterMenuAntigo,
  motivoParaRecusarLigacao,
  passoDoFluxo,
  profundidades,
  validarFluxo
} from '../src/modules/atendimento/fluxo.js';

/**
 * Monta um fluxo pequeno a mao:
 *
 *   inicio (menu) ─1 Comprar──▶ compras (menu) ─1 Cortes──▶ precos (servicos)
 *                 │                             └2 Voltar ao início──▶ inicio
 *                 └2 Suporte──▶ humano (atendente)
 */
function fluxoDeExemplo() {
  return {
    versao: 2,
    inicio: 'inicio',
    nodes: [
      menu('inicio', 'Menu principal', 'Escolha uma opção:', ['Comprar', 'Suporte']),
      menu('compras', 'Compras', 'O que você quer comprar?', ['Cortes', 'Voltar ao início']),
      { id: 'precos', type: 'servicos', position: { x: 0, y: 0 }, data: { title: 'Preços', message: '' } },
      { id: 'humano', type: 'atendente', position: { x: 0, y: 0 }, data: { title: 'Atendente', message: 'Já chamo alguém!' } }
    ],
    connections: {
      inicio: { main: [[liga('compras')], [liga('humano')]] },
      compras: { main: [[liga('precos')], [liga('inicio')]] }
    },
    config: { mensagemErro: 'Opção inválida.', expiraMinutos: 60 }
  };
}

function menu(id, title, message, rotulos) {
  return {
    id,
    type: 'menu',
    position: { x: 0, y: 0 },
    data: { title, message, options: rotulos.map((label, i) => ({ id: `${id}_o${i}`, label })) }
  };
}

const liga = (node) => ({ node, type: 'main', index: 0 });
const servicos = { listarServicos: async () => 'LISTA DE PRECOS' };

describe('validacao do fluxo', () => {
  it('um fluxo correto nao tem erro nem aviso', () => {
    const { erros, avisos } = validarFluxo(fluxoDeExemplo());
    assert.deepEqual(erros, []);
    assert.deepEqual(avisos, []);
  });

  it('sem inicio nao salva', () => {
    const f = { ...fluxoDeExemplo(), inicio: 'nao-existe' };
    assert.ok(validarFluxo(f).erros.some((e) => /início/.test(e.mensagem)));
  });

  it('o inicio precisa ser um menu', () => {
    const f = { ...fluxoDeExemplo(), inicio: 'humano' };
    assert.ok(validarFluxo(f).erros.some((e) => e.noId === 'humano'));
  });

  it(`no maximo ${LIMITES.opcoes} opcoes por menu`, () => {
    const f = fluxoDeExemplo();
    f.nodes[0] = menu('inicio', 'Menu', 'Oi', ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.ok(validarFluxo(f).erros.some((e) => /no máximo 5/.test(e.mensagem)));
  });

  it('opcao sem destino e so aviso: ela some do menu do cliente', () => {
    const f = fluxoDeExemplo();
    f.connections.inicio.main[1] = [];
    const { erros, avisos } = validarFluxo(f);
    assert.deepEqual(erros, []);
    assert.ok(avisos.some((a) => /não leva a lugar nenhum/.test(a.mensagem)));
  });

  it('passo solto (que o inicio nao alcanca) e aviso', () => {
    const f = fluxoDeExemplo();
    f.nodes.push({ id: 'solto', type: 'mensagem', position: { x: 0, y: 0 }, data: { title: 'Solto', message: 'x' } });
    assert.ok(validarFluxo(f).avisos.some((a) => a.noId === 'solto'));
  });

  it('uma saida nao leva a dois passos', () => {
    const f = fluxoDeExemplo();
    f.connections.inicio.main[0] = [liga('compras'), liga('humano')];
    assert.ok(validarFluxo(f).erros.some((e) => /dois passos/.test(e.mensagem)));
  });

  it('mensagens ligadas em roda nunca terminariam de enviar', () => {
    const f = fluxoDeExemplo();
    f.nodes.push(
      { id: 'm1', type: 'mensagem', position: { x: 0, y: 0 }, data: { title: 'A', message: 'a' } },
      { id: 'm2', type: 'mensagem', position: { x: 0, y: 0 }, data: { title: 'B', message: 'b' } }
    );
    f.connections.inicio.main[1] = [liga('m1')];
    f.connections.m1 = { main: [[liga('m2')]] };
    f.connections.m2 = { main: [[liga('m1')]] };
    assert.ok(validarFluxo(f).erros.some((e) => /em roda/.test(e.mensagem)));
  });

  it(`passar de ${LIMITES.profundidade} passos a partir do inicio e erro — e o editor recusa a ligacao`, () => {
    // Corrente inicio → m1 → m2 → ... → m11: o ultimo fica a 11 passos.
    const f = { versao: 2, inicio: 'inicio', nodes: [menu('inicio', 'Início', 'Oi', ['ir'])], connections: {} };
    let anterior = 'inicio';
    for (let i = 1; i <= 11; i++) {
      f.nodes.push(menu(`m${i}`, `Nível ${i}`, 'x', ['ir']));
      f.connections[anterior] = { main: [[liga(`m${i}`)]] };
      anterior = `m${i}`;
    }
    assert.equal(profundidades(f).get('m11'), 11);
    assert.ok(validarFluxo(f).erros.some((e) => e.noId === 'm11'));

    // A mesma regra, no momento de ligar (o que o editor usa ao arrastar a linha).
    const ate10 = comLigacao(comLigacao(f, 'm9', 0, null), 'm10', 0, null);
    assert.equal(motivoParaRecusarLigacao(ate10, 'm9', 0, 'm10'), null, 'o 10o passo ainda cabe');
    const semO11 = comLigacao(f, 'm10', 0, null);
    assert.match(motivoParaRecusarLigacao(semO11, 'm10', 0, 'm11'), /10 passos/);
  });

  it('ligar de volta a um menu anterior (Voltar ao inicio) e permitido', () => {
    assert.equal(motivoParaRecusarLigacao(fluxoDeExemplo(), 'compras', 1, 'inicio'), null);
  });

  it('um passo nao liga a si mesmo', () => {
    assert.match(motivoParaRecusarLigacao(fluxoDeExemplo(), 'compras', 0, 'compras'), /si mesmo/);
  });
});

describe('o cliente andando pelo fluxo', () => {
  it('"1" dentro do submenu escolhe a opcao 1 DO SUBMENU, nao do menu principal', async () => {
    const f = fluxoDeExemplo();
    const a = await passoDoFluxo(f, null, '1', servicos);
    assert.equal(a.estado.no, 'compras');
    assert.match(a.baloes[0], /O que você quer comprar/);
    assert.match(a.baloes[0], /0️⃣ \*Voltar\*/, 'submenu oferece voltar');

    const b = await passoDoFluxo(f, a.estado, '1', servicos);
    assert.equal(b.baloes[0], 'LISTA DE PRECOS');
    assert.equal(b.estado.no, 'compras', 'depois da resposta, continua no mesmo menu');
  });

  it('"0" volta ao menu anterior', async () => {
    const f = fluxoDeExemplo();
    const a = await passoDoFluxo(f, null, '1', servicos);
    const b = await passoDoFluxo(f, a.estado, '0', servicos);
    assert.equal(b.estado.no, 'inicio');
    assert.match(b.baloes[0], /Escolha uma opção/);
  });

  it('opcao ligada de volta ao inicio nao empilha sem fim', async () => {
    const f = fluxoDeExemplo();
    let estado = null;
    for (let i = 0; i < 5; i++) {
      estado = (await passoDoFluxo(f, estado, '1', servicos)).estado; // inicio → compras
      estado = (await passoDoFluxo(f, estado, '2', servicos)).estado; // compras → inicio
    }
    assert.equal(estado.no, 'inicio');
    assert.deepEqual(estado.pilha, []);
  });

  it('numero que nao existe no submenu repete o SUBMENU com a mensagem de erro', async () => {
    const f = fluxoDeExemplo();
    const a = await passoDoFluxo(f, null, '1', servicos);
    const b = await passoDoFluxo(f, a.estado, '7', servicos);
    assert.match(b.baloes[0], /Opção inválida/);
    assert.match(b.baloes[0], /O que você quer comprar/);
    assert.equal(b.estado.no, 'compras');
  });

  it('parado tempo demais no submenu, volta a valer o inicio', async () => {
    const f = fluxoDeExemplo();
    const a = await passoDoFluxo(f, null, '1', servicos);
    const velho = { ...a.estado, em: Date.now() - 61 * 60_000 };
    const b = await passoDoFluxo(f, velho, '2', servicos);
    assert.equal(b.transferir, true, '"2" no inicio e Suporte');
  });

  it('opcao que leva a passo desativado some e a numeracao se ajusta', async () => {
    const f = fluxoDeExemplo();
    f.nodes.find((n) => n.id === 'compras').data.disabled = true;
    const r = await passoDoFluxo(f, null, 'menu', servicos);
    assert.doesNotMatch(r.baloes[0], /Comprar/);
    assert.match(r.baloes[0], /1️⃣ \*Suporte\*/);
    assert.equal((await passoDoFluxo(f, null, '1', servicos)).transferir, true);
  });

  it('escolher pelo texto da opcao tambem funciona', async () => {
    const r = await passoDoFluxo(fluxoDeExemplo(), null, 'suporte', servicos);
    assert.equal(r.transferir, true);
    assert.equal(r.estado, null, 'quem vai para a fila sai do menu');
  });

  it('mensagem encadeada em um menu manda os dois baloes, na ordem', async () => {
    const f = fluxoDeExemplo();
    f.nodes.push({ id: 'aviso', type: 'mensagem', position: { x: 0, y: 0 }, data: { title: 'Aviso', message: 'Promoção hoje!' } });
    f.connections.inicio.main[0] = [liga('aviso')];
    f.connections.aviso = { main: [[liga('compras')]] };
    const r = await passoDoFluxo(f, null, '1', servicos);
    assert.equal(r.baloes[0], 'Promoção hoje!');
    assert.match(r.baloes[1], /O que você quer comprar/);
    assert.equal(r.estado.no, 'compras');
  });
});

describe('conversao do menu antigo', () => {
  it('converte a arvore antiga sem perder opcoes, mesmo passando de 5', () => {
    const antigo = {
      mensagemBoasVindas: 'Olá!',
      mensagemErro: 'Hein?',
      opcoes: Array.from({ length: 7 }, (_, i) => ({ titulo: `Opção ${i + 1}`, acao: 'mensagem', respostaCustomizada: `r${i}` }))
    };
    const f = converterMenuAntigo(antigo);
    assert.deepEqual(validarFluxo(f).erros, []);

    const inicio = f.nodes.find((n) => n.id === f.inicio);
    assert.equal(inicio.data.options.length, 5);
    assert.equal(inicio.data.options[4].label, 'Mais opções');
    const mensagens = f.nodes.filter((n) => n.type === 'mensagem').map((n) => n.data.message);
    assert.equal(mensagens.length, 7, 'as 7 respostas continuam existindo');
    assert.equal(f.config.mensagemErro, 'Hein?');
  });

  it('submenu antigo vira menu de verdade, ligado pela opcao', () => {
    const f = converterMenuAntigo({
      mensagemBoasVindas: 'Oi',
      opcoes: [{ titulo: 'Unidades', acao: 'submenu', subOpcoes: [{ titulo: 'Centro', acao: 'mensagem', respostaCustomizada: 'Rua A' }] }]
    });
    const sub = f.nodes.find((n) => n.type === 'menu' && n.id !== f.inicio);
    assert.equal(sub.data.title, 'Unidades');
    assert.equal(f.connections[f.inicio].main[0][0].node, sub.id);
  });
});

describe('fluxo pela API e na conversa de verdade', () => {
  let app;
  let cab;
  let tenantId;

  before(async () => {
    ({ app } = await criarAppDeTeste());
    ({ cabecalho: cab } = await entrar(app));
    const { db } = await import('../src/db/client.js');
    const { tenants } = await import('../src/db/schema/index.js');
    tenantId = (await db.select().from(tenants))[0].id;
  });

  after(async () => {
    await app?.close();
  });

  const salvar = (fluxo) => app.inject({ method: 'PUT', url: '/api/atendimento/menu', headers: cab, payload: { fluxo } });

  it('salva e devolve o fluxo como foi desenhado', async () => {
    const r = await salvar(fluxoDeExemplo());
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().menu.fluxo.inicio, 'inicio');
    assert.equal(r.json().menu.padrao, false);
  });

  it('recusa fluxo com erro e diz quais sao os problemas', async () => {
    const f = fluxoDeExemplo();
    f.inicio = 'humano';
    const r = await salvar(f);
    assert.equal(r.statusCode, 422);
    assert.ok(r.json().erro.detalhes.problemas.length >= 1);
  });

  it('recusa formato quebrado (tipo de passo que nao existe)', async () => {
    const f = fluxoDeExemplo();
    f.nodes[2].type = 'webhook';
    assert.equal((await salvar(f)).statusCode, 400);
  });

  it('a conversa lembra em que submenu o cliente esta, entre uma mensagem e outra', async () => {
    await salvar(fluxoDeExemplo());
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const leadsService = await import('../src/modules/leads/leads.service.js');
    await atendimento.salvarConfiguracao(tenantId, { modo: 'menu' });

    const lead = await leadsService.encontrarOuCriarPorTelefone(tenantId, '5511955501234', 'Cliente Fluxo');
    const conversationId = await conversas.encontrarOuAbrir(tenantId, { leadId: lead.id });
    const falar = async (texto) => {
      await conversas.registrarRecebida(tenantId, conversationId, { conteudo: texto });
      return atendimento.responder({ tenantId, conversationId, leadId: lead.id, leadNome: lead.nome, texto });
    };

    const a = await falar('1');
    assert.match(a.baloes.join('\n'), /O que você quer comprar/);

    const b = await falar('1');
    assert.match(b.baloes.join('\n'), /Nossos serviços e valores/, 'o "1" do submenu e Cortes (lista de precos real)');
    assert.match(b.baloes.join('\n'), /R\$/);

    const c = await falar('0');
    assert.match(c.baloes.join('\n'), /Escolha uma opção/);
  });

  it('o simulador tambem lembra, devolvendo o estado para a tela', async () => {
    await salvar(fluxoDeExemplo());
    const simular = (mensagem, menuEstado) =>
      app.inject({ method: 'POST', url: '/api/ia/simular', headers: cab, payload: { mensagem, modo: 'menu', menuEstado } });

    const a = (await simular('1')).json();
    assert.equal(a.menuEstado.no, 'compras');
    const b = (await simular('2', a.menuEstado)).json();
    assert.equal(b.menuEstado.no, 'inicio', '"2" no submenu Compras e Voltar ao início');
  });
});
