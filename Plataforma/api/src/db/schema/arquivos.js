import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { colunaTenant } from './_shared.js';

/**
 * De que empresa e cada arquivo da pasta de uploads (fotos, audios, anexos).
 *
 * O arquivo e servido por `/api/arquivos/<nome>`, que exige login e so entrega
 * para quem e da MESMA empresa (ver equipe.routes.js). O nome do arquivo nao
 * diz a empresa, por isso esta tabela: gravada no momento em que o arquivo e
 * salvo (modules/equipe/arquivos.js — as funcoes de salvar EXIGEM a empresa),
 * e preenchida uma vez para os arquivos que ja existiam (modules/dados/indexar-arquivos.js).
 */
export const arquivos = sqliteTable(
  'arquivos',
  {
    /** O nome dentro da pasta de uploads, ex.: `anexo-<uuid>.pdf`. */
    nome: text('nome').primaryKey(),
    tenantId: colunaTenant(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date())
  },
  (t) => [index('idx_arquivos_tenant').on(t.tenantId)]
);
