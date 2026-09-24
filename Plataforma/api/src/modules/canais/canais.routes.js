import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { db, emTransacao } from '../../db/client.js';
import { channelInstances } from '../../db/schema/conversations.js';
import { NIVEL_CARGO } from '../../db/schema/auth.js';
import { ID } from '../../core/ids.js';
import { Conflito, NaoEncontrado, RegraDeNegocio } from '../../core/errors.js';
import { apenas } from '../../http/plugins/autenticacao.js';
import { obterAdaptador, recarregarAgrupador } from '../../channels/gateway.js';
import { listarEventos, registrarEvento, ultimoIdDeEvento } from '../../channels/eventos.js';
import { configEfetiva } from '../../channels/whatsapp/handlers.js';
import * as atendimento from '../atendimento/atendimento.service.js';
import { LIMITES, TIPOS_NO } from '../atendimento/fluxo.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';

/**
 * Conexoes com canais (hoje: WhatsApp via Baileys, ate 5 contas).
 *
 * QUEM FAZ O QUE — a divisao e proposital:
 *
 *   DEV (perfil invisivel)   adiciona e remove contas, renomeia, ativa e desativa.
 *   dono / gerente           liga, desliga e sai da conta que ja existe (le o QR
 *                            Code) e ajusta as preferencias dela.
 *   atendente                so ve a lista.
 *
 * Quem cadastra as contas e quem configura a plataforma, nao o cliente: cada
 * conta tem custo e risco (numero banido, limite do plano), e o dono nao
 * deveria conseguir sem querer estourar o contrato ou apagar a linha que
 * atende a clinica. As rotas do DEV respondem 404 para os demais — veja
 * `apenas.dev`.
 */

const MAX_INSTANCIAS = 5;

const criarInstanciaSchema = z.object({
  // So WhatsApp por enquanto: Telegram e Instagram ainda nao tem adaptador, e
  // uma conexao que nunca conecta seria so um cartao morto na tela.
  canal: z.enum(['whatsapp']).default('whatsapp'),
  nome: z.string().trim().min(2, 'Dê um nome para esta conexão.').max(60),
  iaHabilitada: z.boolean().default(true)
});

/** Campos que so o DEV altera. */
const atualizarInstanciaSchema = z
  .object({
    nome: z.string().trim().min(2).max(60).optional(),
    ativo: z.boolean().optional()
  })
  .refine((d) => Object.keys(d).length > 0, 'Envie pelo menos um campo.');

/** Preferencias que o dono e o gerente podem mexer. */
const configuracaoInstanciaSchema = z
  .object({
    iaHabilitada: z.boolean().optional(),
    rejeitarChamadas: z.boolean().optional(),
    marcarComoLida: z.boolean().optional(),
    sincronizarContatos: z.boolean().optional(),
    mensagemChamada: z.string().trim().min(3, 'Escreva uma mensagem com pelo menos 3 caracteres.').max(500).optional()
  })
  .refine((d) => Object.keys(d).length > 0, 'Envie pelo menos um campo.');

const eventosQuerySchema = z.object({
  depoisDe: z.coerce.number().int().min(0).default(0),
  limite: z.coerce.number().int().min(1).max(300).default(100),
  chave: z.string().max(40).optional()
});

const configAtendimentoSchema = z
  .object({
    modo: z.enum(atendimento.MODOS).optional(),
    agrupamentoSegundos: z.number().int().min(0).max(120).optional(),
    janelaContextoMensagens: z.number().int().min(2).max(40).optional(),
    fechamentoHora: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM.')
      .optional()
  })
  .refine((d) => Object.keys(d).length > 0, 'Envie pelo menos um campo.');

/**
 * A FORMA do fluxo (tipos e tamanhos). As regras do grafo — inicio, opcoes
 * sem destino, profundidade, ligacoes — sao conferidas depois por
 * `validarFluxo`, o mesmo codigo que o editor usa enquanto a pessoa desenha.
 */
const idSchema = z.string().trim().min(1).max(60);

const fluxoSchema = z.object({
  versao: z.literal(2),
  inicio: idSchema,
  nodes: z
    .array(
      z.object({
        id: idSchema,
        type: z.enum(Object.keys(TIPOS_NO)),
        position: z.object({ x: z.number().finite(), y: z.number().finite() }),
        data: z.object({
          title: z.string().max(LIMITES.titulo).default(''),
          message: z.string().max(LIMITES.mensagem).default(''),
          options: z
            .array(z.object({ id: idSchema, label: z.string().max(LIMITES.rotulo) }))
            .max(LIMITES.opcoes)
            .optional(),
          disabled: z.boolean().optional()
        })
      })
    )
    .min(1)
    .max(LIMITES.nos),
  connections: z.record(
    idSchema,
    z.object({
      main: z
        .array(z.array(z.object({ node: idSchema, type: z.literal('main'), index: z.literal(0) })).max(1))
        .max(LIMITES.opcoes)
    })
  ),
  config: z
    .object({
      mensagemErro: z.string().max(500).optional(),
      expiraMinutos: z.number().int().min(5).max(24 * 60).optional()
    })
    .optional()
});

const salvarMenuSchema = z.object({
  nome: z.string().trim().max(60).optional(),
  fluxo: fluxoSchema
});

const podeVerQr = (usuario) => (NIVEL_CARGO[usuario?.cargo] ?? 0) >= NIVEL_CARGO.admin;

/**
 * Como a instancia sai na API.
 *
 * O QR Code so vai para quem pode conecta-la (gerente para cima): quem le o
 * QR Code assume o numero, entao um atendente nao pode ve-lo.
 */
function apresentarInstancia(i, { verQr = false } = {}) {
  return {
    id: i.id,
    canal: i.canal,
    chave: i.chave,
    nome: i.nome,
    status: i.status,
    identificador: i.identificador,
    nomePerfil: i.nomePerfil,
    iaHabilitada: i.iaHabilitada,
    config: configEfetiva(i.config),
    qrCode: verQr && i.status === 'aguardando_qr' ? i.qrCode : null,
    qrExpiraEm: verQr && i.status === 'aguardando_qr' ? (i.qrExpiraEm?.getTime() ?? null) : null,
    ultimoErro: i.ultimoErro,
    conectadoEm: i.conectadoEm?.getTime() ?? null,
    ativo: i.ativo
  };
}

/** A instancia da empresa com esta chave — removidas nao contam. */
async function buscarInstancia(tenantId, chave) {
  const instancia = await db.query.channelInstances.findFirst({
    where: and(
      eq(channelInstances.tenantId, tenantId),
      eq(channelInstances.chave, chave),
      isNull(channelInstances.deletedAt)
    )
  });
  if (!instancia) throw new NaoEncontrado('Conexao');
  return instancia;
}

/**
 * Nome de quem fez a acao, para o console. O DEV e invisivel: aparecer o nome
 * dele numa lista que o dono le entregaria que ha alguem alem da equipe.
 */
const autorDe = (usuario) => (usuario.cargo === 'dev' ? 'A equipe técnica' : usuario.nome);

const aviso = (tenantId, chave, mensagem) =>
  registrarEvento(tenantId, { chave, nivel: 'info', tipo: 'admin', mensagem });

export async function rotasCanais(app) {
  // --- Instancias de canal ---

  app.get('/api/canais', { config: apenas.atendente }, async (req) => {
    const linhas = await db
      .select()
      .from(channelInstances)
      .where(and(eq(channelInstances.tenantId, req.tenantId), isNull(channelInstances.deletedAt)));

    const verQr = podeVerQr(req.usuario);
    return {
      canais: linhas.sort((a, b) => a.chave.localeCompare(b.chave)).map((i) => apresentarInstancia(i, { verQr })),
      limite: MAX_INSTANCIAS
    };
  });

  /**
   * GET /api/canais/eventos — o console de conexoes.
   *
   * A tela manda o `id` do ultimo evento que viu em `depoisDe` e recebe so o
   * que veio depois. Declarada antes das rotas com `:chave` de proposito.
   */
  app.get('/api/canais/eventos', { config: apenas.admin }, async (req) => {
    const filtros = eventosQuerySchema.parse(req.query);
    return {
      eventos: listarEventos(req.tenantId, filtros),
      ultimoId: ultimoIdDeEvento(req.tenantId)
    };
  });

  // --- So o DEV: criar e remover contas ---

  app.post('/api/canais', { config: apenas.dev }, async (req, res) => {
    const dados = criarInstanciaSchema.parse(req.body);

    // A contagem e a insercao acontecem dentro da fila de escrita: duas
    // requisicoes simultaneas nao conseguem, juntas, passar do limite nem
    // escolher a mesma chave.
    const { id, chave } = await emTransacao(async (tx) => {
      const existentes = await tx
        .select()
        .from(channelInstances)
        .where(and(eq(channelInstances.tenantId, req.tenantId), isNull(channelInstances.deletedAt)));

      if (existentes.length >= MAX_INSTANCIAS) {
        throw new Conflito(`Limite de ${MAX_INSTANCIAS} conexões por empresa atingido.`);
      }

      // Gera a proxima chave livre (W1, W2...), reaproveitando buracos deixados
      // por conexoes removidas.
      const usadas = new Set(existentes.map((e) => e.chave));
      const livre = Array.from({ length: MAX_INSTANCIAS }, (_, i) => `W${i + 1}`).find((c) => !usadas.has(c));

      const novoId = ID.canal();
      await tx.insert(channelInstances).values({
        id: novoId,
        tenantId: req.tenantId,
        canal: dados.canal,
        chave: livre,
        nome: dados.nome,
        iaHabilitada: dados.iaHabilitada,
        status: 'desconectado'
      });
      return { id: novoId, chave: livre };
    });

    await registrarAuditoria({
      tenantId: req.tenantId,
      usuario: req.usuario,
      acao: 'canal.criar',
      entidade: 'canal',
      entidadeId: id,
      dados: { depois: { nome: dados.nome, chave } }
    });
    aviso(req.tenantId, chave, `Conexão "${dados.nome}" (${chave}) adicionada.`);

    const criado = await db.query.channelInstances.findFirst({ where: eq(channelInstances.id, id) });
    res.status(201);
    return { canal: apresentarInstancia(criado, { verQr: true }) };
  });

  /** PATCH /api/canais/:chave — renomear, ativar e desativar. So o DEV. */
  app.patch('/api/canais/:chave', { config: apenas.dev }, async (req) => {
    const dados = atualizarInstanciaSchema.parse(req.body);
    const instancia = await buscarInstancia(req.tenantId, req.params.chave);

    // Desativar tira a conta do ar (sem apagar a sessao: ativar de novo volta
    // com um clique, sem precisar do QR Code).
    if (dados.ativo === false && instancia.ativo) {
      await obterAdaptador(instancia.canal)?.desconectar?.(req.tenantId, instancia.chave, { sair: false });
    }

    await db.update(channelInstances).set(dados).where(eq(channelInstances.id, instancia.id));

    await registrarAuditoria({
      tenantId: req.tenantId,
      usuario: req.usuario,
      acao: 'canal.atualizar',
      entidade: 'canal',
      entidadeId: instancia.id,
      dados: { antes: { nome: instancia.nome, ativo: instancia.ativo }, depois: dados }
    });
    if (dados.ativo !== undefined && dados.ativo !== instancia.ativo) {
      aviso(req.tenantId, instancia.chave, dados.ativo ? 'Conexão ativada.' : 'Conexão desativada.');
    }

    const atualizado = await buscarInstancia(req.tenantId, instancia.chave);
    return { canal: apresentarInstancia(atualizado, { verQr: true }) };
  });

  app.delete('/api/canais/:chave', { config: apenas.dev }, async (req) => {
    const instancia = await buscarInstancia(req.tenantId, req.params.chave);

    // Sai da sessao antes de remover: senao o celular continua mostrando um
    // aparelho conectado que nao existe mais.
    await Promise.resolve(obterAdaptador(instancia.canal)?.desconectar?.(req.tenantId, instancia.chave, { sair: true })).catch(
      () => {}
    );

    /**
     * A chave e trocada ao remover. O indice unico (empresa + chave) tambem
     * vale para linhas apagadas logicamente; sem isto, remover "W2" e criar
     * outra conexao (que receberia "W2" de volta) falharia por duplicidade.
     * A conversa continua apontando para a conexao pelo `id`, entao o
     * historico segue mostrando de qual numero veio.
     */
    await db
      .update(channelInstances)
      .set({
        deletedAt: new Date(),
        ativo: false,
        status: 'desconectado',
        qrCode: null,
        chave: `${instancia.chave}~removida~${instancia.id.slice(-8)}`
      })
      .where(eq(channelInstances.id, instancia.id));

    await registrarAuditoria({
      tenantId: req.tenantId,
      usuario: req.usuario,
      acao: 'canal.remover',
      entidade: 'canal',
      entidadeId: instancia.id,
      dados: { antes: { nome: instancia.nome, chave: instancia.chave } }
    });
    aviso(req.tenantId, instancia.chave, `Conexão "${instancia.nome}" removida.`);

    return { ok: true };
  });

  // --- Dono e gerente: operar a conta que ja existe ---

  /** PATCH /api/canais/:chave/config — preferencias da conta. */
  app.patch('/api/canais/:chave/config', { config: apenas.admin }, async (req) => {
    const { iaHabilitada, ...preferencias } = configuracaoInstanciaSchema.parse(req.body);
    const instancia = await buscarInstancia(req.tenantId, req.params.chave);

    const config = { ...(instancia.config ?? {}), ...preferencias };
    const mudancas = { config };
    if (iaHabilitada !== undefined) mudancas.iaHabilitada = iaHabilitada;

    await db.update(channelInstances).set(mudancas).where(eq(channelInstances.id, instancia.id));

    await registrarAuditoria({
      tenantId: req.tenantId,
      usuario: req.usuario,
      acao: 'canal.configurar',
      entidade: 'canal',
      entidadeId: instancia.id,
      dados: { depois: { iaHabilitada, ...preferencias } }
    });
    aviso(req.tenantId, instancia.chave, `${autorDe(req.usuario)} alterou as preferências da conexão.`);

    const atualizado = await buscarInstancia(req.tenantId, instancia.chave);
    return { canal: apresentarInstancia(atualizado, { verQr: true }) };
  });

  /**
   * POST /api/canais/:chave/conectar
   *
   * Retorna imediatamente: o QR Code chega por evento e e gravado no banco.
   * A tela consulta o status ate o QR aparecer. Esperar aqui deixaria a
   * requisicao pendurada por varios segundos.
   */
  app.post('/api/canais/:chave/conectar', { config: apenas.admin }, async (req) => {
    const instancia = await buscarInstancia(req.tenantId, req.params.chave);

    if (!instancia.ativo) {
      throw new RegraDeNegocio('Esta conexão está desativada. Peça à equipe técnica para ativá-la.');
    }

    const adaptador = obterAdaptador(instancia.canal);
    if (!adaptador?.conectar) {
      throw new RegraDeNegocio(`O canal "${instancia.canal}" ainda não tem conexão implementada.`);
    }

    // O adaptador marca o status ('conectando') quando realmente inicia; se ja
    // estava conectado ele nao mexe em nada. Marcar aqui, antes, deixaria uma
    // conta ja conectada eternamente "conectando" (nao viria evento novo).
    const r = await adaptador.conectar(req.tenantId, instancia.chave);

    await registrarAuditoria({
      tenantId: req.tenantId,
      usuario: req.usuario,
      acao: 'canal.conectar',
      entidade: 'canal',
      entidadeId: instancia.id
    });
    aviso(req.tenantId, instancia.chave, `${autorDe(req.usuario)} pediu para conectar.`);

    if (r?.jaAtiva) {
      const atual = await buscarInstancia(req.tenantId, instancia.chave);
      return { status: atual.status, mensagem: 'Esta conexão já está ativa.' };
    }
    return { status: 'conectando', mensagem: 'Aguarde o QR Code aparecer.' };
  });

  /** GET /api/canais/:chave/status — a tela consulta ate o QR chegar. */
  app.get('/api/canais/:chave/status', { config: apenas.admin }, async (req) => {
    const instancia = await buscarInstancia(req.tenantId, req.params.chave);
    return { canal: apresentarInstancia(instancia, { verQr: true }) };
  });

  /**
   * POST /api/canais/:chave/desconectar
   *
   * `{ sair: false }` desliga e guarda a sessao (voltar e um clique);
   * `{ sair: true }` faz logout no WhatsApp e apaga a sessao (exige novo QR Code).
   */
  app.post('/api/canais/:chave/desconectar', { config: apenas.admin }, async (req) => {
    const instancia = await buscarInstancia(req.tenantId, req.params.chave);

    const sair = req.body?.sair === true;
    const adaptador = obterAdaptador(instancia.canal);

    if (adaptador?.desconectar) {
      await adaptador.desconectar(req.tenantId, instancia.chave, { sair });
    } else {
      await db.update(channelInstances).set({ status: 'desconectado' }).where(eq(channelInstances.id, instancia.id));
    }

    await registrarAuditoria({
      tenantId: req.tenantId,
      usuario: req.usuario,
      acao: sair ? 'canal.sair' : 'canal.desconectar',
      entidade: 'canal',
      entidadeId: instancia.id
    });
    aviso(req.tenantId, instancia.chave, `${autorDe(req.usuario)} ${sair ? 'saiu da conta' : 'desconectou'}.`);

    return { ok: true };
  });

  // --- Configuracao do atendimento automatico ---

  app.get('/api/atendimento/configuracao', { config: apenas.atendente }, async (req) => {
    return atendimento.obterConfiguracao(req.tenantId);
  });

  app.put('/api/atendimento/configuracao', { config: apenas.admin }, async (req) => {
    const dados = configAtendimentoSchema.parse(req.body);
    const cfg = await atendimento.salvarConfiguracao(req.tenantId, dados);

    // A janela de agrupamento esta em memoria; sem recarregar, a mudanca so
    // valeria no proximo reinicio do servidor.
    recarregarAgrupador(req.tenantId);

    return cfg;
  });

  app.put('/api/atendimento/menu', { config: apenas.admin }, async (req) => {
    const dados = salvarMenuSchema.parse(req.body);
    return atendimento.salvarMenu(req.tenantId, dados);
  });
}
