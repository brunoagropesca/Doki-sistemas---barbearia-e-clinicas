import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { carimbos, colunaTenant, exclusaoLogica, instante, jsonTexto } from './_shared.js';
import { users } from './auth.js';

/**
 * Lead = uma pessoa que entrou em contato. O contato do CRM.
 */
export const leads = sqliteTable(
  'leads',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    /**
     * Telefone na forma canonica: so digitos, com o 55 na frente.
     * Toda escrita passa por `core/phone.js` antes de chegar aqui — e isso
     * que impede o mesmo cliente de virar tres cadastros diferentes.
     */
    telefone: text('telefone').notNull(),
    nome: text('nome').notNull(),
    email: text('email'),

    /** Endereco do cliente, em texto livre: "Rua X, 123 - Centro". */
    endereco: text('endereco').notNull().default(''),

    /**
     * Foto do cliente, servida por `/api/arquivos/...`.
     *
     * Vem do perfil do WhatsApp quando ele e publico. A imagem e BAIXADA e
     * guardada aqui: a URL que o WhatsApp devolve e assinada e expira em
     * horas, entao guardar o link daria uma foto quebrada no dia seguinte.
     */
    fotoUrl: text('foto_url'),
    /** Quando tentamos buscar a foto pela ultima vez (deu certo ou nao). */
    fotoSincronizadaEm: instante('foto_sincronizada_em'),

    /** Anotacoes livres: preferencias, alergias, "gosta de corte na tesoura". */
    observacoes: text('observacoes').notNull().default(''),

    /**
     * Etiquetas livres. Ficam em JSON porque sao poucas por lead e a empresa
     * inventa as dela. Se um dia virar filtro pesado, vira tabela propria.
     */
    tags: jsonTexto('tags', []),

    /** Por onde este lead chegou: 'whatsapp', 'manual', 'importacao'. */
    origem: text('origem').notNull().default('whatsapp'),

    /** Humor detectado pela IA na ultima conversa. Veja o modulo de IA. */
    humor: text('humor', { enum: ['satisfeito', 'neutro', 'duvida', 'frustrado'] }),
    humorAtualizadoEm: instante('humor_atualizado_em'),

    /** Atendente responsavel por esta carteira de cliente. */
    responsavelId: text('responsavel_id').references(() => users.id, { onDelete: 'set null' }),

    ultimoContatoEm: instante('ultimo_contato_em'),

    /**
     * Cliente pediu pra nao receber mais campanha.
     *
     * Isto nao e enfeite: e a diferenca entre marketing e perseguicao, e o
     * motor de campanhas e obrigado a respeitar. Uma vez marcado, nenhum
     * disparo em massa alcanca esta pessoa de novo.
     */
    aceitaCampanha: integer('aceita_campanha', { mode: 'boolean' }).notNull().default(true),
    ultimaCampanhaEm: instante('ultima_campanha_em'),

    /**
     * A IA atende ESTE cliente?
     *
     * Desligar aqui e diferente de desligar a IA do canal inteiro: serve para
     * o cliente que pediu para falar so com gente, ou para aquele que a IA
     * nao consegue entender. Vale para todas as conversas dele, inclusive as
     * que ainda vao abrir.
     */
    iaAtiva: integer('ia_ativa', { mode: 'boolean' }).notNull().default(true),

    ...carimbos(),
    ...exclusaoLogica()
  },
  (t) => [
    // Um telefone so pode existir uma vez por empresa — esta e a barreira
    // de banco contra lead duplicado. Nao confiamos so na checagem do codigo.
    uniqueIndex('idx_leads_tenant_telefone').on(t.tenantId, t.telefone),
    index('idx_leads_tenant_nome').on(t.tenantId, t.nome),
    index('idx_leads_responsavel').on(t.tenantId, t.responsavelId),
    index('idx_leads_ultimo_contato').on(t.tenantId, t.ultimoContatoEm)
  ]
);

/**
 * Profissional = quem executa o servico (barbeiro, esteticista, dentista).
 *
 * Separado de `users` de proposito. Um barbeiro pode nao ter login nenhum no
 * sistema, e uma recepcionista tem login mas nao atende ninguem na cadeira.
 * Quando a mesma pessoa e as duas coisas, `userId` liga os dois cadastros.
 */
export const professionals = sqliteTable(
  'professionals',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    nome: text('nome').notNull(),
    funcao: text('funcao').notNull().default('Especialista'),
    /** Cor do profissional no calendario. */
    cor: text('cor').notNull().default('#3b82f6'),

    /** Contato direto, para a recepcao avisar de encaixe ou cancelamento. */
    telefone: text('telefone'),
    /** Foto do profissional, servida por `/api/arquivos/...`. */
    fotoUrl: text('foto_url'),
    /** Observacoes internas: preferencias, acordos, o que a equipe precisa saber. */
    observacoes: text('observacoes').notNull().default(''),

    /** Ligacao opcional com um login do sistema. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

    /**
     * Jornada de trabalho.
     *
     * Formato: `{ dias: { "1": [{ inicio: "09:00", fim: "18:00" }] }, intervaloMinutos: 30 }`
     * onde a chave e o dia da semana (0 = domingo).
     *
     * O sistema antigo tinha os horarios disponiveis escritos na mao dentro do
     * codigo, em dois lugares diferentes e com valores diferentes. Aqui a agenda
     * de cada profissional e dado, e o calculo de vagas le daqui.
     */
    jornada: jsonTexto('jornada', {
      dias: {
        1: [{ inicio: '09:00', fim: '18:00' }],
        2: [{ inicio: '09:00', fim: '18:00' }],
        3: [{ inicio: '09:00', fim: '18:00' }],
        4: [{ inicio: '09:00', fim: '18:00' }],
        5: [{ inicio: '09:00', fim: '18:00' }],
        6: [{ inicio: '09:00', fim: '14:00' }]
      },
      intervaloMinutos: 30
    }),

    ativo: integer('ativo', { mode: 'boolean' }).notNull().default(true),

    ...carimbos(),
    ...exclusaoLogica()
  },
  (t) => [index('idx_professionals_tenant').on(t.tenantId, t.ativo)]
);

/**
 * Bloqueios de agenda: ferias, almoco, feriado, consulta particular.
 *
 * Sem isto, a unica forma de impedir um agendamento num horario e criar um
 * agendamento falso — exatamente a gambiarra que as recepcoes acabam fazendo.
 */
export const scheduleBlocks = sqliteTable(
  'schedule_blocks',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    /** Nulo = bloqueia a empresa inteira (feriado, por exemplo). */
    professionalId: text('professional_id').references(() => professionals.id, { onDelete: 'cascade' }),

    motivo: text('motivo').notNull().default('Indisponivel'),
    inicioEm: integer('inicio_em', { mode: 'timestamp_ms' }).notNull(),
    fimEm: integer('fim_em', { mode: 'timestamp_ms' }).notNull(),

    ...carimbos()
  },
  (t) => [index('idx_blocks_tenant_periodo').on(t.tenantId, t.inicioEm, t.fimEm)]
);
