import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { carimbos, centavos, colunaTenant, exclusaoLogica } from './_shared.js';
import { professionals } from './crm.js';

/** Servico prestado: corte, barba, limpeza de pele, consulta. */
export const services = sqliteTable(
  'services',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    nome: text('nome').notNull(),
    descricao: text('descricao').notNull().default(''),
    categoria: text('categoria').notNull().default('Geral'),

    duracaoMinutos: integer('duracao_minutos').notNull().default(30),
    precoCentavos: centavos('preco_centavos'),

    /**
     * Folga depois do atendimento: limpar a estacao, trocar o lencol.
     * Conta na ocupacao da agenda, mas nao e cobrada do cliente — por isso
     * e separada da duracao.
     */
    intervaloAposMinutos: integer('intervalo_apos_minutos').notNull().default(0),

    ativo: integer('ativo', { mode: 'boolean' }).notNull().default(true),

    ...carimbos(),
    ...exclusaoLogica()
  },
  (t) => [
    index('idx_services_tenant_ativo').on(t.tenantId, t.ativo),
    index('idx_services_tenant_categoria').on(t.tenantId, t.categoria)
  ]
);

/**
 * Quais profissionais fazem quais servicos — e por quanto.
 *
 * Tabela de ligacao (um servico tem varios profissionais, um profissional faz
 * varios servicos). As colunas de sobrescrita resolvem um caso real: o barbeiro
 * senior cobra R$ 70 pelo mesmo corte que o junior cobra R$ 45, e o senior leva
 * 20 minutos onde o junior leva 40.
 *
 * Nulo nessas colunas significa "usa o valor padrao do servico".
 */
export const professionalServices = sqliteTable(
  'professional_services',
  {
    tenantId: colunaTenant(),
    professionalId: text('professional_id')
      .notNull()
      .references(() => professionals.id, { onDelete: 'cascade' }),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),

    precoCentavos: integer('preco_centavos'),
    duracaoMinutos: integer('duracao_minutos'),

    ...carimbos()
  },
  (t) => [
    primaryKey({ columns: [t.professionalId, t.serviceId] }),
    index('idx_prof_services_tenant').on(t.tenantId),
    index('idx_prof_services_service').on(t.serviceId)
  ]
);

/** Produto fisico vendido no balcao: pomada, shampoo, lamina. */
export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    nome: text('nome').notNull(),
    descricao: text('descricao').notNull().default(''),
    categoria: text('categoria').notNull().default('Geral'),
    sku: text('sku'),

    precoCentavos: centavos('preco_centavos'),
    /** Quanto custou pra empresa — permite calcular margem. */
    custoCentavos: centavos('custo_centavos'),

    /**
     * Caminho da foto, servido por `/api/arquivos/...`.
     *
     * Guardamos o CAMINHO, nao a imagem. Uma foto de produto em base64 dentro
     * da linha faz cada listagem do catalogo arrastar megabytes de imagem
     * atraves do banco, mesmo quando a tela so quer nome e preco.
     */
    fotoUrl: text('foto_url'),

    estoque: integer('estoque').notNull().default(0),
    /** Abaixo disto, a interface avisa que precisa repor. */
    estoqueMinimo: integer('estoque_minimo').notNull().default(0),

    ativo: integer('ativo', { mode: 'boolean' }).notNull().default(true),

    ...carimbos(),
    ...exclusaoLogica()
  },
  (t) => [
    index('idx_products_tenant_ativo').on(t.tenantId, t.ativo),
    index('idx_products_tenant_sku').on(t.tenantId, t.sku)
  ]
);

/**
 * Movimentacao de estoque.
 *
 * O estoque nao e simplesmente sobrescrito: cada mudanca vira uma linha aqui.
 * Assim, quando o numero na tela nao bate com a prateleira, da pra reconstruir
 * a historia e achar onde sumiu — em vez de dar de ombros e corrigir na mao.
 */
export const stockMovements = sqliteTable(
  'stock_movements',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),

    tipo: text('tipo', { enum: ['entrada', 'saida', 'ajuste', 'venda', 'perda'] }).notNull(),
    /** Positivo entra, negativo sai. */
    quantidade: integer('quantidade').notNull(),
    /** Estoque depois do movimento — congela o historico. */
    estoqueResultante: integer('estoque_resultante').notNull(),

    motivo: text('motivo').notNull().default(''),
    /** Aponta pra venda que gerou a baixa, quando houver. */
    referenciaId: text('referencia_id'),

    ...carimbos()
  },
  (t) => [index('idx_stock_tenant_produto').on(t.tenantId, t.productId, t.createdAt)]
);
