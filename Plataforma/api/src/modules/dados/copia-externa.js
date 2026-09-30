import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RegraDeNegocio } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { ver } from '../../core/painel.js';
import { pastaDeBackups, pastaDoCofre } from '../../db/restauracao.js';

const log = comContexto({ modulo: 'copia-externa' });

/**
 * Copia dos backups FORA do computador (pendrive, pasta do OneDrive ou do
 * Google Drive).
 *
 * O backup diario mora em `data/backups`, no MESMO disco do sistema: se o HD
 * morre ou o Windows corrompe, original e copia vao juntos. Aqui, depois de
 * cada backup, a pasta de backups e ESPELHADA num lugar que a empresa escolhe:
 *
 *   <pasta escolhida>/Doki-backups/
 *     <id do backup>/   banco.db.gz, midia.json, info.json (como no local)
 *     _midia/           uma copia de cada foto/audio (o cofre)
 *     LEIA-ME.txt       como restaurar a partir daqui
 *
 * Incremental como o cofre: so copia o que falta (mesmo nome e tamanho = ja
 * esta la). Espelho: backup que saiu do local (regra dos 14) sai tambem de la,
 * senao o pendrive enche.
 *
 * Nunca derruba o backup: pasta fora do ar (pendrive desconectado) vira aviso
 * na tela e no painel, e a proxima tentativa e no proximo backup.
 *
 * A configuracao e da INSTALACAO, num arquivo ao lado dos backups — e nao no
 * banco: restaurar um backup antigo nao pode desfazer o caminho escolhido.
 */

const SUBPASTA = 'Doki-backups';
const ID_BACKUP = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}_[a-z_]+$/;

function arquivoDeConfig() {
  return join(pastaDeBackups(), '_copia-externa.json');
}

/** { pasta, ultimaCopiaEm, ultimaTentativaEm, ultimoErro } — tudo opcional. */
export function lerCopiaExterna() {
  try {
    return JSON.parse(readFileSync(arquivoDeConfig(), 'utf8'));
  } catch {
    return {};
  }
}

function gravar(estado) {
  mkdirSync(pastaDeBackups(), { recursive: true });
  writeFileSync(arquivoDeConfig(), JSON.stringify(estado, null, 2));
}

/**
 * A pasta serve? Precisa ser um caminho completo (C:\..., E:\...), existir e
 * aceitar escrita — testado de verdade, gravando e apagando um arquivo.
 *
 * @returns {{ ok: boolean, erro?: string }}
 */
export function testarPasta(pasta) {
  const caminho = String(pasta ?? '').trim();
  if (!caminho) return { ok: false, erro: 'Informe a pasta.' };
  if (!isAbsolute(caminho)) return { ok: false, erro: 'Use o caminho completo da pasta (ex.: E:\\Backups).' };
  if (!existsSync(caminho)) return { ok: false, erro: 'Pasta não encontrada. O pendrive está conectado?' };
  if (!statSync(caminho).isDirectory()) return { ok: false, erro: 'Esse caminho é um arquivo, não uma pasta.' };
  // Nao faz sentido "copia externa" dentro da propria pasta de dados.
  const dados = resolve(pastaDeBackups(), '..');
  if (!relative(dados, resolve(caminho)).startsWith('..') && !isAbsolute(relative(dados, resolve(caminho)))) {
    return { ok: false, erro: 'Escolha uma pasta fora da pasta do sistema (de preferência outro disco, pendrive ou nuvem).' };
  }
  const teste = join(caminho, `.teste-doki-${process.pid}`);
  try {
    writeFileSync(teste, 'ok');
    rmSync(teste, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, erro: `Não foi possível gravar nessa pasta: ${err.code ?? err.message}` };
  }
}

/** Grava (ou tira, com vazio) a pasta. So aceita pasta que passou no teste. */
export function definirPasta(pasta) {
  const caminho = String(pasta ?? '').trim();
  const atual = lerCopiaExterna();
  if (!caminho) {
    gravar({ ...atual, pasta: null, ultimoErro: null });
    return lerCopiaExterna();
  }
  const t = testarPasta(caminho);
  if (!t.ok) throw new RegraDeNegocio(t.erro);
  gravar({ ...atual, pasta: caminho, ultimoErro: null });
  return lerCopiaExterna();
}

/** Arquivos de uma pasta, com nome relativo (com "/") e tamanho. */
function arquivosDe(raiz) {
  if (!existsSync(raiz)) return [];
  const saida = [];
  const andar = (p) => {
    for (const d of readdirSync(p, { withFileTypes: true })) {
      const c = join(p, d.name);
      if (d.isDirectory()) andar(c);
      else saida.push({ nome: relative(raiz, c).split(sep).join('/'), bytes: statSync(c).size });
    }
  };
  andar(raiz);
  return saida;
}

/** Copia `origem`/`nome` para `destino`/`nome` se la nao houver igual. Devolve os bytes copiados. */
function copiarSeFaltar(origem, destino, { nome, bytes }) {
  const alvo = join(destino, nome);
  if (existsSync(alvo) && statSync(alvo).size === bytes) return 0;
  const de = join(origem, nome);
  if (!existsSync(de)) return 0; // saiu do local no meio da copia (limpeza do cofre): fica para a proxima
  mkdirSync(dirname(alvo), { recursive: true });
  copyFileSync(de, alvo);
  return bytes;
}

const LEIA_ME = `Copias de seguranca do sistema de atendimento.

Cada pasta com data e um backup (banco.db.gz = o banco compactado; midia.json =
a lista de fotos e audios daquele dia, que ficam em _midia/).

Para restaurar em outro computador: copie esta pasta inteira para
<sistema>/api/data/backups (a pasta _midia junto) e use Backups > Restaurar.
`;

/**
 * Espelha os backups na pasta externa. Nao lanca: grava o resultado no
 * estado (ultimaCopiaEm ou ultimoErro) e devolve.
 *
 * @returns {{ ok: boolean, bytesCopiados?: number, erro?: string, semPasta?: boolean }}
 */
export function copiarParaExterna({ agora = new Date() } = {}) {
  const estado = lerCopiaExterna();
  if (!estado.pasta) return { ok: false, semPasta: true };

  const teste = testarPasta(estado.pasta);
  if (!teste.ok) {
    gravar({ ...estado, ultimaTentativaEm: agora.toISOString(), ultimoErro: teste.erro });
    ver('aviso', 'cópia externa dos backups não foi feita', teste.erro);
    log.warn({ pasta: estado.pasta, erro: teste.erro }, 'Copia externa dos backups nao foi feita');
    return { ok: false, erro: teste.erro };
  }

  try {
    const destino = join(estado.pasta, SUBPASTA);
    mkdirSync(destino, { recursive: true });
    let bytesCopiados = 0;

    const locais = existsSync(pastaDeBackups())
      ? readdirSync(pastaDeBackups(), { withFileTypes: true }).filter((d) => d.isDirectory() && ID_BACKUP.test(d.name)).map((d) => d.name)
      : [];
    for (const id of locais) {
      for (const arq of arquivosDe(join(pastaDeBackups(), id))) {
        bytesCopiados += copiarSeFaltar(join(pastaDeBackups(), id), join(destino, id), arq);
      }
    }
    for (const arq of arquivosDe(pastaDoCofre())) {
      bytesCopiados += copiarSeFaltar(pastaDoCofre(), join(destino, '_midia'), arq);
    }

    // Espelho: o que saiu do local sai de la (backup e midia que ninguem mais cita).
    const manter = new Set(locais);
    for (const d of readdirSync(destino, { withFileTypes: true })) {
      if (d.isDirectory() && ID_BACKUP.test(d.name) && !manter.has(d.name)) rmSync(join(destino, d.name), { recursive: true, force: true });
    }
    const noCofre = new Set(arquivosDe(pastaDoCofre()).map((a) => a.nome));
    for (const arq of arquivosDe(join(destino, '_midia'))) {
      if (!noCofre.has(arq.nome)) rmSync(join(destino, '_midia', arq.nome), { force: true });
    }
    writeFileSync(join(destino, 'LEIA-ME.txt'), LEIA_ME);

    gravar({ ...estado, ultimaCopiaEm: agora.toISOString(), ultimaTentativaEm: agora.toISOString(), ultimoErro: null });
    if (bytesCopiados) log.info({ bytesCopiados }, 'Backups copiados para a pasta externa');
    return { ok: true, bytesCopiados };
  } catch (err) {
    const erro = `Falha ao copiar: ${err.code ?? err.message}`;
    gravar({ ...estado, ultimaTentativaEm: agora.toISOString(), ultimoErro: erro });
    ver('aviso', 'cópia externa dos backups falhou', erro);
    log.warn({ err }, 'Copia externa dos backups falhou');
    return { ok: false, erro };
  }
}

/**
 * Pede uma copia em segundo plano (depois de cada backup). Uma de cada vez:
 * se ja tem uma rodando, marca para rodar de novo quando ela terminar.
 */
let rodando = null;
let deNovo = false;
/**
 * Espera a copia em andamento terminar. Para scripts que fazem backup e depois
 * encerram o processo (ex.: db/preparar-env.js): sair no meio deixaria uma copia
 * pela metade no pendrive/nuvem.
 */
export async function aguardarCopiaExterna() {
  while (rodando) await rodando;
}

export function agendarCopiaExterna() {
  if (!lerCopiaExterna().pasta) return;
  if (rodando) {
    deNovo = true;
    return;
  }
  rodando = new Promise((resolver) => setImmediate(resolver))
    .then(() => copiarParaExterna())
    .catch((err) => log.warn({ err }, 'Copia externa falhou'))
    .finally(() => {
      rodando = null;
      if (deNovo) {
        deNovo = false;
        agendarCopiaExterna();
      }
    });
}
