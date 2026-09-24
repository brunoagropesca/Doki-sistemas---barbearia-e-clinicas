import { integer, text } from 'drizzle-orm/sqlite-core';
import { tenants } from './tenants.js';

/**
 * Pecas reaproveitadas por todas as tabelas.
 *
 * Centralizar isso evita o problema classico de banco: `created_at` ser TEXT
 * numa tabela, INTEGER na outra e nao existir numa terceira. Quando toda
 * tabela monta suas colunas comuns a partir daqui, elas ficam identicas
 * por construcao, nao por disciplina.
 */

/**
 * Carimbos de tempo.
 *
 * Guardamos tempo como INTEGER (milissegundos desde 1970, em UTC), nao como texto.
 * Numero ocupa menos espaco, compara e ordena direto no indice, e — o mais
 * importante — nao carrega fuso embutido, entao nao existe a duvida
 * "esse '2026-09-19 21:00' e horario de Brasilia ou de Londres?".
 * A conversao pro fuso da empresa acontece em `core/datetime.js`, ao exibir.
 */
export const carimbos = () => ({
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date())
});

/**
 * Exclusao logica ("soft delete").
 *
 * Nada importante e apagado de verdade. Um lead removido por engano pela
 * secretaria precisa poder voltar, e um agendamento apagado ainda conta pro
 * faturamento do mes. Quando `deletedAt` tem valor, o registro esta na lixeira.
 * Os repositorios filtram `deletedAt IS NULL` por padrao.
 */
export const exclusaoLogica = () => ({
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' })
});

/**
 * A coluna que torna o sistema multi-empresa.
 *
 * ESTA E A DECISAO MAIS IMPORTANTE DO SCHEMA.
 *
 * Toda tabela de dado de negocio carrega `tenant_id`. Hoje existe uma empresa
 * so, e ela parece inutil. Mas no dia que a segunda barbearia entrar, sem esta
 * coluna seria preciso reescrever cada consulta do sistema — e qualquer consulta
 * esquecida vazaria os clientes de uma empresa pra outra.
 *
 * Pagar essa coluna agora custa quase nada. Adicionar depois custa uma reescrita.
 */
export const colunaTenant = () =>
  text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });

/**
 * JSON guardado como texto.
 *
 * SQLite nao tem tipo JSON nativo; o Drizzle serializa e desserializa sozinho
 * com `mode: 'json'`. Use para dados de forma livre (configuracoes, checklists).
 * NAO use para algo que voce vai querer filtrar ou ordenar — isso merece
 * coluna de verdade.
 */
export const jsonTexto = (nome, padrao) =>
  text(nome, { mode: 'json' })
    .notNull()
    .$defaultFn(() => padrao);

/** Dinheiro: sempre inteiro de centavos. Veja `core/money.js`. */
export const centavos = (nome) => integer(nome).notNull().default(0);

/** Instante opcional (pode ser nulo). */
export const instante = (nome) => integer(nome, { mode: 'timestamp_ms' });
