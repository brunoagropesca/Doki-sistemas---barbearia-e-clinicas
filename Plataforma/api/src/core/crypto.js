import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual
} from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { ServicoIndisponivel } from './errors.js';

const scryptLivre = promisify(scryptCb);

/**
 * No maximo 2 scrypt ao mesmo tempo.
 *
 * Cada calculo pede ~64 MB de uma vez (e o que torna o scrypt caro para quem
 * ataca). Varios logins/cadastros juntos pediam 64 MB cada, em paralelo, e com
 * a memoria da maquina apertada o OpenSSL falhava ("malloc failure") — visto na
 * suite de testes, e que num pico de logins de verdade aconteceria igual.
 * Com a fila o pico fica em ~128 MB; quem chega depois so espera a vez (cada
 * calculo leva ~100 ms). O custo de seguranca nao muda.
 */
const MAX_SCRYPT_SIMULTANEOS = 2;
let scryptRodando = 0;
let scryptPico = 0;
const scryptEsperando = [];

/** So para os testes: quantos scrypt chegaram a rodar juntos (e zera). */
export function _picoScrypt() {
  const pico = scryptPico;
  scryptPico = 0;
  return pico;
}

async function scrypt(...args) {
  if (scryptRodando >= MAX_SCRYPT_SIMULTANEOS) await new Promise((vez) => scryptEsperando.push(vez));
  scryptRodando++;
  scryptPico = Math.max(scryptPico, scryptRodando);
  try {
    return await scryptLivre(...args);
  } finally {
    scryptRodando--;
    scryptEsperando.shift()?.();
  }
}

/** A falha foi falta de memoria (passageira), e nao hash invalido? */
const faltouMemoria = (err) => /malloc|memory|memoria/i.test(String(err?.message ?? ''));

/**
 * Criptografia da aplicacao.
 *
 * Tudo aqui usa `node:crypto`, que ja vem com o Node. Nenhuma dependencia
 * externa — em codigo de seguranca, cada biblioteca a mais e uma porta a mais.
 */

// ============================================================================
// SENHAS
// ============================================================================

/**
 * Parametros do scrypt.
 *
 * `N` e o custo: 2^16 = 65536 iteracoes. Gastar ~100ms pra conferir uma senha
 * e irrelevante pra quem esta logando (acontece uma vez) e devastador pra quem
 * esta tentando adivinhar (precisa fazer isso bilhoes de vezes).
 *
 * Era exatamente isto que faltava no sistema antigo: ele usava SHA-256, que foi
 * projetado pra ser RAPIDO. Uma placa de video testa bilhoes de SHA-256 por
 * segundo. Contra scrypt com estes parametros, a mesma placa faz algumas
 * milhares — e o scrypt ainda exige muita memoria, o que atrapalha o paralelismo
 * que torna GPU perigosa.
 */
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, tamanhoChave: 64, maxmem: 128 * 2 ** 16 * 8 * 2 };

/**
 * Transforma uma senha no que sera guardado no banco.
 *
 * Formato: `scrypt$<N>$<r>$<p>$<sal em hex>$<hash em hex>`
 *
 * Os parametros vao junto de proposito: quando daqui a alguns anos for preciso
 * aumentar o custo, senhas antigas continuam conferindo com os parametros
 * antigos, e cada usuario e migrado pro custo novo no proximo login.
 *
 * O SAL e aleatorio POR USUARIO. No sistema antigo era um texto fixo no codigo,
 * o que significa que duas pessoas com a senha "123456" tinham hashes identicos —
 * quebrar um quebrava os dois, e uma tabela pre-calculada quebrava todos.
 */
export async function gerarHashSenha(senha) {
  if (typeof senha !== 'string' || senha.length < 8) {
    throw new Error('A senha precisa ter pelo menos 8 caracteres.');
  }
  const sal = randomBytes(16);
  const derivada = await scrypt(senha.normalize('NFKC'), sal, SCRYPT.tamanhoChave, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sal.toString('hex')}$${derivada.toString('hex')}`;
}

/**
 * Confere uma senha contra o hash guardado.
 *
 * A comparacao usa `timingSafeEqual`, que leva o mesmo tempo acertando ou
 * errando. Comparar com `===` vaza informacao: sai mais rapido quando o
 * primeiro caractere ja esta errado, e com medicoes suficientes da pra
 * descobrir o hash caractere por caractere.
 *
 * @returns {Promise<boolean>}
 */
export async function conferirSenha(senha, hashGuardado) {
  if (typeof senha !== 'string' || typeof hashGuardado !== 'string') return false;

  const partes = hashGuardado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;

  const [, n, r, p, salHex, hashHex] = partes;
  const sal = Buffer.from(salHex, 'hex');
  const esperado = Buffer.from(hashHex, 'hex');

  const calcular = () =>
    scrypt(senha.normalize('NFKC'), sal, esperado.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(n) * Number(r) * 2
    });

  let derivada;
  try {
    derivada = await calcular();
  } catch (err) {
    // Hash com parametros quebrados: nao confere, como antes.
    if (!faltouMemoria(err)) return false;
    /**
     * Faltou memoria: isso NAO e senha errada. Antes caia no `return false` e
     * a pessoa lia "Usuario ou senha incorretos" com a senha certa. Tentamos de
     * novo uma vez; se faltar de novo, avisamos que foi o servidor.
     */
    await new Promise((ok) => setTimeout(ok, 150));
    try {
      derivada = await calcular();
    } catch (err2) {
      if (!faltouMemoria(err2)) return false;
      throw new ServicoIndisponivel('Não consegui conferir a senha agora. Tente de novo em alguns segundos.');
    }
  }
  return derivada.length === esperado.length && timingSafeEqual(derivada, esperado);
}

/** True quando o hash foi feito com parametros mais fracos que os atuais. */
export function precisaRehash(hashGuardado) {
  const partes = String(hashGuardado || '').split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return true;
  return Number(partes[1]) < SCRYPT.N;
}

// ============================================================================
// TOKENS DE SESSAO
// ============================================================================

/**
 * Gera um token de sessao.
 *
 * Devolve o par: o token que vai pro navegador do usuario, e o hash dele que
 * vai pro banco. O banco NUNCA guarda o token utilizavel — assim, um vazamento
 * do banco nao entrega sessoes ativas de ninguem.
 *
 * Aqui basta SHA-256 (sem scrypt): o token ja e 256 bits de aleatoriedade pura,
 * nao ha o que adivinhar por forca bruta. O custo alto do scrypt existe pra
 * proteger senhas humanas, que sao curtas e previsiveis.
 */
export function gerarTokenSessao() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

// ============================================================================
// SEGREDOS GUARDADOS (chaves de API dos provedores de IA)
// ============================================================================

/**
 * Deriva a chave de cifragem de um segredo (por padrao, o APP_SECRET).
 *
 * O segredo e parametro para a TROCA de segredo (db/preparar-env.js): ela
 * precisa abrir com o antigo e fechar com o novo no mesmo processo.
 */
function chaveDeCifragem(segredo = env.APP_SECRET) {
  return createHash('sha256').update(`${segredo}:cofre-v1`).digest();
}

/**
 * Cifra um segredo para guardar no banco (AES-256-GCM).
 *
 * GCM e "autenticado": se alguem alterar um byte do texto cifrado no banco,
 * a decifragem falha em vez de devolver lixo silenciosamente.
 *
 * Formato: `v1.<iv>.<tag>.<dados>`, tudo em base64url.
 */
export function cifrar(textoPuro) {
  return cifrarCom(textoPuro, env.APP_SECRET);
}

/** `cifrar` com um segredo explicito (so a troca de segredo usa). */
export function cifrarCom(textoPuro, segredo) {
  if (textoPuro == null || textoPuro === '') return null;

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', chaveDeCifragem(segredo), iv);
  const dados = Buffer.concat([cipher.update(String(textoPuro), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${dados.toString('base64url')}`;
}

/**
 * Decifra um segredo. Devolve null se o dado estiver corrompido ou se o
 * APP_SECRET tiver mudado (caso em que as chaves precisam ser recadastradas).
 */
export function decifrar(valorCifrado) {
  return decifrarCom(valorCifrado, env.APP_SECRET);
}

/** `decifrar` com um segredo explicito (so a troca de segredo usa). */
export function decifrarCom(valorCifrado, segredo) {
  if (!valorCifrado || typeof valorCifrado !== 'string') return null;

  const partes = valorCifrado.split('.');
  if (partes.length !== 4 || partes[0] !== 'v1') return null;

  try {
    const [, ivB64, tagB64, dadosB64] = partes;
    const decipher = createDecipheriv('aes-256-gcm', chaveDeCifragem(segredo), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dadosB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Ultimos 4 caracteres de um segredo, para exibicao segura na tela. */
export function sufixoVisivel(segredo) {
  const s = String(segredo || '');
  return s.length <= 4 ? '****' : s.slice(-4);
}
