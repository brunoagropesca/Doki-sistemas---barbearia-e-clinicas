/**
 * Gera os icones do app instalado (PWA) em `public/icones/`.
 *
 * Sem dependencias: desenha o mesmo raio do favicon sobre o gradiente da marca
 * (azul -> roxo, o do logo no menu) e grava PNG com o zlib do proprio Node.
 * So precisa rodar de novo se o desenho mudar:  node scripts/gerar-icones.mjs
 *
 *   - icone-192 / icone-512: cantos arredondados (Android, atalhos, instalacao)
 *   - icone-maskable-512: fundo ate a borda e raio menor, dentro da "zona
 *     segura" — o Android recorta no formato do aparelho (circulo, gota...)
 *   - apple-touch-icon (180): quadrado cheio; o iPhone arredonda sozinho
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const PASTA = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icones');

// O raio do favicon (grade de 32): "M18 5 9 18h6l-1 9 9-13h-6z".
const RAIO = [[18, 5], [9, 18], [15, 18], [14, 27], [23, 14], [17, 14]];
const DE = [0x18, 0x56, 0xff]; // --primaria
const ATE = [0x7c, 0x3a, 0xed]; // o roxo do logo

function dentroDoPoligono(x, y, pontos) {
  let dentro = false;
  for (let i = 0, j = pontos.length - 1; i < pontos.length; j = i++) {
    const [xi, yi] = pontos[i];
    const [xj, yj] = pontos[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

function dentroDoRetanguloArredondado(x, y, lado, raio) {
  if (raio <= 0) return x >= 0 && y >= 0 && x < lado && y < lado;
  const cx = Math.min(Math.max(x, raio), lado - raio);
  const cy = Math.min(Math.max(y, raio), lado - raio);
  return (x - cx) ** 2 + (y - cy) ** 2 <= raio * raio;
}

/** Desenha com 4x4 amostras por pixel: bordas lisas, sem serrilhado. */
function desenhar(lado, { cantos, escalaDoRaio }) {
  const px = Buffer.alloc(lado * lado * 4);
  const raioCanto = lado * cantos;
  // O raio fica centrado: a caixa dele na grade de 32 vai de (9,5) a (23,27).
  const escala = (lado * escalaDoRaio) / 22;
  const pontos = RAIO.map(([x, y]) => [lado / 2 + (x - 16) * escala, lado / 2 + (y - 16) * escala]);
  const N = 4;

  for (let y = 0; y < lado; y++) {
    for (let x = 0; x < lado; x++) {
      let fundo = 0;
      let branco = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const fx = x + (sx + 0.5) / N;
          const fy = y + (sy + 0.5) / N;
          if (!dentroDoRetanguloArredondado(fx, fy, lado, raioCanto)) continue;
          fundo++;
          if (dentroDoPoligono(fx, fy, pontos)) branco++;
        }
      }
      const total = N * N;
      const t = (x + y) / (2 * lado); // gradiente na diagonal, como o do menu
      const cor = DE.map((c, i) => c + (ATE[i] - c) * t);
      const b = branco / Math.max(fundo, 1);
      const o = (y * lado + x) * 4;
      px[o] = Math.round(cor[0] + (255 - cor[0]) * b);
      px[o + 1] = Math.round(cor[1] + (255 - cor[1]) * b);
      px[o + 2] = Math.round(cor[2] + (255 - cor[2]) * b);
      px[o + 3] = Math.round((fundo / total) * 255);
    }
  }
  return px;
}

const TABELA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = TABELA_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function bloco(tipo, dados) {
  const tam = Buffer.alloc(4);
  tam.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tam, corpo, crc]);
}
function png(lado, rgba) {
  const cab = Buffer.alloc(13);
  cab.writeUInt32BE(lado, 0);
  cab.writeUInt32BE(lado, 4);
  cab[8] = 8; // 8 bits por canal
  cab[9] = 6; // RGBA
  const linhas = Buffer.alloc(lado * (lado * 4 + 1));
  for (let y = 0; y < lado; y++) rgba.copy(linhas, y * (lado * 4 + 1) + 1, y * lado * 4, (y + 1) * lado * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco('IHDR', cab),
    bloco('IDAT', deflateSync(linhas, { level: 9 })),
    bloco('IEND', Buffer.alloc(0))
  ]);
}

const ICONES = [
  ['icone-192.png', 192, { cantos: 0.22, escalaDoRaio: 0.62 }],
  ['icone-512.png', 512, { cantos: 0.22, escalaDoRaio: 0.62 }],
  ['icone-maskable-512.png', 512, { cantos: 0, escalaDoRaio: 0.46 }],
  ['apple-touch-icon.png', 180, { cantos: 0, escalaDoRaio: 0.56 }]
];

mkdirSync(PASTA, { recursive: true });
for (const [nome, lado, opcoes] of ICONES) {
  writeFileSync(join(PASTA, nome), png(lado, desenhar(lado, opcoes)));
  console.log('ok', nome);
}
