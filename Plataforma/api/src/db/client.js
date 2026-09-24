import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import * as schema from './schema/index.js';

/**
 * Conexao com o banco.
 *
 * Usamos libsql, que e SQLite — mesmo formato de arquivo, mesma linguagem.
 * A escolha dele em vez do `better-sqlite3` foi pratica: o libsql distribui
 * binarios prontos, entao instalar nao exige um compilador C++ na maquina.
 *
 * O caminho de crescimento esta embutido: quando o sistema sair da maquina
 * local, basta trocar `DATABASE_URL` de `file:./data/plataforma.db` por uma
 * URL `libsql://...` na nuvem. Nenhuma consulta do sistema muda.
 */

/** Garante que a pasta do arquivo .db existe antes de tentar abrir. */
function garantirPasta(url) {
  if (!url.startsWith('file:')) return;
  const caminho = resolve(url.slice('file:'.length));
  mkdirSync(dirname(caminho), { recursive: true });
}

garantirPasta(env.DATABASE_URL);

export const libsql = createClient({ url: env.DATABASE_URL });

/** O banco de verdade da empresa. Use direto so quando PRECISA ser ele (auth, backups). */
export const dbReal = drizzle(libsql, { schema, logger: false });

/**
 * Banco da requisicao.
 *
 * Quase sempre e o real. A excecao e o MODO DEMONSTRACAO do perfil DEV: as
 * requisicoes daquele navegador rodam dentro de `rodarNoBanco(...)` e todas as
 * consultas do sistema caem num arquivo paralelo (ver modules/demonstracao) —
 * sem nenhum modulo precisar saber disso.
 *
 * O contexto segue a requisicao pelas promessas e timers que ela dispara
 * (AsyncLocalStorage). O que NAO nasce de uma requisicao da demonstracao — o
 * WhatsApp chegando, as rotinas, os backups — nunca ve o banco paralelo.
 */
const contexto = new AsyncLocalStorage();

export const db = new Proxy(
  {},
  {
    get(_, prop) {
      const alvo = contexto.getStore()?.db ?? dbReal;
      const valor = alvo[prop];
      return typeof valor === 'function' ? valor.bind(alvo) : valor;
    }
  }
);

/** Executa `fn` (e tudo o que ela disparar) com outro banco. */
export function rodarNoBanco(loja, fn) {
  return contexto.run(loja, fn);
}

/** Esta execucao e da demonstracao? (envios de WhatsApp viram simulacao) */
export function emDemonstracao() {
  return contexto.getStore()?.demonstracao === true;
}

/**
 * Prepara o banco para uso.
 *
 * Os PRAGMAs abaixo nao sao enfeite — cada um resolve um problema concreto:
 *
 * `foreign_keys = ON`
 *   O SQLite vem com chave estrangeira DESLIGADA por padrao, por compatibilidade
 *   historica. Sem isto, declarar `references()` no schema nao garante nada:
 *   da pra ter agendamento apontando pra um cliente que nao existe mais.
 *
 * `journal_mode = WAL`
 *   Permite que alguem leia a agenda enquanto outra pessoa grava um agendamento.
 *   No modo padrao, uma escrita trava todas as leituras.
 *
 * `busy_timeout = 5000`
 *   Se o banco estiver ocupado, espera ate 5 segundos em vez de falhar na hora.
 *   Sem isto, dois atendentes salvando ao mesmo tempo geram "database is locked".
 */
export async function inicializarBanco() {
  await libsql.execute('PRAGMA foreign_keys = ON');
  await libsql.execute('PRAGMA journal_mode = WAL');
  await libsql.execute('PRAGMA busy_timeout = 5000');
  await libsql.execute('PRAGMA synchronous = NORMAL');

  const [{ foreign_keys: fk }] = (await libsql.execute('PRAGMA foreign_keys')).rows;
  if (Number(fk) !== 1) {
    throw new Error('Nao foi possivel ligar as chaves estrangeiras no SQLite.');
  }

  logger.debug({ url: env.DATABASE_URL }, 'Banco inicializado');
}

/**
 * Fila de escrita.
 *
 * O SQLite aceita UM escritor por vez. Quando duas transacoes tentam gravar
 * ao mesmo tempo, a segunda recebe `SQLITE_BUSY: database is locked`.
 *
 * Isso nao e hipotese: aconteceu nos testes com tres mensagens de WhatsApp
 * chegando na mesma fracao de segundo — exatamente o que acontece quando um
 * cliente escreve "oi" / "tudo bem?" / "queria marcar" em rajada.
 *
 * O `busy_timeout` ajuda, mas so faz a segunda transacao ESPERAR ocupando a
 * linha — e ainda falha se a espera estourar. Serializar aqui, no processo,
 * e mais barato e deterministico: cada transacao entra numa fila e roda
 * quando chegar a vez. Como o banco so tem um escritor mesmo, nao se perde
 * paralelismo nenhum — so se troca "falhar" por "esperar um instante".
 *
 * (Leituras NAO passam por aqui: com WAL ligado, elas acontecem em paralelo
 * com a escrita sem travar.)
 */
let filaDeEscrita = Promise.resolve();

/**
 * Executa varias operacoes como uma unica unidade: ou tudo grava, ou nada grava.
 *
 * Use sempre que uma acao mexer em mais de uma tabela. Exemplo: registrar a
 * venda de um produto e baixar o estoque. Sem transacao, uma falha no meio
 * deixa a venda registrada e o estoque intacto — e o numero na tela nunca
 * mais bate com a prateleira.
 *
 * @param {(tx: typeof db) => Promise<any>} fn
 */
export async function emTransacao(fn) {
  // Encadeia nesta fila. O `.catch` vazio impede que uma transacao que falhou
  // envenene a fila e derrube todas as seguintes.
  const minhaVez = filaDeEscrita.then(
    () => db.transaction(fn),
    () => db.transaction(fn)
  );

  filaDeEscrita = minhaVez.catch(() => {});

  return minhaVez;
}

/** Verificacao de saude, usada pela rota /health. */
export async function bancoSaudavel() {
  try {
    await db.get(sql`SELECT 1 AS ok`);
    return true;
  } catch (err) {
    logger.error({ err }, 'Banco nao respondeu ao health check');
    return false;
  }
}

/** Fecha a conexao — chamado no desligamento ordenado do servidor. */
export function fecharBanco() {
  libsql.close();
}

export { schema };
