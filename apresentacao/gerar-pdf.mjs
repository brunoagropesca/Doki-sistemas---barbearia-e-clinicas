import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function gerar() {
  const dbg = 9920 + Math.floor(Math.random() * 50);
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new',
    `--remote-debugging-port=${dbg}`,
    '--no-first-run',
    '--hide-scrollbars',
    'about:blank'
  ], { stdio: 'ignore' });

  let alvos;
  for (let i = 0; i < 50; i++) {
    try {
      alvos = await fetch(`http://127.0.0.1:${dbg}/json`).then(r => r.json());
      break;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  if (!alvos) {
    chrome.kill();
    throw new Error('Falha ao conectar com Chrome');
  }

  const wsUrl = alvos.find(t => t.type === 'page').webSocketDebuggerUrl;
  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.addEventListener('open', r));

  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  });

  const send = (method, params = {}) => new Promise(r => {
    const i = ++id;
    pend.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  await send('Page.enable');
  const fileUrl = pathToFileURL(resolve('apresentacao-documento.html')).href;
  console.log('Carregando:', fileUrl);
  await send('Page.navigate', { url: fileUrl });
  
  // Espera carregar fontes do Google e prints locais
  await new Promise(r => setTimeout(r, 3000));

  const res = await send('Page.printToPDF', {
    printBackground: true,
    preferCSSPageSize: true
  });

  if (!res.result?.data) {
    chrome.kill();
    throw new Error('Erro ao renderizar PDF: ' + JSON.stringify(res));
  }

  const pdfBuffer = Buffer.from(res.result.data, 'base64');
  const outPath = resolve('Apresentacao-Comercial-Doki-Sistemas.pdf');
  writeFileSync(outPath, pdfBuffer);
  console.log('PDF gerado com sucesso em:', outPath, 'Bytes:', pdfBuffer.length);

  chrome.kill();
  process.exit(0);
}

gerar().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
