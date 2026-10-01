import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { libsql } from '../../db/client.js';
import { comContexto } from '../../core/logger.js';
import { PASTA_ARQUIVOS } from '../equipe/arquivos.js';

const log = comContexto({ modulo: 'arquivos-orfaos' });

/**
 * Arquivos ORFAOS: fotos, audios e anexos em `data/uploads` que nada no banco
 * cita mais.
 *
 * Aparecem quando o registro sai e o arquivo fica — "Apagar dados" parcial,
 * por exemplo, removia o cliente e deixava a foto (havia 3 fotos identicas
 * sem dono no banco real). Arquivo orfao ocupa disco, entra em todo backup e,
 * se era de um cliente que pediu para ser esquecido, vira problema de LGPD.
 *
 * O que CONTA como citado: qualquer texto do banco com `/api/arquivos/<nome>`,
 * em QUALQUER tabela e coluna — colunas de caminho (midia_url, foto_url,
 * avatar), JSON (a logo em settings, metadados de mensagem) e o que vier a
 * existir. Varrer tudo em vez de listar colunas e de proposito: esquecer uma
 * coluna apagaria o arquivo de alguem; varrer demais so guarda um arquivo a
 * mais. Errar para o lado de guardar e sempre o lado seguro.
 *
 * O que NUNCA e tocado: o cofre dos backups (`data/backups/_midia`) — backup
 * existe justamente para ter o que ja saiu. Um orfao apagado aqui continua
 * recuperavel pelo backup que o citava.
 */

/** Carencia: nunca apagar um upload recente (pode estar sendo gravado agora). */
export const CARENCIA_MS = 24 * 3_600_000;

/** De quanto em quanto tempo a limpeza automatica roda. */
const INTERVALO_MS = 7 * 24 * 3_600_000;

export const NOME_NA_URL = /\/api\/arquivos\/([A-Za-z0-9._-]+)/g;

/** Os arquivos da pasta de uploads, com nome relativo (com "/"), tamanho e data. */
function arquivosDosUploads() {
  if (!existsSync(PASTA_ARQUIVOS)) return [];
  const saida = [];
  const andar = (pasta) => {
    for (const d of readdirSync(pasta, { withFileTypes: true })) {
      const caminho = join(pasta, d.name);
      if (d.isDirectory()) andar(caminho);
      else {
        const st = statSync(caminho);
        saida.push({ nome: relative(PASTA_ARQUIVOS, caminho).split(sep).join('/'), caminho, bytes: st.size, modificadoEm: st.mtimeMs });
      }
    }
  };
  andar(PASTA_ARQUIVOS);
  return saida;
}

/**
 * Os nomes de arquivo que o banco cita, em qualquer tabela e coluna de texto.
 *
 * Sempre o banco REAL (`libsql`): o de demonstracao nao usa esta pasta, e a
 * limpeza nao pode depender de quem esta com a demonstracao ligada.
 *
 * @returns {Promise<Set<string>>}
 */
export async function arquivosCitados() {
  const citados = new Set();
  const tabelas = (
    await libsql.execute("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%'")
  ).rows.map((r) => r.name);

  for (const tabela of tabelas) {
    const colunas = (await libsql.execute(`pragma table_info("${tabela}")`)).rows
      // JSON e texto sao guardados como TEXT; coluna sem tipo declarado tambem pode ter texto.
      .filter((c) => /text|char|clob|json|^$/i.test(String(c.type ?? '')))
      .map((c) => c.name);
    for (const coluna of colunas) {
      const linhas = (await libsql.execute(`select "${coluna}" as v from "${tabela}" where "${coluna}" like '%/api/arquivos/%'`)).rows;
      for (const { v } of linhas) for (const m of String(v).matchAll(NOME_NA_URL)) citados.add(m[1]);
    }
  }
  return citados;
}

/**
 * Apaga os arquivos orfaos.
 *
 * @param {object} [p]
 * @param {number} [p.carenciaMs]   arquivo mais novo que isto fica (padrao: 24 h)
 * @param {Set<string>} [p.apenas]  so estes nomes podem sair (limpeza logo apos
 *   "Apagar dados": os arquivos que acabaram de perder o ultimo registro)
 * @returns {Promise<{ apagados: number, bytes: number, nomes: string[] }>}
 */
export async function limparOrfaos({ carenciaMs = CARENCIA_MS, apenas = null, agora = Date.now() } = {}) {
  const citados = await arquivosCitados();
  const nomes = [];
  let bytes = 0;
  for (const a of arquivosDosUploads()) {
    if (citados.has(a.nome)) continue;
    if (apenas && !apenas.has(a.nome)) continue;
    if (agora - a.modificadoEm < carenciaMs) continue;
    rmSync(a.caminho, { force: true });
    nomes.push(a.nome);
    bytes += a.bytes;
  }
  if (nomes.length) log.info({ apagados: nomes.length, bytes }, 'Arquivos orfaos removidos dos uploads');
  return { apagados: nomes.length, bytes, nomes };
}

// ---------------------------------------------------------------------------
// Limpeza semanal
// ---------------------------------------------------------------------------

/** Onde fica a data da ultima limpeza (ao lado da pasta de uploads, fora do banco: a pasta e da instalacao). */
function arquivoDeEstado() {
  return join(dirname(PASTA_ARQUIVOS), 'limpeza-orfaos.json');
}

function lerEstado() {
  try {
    return JSON.parse(readFileSync(arquivoDeEstado(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Roda a limpeza se a ultima foi ha 7 dias ou mais. Chamada pelo relogio do
 * backup automatico (ver dados/backups.js) — o mesmo relogio, para nunca
 * apagar um arquivo que o backup esta copiando naquele instante.
 *
 * Na PRIMEIRA vez so marca a data: a primeira limpeza de verdade acontece 7
 * dias depois de a funcao existir. Assim ligar esta versao nao apaga nada de
 * surpresa — ha uma semana para ver o que seria removido.
 *
 * @param {object} [p]
 * @param {(r: {apagados: number, bytes: number}) => Promise<void>} [p.aoLimpar]  registra na auditoria
 * @returns {Promise<null | { apagados: number, bytes: number, nomes: string[] }>}
 */
export async function limparOrfaosSeForHora({ agora = Date.now(), aoLimpar } = {}) {
  const estado = lerEstado();
  if (!estado?.ultimaEm) {
    writeFileSync(arquivoDeEstado(), JSON.stringify({ ultimaEm: new Date(agora).toISOString(), primeira: true }, null, 2));
    return null;
  }
  if (agora - new Date(estado.ultimaEm).getTime() < INTERVALO_MS) return null;

  const r = await limparOrfaos({ agora });
  writeFileSync(
    arquivoDeEstado(),
    JSON.stringify({ ultimaEm: new Date(agora).toISOString(), apagados: r.apagados, bytes: r.bytes }, null, 2)
  );
  if (aoLimpar) await aoLimpar(r).catch((err) => log.warn({ err }, 'Falha ao registrar a limpeza de orfaos'));
  return r;
}
