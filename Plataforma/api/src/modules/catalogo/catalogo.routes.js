import { apenas } from '../../http/plugins/autenticacao.js';
import * as service from './catalogo.service.js';
import {
  ajustarEstoqueSchema,
  atualizarProdutoSchema,
  atualizarServicoSchema,
  criarProdutoSchema,
  criarServicoSchema,
  listarProdutosSchema,
  listarServicosSchema,
  renomearCategoriaSchema,
  venderProdutoSchema
} from './catalogo.schemas.js';

/**
 * Rotas do catalogo.
 *
 * Quem LE o catalogo e o atendente (precisa pra agendar e pra vender).
 * Quem MUDA preco, duracao ou estoque e o admin — sao decisoes que afetam
 * faturamento.
 */
export async function rotasCatalogo(app) {
  // --- Numeros ---
  app.get('/api/catalogo/metricas', { config: apenas.atendente }, async (req) => {
    return service.metricas(req.tenantId);
  });

  // --- Servicos ---

  app.get('/api/servicos', { config: apenas.atendente }, async (req) => {
    const filtros = listarServicosSchema.parse(req.query);
    return { servicos: await service.listarServicos(req.tenantId, filtros) };
  });

  app.post('/api/servicos/categorias/renomear', { config: apenas.admin }, async (req) => {
    const dados = renomearCategoriaSchema.parse(req.body);
    return service.renomearCategoriaDeServicos(req.tenantId, dados, { usuario: req.usuario });
  });

  app.get('/api/servicos/:id', { config: apenas.atendente }, async (req) => {
    return { servico: await service.obterServico(req.tenantId, req.params.id) };
  });

  app.post('/api/servicos', { config: apenas.admin }, async (req, res) => {
    const dados = criarServicoSchema.parse(req.body);
    const servico = await service.criarServico(req.tenantId, dados, { usuario: req.usuario });
    res.status(201);
    return { servico };
  });

  app.patch('/api/servicos/:id', { config: apenas.admin }, async (req) => {
    const dados = atualizarServicoSchema.parse(req.body);
    const servico = await service.atualizarServico(req.tenantId, req.params.id, dados, { usuario: req.usuario });
    return { servico };
  });

  app.delete('/api/servicos/:id', { config: apenas.admin }, async (req) => {
    return service.excluirServico(req.tenantId, req.params.id, { usuario: req.usuario });
  });

  // --- Produtos ---

  app.get('/api/produtos', { config: apenas.atendente }, async (req) => {
    const filtros = listarProdutosSchema.parse(req.query);
    return { produtos: await service.listarProdutos(req.tenantId, filtros) };
  });

  app.get('/api/produtos/:id', { config: apenas.atendente }, async (req) => {
    return { produto: await service.obterProduto(req.tenantId, req.params.id) };
  });

  app.post('/api/produtos', { config: apenas.admin }, async (req, res) => {
    const dados = criarProdutoSchema.parse(req.body);
    const produto = await service.criarProduto(req.tenantId, dados, { usuario: req.usuario });
    res.status(201);
    return { produto };
  });

  app.patch('/api/produtos/:id', { config: apenas.admin }, async (req) => {
    const dados = atualizarProdutoSchema.parse(req.body);
    const produto = await service.atualizarProduto(req.tenantId, req.params.id, dados, { usuario: req.usuario });
    return { produto };
  });

  /** POST /api/produtos/:id/estoque — recebimento, perda, contagem. */
  app.post('/api/produtos/:id/estoque', { config: apenas.admin }, async (req) => {
    const dados = ajustarEstoqueSchema.parse(req.body);
    const produto = await service.ajustarEstoque(req.tenantId, req.params.id, dados, { usuario: req.usuario });
    return { produto };
  });

  app.delete('/api/produtos/:id', { config: apenas.admin }, async (req) => {
    return service.excluirProduto(req.tenantId, req.params.id, { usuario: req.usuario });
  });

  // --- Vendas ---

  /** Vender e operacao de balcao: o atendente precisa poder. */
  app.post('/api/vendas', { config: apenas.atendente }, async (req, res) => {
    const dados = venderProdutoSchema.parse(req.body);
    const venda = await service.venderProduto(req.tenantId, dados, { usuario: req.usuario });
    res.status(201);
    return { venda };
  });

  app.get('/api/vendas', { config: apenas.atendente }, async (req) => {
    return { vendas: await service.listarVendas(req.tenantId, { leadId: req.query.leadId }) };
  });
}
