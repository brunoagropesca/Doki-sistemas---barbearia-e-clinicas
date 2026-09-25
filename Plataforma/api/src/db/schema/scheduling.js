import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { carimbos, centavos, colunaTenant, exclusaoLogica, instante, jsonTexto } from './_shared.js';
import { users } from './auth.js';
import { leads, professionals } from './crm.js';
import { conversations } from './conversations.js';
import { products, services } from './catalog.js';

/**
 * Ciclo de vida de um agendamento.
 *
 * `pendente`   — pedido feito, ainda nao confirmado pela empresa
 * `confirmado` — combinado dos dois lados
 * `em_andamento` — cliente esta na cadeira agora
 * `concluido`  — servico entregue (e o unico estado que vira faturamento)
 * `cancelado`  — cancelado com aviso
 * `faltou`     — cliente nao apareceu e nao avisou
 *
 * `faltou` existe separado de `cancelado` de proposito: e um indicador de
 * negocio. Cliente que falta tres vezes merece tratamento diferente de cliente
 * que cancela com antecedencia, e sem esses estados distintos ninguem consegue
 * medir isso.
 */
export const STATUS_AGENDAMENTO = [
  'pendente',
  'confirmado',
  'em_andamento',
  'concluido',
  'cancelado',
  'faltou'
];

export const appointments = sqliteTable(
  'appointments',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    serviceId: text('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    professionalId: text('professional_id')
      .notNull()
      .references(() => professionals.id, { onDelete: 'restrict' }),

    /**
     * Instantes em UTC (milissegundos). O horario que o cliente ve sai da
     * conversao pelo fuso da empresa, em `core/datetime.js`.
     */
    inicioEm: integer('inicio_em', { mode: 'timestamp_ms' }).notNull(),
    fimEm: integer('fim_em', { mode: 'timestamp_ms' }).notNull(),

    /** Quando o lembrete de vespera saiu (nulo = ainda nao). Evita mandar duas vezes. */
    lembreteEnviadoEm: instante('lembrete_enviado_em'),

    status: text('status', { enum: STATUS_AGENDAMENTO }).notNull().default('pendente'),

    /**
     * Preco congelado no momento da marcacao.
     *
     * Copiamos o valor em vez de ler do servico na hora de exibir. Se a
     * barbearia aumentar o corte de R$ 45 pra R$ 50 amanha, o historico do mes
     * passado precisa continuar mostrando R$ 45 — senao o relatorio de
     * faturamento muda sozinho toda vez que alguem mexe na tabela de precos.
     */
    precoCentavos: centavos('preco_centavos'),
    descontoCentavos: centavos('desconto_centavos'),

    observacoes: text('observacoes').notNull().default(''),
    /** Lista de tarefas do atendimento: `[{ texto, feito }]`. */
    checklist: jsonTexto('checklist', []),

    /** Quem criou: um atendente, ou a propria IA. */
    criadoPor: text('criado_por', { enum: ['humano', 'ia', 'cliente', 'sistema'] })
      .notNull()
      .default('humano'),
    criadoPorUserId: text('criado_por_user_id').references(() => users.id, { onDelete: 'set null' }),

    /**
     * O atendente RESPONSAVEL por este horario: quem fala com o cliente ate o
     * dia do servico e quem enxerga a OS quando a privacidade esta ligada.
     *
     * E diferente de `criadoPorUserId`: quando a IA marca, ninguem "criou" —
     * mas alguem precisa ser o dono do cliente, senao o horario ficaria sem
     * responsavel e visivel a todos (ou a ninguem). Quem marca de fato e quem
     * conduz o cliente nem sempre e a mesma pessoa, entao sao dois campos.
     */
    responsavelUserId: text('responsavel_user_id').references(() => users.id, { onDelete: 'set null' }),

    confirmadoEm: instante('confirmado_em'),
    concluidoEm: instante('concluido_em'),
    canceladoEm: instante('cancelado_em'),
    motivoCancelamento: text('motivo_cancelamento'),

    /**
     * Sessao de atendimento (conversa do livechat) que originou esta OS.
     *
     * Enquanto a conversa esta aberta, a OS fica "vinculada" a ela. Ao
     * finalizar a conversa, o resumo do atendimento e copiado para
     * `resumoAtendimento` e o vinculo deixa de estar ativo.
     */
    conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    /** Resumo do atendimento, anexado quando a sessao vinculada e finalizada. */
    resumoAtendimento: text('resumo_atendimento'),
    resumoEm: instante('resumo_em'),

    /**
     * Anotacoes de gente, copiadas da conversa quando a sessao fecha.
     *
     * E uma copia de proposito, pelo mesmo motivo do preco congelado: daqui a
     * seis meses, quem abrir esta OS precisa ler o que o atendente anotou
     * NAQUELE dia — nao o que alguem escreveu na conversa depois.
     */
    anotacoesAtendimento: text('anotacoes_atendimento'),

    /** Humor do cliente no encerramento da sessao, para o historico da OS. */
    humorAtendimento: text('humor_atendimento'),

    /** Tira da agenda do dia a dia sem apagar do historico. */
    arquivadoEm: instante('arquivado_em'),

    ...carimbos(),
    ...exclusaoLogica()
  },
  (t) => [
    // Indice principal: quase toda consulta e "agenda do profissional X no periodo Y".
    index('idx_appt_tenant_prof_inicio').on(t.tenantId, t.professionalId, t.inicioEm),
    index('idx_appt_tenant_inicio').on(t.tenantId, t.inicioEm),
    index('idx_appt_tenant_status').on(t.tenantId, t.status),
    index('idx_appt_lead').on(t.tenantId, t.leadId),
    index('idx_appt_conversa').on(t.tenantId, t.conversationId),
    index('idx_appt_responsavel').on(t.tenantId, t.responsavelUserId, t.inicioEm)
  ]
);

/**
 * Venda de produto.
 *
 * Pode estar amarrada a um agendamento (a pomada que o cliente levou junto com
 * o corte) ou solta (entrou so pra comprar).
 */
export const productSales = sqliteTable(
  'product_sales',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    leadId: text('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    appointmentId: text('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),

    quantidade: integer('quantidade').notNull().default(1),
    /** Preco unitario congelado no momento da venda — mesma logica do agendamento. */
    precoUnitarioCentavos: centavos('preco_unitario_centavos'),
    totalCentavos: centavos('total_centavos'),

    vendidoPorUserId: text('vendido_por_user_id').references(() => users.id, { onDelete: 'set null' }),
    vendidoEm: integer('vendido_em', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),

    ...carimbos(),
    ...exclusaoLogica()
  },
  (t) => [
    index('idx_sales_tenant_data').on(t.tenantId, t.vendidoEm),
    index('idx_sales_lead').on(t.tenantId, t.leadId)
  ]
);

/**
 * Historico de atendimentos encerrados — a base do futuro painel de analise.
 *
 * Uma linha por agendamento que chegou ao fim (`concluido`, `cancelado` ou
 * `faltou`), gravada no momento em que ele encerra. E uma FOTO daquele
 * instante, nao uma consulta sobre a agenda viva:
 *
 *   - nomes e precos ficam copiados: renomear o servico ou reajustar a tabela
 *     nao reescreve o passado;
 *   - data, dia da semana e hora ja vem no fuso da empresa: "que dia da semana
 *     mais fatura?" vira um GROUP BY simples, sem converter fuso em SQL;
 *   - o que so da para saber na hora (se era a primeira visita do cliente,
 *     com quanta antecedencia marcou) fica gravado, porque depois nao da mais
 *     para reconstruir.
 *
 * Cancelados e faltas entram tambem: taxa de falta por profissional e por
 * horario e das perguntas que o painel vai fazer.
 *
 * Nao tem exclusao logica: e registro historico. Se o agendamento for excluido
 * depois, a linha continua — o atendimento aconteceu.
 */
export const RESULTADOS_ATENDIMENTO = ['concluido', 'cancelado', 'faltou'];

export const serviceHistory = sqliteTable(
  'service_history',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    /** Um agendamento gera no maximo uma linha (indice unico abaixo). */
    appointmentId: text('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),
    resultado: text('resultado', { enum: RESULTADOS_ATENDIMENTO }).notNull(),

    professionalId: text('professional_id').references(() => professionals.id, { onDelete: 'set null' }),
    professionalNome: text('professional_nome').notNull(),
    serviceId: text('service_id').references(() => services.id, { onDelete: 'set null' }),
    serviceNome: text('service_nome').notNull(),
    serviceCategoria: text('service_categoria').notNull().default('Geral'),
    leadId: text('lead_id').references(() => leads.id, { onDelete: 'set null' }),

    /** Primeira vez que este cliente CONCLUI um atendimento na empresa. */
    clienteNovo: integer('cliente_novo', { mode: 'boolean' }).notNull().default(false),

    /** Valores do agendamento. `valorCentavos` = preco - desconto (o que entrou no caixa). */
    precoCentavos: centavos('preco_centavos'),
    descontoCentavos: centavos('desconto_centavos'),
    valorCentavos: centavos('valor_centavos'),
    /** Preco de tabela do servico no dia: compara o que o profissional cobra com o padrao. */
    precoTabelaCentavos: centavos('preco_tabela_centavos'),
    duracaoMinutos: integer('duracao_minutos').notNull().default(0),

    /** Quando o servico estava marcado e quando o agendamento encerrou. */
    inicioEm: integer('inicio_em', { mode: 'timestamp_ms' }).notNull(),
    encerradoEm: integer('encerrado_em', { mode: 'timestamp_ms' }).notNull(),
    /** No fuso da empresa: YYYY-MM-DD, 0 (domingo) a 6, 0 a 23. */
    dataLocal: text('data_local').notNull(),
    diaSemana: integer('dia_semana').notNull(),
    horaLocal: integer('hora_local').notNull(),
    /** Horas entre marcar e o horario do servico. */
    antecedenciaHoras: integer('antecedencia_horas'),

    /** Quem marcou (IA, atendente, o proprio cliente) e quem cuidou do cliente. */
    origem: text('origem').notNull(),
    responsavelUserId: text('responsavel_user_id').references(() => users.id, { onDelete: 'set null' }),
    conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    humor: text('humor'),
    motivoCancelamento: text('motivo_cancelamento'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date())
  },
  (t) => [
    uniqueIndex('idx_history_appointment').on(t.appointmentId),
    index('idx_history_prof_data').on(t.tenantId, t.professionalId, t.dataLocal),
    index('idx_history_tenant_data').on(t.tenantId, t.dataLocal),
    index('idx_history_lead').on(t.tenantId, t.leadId)
  ]
);
