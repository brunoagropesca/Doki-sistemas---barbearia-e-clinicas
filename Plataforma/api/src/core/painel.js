import { env } from '../config/env.js';

/**
 * Painel de atividade: o sistema narrando o que faz, em tempo real, no terminal.
 *
 * Nao substitui o log (`logger.js`). O log e estruturado, para maquina e para
 * producao. Este painel e para a PESSOA que esta olhando a janela: uma linha
 * curta e colorida por acao, com quem fez ("SOFIA", "ATENA", "CASCATA") em
 * destaque, para ler o fluxo de um atendimento de cima a baixo sem decifrar
 * JSON. Quando o painel esta ativo, o log baixa para "warn" (ver logger.js):
 * o que era info aqui vira uma linha colorida em vez de duas linhas iguais.
 *
 * Regras:
 *  - So em desenvolvimento. Em producao e em teste tudo aqui vira no-op.
 *  - Nunca lanca. Um painel que derruba o atendimento seria pior que nenhum.
 *  - Telefone SEMPRE mascarado (quem chama usa `mascarar`). O texto que o
 *    cliente escreveu so aparece com PAINEL_CONTEUDO ligado.
 *  - A conversa entre agentes (Sofia <-> Atena) e o proprio objetivo do painel,
 *    entao nao depende dessa chave.
 */

export const painelAtivo = env.PAINEL_ATIVO && env.NODE_ENV === 'development';

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

export const cinza = (t) => `${ESC}90m${t}${RESET}`;
export const negrito = (t) => `${ESC}1m${t}${RESET}`;
export const fg = (n, t) => `${ESC}38;5;${n}m${t}${RESET}`;

/**
 * Cada ator tem uma cor propria (numero da paleta de 256 cores) e um rotulo
 * de oito letras, para as colunas ficarem alinhadas. A cor do ator e a mesma
 * em todo lugar: bater o olho na cor ja diz quem falou.
 */
const ATORES = {
  sistema: { rotulo: 'SISTEMA', cor: 45 },
  api: { rotulo: 'API', cor: 244 },
  whatsapp: { rotulo: 'WHATSAPP', cor: 41 },
  cliente: { rotulo: 'CLIENTE', cor: 255 },
  menu: { rotulo: 'MENU', cor: 250 },
  humano: { rotulo: 'HUMANO', cor: 39 },
  sofia: { rotulo: 'SOFIA', cor: 213 },
  atena: { rotulo: 'ATENA', cor: 220 },
  aquiles: { rotulo: 'AQUILES', cor: 208 },
  cascata: { rotulo: 'CASCATA', cor: 75 },
  tool: { rotulo: 'TOOL', cor: 37 },
  campanha: { rotulo: 'CAMPANHA', cor: 171 },
  humor: { rotulo: 'HUMOR', cor: 141 },
  aviso: { rotulo: 'AVISO', cor: 214 },
  erro: { rotulo: 'ERRO', cor: 196 }
};

const LARGURA = 8;

/** Rotulo em "etiqueta": fundo colorido, letra escura. */
function etiqueta(ator) {
  const a = ATORES[ator] ?? ATORES.sistema;
  return `${ESC}48;5;${a.cor}m${ESC}38;5;16m ${a.rotulo.padEnd(LARGURA)} ${RESET}`;
}

function hora() {
  return new Date().toLocaleTimeString('pt-BR', { hour12: false });
}

/** Uma linha so, sem quebra: o texto de um cliente pode vir com varias. */
export function resumir(texto, max = 140) {
  const limpo = String(texto ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return limpo.length > max ? `${limpo.slice(0, max - 1)}…` : limpo;
}

/** Texto de cliente, respeitando PAINEL_CONTEUDO. */
export function textoDoCliente(texto, max = 110) {
  return env.PAINEL_CONTEUDO ? `"${resumir(texto, max)}"` : cinza('(conteudo oculto)');
}

/** Nome bonito do agente a partir do que a cascata sabe sobre a chamada. */
export function nomeDoAgente(agentKey, origem) {
  if (agentKey === 'atendente') return { ator: 'sofia', nome: 'Sofia' };
  if (agentKey === 'atena') return { ator: 'atena', nome: 'Atena' };
  if (agentKey === 'aquiles') return { ator: 'aquiles', nome: 'Aquiles' };
  // Chamadas internas sem agente (humor, resumo, classificar resposta de campanha).
  const nome = origem ? origem.charAt(0).toUpperCase() + origem.slice(1) : 'IA';
  return { ator: ATORES[origem] ? origem : 'cascata', nome };
}

/** Colore um pedaco de texto com a cor de um ator (para nomes no meio da frase). */
export function colorir(ator, texto) {
  return fg((ATORES[ator] ?? ATORES.sistema).cor, negrito(texto));
}

function escrever(linha) {
  try {
    process.stdout.write(`${linha}\n`);
  } catch {
    // Terminal fechado ou pipe quebrado: o painel nunca derruba o sistema.
  }
}

/**
 * Uma linha do painel.
 *
 * @param {keyof typeof ATORES} ator     quem esta agindo (define cor e rotulo)
 * @param {string} texto                 o que aconteceu
 * @param {string} [detalhe]             complemento, em cinza, ao final
 */
export function ver(ator, texto, detalhe) {
  if (!painelAtivo) return;
  escrever(`${cinza(hora())} ${etiqueta(ator)} ${texto}${detalhe ? `  ${cinza(detalhe)}` : ''}`);
}

/**
 * Um agente falando com outro.
 *
 *   14:02:11  [ SOFIA ] → [ ATENA ]  "Cliente quer Corte Degrade amanha as 10..."
 *
 * As duas etiquetas coloridas lado a lado sao o jeito de enxergar a conversa
 * entre eles: quem perguntou, quem respondeu.
 */
export function fala(de, para, texto, detalhe) {
  if (!painelAtivo) return;
  const seta = fg((ATORES[de] ?? ATORES.sistema).cor, '→');
  escrever(
    `${cinza(hora())} ${etiqueta(de)} ${seta} ${etiqueta(para)} ${resumir(texto, 220)}${
      detalhe ? `  ${cinza(detalhe)}` : ''
    }`
  );
}

/** Separador entre atendimentos: quebra o fluxo em blocos faceis de ler. */
export function separador(texto) {
  if (!painelAtivo) return;
  const rotulo = texto ? ` ${texto} ` : '';
  escrever(cinza(`${'─'.repeat(3)}${rotulo}${'─'.repeat(Math.max(3, 74 - rotulo.length))}`));
}

/** Faixa de abertura, mostrada quando a API sobe (e a cada reinicio do --watch). */
export function faixaDeAbertura({ url, ambiente }) {
  if (!painelAtivo) return;
  const linha = '━'.repeat(64);
  escrever('');
  escrever(fg(45, linha));
  escrever(`  ${negrito(fg(45, 'PLATAFORMA DE ATENDIMENTO'))}  ${cinza(`servidor · ${ambiente}`)}`);
  escrever(`  ${fg(45, url)}`);
  escrever(
    `  ${cinza('cada acao do sistema aparece aqui:')} ${colorir('sofia', 'Sofia')} ${colorir(
      'atena',
      'Atena'
    )} ${colorir('aquiles', 'Aquiles')} ${colorir('cascata', 'Cascata')} ${colorir('whatsapp', 'WhatsApp')}`
  );
  escrever(fg(45, linha));
  escrever('');
}
