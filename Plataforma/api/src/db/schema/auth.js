import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { carimbos, colunaTenant, exclusaoLogica, instante, jsonTexto } from './_shared.js';
import { tenants } from './tenants.js';

/**
 * Cargos do sistema, do mais poderoso pro menos.
 *
 * `owner`     — dono da empresa. Ve faturamento, mexe em tudo do tenant dele.
 * `admin`     — gerente. Mexe em catalogo, agenda, equipe. Nao apaga a empresa.
 * `atendente` — recepcao. Atende conversa, marca horario, ve o proprio desempenho.
 *
 * `dev` e um cargo especial e INVISIVEL: e o de quem configura a plataforma (o
 * desenvolvedor), nao da empresa cliente. Existe para as poucas coisas que o
 * cliente nao deve fazer sozinho — a primeira delas e adicionar e remover
 * sessoes de WhatsApp. Nao aparece em lista nenhuma, nao pode ser criado pela
 * API e nem a validacao de entrada revela que o cargo existe. Nasce por linha
 * de comando (`npm run usuario:dev`).
 */
export const CARGOS = ['dev', 'owner', 'admin', 'atendente'];

/**
 * Cargos que uma empresa pode ver e atribuir. O `dev` fica de fora de
 * proposito: e a lista que a API aceita ao criar usuario e que a tela mostra.
 */
export const CARGOS_VISIVEIS = CARGOS.filter((c) => c !== 'dev');

/** Nivel numerico de cada cargo — quanto maior, mais poder. Usado nas checagens. */
export const NIVEL_CARGO = {
  atendente: 10,
  admin: 20,
  owner: 30,
  dev: 100
};

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    /** Usado no login. Unico dentro da empresa, nao no sistema todo. */
    username: text('username').notNull(),
    nome: text('nome').notNull(),
    email: text('email'),
    telefone: text('telefone'),

    /**
     * NUNCA guardamos a senha. Guardamos o resultado de `scrypt` sobre ela,
     * junto com o sal aleatorio daquele usuario. Veja `modules/auth/password.js`.
     *
     * O sistema antigo usava SHA-256 com um sal fixo escrito no codigo. SHA-256
     * foi feito pra ser rapido, e isso e exatamente o defeito: uma placa de video
     * testa bilhoes de senhas por segundo contra ele. E com sal fixo, quebrar uma
     * senha quebra todas as iguais de uma vez.
     */
    passwordHash: text('password_hash').notNull(),

    cargo: text('cargo', { enum: CARGOS }).notNull().default('atendente'),

    /** Disponibilidade para receber conversa na fila de atendimento. */
    statusPresenca: text('status_presenca', { enum: ['online', 'ausente', 'offline'] })
      .notNull()
      .default('offline'),

    /** Quantas conversas simultaneas esta pessoa aguenta. Usado na distribuicao. */
    capacidadeSimultanea: integer('capacidade_simultanea').notNull().default(5),

    /** Foto da pessoa, servida por `/api/arquivos/...` (ou nulo: mostra a inicial do nome). */
    avatar: text('avatar'),
    ativo: integer('ativo', { mode: 'boolean' }).notNull().default(true),
    ultimoLoginEm: instante('ultimo_login_em'),

    ...carimbos(),
    ...exclusaoLogica()
  },
  (t) => [
    // O username so precisa ser unico DENTRO da empresa. Duas barbearias
    // diferentes podem ter, cada uma, um usuario "recepcao".
    uniqueIndex('idx_users_tenant_username').on(t.tenantId, t.username),
    index('idx_users_tenant_cargo').on(t.tenantId, t.cargo),
    index('idx_users_presenca').on(t.tenantId, t.statusPresenca)
  ]
);

/**
 * Respostas rapidas de cada atendente.
 *
 * Sao DA PESSOA, nao da empresa: cada um tem o proprio jeito de cumprimentar e
 * de passar preco, e uma lista unica viraria uma briga de quem edita o texto
 * do outro. Chamadas no livechat digitando `/atalho`.
 */
export const quickReplies = sqliteTable(
  'quick_replies',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** O que se digita depois da barra: `ola` para `/ola`. */
    atalho: text('atalho').notNull(),
    texto: text('texto').notNull(),

    ...carimbos(),
    ...exclusaoLogica()
  },
  (t) => [index('idx_quick_replies_user').on(t.tenantId, t.userId)]
);

/**
 * Avisos da gerencia para um atendente.
 *
 * Aparecem por cima de tudo na tela da pessoa e so saem quando ela confirma
 * que leu. Ficam no banco, e nao so no canal de tempo real, porque quem esta
 * deslogado (ou com a aba fechada) tem de ver o aviso assim que entrar — e
 * porque "eu avisei" precisa de prova de quando a pessoa confirmou.
 */
export const teamAlerts = sqliteTable(
  'team_alerts',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),
    /** Quem recebe. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Quem mandou. O nome fica copiado: o aviso continua legivel se o remetente sair da empresa. */
    deUserId: text('de_user_id').references(() => users.id, { onDelete: 'set null' }),
    deNome: text('de_nome').notNull(),

    mensagem: text('mensagem').notNull(),
    lidoEm: instante('lido_em'),
    /** Cancelado pelo sistema (avisos desligados pelo DEV): some da tela e NAO conta como lido. */
    canceladoEm: instante('cancelado_em'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date())
  },
  (t) => [index('idx_team_alerts_pendentes').on(t.tenantId, t.userId, t.lidoEm)]
);

/**
 * Sessoes de login.
 *
 * Optamos por token opaco guardado no banco, e nao por JWT. O motivo e pratico:
 * com JWT nao da pra deslogar alguem de verdade antes do token expirar — se um
 * funcionario e demitido, o cracha dele continua funcionando. Aqui basta apagar
 * a linha e o acesso morre na proxima requisicao.
 *
 * Guardamos o HASH do token, nao o token. Se o banco vazar, os tokens de dentro
 * dele nao servem pra entrar em nada — mesma logica das senhas.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    tokenHash: text('token_hash').notNull(),

    expiraEm: integer('expira_em', { mode: 'timestamp_ms' }).notNull(),
    revogadaEm: instante('revogada_em'),
    ultimoUsoEm: instante('ultimo_uso_em'),

    /** Contexto de onde o login partiu — ajuda a investigar acesso suspeito. */
    userAgent: text('user_agent'),
    ip: text('ip'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date())
  },
  (t) => [
    uniqueIndex('idx_sessions_token').on(t.tokenHash),
    index('idx_sessions_user').on(t.userId),
    index('idx_sessions_expira').on(t.expiraEm)
  ]
);

/**
 * Trilha de auditoria.
 *
 * Responde "quem apagou o agendamento da dona Maria?" — pergunta que no sistema
 * antigo nao tinha resposta possivel. Toda acao que muda dado sensivel (apagar,
 * transferir, mexer em dinheiro, trocar cargo) escreve uma linha aqui.
 *
 * Nao tem exclusao logica de proposito: auditoria que pode ser apagada pelo
 * proprio sistema nao e auditoria.
 */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /** Pode ser nulo quando a acao partiu do sistema (robo, tarefa agendada). */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    userNome: text('user_nome'),

    /** Ex: 'lead.excluir', 'agendamento.cancelar', 'usuario.trocar_cargo'. */
    acao: text('acao').notNull(),
    entidade: text('entidade').notNull(),
    entidadeId: text('entidade_id'),

    /** O que mudou: `{ antes: {...}, depois: {...} }`. */
    dados: jsonTexto('dados', {}),

    ip: text('ip'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date())
  },
  (t) => [
    index('idx_audit_tenant_data').on(t.tenantId, t.createdAt),
    index('idx_audit_entidade').on(t.tenantId, t.entidade, t.entidadeId)
  ]
);
