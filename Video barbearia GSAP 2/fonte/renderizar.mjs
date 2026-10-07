// node renderizar.mjs quadros 1,4,9 saida/      -> PNGs de conferência
// node renderizar.mjs video saida.mp4 [sub=4]    -> MP4 30 fps com motion blur (sub-quadros)
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright'; // npm i playwright
const [modo, a1, a2, fpsA = '60', durA = '28'] = process.argv.slice(2);
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), 'cena');
const tipos = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };
const srv = http.createServer((req, res) => { const arq = join(raiz, decodeURIComponent(req.url === '/' ? '/index.html' : req.url.split('?')[0]));
  try { statSync(arq); } catch { res.statusCode = 404; return res.end(); } res.setHeader('content-type', tipos[extname(arq)] ?? 'application/octet-stream'); createReadStream(arq).pipe(res); }).listen(0);
const b = await chromium.launch({ args: ['--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.error('ERRO NA PAGINA', e.message));
await p.goto(`http://127.0.0.1:${srv.address().port}/`); await p.evaluate(() => window.preparar());
const foto = async (t, type) => { await p.evaluate((t) => window.render(t), t); return p.screenshot({ type, quality: type === 'jpeg' ? 92 : undefined }); };
if (modo === 'quadros') { mkdirSync(a2, { recursive: true }); for (const t of a1.split(',').map(Number)) writeFileSync(join(a2, `t${t.toFixed(2).padStart(5, '0')}.png`), await foto(t, 'png')); }
else {
  const sub = Number(a2 ?? 2), fps = Number(fpsA), total = Math.round(Number(durA) * fps);
  // sub-quadros por quadro, misturados pelo ffmpeg (tmix) = motion blur real (obturador ~270°)
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps * sub), '-c:v', 'mjpeg', '-i', '-',
    '-vf', `tmix=frames=${sub}:weights='${Array(sub).fill(1).join(' ')}',select='not(mod(n+1\\,${sub}))',setpts=N/${fps}/TB`, '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', a1], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ini = Date.now();
  for (let n = 0; n < total; n++) for (let s = 0; s < sub; s++) {
    const t = (n + (s - (sub - 1)) * 0.5 / sub) / fps; // amostras espalhadas em 75% do intervalo, terminando no instante do quadro
    const buf = await foto(Math.max(0, t), 'jpeg'); if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (s === 0 && n % 60 === 0) console.log(`quadro ${n}/${total} ${((Date.now() - ini) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end(); await new Promise((r) => ff.on('close', r)); console.log('video ok');
}
await b.close(); srv.close();
