import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { dbReal as db, fecharBanco, inicializarBanco } from './client.js';
import { logger } from '../core/logger.js';

/**
 * Aplica as migrations pendentes.
 *
 * O Drizzle mantem uma tabela de controle com o que ja rodou, entao este
 * comando e seguro de repetir: rodar duas vezes seguidas nao aplica nada na
 * segunda. E o mesmo comando serve pra criar o banco do zero numa maquina nova
 * e pra atualizar um banco que ja tem dado de producao.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function rodarMigrations() {
  await inicializarBanco();
  const pasta = resolve(__dirname, 'migrations');
  logger.info({ pasta }, 'Aplicando migrations...');
  await migrate(db, { migrationsFolder: pasta });
  logger.info('Migrations aplicadas.');
}

// Permite rodar direto pelo terminal (`npm run db:migrate`) e tambem
// importar a funcao de dentro dos testes.
// Compara pelo endereco que o proprio Node gera: montar a URL na mao quebrava
// em pasta com espaco no nome (o Node escreve %20) e o script nao rodava.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await rodarMigrations();
    console.log('Banco atualizado com sucesso.');
  } catch (err) {
    console.error('Falha ao aplicar migrations:', err);
    process.exitCode = 1;
  } finally {
    fecharBanco();
  }
}
