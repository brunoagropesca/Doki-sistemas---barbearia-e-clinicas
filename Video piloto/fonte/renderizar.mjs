// Uso:
//   node renderizar.mjs quadros 0.8,4,9,13 saida/   -> PNGs desses instantes (conferencia)
//   node renderizar.mjs video saida.mp4 [fps=30] [duracao=30]
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';

const [modo, arg1, arg2, fpsArg = '30', durArg = '30'] = process.argv.slice(2);
const raiz = resolve('cena');
const tipos = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };
const servidor = http.createServer((req, res) => {
  const arq = join(raiz, decodeURIComponent(req.url === '/' ? '/index.html' : req.url.split('?')[0]));
  try { statSync(arq); } catch { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', tipos[extname(arq)] ?? 'application/octet-stream');
  createReadStream(arq).pipe(res);
}).listen(0);
const porta = servidor.address().port;

const dbg = 9900 + Math.floor(Math.random() * 90);
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${dbg}`, '--no-first-run', '--hide-scrollbars', `--user-data-dir=${resolve('.chrome-video')}`, 'about:blank'], { stdio: 'ignore' });
let alvos;
for (let i = 0; i < 100; i++) { try { alvos = await fetch(`http://127.0.0.1:${dbg}/json`).then((r) => r.json()); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const ws = new WebSocket(alvos.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const avaliar = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};

await send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false });
await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${porta}/` });
for (let i = 0; i < 100 && !(await avaliar('typeof window.preparar === "function" && document.readyState === "complete"').catch(() => false)); i++) await new Promise((r) => setTimeout(r, 200));
await avaliar('window.preparar()');

const foto = async (t, formato) => {
  await avaliar(`window.render(${t})`);
  const r = await send('Page.captureScreenshot', { format: formato, quality: formato === 'jpeg' ? 94 : undefined, clip: { x: 0, y: 0, width: 1080, height: 1920, scale: 1 } });
  return Buffer.from(r.result.data, 'base64');
};

if (modo === 'quadros') {
  mkdirSync(arg2, { recursive: true });
  for (const t of arg1.split(',').map(Number)) writeFileSync(join(arg2, `t${String(t).padStart(5, '0')}.png`), await foto(t, 'png'));
  console.log('quadros ok');
} else {
  const ffmpeg = process.env.FFMPEG;
  const fps = Number(fpsArg), dur = Number(durArg), total = Math.round(fps * dur);
  const ff = spawn(ffmpeg, ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', String(fps), arg1], { stdio: ['pipe', 'ignore', 'inherit'] });
  const inicio = Date.now();
  for (let n = 0; n < total; n++) {
    const buf = await foto(n / fps, 'jpeg');
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (n % 90 === 0) console.log(`quadro ${n}/${total} (${((Date.now() - inicio) / 1000).toFixed(0)} s)`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log('video ok');
}
ws.close(); chrome.kill(); servidor.close();
