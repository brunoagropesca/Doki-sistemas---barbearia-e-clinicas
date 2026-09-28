import { z } from 'zod';
import { apenas } from '../../http/plugins/autenticacao.js';
import { exigirFuncao } from '../funcoes/funcoes.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import { configPublica, salvarConfig } from './hades.config.js';
import * as service from './hades.service.js';

/**
 * Hades — assistente administrativo do dono. So o dono e o DEV (faturamento,
 * equipe e rumo do negocio nao sao assunto do balcao). O DEV desliga em
 * "Funcoes do sistema" (agente_hades): desligado, tudo aqui responde 404.
 */

const configSchema = z.object({
  ativo: z.boolean().optional(),
  nome: z.string().trim().min(1).max(40).optional(),
  modelo: z.string().trim().max(120).nullish(),
  temperatura: z.number().min(0).max(1.5).optional(),
  pesquisaWeb: z.boolean().optional(),
  systemPrompt: z.string().trim().min(1, 'Escreva quem o Hades é.').max(6000).optional(),
  // texto = troca a chave; null = remove.
  apiKey: z.string().trim().min(10, 'Chave curta demais.').max(300).nullish()
});

const conversaSchema = z.object({
  mensagens: z
    .array(z.object({ papel: z.enum(['user', 'assistant']), conteudo: z.string().trim().min(1).max(8000) }))
    .min(1)
    .max(40)
    .refine((m) => m.at(-1).papel === 'user', 'A última mensagem precisa ser a pergunta.')
});

export async function rotasHades(app) {
  app.addHook('onRequest', exigirFuncao('agente_hades'));

  app.get('/api/hades/config', { config: apenas.owner }, async (req) => ({ config: await configPublica(req.tenantId) }));

  app.put('/api/hades/config', { config: apenas.owner }, async (req) => {
    const dados = configSchema.parse(req.body ?? {});
    const config = await salvarConfig(req.tenantId, { ...dados, modelo: dados.modelo === undefined ? undefined : dados.modelo || null });
    await registrarAuditoria({
      tenantId: req.tenantId,
      usuario: req.usuario,
      acao: 'hades.config',
      entidade: 'hades',
      entidadeId: req.tenantId,
      // Nunca a chave: so QUE ela mudou.
      dados: { campos: Object.keys(dados).map((k) => (k === 'apiKey' ? (dados.apiKey ? 'chave trocada' : 'chave removida') : k)) }
    });
    return { config };
  });

  app.post('/api/hades/testar', { config: apenas.owner }, async (req) => service.testar(req.tenantId));
  app.get('/api/hades/modelos', { config: apenas.owner }, async (req) => service.modelos(req.tenantId));

  app.post('/api/hades/conversar', { config: apenas.owner }, async (req) => {
    const { mensagens } = conversaSchema.parse(req.body ?? {});
    return service.conversar(req.tenantId, mensagens);
  });
}
