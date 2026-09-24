import { useSyncExternalStore } from 'react';

/**
 * O sistema como APP no celular (PWA): instalado pela tela inicial, sem loja.
 *
 * Cada sistema instala de um jeito:
 *   - Android/Chrome: o navegador oferece um "convite" (`beforeinstallprompt`)
 *     que a gente guarda e dispara quando a pessoa toca em "Instalar app".
 *   - iPhone/iPad: nao existe convite — so o caminho manual, pelo Safari:
 *     Compartilhar → "Adicionar a Tela de Inicio". A tela explica o passo.
 *
 * O convite do Chrome chega UMA vez, logo que a pagina abre — muitas vezes
 * antes de qualquer tela montar. Por isso ele e ouvido aqui, no carregamento
 * do modulo (importado pelo main.jsx), e nao dentro de um componente.
 */

let convite = null;
const ouvintes = new Set();
const avisar = () => ouvintes.forEach((f) => f());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Sem isto o Chrome mostra a propria barrinha, na hora que ele quer.
    e.preventDefault();
    convite = e;
    avisar();
  });
  window.addEventListener('appinstalled', () => {
    convite = null;
    avisar();
  });
}

/** Aberto pelo icone da tela inicial (e nao numa aba do navegador)? */
export function estaInstalado() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

/** iPhone/iPad — o iPad novo se apresenta como Mac, mas tem tela de toque. */
export function ehIos() {
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

/** No iPhone so o Safari instala; Chrome/Firefox do iPhone nao tem a opcao. */
export function ehSafariDoIos() {
  return ehIos() && !/crios|fxios|edgios/i.test(navigator.userAgent);
}

/**
 * Registra o service worker (ver `public/sw.js`). O navegador so aceita em
 * endereco seguro: HTTPS, ou `localhost` no proprio computador. Pelo IP da
 * rede (http://192.168...) ele simplesmente nao registra — o sistema funciona
 * igual, so fica sem a pagina "sem conexao" e sem o convite do Android.
 */
export function registrarServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Sem service worker o sistema funciona igual; nada a fazer.
    });
  });
}

function inscrever(f) {
  ouvintes.add(f);
  return () => ouvintes.delete(f);
}

/**
 * Estado da instalacao para as telas.
 * @returns {{ instalado: boolean, podeConvidar: boolean, ios: boolean, convidar: () => Promise<boolean> }}
 */
export function useAppInstalado() {
  const temConvite = useSyncExternalStore(inscrever, () => convite !== null, () => false);
  return {
    instalado: estaInstalado(),
    podeConvidar: temConvite,
    ios: ehIos(),
    async convidar() {
      if (!convite) return false;
      const c = convite;
      convite = null;
      avisar();
      await c.prompt();
      const { outcome } = await c.userChoice;
      return outcome === 'accepted';
    }
  };
}
