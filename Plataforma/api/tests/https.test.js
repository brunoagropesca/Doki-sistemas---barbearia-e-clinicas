import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as pedirHttp } from 'node:http';
import { request as pedirHttps } from 'node:https';
import { connect as conectarTls, createServer as criarServidorTls } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarAppDeTeste } from './helpers/ambiente.js';
import {
  gerarAutoridade,
  gerarCertificadoServidor,
  prepararCertificados,
  VALIDADE_SERVIDOR_DIAS
} from '../src/http/certificados.js';
import { escutarComHttps } from '../src/http/https.js';

/**
 * HTTPS da loja (http/certificados.js e http/https.js): certificados feitos
 * aqui mesmo, conferidos com o Node e com um handshake TLS de verdade
 * (OpenSSL), e a porta que atende HTTP (redireciona) e HTTPS juntos.
 */

const DIA = 86_400_000;
const COMPUTADOR = 'PC-DA-LOJA';
const pastas = [];
const pastaTemporaria = () => {
  const p = mkdtempSync(join(tmpdir(), 'https-'));
  pastas.push(p);
  return p;
};

after(() => {
  for (const p of pastas) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // pasta temporaria
    }
  }
});

/** Handshake TLS de verdade contra um servidor com `cert`, confiando so em `ca`. */
async function handshake({ chave, cert }, ca, servername) {
  const servidor = criarServidorTls({ key: chave, cert }, (s) => s.end());
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  try {
    return await new Promise((ok) => {
      const s = conectarTls({ host: '127.0.0.1', port: servidor.address().port, ca, servername }, () => {
        ok({ autorizado: s.authorized, erro: null });
        s.end();
      });
      // A mensagem (e nao o codigo): o Node mapeia a violacao de name constraints como 'UNSPECIFIED'.
      s.on('error', (err) => ok({ autorizado: false, erro: err.message }));
    });
  } finally {
    servidor.close();
  }
}

describe('certificados feitos aqui (DER a mao)', () => {
  const ca = gerarAutoridade({ computador: COMPUTADOR });
  const servidor = gerarCertificadoServidor(ca, { computador: COMPUTADOR, ips: ['192.168.0.50', '10.0.0.7', '8.8.8.8'] });
  const x509Ca = new X509Certificate(ca.cert);
  const x509 = new X509Certificate(servidor.cert);

  it('a autoridade e autoridade; o do servidor nao, e foi assinado por ela', () => {
    assert.equal(x509Ca.ca, true);
    assert.equal(x509.ca, false);
    assert.ok(x509.checkIssued(x509Ca));
    assert.ok(x509.verify(x509Ca.publicKey), 'assinatura confere com a chave da autoridade');
  });

  it('vale para localhost, o nome do computador, 127.0.0.1 e os IPs LOCAIS (IP de fora nao entra)', () => {
    const san = x509.subjectAltName.split(', ');
    for (const item of ['DNS:localhost', 'DNS:pc-da-loja', 'DNS:pc-da-loja.local', 'IP Address:127.0.0.1', 'IP Address:192.168.0.50', 'IP Address:10.0.0.7']) {
      assert.ok(san.includes(item), `${item} em ${x509.subjectAltName}`);
    }
    assert.ok(!san.includes('IP Address:8.8.8.8'));
    assert.deepEqual(x509.keyUsage, ['1.3.6.1.5.5.7.3.1'], 'certificado de servidor TLS');
  });

  it('validade dentro do limite do iPhone (398 dias)', () => {
    const dias = (Date.parse(x509.validTo) - Date.parse(x509.validFrom)) / DIA;
    assert.ok(dias <= 398, `${dias} dias`);
    assert.equal(Math.round(dias), VALIDADE_SERVIDOR_DIAS + 1);
  });

  it('handshake TLS de verdade: confiando na autoridade, fecha por nome e por IP', async () => {
    assert.deepEqual(await handshake(servidor, ca.cert, 'localhost'), { autorizado: true, erro: null });
    assert.deepEqual(await handshake(servidor, ca.cert, undefined), { autorizado: true, erro: null }, 'pelo IP 127.0.0.1');
  });

  it('sem instalar a autoridade, o navegador/celular desconfia', async () => {
    const r = await handshake(servidor, undefined, 'localhost');
    assert.equal(r.autorizado, false);
  });

  it('a autoridade so assina nomes desta loja (name constraints): um certificado para outro nome e recusado', async () => {
    // Montado com a autoridade da loja, mas para um nome que ela NAO pode assinar.
    const intruso = gerarCertificadoServidor(ca, { computador: 'banco.com.br', ips: [] });
    const r = await handshake(intruso, ca.cert, 'localhost');
    assert.equal(r.autorizado, false);
    assert.match(String(r.erro), /permitted subtree violation/i);
  });
});

describe('em disco (api/data/https)', () => {
  it('rodar de novo nao troca a autoridade nem o certificado', () => {
    const pasta = pastaTemporaria();
    const a = prepararCertificados({ pasta, computador: COMPUTADOR, ips: ['192.168.0.50'] });
    const b = prepararCertificados({ pasta, computador: COMPUTADOR, ips: ['192.168.0.50'] });
    assert.equal(a.autoridadeNova, true);
    assert.equal(b.autoridadeNova, false);
    assert.equal(b.servidorNovo, false);
    assert.equal(b.autoridadePem, a.autoridadePem);
    assert.equal(b.cert, a.cert);
  });

  it('IP novo: refaz so o certificado do servidor (os aparelhos nao precisam fazer nada)', () => {
    const pasta = pastaTemporaria();
    const a = prepararCertificados({ pasta, computador: COMPUTADOR, ips: ['192.168.0.50'] });
    const b = prepararCertificados({ pasta, computador: COMPUTADOR, ips: ['192.168.0.77'] });
    assert.equal(b.autoridadeNova, false);
    assert.equal(b.servidorNovo, true);
    assert.equal(b.autoridadePem, a.autoridadePem);
    assert.match(new X509Certificate(b.cert).subjectAltName, /IP Address:192\.168\.0\.77/);
  });

  it('nome do computador mudou: a autoridade e refeita (ela so vale para o nome antigo)', () => {
    const pasta = pastaTemporaria();
    const a = prepararCertificados({ pasta, computador: COMPUTADOR, ips: [] });
    const b = prepararCertificados({ pasta, computador: 'PC-NOVO', ips: [] });
    assert.equal(b.autoridadeNova, true);
    assert.notEqual(b.autoridadePem, a.autoridadePem);
  });
});

describe('a porta da loja: HTTP e HTTPS juntos', () => {
  let app;
  let escuta;
  let escutaComLocal;
  let certs;

  /** Pedido cru, com a autoridade da loja como unica confianca no HTTPS. */
  const pedir = (url, { method = 'GET', corpo, headers = {} } = {}) =>
    new Promise((ok, falhou) => {
      const alvo = new URL(url);
      const funcao = alvo.protocol === 'https:' ? pedirHttps : pedirHttp;
      const req = funcao(
        alvo,
        { method, ca: certs.autoridadePem, headers: { ...headers, ...(corpo ? { 'content-type': 'application/json' } : {}) } },
        (res) => {
          const partes = [];
          res.on('data', (p) => partes.push(p));
          res.on('end', () => ok({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(partes) }));
        }
      );
      req.on('error', falhou);
      if (corpo) req.write(JSON.stringify(corpo));
      req.end();
    });

  before(async () => {
    certs = prepararCertificados({ pasta: pastaTemporaria(), computador: COMPUTADOR, ips: [] });
    ({ app } = await criarAppDeTeste({ https: certs }));
    // isentarLocal: false — nos testes todo pedido vem de 127.0.0.1; assim ele e tratado como um celular do Wi-Fi.
    escuta = await escutarComHttps(app, { port: 0, host: '127.0.0.1', isentarLocal: false });
    escutaComLocal = await escutarComHttps(app, { port: 0, host: '127.0.0.1' });
  });

  after(async () => {
    await escuta?.fechar();
    await escutaComLocal?.fechar();
    await app?.close();
  });

  it('HTTP pelo Wi-Fi redireciona para HTTPS, no mesmo endereco e porta', async () => {
    const r = await pedir(`http://127.0.0.1:${escuta.porta}/agenda?data=2026-09-30`);
    assert.equal(r.status, 308);
    assert.equal(r.headers.location, `https://127.0.0.1:${escuta.porta}/agenda?data=2026-09-30`);
  });

  it('menos a pagina de instalacao e o arquivo da autoridade (antes de instalar, o HTTPS ainda da aviso)', async () => {
    const pagina = await pedir(`http://127.0.0.1:${escuta.porta}/instalar-certificado`);
    assert.equal(pagina.status, 200);
    assert.match(pagina.corpo.toString(), /Baixar o certificado/);
    assert.match(pagina.corpo.toString(), new RegExp(`https://127\\.0\\.0\\.1:${escuta.porta}/`));

    const arquivo = await pedir(`http://127.0.0.1:${escuta.porta}/instalar-certificado/autoridade.crt`);
    assert.equal(arquivo.status, 200);
    assert.equal(arquivo.headers['content-type'], 'application/x-x509-ca-cert');
    assert.equal(new X509Certificate(arquivo.corpo).ca, true);
    assert.equal(new X509Certificate(arquivo.corpo).fingerprint256, new X509Certificate(certs.autoridadePem).fingerprint256);
  });

  it('HTTPS atende, com HSTS curto (1 dia)', async () => {
    const r = await pedir(`https://127.0.0.1:${escuta.porta}/health`);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.corpo).ok, true);
    assert.equal(r.headers['strict-transport-security'], 'max-age=86400');
  });

  it('login por HTTPS: cookie de sessao com Secure', async () => {
    const r = await pedir(`https://127.0.0.1:${escuta.porta}/api/auth/login`, {
      method: 'POST',
      corpo: { username: 'dono', senha: 'trocar@123' }
    });
    assert.equal(r.status, 200, r.corpo.toString());
    assert.match(String(r.headers['set-cookie']), /Secure/i);
  });

  it('o proprio computador da loja (localhost) segue em HTTP, sem redirecionar e sem HSTS', async () => {
    const r = await pedir(`http://127.0.0.1:${escutaComLocal.porta}/health`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['strict-transport-security'], undefined);
  });
});
