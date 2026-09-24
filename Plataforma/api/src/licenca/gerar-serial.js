import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { env } from '../config/env.js';
import { CHAVE_PUBLICA } from './chave-publica.js';

/**
 * Gerador de seriais — roda SO no computador do fornecedor (GERAR-SERIAL.bat).
 *
 * Na primeira vez, cria o par de chaves:
 *   - a PRIVADA vai para `%USERPROFILE%\.doki-licencas\chave-privada.pem`,
 *     fora do projeto (nunca vai para o cliente nem para o git);
 *   - a PUBLICA e escrita em `chave-publica.js`, e vai junto com o sistema.
 *
 * Sem a chave privada neste computador, o gerador se recusa a funcionar — e
 * NAO cria chaves novas se o projeto ja tiver uma publica: senao, o .bat
 * copiado para o cliente criaria um par proprio e o cliente passaria a gerar
 * os seriais dele.
 */

const PASTA_PRIVADA = join(homedir(), '.doki-licencas');
const caminhoPrivada = () => env.LICENCA_CHAVE_PRIVADA || join(PASTA_PRIVADA, 'chave-privada.pem');
const ARQUIVO_PUBLICA = fileURLToPath(new URL('./chave-publica.js', import.meta.url));

function criarChaves() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privada = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publica = publicKey.export({ type: 'spki', format: 'pem' });

  mkdirSync(dirname(caminhoPrivada()), { recursive: true });
  writeFileSync(caminhoPrivada(), privada, { mode: 0o600 });

  const fonte = readFileSync(ARQUIVO_PUBLICA, 'utf8').replace(
    /export const CHAVE_PUBLICA = [^;]*;/,
    `export const CHAVE_PUBLICA = ${JSON.stringify(publica)};`
  );
  writeFileSync(ARQUIVO_PUBLICA, fonte);
  return publica;
}

/** Garante as chaves e devolve a privada. */
export function carregarChavePrivada() {
  if (existsSync(caminhoPrivada())) return createPrivateKey(readFileSync(caminhoPrivada(), 'utf8'));
  if (CHAVE_PUBLICA) {
    throw new Error(
      'A chave privada nao esta neste computador. Os seriais so podem ser gerados no computador do fornecedor ' +
        `(procurei em ${caminhoPrivada()}).`
    );
  }
  criarChaves();
  console.log('\n*** Chaves de licenca criadas pela primeira vez. ***');
  console.log(`Chave PRIVADA: ${caminhoPrivada()}`);
  console.log('  -> FACA UMA COPIA DE SEGURANCA DESTE ARQUIVO (pendrive, nuvem pessoal).');
  console.log('     Se ele for perdido, nao sera possivel renovar a licenca de nenhum cliente.');
  console.log('  -> NUNCA envie este arquivo para cliente nenhum.');
  console.log('Chave PUBLICA gravada em api/src/licenca/chave-publica.js (vai junto com o sistema).');
  console.log('  -> Reinicie o sistema para ele passar a conferir seriais com a chave nova.\n');
  return createPrivateKey(readFileSync(caminhoPrivada(), 'utf8'));
}

/**
 * Gera um serial.
 * @param {object} p
 * @param {string} p.codigo    codigo da instalacao do cliente (XXXX-XXXX-XXXX)
 * @param {string} p.cliente   nome para exibir
 * @param {string|null} p.ate  AAAA-MM-DD; nulo = permanente
 */
export function gerarSerial({ codigo, cliente, ate = null, chavePrivada = carregarChavePrivada() }) {
  const i = String(codigo ?? '').trim().toUpperCase();
  if (!/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(i)) throw new Error('Codigo da instalacao invalido (formato XXXX-XXXX-XXXX).');
  if (!String(cliente ?? '').trim()) throw new Error('Informe o nome do cliente.');
  if (ate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(ate)) throw new Error('Data invalida (use AAAA-MM-DD).');

  const dados = { v: 1, c: String(cliente).trim().slice(0, 80), i, t: ate ? 'mensal' : 'permanente', ate, e: new Date().toISOString().slice(0, 10) };
  const corpo = Buffer.from(JSON.stringify(dados)).toString('base64url');
  const assinatura = sign(null, Buffer.from(corpo), chavePrivada).toString('base64url');
  return { serial: `DOKI-${corpo}.${assinatura}`, dados };
}

// ============================================================================
// Linha de comando
// ============================================================================

function perguntar(texto) {
  return new Promise((resolver) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(texto, (r) => {
      rl.close();
      resolver(r.trim());
    });
  });
}

const argumento = (nome) => process.argv.find((a) => a.startsWith(`--${nome}=`))?.slice(nome.length + 3);

/** "10/11/2026" ou "2026-11-10" -> "2026-11-10". */
function lerData(texto) {
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(texto);
  if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  return texto;
}

/** Padrao do mensal: o mesmo dia no mes seguinte. */
function umMesAFrente() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  // Data LOCAL: toISOString() e UTC e, depois das 21h no Brasil, ja seria o dia seguinte.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function principal() {
  const chave = carregarChavePrivada();
  console.log('\nGerar serial de licenca\n');

  const codigo = argumento('codigo') ?? (await perguntar('Codigo da instalacao do cliente (aparece na tela de licenca dele): '));
  const cliente = argumento('cliente') ?? (await perguntar('Nome do cliente: '));
  let ate;
  if (process.argv.includes('--permanente')) ate = null;
  else if (argumento('ate')) ate = lerData(argumento('ate'));
  else {
    const padrao = umMesAFrente();
    const r = await perguntar(`Valido ate (DD/MM/AAAA), ou P para PERMANENTE [Enter = ${padrao.split('-').reverse().join('/')}]: `);
    ate = /^p(ermanente)?$/i.test(r) ? null : lerData(r || padrao);
  }

  const { serial, dados } = gerarSerial({ codigo, cliente, ate, chavePrivada: chave });

  console.log(`\nCliente: ${dados.c}   Instalacao: ${dados.i}`);
  console.log(dados.t === 'permanente' ? 'Tipo: PERMANENTE (nao vence)' : `Tipo: mensal — valido ate ${dados.ate.split('-').reverse().join('/')} (+5 dias de tolerancia)`);
  console.log('\nSerial (copie a linha inteira e mande ao cliente):\n');
  console.log(serial);
  console.log('');

  // Historico de tudo que foi emitido, junto da chave privada.
  appendFileSync(join(dirname(caminhoPrivada()), 'seriais-emitidos.csv'), `${dados.e};${dados.c};${dados.i};${dados.t};${dados.ate ?? ''};${serial}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await principal();
  } catch (err) {
    console.error(`\nNao foi possivel: ${err.message}\n`);
    process.exitCode = 1;
  }
}
