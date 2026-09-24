import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { carimbos, colunaTenant, exclusaoLogica, instante, jsonTexto } from './_shared.js';
import { users } from './auth.js';
import { leads } from './crm.js';
import { channelInstances } from './conversations.js';

/**
 * Campanha = disparo em massa personalizado.
 *
 * O modulo inteiro do sistema antigo estava quebrado em tres lugares ao mesmo
 * tempo: chamava uma funcao com os argumentos trocados, escrevia numa coluna
 * que nunca existiu e — o mais grave — marcava a mensagem como "enviada" sem
 * nunca ter mandado nada pro WhatsApp. O painel mostrava sucesso e o cliente
 * nao recebia coisa alguma.
 *
 * O schema aqui e desenhado pra impedir a repeticao disso:
 *  - `channelInstanceId` e OBRIGATORIO: nao existe campanha sem dizer por qual
 *    numero ela sai. Era o dado que faltava pra conseguir enviar de fato.
 *  - `enviadoEm` so recebe valor no alvo depois de confirmacao do canal.
 *  - `status` do alvo separa 'enviada' de 'entregue'.
 */
export const campaigns = sqliteTable(
  'campaigns',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    nome: text('nome').notNull(),

    /** O que a campanha quer: "resgatar quem sumiu ha mais de 60 dias". */
    objetivo: text('objetivo').notNull().default(''),

    modo: text('modo', { enum: ['ia_personalizada', 'template'] })
      .notNull()
      .default('ia_personalizada'),
    /** Usado quando o modo e 'template'. Aceita {{nome}}, {{ultimo_servico}}. */
    template: text('template').notNull().default(''),

    /**
     * O ciclo de vida segue as etapas do assistente:
     *
     *   rascunho  -> montando publico e configurando a IA
     *   gerando   -> a IA esta escrevendo as mensagens (em segundo plano)
     *   revisao   -> mensagens prontas esperando aprovacao humana
     *   pronta    -> tudo aprovado, esperando o "iniciar"
     *   enviando  -> disparo em andamento (pode estar esperando a janela abrir)
     *   pausada   -> parou por pedido de alguem; retoma de onde estava
     *   concluida / cancelada -> fim
     */
    status: text('status', {
      enum: ['rascunho', 'gerando', 'revisao', 'pronta', 'enviando', 'pausada', 'concluida', 'cancelada']
    })
      .notNull()
      .default('rascunho'),

    /**
     * Como a IA deve escrever: tom, tamanho, emojis, se usa o historico do
     * cliente, como assina e o que evitar. O objetivo (o "prompt" do dono)
     * fica na coluna `objetivo`; aqui ficam os ajustes finos.
     */
    iaConfig: jsonTexto('ia_config', {}),

    /**
     * Mostra "digitando..." ao cliente antes de cada mensagem, pelo tempo que
     * uma pessoa levaria para escrever aquele texto. Mensagem que chega do
     * nada, sem ninguem ter digitado, e assinatura de robo.
     */
    simularDigitacao: integer('simular_digitacao', { mode: 'boolean' }).notNull().default(true),

    /**
     * Por que um disparo em andamento esta parado agora, e quando volta.
     *
     * Fora da janela de horario ou com o limite do dia batido, a campanha NAO
     * vira 'pausada' (isso exigiria alguem clicar para retomar): ela continua
     * 'enviando' e espera sozinha. Estes campos contam isso para a tela.
     */
    esperaMotivo: text('espera_motivo'),
    retomaEm: instante('retoma_em'),
    proximoEnvioEm: instante('proximo_envio_em'),

    /**
     * Por qual numero a campanha sai. Obrigatorio — sem isto nao ha como enviar.
     */
    channelInstanceId: text('channel_instance_id')
      .notNull()
      .references(() => channelInstances.id, { onDelete: 'restrict' }),

    /**
     * Intervalo aleatorio entre um envio e o proximo.
     *
     * Mandar 300 mensagens identicas em sequencia e a forma mais rapida de
     * ter o numero bloqueado pelo WhatsApp. O intervalo variavel imita o ritmo
     * de uma pessoa digitando.
     */
    intervaloMinSegundos: integer('intervalo_min_segundos').notNull().default(25),
    intervaloMaxSegundos: integer('intervalo_max_segundos').notNull().default(70),

    /** Teto de envios por dia, outra protecao contra bloqueio. */
    limiteDiario: integer('limite_diario').notNull().default(150),

    /**
     * Janela permitida para disparo, no fuso da empresa.
     * Mandar promocao as 3 da manha irrita cliente e chama atencao do WhatsApp.
     */
    janelaInicio: text('janela_inicio').notNull().default('09:00'),
    janelaFim: text('janela_fim').notNull().default('20:00'),

    /** Contadores, mantidos junto com a mudanca de status de cada alvo. */
    totalAlvos: integer('total_alvos').notNull().default(0),
    totalEnviadas: integer('total_enviadas').notNull().default(0),
    totalFalhas: integer('total_falhas').notNull().default(0),
    totalRespostas: integer('total_respostas').notNull().default(0),

    criadoPorUserId: text('criado_por_user_id').references(() => users.id, { onDelete: 'set null' }),
    iniciadaEm: instante('iniciada_em'),
    concluidaEm: instante('concluida_em'),

    ...carimbos(),
    ...exclusaoLogica()
  },
  (t) => [index('idx_campaigns_tenant_status').on(t.tenantId, t.status)]
);

/**
 * Alvo = um lead dentro de uma campanha, com a mensagem unica dele.
 *
 * `aguardando` — entrou no publico; a IA ainda nao escreveu a mensagem
 * `pendente`  — mensagem gerada, esperando aprovacao humana
 * `aprovada`  — liberada para a fila de envio
 * `enviando`  — sendo enviada agora (trava contra envio duplicado)
 * `enviada`   — o canal aceitou
 * `falha`     — o canal recusou; `erro` explica
 * `respondeu` — o cliente respondeu; `classificacao` diz se foi interesse ou recusa
 * `pulada`    — nao enviada de proposito (cliente pediu pra nao receber)
 */
export const campaignTargets = sqliteTable(
  'campaign_targets',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),

    /** Copiados na criacao, pra campanha antiga continuar legivel se o lead mudar. */
    telefone: text('telefone').notNull(),
    nomeCliente: text('nome_cliente').notNull(),

    mensagem: text('mensagem').notNull().default(''),

    status: text('status', {
      enum: ['aguardando', 'pendente', 'aprovada', 'enviando', 'enviada', 'falha', 'respondeu', 'pulada']
    })
      .notNull()
      // O padrao antigo fica: troca-lo obrigaria o SQLite a reconstruir a
      // tabela. Quem cria alvo sempre informa o status.
      .default('pendente'),

    /**
     * A IA falhou e a mensagem e o texto generico de reserva. A tela destaca
     * estas na revisao: ninguem deve aprovar achando que foi personalizada.
     */
    mensagemReserva: integer('mensagem_reserva', { mode: 'boolean' }).notNull().default(false),

    /** So recebe valor depois que o canal confirma. Nunca antes. */
    enviadoEm: instante('enviado_em'),
    erro: text('erro'),
    tentativas: integer('tentativas').notNull().default(0),

    respostaTexto: text('resposta_texto'),
    respondidoEm: instante('respondido_em'),
    classificacao: text('classificacao', { enum: ['interessado', 'recusa', 'neutro'] }),

    /** Contexto usado pra gerar a mensagem — permite auditar o que a IA viu. */
    contextoGeracao: jsonTexto('contexto_geracao', {}),

    ...carimbos()
  },
  (t) => [
    // Um lead nao pode entrar duas vezes na mesma campanha.
    uniqueIndex('idx_targets_campanha_lead').on(t.campaignId, t.leadId),
    index('idx_targets_campanha_status').on(t.campaignId, t.status),
    index('idx_targets_tenant').on(t.tenantId),
    // Cada mensagem que chega pergunta "este cliente esta respondendo a uma
    // campanha?" — sem indice, isso varreria todos os alvos a cada mensagem.
    index('idx_targets_lead').on(t.tenantId, t.leadId)
  ]
);
