import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { ehSegredoPadrao, SEGREDO_PADRAO } from '../config/segredo-padrao.js';

/**
 * Garante que ESTA instalacao tem um APP_SECRET so dela.
 *
 * Roda pelo INICIAR.bat (`npm run env:preparar`) antes de tudo. Tres casos:
 *   - sem `.env`: cria a partir do `.env.example`, ja com um segredo aleatorio;
 *   - `.env` com o segredo de fabrica (instalacoes feitas antes desta regra):
 *     gera um segredo novo, RECIFRA as chaves de IA guardadas no banco e so
 *     entao grava o `.env`. Se a recifragem falhar, o `.env` fica como estava —
 *     trocar o segredo sem recifrar deixaria as chaves ilegiveis para sempre;
 *   - `.env` com segredo proprio: nao faz nada.
 *
 * ATENCAO a ordem dos imports: este arquivo NAO importa o `config/env.js` (nem
 * nada que o importe) no topo. O `env.js` recusa o segredo de fabrica e
 * derrubaria o processo antes da troca. Por isso o npm script roda SEM
 * `--env-file`, e a configuracao so e montada (com o segredo novo) na hora da
 * recifragem, com import dinamico.
 */

const PASTA_API = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** 32 bytes aleatorios = 64 caracteres hex. */
export const novoSegredo = () => randomBytes(32).toString('hex');

/**
 * O texto do `.env` com a linha APP_SECRET trocada — o resto (comentarios,
 * outras variaveis, fim de linha CRLF/LF) fica exatamente como estava.
 */
export function comSegredo(texto, segredo) {
  const fimDeLinha = texto.includes('\r\n') ? '\r\n' : '\n';
  const linhas = texto.split(/\r?\n/);
  const i = linhas.findIndex((l) => /^\s*APP_SECRET\s*=/.test(l));
  if (i >= 0) {
    linhas[i] = `APP_SECRET=${segredo}`;
  } else {
    // Sem a linha: acrescenta no fim (antes da ultima linha vazia, se houver).
    const fim = linhas.at(-1) === '' ? linhas.length - 1 : linhas.length;
    linhas.splice(fim, 0, `APP_SECRET=${segredo}`);
  }
  return linhas.join(fimDeLinha);
}

/** Grava num temporario e renomeia: queda de energia no meio nao deixa um `.env` pela metade. */
function gravarInteiro(caminho, texto) {
  const temporario = `${caminho}.tmp`;
  writeFileSync(temporario, texto);
  renameSync(temporario, caminho);
}

/**
 * @param {object} p
 * @param {string} [p.pasta]  onde ficam o `.env` e o `.env.example` (padrao: a pasta api)
 * @param {(dados: { valores: Record<string,string>, de: string, para: string }) => Promise<object>} p.recifrar
 * @returns {Promise<{ acao: 'criado' | 'trocado' | 'nada' }>}
 */
export async function prepararEnv({ pasta = PASTA_API, recifrar }) {
  const caminho = join(pasta, '.env');

  if (!existsSync(caminho)) {
    const modelo = readFileSync(join(pasta, '.env.example'), 'utf8');
    gravarInteiro(caminho, comSegredo(modelo, novoSegredo()));
    return { acao: 'criado' };
  }

  const texto = readFileSync(caminho, 'utf8');
  const valores = parseEnv(texto);
  if (!ehSegredoPadrao(valores.APP_SECRET)) return { acao: 'nada' };

  // Sem a linha no .env, o env.js usava o de fabrica: e com ele que o banco foi cifrado.
  const de = valores.APP_SECRET || SEGREDO_PADRAO;

  // A ORDEM protege as chaves:
  //   1. o .env novo vai para `.env.novo` ANTES de mexer no banco — o segredo
  //      novo nunca existe so na memoria;
  //   2. recifra (se falhar, o `.env` fica intacto);
  //   3. troca os arquivos.
  // Uma troca INTERROMPIDA (queda de energia, erro no passo 3) deixa o
  // `.env.novo`: a proxima execucao reaproveita o segredo DELE (nunca sorteia
  // outro) e a recifragem pula o que ja estiver nele. Assim retomar e seguro
  // em qualquer ponto em que tenha parado.
  const pendente = `${caminho}.novo`;
  const interrompido = existsSync(pendente) ? parseEnv(readFileSync(pendente, 'utf8')).APP_SECRET : null;
  const para = interrompido && !ehSegredoPadrao(interrompido) ? interrompido : novoSegredo();

  writeFileSync(pendente, comSegredo(texto, para));
  const resultado = await recifrar({ valores, de, para });
  try {
    renameSync(pendente, caminho);
  } catch (err) {
    throw new Error(
      `As chaves ja foram recifradas, mas o .env nao pode ser trocado (${err.message}). ` +
        `NAO apague o arquivo ".env.novo": feche o que estiver usando o .env e rode o INICIAR.bat de novo.`
    );
  }
  return { acao: 'trocado', ...resultado };
}

/**
 * A recifragem de verdade: backup, chaves passadas para o segredo novo e o
 * banco de demonstracao apagado (ele guarda uma copia das chaves, cifradas com
 * o antigo — e e so gerar de novo).
 */
async function recifrarNoBanco({ valores, de, para }) {
  // O resto do sistema le a configuracao de process.env (via env.js). Monta a
  // partir do .env, sem passar por cima do que ja veio do ambiente, e com o
  // segredo NOVO — e com ele que tudo vai ser cifrado daqui em diante.
  for (const [chave, valor] of Object.entries(valores)) {
    if (process.env[chave] === undefined) process.env[chave] = valor;
  }
  process.env.APP_SECRET = para;

  const { env } = await import('../config/env.js');
  if (env.DATABASE_URL.startsWith('file:') && !existsSync(resolve(env.DATABASE_URL.slice('file:'.length)))) {
    return { recifradas: 0, ilegiveis: 0, semBanco: true };
  }

  const { dbReal, fecharBanco } = await import('./client.js');
  const { criarBackup } = await import('../modules/dados/backups.js');
  const { aguardarCopiaExterna } = await import('../modules/dados/copia-externa.js');
  const { recifrarSegredos } = await import('../modules/dados/trocar-segredo.js');
  const demonstracao = await import('../modules/demonstracao/demonstracao.js');

  try {
    const backup = await criarBackup({ motivo: 'antes_de_trocar_segredo', por: 'Instalação (troca do segredo)' });
    const r = await recifrarSegredos(dbReal, { de, para });

    // Daqui em diante o banco JA esta no segredo novo: nada abaixo pode lancar
    // (senao o .env nao seria trocado e as chaves ficariam ilegiveis).
    try {
      if (demonstracao.existe()) await demonstracao.apagarArquivo();
    } catch {
      // A demonstracao velha so fica sem as chaves de IA; e so gerar de novo.
    }
    await aguardarCopiaExterna().catch(() => {});
    return { ...r, backupId: backup.id };
  } finally {
    try {
      fecharBanco();
    } catch {
      // ja fechado
    }
  }
}

// Linha de comando: `npm run env:preparar` (opcional: --pasta <outra pasta api>, usado nos testes).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--pasta');
  const pasta = i > 0 ? resolve(process.argv[i + 1]) : PASTA_API;
  // Os caminhos relativos do .env (./data/...) sao relativos a pasta api, como no resto do sistema.
  process.chdir(pasta);

  try {
    const r = await prepararEnv({ pasta, recifrar: recifrarNoBanco });
    if (r.acao === 'criado') {
      console.log('        Configuracao criada (.env) com um segredo proprio desta maquina.');
    } else if (r.acao === 'trocado') {
      console.log('        Segredo da instalacao trocado por um proprio desta maquina.');
      if (!r.semBanco) {
        console.log(`        Chaves de IA recifradas: ${r.recifradas}. Backup antes da troca: ${r.backupId}.`);
      }
      if (r.ilegiveis > 0) {
        console.log(`        [AVISO] ${r.ilegiveis} chave(s) ja estavam ilegiveis antes e continuam assim: cadastre de novo em Inteligencia Artificial.`);
      }
    }
    process.exit(0);
  } catch (err) {
    console.error('\n  [ERRO] Nao foi possivel trocar o segredo da instalacao. Nada foi alterado no .env.');
    console.error(`         ${err?.message ?? err}\n`);
    process.exit(1);
  }
}
