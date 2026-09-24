import { copyFileSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

export function pastaDeBackups() {
  return resolve(env.BACKUP_DIR);
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

  const origem = join(pastaDeBackups(), String(pedido.id), 'banco.db');
  const destino = resolve(env.DATABASE_URL.slice('file:'.length));
  const resultado = { id: pedido.id, em: new Date().toISOString(), ok: false, erro: null };

  try {
    if (!existsSync(origem)) throw new Error('O arquivo do backup nao existe mais.');
    // O WAL e o indice compartilhado pertencem ao banco ANTIGO: se ficassem,
    // o SQLite os aplicaria por cima do banco restaurado.
    for (const sufixo of ['', '-wal', '-shm']) rmSync(destino + sufixo, { force: true });
    copyFileSync(origem, destino);

    const arquivos = join(pastaDeBackups(), String(pedido.id), 'arquivos');
    const pastaUploads = resolve(process.env.PASTA_ARQUIVOS || 'data/uploads');
    if (existsSync(arquivos)) cpSync(arquivos, pastaUploads, { recursive: true, force: true });

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
