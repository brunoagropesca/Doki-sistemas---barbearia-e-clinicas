/**
 * Configuracao do drizzle-kit — a ferramenta que compara o schema em
 * `src/db/schema/` com o banco e gera o SQL da diferenca.
 *
 * As migrations geradas ficam em `src/db/migrations/` e sao aplicadas por
 * `npm run db:migrate`. Elas sao versionadas junto com o codigo: assim qualquer
 * maquina consegue reconstruir o banco do zero, na ordem certa.
 */
export default {
  schema: './src/db/schema/index.js',
  out: './src/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'file:./data/plataforma.db'
  },
  verbose: true,
  strict: true
};
