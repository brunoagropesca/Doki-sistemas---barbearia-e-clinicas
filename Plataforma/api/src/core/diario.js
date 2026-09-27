import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isTest } from '../config/env.js';
import { pastaDeLogs } from './falhas.js';

/**
 * Diario permanente das conexoes: `data/logs/conexoes.log`.
 *
 * O console de conexoes (channels/eventos.js) fica so na MEMORIA — some a
 * cada reinicio. Foi o que impediu descobrir por que os envios de foto
 * falharam (a conexao caiu? o servidor reiniciou? por que?): nao sobrava
 * rastro. Aqui ficam, uma linha cada, as quedas e voltas da conexao (com o
 * motivo que o WhatsApp deu), cada subida e descida do servidor, e envios
 * lentos ou que falharam.
 *
 * Mesmas regras do console: nunca o conteudo de mensagem de cliente, nem
 * telefone inteiro. Um arquivo so, pequeno: passou de 2 MB, o antigo vira
 * `.1`. Escrita em fila e sem esperar: anotar nunca atrasa nem derruba nada.
 * Os testes nao escrevem (o banco de teste mora na mesma pasta `data/`).
 */

const TAMANHO_MAXIMO = 2 * 1024 * 1024;

let fila = Promise.resolve();

/** Tambem usado nos testes para esperar a escrita. */
export function aguardarDiario() {
  return fila;
}

/**
 * @param {string} texto  a linha (sem data; ela e posta aqui)
 * @param {object} [opcoes]
 * @param {string} [opcoes.pasta]  so para testes
 * @param {boolean} [opcoes.forcar] escreve mesmo em teste (so para testar o proprio diario)
 */
export function anotar(texto, { pasta = null, forcar = false, agora = new Date() } = {}) {
  if (isTest && !forcar) return fila;
  const linha = `${agora.toISOString()} ${String(texto).replace(/\s*\n\s*/g, ' ')}\n`;
  fila = fila
    .then(async () => {
      const destino = pasta ?? pastaDeLogs();
      mkdirSync(destino, { recursive: true });
      const arquivo = join(destino, 'conexoes.log');
      if (existsSync(arquivo) && statSync(arquivo).size > TAMANHO_MAXIMO) renameSync(arquivo, `${arquivo}.1`);
      await appendFile(arquivo, linha, 'utf8');
    })
    .catch(() => {
      // Sem disco ou sem permissao: o diario e ajuda para investigar, nunca
      // motivo para o sistema parar.
    });
  return fila;
}

/** Versao que escreve JA (sincrona): para o desligamento, logo antes do `process.exit`. */
export function anotarAgora(texto, { pasta = null, forcar = false, agora = new Date() } = {}) {
  if (isTest && !forcar) return;
  try {
    const destino = pasta ?? pastaDeLogs();
    mkdirSync(destino, { recursive: true });
    appendFileSync(join(destino, 'conexoes.log'), `${agora.toISOString()} ${String(texto).replace(/\s*\n\s*/g, ' ')}\n`, 'utf8');
  } catch {
    // Idem: nunca atrapalha o desligamento.
  }
}

/**
 * Como terminou o processo anterior, pela ultima marca de SERVIDOR no diario:
 * 'normal' (desligou pelo caminho certo), 'abrupto' (subiu e nunca registrou
 * a descida: fechado a forca, reinicio do --watch, queda) ou null (sem diario).
 */
export function comoTerminouOAnterior({ pasta = null } = {}) {
  try {
    const arquivo = join(pasta ?? pastaDeLogs(), 'conexoes.log');
    if (!existsSync(arquivo)) return null;
    const marcas = readFileSync(arquivo, 'utf8').match(/ SERVIDOR (iniciado|encerrado)/g);
    if (!marcas) return null;
    return marcas.at(-1).endsWith('encerrado') ? 'normal' : 'abrupto';
  } catch {
    return null;
  }
}
