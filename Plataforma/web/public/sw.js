/**
 * Service worker do app instalado (PWA).
 *
 * De proposito ele faz POUCO: nao guarda telas, scripts nem dados da API.
 * O sistema roda com o Vite (que troca os arquivos a cada mudanca) e mostra
 * informacao ao vivo (fila, agenda) — um cache aqui serviria tela velha ou
 * numero errado. Ele existe para duas coisas:
 *
 *   1. o celular reconhecer o site como app instalavel (Android/Chrome);
 *   2. sem internet/Wi-Fi, abrir uma pagina amigavel em vez do dinossauro.
 *
 * Mudou este arquivo? Troque a VERSAO: o navegador instala o novo e apaga o
 * cache antigo sozinho.
 */
const VERSAO = 'v1';
const CACHE = `plataforma-${VERSAO}`;
const OFFLINE = '/offline.html';
const GUARDADOS = [OFFLINE, '/icones/icone-192.png', '/icones/apple-touch-icon.png'];

self.addEventListener('install', (evento) => {
  evento.waitUntil(caches.open(CACHE).then((c) => c.addAll(GUARDADOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches
      .keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evento) => {
  // So a abertura de paginas passa por aqui; o resto (API, scripts, fotos)
  // vai direto para a rede, como se o service worker nao existisse.
  if (evento.request.mode !== 'navigate') return;
  evento.respondWith(fetch(evento.request).catch(() => caches.match(OFFLINE)));
});
