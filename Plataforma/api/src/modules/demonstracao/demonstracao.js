import { existsSync, statSync, unlinkSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import * as schema from '../../db/schema/index.js';
import { comContexto } from '../../core/logger.js';

const log = comContexto({ modulo: 'demonstracao' });

/**
 * O libsql, no Windows, so solta o arquivo quando a memoria da conexao ja
 * fechada e recolhida — e o Node recolhe quando quer. Para APAGAR o arquivo
 * na hora, pedimos o recolhimento (gc) explicitamente.
 */
let recolherMemoria = () => {};
try {
  setFlagsFromString('--expose-gc');
  recolherMemoria = runInNewContext('gc');
} catch {
  // Sem o gc sob demanda, as tentativas abaixo dependem do recolhimento normal.
}

/**
 * Banco de DEMONSTRACAO: um arquivo paralelo ao da empresa, com 3 meses de
 * movimento ficticio, para mostrar o sistema a um cliente.
 *
 * So o navegador do DEV que ligar a demonstracao enxerga este banco (ver o
 * plugin de autenticacao); todo o resto continua no real. Excluir apaga o
 * arquivo inteiro do disco.
 */

const PASTA_MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

/** Nome do cookie que liga a demonstracao no navegador do DEV. */
export const COOKIE_DEMONSTRACAO = 'plataforma_demonstracao';

/**
 * O arquivo fica ao lado do banco real, com o nome dele + "-demonstracao"
 * (plataforma.db -> plataforma-demonstracao.db). O banco dos testes, na mesma
 * pasta, ganha o seu proprio (teste-demonstracao.db) e nunca pisa no do DEV.
 */
export function caminhoDoArquivo() {
  if (!env.DATABASE_URL.startsWith('file:')) return null;
  const real = resolve(env.DATABASE_URL.slice('file:'.length));
  return resolve(dirname(real), `${basename(real, extname(real))}-demonstracao.db`);
}

let aberto = null; // { client, db, tenantId }
// A abertura em andamento: duas requisicoes ao mesmo tempo esperam a MESMA
// conexao (senao nasciam duas, uma ficava sem fechar e o arquivo nunca mais
// podia ser apagado no Windows).
let abrindo = null;

export function existe() {
  const c = caminhoDoArquivo();
  return Boolean(c && existsSync(c));
}

/** Abre (e prepara) o banco de demonstracao. Reaproveita a conexao aberta. */
export async function abrir() {
  if (aberto) return aberto;
  abrindo ??= abrirDeVerdade().finally(() => {
    abrindo = null;
  });
  return abrindo;
}

async function abrirDeVerdade() {
  const caminho = caminhoDoArquivo();
  if (!caminho) throw new Error('A demonstracao so funciona com banco em arquivo.');

  const client = createClient({ url: `file:${caminho}` });
  await client.execute('PRAGMA foreign_keys = ON');
  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA busy_timeout = 5000');
  const db = drizzle(client, { schema, logger: false });
  await migrate(db, { migrationsFolder: PASTA_MIGRATIONS });

  const [tenant] = await db.select({ id: schema.tenants.id }).from(schema.tenants).limit(1);
  aberto = { client, db, tenantId: tenant?.id ?? null };
  return aberto;
}

/** Fecha a conexao (antes de apagar ou regerar o arquivo). */
export function fechar() {
  if (!aberto) return;
  try {
    aberto.client.close();
  } catch {
    // ja fechado
  }
  aberto = null;
  espelhados.clear();
}

/**
 * Apaga o arquivo do disco (e os auxiliares do SQLite). Devolve os bytes
 * liberados. No Windows o arquivo pode seguir "ocupado" por um instante
 * depois de fechado: tenta de novo algumas vezes antes de desistir.
 */
export async function apagarArquivo() {
  if (abrindo) await abrindo.catch(() => {});
  fechar();
  const caminho = caminhoDoArquivo();
  let liberados = 0;
  for (const sufixo of ['', '-wal', '-shm', '-journal']) {
    const f = `${caminho}${sufixo}`;
    if (!existsSync(f)) continue;
    const tamanho = statSync(f).size;
    for (let tentativa = 0; ; tentativa++) {
      try {
        unlinkSync(f);
        break;
      } catch (err) {
        if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
        if (tentativa >= 20) throw new Error('O arquivo da demonstração está em uso. Tente de novo em alguns segundos.');
        recolherMemoria();
        await new Promise((ok) => setTimeout(ok, 100));
      }
    }
    liberados += tamanho;
  }
  log.warn({ liberados }, 'Banco de demonstracao apagado');
  return liberados;
}

export function tamanhoEmBytes() {
  const caminho = caminhoDoArquivo();
  return ['', '-wal'].reduce((s, suf) => s + (existsSync(`${caminho}${suf}`) ? statSync(`${caminho}${suf}`).size : 0), 0);
}

/**
 * O DEV entra na demonstracao com o PROPRIO usuario: uma copia dele (mesmo id,
 * cargo dev) na empresa ficticia. Sem a copia, tudo que grava "quem fez"
 * (mensagem enviada, auditoria) quebraria a chave estrangeira.
 */
const espelhados = new Set();

export async function espelharUsuario(usuario) {
  const { db, tenantId } = await abrir();
  if (!tenantId) return null;
  if (espelhados.has(usuario.id)) return tenantId;

  const existente = await db.query.users.findFirst({ where: eq(schema.users.id, usuario.id) });
  if (!existente) {
    await db.insert(schema.users).values({
      id: usuario.id,
      tenantId,
      username: `${usuario.username}.demo`,
      nome: usuario.nome,
      cargo: 'dev',
      // Ninguem entra na demonstracao por senha: so pelo modo do DEV.
      passwordHash: 'demonstracao-sem-login',
      statusPresenca: 'online',
      capacidadeSimultanea: 10,
      ativo: true
    });
  }
  espelhados.add(usuario.id);
  return tenantId;
}
