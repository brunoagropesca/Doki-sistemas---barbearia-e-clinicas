import { z } from 'zod';
import { apenas } from '../../http/plugins/autenticacao.js';
import { enviarMensagem } from '../../channels/gateway.js';
import * as service from './campanhas.service.js';
import { exigirFuncao } from '../funcoes/funcoes.js';

const horaSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM.');

const criarCampanhaSchema = z.object({
  nome: z.string().trim().min(3, 'De um nome para a campanha.').max(100),
  objetivo: z.string().trim().max(2000).optional(),
  channelInstanceId: z.string().min(1, 'Escolha por qual numero a campanha sai.')
});

const iaConfigSchema = z
  .object({
    tom: z.enum(['amigavel', 'profissional', 'descontraido']),
    tamanho: z.enum(['curta', 'media', 'longa']),
    ousadia: z.enum(['contida', 'equilibrada', 'ousada']),
    emojis: z.boolean(),
    usarHistorico: z.boolean(),
    assinatura: z.string().trim().max(80),
    evitar: z.string().trim().max(500)
  })
  .partial();

const atualizarCampanhaSchema = z
  .object({
    nome: z.string().trim().min(3, 'De um nome para a campanha.').max(100),
    objetivo: z.string().trim().max(2000),
    channelInstanceId: z.string().min(1),
    iaConfig: iaConfigSchema,
    simularDigitacao: z.boolean(),
    intervaloMinSegundos: z.number().int().min(10, 'Menos de 10s entre envios e um risco alto de bloqueio.').max(900),
    intervaloMaxSegundos: z.number().int().min(10, 'Menos de 10s entre envios e um risco alto de bloqueio.').max(900),
    limiteDiario: z.number().int().min(1).max(500, 'Mais de 500 por dia e um risco alto de bloqueio.'),
    janelaInicio: horaSchema,
    janelaFim: horaSchema
  })
  .partial();

const publicoSchema = z.object({
  // Teto de 1000 por campanha. Acima disso, o disparo levaria dias com os
  // intervalos anti-bloqueio — e deveria ser dividido em campanhas menores,
  // com publico melhor escolhido.
  leadIds: z.array(z.string()).min(1, 'Selecione pelo menos um contato.').max(1000, 'No maximo 1000 contatos por campanha.')
});

const previaSchema = z.object({
  quantidade: z.number().int().min(1).max(5).default(3),
  objetivo: z.string().trim().max(2000).optional(),
  iaConfig: iaConfigSchema.optional()
});

const aprovarSchema = z
  .object({
    alvoIds: z.array(z.string()).max(1000).optional(),
    todos: z.boolean().default(false),
    aprovar: z.boolean().default(true)
  })
  .refine((d) => d.todos || d.alvoIds?.length, 'Selecione as mensagens ou marque "todas".');

const editarMensagemSchema = z.object({
  mensagem: z.string().trim().min(1, 'A mensagem nao pode ficar vazia.').max(4096)
});

/**
 * Rotas de campanha.
 *
 * Tudo exige admin: disparo em massa mexe com a reputacao do numero da
 * empresa. Um envio mal feito nao e so ineficaz — pode custar o WhatsApp
 * pelo qual a empresa inteira atende.
 */
export async function rotasCampanhas(app) {
  // Desligada pelo DEV, a area inteira responde como inexistente.
  app.addHook('onRequest', exigirFuncao('campanhas'));

  app.get('/api/campanhas', { config: apenas.admin }, async (req) => {
    return { campanhas: await service.listar(req.tenantId) };
  });

  app.get('/api/campanhas/:id', { config: apenas.admin }, async (req) => {
    const campanha = await service.obter(req.tenantId, req.params.id);
    return { campanha, rodando: campanha.rodando };
  });

  /** Etapa 1: cria o rascunho (nome e numero de envio). */
  app.post('/api/campanhas', { config: apenas.admin }, async (req, res) => {
    const dados = criarCampanhaSchema.parse(req.body);
    res.status(201);
    return { campanha: await service.criar(req.tenantId, dados, { usuario: req.usuario }) };
  });

  /** Qualquer etapa: nome, objetivo, jeito da IA, ritmo de envio. */
  app.patch('/api/campanhas/:id', { config: apenas.admin }, async (req) => {
    const dados = atualizarCampanhaSchema.parse(req.body ?? {});
    return { campanha: await service.atualizar(req.tenantId, req.params.id, dados, { usuario: req.usuario }) };
  });

  /**
   * Etapa 2: quem recebe.
   * `pulados` volta junto para a tela explicar quem ficou de fora e por que.
   */
  app.put('/api/campanhas/:id/publico', { config: apenas.admin }, async (req) => {
    const { leadIds } = publicoSchema.parse(req.body);
    return service.definirPublico(req.tenantId, req.params.id, leadIds, { usuario: req.usuario });
  });

  /** Etapa 3: testa o objetivo com alguns clientes, sem gravar nada. */
  app.post('/api/campanhas/:id/previa', { config: apenas.admin }, async (req) => {
    const dados = previaSchema.parse(req.body ?? {});
    return service.previa(req.tenantId, req.params.id, dados);
  });

  /** Etapa 4: a IA escreve (em segundo plano). NAO envia nada. */
  app.post('/api/campanhas/:id/gerar', { config: apenas.admin }, async (req) => {
    const { refazer } = z.object({ refazer: z.boolean().default(false) }).parse(req.body ?? {});
    return { campanha: await service.gerarMensagens(req.tenantId, req.params.id, { refazer }, { usuario: req.usuario }) };
  });

  app.patch('/api/campanhas/alvos/:alvoId', { config: apenas.admin }, async (req) => {
    const { mensagem } = editarMensagemSchema.parse(req.body);
    return service.editarMensagem(req.tenantId, req.params.alvoId, mensagem);
  });

  app.post('/api/campanhas/alvos/:alvoId/regerar', { config: apenas.admin }, async (req) => {
    return service.regerarAlvo(req.tenantId, req.params.alvoId);
  });

  app.delete('/api/campanhas/alvos/:alvoId', { config: apenas.admin }, async (req) => {
    return service.removerAlvo(req.tenantId, req.params.alvoId);
  });

  app.post('/api/campanhas/:id/aprovar', { config: apenas.admin }, async (req) => {
    const dados = aprovarSchema.parse(req.body ?? {});
    return service.aprovar(req.tenantId, req.params.id, dados, { usuario: req.usuario });
  });

  /**
   * Etapa 5: dispara (ou retoma).
   *
   * Injetamos `enviarMensagem` do gateway em vez de o servico importar direto.
   * Isso e o que permite testar a fila inteira com um canal de mentira, sem
   * WhatsApp.
   */
  app.post('/api/campanhas/:id/iniciar', { config: apenas.admin }, async (req) => {
    return service.iniciar(req.tenantId, req.params.id, { enviar: enviarMensagem }, { usuario: req.usuario });
  });

  app.post('/api/campanhas/:id/pausar', { config: apenas.admin }, async (req) => {
    return service.pausar(req.tenantId, req.params.id, { usuario: req.usuario });
  });

  /** "Parar": encerra de vez. O que nao saiu fica registrado como nao enviado. */
  app.post('/api/campanhas/:id/cancelar', { config: apenas.admin }, async (req) => {
    return service.cancelar(req.tenantId, req.params.id, { usuario: req.usuario });
  });

  app.delete('/api/campanhas/:id', { config: apenas.admin }, async (req) => {
    return service.excluir(req.tenantId, req.params.id, { usuario: req.usuario });
  });
}
