import { z } from 'zod';
import { apenas } from '../../http/plugins/autenticacao.js';
import * as service from './agenda.service.js';
import {
  arquivarSchema,
  atualizarDetalhesSchema,
  criarAgendamentoSchema,
  horariosLivresSchema,
  listarAgendaSchema,
  metricasSchema,
  mudarStatusSchema,
  remarcarSchema
} from './agenda.schemas.js';

export async function rotasAgenda(app) {
  /**
   * GET /api/agenda/horarios-livres
   *
   * O coracao da tela de agendar. Devolve so horarios em que o servico
   * realmente cabe, considerando jornada, duracao, folga e ocupacao.
   */
  app.get('/api/agenda/horarios-livres', { config: apenas.atendente }, async (req) => {
    const filtros = horariosLivresSchema.parse(req.query);
    return service.horariosLivres(req.tenantId, filtros);
  });

  /** GET /api/agenda/metricas — numeros do dia/periodo para o painel. */
  app.get('/api/agenda/metricas', { config: apenas.atendente }, async (req) => {
    const filtros = metricasSchema.parse(req.query);
    return service.metricas(req.tenantId, filtros, req.usuario);
  });

  /** GET /api/agenda — agendamentos do dia (ou de um intervalo). */
  app.get('/api/agenda', { config: apenas.atendente }, async (req) => {
    const filtros = listarAgendaSchema.parse(req.query);
    return { agendamentos: await service.listar(req.tenantId, filtros, req.usuario) };
  });

  /**
   * GET /api/agenda/cliente/:leadId — tudo que o cliente tem/teve com a empresa.
   *
   * Devolve `agendamentos` (as OS) e `atendimentos`: as conversas que NAO
   * viraram horario marcado. Sem as segundas, um cliente que conversou tres
   * vezes e nunca fechou apareceria no sistema como se nunca tivesse
   * procurado a empresa. Declarada antes de '/:id'.
   */
  app.get('/api/agenda/cliente/:leadId', { config: apenas.atendente }, async (req) => {
    return service.historicoDoCliente(req.tenantId, req.params.leadId);
  });

  /**
   * GET /api/agenda/atendente — os horarios que um atendente acompanha.
   * Caminho fixo, declarado antes de '/:id'.
   */
  app.get('/api/agenda/atendente', { config: apenas.atendente }, async (req) => {
    const { atendenteId } = z.object({ atendenteId: z.string().optional() }).parse(req.query);
    return { agendamentos: await service.doAtendente(req.tenantId, req.usuario, { atendenteId }) };
  });

  /** GET /api/agenda/:id */
  app.get('/api/agenda/:id', { config: apenas.atendente }, async (req) => {
    return { agendamento: await service.obter(req.tenantId, req.params.id, req.usuario) };
  });

  /** POST /api/agenda */
  app.post('/api/agenda', { config: apenas.atendente }, async (req, res) => {
    const dados = criarAgendamentoSchema.parse(req.body);
    const agendamento = await service.criar(req.tenantId, dados, { usuario: req.usuario });
    res.status(201);
    return { agendamento };
  });

  /** PATCH /api/agenda/:id/status */
  app.patch('/api/agenda/:id/status', { config: apenas.atendente }, async (req) => {
    const { status, motivo } = mudarStatusSchema.parse(req.body);
    const agendamento = await service.mudarStatus(req.tenantId, req.params.id, status, {
      usuario: req.usuario,
      motivo
    });
    return { agendamento };
  });

  /** PATCH /api/agenda/:id/remarcar */
  app.patch('/api/agenda/:id/remarcar', { config: apenas.atendente }, async (req) => {
    const dados = remarcarSchema.parse(req.body);
    const agendamento = await service.remarcar(req.tenantId, req.params.id, dados, { usuario: req.usuario });
    return { agendamento };
  });

  /** PATCH /api/agenda/:id — observacoes, checklist, preco, desconto. */
  app.patch('/api/agenda/:id', { config: apenas.atendente }, async (req) => {
    const dados = atualizarDetalhesSchema.parse(req.body);
    const agendamento = await service.atualizarDetalhes(req.tenantId, req.params.id, dados, {
      usuario: req.usuario
    });
    return { agendamento };
  });

  /**
   * POST /api/agenda/:id/arquivar — tira uma OS encerrada da agenda ativa.
   * `{ desfazer: true }` traz de volta.
   */
  app.post('/api/agenda/:id/arquivar', { config: apenas.atendente }, async (req) => {
    const { desfazer } = arquivarSchema.parse(req.body ?? {});
    const agendamento = await service.arquivar(req.tenantId, req.params.id, { usuario: req.usuario, desfazer });
    return { agendamento };
  });

  /** POST /api/agenda/arquivar — limpa a agenda do que ja passou e encerrou. */
  app.post('/api/agenda/arquivar', { config: apenas.admin }, async (req) => {
    return service.arquivarEncerrados(req.tenantId, req.body ?? {});
  });

  /**
   * DELETE /api/agenda/:id
   *
   * Exige admin: cancelar (que preserva o registro e o motivo) e a acao do
   * dia a dia; excluir de verdade some da agenda e dos relatorios.
   */
  app.delete('/api/agenda/:id', { config: apenas.admin }, async (req) => {
    return service.excluir(req.tenantId, req.params.id, { usuario: req.usuario });
  });
}
