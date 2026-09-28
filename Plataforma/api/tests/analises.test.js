import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

/**
 * Dashboard do dono: as contas que ele usa para decidir (faturamento, mapa de
 * calor, ocupacao, estoque) batem com o que foi registrado.
 */

let app;
let dono;
let cabRecepcao;
const ctx = {};

const hojeSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const menosDias = (data, n) => {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

/** Um atendimento encerrado, direto no historico (e de la que o dashboard le). */
async function atendimento({ data, hora = 10, resultado = 'concluido', valor = 5000, leadId, clienteNovo = false, prof = ctx.prof }) {
  const { ID } = await import('../src/core/ids.js');
  const [a, m, d] = data.split('-').map(Number);
  await ctx.db.insert(ctx.s.serviceHistory).values({
    id: ID.historico(),
    tenantId: ctx.tenantId,
    resultado,
    professionalId: prof.id,
    professionalNome: prof.nome,
    serviceId: ctx.serv.id,
    serviceNome: ctx.serv.nome,
    serviceCategoria: ctx.serv.categoria,
    leadId,
    clienteNovo,
    precoCentavos: valor,
    descontoCentavos: 0,
    valorCentavos: resultado === 'concluido' ? valor : 0,
    precoTabelaCentavos: valor,
    duracaoMinutos: 60,
    inicioEm: new Date(Date.UTC(a, m - 1, d, hora + 3)),
    encerradoEm: new Date(Date.UTC(a, m - 1, d, hora + 4)),
    dataLocal: data,
    diaSemana: new Date(Date.UTC(a, m - 1, d)).getUTCDay(),
    horaLocal: hora,
    origem: 'humano'
  });
}

const pegar = async (query = 'dias=30', cab = dono.cabecalho) => app.inject({ method: 'GET', url: `/api/analises?${query}`, headers: cab });

before(async () => {
  ({ app } = await criarAppDeTeste());
  dono = await entrar(app);
  ctx.tenantId = dono.usuario.tenantId;
  ({ cabecalho: cabRecepcao } = await entrar(app, 'recepcao'));
  ctx.db = (await import('../src/db/client.js')).db;
  ctx.s = await import('../src/db/schema/index.js');
  const { eq } = await import('drizzle-orm');

  [ctx.prof] = await ctx.db.select().from(ctx.s.professionals).where(eq(ctx.s.professionals.tenantId, ctx.tenantId));
  [ctx.serv] = await ctx.db.select().from(ctx.s.services).where(eq(ctx.s.services.tenantId, ctx.tenantId));

  const leads = await import('../src/modules/leads/leads.service.js');
  ctx.ana = await leads.criar(ctx.tenantId, { nome: 'Dash Ana', telefone: '5511955500001' });
  ctx.bia = await leads.criar(ctx.tenantId, { nome: 'Dash Bia', telefone: '5511955500002' });

  // Linha de base: o que ja existia antes deste teste.
  ctx.base = (await pegar()).json();

  const hoje = hojeSP();
  ctx.hoje = hoje;
  await atendimento({ data: menosDias(hoje, 1), hora: 10, valor: 5000, leadId: ctx.ana.id, clienteNovo: true });
  await atendimento({ data: menosDias(hoje, 2), hora: 10, valor: 7000, leadId: ctx.ana.id });
  await atendimento({ data: menosDias(hoje, 2), hora: 15, valor: 3000, leadId: ctx.bia.id, clienteNovo: true });
  await atendimento({ data: menosDias(hoje, 3), hora: 9, resultado: 'faltou', leadId: ctx.bia.id });
  // Periodo anterior (35 dias atras): entra so na comparacao.
  await atendimento({ data: menosDias(hoje, 35), hora: 11, valor: 4000, leadId: ctx.bia.id });

  // Uma venda de produto pelo caminho de verdade (baixa estoque e registra).
  const [prod] = await ctx.db.select().from(ctx.s.products).where(eq(ctx.s.products.tenantId, ctx.tenantId));
  ctx.prod = prod;
  await ctx.db.update(ctx.s.products).set({ estoque: 50, ativo: true }).where(eq(ctx.s.products.id, prod.id));
  const venda = await app.inject({ method: 'POST', url: '/api/vendas', headers: dono.cabecalho, payload: { productId: prod.id, quantidade: 2 } });
  assert.equal(venda.statusCode, 201, venda.body);
});

after(async () => {
  await app?.close();
});

describe('dashboard do dono', () => {
  it('so o dono ve', async () => {
    assert.equal((await pegar('dias=30', cabRecepcao)).statusCode, 403);
    assert.equal((await pegar()).statusCode, 200);
  });

  it('faturamento = servicos concluidos + produtos; falta nao fatura, mas conta', async () => {
    const r = (await pegar()).json();
    const b = ctx.base.resumo;
    assert.equal(r.resumo.servicosCentavos - b.servicosCentavos, 15000);
    assert.equal(r.resumo.produtosCentavos - b.produtosCentavos, ctx.prod.precoCentavos * 2);
    assert.equal(r.resumo.faturamentoCentavos, r.resumo.servicosCentavos + r.resumo.produtosCentavos);
    assert.equal(r.resumo.atendimentos - b.atendimentos, 3);
    assert.equal(r.resumo.faltas - b.faltas, 1);
    assert.equal(r.resumo.itensVendidos - b.itensVendidos, 2);
  });

  it('o periodo anterior (mesmo tamanho) vem junto para a comparacao', async () => {
    const r = (await pegar()).json();
    assert.equal(r.periodo.dias, 30);
    assert.equal(r.periodo.anterior.ate, menosDias(r.periodo.de, 1));
    assert.ok(r.resumoAnterior.servicosCentavos >= 4000);
  });

  it('mapa de calor: cada atendimento cai no dia da semana e na hora certos', async () => {
    const r = (await pegar()).json();
    const ontem = menosDias(ctx.hoje, 1);
    const dia = new Date(`${ontem}T12:00:00Z`).getUTCDay();
    const baseCel = ctx.base.calor.atendimentos[dia][10];
    assert.ok(r.calor.atendimentos[dia][10] - baseCel >= 1);
    assert.equal(r.calor.atendimentos.length, 7);
    assert.equal(r.calor.atendimentos[0].length, 24);
    // Totais por hora e por dia fecham com a matriz.
    const soma = r.calor.atendimentos.flat().reduce((s, v) => s + v, 0);
    assert.equal(soma, r.calor.porHora.atendimentos.reduce((s, v) => s + v, 0));
    assert.equal(soma, r.calor.porDiaSemana.atendimentos.reduce((s, v) => s + v, 0));
    assert.ok(r.calor.picos.atendimentos.rotulo.includes('h'));
  });

  it('mapas do mes (semana do mes x dia) e do ano (mes x dia): mesmo total, celula certa', async () => {
    const r = (await pegar()).json();
    const ontem = menosDias(ctx.hoje, 1);
    const dia = new Date(`${ontem}T12:00:00Z`).getUTCDay();
    const { mes, ano } = r.calor.visoes;
    assert.equal(mes.linhas.length, 5);
    assert.equal(ano.linhas.length, 12);
    assert.equal(mes.atendimentos[0].length, 7);
    // O atendimento de ontem cai na semana do mes e no mes certos.
    const semanaDoMes = Math.min(4, Math.floor((Number(ontem.slice(8, 10)) - 1) / 7));
    assert.ok(mes.atendimentos[semanaDoMes][dia] >= 1);
    assert.ok(ano.atendimentos[Number(ontem.slice(5, 7)) - 1][dia] >= 1);
    // As tres visoes somam o mesmo total do periodo.
    const total = r.calor.atendimentos.flat().reduce((s, v) => s + v, 0);
    for (const v of [mes, ano]) {
      assert.equal(v.atendimentos.flat().reduce((s, x) => s + x, 0), total);
      assert.equal(v.porLinha.atendimentos.reduce((s, x) => s + x, 0), total);
      assert.equal(v.porColuna.atendimentos.reduce((s, x) => s + x, 0), total);
    }
  });

  it('profissional: faturamento, clientes e ocupacao da jornada', async () => {
    const r = (await pegar()).json();
    const p = r.profissionais.find((x) => x.id === ctx.prof.id);
    const antes = ctx.base.profissionais.find((x) => x.id === ctx.prof.id);
    assert.equal(p.faturamentoCentavos - (antes?.faturamentoCentavos ?? 0), 15000);
    assert.ok(p.horasDisponiveis > 0, 'a jornada do cadastro vira horas disponiveis');
    assert.ok(p.ocupacao > 0 && p.ocupacao <= 100);
  });

  it('produtos: vendidos, margem e estoque', async () => {
    const r = (await pegar()).json();
    const p = r.produtos.lista.find((x) => x.id === ctx.prod.id);
    assert.ok(p.vendidos >= 2);
    assert.equal(p.estoque, 48, 'a venda baixou o estoque');
    assert.ok(r.produtos.estoque.valorVendaCentavos > 0);
  });

  it('clientes: top por gasto e frequencia de retorno', async () => {
    const r = (await pegar()).json();
    const ana = r.clientes.top.find((c) => c.id === ctx.ana.id);
    assert.equal(ana.gastoCentavos, 12000);
    assert.equal(ana.visitas, 2);
    assert.ok(r.clientes.frequenciaRetornoDias !== null);
  });

  it('periodo longo agrupa por semana ou mes; periodo invalido e recusado', async () => {
    assert.equal((await pegar('dias=365')).json().periodo.granularidade, 'mes');
    assert.equal((await pegar('dias=90')).json().periodo.granularidade, 'semana');
    // Datas bem escritas, mas invertidas: recusa pela REGRA (422), nao pelo formato.
    assert.equal((await pegar('de=2026-09-10&ate=2026-09-01')).statusCode, 422);
    assert.equal((await pegar('de=2026-02-31&ate=2026-03-02')).statusCode, 400, 'dia que nao existe');
    assert.equal((await pegar('de=10/09/2026&ate=2026-09-01')).statusCode, 400, 'formato errado');
  });

  // Ja houve regressao aqui: a validacao recusava TODA data (o filtro
  // personalizado e o "Este mes" da tela nunca funcionaram).
  it('filtro por data: de/ate personalizados valem e contam so o intervalo', async () => {
    const ontem = menosDias(ctx.hoje, 1);
    const r = await pegar(`de=${ontem}&ate=${ontem}`);
    assert.equal(r.statusCode, 200, r.body);
    const d = r.json();
    assert.equal(d.periodo.de, ontem);
    assert.equal(d.periodo.ate, ontem);
    assert.equal(d.periodo.dias, 1);
    const baseOntem = ctx.base.serie.find((b) => b.inicio === ontem)?.servicosCentavos ?? 0;
    assert.equal(d.resumo.servicosCentavos - baseOntem, 5000, 'so o atendimento de ontem');

    // So "de": vai ate hoje.
    const soDe = (await pegar(`de=${menosDias(ctx.hoje, 4)}`)).json();
    assert.equal(soDe.periodo.ate, ctx.hoje);
    assert.equal(soDe.periodo.dias, 5);
  });

  it('periodo do dia 1 dentro de um mes compara com os mesmos dias do mes anterior', async () => {
    const d = (await pegar('de=2026-03-01&ate=2026-03-10')).json();
    assert.deepEqual([d.periodo.anterior.de, d.periodo.anterior.ate], ['2026-02-01', '2026-02-10']);
    const mesInteiro = (await pegar('de=2026-04-01&ate=2026-04-30')).json();
    assert.deepEqual([mesInteiro.periodo.anterior.de, mesInteiro.periodo.anterior.ate], ['2026-03-01', '2026-03-31']);
    // 31/03 nao existe em fevereiro: para no ultimo dia dele.
    const fimDeMes = (await pegar('de=2026-03-01&ate=2026-03-31')).json();
    assert.equal(fimDeMes.periodo.anterior.ate, '2026-02-28');
  });

  it('semana/mes cortado pelo periodo vem marcado como parcial e comeca dentro dele', async () => {
    const d = (await pegar('dias=90')).json();
    assert.equal(d.serie[0].inicio, d.periodo.de, 'a 1a coluna nao comeca antes do periodo');
    assert.equal(d.serie.at(-1).fim, d.periodo.ate);
    assert.equal(d.serie.reduce((s, b) => s + b.dias, 0), 90);
    for (const b of d.serie) assert.equal(b.parcial, b.dias < 7);
  });

  it('exporta o dashboard para Excel (.xlsx) com os mesmos numeros', async () => {
    const { inflateRawSync } = await import('node:zlib');
    const r = await app.inject({ method: 'GET', url: '/api/analises/exportar?dias=30', headers: dono.cabecalho });
    assert.equal(r.statusCode, 200, r.body);
    assert.match(r.headers['content-type'], /spreadsheetml\.sheet/);
    assert.match(r.headers['content-disposition'], /attachment; filename="dashboard_\d{4}-\d{2}-\d{2}_a_\d{4}-\d{2}-\d{2}\.xlsx"/);

    // Abre o ZIP pelo diretorio central e descomprime cada parte.
    const buf = r.rawPayload;
    const fim = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(fim > 0, 'e um ZIP');
    const partes = {};
    let p = buf.readUInt32LE(fim + 16);
    for (let i = 0; i < buf.readUInt16LE(fim + 10); i++) {
      const tamNome = buf.readUInt16LE(p + 28);
      const nome = buf.toString('utf8', p + 46, p + 46 + tamNome);
      const local = buf.readUInt32LE(p + 42);
      const inicio = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      partes[nome] = inflateRawSync(buf.subarray(inicio, inicio + buf.readUInt32LE(p + 20))).toString('utf8');
      p += 46 + tamNome + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    for (const obrigatoria of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
      assert.ok(partes[obrigatoria], `falta ${obrigatoria}`);
    }
    for (const aba of ['Resumo', 'Serviços', 'Profissionais', 'Produtos', 'Mapa de calor']) assert.match(partes['xl/workbook.xml'], new RegExp(`name="${aba}"`));

    // O faturamento do Resumo e o do dashboard, em reais.
    const d = (await pegar('dias=30')).json();
    const resumo = partes['xl/worksheets/sheet1.xml'];
    assert.match(resumo, /Faturamento total/);
    assert.ok(resumo.includes(`<v>${d.resumo.faturamentoCentavos / 100}</v>`), 'faturamento em reais');
  });

  it('comparacao com periodo de antes dos primeiros registros vem marcada como sem base', async () => {
    const d = (await pegar('dias=30')).json();
    assert.ok(d.periodo.inicioDosDados, 'sabe desde quando ha movimento');
    // 400 dias atras: o sistema de teste nao tinha nada.
    const antigo = (await pegar('dias=365')).json();
    assert.equal(antigo.periodo.anterior.completo, false);
  });
});
