import { apenas } from '../../http/plugins/autenticacao.js';
import * as service from './notificacoes.service.js';

export async function rotasNotificacoes(app) {
  /** GET /api/notificacoes — as MINHAS notificacoes abertas. */
  app.get('/api/notificacoes', { config: apenas.atendente }, async (req) => {
    return { notificacoes: await service.minhas(req.usuario) };
  });

  /** POST /api/notificacoes/:id/atender — assume a conversa e fecha a notificacao de todos. */
  app.post('/api/notificacoes/:id/atender', { config: apenas.atendente }, async (req) => {
    return service.atender(req.usuario, req.params.id);
  });

  /** POST /api/notificacoes/:id/fechar — dispensa. Recusado para cliente frustrado. */
  app.post('/api/notificacoes/:id/fechar', { config: apenas.atendente }, async (req) => {
    return service.fechar(req.usuario, req.params.id);
  });
}
