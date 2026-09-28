/**
 * Idioma da interface: português (padrão), inglês ou espanhol.
 *
 * As telas continuam escritas em português. A tradução acontece na hora de
 * MOSTRAR, pelo mesmo observador que aplica os "Textos do sistema" do DEV
 * (ver lib/textos.jsx): a chave é o próprio texto em português e o dicionário
 * (lib/traducoes) diz como ele fica em cada idioma. Reescrever as ~100 telas
 * para ler de um catálogo seria tocar em tudo; assim, uma tela nova já nasce
 * traduzível, e `node scripts/textos-da-tela.mjs` aponta o que falta traduzir.
 *
 * O que NÃO é traduzido: o que vem do servidor (mensagens de erro, textos
 * cadastrados pela empresa, conversas de clientes). O backend não muda.
 *
 * A escolha é deste navegador (cada pessoa da equipe usa a sua). Trocar
 * recarrega a página: datas já desenhadas e o cache das telas voltam no
 * idioma novo, sem sobrar meia tela em português.
 */

export const IDIOMAS = [
  { codigo: 'pt', rotulo: 'Português', curto: 'PT', local: 'pt-BR' },
  { codigo: 'en', rotulo: 'English', curto: 'EN', local: 'en-US' },
  { codigo: 'es', rotulo: 'Español', curto: 'ES', local: 'es-ES' }
];

const CHAVE = 'idioma';

function lerIdioma() {
  try {
    const salvo = localStorage.getItem(CHAVE);
    if (IDIOMAS.some((i) => i.codigo === salvo)) return salvo;
  } catch {
    // Navegador sem armazenamento: fica o padrão.
  }
  return 'pt';
}

/** Idioma desta visita (fixo até recarregar). */
export const idiomaAtual = lerIdioma();

export function trocarIdioma(codigo) {
  if (codigo === idiomaAtual) return;
  try {
    localStorage.setItem(CHAVE, codigo);
  } catch {
    // Sem armazenamento não há como lembrar a escolha.
    return;
  }
  window.location.reload();
}

// ---------------------------------------------------------------------------
// Dicionário
// ---------------------------------------------------------------------------

let exatos = {};
/** Textos com parte variável ("{0} marcados"): viram expressão regular. */
let padroes = [];

const escapar = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function montarPadroes(dicionario) {
  const lista = [];
  for (const [original, traducao] of Object.entries(dicionario)) {
    if (!/\{\d+\}/.test(original)) continue;
    const pedacos = original.split(/(\{\d+\})/);
    const ordem = [];
    const corpo = pedacos
      .map((p) => {
        const m = p.match(/^\{(\d+)\}$/);
        if (!m) return escapar(p);
        ordem.push(Number(m[1]));
        return '(.+?)';
      })
      .join('');
    // O maior pedaço fixo filtra rápido antes de testar a expressão.
    const fixo = pedacos.filter((p) => !/^\{\d+\}$/.test(p)).sort((a, b) => b.length - a.length)[0] ?? '';
    lista.push({ regex: new RegExp(`^${corpo}$`), ordem, traducao, fixo });
  }
  // Os mais específicos (mais texto fixo) primeiro.
  return lista.sort((a, b) => b.fixo.length - a.fixo.length);
}

/**
 * Carrega o dicionário do idioma escolhido. Em português não carrega nada
 * (o arquivo de traduções fica fora do pacote de quem não precisa dele).
 */
export async function carregarIdioma() {
  document.documentElement.lang = IDIOMAS.find((i) => i.codigo === idiomaAtual)?.local ?? 'pt-BR';
  if (idiomaAtual === 'pt') return;
  ajustarDatas();
  try {
    const { TRADUCOES } = await import('./traducoes/index.js');
    exatos = TRADUCOES[idiomaAtual] ?? {};
    padroes = montarPadroes(exatos);
  } catch {
    // Sem o dicionário a tela fica em português — melhor do que não abrir.
  }
}

/** O texto no idioma escolhido, ou null quando fica como está. */
export function traduzir(texto) {
  if (idiomaAtual === 'pt' || !texto) return null;
  if (Object.hasOwn(exatos, texto)) return exatos[texto];
  for (const p of padroes) {
    if (p.fixo && !texto.includes(p.fixo)) continue;
    const m = texto.match(p.regex);
    if (!m) continue;
    return p.traducao.replace(/\{(\d+)\}/g, (_, n) => {
      const valor = m[p.ordem.indexOf(Number(n)) + 1] ?? '';
      // A parte variável pode ser ela mesma um texto conhecido ("Pendente").
      return Object.hasOwn(exatos, valor) ? exatos[valor] : valor;
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------

/**
 * As telas formatam datas com 'pt-BR' escrito no código ("28 de set.").
 * Fora do português, 'pt-BR' (ou nenhum idioma) passa a significar o idioma
 * escolhido. Só DATAS: números e dinheiro seguem no formato brasileiro (R$).
 * Hora continua em 24 h, como a empresa trabalha.
 */
function ajustarDatas() {
  const local = IDIOMAS.find((i) => i.codigo === idiomaAtual).local;
  const trocar = (loc) => (loc == null || loc === 'pt-BR' ? local : loc);
  const opcoes = (loc, op) =>
    loc == null || loc === 'pt-BR' ? (op?.hour12 === undefined && !op?.hourCycle ? { ...op, hourCycle: 'h23' } : op) : op;

  for (const metodo of ['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString']) {
    const original = Date.prototype[metodo];
    Date.prototype[metodo] = function (loc, op) {
      return original.call(this, trocar(loc), opcoes(loc, op));
    };
  }

  const Original = Intl.DateTimeFormat;
  function DateTimeFormat(loc, op) {
    return new Original(trocar(loc), opcoes(loc, op));
  }
  DateTimeFormat.prototype = Original.prototype;
  DateTimeFormat.supportedLocalesOf = Original.supportedLocalesOf;
  Intl.DateTimeFormat = DateTimeFormat;
}
