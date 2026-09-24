import { apenas } from '../../http/plugins/autenticacao.js';
import * as service from './perfil.service.js';
import { atualizarPerfilSchema, respostaRapidaSchema } from './perfil.schemas.js';

/**
 * Rotas de "meu perfil". Nenhuma recebe id de usuario: agem sempre sobre quem
 * esta logado. Foto, senha e presenca continuam em /api/auth.
 */
export async function rotasPerfil(app) {
  /** PATCH /api/perfil — nome, e-mail e telefone da propria pessoa. */
  app.patch('/api/perfil', { config: apenas.atendente }, async (req) => {
    const dados = atualizarPerfilSchema.parse(req.body);
    return { usuario: await service.atualizarPerfil(req.usuario, dados) };
  });

  /** GET /api/perfil/respostas-rapidas */
  app.get('/api/perfil/respostas-rapidas', { config: apenas.atendente }, async (req) => {
    return { respostas: await service.listarRespostas(req.tenantId, req.usuario) };
  });

  /** POST /api/perfil/respostas-rapidas */
  app.post('/api/perfil/respostas-rapidas', { config: apenas.atendente }, async (req, res) => {
    const dados = respostaRapidaSchema.parse(req.body);
    res.status(201);
    return { resposta: await service.criarResposta(req.tenantId, req.usuario, dados) };
  });

  /** PUT /api/perfil/respostas-rapidas/:id */
  app.put('/api/perfil/respostas-rapidas/:id', { config: apenas.atendente }, async (req) => {
    const dados = respostaRapidaSchema.parse(req.body);
    return { resposta: await service.atualizarResposta(req.tenantId, req.usuario, req.params.id, dados) };
  });

  /** DELETE /api/perfil/respostas-rapidas/:id */
  app.delete('/api/perfil/respostas-rapidas/:id', { config: apenas.atendente }, async (req) => {
    await service.apagarResposta(req.tenantId, req.usuario, req.params.id);
    return { ok: true };
  });
}
