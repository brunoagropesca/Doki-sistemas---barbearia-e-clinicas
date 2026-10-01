import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

/**
 * Cadastro da equipe e o resgate do cliente excluido.
 *
 * O teste do cliente excluido guarda um defeito que travava o atendimento
 * inteiro: o telefone e unico por empresa e o indice nao enxerga exclusao
 * logica, entao quem fosse excluido e voltasse a escrever nao podia ser
 * encontrado (a busca esconde excluidos) nem criado (o banco recusa o
 * telefone repetido) — e cada mensagem dele falhava.
 */

let app;
let cab;
const ctx = {};

/** PNG de 1x1 transparente, em data URL. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

before(async () => {
  const criado = await criarAppDeTeste();
  app = criado.app;
  const l = await entrar(app);
  cab = l.cabecalho;
  ctx.tenantId = l.usuario.tenantId;
});

after(async () => {
  await app?.close();
});

describe('cliente que foi excluido e voltou', () => {
  it('restaura o cadastro em vez de recusar a mensagem', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const telefone = '5511955554444';

    const original = await leads.encontrarOuCriarPorTelefone(ctx.tenantId, telefone, 'Cliente Sumido');

    const apagar = await app.inject({ method: 'DELETE', url: `/api/leads/${original.id}`, headers: cab });
    assert.equal(apagar.statusCode, 200);

    // A mensagem seguinte dele chega ao gateway exatamente assim.
    const devolta = await leads.encontrarOuCriarPorTelefone(ctx.tenantId, telefone, 'Cliente Sumido');

    assert.equal(devolta.id, original.id, 'devia reaproveitar o cadastro, nao criar outro');
    assert.equal(devolta.deletedAt, null, 'devia ter saido da lixeira');

    // E o historico dele continua acessivel pela API.
    const ficha = await app.inject({ method: 'GET', url: `/api/leads/${original.id}`, headers: cab });
    assert.equal(ficha.statusCode, 200);
  });
});

describe('profissionais', () => {
  it('cadastra com foto, jornada e servicos proprios', async () => {
    const { servicos } = (await app.inject({ method: 'GET', url: '/api/servicos', headers: cab })).json();
    const corte = servicos[0];
    ctx.servico = corte;

    const res = await app.inject({
      method: 'POST',
      url: '/api/profissionais',
      headers: cab,
      payload: {
        nome: 'Rita Teste',
        funcao: 'Barbeira',
        cor: '#07CA6B',
        telefone: '11988887777',
        foto: PNG,
        jornada: { dias: { 2: [{ inicio: '10:00', fim: '19:00' }] }, intervaloMinutos: 30 },
        // Ela cobra mais caro e demora menos que o padrao do servico.
        servicos: [{ serviceId: corte.id, precoCentavos: 9900, duracaoMinutos: 20 }]
      }
    });

    assert.equal(res.statusCode, 201, res.body);
    const p = res.json().profissional;

    assert.equal(p.nome, 'Rita Teste');
    assert.match(p.fotoUrl, /^\/api\/arquivos\/profissional-/);
    assert.equal(p.telefoneFormatado, '+55 (11) 98888-7777');

    const s = p.servicos.find((x) => x.serviceId === corte.id);
    assert.equal(s.precoCentavos, 9900);
    assert.equal(s.duracaoMinutos, 20);
    assert.equal(s.precoProprio, true, 'precisa dizer que o valor e dela, nao o padrao');

    ctx.profissionalId = p.id;
    ctx.fotoUrl = p.fotoUrl;
  });

  it('serve a foto que acabou de guardar', async () => {
    const res = await app.inject({ method: 'GET', url: ctx.fotoUrl, headers: cab });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /image\/png/);
  });

  it('recusa ler arquivo fora da pasta publica', async () => {
    for (const nome of ['..%2F..%2F.env', '....//....//package.json']) {
      // Logado, para provar que nem com sessao se sai da pasta.
      const res = await app.inject({ method: 'GET', url: `/api/arquivos/${nome}`, headers: cab });
      assert.equal(res.statusCode, 404, `devia recusar "${nome}"`);
    }
  });

  it('campo em branco volta a valer o preco do servico', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/profissionais/${ctx.profissionalId}/servicos`,
      headers: cab,
      payload: { servicos: [{ serviceId: ctx.servico.id, precoCentavos: null, duracaoMinutos: null }] }
    });

    assert.equal(res.statusCode, 200);
    const s = res.json().servicos[0];

    assert.equal(s.precoProprio, false);
    assert.equal(s.precoCentavos, ctx.servico.precoCentavos, 'sem valor proprio, vale o do servico');
  });

  it('o profissional novo ja pode receber agendamento', async () => {
    // Uma terca-feira, o unico dia da jornada da Rita.
    let d = new Date();
    do {
      d = new Date(d.getTime() + 86400000);
    } while (d.getDay() !== 2);
    const terca = d.toLocaleDateString('sv-SE');

    const res = await app.inject({
      method: 'GET',
      url: `/api/agenda/horarios-livres?data=${terca}&professionalId=${ctx.profissionalId}&serviceId=${ctx.servico.id}`,
      headers: cab
    });

    assert.equal(res.statusCode, 200, res.body);
    const corpo = res.json();
    assert.ok(corpo.horarios.length > 0, 'a jornada cadastrada devia gerar horarios');
    assert.equal(corpo.horarios[0].hora, '10:00', 'a jornada dela comeca as 10h');
  });

  it('recusa imagem que nao e imagem', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/profissionais',
      headers: cab,
      payload: { nome: 'Teste Formato', foto: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' }
    });

    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /formato/i);
  });

  it('remove de vez quem nunca atendeu ninguem', async () => {
    const criado = (
      await app.inject({
        method: 'POST',
        url: '/api/profissionais',
        headers: cab,
        payload: { nome: 'Contratado por engano' }
      })
    ).json().profissional;

    const res = await app.inject({ method: 'DELETE', url: `/api/profissionais/${criado.id}`, headers: cab });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().desativado, false, 'sem historico, pode sair da lista de vez');

    const depois = await app.inject({ method: 'GET', url: `/api/profissionais/${criado.id}`, headers: cab });
    assert.equal(depois.statusCode, 404);
  });

  /**
   * A regra que protege o historico: quem ja atendeu alguem nao some, porque
   * o faturamento e a agenda antiga apontam para ele. Vira inativo.
   */
  it('desativa, em vez de apagar, quem ja tem atendimento no historico', async () => {
    const { db } = await import('../src/db/client.js');
    const { appointments, leads } = await import('../src/db/schema/index.js');
    const [lead] = await db.select().from(leads);

    await db.insert(appointments).values({
      id: `apt_eq_${Math.random().toString(36).slice(2)}`,
      tenantId: ctx.tenantId,
      leadId: lead.id,
      serviceId: ctx.servico.id,
      professionalId: ctx.profissionalId,
      inicioEm: new Date(Date.now() - 86400000),
      fimEm: new Date(Date.now() - 86400000 + 1800000),
      status: 'concluido',
      precoCentavos: 9900
    });

    const res = await app.inject({ method: 'DELETE', url: `/api/profissionais/${ctx.profissionalId}`, headers: cab });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().desativado, true, 'nao pode sumir: o historico aponta para ele');

    const depois = (
      await app.inject({ method: 'GET', url: `/api/profissionais/${ctx.profissionalId}`, headers: cab })
    ).json();
    assert.equal(depois.profissional.ativo, false);
  });
});

describe('produtos com foto', () => {
  it('guarda a imagem como arquivo e devolve o caminho', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/produtos',
      headers: cab,
      payload: { nome: 'Pomada Teste', precoCentavos: 4500, custoCentavos: 2000, estoque: 3, foto: PNG }
    });

    assert.equal(res.statusCode, 201, res.body);
    const p = res.json().produto;

    assert.match(p.fotoUrl, /^\/api\/arquivos\/produto-/);
    // O caminho e curto: a imagem NAO esta dentro do JSON do produto.
    assert.ok(p.fotoUrl.length < 120, 'o banco deve guardar o caminho, nao a imagem');

    const arquivo = await app.inject({ method: 'GET', url: p.fotoUrl, headers: cab });
    assert.equal(arquivo.statusCode, 200);
  });
});
