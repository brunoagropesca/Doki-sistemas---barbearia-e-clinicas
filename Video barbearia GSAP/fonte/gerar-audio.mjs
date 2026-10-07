// Trilha e efeitos do Reels GSAP (barbearia), 100% sintetizados - sem licenca de terceiros.
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

// ---------- trilha: 120 BPM, compasso de 2 s, menor e escura ----------
const BATIDA = 0.5;
const ACORDES = [
  { raiz: 33, pad: [57, 60, 64, 67, 71] }, // Am9
  { raiz: 29, pad: [57, 60, 64, 65, 69] }, // Fmaj7
  { raiz: 26, pad: [53, 57, 60, 62, 64] }, // Dm9
  { raiz: 28, pad: [56, 59, 62, 64, 68] }  // E7
];
const acordeEm = (t) => ACORDES[Math.floor(t / 2) % 4];
const groove = (t) => (t >= 3.0 && t < 21.9) || (t >= 22.4 && t < 25.75) || (t >= 26.1 && t < 29.4);

for (let c = 0; c < 15; c++) {
  const t = c * 2; const a = ACORDES[c % 4];
  const vol = t < 3 ? 0.35 : t < 22 ? 0.5 : 0.7;
  mix(pad(a.pad, 2.35, t < 3 ? 3 : 6), t, vol, -0.3, 0.35);
  mix(pad(a.pad.map((n) => n + 12), 2.35, 3), t, vol * 0.3, 0.35, 0.4);
}
mix(pad([45, 52, 57, 60, 64, 71], 2.0, 6), 28.0, 0.8, 0, 0.45);

for (let b = 0; b < DUR / BATIDA; b++) {
  const t = b * BATIDA;
  if (!groove(t)) continue;
  mix(kick(), t, 0.75, 0, 0.03);
  if (b % 2 === 1) mix(clap(), t, 0.42, 0.05, 0.25);
  mix(hat(), t + BATIDA / 2, 0.2, 0.35, 0.05);
  if (t >= 8 && t < 25.7) { mix(hat(0.03), t + BATIDA / 4, 0.09, -0.35, 0.05); mix(hat(0.03), t + 3 * BATIDA / 4, 0.09, -0.35, 0.05); }
}
for (let t = 3.0; t < 29.4; t += 2) {
  const inicio = Math.floor(t / 2) * 2;
  for (const passo of [0, 3, 6, 8, 11, 14]) { const tt = inicio + passo * 0.125; if (!groove(tt)) continue; mix(baixo(acordeEm(tt).raiz + 12, 0.24), tt, 0.48, 0, 0); }
}
for (let tt = 15; tt < 21.9; tt += 0.125) {
  const a = acordeEm(tt); const notas = [...a.pad, a.pad[1] + 12, a.pad[3] + 12]; const passo = Math.round(tt / 0.125);
  mix(pluck(notas[passo % notas.length] + 12), tt, 0.11, passo % 2 ? 0.45 : -0.45, 0.35);
}
for (let i = 0; i < N; i++) { const t = i / SR; if (!groove(t)) continue; const fase = (t % BATIDA) / BATIDA; const d = 1 - 0.45 * Math.exp(-fase * 9); L[i] *= d; R[i] *= d; }

// ---------- efeitos sincronizados com cena/index.html ----------
// Cena 1: lâmina + sub drop + impactos do texto
mix(lamina(), 0.0, 0.9, -0.4, 0.3); mix(lamina(), 0.12, 0.6, 0.4, 0.3);
[0.05, 0.12, 0.2, 0.42].forEach((t, k) => mix(pop(220 + k * 70, 0.12), t + 0.4, 0.5, -0.5 + k * 0.33, 0.15)); // colisões
mix(subDrop(2.0), 0.86, 1.0, 0, 0.05); mix(impacto(), 0.86, 0.7, 0, 0.3);
[0.99, 1.12, 1.25, 1.38].forEach((t, k) => mix(kick(0.7), t, 0.45 + k * 0.05, 0, 0.1));
mix(impacto(), 1.38, 0.5, 0, 0.3);
mix(riser(1.0), 1.7, 0.3, 0, 0.3);
// Cena 2: partículas -> celular, encaixes
mix(brilho(1.6, 84), 2.65, 0.45, 0, 0.5); mix(whoosh(0.8, 250, 6000), 2.9, 0.55, 0.2, 0.3); mix(prato(), 3.0, 0.3, 0, 0.3);
for (let k = 0; k < 7; k++) mix(snap(), 3.55 + k * 0.09, 0.5, -0.5 + k * 0.16, 0.15);
mix(whoosh(1.2, 600, 7000), 4.7, 0.35, -0.6, 0.35); // luz volumétrica
mix(whoosh(0.35, 800, 4000), 6.0, 0.3, 0, 0.2); [6.38, 6.46, 6.55].forEach((t) => mix(snap(), t, 0.55, 0, 0.15));
// Cena 3: agenda
mix(whoosh(0.6, 400, 6000), 7.9, 0.5, 0.3, 0.3);
[9.0, 9.75, 10.5].forEach((t, k) => { mix(confirma(), t + 0.05, 0.7, [-0.3, 0.3, 0][k], 0.25); mix(snap(), t, 0.3, 0, 0.1); });
mix(whoosh(0.5, 500, 6000), 11.35, 0.45, -0.5, 0.25); mix(whoosh(0.6, 300, 5000), 11.7, 0.5, 0.4, 0.3);
for (let k = 0; k < 4; k++) mix(snap(), 12.1 + k * 0.08, 0.35, 0.4 - k * 0.25, 0.15);
for (let x = 0; x < 1; x += 0.07) mix(tique(2000 + x * 1000), 12.5 + 1.3 * (1 - Math.pow(1 - x, 2)), 0.18, 0.2, 0.05);
[13.9, 14.38].forEach((t) => mix(bip(988), t, 0.4, 0, 0.2)); // alerta
// Cena 4: equipe + 5 números
mix(whoosh(0.6, 300, 5000), 14.8, 0.5, 0, 0.3);
for (let t = 15.5; t < 17.4; t += 0.06 + Math.abs(aleatorio()) * 0.07) mix(tecla(), t, 0.28, aleatorio() * 0.6, 0.05);
mix(brilho(1.2, 88), 17.0, 0.35, 0, 0.4);
mix(whoosh(0.5, 600, 5000), 18.0, 0.4, 0, 0.25); mix(pop(500, 0.18), 18.25, 0.6, 0, 0.2);
for (let k = 0; k < 5; k++) mix(snap(), 18.85 + k * 0.08, 0.45, -0.8 + k * 0.4, 0.15);
for (let k = 0; k < 5; k++) for (let rep = 0; rep < 2; rep++) mix(bip(1568 + k * 140), 19.4 + k * 0.42 + rep * 1.85, 0.42, -0.9 + k * 0.45, 0.25); // entregues em estéreo aberto
// Cena 5: vitalício
mix(riser(0.6), 21.6, 0.4, 0, 0.3); mix(whoosh(0.5, 200, 3000), 21.9, 0.5, 0, 0.3);
mix(orquestral(), 22.38, 1.0, 0, 0.45); mix(subDrop(1.8), 22.38, 0.8, 0, 0.05);
[23.2, 23.34, 23.48].forEach((t, k) => mix(lamina(), t - 0.05, 0.35, -0.5 + k * 0.5, 0.2)); // riscos
mix(filtro(ruido(1.0), 'lp', 1500, 0.5).map((v, i, a) => v * Math.sin(Math.PI * i / a.length) * 0.5), 23.75, 0.5, 0, 0.4); // fumaça
mix(sino(69, 2.5), 24.3, 0.5, 0, 0.5); mix(impacto(), 24.3, 0.45, 0, 0.3);
// Cena 6: CTA
mix(whoosh(0.8, 200, 5000), 25.75, 0.5, 0, 0.3);
mix(pop(620, 0.18), 26.3, 0.7, 0, 0.25); mix(brilho(1.2, 86), 26.35, 0.45, 0, 0.45);
mix(whoosh(0.4, 900, 6000), 27.0, 0.3, 0.5, 0.2);
mix(toque(3000), 27.6, 1.2, 0.1, 0.1); mix(pop(900, 0.08), 27.62, 0.8, 0, 0.15); mix(brilho(1.8, 91), 27.65, 0.55, 0, 0.5); // clique satisfatório
mix(whoosh(0.5, 400, 7000), 29.45, 0.45, 0, 0.3); // fechamento rápido

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
  const fade = Math.min(1, t / 0.08) * (t > 29.6 ? Math.max(0, (30 - t) / 0.4) : 1);
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
