import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { FUSO_PADRAO } from '../../core/datetime.js';

/**
 * Tenant = uma empresa cliente (uma barbearia, uma clinica).
 *
 * Fica num arquivo separado das outras tabelas de proposito: todas as demais
 * apontam pra ca, entao se ela morasse junto com qualquer outra teriamos um
 * ciclo de imports. Uma tabela sem dependencias, num arquivo sem dependencias.
 */
export const tenants = sqliteTable(
  'tenants',
  {
    id: text('id').primaryKey(),

    /** Nome comercial, o que aparece pro cliente final. */
    nome: text('nome').notNull(),

    /** Identificador curto e unico para URL: 'barbearia-do-ze'. */
    slug: text('slug').notNull(),

    /** Muda o vocabulario do sistema e os modelos de menu sugeridos. */
    segmento: text('segmento', { enum: ['barbearia', 'clinica', 'salao', 'outro'] })
      .notNull()
      .default('outro'),

    /**
     * Fuso horario da empresa. E daqui que sai a resposta pra "que dia e hoje?".
     * Guardar isso por empresa (e nao fixo no codigo) e o que permite atender
     * uma barbearia em Manaus e outra em Sao Paulo na mesma instalacao.
     */
    fusoHorario: text('fuso_horario').notNull().default(FUSO_PADRAO),

    /** Contatos administrativos da empresa. */
    emailContato: text('email_contato'),
    telefoneContato: text('telefone_contato'),

    ativo: integer('ativo', { mode: 'boolean' }).notNull().default(true),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date())
  },
  (t) => [uniqueIndex('idx_tenants_slug').on(t.slug)]
);
