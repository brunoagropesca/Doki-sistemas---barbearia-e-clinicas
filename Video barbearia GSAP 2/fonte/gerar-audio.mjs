// Trilha e efeitos do Reels 2 (DOKI Barbearias, 60 fps, 28 s), 100% sintetizados.
// de terceiros: nada de licenca). Os tempos seguem cena/index.html.
// Uso: node gerar-audio.mjs audio.wav
import { writeFileSync } from 'node:fs';

const SR = 48000;
const DUR = 28;
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

// ---------- efeitos extras deste roteiro ----------
/** Lâmina cortando o ar: whoosh agudo + "zing" metálico descendo. */
function lamina() {
  const w = filtro(ruido(0.55), 'bp', 2500, 3, 9000).map((v, i, a) => v * Math.pow(Math.sin(Math.PI * i / a.length), 3) * 1.4);
  const n = w.length; let fase = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; fase += TAU * (5200 - 2600 * t / 0.55) / SR; w[i] += Math.sin(fase) * 0.18 * Math.exp(-t * 5) * Math.min(1, t * 60); }
  return w;
}
/** Sub-bass drop: seno grave descendo, longo. */
function subDrop(dur = 1.6) {
  const n = Math.round(dur * SR), s = new Float32Array(n); let fase = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; fase += TAU * (62 - 30 * t / dur) / SR; s[i] = Math.tanh(1.8 * Math.sin(fase)) * Math.exp(-t * 1.6) * Math.min(1, i / 300); }
  return s;
}
/** Encaixe mecânico (snap). */
function snap() { const c = toque(5200), p = pop(1400, 0.06); const s = new Float32Array(p.length); for (let i = 0; i < s.length; i++) s[i] = p[i] * 0.7 + (c[i] ?? 0); return s; }
/** Confirmação estilo pagamento por aproximação: dois tons limpos. */
function confirma() {
  const n = Math.round(0.45 * SR), s = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR;
    s[i] = Math.sin(TAU * 1318.5 * t) * Math.exp(-t * 14) * Math.min(1, t * 400) * (t < 0.09 ? 1 : 0.0)
         + (t > 0.09 ? Math.sin(TAU * 1760 * (t - 0.09)) * Math.exp(-(t - 0.09) * 7) * Math.min(1, (t - 0.09) * 400) : 0); }
  return s.map((v) => v * 0.6);
}
function bip(f = 2093) { const n = Math.round(0.09 * SR), s = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR; s[i] = Math.sin(TAU * f * t) * Math.exp(-t * 30) * Math.min(1, t * 500) * 0.5; } return s; }
function tecla() { const a = toque(1800 + aleatorio() * 600), b = filtro(ruido(0.04), 'lp', 900, 1).map((v, i) => v * Math.exp(-i / SR * 120) * 0.8); const s = new Float32Array(b.length); for (let i = 0; i < s.length; i++) s[i] = b[i] + (a[i] ?? 0); return s; }
/** Impacto orquestral: tímpano grave + metais (saw filtrado) + sino. */
function orquestral() {
  const dur = 3.2, n = Math.round(dur * SR), s = new Float32Array(n);
  const k = impacto(); for (let i = 0; i < k.length && i < n; i++) s[i] += k[i] * 1.1;
  for (const nota of [33, 45, 52, 57, 60, 64]) { const f = midi(nota);
    for (let h = 1; h <= 8; h++) { const w = TAU * f * h / SR; for (let i = 0; i < n; i++) { const t = i / SR; s[i] += Math.sin(w * i) / h * 0.05 * Math.exp(-t * 1.1) * Math.min(1, t * 30); } } }
  const sb = sino(57, dur); for (let i = 0; i < n; i++) s[i] += sb[i] * 0.5;
  return filtro(s, 'lp', 5000, 0.7);
}

function vibra(dur = 0.13) { const n = Math.round(dur * SR), s = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR; s[i] = Math.tanh(3 * Math.sin(TAU * 165 * t)) * (0.6 + 0.4 * Math.sin(TAU * 30 * t)) * Math.min(1, t * 200, (dur - t) * 200) * 0.5; } return filtro(s, 'lp', 1200, 0.7); }
function envio() { const w = filtro(ruido(0.35), 'bp', 900, 1.5, 6000).map((v, i, a) => v * Math.pow(Math.sin(Math.PI * i / a.length), 2)); const p = pop(1500, 0.1); for (let i = 0; i < p.length; i++) w[Math.min(w.length - 1, i + Math.round(0.22 * SR))] += p[i] * 0.8; return w; }
function thud() { const k = kick(1.6), m = sino(40, 1.2).map((v) => v * 0.35), r = filtro(ruido(0.5), 'lp', 400, 0.7).map((v, i) => v * Math.exp(-i / SR * 9)); const s = new Float32Array(Math.max(k.length, m.length));
  for (let i = 0; i < s.length; i++) s[i] = (k[i] ?? 0) * 1.2 + (m[i] ?? 0) + (r[i] ?? 0) * 0.8; return s; }

// ---------- trilha: 120 BPM, eletrônica moderna e cadenciada ----------
const BATIDA = 0.5;
const ACORDES = [
  { raiz: 36, pad: [55, 59, 62, 64, 67] }, // Cmaj9
  { raiz: 33, pad: [52, 55, 59, 60, 64] }, // Am9
  { raiz: 29, pad: [52, 55, 57, 60, 64] }, // Fmaj9
  { raiz: 31, pad: [50, 55, 59, 62, 64] }  // G6
];
const acordeEm = (t) => ACORDES[Math.floor(t / 2) % 4];
const groove = (t) => (t >= 4.3 && t < 20.9) || (t >= 22.8 && t < 24.7) || (t >= 25.1 && t < 27.6);
// tensão escura no gancho (pad grave em Am)
mix(pad([45, 52, 57, 60], 4.0, 3), 0, 0.45, 0, 0.3);
for (let c = 2; c < 14; c++) { const t = c * 2; if (t < 4) continue; const a = ACORDES[c % 4];
  const vol = t < 21 ? 0.5 : 0.65; mix(pad(a.pad, 2.35, 6), t, vol, -0.3, 0.35); mix(pad(a.pad.map((x) => x + 12), 2.35, 3), t, vol * 0.3, 0.35, 0.4); }
mix(pad([48, 55, 59, 62, 64, 67], 1.6, 6), 26.4, 0.8, 0, 0.45);
for (let b = 0; b < DUR / BATIDA; b++) { const t = b * BATIDA; if (!groove(t)) continue;
  mix(kick(), t, 0.72, 0, 0.03); if (b % 2 === 1) mix(clap(), t, 0.42, 0.05, 0.25); mix(hat(), t + BATIDA / 2, 0.2, 0.35, 0.05);
  if (t >= 9 && t < 20.9) { mix(hat(0.03), t + BATIDA / 4, 0.09, -0.35, 0.05); mix(hat(0.03), t + 3 * BATIDA / 4, 0.09, -0.35, 0.05); } }
for (let t = 4; t < 28; t += 2) { const ini = Math.floor(t / 2) * 2; for (const passo of [0, 3, 6, 8, 11, 14]) { const tt = ini + passo * 0.125; if (!groove(tt)) continue; mix(baixo(acordeEm(tt).raiz + 12, 0.24), tt, 0.46, 0, 0); } }
for (let tt = 9; tt < 20.9; tt += 0.125) { const a = acordeEm(tt); const notas = [...a.pad, a.pad[1] + 12, a.pad[3] + 12]; const p = Math.round(tt / 0.125); mix(pluck(notas[p % notas.length] + 12), tt, 0.11, p % 2 ? 0.45 : -0.45, 0.35); }
for (let i = 0; i < N; i++) { const t = i / SR; if (!groove(t)) continue; const f = (t % BATIDA) / BATIDA; const d = 1 - 0.45 * Math.exp(-f * 9); L[i] *= d; R[i] *= d; }

// ---------- efeitos sincronizados com cena/index.html ----------
// Cena 1
mix(vibra(), 0.5, 0.9, 0, 0.05); mix(vibra(), 0.7, 0.9, 0, 0.05);
mix(pop(1250, 0.1), 0.48, 0.5, 0.3, 0.15);
mix(bip(1760), 1.25, 0.45, 0.2, 0.2); // visualizada
for (let x = 0; x < 1; x += 0.045) mix(tique(1700 + x * 1500), 0.75 + 1.4 * Math.sqrt(x), 0.28, (x * 7 % 2) - 1, 0.05); // relógio acelerando
mix(pop(760, 0.13), 2.15, 0.6, -0.3, 0.15); // resposta do cliente
mix(whoosh(0.35, 300, 3000), 2.45, 0.4, 0, 0.2); // punch-in
mix(subDrop(2.0), 2.9, 1.0, 0, 0.05); mix(impacto(), 2.9, 0.75, 0, 0.3); // carimbo
mix(riser(0.8), 3.0, 0.3, 0, 0.3);
// Cena 2
mix(whoosh(0.6, 500, 9000), 3.7, 0.7, -0.4, 0.3); mix(brilho(1.4, 84), 4.0, 0.35, 0, 0.45);
mix(pop(420, 0.2), 4.5, 0.5, -0.3, 0.2); // mascote aterrissa
mix(whoosh(0.4, 900, 7000), 5.78, 0.45, 0.3, 0.2); // gesto
for (let k = 0; k < 6; k++) mix(snap(), 6.5 + k * 0.08, 0.35, 0.6 - k * 0.15, 0.15);
// Cena 3
mix(whoosh(0.6, 400, 6000), 8.85, 0.5, 0, 0.3);
for (let k = 0; k < 5; k++) mix(snap(), 9.85 + k * 0.07, 0.4, -0.8 + k * 0.4, 0.15);
mix(pop(1250, 0.1), 9.7, 0.55, 0.3, 0.15);
for (let t = 10.1; t < 10.7; t += 0.09) mix(tecla(), t, 0.15, -0.2, 0.05);
mix(envio(), 10.55, 0.55, -0.3, 0.2); // bot envia
mix(pop(1250, 0.1), 11.55, 0.55, 0.3, 0.15); // "Sim!"
mix(whoosh(0.4, 600, 5000), 11.95, 0.35, 0, 0.2);
mix(confirma(), 12.45, 0.8, 0, 0.25); // agendado
mix(pop(900, 0.1), 12.5, 0.4, 0, 0.2);
[12.9, 13.15].forEach((t, k) => { mix(whoosh(0.3, 700, 5000), t, 0.3, k ? 0.5 : -0.5, 0.2); mix(snap(), t + 0.25, 0.4, k ? 0.5 : -0.5, 0.15); });
for (let k = 0; k < 8; k++) mix(bip(1568 + (k % 5) * 140), 10.3 + k * 0.55, 0.18, -0.9 + (k % 5) * 0.45, 0.25);
// Cena 4
mix(whoosh(0.6, 300, 5000), 14.8, 0.5, 0, 0.3);
for (let t = 15.3; t < 17.8; t += 0.08 + Math.abs(aleatorio()) * 0.08) mix(toque(2400 + aleatorio() * 900), t, 0.22, aleatorio() * 0.7, 0.05);
for (let x = 0; x < 1; x += 0.06) mix(tique(2000 + x * 1200), 15.9 + 1.5 * (1 - Math.pow(1 - x, 2)), 0.16, 0.2, 0.05);
mix(pop(420, 0.2), 16.3, 0.4, 0.5, 0.2);
mix(sino(88, 1.0), 18.3, 0.35, 0, 0.35); mix(confirma(), 18.55, 0.6, 0.4, 0.25);
// Cena 5
mix(whoosh(0.5, 300, 4000), 20.8, 0.45, 0, 0.3);
[21.2, 21.3].forEach((t, k) => mix(whoosh(0.3, 800, 5000), t, 0.3, k ? 0.4 : -0.4, 0.2));
[22.0, 22.12].forEach((t, k) => mix(filtro(ruido(0.4), 'bp', 2500, 0.8, 1200).map((v, i, a) => v * Math.exp(-i / a.length * 3) * 0.9), t, 0.55, k ? 0.5 : -0.5, 0.2)); // rasgo
mix(riser(0.5), 22.3, 0.4, 0, 0.3);
mix(thud(), 22.8, 1.0, 0, 0.18); mix(subDrop(1.4), 22.8, 0.8, 0, 0.05);
mix(whoosh(0.8, 2000, 9000), 23.1, 0.25, 0.4, 0.3); // light sweep
mix(brilho(1.2, 86), 23.25, 0.35, 0, 0.45);
// Cena 6
mix(riser(0.6), 24.5, 0.45, 0, 0.3); mix(whoosh(0.5, 300, 5000), 24.75, 0.45, 0, 0.3);
mix(pop(620, 0.16), 25.3, 0.6, 0, 0.25);
mix(toque(3000), 26.5, 1.2, 0.2, 0.1); mix(envio(), 26.5, 0.8, 0, 0.25); mix(brilho(1.4, 91), 26.6, 0.45, 0, 0.5);

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
  const fade = Math.min(1, t / 0.08) * (t > 27.7 ? Math.max(0, (28 - t) / 0.3) : 1);
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
