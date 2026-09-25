import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { env } from '../config/env.js';

/**
 * Registro das quedas do servidor, em arquivo.
 *
 * Quando um erro escapa de tudo, o servidor encerra de proposito (ver main.js)
 * e o painel o religa. O erro, porem, so aparecia no terminal: fechou a janela,
 * a causa sumiu — foi assim que uma queda ao enviar audio ficou sem explicacao.
 * Aqui cada queda vira um bloco em `data/logs/falhas.log`, com a pilha
 * completa, para qualquer pessoa (ou o suporte) ler depois.
 *
 * Tudo SINCRONO e sem lancar: roda dentro do tratador de erro fatal, quando o
 * processo ja esta morrendo — nao ha tempo para promessa, e um erro aqui
 * esconderia o erro que interessa.
 */

/** Um arquivo so, pequeno: passou disso, o antigo vira `.1` (fica o ultimo). */
const TAMANHO_MAXIMO = 1024 * 1024;

/** A pasta de logs fica ao lado do banco (data/ no uso normal). */
export function pastaDeLogs() {
  const banco = env.DATABASE_URL.startsWith('file:') ? env.DATABASE_URL.slice('file:'.length) : './data/x.db';
  return join(dirname(resolve(banco)), 'logs');
}

/** O texto de um erro com as causas encadeadas (`err.cause`), sem repetir. */
function descrever(err, profundidade = 0) {
  if (!err || profundidade > 3) return '';
  const base = err instanceof Error ? err.stack || `${err.name}: ${err.message}` : String(err);
  const causa = err instanceof Error && err.cause ? `\nCausado por: ${descrever(err.cause, profundidade + 1)}` : '';
  return base + causa;
}

/**
 * Grava uma queda. Devolve o caminho do arquivo (ou null se nem isso deu).
 *
 * @param {string} tipo   'uncaughtException' | 'unhandledRejection' | ...
 * @param {unknown} err
 */
export function gravarFalhaFatal(tipo, err, { pasta = pastaDeLogs(), agora = new Date() } = {}) {
  try {
    mkdirSync(pasta, { recursive: true });
    const arquivo = join(pasta, 'falhas.log');
    if (existsSync(arquivo) && statSync(arquivo).size > TAMANHO_MAXIMO) renameSync(arquivo, `${arquivo}.1`);
    appendFileSync(
      arquivo,
      `===== ${agora.toISOString()} · ${tipo} · pid ${process.pid} · node ${process.version}\n${descrever(err)}\n\n`,
      'utf8'
    );
    return arquivo;
  } catch {
    return null;
  }
}

/**
 * A queda mais recente, se aconteceu ha menos de `janelaMs` — o boot usa para
 * avisar no painel "o servidor caiu e foi religado; detalhes em ...".
 *
 * @returns {{ quando: Date, tipo: string, resumo: string, arquivo: string } | null}
 */
export function quedaRecente({ pasta = pastaDeLogs(), janelaMs = 10 * 60_000, agora = Date.now() } = {}) {
  try {
    const arquivo = join(pasta, 'falhas.log');
    if (!existsSync(arquivo)) return null;
    const blocos = readFileSync(arquivo, 'utf8').split(/^===== /m).filter(Boolean);
    const ultimo = blocos.at(-1);
    const [cabecalho, primeiraLinha = ''] = ultimo.split('\n');
    const [iso, tipo] = cabecalho.split(' · ');
    const quando = new Date(iso);
    if (Number.isNaN(quando.getTime()) || agora - quando.getTime() > janelaMs) return null;
    return { quando, tipo, resumo: primeiraLinha.trim(), arquivo };
  } catch {
    return null;
  }
}
