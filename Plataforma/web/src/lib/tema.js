import { useSyncExternalStore } from 'react';

/**
 * Modo de visualizacao: claro, medio (o escuro azulado de sempre) ou full black.
 *
 * E uma preferencia de quem esta na frente da tela — a recepcao de dia quer
 * claro, o celular com tela OLED quer preto — entao fica no navegador, nao na
 * conta. As cores de cada modo estao em estilos/global.css (`data-tema`).
 */
export const TEMAS = [
  { chave: 'claro', rotulo: 'Claro', icone: 'sol', corBarra: '#EEF1F7' },
  { chave: 'medio', rotulo: 'Médio', icone: 'contraste', corBarra: '#050814' },
  { chave: 'preto', rotulo: 'Full black', icone: 'lua', corBarra: '#000000' }
];
const PADRAO = 'medio';
const CHAVE = 'layout.tema';

function lerTema() {
  try {
    const salvo = localStorage.getItem(CHAVE);
    return TEMAS.some((t) => t.chave === salvo) ? salvo : PADRAO;
  } catch {
    return PADRAO;
  }
}

let atual = lerTema();
const ouvintes = new Set();

function aplicar(chave) {
  const raiz = document.documentElement;
  if (chave === PADRAO) raiz.removeAttribute('data-tema');
  else raiz.setAttribute('data-tema', chave);
  // A barra do navegador/app instalado acompanha o fundo.
  const cor = TEMAS.find((t) => t.chave === chave)?.corBarra;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', cor);
}

// Aplica ja ao carregar o modulo (antes do React desenhar): sem piscar o
// tema errado na abertura.
aplicar(atual);

export function definirTema(chave) {
  if (!TEMAS.some((t) => t.chave === chave) || chave === atual) return;
  atual = chave;
  aplicar(chave);
  try {
    localStorage.setItem(CHAVE, chave);
  } catch {
    // Navegador sem armazenamento: vale so nesta visita.
  }
  ouvintes.forEach((f) => f());
}

/** O proximo da fila (o menu recolhido troca com um clique so). */
export function proximoTema(chave) {
  const i = TEMAS.findIndex((t) => t.chave === chave);
  return TEMAS[(i + 1) % TEMAS.length].chave;
}

export function useTema() {
  return useSyncExternalStore(
    (f) => {
      ouvintes.add(f);
      return () => ouvintes.delete(f);
    },
    () => atual
  );
}
