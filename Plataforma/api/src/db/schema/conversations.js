import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { carimbos, colunaTenant, exclusaoLogica, instante, jsonTexto } from './_shared.js';
import { users } from './auth.js';
import { leads } from './crm.js';

/**
 * Instancia de canal = uma conexao concreta com o mundo externo.
 * Ex: "o WhatsApp da recepcao", "o WhatsApp do dono", "o bot do Telegram".
 *
 * O sistema antigo tinha DUAS tabelas pra isso (`channel_connections` e
 * `whatsapp_instances`) que guardavam a mesma coisa de jeitos diferentes e
 * viviam fora de sincronia. Aqui e uma tabela so, com o que varia por canal
 * dentro de `config`.
 */
export const channelInstances = sqliteTable(
  'channel_instances',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    canal: text('canal', { enum: ['whatsapp', 'telegram', 'instagram', 'web'] }).notNull(),
    /** Apelido curto e estavel: 'W1', 'W2'. Usado nos logs e nas rotas. */
    chave: text('chave').notNull(),
    nome: text('nome').notNull(),

    status: text('status', {
      enum: ['desconectado', 'conectando', 'aguardando_qr', 'conectado', 'erro']
    })
      .notNull()
      .default('desconectado'),

    /** Numero/identificador que a conta representa, quando conectada. */
    identificador: text('identificador'),
    nomePerfil: text('nome_perfil'),

    /** QR Code atual, quando o canal esta esperando leitura. Volatil. */
    qrCode: text('qr_code'),
    qrExpiraEm: instante('qr_expira_em'),

    /** Config especifica do canal (token do bot, webhook, preferencias). */
    config: jsonTexto('config', {}),

    /**
     * Liga/desliga a resposta automatica NESTE canal.
     * Permite ter um numero atendido por IA e outro so por humano.
     */
    iaHabilitada: integer('ia_habilitada', { mode: 'boolean' }).notNull().default(true),

    ultimoErro: text('ultimo_erro'),
    conectadoEm: instante('conectado_em'),

    ativo: integer('ativo', { mode: 'boolean' }).notNull().default(true),

    ...carimbos(),
    ...exclusaoLogica()
  },
  (t) => [
    uniqueIndex('idx_channels_tenant_chave').on(t.tenantId, t.chave),
    index('idx_channels_tenant_canal').on(t.tenantId, t.canal)
  ]
);

/**
 * Estados de uma conversa.
 *
 * `bot`        — a IA esta conduzindo
 * `na_fila`    — pediu humano, esperando alguem assumir
 * `humana`     — um atendente assumiu; a IA fica calada
 * `finalizada` — encerrada
 */
export const STATUS_CONVERSA = ['bot', 'na_fila', 'humana', 'finalizada'];

/**
 * Etapas da PRIMEIRA metade do atendimento — do "oi" ate o horario fechar.
 *
 * Depois que a OS existe e esta confirmada, quem manda no quadro e o status
 * do agendamento (`confirmado`, `em_andamento`, `concluido`, `cancelado`).
 * Por isso esta lista para em `aguardando`: as colunas seguintes nao sao um
 * campo, sao o estado real da OS. Ter duas fontes para a mesma informacao e
 * o caminho mais curto para um quadro que discorda da agenda.
 *
 * `novo`        — chegou agora, ninguem entendeu o pedido ainda
 * `entendendo`  — descobrindo o que a pessoa quer (servico, profissional)
 * `orcamento`   — preco e horarios ja foram apresentados
 * `aguardando`  — a proposta esta de pe, esperando o cliente confirmar
 */
export const ETAPAS_ATENDIMENTO = ['novo', 'entendendo', 'orcamento', 'aguardando'];

/** Os quatro humores que a Sofia sabe distinguir — os mesmos do lead. */
export const HUMORES = ['satisfeito', 'neutro', 'duvida', 'frustrado'];

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    channelInstanceId: text('channel_instance_id').references(() => channelInstances.id, {
      onDelete: 'set null'
    }),
    canal: text('canal').notNull().default('whatsapp'),

    status: text('status', { enum: STATUS_CONVERSA }).notNull().default('bot'),

    /** Atendente humano responsavel, quando o status e 'humana'. */
    assignedUserId: text('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    assumidaEm: instante('assumida_em'),

    /**
     * Previa da ultima mensagem, para a lista de conversas.
     *
     * E duplicacao proposital: sem isto, montar a tela com 200 conversas exige
     * 200 consultas pra descobrir a ultima mensagem de cada uma. Guardar a previa
     * aqui troca um pouco de redundancia por uma tela que abre instantaneamente.
     *
     * (No sistema antigo o motor de campanhas tentava escrever numa coluna
     * `last_message` que nunca chegou a ser criada, e isso derrubava todo disparo.)
     */
    ultimaMensagemPreview: text('ultima_mensagem_preview').notNull().default(''),
    ultimaMensagemEm: instante('ultima_mensagem_em'),
    naoLidas: integer('nao_lidas').notNull().default(0),

    /** Metricas de atendimento, calculadas na hora em que o fato acontece. */
    primeiraRespostaSegundos: integer('primeira_resposta_segundos'),
    totalMensagensCliente: integer('total_mensagens_cliente').notNull().default(0),
    totalMensagensIa: integer('total_mensagens_ia').notNull().default(0),
    totalMensagensHumano: integer('total_mensagens_humano').notNull().default(0),

    /** Historico de transferencias: `[{ de, para, motivo, em }]`. */
    historicoTransferencias: jsonTexto('historico_transferencias', []),

    /**
     * Etapa no quadro de atendimento, enquanto nao ha OS confirmada.
     * Quem move e a Atena (ou o atendente arrastando o cartao).
     */
    etapaAtendimento: text('etapa_atendimento', { enum: ETAPAS_ATENDIMENTO }).notNull().default('novo'),

    /**
     * Leitura de humor feita pela Sofia DURANTE a conversa.
     *
     * Fica na conversa, e nao so no lead, porque a pergunta que o atendente
     * faz e "como esta ESTE atendimento agora?". O lead guarda o humor mais
     * recente para o CRM; aqui fica o do atendimento em curso, com o
     * mini-resumo que explica a leitura.
     */
    humor: text('humor', { enum: HUMORES }),
    humorResumo: text('humor_resumo'),
    humorAtualizadoEm: instante('humor_atualizado_em'),
    /** Em qual mensagem do cliente a ultima leitura foi feita (controla o gasto). */
    humorNaMensagem: integer('humor_na_mensagem').notNull().default(0),

    /** Anotacoes escritas por gente, na mao. A IA nunca escreve aqui. */
    anotacoesHumanas: text('anotacoes_humanas').notNull().default(''),

    /** Resumo gerado pela IA quando a conversa fecha. */
    resumo: text('resumo'),
    finalizadaEm: instante('finalizada_em'),

    /**
     * Em que ponto do menu o cliente esta: `{ no, pilha, em }`. Sem isto, um
     * "1" digitado dentro de um submenu era lido como a opcao 1 do menu
     * PRINCIPAL. Nulo = fora do menu (a proxima mensagem comeca do inicio).
     */
    menuEstado: text('menu_estado', { mode: 'json' }),

    ...carimbos(),
    ...exclusaoLogica()
  },
  (t) => [
    index('idx_conv_tenant_status').on(t.tenantId, t.status),
    index('idx_conv_tenant_ultima_msg').on(t.tenantId, t.ultimaMensagemEm),
    index('idx_conv_lead').on(t.tenantId, t.leadId),
    index('idx_conv_atendente').on(t.tenantId, t.assignedUserId),
    // O quadro de atendimento le por etapa, sempre dentro das nao finalizadas.
    index('idx_conv_etapa').on(t.tenantId, t.etapaAtendimento),

    /**
     * Um cliente tem NO MAXIMO uma conversa aberta por vez.
     *
     * Todo o codigo ja assumia isso, mas nada garantia. O resultado aparecia
     * numa rajada de mensagens: tres chegam juntas, as tres procuram uma
     * conversa aberta, nenhuma acha, e as tres criam a sua — o cliente vira
     * tres linhas na mesa de atendimento e recebe tres respostas.
     *
     * Com o indice parcial, o banco recusa a segunda. Quem levar a recusa
     * busca de novo e reaproveita a conversa que o outro acabou de abrir.
     * Conversas finalizadas ficam de fora, entao o historico pode ter quantas
     * conversas encerradas forem necessarias.
     */
    uniqueIndex('idx_conv_aberta_por_lead')
      // Por CONEXAO tambem: o mesmo cliente pode falar com dois numeros da
      // empresa (W1 e W2), e sao duas conversas — cada uma responde pelo numero
      // em que ele escreveu. O coalesce faz "sem conexao" contar como um valor
      // (no SQLite, NULL nunca e igual a NULL, e o indice nao barraria nada).
      // (Sem nome de tabela na frente: o SQLite proibe "tabela.coluna" em indice de expressao.)
      .on(t.tenantId, t.leadId, sql.raw("coalesce(`channel_instance_id`, '')"))
      .where(sql`${t.status} != 'finalizada' AND ${t.deletedAt} IS NULL`)
  ]
);

/**
 * Mensagem de uma conversa.
 *
 * O sistema antigo tinha uma coluna `sender` com uma lista fechada de valores
 * ('client', 'atendente', 'menu_estatico', 'ai_agent'...). Toda vez que surgia
 * um tipo novo de remetente, era preciso uma migracao pra ampliar a lista —
 * e isso aconteceu de verdade, na migracao 009.
 *
 * Aqui a informacao e dividida em duas perguntas independentes:
 *   `direcao`    — entrou ou saiu?
 *   `autorTipo`  — quem produziu?
 * Duas colunas pequenas que cobrem qualquer combinacao futura sem migracao.
 */
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    direcao: text('direcao', { enum: ['entrada', 'saida'] }).notNull(),
    autorTipo: text('autor_tipo', { enum: ['lead', 'ia', 'humano', 'menu', 'sistema'] }).notNull(),
    autorUserId: text('autor_user_id').references(() => users.id, { onDelete: 'set null' }),

    tipo: text('tipo', { enum: ['texto', 'audio', 'imagem', 'documento', 'video'] })
      .notNull()
      .default('texto'),
    conteudo: text('conteudo').notNull(),

    /** Para midia: caminho do arquivo e transcricao, quando houver. */
    midiaUrl: text('midia_url'),
    transcricao: text('transcricao'),

    /**
     * Id da mensagem no sistema externo (WhatsApp, Telegram).
     * Existe pra deduplicar: esses servicos reenviam a mesma mensagem quando
     * acham que voce nao confirmou o recebimento.
     */
    externalId: text('external_id'),

    /** Rastro tecnico: qual modelo respondeu, quanto demorou, quais tentativas falharam. */
    metadados: jsonTexto('metadados', {}),

    /** Falha no envio para o canal externo. */
    erroEnvio: text('erro_envio'),
    entregueEm: instante('entregue_em'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date())
  },
  (t) => [
    index('idx_msg_conversa_data').on(t.conversationId, t.createdAt),
    index('idx_msg_tenant_data').on(t.tenantId, t.createdAt),
    /**
     * Indice unico PARCIAL: vale so para mensagens que ENTRAM.
     *
     * Deduplicar e uma preocupacao de entrada — WhatsApp e Telegram reenviam
     * a mesma mensagem quando acham que nao confirmamos o recebimento.
     *
     * Na saida, o id externo e so um rastro util. Se dois envios acabarem com
     * o mesmo id (reenvio nosso, id reaproveitado pelo canal), isso nao pode
     * derrubar a resposta ao cliente — que era o que acontecia quando o
     * indice cobria as duas direcoes.
     */
    uniqueIndex('idx_msg_external_entrada')
      .on(t.tenantId, t.externalId)
      .where(sql`${t.direcao} = 'entrada' AND ${t.externalId} IS NOT NULL`)
  ]
);

/**
 * Notificacao para o atendente: "a IA passou um cliente para voce".
 *
 * Uma linha por pessoa notificada. Quando a conversa foi distribuida, so quem
 * a recebeu e notificado; quando ficou na fila sem dono, toda a equipe que
 * atende recebe — e a primeira pessoa que clicar em "Atender" leva, fechando
 * a notificacao de todo mundo.
 *
 * `urgente` marca cliente frustrado: essa notificacao nao se fecha sozinha nem
 * no "x" — so sai quando alguem atende a conversa.
 */
export const teamNotifications = sqliteTable(
  'team_notifications',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    /** Copiados na hora: a notificacao aparece sem precisar buscar a conversa. */
    leadNome: text('lead_nome'),
    motivo: text('motivo').notNull().default(''),
    urgente: integer('urgente', { mode: 'boolean' }).notNull().default(false),

    /** Quando saiu da tela da pessoa (atendeu, fechou, ou outra pessoa atendeu). */
    fechadaEm: instante('fechada_em'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date())
  },
  (t) => [
    index('idx_team_notifications_abertas').on(t.tenantId, t.userId, t.fechadaEm),
    index('idx_team_notifications_conversa').on(t.tenantId, t.conversationId)
  ]
);
