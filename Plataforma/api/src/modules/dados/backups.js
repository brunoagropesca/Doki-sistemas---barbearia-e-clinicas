import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { count } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db, libsql } from '../../db/client.js';
import { appointments, conversations, leads, tenants, users } from '../../db/schema/index.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import { limparOrfaosSeForHora } from './orfaos.js';
import { devolverEspacoLivre, manutencaoDiaria } from '../../db/manutencao.js';
import { compactarRastrosAntigos } from '../conversas/rastro.js';
import { aplicarRetencao } from './retencao.js';
import { agendarCopiaExterna } from './copia-externa.js';
import { NaoEncontrado, RegraDeNegocio } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { PASTA_ARQUIVOS } from '../equipe/arquivos.js';
import {
  ARQUIVO_MIDIA,
  ARQUIVO_RESTAURACAO,
  arquivoDoBancoNoBackup,
  pastaDeBackups,
  pastaDoCofre
} from '../../db/restauracao.js';

const log = comContexto({ modulo: 'backups' });

/**
 * Backups do banco (e, opcionalmente, das fotos e audios).
 *
 * Cada backup e uma pasta em `data/backups/<id>/`:
 *   banco.db.gz — copia CONSISTENTE do banco, feita com `VACUUM INTO` (o SQLite
 *                 gera um arquivo novo a partir de uma leitura so; copiar o
 *                 arquivo na mao com o sistema rodando pegaria o banco no meio
 *                 de uma escrita) e compactada (SQLite encolhe ~70-80%);
 *   midia.json  — a LISTA das fotos e audios que existiam naquele momento,
 *                 quando pedida;
 *   info.json   — quando, por que, tamanho e um resumo do que tinha.
 *
 * As fotos e audios em si ficam UMA vez so no cofre `data/backups/_midia/`.
 * Antes cada backup copiava a pasta de uploads inteira: guardando 14, cada
 * arquivo existia ate 15 vezes (8,4 MB de backup para 1,9 MB de midia; numa
 * barbearia movimentada, ~14 GB em um ano). Da para copiar uma vez porque um
 * upload nunca muda depois de gravado — o nome tem UUID, e trocar a foto gera
 * um arquivo novo. Backups antigos (com a pasta `arquivos/` e `banco.db`)
 * continuam restaurando, e o boot os converte (`migrarBackupsAntigos`).
 *
 * RESTAURAR nao acontece com o sistema rodando: o banco esta aberto e trocar o
 * arquivo por baixo corromperia tudo. A restauracao e AGENDADA e aplicada no
 * proximo inicio, antes de o banco abrir (ver `db/restauracao.js`).
 */

export const MOTIVOS = {
  // Antes "Feito pelo DEV": agora o dono tambem faz backup (Backups, no menu).
  manual: 'Feito manualmente',
  automatico: 'Automático diário',
  antes_de_apagar: 'Antes de apagar dados',
  antes_de_restaurar: 'Antes de restaurar outro backup',
  antes_de_exportar_demo: 'Antes de trazer os dados da demonstração',
  antes_de_trocar_segredo: 'Antes de trocar o segredo da instalação'
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
  if (!arquivoDoBancoNoBackup(pasta)) throw new NaoEncontrado('Backup');
  return pasta;
}

// ---------------------------------------------------------------------------
// Cofre de midia (uma copia de cada foto/audio para todos os backups)
// ---------------------------------------------------------------------------

/**
 * Todos os arquivos de uma pasta, com o caminho RELATIVO a ela (com "/") e o
 * tamanho. Hoje os uploads ficam soltos numa pasta so; o relativo cobre uma
 * subpasta futura sem mudar o formato do midia.json.
 */
function listarArquivos(raiz) {
  if (!existsSync(raiz)) return [];
  const saida = [];
  const andar = (pasta) => {
    for (const d of readdirSync(pasta, { withFileTypes: true })) {
      const caminho = join(pasta, d.name);
      if (d.isDirectory()) andar(caminho);
      else saida.push({ nome: relative(raiz, caminho).split(sep).join('/'), bytes: statSync(caminho).size });
    }
  };
  andar(raiz);
  return saida;
}

/** Mesmo nome e mesmo tamanho = e o mesmo arquivo (upload nunca muda). */
function jaNoCofre({ nome, bytes }) {
  const alvo = join(pastaDoCofre(), nome);
  return existsSync(alvo) && statSync(alvo).size === bytes;
}

/** Copia para o cofre so o que ainda nao esta la. Devolve a lista (o midia.json). */
function guardarMidiaNoCofre() {
  const lista = listarArquivos(PASTA_ARQUIVOS);
  for (const item of lista) {
    if (jaNoCofre(item)) continue;
    const destino = join(pastaDoCofre(), item.nome);
    mkdirSync(dirname(destino), { recursive: true });
    copyFileSync(join(PASTA_ARQUIVOS, item.nome), destino);
  }
  return lista;
}

function lerMidiaDoBackup(pasta) {
  try {
    return JSON.parse(readFileSync(join(pasta, ARQUIVO_MIDIA), 'utf8'));
  } catch {
    return null;
  }
}

/** Pastas de backup validas (as que tem banco), sem o cofre e o pedido de restauracao. */
function pastasDeBackup() {
  const raiz = pastaDeBackups();
  if (!existsSync(raiz)) return [];
  return readdirSync(raiz, { withFileTypes: true })
    .filter((d) => d.isDirectory() && ID_VALIDO.test(d.name) && arquivoDoBancoNoBackup(join(raiz, d.name)))
    .map((d) => d.name);
}

/** Quantos backups citam cada arquivo do cofre. */
function referenciasDoCofre() {
  const vezes = new Map();
  for (const id of pastasDeBackup()) {
    for (const { nome } of lerMidiaDoBackup(join(pastaDeBackups(), id)) ?? []) vezes.set(nome, (vezes.get(nome) ?? 0) + 1);
  }
  return vezes;
}

/**
 * Tira do cofre o que nenhum backup cita E que ja nao esta nos uploads.
 *
 * O "ja nao esta nos uploads" e a folga: um arquivo que existe agora vai ser
 * citado pelo proximo backup, e nao ha por que apagar e copiar de novo.
 * Roda depois que um backup sai (a mao ou pela regra dos 14).
 */
function limparCofre() {
  const citados = referenciasDoCofre();
  const noUpload = new Set(listarArquivos(PASTA_ARQUIVOS).map((a) => a.nome));
  let bytes = 0;
  for (const item of listarArquivos(pastaDoCofre())) {
    if (citados.has(item.nome) || noUpload.has(item.nome)) continue;
    rmSync(join(pastaDoCofre(), item.nome), { force: true });
    bytes += item.bytes;
  }
  if (bytes > 0) log.info({ bytes }, 'Cofre de midia: arquivos que nenhum backup cita foram removidos');
  return bytes;
}

/** Tamanho total do cofre (para a tela mostrar). */
export function resumoDoCofre() {
  const arquivos = listarArquivos(pastaDoCofre());
  return { arquivos: arquivos.length, bytes: arquivos.reduce((t, a) => t + a.bytes, 0) };
}

/**
 * Converte os backups do formato antigo (pasta `arquivos/` com a copia inteira
 * dos uploads e `banco.db` solto) para o formato novo: move os arquivos para o
 * cofre (o que ja estiver la e so apagado), grava o midia.json e compacta o
 * banco. Nada se perde: a lista reproduz exatamente o que a pasta tinha.
 * Chamado no boot; nao faz nada quando nao ha backup antigo.
 *
 * @returns {Promise<{ convertidos: number, bytesLiberados: number }>}
 */
export async function migrarBackupsAntigos() {
  let convertidos = 0;
  let bytesLiberados = 0;
  for (const id of pastasDeBackup()) {
    const pasta = join(pastaDeBackups(), id);
    const antiga = join(pasta, 'arquivos');
    const bancoSolto = join(pasta, 'banco.db');
    if (!existsSync(antiga) && !existsSync(bancoSolto)) continue;

    const antes = tamanhoDaPasta(pasta);
    if (existsSync(antiga)) {
      const lista = listarArquivos(antiga);
      for (const item of lista) {
        const origem = join(antiga, item.nome);
        if (!jaNoCofre(item)) {
          const destino = join(pastaDoCofre(), item.nome);
          mkdirSync(dirname(destino), { recursive: true });
          renameSync(origem, destino);
        }
      }
      writeFileSync(join(pasta, ARQUIVO_MIDIA), JSON.stringify(lista));
      rmSync(antiga, { recursive: true, force: true });
    }
    if (existsSync(bancoSolto)) await compactarBanco(bancoSolto);
    bytesLiberados += Math.max(0, antes - tamanhoDaPasta(pasta));
    convertidos += 1;
  }
  if (convertidos > 0) log.info({ convertidos, bytesLiberados }, 'Backups antigos convertidos para o cofre de midia');
  return { convertidos, bytesLiberados };
}

/** banco.db -> banco.db.gz (e apaga o .db). Stream: nao carrega o banco inteiro na memoria. */
async function compactarBanco(caminhoDb) {
  await pipeline(createReadStream(caminhoDb), createGzip({ level: 9 }), createWriteStream(`${caminhoDb}.gz`));
  rmSync(caminhoDb, { force: true });
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
    const copia = join(pasta, 'banco.db');
    await libsql.execute({ sql: 'VACUUM INTO ?', args: [copia] });
    await compactarBanco(copia);

    // Fotos e audios: so a LISTA fica no backup; o arquivo vai uma vez so para o cofre.
    const comArquivos = incluirArquivos && existsSync(PASTA_ARQUIVOS);
    if (comArquivos) writeFileSync(join(pasta, ARQUIVO_MIDIA), JSON.stringify(guardarMidiaNoCofre()));

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
    // Copia fora do computador (pendrive/nuvem), em segundo plano: o backup ja
    // esta pronto e a copia nunca o derruba (ver copia-externa.js).
    agendarCopiaExterna();
    return apresentar(id);
  } catch (err) {
    // Backup pela metade e pior que nenhum: parece que existe e nao restaura.
    rmSync(pasta, { recursive: true, force: true });
    throw err;
  }
}

/**
 * @param {Map<string, number>} [referencias]  quantos backups citam cada arquivo
 *   do cofre (calculado uma vez por listagem)
 */
function apresentar(id, referencias = referenciasDoCofre()) {
  const pasta = join(pastaDeBackups(), id);
  let info = {};
  try {
    info = JSON.parse(readFileSync(join(pasta, 'info.json'), 'utf8'));
  } catch {
    // Backup sem info (copiado a mao para a pasta): mostra o que der.
  }
  // O tamanho de um backup e o que ELE ocupa: a pasta dele + as midias do
  // cofre que so ele cita (as compartilhadas nao somam em cada um, senao a
  // tela mostraria de novo o espaco "15 vezes" que o cofre economizou).
  const exclusivos = (lerMidiaDoBackup(pasta) ?? [])
    .filter((a) => referencias.get(a.nome) === 1)
    .reduce((t, a) => t + a.bytes, 0);
  return {
    id,
    motivo: info.motivo ?? 'manual',
    motivoTexto: MOTIVOS[info.motivo] ?? 'Backup',
    criadoEm: info.criadoEm ?? statSync(arquivoDoBancoNoBackup(pasta)).mtime.toISOString(),
    por: info.por ?? null,
    comArquivos: Boolean(info.comArquivos),
    resumo: info.resumo ?? null,
    tamanhoBytes: tamanhoDaPasta(pasta) + exclusivos
  };
}

export function listarBackups() {
  const referencias = referenciasDoCofre();
  return pastasDeBackup()
    .map((id) => apresentar(id, referencias))
    .sort((a, b) => b.id.localeCompare(a.id));
}

export function apagarBackup(id) {
  const pasta = pastaDo(id);
  if (restauracaoPendente()?.id === id) {
    throw new RegraDeNegocio('Este backup esta agendado para ser restaurado. Cancele a restauracao antes.');
  }
  rmSync(pasta, { recursive: true, force: true });
  limparCofre();
  return { ok: true };
}

/**
 * Apagar pela tela do DONO: so backup MANUAL. O automatico sai sozinho pela
 * regra dos 14, e os de seguranca (antes de apagar dados / de restaurar) sao
 * justamente o caminho de volta de um clique errado.
 */
export function apagarBackupManual(id) {
  const pasta = pastaDo(id);
  let motivo = 'manual';
  try {
    motivo = JSON.parse(readFileSync(join(pasta, 'info.json'), 'utf8')).motivo ?? 'manual';
  } catch {
    // Sem info: trata como manual (foi copiado a mao para a pasta).
  }
  if (motivo !== 'manual') {
    throw new RegraDeNegocio('Só backups feitos manualmente podem ser apagados. Os automáticos e os de segurança saem sozinhos.');
  }
  return apagarBackup(id);
}

/**
 * O banco do backup, para download — sempre o `.db` pronto para abrir. O
 * compactado e descompactado no caminho (tamanho final desconhecido: sem
 * content-length). Backup antigo, ainda com `banco.db`, sai como estava.
 */
export function arquivoDoBackup(id) {
  const caminho = arquivoDoBancoNoBackup(pastaDo(id));
  const nome = `backup-${id}.db`;
  if (!caminho.endsWith('.gz')) return { stream: createReadStream(caminho), tamanho: statSync(caminho).size, nome };
  return { stream: createReadStream(caminho).pipe(createGunzip()), tamanho: null, nome };
}

function limparAutomaticosAntigos() {
  const automaticos = listarBackups().filter((b) => b.motivo === 'automatico');
  const velhos = automaticos.slice(MANTER_AUTOMATICOS);
  for (const b of velhos) rmSync(join(pastaDeBackups(), b.id), { recursive: true, force: true });
  if (velhos.length) limparCofre();
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
 * Quantas linhas a retencao tirou — registrado DEPOIS de expurgar, para esta
 * linha da auditoria nao cair no proprio expurgo.
 */
async function registrarRetencaoNaAuditoria({ ia, auditoria, notificacoes }) {
  if (!ia?.linhasApagadas && !auditoria && !notificacoes) return;
  for (const { id } of await db.select({ id: tenants.id }).from(tenants)) {
    await registrarAuditoria({
      tenantId: id,
      usuario: null,
      acao: 'registros.retencao',
      entidade: 'registros',
      dados: { chamadasIaConsolidadas: ia?.linhasApagadas ?? 0, mesesDeIa: ia?.meses ?? 0, auditoria, notificacoes }
    });
  }
}

/** A pasta de uploads e da instalacao: a limpeza vale para todas as empresas do banco. */
async function registrarLimpezaNaAuditoria({ apagados, bytes }) {
  if (!apagados) return;
  for (const { id } of await db.select({ id: tenants.id }).from(tenants)) {
    await registrarAuditoria({
      tenantId: id,
      usuario: null,
      acao: 'arquivos.limpar_orfaos',
      entidade: 'arquivos',
      dados: { apagados, bytes }
    });
  }
}

/**
 * Um backup por dia. Confere de hora em hora (e logo no inicio) se o ultimo
 * automatico tem mais de 24h. Devolve a funcao que para o relogio.
 */
export function iniciarBackupAutomatico() {
  // Backups do formato antigo viram cofre + lista uma vez, ANTES da primeira
  // conferencia — no mesmo relogio, para nunca correr junto com um backup.
  let migrado = false;
  const conferir = async () => {
    if (!migrado) {
      migrado = true;
      await migrarBackupsAntigos().catch((err) => log.warn({ err }, 'Falha ao converter backups antigos'));
    }
    try {
      const ultimo = listarBackups().find((b) => b.motivo === 'automatico');
      const idade = ultimo ? Date.now() - new Date(ultimo.criadoEm).getTime() : Infinity;
      if (idade >= HORAS_ENTRE_AUTOMATICOS * 3_600_000) {
        await criarBackup({ motivo: 'automatico', incluirArquivos: true });
        // Manutencao diaria do banco, logo DEPOIS do backup (nunca durante).
        await manutencaoDiaria().catch((err) => log.warn({ err }, 'Manutencao diaria do banco falhou'));
      }
    } catch (err) {
      log.warn({ err }, 'Backup automatico falhou');
    }
    // Arquivos orfaos, uma vez por semana, DEPOIS do backup e no mesmo relogio:
    // nunca apaga um arquivo que o backup esta copiando, e o que sai continua
    // no cofre (o backup de agora o citou).
    try {
      const limpou = await limparOrfaosSeForHora({ aoLimpar: registrarLimpezaNaAuditoria });
      if (limpou) {
        // Semanal, junto: o rastro da IA com mais de 90 dias vira resumo, e
        // depois o espaco que a semana liberou volta ao disco (nessa ordem, para
        // o que a compactacao liberou ja sair nesta passada).
        await compactarRastrosAntigos().catch((err) => log.warn({ err }, 'Compactacao do rastro da IA falhou'));
        // Prazo de validade dos registros: uso de IA antigo vira totais do mes,
        // auditoria de mais de 2 anos cheios e notificacoes fechadas saem.
        const retidos = await aplicarRetencao().catch((err) => log.warn({ err }, 'Retencao dos registros falhou'));
        if (retidos) await registrarRetencaoNaAuditoria(retidos);
        await devolverEspacoLivre();
      }
    } catch (err) {
      log.warn({ err }, 'Limpeza semanal (arquivos orfaos e espaco do banco) falhou');
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
