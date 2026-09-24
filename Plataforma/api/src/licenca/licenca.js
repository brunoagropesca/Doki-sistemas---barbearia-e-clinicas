import { createHash, createPublicKey, verify } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cpus, hostname, platform } from 'node:os';
import { env } from '../config/env.js';
import { dataNoFuso, FUSO_PADRAO } from '../core/datetime.js';
import { RegraDeNegocio } from '../core/errors.js';
import { comContexto } from '../core/logger.js';
import { CHAVE_PUBLICA } from './chave-publica.js';

const log = comContexto({ modulo: 'licenca' });

/**
 * Licenca de uso da instalacao.
 *
 * O sistema roda no computador do cliente e so funciona com um SERIAL valido,
 * emitido pelo fornecedor. O serial e um texto ASSINADO (Ed25519) que diz:
 *
 *   c   — nome do cliente (so para exibir);
 *   i   — o codigo DESTA instalacao (serial de um cliente nao serve em outro);
 *   t   — 'mensal' (vale ate a data `ate`) ou 'permanente' (nao vence);
 *   ate — AAAA-MM-DD, ultimo dia de validade (nulo no permanente);
 *   e   — quando foi emitido.
 *
 * So quem tem a chave PRIVADA (o fornecedor) consegue assinar. Mudar uma
 * virgula do serial invalida a assinatura.
 *
 * Linha do tempo de um serial mensal:
 *   ate-7 ....... ate ....... ate+5 .......
 *   ativa | aviso  | tolerancia | BLOQUEADA
 *
 * Voltar o relogio do computador nao adianta: a licenca guarda a data mais
 * recente que ja viu e usa sempre a maior.
 */

export const DIAS_DE_AVISO = 7;
export const DIAS_DE_TOLERANCIA = 5;
const PREFIXO = 'DOKI-';

// ---------------------------------------------------------------------------
// Codigo da instalacao
// ---------------------------------------------------------------------------

/**
 * Identidade da MAQUINA, nao da pasta: copiar o sistema para outro computador
 * muda o codigo, e o serial do primeiro deixa de valer. No Windows e o
 * MachineGuid (criado na instalacao do Windows); reinstalar o Windows gera
 * outro — e o fornecedor emite um serial novo.
 */
function identidadeDaMaquina() {
  try {
    if (platform() === 'win32') {
      const saida = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      });
      const guid = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(saida)?.[1];
      if (guid) return guid;
    }
    for (const caminho of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      if (existsSync(caminho)) return readFileSync(caminho, 'utf8').trim();
    }
  } catch {
    // Cai para o nome da maquina abaixo.
  }
  return `${hostname()}|${platform()}|${cpus()[0]?.model ?? ''}`;
}

/** Dias de `de` ate `ate` (AAAA-MM-DD), COM sinal: negativo = ja passou. */
function diasAte(de, ate) {
  return Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000);
}

let codigoEmCache = null;

/** "A1B2-C3D4-E5F6": o que o cliente le para o fornecedor ao pedir o serial. */
export function codigoDaInstalacao() {
  if (!codigoEmCache) {
    const h = createHash('sha256').update(`doki-instalacao|${identidadeDaMaquina()}`).digest('hex').slice(0, 12).toUpperCase();
    codigoEmCache = `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
  }
  return codigoEmCache;
}

// ---------------------------------------------------------------------------
// Serial
// ---------------------------------------------------------------------------

function chavePublica() {
  const pem = env.LICENCA_CHAVE_PUBLICA || CHAVE_PUBLICA;
  if (!pem) return null;
  try {
    return createPublicKey(pem);
  } catch {
    return null;
  }
}

/**
 * Le e confere um serial. Nunca lanca: devolve `{ ok: false, motivo }`.
 * @returns {{ ok: true, dados: {c: string, i: string, t: string, ate: string|null, e: string} } | { ok: false, motivo: string }}
 */
export function conferirSerial(serial) {
  const limpo = String(serial ?? '').replace(/\s+/g, '');
  if (!limpo.startsWith(PREFIXO)) return { ok: false, motivo: 'Isto nao parece um serial (deve comecar com DOKI-).' };
  const [corpo, assinatura] = limpo.slice(PREFIXO.length).split('.');
  if (!corpo || !assinatura) return { ok: false, motivo: 'Serial incompleto. Copie o texto inteiro.' };

  const chave = chavePublica();
  if (!chave) return { ok: false, motivo: 'Esta instalacao ainda nao tem a chave de licencas configurada.' };

  let valido = false;
  try {
    valido = verify(null, Buffer.from(corpo), chave, Buffer.from(assinatura, 'base64url'));
  } catch {
    valido = false;
  }
  if (!valido) return { ok: false, motivo: 'Serial invalido (assinatura nao confere).' };

  let dados;
  try {
    dados = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, motivo: 'Serial invalido.' };
  }
  if (!['mensal', 'permanente'].includes(dados.t)) return { ok: false, motivo: 'Serial de tipo desconhecido.' };
  if (dados.t === 'mensal' && !/^\d{4}-\d{2}-\d{2}$/.test(dados.ate ?? '')) return { ok: false, motivo: 'Serial sem data de validade.' };
  if (dados.i !== codigoDaInstalacao()) {
    return { ok: false, motivo: `Este serial e de outra instalacao (${dados.i}). O codigo desta e ${codigoDaInstalacao()}.` };
  }
  return { ok: true, dados };
}

// ---------------------------------------------------------------------------
// Estado (guardado num arquivo da instalacao, nao no banco)
// ---------------------------------------------------------------------------

/**
 * Arquivo e nao banco de proposito: restaurar um backup antigo nao pode trazer
 * de volta um serial vencido, nem apagar a "maior data vista".
 */
const arquivo = () => resolve(env.LICENCA_ARQUIVO);

function lerArquivo() {
  try {
    return JSON.parse(readFileSync(arquivo(), 'utf8'));
  } catch {
    return {};
  }
}

function gravarArquivo(dados) {
  mkdirSync(dirname(arquivo()), { recursive: true });
  writeFileSync(arquivo(), JSON.stringify(dados, null, 2));
}

/** Hoje, sem deixar o relogio voltar para tras. */
function hojeProtegido(salvo) {
  const hoje = dataNoFuso(Date.now(), FUSO_PADRAO);
  const maior = salvo.maiorDataVista && salvo.maiorDataVista > hoje ? salvo.maiorDataVista : hoje;
  return { hoje: maior, relogioAtrasado: maior !== hoje };
}

let cache = null; // { em, estado }
const VALIDADE_DO_CACHE_MS = 60_000;

/**
 * O estado da licenca agora.
 * `bloqueada` e o que decide: com ela, a API e o WhatsApp param (o DEV nao).
 */
export function estadoDaLicenca() {
  if (cache && Date.now() - cache.em < VALIDADE_DO_CACHE_MS) return cache.estado;

  const salvo = lerArquivo();
  const { hoje, relogioAtrasado } = hojeProtegido(salvo);
  if (!salvo.maiorDataVista || hoje > salvo.maiorDataVista) gravarArquivo({ ...salvo, maiorDataVista: hoje });

  const base = { codigoInstalacao: codigoDaInstalacao(), exigida: env.LICENCA_EXIGIDA, relogioAtrasado, hoje };
  let estado;

  if (!salvo.serial) {
    estado = { ...base, situacao: 'sem_licenca', bloqueada: true };
  } else {
    const conferido = conferirSerial(salvo.serial);
    if (!conferido.ok) {
      estado = { ...base, situacao: 'invalida', bloqueada: true, motivo: conferido.motivo };
    } else {
      const d = conferido.dados;
      const comum = { ...base, cliente: d.c, tipo: d.t, validoAte: d.ate ?? null, emitidoEm: d.e };
      if (d.t === 'permanente') {
        estado = { ...comum, situacao: 'ativa', bloqueada: false, diasRestantes: null };
      } else {
        const dias = diasAte(hoje, d.ate);
        const trava = dias < -DIAS_DE_TOLERANCIA;
        const situacao = trava ? 'bloqueada' : dias < 0 ? 'tolerancia' : dias <= DIAS_DE_AVISO ? 'aviso' : 'ativa';
        estado = {
          ...comum,
          situacao,
          bloqueada: trava,
          diasRestantes: dias,
          // Dias ate travar de verdade (conta a tolerancia).
          diasParaTravar: dias + DIAS_DE_TOLERANCIA
        };
      }
    }
  }

  // Licenca dispensada (so em testes e desenvolvimento, por configuracao):
  // mostra o estado, mas nunca trava.
  if (!env.LICENCA_EXIGIDA) estado = { ...estado, bloqueada: false };

  cache = { em: Date.now(), estado };
  return estado;
}

export function licencaBloqueada() {
  return estadoDaLicenca().bloqueada;
}

/**
 * Ativa um serial novo (a renovacao do mes, ou o permanente).
 * Recusa serial vencido e serial que vence ANTES do atual — colar o serial
 * antigo por engano nao pode encurtar a licenca de ninguem.
 */
export function ativarSerial(serial, { por = null } = {}) {
  const conferido = conferirSerial(serial);
  if (!conferido.ok) throw new RegraDeNegocio(conferido.motivo);
  const novo = conferido.dados;

  const salvo = lerArquivo();
  const { hoje } = hojeProtegido(salvo);

  if (novo.t === 'mensal') {
    const dias = diasAte(hoje, novo.ate);
    if (dias < -DIAS_DE_TOLERANCIA) throw new RegraDeNegocio(`Este serial ja venceu (${novo.ate}). Peca um serial novo.`);

    const atual = salvo.serial ? conferirSerial(salvo.serial) : null;
    if (atual?.ok && atual.dados.t === 'permanente') {
      throw new RegraDeNegocio('Esta instalacao ja tem licenca permanente. Nao e preciso ativar serial mensal.');
    }
    if (atual?.ok && atual.dados.ate > novo.ate) {
      throw new RegraDeNegocio(`O serial atual vale ate ${atual.dados.ate}; este vence antes (${novo.ate}).`);
    }
  }

  gravarArquivo({ ...salvo, serial: String(serial).replace(/\s+/g, ''), ativadoEm: new Date().toISOString(), ativadoPor: por });
  cache = null;
  log.info({ tipo: novo.t, ate: novo.ate, cliente: novo.c }, 'Licenca ativada');
  return estadoDaLicenca();
}

/** So para testes: esquece o que esta em memoria. */
export function esquecerCacheDaLicenca() {
  cache = null;
}
