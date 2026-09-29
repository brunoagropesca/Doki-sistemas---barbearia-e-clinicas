import { z } from 'zod';
import { apenas } from '../../http/plugins/autenticacao.js';
import { mudarStatusSchema } from '../agenda/agenda.schemas.js';
import * as service from './meu-dia.service.js';

const doDiaSchema = z.object({
  data: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD.')
    .optional()
});

/**
 * A tela do profissional: os atendimentos DELE e o painel de cada um.
 *
 * Unicas rotas de dados abertas ao login `profissional` (ver o plugin de
 * autenticacao). Qualquer outro cargo tambem pode chamar — util para quem e
 * recepcionista E barbeiro —, e o recorte continua sendo o do profissional
 * ligado ao login.
 */
export async function rotasMeuDia(app) {
  /** GET /api/meu-dia?data=AAAA-MM-DD */
  app.get('/api/meu-dia', { config: apenas.profissional }, async (req) => {
    const filtros = doDiaSchema.parse(req.query);
    return service.doDia(req.tenantId, req.usuario, filtros);
  });

  /** GET /api/meu-dia/:id */
  app.get('/api/meu-dia/:id', { config: apenas.profissional }, async (req) => {
    return { agendamento: await service.obter(req.tenantId, req.usuario, req.params.id) };
  });

  /** PATCH /api/meu-dia/:id/status */
  app.patch('/api/meu-dia/:id/status', { config: apenas.profissional }, async (req) => {
    const dados = mudarStatusSchema.parse(req.body);
    return { agendamento: await service.mudarStatus(req.tenantId, req.usuario, req.params.id, dados) };
  });
}
