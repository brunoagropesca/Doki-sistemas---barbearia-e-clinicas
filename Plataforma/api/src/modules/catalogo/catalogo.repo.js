import { and, asc, desc, eq, inArray, isNull, like, lte, or, sql } from 'drizzle-orm';
import { db, emTransacao } from '../../db/client.js';
import { products, professionalServices, services, stockMovements } from '../../db/schema/catalog.js';
import { professionals } from '../../db/schema/crm.js';
import { productSales } from '../../db/schema/scheduling.js';
import { ID } from '../../core/ids.js';

const baseServico = (tenantId) => and(eq(services.tenantId, tenantId), isNull(services.deletedAt));
const baseProduto = (tenantId) => and(eq(products.tenantId, tenantId), isNull(products.deletedAt));

// ============================================================================
// SERVICOS
// ============================================================================

export function buscarServico(tenantId, id) {
  return db.query.services.findFirst({ where: and(baseServico(tenantId), eq(services.id, id)) });
}

export async function listarServicos(tenantId, { busca, categoria, incluirInativos = false } = {}) {
  const condicoes = [baseServico(tenantId)];
  if (!incluirInativos) condicoes.push(eq(services.ativo, true));
  if (categoria) condicoes.push(eq(services.categoria, categoria));
  if (busca) condicoes.push(like(services.nome, `%${busca.trim()}%`));

  return db
    .select()
    .from(services)
    .where(and(...condicoes))
    .orderBy(asc(services.categoria), asc(services.nome));
}

/**
 * Quais profissionais executam cada servico, com preco e duracao proprios.
 *
 * Feita em uma consulta para a lista inteira, e nao uma por servico. Numa tela
 * com 30 servicos, a versao ingenua faria 31 idas ao banco.
 */
export async function vinculosDosServicos(tenantId, serviceIds) {
  if (!serviceIds?.length) return [];

  return db
    .select({
      serviceId: professionalServices.serviceId,
      professionalId: professionalServices.professionalId,
      profissionalNome: professionals.nome,
      profissionalCor: professionals.cor,
      precoCentavos: professionalServices.precoCentavos,
      duracaoMinutos: professionalServices.duracaoMinutos
    })
    .from(professionalServices)
    .innerJoin(professionals, eq(professionals.id, professionalServices.professionalId))
    .where(
      and(
        eq(professionalServices.tenantId, tenantId),
        inArray(professionalServices.serviceId, serviceIds),
        eq(professionals.ativo, true),
        isNull(professionals.deletedAt)
      )
    );
}

export async function criarServico(tenantId, dados) {
  const registro = { id: ID.servico(), tenantId, ...dados };
  await db.insert(services).values(registro);
  return buscarServico(tenantId, registro.id);
}

export async function atualizarServico(tenantId, id, dados) {
  await db.update(services).set(dados).where(and(baseServico(tenantId), eq(services.id, id)));
  return buscarServico(tenantId, id);
}

export async function excluirServico(tenantId, id) {
  const r = await db.update(services).set({ deletedAt: new Date() }).where(and(baseServico(tenantId), eq(services.id, id)));
  return (r.rowsAffected ?? 0) > 0;
}

/**
 * Redefine quais profissionais executam um servico.
 *
 * Apaga os vinculos e recria dentro de uma transacao. Se a recriacao falhar
 * no meio, o apagar tambem volta atras — sem isso, um erro deixaria o servico
 * sem profissional nenhum e ele sumiria da tela de agendar.
 */
export async function definirProfissionaisDoServico(tenantId, serviceId, lista) {
  return emTransacao(async (tx) => {
    await tx
      .delete(professionalServices)
      .where(and(eq(professionalServices.tenantId, tenantId), eq(professionalServices.serviceId, serviceId)));

    if (lista.length > 0) {
      await tx.insert(professionalServices).values(
        lista.map((v) => ({
          tenantId,
          serviceId,
          professionalId: v.professionalId,
          precoCentavos: v.precoCentavos ?? null,
          duracaoMinutos: v.duracaoMinutos ?? null
        }))
      );
    }
  });
}

export async function profissionaisValidos(tenantId, ids) {
  if (!ids?.length) return [];
  return db
    .select({ id: professionals.id })
    .from(professionals)
    .where(
      and(
        eq(professionals.tenantId, tenantId),
        inArray(professionals.id, ids),
        isNull(professionals.deletedAt)
      )
    );
}

/** Um servico esta em uso se algum agendamento ativo aponta pra ele. */
export async function servicoTemAgendamentos(tenantId, serviceId) {
  const { appointments } = await import('../../db/schema/scheduling.js');
  const [linha] = await db
    .select({ n: sql`COUNT(*)`.as('n') })
    .from(appointments)
    .where(
      and(
        eq(appointments.tenantId, tenantId),
        eq(appointments.serviceId, serviceId),
        isNull(appointments.deletedAt),
        inArray(appointments.status, ['pendente', 'confirmado', 'em_andamento'])
      )
    );
  return Number(linha?.n) > 0;
}

// ============================================================================
// PRODUTOS
// ============================================================================

export function buscarProduto(tenantId, id) {
  return db.query.products.findFirst({ where: and(baseProduto(tenantId), eq(products.id, id)) });
}

export async function listarProdutos(tenantId, { busca, categoria, incluirInativos = false, apenasEstoqueBaixo = false } = {}) {
  const condicoes = [baseProduto(tenantId)];
  if (!incluirInativos) condicoes.push(eq(products.ativo, true));
  if (categoria) condicoes.push(eq(products.categoria, categoria));
  if (busca) condicoes.push(or(like(products.nome, `%${busca.trim()}%`), like(products.sku, `%${busca.trim()}%`)));
  if (apenasEstoqueBaixo) condicoes.push(lte(products.estoque, products.estoqueMinimo));

  return db
    .select()
    .from(products)
    .where(and(...condicoes))
    .orderBy(asc(products.categoria), asc(products.nome));
}

export async function criarProduto(tenantId, dados) {
  const registro = { id: ID.produto(), tenantId, ...dados };
  await db.insert(products).values(registro);
  return buscarProduto(tenantId, registro.id);
}

export async function atualizarProduto(tenantId, id, dados) {
  await db.update(products).set(dados).where(and(baseProduto(tenantId), eq(products.id, id)));
  return buscarProduto(tenantId, id);
}

export async function excluirProduto(tenantId, id) {
  const r = await db.update(products).set({ deletedAt: new Date() }).where(and(baseProduto(tenantId), eq(products.id, id)));
  return (r.rowsAffected ?? 0) > 0;
}

/**
 * Move o estoque gravando o lancamento junto.
 *
 * O saldo e o lancamento sao escritos na MESMA transacao. Se fossem separados,
 * uma falha no meio deixaria o saldo mudado sem historico (ou o contrario) —
 * e o numero na tela deixaria de ter explicacao.
 *
 * O `WHERE estoque >= quantidade` na saida e a trava contra estoque negativo:
 * a condicao e avaliada pelo banco no momento da escrita, entao duas vendas
 * simultaneas da ultima unidade nao passam as duas.
 */
export async function movimentarEstoque(tenantId, { productId, tipo, quantidade, motivo = '', referenciaId = null }, tx = db) {
  const executar = async (t) => {
    const produto = await t.query.products.findFirst({
      where: and(eq(products.tenantId, tenantId), eq(products.id, productId), isNull(products.deletedAt))
    });
    if (!produto) return { ok: false, motivo: 'Produto nao encontrado.' };

    const novoEstoque = produto.estoque + quantidade;
    if (novoEstoque < 0) {
      return {
        ok: false,
        motivo: `Estoque insuficiente: ha ${produto.estoque} unidade(s) de "${produto.nome}".`
      };
    }

    await t.update(products).set({ estoque: novoEstoque }).where(eq(products.id, productId));

    await t.insert(stockMovements).values({
      id: ID.produto().replace('prod', 'mov'),
      tenantId,
      productId,
      tipo,
      quantidade,
      estoqueResultante: novoEstoque,
      motivo,
      referenciaId
    });

    return { ok: true, estoque: novoEstoque, produto };
  };

  return tx === db ? emTransacao(executar) : executar(tx);
}

export function historicoEstoque(tenantId, productId, limite = 50) {
  return db.query.stockMovements.findMany({
    where: and(eq(stockMovements.tenantId, tenantId), eq(stockMovements.productId, productId)),
    orderBy: desc(stockMovements.createdAt),
    limit: limite
  });
}

// ============================================================================
// VENDAS DE PRODUTO
// ============================================================================

export async function registrarVenda(tenantId, dados, tx = db) {
  const registro = { id: ID.venda(), tenantId, ...dados };
  await tx.insert(productSales).values(registro);
  return registro.id;
}

export async function listarVendas(tenantId, { leadId, limite = 50 } = {}) {
  const condicoes = [eq(productSales.tenantId, tenantId), isNull(productSales.deletedAt)];
  if (leadId) condicoes.push(eq(productSales.leadId, leadId));

  return db
    .select({
      venda: productSales,
      produtoNome: products.nome
    })
    .from(productSales)
    .leftJoin(products, eq(products.id, productSales.productId))
    .where(and(...condicoes))
    .orderBy(desc(productSales.vendidoEm))
    .limit(limite);
}

// ============================================================================
// NUMEROS DO CATALOGO
// ============================================================================

export async function metricas(tenantId) {
  const [servicosInfo] = await db
    .select({
      total: sql`COUNT(*)`.as('total'),
      ativos: sql`COALESCE(SUM(CASE WHEN ${services.ativo} = 1 THEN 1 ELSE 0 END), 0)`.as('ativos'),
      precoMedio: sql`COALESCE(CAST(AVG(${services.precoCentavos}) AS INTEGER), 0)`.as('preco_medio')
    })
    .from(services)
    .where(baseServico(tenantId));

  const [produtosInfo] = await db
    .select({
      total: sql`COUNT(*)`.as('total'),
      ativos: sql`COALESCE(SUM(CASE WHEN ${products.ativo} = 1 THEN 1 ELSE 0 END), 0)`.as('ativos'),
      estoqueBaixo: sql`COALESCE(SUM(CASE WHEN ${products.estoque} <= ${products.estoqueMinimo} THEN 1 ELSE 0 END), 0)`.as('estoque_baixo'),
      valorEstoqueCentavos: sql`COALESCE(SUM(${products.estoque} * ${products.custoCentavos}), 0)`.as('valor_estoque')
    })
    .from(products)
    .where(baseProduto(tenantId));

  const num = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, Number(v) || 0]));
  return { servicos: num(servicosInfo), produtos: num(produtosInfo) };
}
