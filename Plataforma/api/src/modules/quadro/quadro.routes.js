import { z } from 'zod';
import { apenas } from '../../http/plugins/autenticacao.js';
import { dataSchema } from '../agenda/agenda.schemas.js';
import { CHAVES_COLUNAS } from './etapas.js';
import * as service from './quadro.service.js';
import { exigirFuncao } from '../funcoes/funcoes.js';

const quadroSchema = z.object({ data: dataSchema.optional() });

const moverSchema = z.object({
  cartaoId: z.string().min(1, 'Informe o cartao.'),
  coluna: z.enum(CHAVES_COLUNAS)
});

const fecharDiaSchema = z.object({ data: dataSchema.optional() });

/** Quadro de atendimento: o funil do "oi" ate o servico entregue. */
export async function rotasQuadro(app) {
  // Desligado pelo DEV, o quadro responde como inexistente.
  app.addHook('onRequest', exigirFuncao('quadro'));

  /** GET /api/quadro — colunas e cartoes do dia. */
  app.get('/api/quadro', { config: apenas.atendente }, async (req) => {
    const filtros = quadroSchema.parse(req.query);
    return service.quadro(req.tenantId, filtros, req.usuario);
  });

  /** PATCH /api/quadro/mover — arrasta um cartao de coluna. */
  app.patch('/api/quadro/mover', { config: apenas.atendente }, async (req) => {
    const { cartaoId, coluna } = moverSchema.parse(req.body);
    return service.mover(req.tenantId, cartaoId, coluna, { usuario: req.usuario });
  });

  /**
   * POST /api/quadro/fechar-dia — rotina de fim de expediente.
   *
   * Exige admin: ela finaliza sessoes de atendimento e arquiva OS em lote.
   */
  app.post('/api/quadro/fechar-dia', { config: apenas.admin }, async (req) => {
    const dados = fecharDiaSchema.parse(req.body ?? {});
    return service.fecharDia(req.tenantId, dados, req.usuario);
  });
}
