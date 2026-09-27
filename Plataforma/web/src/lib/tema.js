import { useSyncExternalStore } from 'react';

/**
 * Modo de visualizacao: claro, medio (o escuro azulado de sempre) ou full black.
 *
 * E uma preferencia de quem esta na frente da tela — a recepcao de dia quer
 * claro, o celular com tela OLED quer preto — entao fica no navegador, nao na
 * conta. As cores de cada modo estao em estilos/global.css (`data-tema`).
 *
 * Alem dos tres modos, qualquer ponto ENTRE eles: arrastando o seletor, a
 * pagina acompanha a mao (0 = claro, 1 = medio, 2 = full black) e, se a
 * pessoa solta no meio, aquele tom fica. Nos pontos inteiros vale o CSS de
 * sempre; no meio, as cores de cada token sao misturadas aqui e postas no
 * <html> (`style`), por cima do CSS.
 */
export const TEMAS = [
  { chave: 'claro', rotulo: 'Claro', icone: 'sol' },
  { chave: 'medio', rotulo: 'Médio', icone: 'contraste' },
  { chave: 'preto', rotulo: 'Full black', icone: 'lua' }
];
const PADRAO = 1; // medio
const CHAVE = 'layout.tema';
const CHAVE_VALOR = 'layout.tema-valor';

// ─── Paletas (as mesmas de global.css), em numeros para poder misturar ───
// Cada cor e [r, g, b, a]. O medio usa um valor representativo onde o CSS
// tem varias variacoes (os paineis): so importa no meio da mistura — nos
// pontos inteiros o CSS original volta a valer.
const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];
const rgba = (r, g, b, a = 1) => [r, g, b, a];

const MEDIO = {
  fundo: hex('#050814'),
  tinta: rgba(255, 255, 255),
  texto: hex('#F0F4FF'),
  textoSuaveA: 0.65,
  textoFracoA: 0.38,
  superficie: rgba(255, 255, 255, 0.05),
  'superficie-2': rgba(255, 255, 255, 0.08),
  'superficie-3': rgba(255, 255, 255, 0.12),
  vidro: rgba(255, 255, 255, 0.04),
  afundado: rgba(0, 0, 0, 0.15),
  'veu-modal': rgba(0, 0, 0, 0.7),
  borda: rgba(255, 255, 255, 0.08),
  'borda-forte': rgba(255, 255, 255, 0.15),
  painel: rgba(10, 14, 30),
  'painel-realce-cor': rgba(40, 48, 86),
  'painel-fundo': hex('#0B1024'),
  'painel-solido': hex('#0E1430'),
  'painel-realce': hex('#171E3B'),
  'tom-azul': hex('#7EB0FF'),
  'tom-perigo': hex('#FF6B82'),
  'tom-amarelo': hex('#FFD23F'),
  'tom-verde': hex('#34D17F'),
  'tom-laranja': hex('#F5C49B'),
  'tom-roxo': hex('#C8B2FF'),
  'tom-ciano': hex('#7DD3FC'),
  'tom-texto': hex('#F0F4FF'),
  sucesso: hex('#07CA6B'),
  alerta: hex('#E89558'),
  perigo: hex('#EA2143'),
  info: hex('#38BDF8'),
  sombra1: rgba(0, 0, 0, 0.5),
  sombra2: rgba(0, 0, 0, 0.3),
  sombraG1: rgba(0, 0, 0, 0.65),
  sombraG2: rgba(0, 0, 0, 0.4),
  brilhoA: 0.25,
  malha: [0.18, 0.14, 0.07]
};

const CLARO = {
  ...MEDIO,
  fundo: hex('#EEF1F7'),
  tinta: rgba(15, 23, 42),
  texto: hex('#0F172A'),
  textoSuaveA: 0.7,
  textoFracoA: 0.5,
  superficie: rgba(255, 255, 255, 0.72),
  'superficie-2': rgba(255, 255, 255, 0.9),
  'superficie-3': rgba(255, 255, 255, 1),
  vidro: rgba(255, 255, 255, 0.8),
  afundado: rgba(15, 23, 42, 0.035),
  'veu-modal': rgba(15, 23, 42, 0.35),
  borda: rgba(15, 23, 42, 0.1),
  'borda-forte': rgba(15, 23, 42, 0.18),
  painel: rgba(255, 255, 255),
  'painel-realce-cor': rgba(226, 232, 244),
  'painel-fundo': hex('#F5F7FB'),
  'painel-solido': hex('#FFFFFF'),
  'painel-realce': hex('#E9EEF8'),
  'tom-azul': hex('#1D4ED8'),
  'tom-perigo': hex('#BE123C'),
  'tom-amarelo': hex('#8A6100'),
  'tom-verde': hex('#047A45'),
  'tom-laranja': hex('#B45309'),
  'tom-roxo': hex('#6D28D9'),
  'tom-ciano': hex('#0369A1'),
  'tom-texto': hex('#0F172A'),
  sucesso: hex('#05A35A'),
  alerta: hex('#C9661F'),
  perigo: hex('#D91A3C'),
  info: hex('#0284C7'),
  sombra1: rgba(15, 23, 42, 0.08),
  sombra2: rgba(15, 23, 42, 0.06),
  sombraG1: rgba(15, 23, 42, 0.14),
  sombraG2: rgba(15, 23, 42, 0.08),
  brilhoA: 0.18,
  malha: [0.08, 0.06, 0]
};

const PRETO = {
  ...MEDIO,
  fundo: hex('#000000'),
  painel: rgba(10, 10, 10),
  'painel-realce-cor': rgba(38, 38, 38),
  'painel-fundo': hex('#000000'),
  'painel-solido': hex('#0A0A0A'),
  'painel-realce': hex('#161616'),
  malha: [0, 0, 0]
};

const PALETAS = [CLARO, MEDIO, PRETO];

const misturar = (a, b, t) => a + (b - a) * t;
const misturarCor = (a, b, t) => a.map((v, i) => misturar(v, b[i], t));
const css = ([r, g, b, a]) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${+a.toFixed(3)})`;
const trio = ([r, g, b]) => `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`;

/** As duas paletas vizinhas de um ponto e quanto ele anda de uma para a outra. */
function vizinhas(valor) {
  const i = Math.min(1, Math.floor(valor));
  return [PALETAS[i], PALETAS[i + 1], valor - i];
}

const fundoEm = (valor) => {
  const [a, b, t] = vizinhas(valor);
  return misturarCor(a.fundo, b.fundo, t);
};

// Contraste (WCAG): luminancia relativa de uma cor e a razao entre duas.
const canal = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminancia = ([r, g, b]) => 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
const contraste = (x, y) => {
  const [l1, l2] = [luminancia(x), luminancia(y)].sort((p, q) => q - p);
  return (l1 + 0.05) / (l2 + 0.05);
};
/** Uma cor translucida por cima de outra: a cor que o olho ve. */
const sobre = ([r, g, b, a], [r2, g2, b2]) => [r * a + r2 * (1 - a), g * a + g2 * (1 - a), b * a + b2 * (1 - a), 1];

/**
 * Tokens de LEITURA (texto, bordas, tons coloridos): NAO sao misturados.
 * Misturar texto escuro->claro enquanto o fundo vai claro->escuro faz os dois
 * se encontrarem no mesmo cinza, e o texto some. Eles vem inteiros da paleta
 * vizinha que da MAIS contraste com o fundo da pagina e com o de um cartao.
 */
const DE_LEITURA = ['tinta', 'texto', 'textoSuaveA', 'textoFracoA', 'borda', 'borda-forte',
  'tom-azul', 'tom-perigo', 'tom-amarelo', 'tom-verde', 'tom-laranja', 'tom-roxo', 'tom-ciano',
  'tom-texto', 'sucesso', 'alerta', 'perigo', 'info'];

/** As variaveis CSS de um ponto qualquer entre 0 (claro) e 2 (full black). */
function variaveisEm(valor) {
  const [a, b, t] = vizinhas(valor);
  const fundo = misturarCor(a.fundo, b.fundo, t);
  const cartao = sobre(misturarCor(a.vidro, b.vidro, t), fundo);
  const piorContraste = (p) => Math.min(contraste(p.texto, fundo), contraste(p.texto, cartao));
  const leitura = piorContraste(a) >= piorContraste(b) ? a : b;

  const cor = (k) => (DE_LEITURA.includes(k) ? leitura[k] : misturarCor(a[k], b[k], t));
  const num = (k) => (DE_LEITURA.includes(k) ? leitura[k] : misturar(a[k], b[k], t));

  const texto = cor('texto');
  const s1 = css(cor('sombra1'));
  const s2 = css(cor('sombra2'));
  const g1 = css(cor('sombraG1'));
  const g2 = css(cor('sombraG2'));
  const [m1, m2, m3] = a.malha.map((v, k) => misturar(v, b.malha[k], t));

  const v = {
    '--fundo': css(cor('fundo')),
    '--tinta': trio(cor('tinta')),
    '--texto': css(texto),
    '--texto-rgb': trio(texto),
    '--texto-suave': css([...texto.slice(0, 3), num('textoSuaveA')]),
    '--texto-fraco': css([...texto.slice(0, 3), num('textoFracoA')]),
    '--painel-rgb': trio(cor('painel')),
    '--painel-realce-rgb': trio(cor('painel-realce-cor')),
    '--sombra': `0 4px 24px ${s1}, 0 1px 4px ${s2}`,
    '--sombra-g': `0 8px 40px ${g1}, 0 2px 8px ${g2}`,
    '--glow-pri': `0 0 24px rgba(24, 86, 255, ${num('brilhoA').toFixed(3)})`,
    '--malha': [
      `radial-gradient(ellipse 80% 60% at 20% 10%, rgba(24, 86, 255, ${m1.toFixed(3)}) 0%, transparent 60%)`,
      `radial-gradient(ellipse 60% 50% at 80% 80%, rgba(120, 40, 255, ${m2.toFixed(3)}) 0%, transparent 55%)`,
      `radial-gradient(ellipse 50% 40% at 60% 20%, rgba(7, 202, 107, ${m3.toFixed(3)}) 0%, transparent 50%)`
    ].join(', ')
  };
  for (const k of [
    'superficie', 'superficie-2', 'superficie-3', 'vidro', 'afundado', 'veu-modal', 'borda', 'borda-forte',
    'painel-fundo', 'painel-solido', 'painel-realce', 'tom-azul', 'tom-perigo', 'tom-amarelo', 'tom-verde',
    'tom-laranja', 'tom-roxo', 'tom-ciano', 'tom-texto', 'sucesso', 'alerta', 'perigo', 'info'
  ]) {
    v[`--${k}`] = css(cor(k));
  }
  return v;
}
const NOMES_VARIAVEIS = Object.keys(variaveisEm(0.5));

// ─── Estado ───

const limitar = (v) => Math.min(TEMAS.length - 1, Math.max(0, v));
/** Ponto inteiro mais perto (o "modo" de fato, para icones, tecla e ciclo). */
export const indiceMaisPerto = (valor) => Math.round(valor);

function lerValor() {
  try {
    const salvo = Number.parseFloat(localStorage.getItem(CHAVE_VALOR));
    if (Number.isFinite(salvo)) return limitar(salvo);
    const i = TEMAS.findIndex((t) => t.chave === localStorage.getItem(CHAVE));
    return i >= 0 ? i : PADRAO;
  } catch {
    return PADRAO;
  }
}

let valorAtual = lerValor();
const ouvintes = new Set();
const avisar = () => ouvintes.forEach((f) => f());

/** Poe o valor na pagina. Nao grava nem avisa: serve ao arrastar e ao salvar. */
function aplicar(valor) {
  const raiz = document.documentElement;
  const i = indiceMaisPerto(valor);
  // O CSS do modo mais perto (color-scheme, etc.) — no inteiro, ele e tudo.
  if (i === PADRAO) raiz.removeAttribute('data-tema');
  else raiz.setAttribute('data-tema', TEMAS[i].chave);

  const inteiro = Math.abs(valor - i) < 0.001;
  const vars = inteiro ? null : variaveisEm(valor);
  for (const nome of NOMES_VARIAVEIS) {
    if (vars) raiz.style.setProperty(nome, vars[nome]);
    else raiz.style.removeProperty(nome);
  }
  // A barra do navegador/app instalado acompanha o fundo.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', css(fundoEm(valor)));
}

// Aplica ja ao carregar o modulo (antes do React desenhar): sem piscar o
// tema errado na abertura.
aplicar(valorAtual);

function gravar(valor) {
  try {
    localStorage.setItem(CHAVE, TEMAS[indiceMaisPerto(valor)].chave);
    if (Number.isInteger(valor)) localStorage.removeItem(CHAVE_VALOR);
    else localStorage.setItem(CHAVE_VALOR, String(+valor.toFixed(3)));
  } catch {
    // Navegador sem armazenamento: vale so nesta visita.
  }
}

/**
 * Vai para um dos tres modos (clique, teclado, menu recolhido). A pagina
 * funde de um tema para o outro (o navegador tira uma foto antes e outra
 * depois e mistura as duas — nada e animado elemento por elemento). Sem
 * suporte, ou com "reduzir movimento", troca direto.
 */
export function definirTema(chave) {
  const i = TEMAS.findIndex((t) => t.chave === chave);
  if (i < 0 || i === valorAtual) return;
  valorAtual = i;
  const semMovimento = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (document.startViewTransition && !semMovimento) document.startViewTransition(() => aplicar(i));
  else aplicar(i);
  gravar(i);
  avisar();
}

/**
 * Arrastando: a pagina acompanha a mao, um quadro por vez (varios movimentos
 * do mouse no mesmo quadro viram uma pintura so). Nada e gravado aqui.
 */
let pendente = null;
export function previsualizarValor(valor) {
  const primeiro = pendente === null;
  pendente = limitar(valor);
  if (primeiro) {
    requestAnimationFrame(() => {
      if (pendente !== null) aplicar(pendente);
      pendente = null;
    });
  }
}

/**
 * Soltou: o tom daquele ponto fica. Pertinho de um modo (menos de 4% do
 * caminho), encaixa nele — ninguem quer um "quase claro" por acidente.
 */
export function fixarValor(valor) {
  let v = limitar(valor);
  if (Math.abs(v - Math.round(v)) < 0.04) v = Math.round(v);
  pendente = null;
  valorAtual = v;
  aplicar(v);
  gravar(v);
  avisar();
}

/** Arraste cancelado (ex.: o navegador tomou o toque): volta ao que estava. */
export function cancelarPrevia() {
  pendente = null;
  aplicar(valorAtual);
}

/** O proximo modo da fila (o menu recolhido troca com um clique so). */
export function proximoTema(valor) {
  return TEMAS[(indiceMaisPerto(valor) + 1) % TEMAS.length].chave;
}

/** O valor atual, de 0 (claro) a 2 (full black). */
export function useTema() {
  return useSyncExternalStore(
    (f) => {
      ouvintes.add(f);
      return () => ouvintes.delete(f);
    },
    () => valorAtual
  );
}
