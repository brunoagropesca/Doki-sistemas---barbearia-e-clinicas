import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../src/config/env.js';
import { apenas } from '../src/http/plugins/autenticacao.js';

/**
 * Modo loja: a API serve as telas compiladas (web/dist) — http/telas.js.
 * Nada aqui usa o banco: um `dist` de mentira numa pasta temporaria e um app
 * montado a mao (para registrar uma rota que explode de proposito).
 */

const pasta = mkdtempSync(join(tmpdir(), 'telas-'));
mkdirSync(join(pasta, 'assets'));
mkdirSync(join(pasta, 'icones'));
writeFileSync(join(pasta, 'index.html'), '<!doctype html><div id="raiz">TELA-DO-SISTEMA</div>');
writeFileSync(join(pasta, 'assets', 'index-abc123.js'), 'console.log("tela")');
writeFileSync(join(pasta, 'sw.js'), '// service worker');
writeFileSync(join(pasta, 'icones', 'icone-192.png'), 'png');

let app;
let semTelas;
const pastaOriginal = env.PASTA_TELAS;
const ambienteOriginal = env.NODE_ENV;

const get = (url, alvo = app) => alvo.inject({ method: 'GET', url });

before(async () => {
  const { criarApp } = await import('../src/app.js');

  env.PASTA_TELAS = pasta;
  app = await criarApp();
  // Um "bug nosso" de proposito, para ver o que o 500 devolve.
  app.get('/api/teste/explode', { config: apenas.publico }, async () => {
    throw new Error('detalhe interno que o navegador nao pode ver');
  });
  await app.ready();

  // Desenvolvimento: sem web/dist, a API nao serve tela nenhuma (quem serve e o Vite).
  env.PASTA_TELAS = join(pasta, 'nao-existe');
  semTelas = await criarApp();
  await semTelas.ready();
});

after(async () => {
  env.PASTA_TELAS = pastaOriginal;
  env.NODE_ENV = ambienteOriginal;
  await app?.close();
  await semTelas?.close();
  const { fecharBanco } = await import('../src/db/client.js');
  fecharBanco();
  try {
    rmSync(pasta, { recursive: true, force: true });
  } catch {
    // pasta temporaria
  }
});

describe('as telas pela API', () => {
  it('GET / e qualquer tela do React (/agenda, /conversas/123) devolvem o index.html, sem cache', async () => {
    for (const url of ['/', '/agenda', '/conversas/123', '/entrar']) {
      const res = await get(url);
      assert.equal(res.statusCode, 200, url);
      assert.match(res.headers['content-type'], /text\/html/, url);
      assert.match(res.body, /TELA-DO-SISTEMA/, url);
      assert.equal(res.headers['cache-control'], 'no-cache', url);
    }
  });

  it('os arquivos das telas sao publicos (a tela de login precisa deles sem login)', async () => {
    const res = await get('/assets/index-abc123.js');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /javascript/);
    assert.equal(res.body, 'console.log("tela")');
  });

  it('cache: assets com hash por 1 ano; sw.js sem cache; icones por 1 dia', async () => {
    assert.equal((await get('/assets/index-abc123.js')).headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal((await get('/sw.js')).headers['cache-control'], 'no-cache');
    assert.equal((await get('/icones/icone-192.png')).headers['cache-control'], 'public, max-age=86400');
  });

  it('/api inexistente continua 404 em JSON (nunca a tela); as rotas da API seguem iguais', async () => {
    const res = await get('/api/xyz');
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().erro.codigo, 'ROTA_NAO_ENCONTRADA');
    assert.equal((await get('/api')).statusCode, 404);

    const saude = await get('/health');
    assert.equal(saude.statusCode, 200);
    assert.equal(saude.json().ok, true);
  });

  it('nao sai da pasta das telas (nem com ".." codificado)', async () => {
    for (const url of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/assets/..%2f..%2f..%2fapi%2f.env', '/%252e%252e/package.json']) {
      const res = await get(url);
      assert.doesNotMatch(res.body, /"dependencies"|APP_SECRET/, url);
    }
  });

  it('sem web/dist (desenvolvimento), a API nao serve tela', async () => {
    const res = await get('/', semTelas);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().erro.codigo, 'ROTA_NAO_ENCONTRADA');
  });
});

describe('erro 500', () => {
  it('em producao NAO devolve o detalhe nem o stack trace', async () => {
    env.NODE_ENV = 'production';
    const res = await get('/api/teste/explode');
    env.NODE_ENV = ambienteOriginal;
    assert.equal(res.statusCode, 500);
    const erro = res.json().erro;
    assert.equal(erro.codigo, 'ERRO_INTERNO');
    assert.equal(erro.debug, undefined);
    assert.equal(erro.stack, undefined);
    assert.doesNotMatch(res.body, /detalhe interno/);
  });

  it('em desenvolvimento devolve o detalhe (para quem programa)', async () => {
    env.NODE_ENV = 'development';
    const res = await get('/api/teste/explode');
    env.NODE_ENV = ambienteOriginal;
    assert.equal(res.statusCode, 500);
    assert.match(res.json().erro.debug, /detalhe interno/);
  });
});
