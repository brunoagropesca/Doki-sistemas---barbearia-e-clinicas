import { z } from 'zod';
import { apenas } from '../../http/plugins/autenticacao.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import {
  listarTextos,
  restaurarInterface,
  trocarMensagem,
  trocarTextoDaInterface,
  trocasDaInterface,
  trocasPublicas
} from './textos.js';

const trocaSchema = z.object({
  original: z.string().min(1, 'Informe o texto original.').max(1000),
  novo: z.string().max(1000)
});
const mensagemSchema = z.object({ texto: z.string().max(1000) });

export async function rotasTextos(app) {
  /**
   * GET /api/textos — as trocas de interface para a tela aplicar.
   * Publica porque a tela de login tambem tem textos; sem login, devolve as
   * da empresa unica (ver `trocasPublicas`). Sao textos de tela, nada sigiloso.
   */
  app.get('/api/textos', { config: apenas.publico }, async (req) => {
    return { textos: req.tenantId ? await trocasDaInterface(req.tenantId) : await trocasPublicas() };
  });

  /** GET /api/dev/textos — a pagina DEV: trocas de interface e mensagens ao cliente. */
  app.get('/api/dev/textos', { config: apenas.dev }, async (req) => listarTextos(req.tenantId));

  /** PUT /api/dev/textos/interface — troca um texto da tela (novo vazio = volta ao original). */
  app.put('/api/dev/textos/interface', { config: apenas.dev }, async (req) => {
    const dados = trocaSchema.parse(req.body);
    const r = await trocarTextoDaInterface(req.tenantId, dados);
    await registrarAuditoria({
      tenantId: req.tenantId,
      usuario: req.usuario,
      acao: 'texto.trocar',
      entidade: 'texto',
      dados: { antes: dados.original, depois: dados.novo }
    });
    return r;
  });

  /** DELETE /api/dev/textos/interface — volta TODOS os textos da tela ao original. */
  app.delete('/api/dev/textos/interface', { config: apenas.dev }, async (req) => {
    const r = await restaurarInterface(req.tenantId);
    await registrarAuditoria({ tenantId: req.tenantId, usuario: req.usuario, acao: 'texto.restaurar_tudo', entidade: 'texto' });
    return r;
  });

  /** PUT /api/dev/textos/mensagens/:chave — mensagem automatica ao cliente (vazio = padrao). */
  app.put('/api/dev/textos/mensagens/:chave', { config: apenas.dev }, async (req) => {
    const { texto } = mensagemSchema.parse(req.body);
    const r = await trocarMensagem(req.tenantId, req.params.chave, texto);
    await registrarAuditoria({
      tenantId: req.tenantId,
      usuario: req.usuario,
      acao: 'texto.mensagem',
      entidade: 'texto',
      entidadeId: req.params.chave
    });
    return r;
  });
}
