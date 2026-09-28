import { apenas } from '../../http/plugins/autenticacao.js';
import * as service from './leads.service.js';
import {
  acaoEmLoteSchema,
  atualizarLeadSchema,
  corrigirMemoriaSchema,
  criarLeadSchema,
  listarLeadsSchema
} from './leads.schemas.js';

/**
 * Rotas do CRM.
 *
 * `req.tenantId` vem do plugin de autenticacao e e SEMPRE o da empresa de
 * quem esta logado — nunca chega pelo corpo ou pela URL. Se viesse do cliente,
 * bastaria trocar o valor na requisicao pra ler os contatos de outra empresa.
 */
export async function rotasLeads(app) {
  /** GET /api/leads — lista com filtros e paginacao. */
  app.get('/api/leads', { config: apenas.atendente }, async (req) => {
    const filtros = listarLeadsSchema.parse(req.query);
    return service.listar(req.tenantId, filtros);
  });

  /**
   * GET /api/leads/etiquetas — as etiquetas que existem, com quantos leads.
   *
   * Alimenta o filtro de etiquetas dos Contatos. Nao ha lista fixa: quem usa
   * inventa as proprias, entao a tela precisa perguntar quais existem hoje.
   */
  app.get('/api/leads/etiquetas', { config: apenas.atendente }, async (req) => {
    return { etiquetas: await service.listarEtiquetas(req.tenantId) };
  });

  /**
   * GET /api/leads/:id — detalhe com historico.
   *
   * Rotas com caminho fixo ('/etiquetas') precisam ser declaradas ANTES
   * desta: senao '/api/leads/etiquetas' casaria aqui, com id = "etiquetas".
   */
  app.get('/api/leads/:id', { config: apenas.atendente }, async (req) => {
    return { lead: await service.obter(req.tenantId, req.params.id) };
  });

  /**
   * GET/PUT /api/leads/:id/memoria — o que a Sofia lembra deste cliente.
   * Mesma regra de privacidade das conversas (ver leads/memoria.js).
   */
  app.get('/api/leads/:id/memoria', { config: apenas.atendente }, async (req) => {
    return service.obterMemoriaDoContato(req.tenantId, req.params.id, { usuario: req.usuario });
  });

  app.put('/api/leads/:id/memoria', { config: apenas.atendente }, async (req) => {
    const dados = corrigirMemoriaSchema.parse(req.body ?? {});
    return service.corrigirMemoriaDoContato(req.tenantId, req.params.id, dados, { usuario: req.usuario });
  });

  /** POST /api/leads */
  app.post('/api/leads', { config: apenas.atendente }, async (req, res) => {
    const dados = criarLeadSchema.parse(req.body);
    const lead = await service.criar(req.tenantId, dados, { usuario: req.usuario });
    res.status(201);
    return { lead };
  });

  /** PATCH /api/leads/:id */
  app.patch('/api/leads/:id', { config: apenas.atendente }, async (req) => {
    const dados = atualizarLeadSchema.parse(req.body);
    const lead = await service.atualizar(req.tenantId, req.params.id, dados, { usuario: req.usuario });
    return { lead };
  });

  /**
   * POST /api/leads/:id/foto — buscar de novo a foto do perfil no WhatsApp.
   *
   * A foto entra sozinha quando o cliente escreve, mas quem ja estava na base
   * antes disso nunca recebeu a sua. Este botao resolve esses casos sem
   * esperar o cliente mandar mensagem.
   */
  app.post('/api/leads/:id/foto', { config: apenas.atendente }, async (req) => {
    return service.atualizarFotoDoWhatsapp(req.tenantId, req.params.id);
  });

  /** POST /api/leads/lote — etiquetar, mover ou bloquear campanha em massa. */
  app.post('/api/leads/lote', { config: apenas.atendente }, async (req) => {
    const dados = acaoEmLoteSchema.parse(req.body);
    return service.acaoEmLote(req.tenantId, dados, { usuario: req.usuario });
  });

  /**
   * DELETE /api/leads/:id
   *
   * Exige admin. No sistema antigo, `POST /api/leads/batch-delete` apagava
   * contatos em lote sem exigir login nenhum.
   */
  app.delete('/api/leads/:id', { config: apenas.admin }, async (req) => {
    return service.excluir(req.tenantId, req.params.id, { usuario: req.usuario });
  });
}
