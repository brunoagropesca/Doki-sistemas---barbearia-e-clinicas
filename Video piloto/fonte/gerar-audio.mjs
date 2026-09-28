// Trilha e efeitos do video piloto, 100% sintetizados (sem arquivo de audio
// de terceiros: nada de licenca). Os tempos seguem cena/index.html.
// Uso: node gerar-audio.mjs audio.wav
import { writeFileSync } from 'node:fs';

const SR = 48000;
const DUR = 30;
const N = SR * DUR;
const L = new Float32Array(N), R = new Float32Array(N);
const envioL = new Float32Array(N), envioR = new Float32Array(N); // para a reverb

// ---------- utilidades ----------
let semente = 12345;
const aleatorio = () => ((semente = (semente * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const TAU = Math.PI * 2;

/** Mistura um som mono no instante t, com volume, pan (-1..1) e envio de reverb. */
function mix(som, t, ganho = 1, pan = 0, rev = 0.15) {
  const i0 = Math.round(t * SR);
  const gl = ganho * Math.cos((pan + 1) * Math.PI / 4), gr = ganho * Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < som.length; i++) {
    const j = i0 + i; if (j < 0 || j >= N) continue;
    L[j] += som[i] * gl; R[j] += som[i] * gr;
    envioL[j] += som[i] * gl * rev; envioR[j] += som[i] * gr * rev;
  }
}

/** Biquad RBJ (lowpass/highpass/bandpass), com frequencia que pode variar. */
function filtro(buf, tipo, freqDe, q = 0.7, freqAte = freqDe) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, b0, b1, b2, a1, a2;
  const coef = (f) => {
    const w = TAU * Math.min(f, SR * 0.45) / SR, a = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + a;
    if (tipo === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else if (tipo === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else { b0 = a; b1 = 0; b2 = -a; }
    b0 /= a0; b1 /= a0; b2 /= a0; a1 = (-2 * c) / a0; a2 = (1 - a) / a0;
  };
  coef(freqDe);
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    if (freqAte !== freqDe && i % 64 === 0) coef(freqDe * Math.pow(freqAte / freqDe, i / buf.length));
    const y = b0 * buf[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = buf[i]; y2 = y1; y1 = y; out[i] = y;
  }
  return out;
}

const ruido = (seg) => Float32Array.from({ length: Math.round(seg * SR) }, aleatorio);
const env = (i, n, ataque, curva = 5) => Math.min(1, i / (ataque * SR + 1)) * Math.exp(-curva * i / n);

// ---------- instrumentos ----------
function kick(ganho = 1) {
  const n = Math.round(0.45 * SR), s = new Float32Array(n); let fase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR; const f = 45 + 110 * Math.exp(-t * 28);
    fase += TAU * f / SR; s[i] = Math.tanh(1.6 * Math.sin(fase)) * Math.exp(-t * 7) * ganho;
  }
  return s;
}
function clap() {
  const r = ruido(0.25);
  const b = filtro(r, 'bp', 1400, 0.9);
  return b.map((v, i) => { const t = i / SR; const rajada = t < 0.03 ? (Math.floor(t / 0.01) % 2 ? 0.6 : 1) : 1; return v * rajada * Math.exp(-t * 18) * 1.6; });
}
function hat(dur = 0.05) {
  return filtro(ruido(dur), 'hp', 8000, 0.7).map((v, i) => v * Math.exp(-i / (dur * SR) * 6) * 0.9);
}
function prato() {
  return filtro(ruido(2.4), 'hp', 5000, 0.5).map((v, i) => v * Math.exp(-i / SR * 1.8) * 0.6);
}
/** Voz de pad: harmonicos com leve desafinacao (soa como um saw filtrado). */
function pad(notas, dur, brilho = 6) {
  const n = Math.round(dur * SR), s = new Float32Array(n);
  for (const nota of notas) for (const det of [-0.08, 0.08]) {
    const f = midi(nota + det);
    for (let h = 1; h <= brilho; h++) {
      const a = 1 / (h * 1.3), w = TAU * f * h / SR, ph = Math.random() * TAU;
      for (let i = 0; i < n; i++) s[i] += Math.sin(w * i + ph) * a;
    }
  }
  const ataque = 0.35 * SR, solta = 0.5 * SR;
  for (let i = 0; i < n; i++) s[i] *= Math.min(1, i / ataque, (n - i) / solta) * 0.05;
  return s;
}
function baixo(nota, dur) {
  const n = Math.round(dur * SR), s = new Float32Array(n), f = midi(nota);
  for (let i = 0; i < n; i++) { const t = i / SR; s[i] = Math.tanh(2.2 * (Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * 2 * f * t))) * Math.min(1, i / 200) * Math.exp(-t * 3.5) * Math.min(1, (n - i) / 300); }
  return filtro(s, 'lp', 900, 0.8);
}
function pluck(nota, dur = 0.35) {
  const n = Math.round(dur * SR), s = new Float32Array(n), f = midi(nota);
  for (let i = 0; i < n; i++) { const t = i / SR; s[i] = (Math.sin(TAU * f * t) + 0.35 * Math.sin(TAU * 2 * f * t) + 0.12 * Math.sin(TAU * 3 * f * t)) * Math.exp(-t * 11) * Math.min(1, i / 60); }
  return s;
}
function sino(nota, dur = 1.6) {
  const n = Math.round(dur * SR), s = new Float32Array(n), f = midi(nota);
  for (let i = 0; i < n; i++) { const t = i / SR; s[i] = (Math.sin(TAU * f * t) + 0.5 * Math.sin(TAU * f * 2.76 * t) * Math.exp(-t * 4) + 0.25 * Math.sin(TAU * f * 5.4 * t) * Math.exp(-t * 8)) * Math.exp(-t * 3) * Math.min(1, i / 40); }
  return s;
}

// ---------- efeitos ----------
function whoosh(dur = 0.6, de = 400, ate = 5000) {
  const r = filtro(ruido(dur), 'bp', de, 1.2, ate);
  return r.map((v, i) => v * Math.pow(Math.sin(Math.PI * i / r.length), 2) * 1.3);
}
function riser(dur) { const r = filtro(ruido(dur), 'bp', 300, 2, 7000); return r.map((v, i) => v * Math.pow(i / r.length, 2.2) * 1.1); }
function pop(freq = 900, dur = 0.12) {
  const n = Math.round(dur * SR), s = new Float32Array(n); let fase = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; fase += TAU * freq * (1 + 1.2 * Math.exp(-t * 60)) / SR; s[i] = Math.sin(fase) * Math.exp(-t * 32) * Math.min(1, i / 30); }
  return s;
}
function tique(freq = 2400) { return pop(freq, 0.03).map((v) => v * 0.6); }
function toque(freq = 3200) { const n = Math.round(0.015 * SR); return filtro(ruido(0.015), 'bp', freq, 3).map((v, i) => v * (1 - i / n) * 1.5); }
function brilho(dur = 1.4, base = 84) {
  const n = Math.round(dur * SR), s = new Float32Array(n);
  [0, 4, 7, 11, 14, 19].forEach((iv, k) => { const f = midi(base + iv), ini = Math.round(k * 0.06 * SR);
    for (let i = ini; i < n; i++) { const t = (i - ini) / SR; s[i] += Math.sin(TAU * f * t) * Math.exp(-t * 3.2) * Math.min(1, t * 80) * 0.16; } });
  return s;
}
function impacto() {
  const g = kick(1.3), r = filtro(ruido(1.2), 'lp', 180, 0.7).map((v, i) => v * Math.exp(-i / SR * 3) * 0.9);
  const s = new Float32Array(r.length); for (let i = 0; i < s.length; i++) s[i] = r[i] + (g[i] ?? 0);
  return s;
}

// ---------- trilha: 120 BPM, compasso de 2 s ----------
const BATIDA = 0.5;
const ACORDES = [
  { raiz: 36, pad: [55, 59, 62, 64, 67] }, // Cmaj9
  { raiz: 33, pad: [52, 55, 59, 60, 64] }, // Am9
  { raiz: 29, pad: [52, 55, 57, 60, 64] }, // Fmaj9
  { raiz: 31, pad: [50, 55, 59, 62, 64] }  // G6
];
const acordeEm = (t) => ACORDES[Math.floor(t / 2) % 4];
const groove = (t) => (t >= 6.5 && t < 25.0) || (t >= 25.8 && t < 28.4);

// pad por compasso, com volume por cena
for (let c = 0; c < 14; c++) {
  const t = c * 2; const a = ACORDES[c % 4];
  const vol = t < 3 ? 0.7 : t < 6.4 ? 0.45 : t < 25 ? 0.55 : 0.8;
  mix(pad(a.pad, 2.35, t < 6.4 ? 4 : 6), t, vol, -0.3, 0.35);
  mix(pad(a.pad.map((n) => n + 12), 2.35, 3), t, vol * 0.35, 0.35, 0.4);
}
// acorde final longo
mix(pad([48, 55, 59, 62, 64, 67], 2.2, 6), 28.2, 0.9, 0, 0.45);

for (let b = 0; b < DUR / BATIDA; b++) {
  const t = b * BATIDA;
  // gancho: batida de coracao que cresce
  if (t >= 3.0 && t < 6.5) mix(kick(0.5 + 0.4 * (t - 3) / 3.5), t, 0.8, 0, 0.05);
  if (groove(t)) {
    mix(kick(), t, 0.7, 0, 0.03);
    if (b % 2 === 1) mix(clap(), t, 0.45, 0.05, 0.25);
    mix(hat(), t + BATIDA / 2, 0.22, 0.35, 0.05);
    if (t >= 14.5 && t < 25) mix(hat(0.03), t + BATIDA / 4, 0.1, -0.35, 0.05), mix(hat(0.03), t + 3 * BATIDA / 4, 0.1, -0.35, 0.05);
  }
}
// baixo sincopado (16 avos por compasso)
for (let t = 6.5; t < 28.4; t += 2) {
  const inicio = Math.floor(t / 2) * 2;
  for (const passo of [0, 3, 6, 8, 11, 14]) {
    const tt = inicio + passo * 0.125; if (!groove(tt) || tt < 6.5) continue;
    mix(baixo(acordeEm(tt).raiz + 12, 0.24), tt, 0.45, 0, 0);
  }
}
// arpejo na cena do sistema e dos beneficios
for (let tt = 14.5; tt < 25; tt += 0.125) {
  const a = acordeEm(tt); const notas = [...a.pad, a.pad[1] + 12, a.pad[3] + 12];
  const passo = Math.round(tt / 0.125);
  mix(pluck(notas[passo % notas.length] + 12), tt, 0.13, passo % 2 ? 0.45 : -0.45, 0.35);
}
// duck (sidechain) do bus todo pela batida do bumbo, durante o groove
for (let i = 0; i < N; i++) {
  const t = i / SR; if (!groove(t)) continue;
  const fase = (t % BATIDA) / BATIDA; const d = 1 - 0.45 * Math.exp(-fase * 9);
  L[i] *= d; R[i] *= d;
}

// ---------- efeitos sincronizados com a animacao ----------
mix(brilho(2.2, 79), 0.15, 0.9, 0, 0.5);           // logo aparece
mix(impacto(), 1.15, 0.5, 0, 0.3);
mix(whoosh(0.7, 300, 6000), 2.6, 0.5, 0.2, 0.3);    // saida do logo
mix(tique(1800), 3.05, 0.5, 0, 0.2);               // "São 23h"
[3.25, 3.45, 3.65].forEach((t, k) => mix(pop(500 + k * 120, 0.09), t, 0.35, -0.2 + k * 0.2, 0.2));
mix(riser(1.4), 3.4, 0.25, 0, 0.3);
mix(impacto(), 4.55, 0.6, 0, 0.35);               // "Quem responde?"
mix(whoosh(0.5, 1500, 7000), 5.0, 0.3, 0.3, 0.2);  // sublinhado
mix(riser(1.3), 5.2, 0.35, 0, 0.3);
mix(whoosh(0.8, 250, 5000), 6.15, 0.6, -0.2, 0.3); // entra o celular
mix(prato(), 6.5, 0.35, 0, 0.3);
// conversa
mix(pop(1250, 0.1), 7.2, 0.6, 0.35, 0.15);         // cliente envia
mix(pop(420, 0.22).map((v, i) => v * (1 + 0.5 * Math.sin(i / 60))), 7.4, 0.5, -0.5, 0.2); // mascote
for (const [a, b] of [[8.0, 8.85], [11.0, 11.75]]) for (let t = a; t < b; t += 0.07 + Math.abs(aleatorio()) * 0.06) mix(toque(2600 + aleatorio() * 800), t, 0.25, -0.3, 0.05);
mix(pop(760, 0.13), 8.9, 0.6, -0.35, 0.15);        // Sofia responde
mix(pop(1250, 0.1), 10.4, 0.6, 0.35, 0.15);
mix(pop(760, 0.13), 11.8, 0.6, -0.35, 0.15);
mix(sino(84), 12.7, 0.35, 0, 0.4); mix(sino(88), 12.82, 0.3, 0.1, 0.4); mix(sino(91), 12.94, 0.3, 0.2, 0.45); // horario marcado
mix(whoosh(0.6, 400, 4000), 14.2, 0.5, 0.2, 0.3);
// sistema
[14.9, 16.9, 18.1].forEach((t) => mix(whoosh(0.45, 800, 6000), t - 0.05, 0.4, 0.5, 0.2));
mix(sino(88, 1.0), 15.75, 0.3, 0.3, 0.35);         // nova linha "via IA"
[17.3, 17.55, 17.8].forEach((t, k) => mix(pop(900 + k * 150, 0.08), t, 0.35, -0.3 + k * 0.3, 0.15));
for (let x = 0; x < 1; x += 0.06) { const t = 18.5 + 1.5 * (1 - Math.pow(1 - x, 2)); mix(tique(2200 + x * 900), t, 0.25, 0.2, 0.05); } // contador
mix(sino(91, 1.0), 19.85, 0.3, 0.2, 0.35);
mix(whoosh(0.6, 300, 5000), 20.75, 0.5, 0, 0.3);
// beneficios
[21.6, 22.3, 23.0].forEach((t, k) => { mix(whoosh(0.4, 600, 5000), t - 0.05, 0.3, -0.4, 0.2); mix(pop(700 + k * 180, 0.1), t + 0.2, 0.45, 0, 0.2); });
mix(riser(2.0), 23.2, 0.4, 0, 0.3);
// chamada
mix(impacto(), 25.2, 0.8, 0, 0.3); mix(prato(), 25.2, 0.5, 0, 0.35);
mix(whoosh(0.9, 200, 5000), 24.9, 0.5, 0, 0.3);
mix(pop(620, 0.16), 26.4, 0.7, 0, 0.25); mix(brilho(1.2, 86), 26.45, 0.5, 0, 0.45); // botao
mix(whoosh(0.8, 300, 6000), 28.2, 0.5, 0, 0.35);
mix(brilho(1.6, 84), 28.6, 0.8, 0, 0.5);           // logo final
mix(impacto(), 28.9, 0.55, 0, 0.45);

// ---------- reverb simples (Schroeder) no envio ----------
function reverb(inp, atrasos, ap) {
  const out = new Float32Array(N);
  for (const d of atrasos) { const n = Math.round(d * SR), buf = new Float32Array(n); let k = 0, lp = 0;
    for (let i = 0; i < N; i++) { const y = buf[k]; lp = y * 0.6 + lp * 0.4; buf[k] = inp[i] + lp * 0.8; k = (k + 1) % n; out[i] += y * 0.25; } }
  for (const d of ap) { const n = Math.round(d * SR), buf = new Float32Array(n); let k = 0;
    for (let i = 0; i < N; i++) { const b = buf[k], x = out[i], y = -x + b; buf[k] = x + b * 0.5; k = (k + 1) % n; out[i] = y; } }
  return out;
}
const rl = reverb(envioL, [0.0297, 0.0371, 0.0411, 0.0437], [0.005, 0.0017]);
const rr = reverb(envioR, [0.0303, 0.0359, 0.0423, 0.0449], [0.0051, 0.0019]);

// ---------- master ----------
let pico = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const fade = Math.min(1, t / 0.08) * (t > 29.55 ? Math.max(0, (30 - t) / 0.45) : 1);
  L[i] = Math.tanh((L[i] + rl[i] * 0.9) * 1.1) * fade; R[i] = Math.tanh((R[i] + rr[i] * 0.9) * 1.1) * fade;
  pico = Math.max(pico, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = 0.89 / pico;
const wav = Buffer.alloc(44 + N * 4);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + N * 4, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(SR, 24);
wav.writeUInt32LE(SR * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { wav.writeInt16LE(Math.round(L[i] * norm * 32767), 44 + i * 4); wav.writeInt16LE(Math.round(R[i] * norm * 32767), 46 + i * 4); }
writeFileSync(process.argv[2] ?? 'audio.wav', wav);
console.log('audio ok, pico', pico.toFixed(2));
