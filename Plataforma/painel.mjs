/**
 * Liga o sistema inteiro NUMA janela so: a API (servidor) e as telas (Vite).
 *
 * Antes eram tres janelas pretas (o instalador, o servidor e as telas), cada
 * uma com um pedaco da historia. Aqui os dois processos rodam como filhos deste
 * e a saida dos dois cai no mesmo terminal:
 *
 *   - a API narra cada acao (ver api/src/core/painel.js): mensagem que chegou,
 *     modelo da cascata que respondeu, Sofia falando com a Atena...
 *   - as telas aparecem com a etiqueta TELAS, e so o que interessa: o endereco
 *     e os erros. O ruido do Vite (banner, "press h") fica de fora.
 *
 * Sem dependencias: so o que ja vem com o Node.
 *
 * Uso:   node painel.mjs [--sem-navegador] [--rede]
 * Ctrl+C desliga os dois, com o desligamento ordenado da API.
 *
 * ACESSO PELA REDE LOCAL (--rede, ou ACESSO_REDE=1 — e o que o
 * INICIAR-NA-REDE.bat faz): so as TELAS passam a aceitar conexao de outros
 * aparelhos do mesmo Wi-Fi. A API continua presa em 127.0.0.1: quem fala com
 * ela e o proxy do Vite, nesta maquina. Assim o celular ve um endereco so
 * (sem CORS, cookie de sessao funcionando) e a API nunca fica exposta direto.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = dirname(fileURLToPath(import.meta.url));
const PASTA_API = join(RAIZ, 'api');
const PASTA_WEB = join(RAIZ, 'web');
const VITE = join(PASTA_WEB, 'node_modules', 'vite', 'bin', 'vite.js');

const PORTA_API = Number(process.env.PORT) || 3333;
const PORTA_TELAS = Number(process.env.VITE_PORT) || 5173;
const ENDERECO = `http://localhost:${PORTA_TELAS}`;
const abrirNavegador = !process.argv.includes('--sem-navegador');
const naRede = process.argv.includes('--rede') || process.env.ACESSO_REDE === '1';

/**
 * Enderecos desta maquina na rede local (os que o celular consegue alcancar).
 *
 * Ficam de fora as placas virtuais (WSL, Hyper-V, VirtualBox, VMware): elas
 * tem IP, mas nenhum aparelho do Wi-Fi chega nelas — mostrar confundiria.
 */
function enderecosNaRede() {
  const virtual = /vethernet|virtualbox|vmware|wsl|hyper-v|loopback|bluetooth|tailscale|zerotier/i;
  const lista = [];
  for (const [nome, ifaces] of Object.entries(networkInterfaces())) {
    if (virtual.test(nome)) continue;
    for (const i of ifaces ?? []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      lista.push({ nome, url: `http://${i.address}:${PORTA_TELAS}` });
    }
  }
  // Os tipicos de Wi-Fi de casa/escritorio primeiro.
  return lista.sort((a, b) => Number(!a.url.includes('//192.168.')) - Number(!b.url.includes('//192.168.')));
}

/**
 * QR Code no terminal, para abrir no celular apontando a camera.
 * Usa o `qrcode` que a API ja tem instalado; se nao der, so o endereco basta.
 */
async function qrNoTerminal(url) {
  try {
    const caminho = join(PASTA_API, 'node_modules', 'qrcode', 'lib', 'index.js');
    const qrcode = (await import(pathToFileURL(caminho).href)).default;
    return await qrcode.toString(url, { type: 'terminal', small: true });
  } catch {
    return null;
  }
}

// --- Aparencia (a mesma etiqueta colorida da API) -------------------------

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const cinza = (t) => `${ESC}90m${t}${RESET}`;
const negrito = (t) => `${ESC}1m${t}${RESET}`;
const fg = (n, t) => `${ESC}38;5;${n}m${t}${RESET}`;
const etiqueta = (rotulo, cor) => `${ESC}48;5;${cor}m${ESC}38;5;16m ${rotulo.padEnd(8)} ${RESET}`;
const hora = () => new Date().toLocaleTimeString('pt-BR', { hour12: false });

const SISTEMA = etiqueta('SISTEMA', 45);
const TELAS = etiqueta('TELAS', 81);
const ERRO = etiqueta('ERRO', 196);

function linha(rotulo, texto, detalhe) {
  process.stdout.write(`${cinza(hora())} ${rotulo} ${texto}${detalhe ? `  ${cinza(detalhe)}` : ''}\n`);
}

// --- Utilidades ------------------------------------------------------------

/** Entrega a saida de um processo linha a linha (um pedaco pode chegar cortado no meio). */
function porLinha(fluxo, aoReceber) {
  let resto = '';
  fluxo.setEncoding('utf8');
  fluxo.on('data', (pedaco) => {
    resto += pedaco;
    const linhas = resto.split(/\r?\n/);
    resto = linhas.pop();
    linhas.forEach(aoReceber);
  });
  fluxo.on('end', () => {
    if (resto) aoReceber(resto);
  });
}

const semCor = (t) => t.replace(/\x1b\[[0-9;]*m/g, '');

/** A porta esta aceitando conexao? E assim que sabemos que o servidor subiu de verdade. */
function portaAberta(porta) {
  return new Promise((resolve) => {
    // "localhost" e nao 127.0.0.1: o Vite escuta em IPv6 (::1) e a API em IPv4.
    // O Node tenta os dois enderecos, entao a mesma conferencia serve aos dois.
    const s = createConnection({ port: porta, host: 'localhost' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => (s.destroy(), resolve(false)));
  });
}

function abrirNoNavegador(url) {
  // Este lancador e feito para o INICIAR.bat (Windows). `start` e um comando
  // do cmd, nao um programa: por isso passa por ele. Em outro sistema, so
  // avisamos o endereco — abrir o navegador sozinho fica por conta da pessoa.
  if (process.platform !== 'win32') return;
  spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
}

// --- Conferencias antes de subir ------------------------------------------

if (!existsSync(join(PASTA_API, 'node_modules')) || !existsSync(VITE)) {
  linha(ERRO, 'As dependencias nao estao instaladas.', 'rode o INICIAR.bat, que instala tudo');
  process.exit(1);
}

process.stdout.write('\n');
linha(SISTEMA, negrito('Ligando a plataforma...'), 'Ctrl+C desliga tudo');

// --- Processos filhos ------------------------------------------------------

const ambiente = { ...process.env, FORCE_COLOR: '1' };

/**
 * A API, religada sozinha quando cai.
 *
 * O `--watch` reinicia quando um arquivo do codigo muda, mas quando o PROCESSO
 * morre (erro fatal: a API encerra de proposito, ver api/src/main.js) ele so
 * escreve "Failed running ... Waiting for file changes" e fica esperando — o
 * sistema parava ate alguem mexer num arquivo ou fechar e abrir de novo. Foi o
 * que aconteceu ao enviar um audio. Aqui o painel le essa linha e sobe uma API
 * nova. Com teto: caindo toda hora (ex.: configuracao invalida no .env), para
 * de insistir e avisa, em vez de girar em ciclo.
 */
const MAX_RELIGACOES = 5;
const JANELA_RELIGACOES_MS = 5 * 60_000;
const religacoes = [];
let api = null;
let religando = false;

function ligarApi() {
  const filho = spawn(process.execPath, ['--env-file-if-exists=.env', '--watch', 'src/main.js'], {
    cwd: PASTA_API,
    env: ambiente,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  api = filho;
  vivos.add(filho);
  // A API ja sai formatada (etiquetas proprias): passa direto.
  const repassar = (l) => {
    process.stdout.write(`${l}\n`);
    if (/^(Completed|Failed) running /.test(semCor(l).trim())) aoCairApi(filho);
  };
  porLinha(filho.stdout, repassar);
  porLinha(filho.stderr, repassar);
  vigiar('API', filho);
  return filho;
}

function aoCairApi(filho) {
  if (desligando || religando || filho !== api) return;
  const agora = Date.now();
  while (religacoes.length && agora - religacoes[0] > JANELA_RELIGACOES_MS) religacoes.shift();
  if (religacoes.length >= MAX_RELIGACOES) {
    linha(ERRO, `A API caiu ${MAX_RELIGACOES} vezes em poucos minutos e nao sera religada de novo.`, 'veja o erro acima e api/data/logs/falhas.log; depois feche e abra o INICIAR.bat');
    return;
  }
  religacoes.push(agora);
  religando = true;
  linha(ERRO, 'A API caiu. Religando em 2 segundos...', 'o motivo fica em api/data/logs/falhas.log');
  setTimeout(() => {
    matarArvore(filho);
    vivos.delete(filho);
    religando = false;
    if (!desligando) ligarApi();
  }, 2000);
}

const web = spawn(process.execPath, [VITE, '--clearScreen', 'false', ...(naRede ? ['--host', '0.0.0.0'] : [])], {
  cwd: PASTA_WEB,
  env: ambiente,
  stdio: ['ignore', 'pipe', 'pipe']
});

/** Das telas, so o que importa. O resto do Vite e propaganda dele mesmo. */
function linhaDasTelas(bruta) {
  const l = semCor(bruta).trim();
  if (!l) return;
  if (/ready in/i.test(l)) return linha(TELAS, 'servidor das telas pronto', l.replace(/.*ready in\s*/i, 'em '));
  if (/Local:/i.test(l)) return linha(TELAS, negrito(l.replace(/.*Local:\s*/i, '')));
  if (/Network:|press h|VITE v/i.test(l)) return;
  if (/hmr update|page reload|hmr invalidate/i.test(l)) return linha(TELAS, cinza(l.replace(/^\d{1,2}:\d{2}:\d{2}\s*/, '')));
  if (/error|failed|cannot|unexpected/i.test(l)) return linha(ERRO, fg(196, l), 'telas');
  linha(TELAS, cinza(l));
}
porLinha(web.stdout, linhaDasTelas);
porLinha(web.stderr, linhaDasTelas);

/** Os enderecos para os outros aparelhos do Wi-Fi, com QR Code do principal. */
async function mostrarAcessoPelaRede() {
  const enderecos = enderecosNaRede();
  if (enderecos.length === 0) {
    linha(ERRO, 'Acesso pela rede ligado, mas este computador nao esta em nenhuma rede.', 'conecte ao Wi-Fi e reinicie');
    return;
  }
  linha(SISTEMA, negrito('Acesso pela rede local ligado.'), 'celulares e computadores do MESMO Wi-Fi');
  for (const e of enderecos) linha(SISTEMA, `   ${fg(45, e.url)}`, e.nome);

  const qr = await qrNoTerminal(enderecos[0].url);
  if (qr) {
    linha(SISTEMA, 'Aponte a camera do celular:');
    process.stdout.write(`${qr}\n`);
  }
  linha(SISTEMA, cinza('Nao abriu no celular? Veja se o Wi-Fi esta como rede PRIVADA no Windows e se o firewall liberou a porta.'));
}

// --- Navegador: so quando os dois responderem -----------------------------

(async () => {
  for (let i = 0; i < 120; i++) {
    if ((await portaAberta(PORTA_API)) && (await portaAberta(PORTA_TELAS))) {
      linha(SISTEMA, `${fg(46, '✓')} ${negrito('Sistema no ar')}  ${fg(45, ENDERECO)}`, 'login de demonstracao: dono / trocar@123');
      if (naRede) await mostrarAcessoPelaRede();
      if (abrirNavegador) abrirNoNavegador(ENDERECO);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  linha(ERRO, 'O sistema demorou mais de um minuto para responder.', 'confira as mensagens acima');
})();

// --- Desligamento ----------------------------------------------------------

let desligando = false;
const vivos = new Set([web]);

function matarArvore(filho) {
  // taskkill /T leva junto os netos (o --watch cria um processo dentro do outro).
  if (filho.pid) spawnSync('taskkill', ['/pid', String(filho.pid), '/T', '/F'], { stdio: 'ignore' });
}

function desligar() {
  if (desligando) return;
  desligando = true;
  linha(SISTEMA, 'Desligando...', 'aguardando o servidor fechar o banco com seguranca');

  // O Ctrl+C ja chegou aos filhos (dividem esta janela) e a API faz o
  // desligamento ordenado sozinha. Aqui so esperamos, e derrubamos na marra
  // se travar.
  setTimeout(() => {
    vivos.forEach(matarArvore);
    process.exit(0);
  }, 12_000);
}

function vigiar(nome, filho) {
  filho.on('error', (err) => linha(ERRO, `Nao consegui iniciar ${nome}: ${err.message}`));
  filho.on('exit', (codigo) => {
    vivos.delete(filho);
    // A API derrubada de proposito para religar nao e um erro a anunciar.
    if (!desligando && codigo && !(nome === 'API' && filho !== api)) {
      linha(ERRO, `${nome} encerrou com erro (codigo ${codigo}).`, 'veja as mensagens acima');
    }
    if (desligando && vivos.size === 0) {
      linha(SISTEMA, 'Tudo desligado.');
      process.exit(0);
    }
  });
}

vigiar('telas', web);
ligarApi();

process.on('SIGINT', desligar);
process.on('SIGBREAK', desligar);
process.on('SIGTERM', desligar);
