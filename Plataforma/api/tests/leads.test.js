import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

let app;
let cab;

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cab } = await entrar(app));
});

after(async () => {
  await app?.close();
});

describe('cadastro de contatos', () => {
  it('cria um contato normalizando o telefone', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: cab,
      payload: { nome: 'Fernanda Dias', telefone: '(11) 98888-7777' }
    });

    assert.equal(res.statusCode, 201);
    const lead = res.json().lead;
    assert.equal(lead.telefone, '5511988887777', 'o telefone precisa ser guardado na forma canonica');
    assert.equal(lead.telefoneFormatado, '+55 (11) 98888-7777');
  });

  /**
   * O problema silencioso e caro do sistema antigo: o mesmo cliente virando
   * varios cadastros porque cada canal escrevia o numero de um jeito.
   */
  it('recusa o mesmo cliente cadastrado com telefone em outro formato', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: cab,
      payload: { nome: 'Original', telefone: '5511977776666' }
    });

    for (const formato of ['(11) 97777-6666', '11977776666', '+55 11 97777-6666']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/leads',
        headers: cab,
        payload: { nome: 'Duplicado', telefone: formato }
      });

      assert.equal(res.statusCode, 409, `o formato "${formato}" criou um cadastro duplicado`);
      assert.equal(res.json().erro.codigo, 'CONFLITO');
    }
  });

  it('recusa telefone invalido com mensagem util', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: cab,
      payload: { nome: 'Invalido', telefone: '123' }
    });

    assert.equal(res.statusCode, 400);
  });

  it('exige nome', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: cab,
      payload: { telefone: '11955554444' }
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().erro.codigo, 'VALIDACAO');
  });
});

describe('listagem', () => {
  it('lista os contatos com os numeros agregados', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/leads', headers: cab });

    assert.equal(res.statusCode, 200);
    const { itens } = res.json();
    assert.ok(itens.length >= 3, 'o seed criou 3 contatos');

    const primeiro = itens[0];
    assert.ok('totalAgendamentos' in primeiro, 'a listagem precisa trazer os agregados');
    assert.ok('gastoTotalFormatado' in primeiro);
  });

  it('busca por nome e por telefone', async () => {
    const porNome = await app.inject({ method: 'GET', url: '/api/leads?busca=Marcos', headers: cab });
    assert.equal(porNome.json().itens.length, 1);

    const porTelefone = await app.inject({ method: 'GET', url: '/api/leads?busca=98877', headers: cab });
    assert.ok(porTelefone.json().itens.length >= 1);
  });

  /**
   * '/api/leads/etiquetas' nao pode ser interpretada como '/api/leads/:id'
   * com id = "etiquetas". E um erro classico de ordem de registro de rotas.
   */
  it('rotas fixas nao colidem com a rota de detalhe', async () => {
    const etiquetas = await app.inject({ method: 'GET', url: '/api/leads/etiquetas', headers: cab });

    assert.equal(etiquetas.statusCode, 200);
    assert.ok(Array.isArray(etiquetas.json().etiquetas));
  });

  it('pagina com cursor', async () => {
    const pagina1 = await app.inject({ method: 'GET', url: '/api/leads?limite=2', headers: cab });
    const corpo1 = pagina1.json();

    assert.equal(corpo1.itens.length, 2);
    assert.ok(corpo1.proximoCursor, 'com mais registros, precisa devolver cursor');

    const pagina2 = await app.inject({
      method: 'GET',
      url: `/api/leads?limite=2&cursor=${corpo1.proximoCursor}`,
      headers: cab
    });

    const ids1 = corpo1.itens.map((i) => i.id);
    const ids2 = pagina2.json().itens.map((i) => i.id);
    assert.equal(ids1.filter((id) => ids2.includes(id)).length, 0, 'as paginas nao podem repetir contatos');
  });
});

describe('permissao', () => {
  it('atendente lista contatos', async () => {
    const { cabecalho } = await entrar(app, 'recepcao');
    const res = await app.inject({ method: 'GET', url: '/api/leads', headers: cabecalho });
    assert.equal(res.statusCode, 200);
  });

  /** No sistema antigo, apagar contatos em lote nao exigia login nenhum. */
  it('atendente NAO apaga contatos', async () => {
    const { cabecalho } = await entrar(app, 'recepcao');
    const lista = await app.inject({ method: 'GET', url: '/api/leads', headers: cabecalho });
    const id = lista.json().itens[0].id;

    const res = await app.inject({ method: 'DELETE', url: `/api/leads/${id}`, headers: cabecalho });
    assert.equal(res.statusCode, 403);
  });

  it('sem login nao ve contato nenhum', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/leads' });
    assert.equal(res.statusCode, 401);
  });
});

describe('isolamento entre empresas', () => {
  /**
   * A garantia mais importante do sistema multi-empresa: um id valido de
   * OUTRA empresa precisa responder 404, como se nao existisse. Responder
   * 403 ja confirmaria que aquele registro existe em algum lugar.
   */
  it('id de outra empresa responde 404, nao 403', async () => {
    const { db } = await import('../src/db/client.js');
    const { tenants, leads } = await import('../src/db/schema/index.js');
    const { ID } = await import('../src/core/ids.js');

    const outroTenant = ID.tenant();
    await db.insert(tenants).values({ id: outroTenant, nome: 'Concorrente', slug: 'concorrente' });

    const leadAlheio = ID.lead();
    await db.insert(leads).values({
      id: leadAlheio,
      tenantId: outroTenant,
      telefone: '5521999998888',
      nome: 'Cliente da Concorrencia',
      observacoes: '',
      tags: [],
      origem: 'manual'
    });

    const res = await app.inject({ method: 'GET', url: `/api/leads/${leadAlheio}`, headers: cab });
    assert.equal(res.statusCode, 404, 'nao pode existir vazamento entre empresas');

    // E nao aparece na listagem.
    const lista = await app.inject({ method: 'GET', url: '/api/leads?limite=200', headers: cab });
    const ids = lista.json().itens.map((i) => i.id);
    assert.ok(!ids.includes(leadAlheio));
  });
});

describe('acoes em lote', () => {
  it('aplica etiqueta em varios contatos', async () => {
    const lista = await app.inject({ method: 'GET', url: '/api/leads?limite=2', headers: cab });
    const ids = lista.json().itens.map((i) => i.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/leads/lote',
      headers: cab,
      payload: { ids, adicionarTag: 'vip' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().afetados, 2);

    const comTag = await app.inject({ method: 'GET', url: '/api/leads?tag=vip', headers: cab });
    assert.equal(comTag.json().itens.length, 2);
  });

  it('recusa lote sem dizer o que fazer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/leads/lote',
      headers: cab,
      payload: { ids: ['lead_x'] }
    });
    assert.equal(res.statusCode, 400);
  });
});
