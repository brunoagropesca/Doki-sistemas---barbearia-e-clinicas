import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { env } from '../config/env.js';

/**
 * Restauracao de backup agendada — aplicada no INICIO do sistema, antes de o
 * banco abrir.
 *
 * Este arquivo nao importa o cliente do banco de proposito: ele tem de rodar
 * quando o arquivo do banco ainda esta fechado, e e por isso que `main.js` o
 * importa em PRIMEIRO lugar (no ESM, os imports rodam na ordem em que
 * aparecem).
 */

export const ARQUIVO_RESTAURACAO = 'RESTAURAR.json';
export const ARQUIVO_RESULTADO = 'ULTIMA-RESTAURACAO.json';
/** A lista das fotos/audios de um backup (os arquivos ficam no cofre). */
export const ARQUIVO_MIDIA = 'midia.json';

export function pastaDeBackups() {
  return resolve(env.BACKUP_DIR);
}

/** O cofre: uma copia so de cada foto/audio, para todos os backups (ver dados/backups.js). */
export function pastaDoCofre() {
  return join(pastaDeBackups(), '_midia');
}

/**
 * O arquivo do banco de um backup: `banco.db.gz` (formato atual) ou `banco.db`
 * (backups antigos, ainda nao convertidos). null se nao ha nenhum.
 */
export function arquivoDoBancoNoBackup(pasta) {
  for (const nome of ['banco.db.gz', 'banco.db']) {
    if (existsSync(join(pasta, nome))) return join(pasta, nome);
  }
  return null;
}

/**
 * Devolve as fotos/audios de um backup para a pasta de uploads, SEM apagar os
 * atuais (restaurar o banco nao pode sumir com um arquivo mais novo).
 *   - formato atual: a lista do midia.json, copiada do cofre (so o que falta);
 *   - formato antigo: a pasta `arquivos/` inteira, como sempre foi.
 */
function devolverMidia(pastaDoBackup, pastaUploads) {
  const lista = join(pastaDoBackup, ARQUIVO_MIDIA);
  if (existsSync(lista)) {
    for (const { nome, bytes } of JSON.parse(readFileSync(lista, 'utf8'))) {
      const destino = join(pastaUploads, nome);
      if (existsSync(destino) && statSync(destino).size === bytes) continue;
      const origem = join(pastaDoCofre(), nome);
      if (!existsSync(origem)) continue; // nao some com o resto por causa de um arquivo
      mkdirSync(dirname(destino), { recursive: true });
      copyFileSync(origem, destino);
    }
    return;
  }
  const antiga = join(pastaDoBackup, 'arquivos');
  if (existsSync(antiga)) cpSync(antiga, pastaUploads, { recursive: true, force: true });
}

/**
 * Se ha restauracao agendada, troca o banco (e devolve as fotos/audios do
 * backup, sem apagar os atuais). Sincrono e sem logger: roda antes de tudo.
 * @returns {{id: string}|null}
 */
export function aplicarRestauracaoPendente() {
  const pedidoArq = join(pastaDeBackups(), ARQUIVO_RESTAURACAO);
  if (!existsSync(pedidoArq)) return null;
  if (!env.DATABASE_URL.startsWith('file:')) return null;

  let pedido;
  try {
    pedido = JSON.parse(readFileSync(pedidoArq, 'utf8'));
  } catch {
    rmSync(pedidoArq, { force: true });
    return null;
  }

  const pastaDoBackup = join(pastaDeBackups(), String(pedido.id));
  const origem = arquivoDoBancoNoBackup(pastaDoBackup);
  const destino = resolve(env.DATABASE_URL.slice('file:'.length));
  const resultado = { id: pedido.id, em: new Date().toISOString(), ok: false, erro: null };

  try {
    if (!origem) throw new Error('O arquivo do backup nao existe mais.');
    // Descompacta ANTES de apagar o banco atual: um .gz corrompido falha aqui
    // e o sistema sobe com o banco de antes, em vez de sem banco nenhum.
    const conteudo = origem.endsWith('.gz') ? gunzipSync(readFileSync(origem)) : null;
    // O WAL e o indice compartilhado pertencem ao banco ANTIGO: se ficassem,
    // o SQLite os aplicaria por cima do banco restaurado.
    for (const sufixo of ['', '-wal', '-shm']) rmSync(destino + sufixo, { force: true });
    if (conteudo) writeFileSync(destino, conteudo);
    else copyFileSync(origem, destino);

    devolverMidia(pastaDoBackup, resolve(process.env.PASTA_ARQUIVOS || 'data/uploads'));

    resultado.ok = true;
    console.log(`[restauracao] Backup ${pedido.id} restaurado.`);
  } catch (err) {
    resultado.erro = err.message;
    console.error(`[restauracao] Falhou ao restaurar ${pedido.id}: ${err.message}`);
  } finally {
    // Tentando ou nao, o pedido sai: um pedido quebrado repetido a cada
    // inicio impediria o sistema de subir.
    rmSync(pedidoArq, { force: true });
    writeFileSync(join(pastaDeBackups(), ARQUIVO_RESULTADO), JSON.stringify(resultado, null, 2));
  }
  return resultado;
}

/** O resultado da ultima restauracao, para a pagina mostrar. */
export function ultimaRestauracao() {
  try {
    return JSON.parse(readFileSync(join(pastaDeBackups(), ARQUIVO_RESULTADO), 'utf8'));
  } catch {
    return null;
  }
}
