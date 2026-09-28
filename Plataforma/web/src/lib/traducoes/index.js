import { TEXTOS } from './textos.js';

/**
 * Os dicionarios por idioma, montados a partir de `textos.js`.
 * Carregado sob demanda por lib/idioma.js: quem usa em portugues nao baixa.
 */
export const TRADUCOES = {
  en: Object.fromEntries(TEXTOS.map(([pt, en]) => [pt, en])),
  es: Object.fromEntries(TEXTOS.map(([pt, , es]) => [pt, es]))
};
