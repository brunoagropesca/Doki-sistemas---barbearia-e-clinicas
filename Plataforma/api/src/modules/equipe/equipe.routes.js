import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import { apenas } from '../../http/plugins/autenticacao.js';
import { caminhoDe, EXTENSOES_DOCUMENTO } from './arquivos.js';
import * as service from './equipe.service.js';
import { metricasDoProfissional } from '../historico/historico.service.js';
import { exigirFuncao } from '../funcoes/funcoes.js';
import { CRITERIOS_DISTRIBUICAO, PRIVACIDADE, obterConfiguracao, salvarConfiguracao } from './equipe.config.js';

/** Uma imagem enviada pela tela, em data URL. */
const fotoSchema = z.string().startsWith('data:', 'Envie a imagem como data URL.').max(4_500_000);

const servicoDoProfissionalSchema = z.object({
  serviceId: z.string().min(1),
  /** Nulo = usa o preco do servico. Nao confundir com zero (servico de cortesia). */
  precoCentavos: z.number().int().nonnegative().nullable().optional(),
  duracaoMinutos: z.number().int().min(5).max(480).nullable().optional()
});

const faixaSchema = z.object({
  inicio: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  fim: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
});

const jornadaSchema = z.object({
  dias: z.record(z.string().regex(/^[0-6]$/), z.array(faixaSchema).max(4)),
  intervaloMinutos: z.number().int().min(5).max(120).default(30)
});

const criarProfissionalSchema = z.object({
  nome: z.string().trim().min(2, 'Diga o nome do profissional.').max(120),
  funcao: z.string().trim().max(60).optional(),
  cor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'A cor precisa estar no formato #1856FF.')
    .optional(),
  telefone: z.string().trim().max(30).nullish(),
  observacoes: z.string().max(2000).optional(),
  foto: fotoSchema.optional(),
  userId: z.string().nullish(),
  jornada: jornadaSchema.optional(),
  servicos: z.array(servicoDoProfissionalSchema).max(100).optional(),
  ativo: z.boolean().optional()
});

const atualizarProfissionalSchema = criarProfissionalSchema.partial().extend({
  removerFoto: z.boolean().optional()
});

const definirServicosSchema = z.object({
  servicos: z.array(servicoDoProfissionalSchema).max(100)
});

const configuracaoSchema = z
  .object({
    privacidade: z.enum(Object.keys(PRIVACIDADE)).optional(),
    distribuicaoAutomatica: z.boolean().optional(),
    criterioDistribuicao: z.enum(Object.keys(CRITERIOS_DISTRIBUICAO)).optional(),
    distribuirSomenteOnline: z.boolean().optional(),
    distribuirParaGerencia: z.boolean().optional(),
    assinaturaAtendente: z.boolean().optional(),
    assinaturaSofia: z.boolean().optional(),
    agendaCompletaParaEquipe: z.boolean().optional()
  })
  .refine((d) => Object.keys(d).length > 0, 'Envie pelo menos um campo.');

const listarSchema = z.object({
  incluirInativos: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
});

const metricasSchema = z.object({
  dias: z.coerce.number().int().min(0).max(3650).default(30)
});

/** Tipo de conteudo pela extensao — a pasta so aceita imagem. */
const TIPO_POR_EXTENSAO = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // Audio recebido pelos canais (recado de WhatsApp e afins).
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  // Videos mandados pelo atendente no livechat.
  '.mp4': 'video/mp4',
  '.3gp': 'video/3gpp',
  '.mov': 'video/quicktime',
  // Documentos: sempre servidos como download (ver `DOCUMENTOS` abaixo).
  ...Object.fromEntries(Object.entries(EXTENSOES_DOCUMENTO).map(([ext, tipo]) => [`.${ext}`, tipo]))
};

/**
 * Documento nunca e aberto pelo navegador no nosso dominio: vai como download.
 * Um PDF ou planilha aberto aqui dentro rodaria com a sessao de quem clicou.
 */
const DOCUMENTOS = new Set(Object.keys(EXTENSOES_DOCUMENTO).map((ext) => `.${ext}`));

/**
 * Le o cabecalho `Range` de um pedido de audio.
 *
 * O player precisa disto para ARRASTAR a barra: sem resposta 206, o navegador
 * so consegue tocar do comeco, e em alguns formatos nem descobre a duracao do
 * audio (a barra fica travada). So tratamos a forma simples `bytes=inicio-fim`,
 * que e a unica que os navegadores usam para tocar midia.
 *
 * @returns {{inicio: number, fim: number}|null}  null = manda o arquivo inteiro
 */
function faixaPedida(cabecalho, tamanho) {
  const casou = /^bytes=(\d*)-(\d*)$/.exec(String(cabecalho ?? '').trim());
  if (!casou) return null;

  const [, cru1, cru2] = casou;

  // "bytes=-500" = os ultimos 500 bytes.
  const inicio = cru1 === '' ? Math.max(0, tamanho - Number(cru2 || 0)) : Number(cru1);
  const fim = cru1 === '' || cru2 === '' ? tamanho - 1 : Math.min(Number(cru2), tamanho - 1);

  if (!Number.isFinite(inicio) || !Number.isFinite(fim) || inicio > fim || inicio >= tamanho) return null;
  return { inicio, fim };
}

export async function rotasEquipe(app) {
  // --- Profissionais (quem executa o servico) ---

  app.get('/api/profissionais', { config: apenas.atendente }, async (req) => {
    const filtros = listarSchema.parse(req.query);
    return { profissionais: await service.listarProfissionais(req.tenantId, filtros) };
  });

  app.get('/api/profissionais/:id', { config: apenas.atendente }, async (req) => {
    return { profissional: await service.obterProfissional(req.tenantId, req.params.id) };
  });

  /**
   * GET /api/profissionais/:id/metricas?dias=30 — o resumo da ficha.
   * Admin: tem faturamento. `dias=0` = desde sempre.
   */
  app.get(
    '/api/profissionais/:id/metricas',
    { config: apenas.admin, onRequest: exigirFuncao('metricas_profissional') },
    async (req) => {
      const { dias } = metricasSchema.parse(req.query);
      await service.obterProfissional(req.tenantId, req.params.id); // 404 se nao for desta empresa
      return { metricas: await metricasDoProfissional(req.tenantId, req.params.id, { dias }) };
    }
  );

  app.post('/api/profissionais', { config: apenas.admin }, async (req, res) => {
    const dados = criarProfissionalSchema.parse(req.body);
    const profissional = await service.criarProfissional(req.tenantId, dados, { usuario: req.usuario });
    res.status(201);
    return { profissional };
  });

  app.patch('/api/profissionais/:id', { config: apenas.admin }, async (req) => {
    const dados = atualizarProfissionalSchema.parse(req.body);
    const profissional = await service.atualizarProfissional(req.tenantId, req.params.id, dados, {
      usuario: req.usuario
    });
    return { profissional };
  });

  /**
   * PUT /api/profissionais/:id/servicos
   *
   * A ficha do profissional: o que ele faz, por quanto e em quanto tempo.
   * Substitui a lista inteira — e assim que a tela trabalha.
   */
  app.put('/api/profissionais/:id/servicos', { config: apenas.admin }, async (req) => {
    const { servicos } = definirServicosSchema.parse(req.body);
    return { servicos: await service.definirServicos(req.tenantId, req.params.id, servicos) };
  });

  app.delete('/api/profissionais/:id', { config: apenas.admin }, async (req) => {
    return service.excluirProfissional(req.tenantId, req.params.id, { usuario: req.usuario });
  });

  // --- Atendentes (quem usa o sistema) ---

  app.get('/api/atendentes', { config: apenas.admin }, async (req) => {
    return { atendentes: await service.listarAtendentes(req.tenantId) };
  });

  /**
   * Configuracao do atendimento em equipe: privacidade e distribuicao.
   *
   * Ler exige admin (e uma tela de configuracao); GRAVAR exige o dono. Quem
   * decide se os gerentes passam a enxergar o atendimento de todo mundo nao
   * pode ser um gerente — senao a regra nao protege ninguem.
   */
  app.get('/api/equipe/configuracao', { config: apenas.admin }, async (req) => {
    return { configuracao: await obterConfiguracao(req.tenantId) };
  });

  app.put('/api/equipe/configuracao', { config: apenas.owner }, async (req) => {
    const dados = configuracaoSchema.parse(req.body);
    return { configuracao: await salvarConfiguracao(req.tenantId, dados) };
  });

  /**
   * GET /api/arquivos/:nome — serve as fotos enviadas e os audios recebidos.
   *
   * Aberta de proposito: sao fotos de catalogo e recados de audio, exibidos em
   * `<img>` e `<audio>`, e essas tags nao mandam cabecalho de autenticacao. O
   * nome e um UUID sorteado na gravacao, entao nao da para adivinhar o arquivo
   * de outra empresa, e `caminhoDe` recusa qualquer nome que tente sair da pasta.
   */
  app.get('/api/arquivos/:nome', { config: apenas.publico }, async (req, res) => {
    const destino = caminhoDe(req.params.nome);
    const tipo = TIPO_POR_EXTENSAO[extname(req.params.nome ?? '').toLowerCase()];

    if (!destino || !tipo) {
      res.status(404);
      return { erro: { codigo: 'NAO_ENCONTRADO', mensagem: 'Arquivo nao encontrado.' } };
    }

    let informacao;
    try {
      informacao = await stat(destino);
    } catch {
      res.status(404);
      return { erro: { codigo: 'NAO_ENCONTRADO', mensagem: 'Arquivo nao encontrado.' } };
    }

    // O nome tem UUID: o conteudo nunca muda, entao pode ficar no cache.
    res.header('cache-control', 'public, max-age=31536000, immutable');
    res.type(tipo);
    // Sem isto o navegador pode "adivinhar" que um .txt e HTML e executa-lo.
    res.header('x-content-type-options', 'nosniff');
    if (DOCUMENTOS.has(extname(req.params.nome).toLowerCase())) res.header('content-disposition', 'attachment');

    // Avisa que aceitamos pedidos por faixa — e assim que o player descobre
    // que pode arrastar a barra em vez de so tocar do comeco.
    res.header('accept-ranges', 'bytes');

    const faixa = faixaPedida(req.headers.range, informacao.size);
    if (!faixa) {
      res.header('content-length', String(informacao.size));
      return createReadStream(destino);
    }

    res.status(206);
    res.header('content-range', `bytes ${faixa.inicio}-${faixa.fim}/${informacao.size}`);
    res.header('content-length', String(faixa.fim - faixa.inicio + 1));
    return createReadStream(destino, { start: faixa.inicio, end: faixa.fim });
  });
}
