import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import { libsql } from './client.js';

/**
 * Manutencao do SQLite: o arquivo do banco volta a encolher.
 *
 * Sem isto, apagar dados (ou as limpezas de registros antigos) libera as
 * paginas por DENTRO do arquivo, mas o arquivo nunca diminui: o espaco fica
 * reservado para sempre. E o WAL (o diario de escrita) cresce entre um
 * checkpoint e outro.
 *
 *   `auto_vacuum = INCREMENTAL` — o banco passa a poder devolver paginas
 *     livres ao disco quando mandamos (`incremental_vacuum`), sem reescrever o
 *     arquivo inteiro. Num banco que ja existe, a opcao so vale depois de UM
 *     `VACUUM` completo: `ativarAutoVacuumIncremental`, uma vez, no boot.
 *   `optimize` — atualiza as estatisticas que o SQLite usa para escolher
 *     indices (as consultas nao ficam lentas conforme o banco cresce).
 *   `wal_checkpoint(TRUNCATE)` — passa o diario para o banco e zera o arquivo
 *     de WAL.
 *
 * Tudo aqui e rapido (milissegundos num banco de centenas de MB, exceto o
 * VACUUM unico do boot) e roda no relogio do backup automatico, logo depois
 * dele: nunca em paralelo com um backup (ver dados/backups.js).
 *
 * As funcoes recebem o cliente do banco para os testes usarem um temporario.
 */

const valor = async (cliente, pragma) => Number(Object.values((await cliente.execute(`PRAGMA ${pragma}`)).rows[0] ?? {})[0]);

/** Tamanho do banco + WAL no disco (0 se nao for arquivo local). */
function tamanhoNoDisco(url) {
  if (!String(url).startsWith('file:')) return 0;
  const base = resolve(String(url).slice('file:'.length));
  return ['', '-wal'].reduce((t, s) => t + (existsSync(base + s) ? statSync(base + s).size : 0), 0);
}

/**
 * Liga o `auto_vacuum = INCREMENTAL` num banco que ainda esta em NONE — com o
 * `VACUUM` completo que a troca exige. Roda UMA vez por banco (depois o banco
 * ja nasce em INCREMENTAL e a funcao nao faz nada). Chamada no boot, antes de
 * abrir a porta HTTP: o VACUUM trava o banco enquanto roda.
 *
 * @returns {Promise<null | { ms: number, antes: number, depois: number }>}
 */
export async function ativarAutoVacuumIncremental(cliente = libsql, url = env.DATABASE_URL) {
  if ((await valor(cliente, 'auto_vacuum')) !== 0) return null; // 1 = FULL, 2 = INCREMENTAL: ja resolvido
  const inicio = Date.now();
  const antes = tamanhoNoDisco(url);
  await cliente.execute('PRAGMA auto_vacuum = INCREMENTAL');
  await cliente.execute('VACUUM');
  await cliente.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  const r = { ms: Date.now() - inicio, antes, depois: tamanhoNoDisco(url) };
  logger.info(r, 'Banco convertido para auto_vacuum incremental (VACUUM unico)');
  return r;
}

/** Diaria: estatisticas de indice em dia e o WAL zerado. */
export async function manutencaoDiaria(cliente = libsql) {
  const inicio = Date.now();
  await cliente.execute('PRAGMA optimize');
  await cliente.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  return { ms: Date.now() - inicio };
}

/**
 * Semanal (e logo depois de "Apagar dados"): devolve ao disco as paginas que
 * as exclusoes deixaram livres, e zera o WAL para o arquivo encolher de fato.
 *
 * @returns {Promise<{ ms: number, paginasLiberadas: number }>}
 */
export async function devolverEspacoLivre(cliente = libsql) {
  const inicio = Date.now();
  const livres = await valor(cliente, 'freelist_count');
  // executeMultiple, nao execute: o incremental_vacuum libera UMA pagina por
  // passo, e o execute do libsql so da o primeiro — a instrucao ficava aberta
  // e travava a proxima ("database table is locked"). Este roda ate o fim.
  if (livres > 0) await cliente.executeMultiple('PRAGMA incremental_vacuum;');
  await cliente.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  const r = { ms: Date.now() - inicio, paginasLiberadas: livres - (await valor(cliente, 'freelist_count')) };
  if (r.paginasLiberadas > 0) logger.info(r, 'Espaco livre do banco devolvido ao disco');
  return r;
}
