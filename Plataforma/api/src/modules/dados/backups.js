import { cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { count } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db, libsql } from '../../db/client.js';
import { appointments, conversations, leads, users } from '../../db/schema/index.js';
import { NaoEncontrado, RegraDeNegocio } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { PASTA_ARQUIVOS } from '../equipe/arquivos.js';
import { ARQUIVO_RESTAURACAO, pastaDeBackups } from '../../db/restauracao.js';

const log = comContexto({ modulo: 'backups' });

/**
 * Backups do banco (e, opcionalmente, das fotos e audios).
 *
 * Cada backup e uma pasta em `data/backups/<id>/`:
 *   banco.db   — copia CONSISTENTE do banco, feita com `VACUUM INTO` (o SQLite
 *                gera um arquivo novo a partir de uma leitura so; copiar o
 *                arquivo na mao com o sistema rodando pegaria o banco no meio
 *                de uma escrita);
 *   arquivos/  — copia da pasta de uploads, quando pedida;
 *   info.json  — quando, por que, tamanho e um resumo do que tinha.
 *
 * RESTAURAR nao acontece com o sistema rodando: o banco esta aberto e trocar o
 * arquivo por baixo corromperia tudo. A restauracao e AGENDADA e aplicada no
 * proximo inicio, antes de o banco abrir (ver `db/restauracao.js`).
 */

export const MOTIVOS = {
  manual: 'Feito pelo DEV',
  automatico: 'Automático diário',
  antes_de_apagar: 'Antes de apagar dados',
  antes_de_restaurar: 'Antes de restaurar outro backup'
};

/** Quantos backups AUTOMATICOS guardar. Os outros so saem quando alguem apaga. */
const MANTER_AUTOMATICOS = 14;
const ID_VALIDO = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}_[a-z_]+$/;

function caminhoDoBanco() {
  if (!env.DATABASE_URL.startsWith('file:')) {
    throw new RegraDeNegocio('Backup so funciona com o banco em arquivo local.');
  }
  return resolve(env.DATABASE_URL.slice('file:'.length));
}

function pastaDo(id) {
  // O id vem da URL: sem esta checagem, "../../" sairia da pasta de backups.
  if (!ID_VALIDO.test(String(id))) throw new NaoEncontrado('Backup');
  const pasta = join(pastaDeBackups(), id);
  if (!existsSync(join(pasta, 'banco.db'))) throw new NaoEncontrado('Backup');
  return pasta;
}

function novoId(motivo) {
  const agora = new Date();
  const p = (n, t = 2) => String(n).padStart(t, '0');
  // Hora local da maquina: e o que a pessoa ve no relogio do computador.
  return (
    `${agora.getFullYear()}-${p(agora.getMonth() + 1)}-${p(agora.getDate())}_` +
    `${p(agora.getHours())}-${p(agora.getMinutes())}-${p(agora.getSeconds())}-${p(agora.getMilliseconds(), 3)}_${motivo}`
  );
}

function tamanhoDaPasta(pasta) {
  let total = 0;
  for (const nome of readdirSync(pasta, { withFileTypes: true })) {
    const caminho = join(pasta, nome.name);
    total += nome.isDirectory() ? tamanhoDaPasta(caminho) : statSync(caminho).size;
  }
  return total;
}

async function resumoDoBanco() {
  const conta = async (tabela) => Number((await db.select({ n: count() }).from(tabela))[0]?.n ?? 0);
  return {
    clientes: await conta(leads),
    conversas: await conta(conversations),
    agendamentos: await conta(appointments),
    usuarios: await conta(users)
  };
}

/**
 * Cria um backup agora.
 * @param {object} p
 * @param {keyof MOTIVOS} [p.motivo]
 * @param {boolean} [p.incluirArquivos]  copia tambem fotos e audios
 */
export async function criarBackup({ motivo = 'manual', incluirArquivos = false, por = null } = {}) {
  if (!MOTIVOS[motivo]) throw new RegraDeNegocio('Motivo de backup invalido.');
  caminhoDoBanco();

  const id = novoId(motivo);
  const pasta = join(pastaDeBackups(), id);
  mkdirSync(pasta, { recursive: true });

  try {
    await libsql.execute({ sql: 'VACUUM INTO ?', args: [join(pasta, 'banco.db')] });

    const comArquivos = incluirArquivos && existsSync(PASTA_ARQUIVOS);
    if (comArquivos) cpSync(PASTA_ARQUIVOS, join(pasta, 'arquivos'), { recursive: true });

    const info = {
      id,
      motivo,
      criadoEm: new Date().toISOString(),
      por,
      comArquivos,
      resumo: await resumoDoBanco()
    };
    writeFileSync(join(pasta, 'info.json'), JSON.stringify(info, null, 2));

    log.info({ id, motivo, comArquivos }, 'Backup criado');
    if (motivo === 'automatico') limparAutomaticosAntigos();
    return apresentar(id);
  } catch (err) {
    // Backup pela metade e pior que nenhum: parece que existe e nao restaura.
    rmSync(pasta, { recursive: true, force: true });
    throw err;
  }
}

function apresentar(id) {
  const pasta = join(pastaDeBackups(), id);
  let info = {};
  try {
    info = JSON.parse(readFileSync(join(pasta, 'info.json'), 'utf8'));
  } catch {
    // Backup sem info (copiado a mao para a pasta): mostra o que der.
  }
  return {
    id,
    motivo: info.motivo ?? 'manual',
    motivoTexto: MOTIVOS[info.motivo] ?? 'Backup',
    criadoEm: info.criadoEm ?? statSync(join(pasta, 'banco.db')).mtime.toISOString(),
    por: info.por ?? null,
    comArquivos: Boolean(info.comArquivos),
    resumo: info.resumo ?? null,
    tamanhoBytes: tamanhoDaPasta(pasta)
  };
}

export function listarBackups() {
  const raiz = pastaDeBackups();
  if (!existsSync(raiz)) return [];
  return readdirSync(raiz, { withFileTypes: true })
    .filter((d) => d.isDirectory() && ID_VALIDO.test(d.name) && existsSync(join(raiz, d.name, 'banco.db')))
    .map((d) => apresentar(d.name))
    .sort((a, b) => b.id.localeCompare(a.id));
}

export function apagarBackup(id) {
  const pasta = pastaDo(id);
  if (restauracaoPendente()?.id === id) {
    throw new RegraDeNegocio('Este backup esta agendado para ser restaurado. Cancele a restauracao antes.');
  }
  rmSync(pasta, { recursive: true, force: true });
  return { ok: true };
}

/** O arquivo do banco do backup, para download. */
export function arquivoDoBackup(id) {
  const caminho = join(pastaDo(id), 'banco.db');
  return { stream: createReadStream(caminho), tamanho: statSync(caminho).size, nome: `backup-${id}.db` };
}

function limparAutomaticosAntigos() {
  const automaticos = listarBackups().filter((b) => b.motivo === 'automatico');
  for (const b of automaticos.slice(MANTER_AUTOMATICOS)) {
    rmSync(join(pastaDeBackups(), b.id), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Restauracao (agendada para o proximo inicio)
// ---------------------------------------------------------------------------

export function restauracaoPendente() {
  const arquivo = join(pastaDeBackups(), ARQUIVO_RESTAURACAO);
  if (!existsSync(arquivo)) return null;
  try {
    return JSON.parse(readFileSync(arquivo, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Agenda a restauracao. Antes, guarda o estado ATUAL num backup: restaurar o
 * backup errado precisa ter volta.
 */
export async function agendarRestauracao(id, { por = null } = {}) {
  pastaDo(id);
  const seguranca = await criarBackup({ motivo: 'antes_de_restaurar', incluirArquivos: false, por });
  const pedido = { id, agendadoEm: new Date().toISOString(), por, backupDeSeguranca: seguranca.id };
  writeFileSync(join(pastaDeBackups(), ARQUIVO_RESTAURACAO), JSON.stringify(pedido, null, 2));
  log.warn({ id, seguranca: seguranca.id }, 'Restauracao agendada para o proximo inicio');
  return pedido;
}

export function cancelarRestauracao() {
  rmSync(join(pastaDeBackups(), ARQUIVO_RESTAURACAO), { force: true });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Backup automatico
// ---------------------------------------------------------------------------

const HORAS_ENTRE_AUTOMATICOS = 24;

/**
 * Um backup por dia. Confere de hora em hora (e logo no inicio) se o ultimo
 * automatico tem mais de 24h. Devolve a funcao que para o relogio.
 */
export function iniciarBackupAutomatico() {
  const conferir = async () => {
    try {
      const ultimo = listarBackups().find((b) => b.motivo === 'automatico');
      const idade = ultimo ? Date.now() - new Date(ultimo.criadoEm).getTime() : Infinity;
      if (idade >= HORAS_ENTRE_AUTOMATICOS * 3_600_000) await criarBackup({ motivo: 'automatico', incluirArquivos: true });
    } catch (err) {
      log.warn({ err }, 'Backup automatico falhou');
    }
  };
  const inicio = setTimeout(conferir, 60_000); // deixa o sistema subir primeiro
  const relogio = setInterval(conferir, 3_600_000);
  inicio.unref?.();
  relogio.unref?.();
  return () => {
    clearTimeout(inicio);
    clearInterval(relogio);
  };
}
