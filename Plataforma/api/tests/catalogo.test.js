import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

let app;
let cab;
let cabAtendente;
let ctx = {};

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cab } = await entrar(app));
  ({ cabecalho: cabAtendente } = await entrar(app, 'recepcao'));

  const { db } = await import('../src/db/client.js');
  const { professionals } = await import('../src/db/schema/index.js');
  const profs = await db.select().from(professionals);
  ctx.carlos = profs.find((p) => p.nome.startsWith('Carlos'));
  ctx.julia = profs.find((p) => p.nome.startsWith('Julia'));
});

after(async () => {
  await app?.close();
});

describe('servicos', () => {
  it('lista com os profissionais e o preco efetivo de cada um', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/servicos', headers: cab });

    assert.equal(res.statusCode, 200);
    const servicos = res.json().servicos;
    assert.equal(servicos.length, 5);

    const degrade = servicos.find((s) => s.nome === 'Corte Degrade');
    const julia = degrade.profissionais.find((p) => p.nome.startsWith('Julia'));
    const carlos = degrade.profissionais.find((p) => p.nome.startsWith('Carlos'));

    assert.equal(julia.precoCentavos, 6500);
    assert.equal(julia.precoProprio, true, 'Julia tem preco proprio neste servico');
    assert.equal(carlos.precoCentavos, 5500);
    assert.equal(carlos.precoProprio, false, 'Carlos usa o preco padrao');
  });

  it('calcula a ocupacao real na agenda (duracao + limpeza)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/servicos', headers: cab });
    const combo = res.json().servicos.find((s) => s.nome === 'Corte + Barba');

    assert.equal(combo.duracaoMinutos, 70);
    assert.equal(combo.intervaloAposMinutos, 10);
    assert.equal(combo.ocupacaoTotalMinutos, 80);
  });

  it('aceita preco digitado como texto brasileiro', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/servicos',
      headers: cab,
      payload: {
        nome: 'Hidratacao',
        duracaoMinutos: 45,
        precoCentavos: 'R$ 89,90',
        profissionais: [{ professionalId: ctx.carlos.id }]
      }
    });

    assert.equal(res.statusCode, 201);
    const servico = res.json().servico;
    assert.equal(servico.precoCentavos, 8990);
    assert.equal(servico.precoFormatado.replace(/ /g, ' '), 'R$ 89,90');

    ctx.hidratacaoId = servico.id;
  });

  it('recusa profissional que nao existe nesta empresa', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/servicos',
      headers: cab,
      payload: {
        nome: 'Servico Fantasma',
        duracaoMinutos: 30,
        precoCentavos: 5000,
        profissionais: [{ professionalId: 'prof_inexistente' }]
      }
    });

    assert.equal(res.statusCode, 422);
  });

  it('recusa duracao menor que 5 minutos', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/servicos',
      headers: cab,
      payload: { nome: 'Instantaneo', duracaoMinutos: 1, precoCentavos: 1000 }
    });

    assert.equal(res.statusCode, 400);
  });

  it('troca os profissionais de um servico', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/servicos/${ctx.hidratacaoId}`,
      headers: cab,
      payload: {
        profissionais: [
          { professionalId: ctx.carlos.id },
          { professionalId: ctx.julia.id, precoCentavos: 9990, duracaoMinutos: 30 }
        ]
      }
    });

    assert.equal(res.statusCode, 200);
    const servico = res.json().servico;
    assert.equal(servico.profissionais.length, 2);

    const julia = servico.profissionais.find((p) => p.nome.startsWith('Julia'));
    assert.equal(julia.precoCentavos, 9990);
    assert.equal(julia.duracaoMinutos, 30);
  });

  /**
   * Excluir um servico com horario ja marcado quebraria a agenda.
   * O caminho certo e desativar.
   */
  it('nao exclui servico com agendamento futuro', async () => {
    const { db } = await import('../src/db/client.js');
    const { leads, services } = await import('../src/db/schema/index.js');
    const [lead] = await db.select().from(leads).limit(1);
    const [svc] = await db.select().from(services).limit(1);

    // Marca um horario usando esse servico.
    const listaLivres = await app.inject({
      method: 'GET',
      url: `/api/agenda/horarios-livres?data=${proximaSegundaStr()}&professionalId=${ctx.carlos.id}&serviceId=${svc.id}`,
      headers: cab
    });

    const primeiro = listaLivres.json().horarios[0];
    await app.inject({
      method: 'POST',
      url: '/api/agenda',
      headers: cab,
      payload: {
        leadId: lead.id,
        serviceId: svc.id,
        professionalId: ctx.carlos.id,
        data: proximaSegundaStr(),
        hora: primeiro.hora
      }
    });

    const res = await app.inject({ method: 'DELETE', url: `/api/servicos/${svc.id}`, headers: cab });

    assert.equal(res.statusCode, 409);
    assert.match(res.json().erro.mensagem, /Desative/i);
  });

  it('atendente le mas NAO muda preco', async () => {
    const ler = await app.inject({ method: 'GET', url: '/api/servicos', headers: cabAtendente });
    assert.equal(ler.statusCode, 200);

    const mudar = await app.inject({
      method: 'PATCH',
      url: `/api/servicos/${ctx.hidratacaoId}`,
      headers: cabAtendente,
      payload: { precoCentavos: 100 }
    });
    assert.equal(mudar.statusCode, 403);
  });
});

describe('produtos e estoque', () => {
  it('o estoque inicial entra como lancamento, nao como saldo magico', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/produtos',
      headers: cab,
      payload: { nome: 'Cera Modeladora', precoCentavos: 5000, custoCentavos: 2000, estoque: 10, estoqueMinimo: 3 }
    });

    assert.equal(res.statusCode, 201);
    const produto = res.json().produto;

    assert.equal(produto.estoque, 10);
    assert.equal(produto.historicoEstoque.length, 1, 'o saldo inicial precisa ter origem no historico');
    assert.equal(produto.historicoEstoque[0].tipo, 'entrada');
    assert.equal(produto.historicoEstoque[0].estoqueResultante, 10);

    ctx.produtoId = produto.id;
  });

  it('calcula a margem', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/produtos/${ctx.produtoId}`, headers: cab });
    const p = res.json().produto;

    assert.equal(p.margemCentavos, 3000);
    assert.equal(p.margemPercentual, 60);
  });

  it('marca estoque baixo', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/produtos?apenasEstoqueBaixo=true', headers: cab });
    const nomes = res.json().produtos.map((p) => p.nome);

    // O seed criou "Oleo para Barba" com estoque 3 e minimo 5.
    assert.ok(nomes.includes('Oleo para Barba'));
    assert.ok(!nomes.includes('Cera Modeladora'), 'estoque 10 com minimo 3 nao e baixo');
  });

  it('nao deixa mudar estoque pelo cadastro — exige ajuste com motivo', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/produtos/${ctx.produtoId}`,
      headers: cab,
      payload: { estoque: 999 }
    });

    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /ajuste de estoque/i);
  });

  it('exige motivo no ajuste', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/produtos/${ctx.produtoId}/estoque`,
      headers: cab,
      payload: { tipo: 'entrada', quantidade: 5 }
    });

    assert.equal(res.statusCode, 400);
  });

  it('registra entrada com motivo e mantem o historico fechando', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/produtos/${ctx.produtoId}/estoque`,
      headers: cab,
      payload: { tipo: 'entrada', quantidade: 5, motivo: 'Recebimento nota 123' }
    });

    assert.equal(res.statusCode, 200);
    const p = res.json().produto;
    assert.equal(p.estoque, 15);
    assert.equal(p.historicoEstoque[0].estoqueResultante, 15);
    assert.equal(p.historicoEstoque[0].motivo, 'Recebimento nota 123');
  });

  it('recusa saida maior que o estoque', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/produtos/${ctx.produtoId}/estoque`,
      headers: cab,
      payload: { tipo: 'saida', quantidade: 9999, motivo: 'Teste' }
    });

    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /insuficiente/i);
  });
});

describe('venda de produto', () => {
  it('baixa o estoque e congela o preco na mesma operacao', async () => {
    const antes = await app.inject({ method: 'GET', url: `/api/produtos/${ctx.produtoId}`, headers: cab });
    const estoqueAntes = antes.json().produto.estoque;

    const res = await app.inject({
      method: 'POST',
      url: '/api/vendas',
      headers: cabAtendente,
      payload: { productId: ctx.produtoId, quantidade: 2 }
    });

    assert.equal(res.statusCode, 201);
    const venda = res.json().venda;
    assert.equal(venda.totalCentavos, 10000);

    const depois = await app.inject({ method: 'GET', url: `/api/produtos/${ctx.produtoId}`, headers: cab });
    const p = depois.json().produto;

    assert.equal(p.estoque, estoqueAntes - 2);
    assert.equal(p.historicoEstoque[0].tipo, 'venda');
  });

  /**
   * Se a venda falhar por estoque, NADA pode ter acontecido: nem a baixa,
   * nem o registro. E o que a transacao garante.
   */
  it('venda sem estoque nao deixa rastro', async () => {
    const antes = await app.inject({ method: 'GET', url: `/api/produtos/${ctx.produtoId}`, headers: cab });
    const estoqueAntes = antes.json().produto.estoque;
    const movimentosAntes = antes.json().produto.historicoEstoque.length;

    // 500 passa na validacao (o teto por venda e 1000) mas excede o estoque,
    // que e exatamente o caminho que queremos exercitar: a falha tem que
    // acontecer na regra de estoque, dentro da transacao.
    const res = await app.inject({
      method: 'POST',
      url: '/api/vendas',
      headers: cabAtendente,
      payload: { productId: ctx.produtoId, quantidade: 500 }
    });

    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /insuficiente/i);

    const depois = await app.inject({ method: 'GET', url: `/api/produtos/${ctx.produtoId}`, headers: cab });
    assert.equal(depois.json().produto.estoque, estoqueAntes, 'o estoque nao pode ter mudado');
    assert.equal(
      depois.json().produto.historicoEstoque.length,
      movimentosAntes,
      'uma venda que falhou nao pode deixar lancamento'
    );
  });

  it('recusa quantidade zero ou negativa', async () => {
    for (const quantidade of [0, -5]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/vendas',
        headers: cabAtendente,
        payload: { productId: ctx.produtoId, quantidade }
      });
      assert.equal(res.statusCode, 400);
    }
  });
});

describe('metricas do catalogo', () => {
  it('resume servicos e produtos', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/catalogo/metricas', headers: cab });

    assert.equal(res.statusCode, 200);
    const m = res.json();

    assert.ok(m.servicos.total >= 5);
    assert.ok(m.produtos.total >= 3);
    assert.ok(m.produtos.estoqueBaixo >= 1);
    assert.ok(m.produtos.valorEstoqueFormatado.startsWith('R$'));
  });
});

/** Proxima segunda-feira, para os testes que precisam de um dia util. */
function proximaSegundaStr() {
  const d = new Date();
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() !== 1);
  return d.toISOString().slice(0, 10);
}
