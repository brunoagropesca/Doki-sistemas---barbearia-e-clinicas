import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

/**
 * Teto de 25 servicos ATIVOS e renomear categoria.
 *
 * O teto existe porque e o tamanho em que a Sofia ainda recebe o catalogo
 * inteiro no prompt — passado disso ela passou a inventar. Inativos nao contam.
 * O seed ja tem 5 ativos; os servicos daqui usam nomes proprios ("Lim ...").
 */

let app;
let cab;

const criar = (nome, extra = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/servicos',
    headers: cab,
    payload: { nome, duracaoMinutos: 30, precoCentavos: 1000, categoria: 'Limite Teste', ...extra }
  });

const metricas = async () =>
  (await app.inject({ method: 'GET', url: '/api/catalogo/metricas', headers: cab })).json().servicos;

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cab } = await entrar(app));
});

after(async () => {
  await app?.close();
});

describe('limite de servicos ativos', () => {
  let inativoId;

  it('as metricas informam o limite', async () => {
    const m = await metricas();
    assert.equal(m.limiteAtivos, 25);
  });

  it('cria ate 25 ativos e recusa o 26o com mensagem clara', async () => {
    const faltam = 25 - (await metricas()).ativos;
    for (let i = 1; i <= faltam; i++) {
      const r = await criar(`Lim Servico ${i}`);
      assert.equal(r.statusCode, 201, r.body);
    }
    assert.equal((await metricas()).ativos, 25);

    const r = await criar('Lim Servico Excedente');
    assert.equal(r.statusCode, 422);
    assert.match(r.json().erro?.mensagem ?? r.body, /no maximo 25 servicos ativos/);
  });

  it('servico INATIVO nao conta: pode cadastrar, mas nao reativar sem vaga', async () => {
    const r = await criar('Lim Guardado', { ativo: false });
    assert.equal(r.statusCode, 201, r.body);
    inativoId = r.json().servico.id;

    const reativar = await app.inject({ method: 'PATCH', url: `/api/servicos/${inativoId}`, headers: cab, payload: { ativo: true } });
    assert.equal(reativar.statusCode, 422);
  });

  it('editar um ativo no limite continua permitido', async () => {
    const { servicos } = (await app.inject({ method: 'GET', url: '/api/servicos', headers: cab })).json();
    const um = servicos.find((s) => s.nome === 'Lim Servico 1');
    const r = await app.inject({ method: 'PATCH', url: `/api/servicos/${um.id}`, headers: cab, payload: { precoCentavos: 1500, ativo: true } });
    assert.equal(r.statusCode, 200, r.body);
  });

  it('desativando um, abre vaga para reativar outro', async () => {
    const { servicos } = (await app.inject({ method: 'GET', url: '/api/servicos', headers: cab })).json();
    const um = servicos.find((s) => s.nome === 'Lim Servico 2');
    await app.inject({ method: 'PATCH', url: `/api/servicos/${um.id}`, headers: cab, payload: { ativo: false } });

    const r = await app.inject({ method: 'PATCH', url: `/api/servicos/${inativoId}`, headers: cab, payload: { ativo: true } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await metricas()).ativos, 25);
  });
});

describe('editar mexe so no que foi enviado', () => {
  // Bug antigo: o schema de edicao herdava os valores padrao do de criar.
  it('servico: mudar o preco nao troca a categoria, a folga nem reativa', async () => {
    const r = await criar('Lim Edicao Parcial', { ativo: false, intervaloAposMinutos: 10 });
    const id = r.json().servico.id;

    const patch = await app.inject({ method: 'PATCH', url: `/api/servicos/${id}`, headers: cab, payload: { precoCentavos: '12,50' } });
    assert.equal(patch.statusCode, 200, patch.body);
    const s = patch.json().servico;
    assert.equal(s.precoCentavos, 1250);
    assert.equal(s.categoria, 'Limite Teste');
    assert.equal(s.intervaloAposMinutos, 10);
    assert.equal(s.ativo, false);
  });

  it('produto: mudar o nome e aceito e nao zera o estoque', async () => {
    const criado = await app.inject({
      method: 'POST',
      url: '/api/produtos',
      headers: cab,
      payload: { nome: 'Lim Pomada', precoCentavos: 3000, categoria: 'Lim Finalizadores', estoque: 7 }
    });
    assert.equal(criado.statusCode, 201, criado.body);
    const id = criado.json().produto.id;

    const patch = await app.inject({ method: 'PATCH', url: `/api/produtos/${id}`, headers: cab, payload: { nome: 'Lim Pomada Forte' } });
    assert.equal(patch.statusCode, 200, patch.body);
    const p = patch.json().produto;
    assert.equal(p.nome, 'Lim Pomada Forte');
    assert.equal(p.estoque, 7);
    assert.equal(p.categoria, 'Lim Finalizadores');
  });
});

describe('renomear categoria', () => {
  it('troca a categoria de todos os servicos dela (inclusive inativos)', async () => {
    const todos = async () =>
      (await app.inject({ method: 'GET', url: '/api/servicos?incluirInativos=true', headers: cab })).json().servicos;
    const daCategoria = (await todos()).filter((s) => s.categoria === 'Limite Teste');
    assert.ok(daCategoria.some((s) => !s.ativo), 'tem inativo na categoria');

    const r = await app.inject({
      method: 'POST',
      url: '/api/servicos/categorias/renomear',
      headers: cab,
      payload: { de: 'Limite Teste', para: 'Limite Renomeada' }
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().alterados, daCategoria.length);

    const servicos = await todos();
    assert.equal(servicos.filter((s) => s.categoria === 'Limite Teste').length, 0);
    assert.equal(servicos.filter((s) => s.categoria === 'Limite Renomeada').length, daCategoria.length);
  });

  it('categoria que nao existe da 404; nome vazio da 400', async () => {
    const naoExiste = await app.inject({
      method: 'POST',
      url: '/api/servicos/categorias/renomear',
      headers: cab,
      payload: { de: 'Lim Categoria Fantasma', para: 'X' }
    });
    assert.equal(naoExiste.statusCode, 404);

    const vazio = await app.inject({
      method: 'POST',
      url: '/api/servicos/categorias/renomear',
      headers: cab,
      payload: { de: 'Limite Renomeada', para: '   ' }
    });
    assert.equal(vazio.statusCode, 400);
  });

  it('atendente nao renomeia categoria', async () => {
    const { cabecalho } = await entrar(app, 'recepcao');
    const r = await app.inject({
      method: 'POST',
      url: '/api/servicos/categorias/renomear',
      headers: cabecalho,
      payload: { de: 'Limite Renomeada', para: 'Y' }
    });
    assert.equal(r.statusCode, 403);
  });
});
