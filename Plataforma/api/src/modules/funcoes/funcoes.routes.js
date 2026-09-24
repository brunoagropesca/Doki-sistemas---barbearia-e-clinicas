import { z } from 'zod';
import { apenas } from '../../http/plugins/autenticacao.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import { definirFuncao, estadoDasFuncoes, listarFuncoes } from './funcoes.js';

const definirSchema = z.object({ ligada: z.boolean() });

export async function rotasFuncoes(app) {
  /**
   * GET /api/funcoes — `{ chave: ligada }` para a tela esconder menu e botoes.
   * Qualquer pessoa logada: so diz o que existe, sem os textos da pagina DEV.
   */
  app.get('/api/funcoes', { config: apenas.atendente }, async (req) => {
    return { funcoes: await estadoDasFuncoes(req.tenantId) };
  });

  /** GET /api/dev/funcoes — a pagina DEV: grupos, textos e estado. */
  app.get('/api/dev/funcoes', { config: apenas.dev }, async (req) => {
    return listarFuncoes(req.tenantId);
  });

  /** PUT /api/dev/funcoes/:chave — liga ou desliga. */
  app.put('/api/dev/funcoes/:chave', { config: apenas.dev }, async (req) => {
    const { ligada } = definirSchema.parse(req.body);
    const resultado = await definirFuncao(req.tenantId, req.params.chave, ligada);
    await registrarAuditoria({
      tenantId: req.tenantId,
      usuario: req.usuario,
      acao: ligada ? 'funcao.ligar' : 'funcao.desligar',
      entidade: 'funcao',
      entidadeId: req.params.chave
    });
    return resultado;
  });
}
