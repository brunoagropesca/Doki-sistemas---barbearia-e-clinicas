import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, eq } from 'drizzle-orm';
import { criarAppDeTeste } from './helpers/ambiente.js';
import { comSegredo, prepararEnv } from '../src/db/preparar-env.js';
import { SEGREDO_PADRAO } from '../src/config/segredo-padrao.js';
import { cifrarCom, decifrarCom } from '../src/core/crypto.js';
import * as s from '../src/db/schema/index.js';

/**
 * Segredo proprio em cada instalacao (db/preparar-env.js).
 *
 * O APP_SECRET de fabrica e publico (esta no git) e cifra as chaves de IA:
 * cada instalacao precisa do seu, e as instalacoes antigas precisam trocar SEM
 * perder as chaves ja cadastradas. Tudo aqui roda em pastas TEMPORARIAS.
 */

const PASTA_API = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELO = readFileSync(join(PASTA_API, '.env.example'), 'utf8');
const pastas = [];

function pastaTemporaria() {
  const p = mkdtempSync(join(tmpdir(), 'segredo-'));
  pastas.push(p);
  return p;
}

const segredoDo = (pasta) => parseEnv(readFileSync(join(pasta, '.env'), 'utf8')).APP_SECRET;

after(() => {
  // No Windows o libsql solta o arquivo do banco um pouco depois de fechado:
  // tenta de novo e, se ainda assim nao der, deixa para a limpeza do sistema.
  for (const p of pastas) {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // pasta temporaria; nao reprova o teste
    }
  }
});

describe('o texto do .env', () => {
  it('troca so a linha do APP_SECRET, mantendo comentarios e o fim de linha', () => {
    const crlf = '# comentario\r\nPORT=3333\r\nAPP_SECRET=velho\r\nHOST=127.0.0.1\r\n';
    assert.equal(comSegredo(crlf, 'novo'), '# comentario\r\nPORT=3333\r\nAPP_SECRET=novo\r\nHOST=127.0.0.1\r\n');
    const lf = 'PORT=1\nAPP_SECRET=x\n';
    assert.equal(comSegredo(lf, 'y'), 'PORT=1\nAPP_SECRET=y\n');
  });

  it('sem a linha, acrescenta no fim', () => {
    assert.equal(comSegredo('PORT=1\n', 'y'), 'PORT=1\nAPP_SECRET=y\n');
  });
});

describe('prepararEnv', () => {
  const semBanco = async () => ({ recifradas: 0, ilegiveis: 0 });

  it('sem .env: cria a partir do modelo com um segredo aleatorio de 64 hex; rodar de novo nao troca', async () => {
    const pasta = pastaTemporaria();
    writeFileSync(join(pasta, '.env.example'), MODELO);

    assert.equal((await prepararEnv({ pasta, recifrar: semBanco })).acao, 'criado');
    const segredo = segredoDo(pasta);
    assert.match(segredo, /^[0-9a-f]{64}$/);
    // O resto do arquivo e o modelo, intacto.
    assert.equal(readFileSync(join(pasta, '.env'), 'utf8'), comSegredo(MODELO, segredo));

    assert.equal((await prepararEnv({ pasta, recifrar: semBanco })).acao, 'nada');
    assert.equal(segredoDo(pasta), segredo);
  });

  it('duas instalacoes nunca ficam com o mesmo segredo', async () => {
    const [a, b] = [pastaTemporaria(), pastaTemporaria()];
    for (const p of [a, b]) {
      writeFileSync(join(p, '.env.example'), MODELO);
      await prepararEnv({ pasta: p, recifrar: semBanco });
    }
    assert.notEqual(segredoDo(a), segredoDo(b));
  });

  it('.env com o segredo de fabrica: recifra do antigo para o novo e so entao grava', async () => {
    const pasta = pastaTemporaria();
    writeFileSync(join(pasta, '.env'), MODELO);
    let pedido;
    const r = await prepararEnv({
      pasta,
      recifrar: async (dados) => {
        pedido = dados;
        // Durante a recifragem o .env ainda e o antigo.
        assert.equal(segredoDo(pasta), SEGREDO_PADRAO);
        return { recifradas: 2, ilegiveis: 0 };
      }
    });
    assert.equal(r.acao, 'trocado');
    assert.equal(r.recifradas, 2);
    assert.equal(pedido.de, SEGREDO_PADRAO);
    assert.equal(segredoDo(pasta), pedido.para);
    assert.equal(existsSync(join(pasta, '.env.novo')), false);
  });

  it('com segredo proprio: nao faz nada nem chama a recifragem', async () => {
    const pasta = pastaTemporaria();
    writeFileSync(join(pasta, '.env'), comSegredo(MODELO, 'a'.repeat(64)));
    const r = await prepararEnv({ pasta, recifrar: () => assert.fail('nao devia recifrar') });
    assert.equal(r.acao, 'nada');
  });

  it('falha na recifragem: o .env fica como estava, e a retomada usa o MESMO segredo novo', async () => {
    const pasta = pastaTemporaria();
    writeFileSync(join(pasta, '.env'), MODELO);

    let primeiro;
    await assert.rejects(
      prepararEnv({
        pasta,
        recifrar: async ({ para }) => {
          primeiro = para;
          throw new Error('banco ocupado');
        }
      }),
      /banco ocupado/
    );
    assert.equal(readFileSync(join(pasta, '.env'), 'utf8'), MODELO, 'o .env nao pode mudar');

    // Retomada: se o banco chegou a ser recifrado com `primeiro`, sortear outro
    // segredo perderia as chaves — tem de ser o mesmo.
    let segundo;
    await prepararEnv({
      pasta,
      recifrar: async ({ para }) => {
        segundo = para;
        return { recifradas: 0, ilegiveis: 0 };
      }
    });
    assert.equal(segundo, primeiro);
    assert.equal(segredoDo(pasta), primeiro);
  });
});

describe('recifrarSegredos (banco)', () => {
  let app;
  let tenantId;
  const NOVO = 'b'.repeat(64);

  before(async () => {
    const criado = await criarAppDeTeste();
    app = criado.app;
    tenantId = criado.tenant.id;
  });

  after(async () => {
    await app?.close();
  });

  it('as chaves de IA e a do Hades passam a abrir com o segredo novo; rodar de novo nao estraga', async () => {
    const { db } = await import('../src/db/client.js');
    const { recifrarSegredos } = await import('../src/modules/dados/trocar-segredo.js');

    await db.delete(s.aiProviders).where(eq(s.aiProviders.tenantId, tenantId));
    await db.insert(s.aiProviders).values([
      { id: 'aip_seg_1', tenantId, provedor: 'groq', apiKeyCifrada: cifrarCom('gsk-chave-groq', SEGREDO_PADRAO) },
      { id: 'aip_seg_2', tenantId, provedor: 'openai', apiKeyCifrada: 'v1.lixo.lixo.lixo' }
    ]);
    await db.delete(s.settings).where(and(eq(s.settings.tenantId, tenantId), eq(s.settings.chave, 'hades.config')));
    await db.insert(s.settings).values({
      tenantId,
      chave: 'hades.config',
      valor: { ativo: true, nome: 'Hades', chaveCifrada: cifrarCom('chave-do-hades', SEGREDO_PADRAO) }
    });

    const r = await recifrarSegredos(db, { de: SEGREDO_PADRAO, para: NOVO });
    assert.deepEqual(r, { recifradas: 2, jaNoNovo: 0, ilegiveis: 1 });

    const [groq] = await db.select().from(s.aiProviders).where(eq(s.aiProviders.id, 'aip_seg_1'));
    assert.equal(decifrarCom(groq.apiKeyCifrada, NOVO), 'gsk-chave-groq');
    assert.equal(decifrarCom(groq.apiKeyCifrada, SEGREDO_PADRAO), null, 'o segredo publico nao abre mais');

    const [hades] = await db.select().from(s.settings).where(and(eq(s.settings.tenantId, tenantId), eq(s.settings.chave, 'hades.config')));
    assert.equal(decifrarCom(hades.valor.chaveCifrada, NOVO), 'chave-do-hades');
    assert.equal(hades.valor.nome, 'Hades', 'o resto da configuracao do Hades fica');

    // O valor ilegivel continua la (nao se destroi a unica copia).
    const [lixo] = await db.select().from(s.aiProviders).where(eq(s.aiProviders.id, 'aip_seg_2'));
    assert.equal(lixo.apiKeyCifrada, 'v1.lixo.lixo.lixo');

    // Retomada de uma troca interrompida: o que ja esta no novo fica.
    const de2 = await recifrarSegredos(db, { de: SEGREDO_PADRAO, para: NOVO });
    assert.deepEqual(de2, { recifradas: 0, jaNoNovo: 2, ilegiveis: 1 });
  });

  it('so ia.service e hades.config cifram: quem cifrar algo novo tem de entrar na recifragem', () => {
    const src = join(PASTA_API, 'src');
    const achados = [];
    const andar = (pasta) => {
      for (const nome of readdirSync(pasta, { withFileTypes: true })) {
        const caminho = join(pasta, nome.name);
        if (nome.isDirectory()) andar(caminho);
        else if (nome.name.endsWith('.js') && /[^.\w]cifrar(Com)?\(/.test(readFileSync(caminho, 'utf8'))) {
          achados.push(relative(src, caminho).split(sep).join('/'));
        }
      }
    };
    andar(src);
    assert.deepEqual(
      achados.filter((a) => !['core/crypto.js', 'modules/dados/trocar-segredo.js'].includes(a)).sort(),
      ['modules/hades/hades.config.js', 'modules/ia/ia.service.js']
    );
  });
});

describe('de ponta a ponta (npm run env:preparar numa instalacao antiga)', () => {
  /** Ambiente do processo filho SEM as variaveis dos testes (senao elas ganhariam do .env). */
  const ambienteLimpo = () => {
    const doTeste = Object.keys(parseEnv(readFileSync(join(PASTA_API, '.env.test'), 'utf8')));
    const e = { ...process.env };
    for (const chave of [...doTeste, 'NODE_ENV', 'PASTA_ARQUIVOS']) delete e[chave];
    return e;
  };

  it('troca o segredo, recifra a chave e faz backup antes', { timeout: 60_000 }, async () => {
    const pasta = pastaTemporaria();
    const barra = (p) => p.split(sep).join('/');
    const banco = join(pasta, 'data', 'plataforma.db');

    // Instalacao "antiga": .env de fabrica apontando tudo para a pasta temporaria.
    const trocas = {
      DATABASE_URL: `file:${barra(banco)}`,
      BACKUP_DIR: barra(join(pasta, 'data', 'backups')),
      PASTA_ARQUIVOS: barra(join(pasta, 'data', 'uploads')),
      WHATSAPP_AUTH_DIR: barra(join(pasta, 'data', 'whatsapp')),
      LICENCA_ARQUIVO: barra(join(pasta, 'data', 'licenca.json')),
      LOG_LEVEL: 'silent',
      PAINEL_ATIVO: 'false'
    };
    // O modelo de verdade, sem as linhas que apontariam para a pasta real (nada de chave repetida).
    const modelo = MODELO.split(/\r?\n/).filter((l) => !Object.keys(trocas).some((k) => l.startsWith(`${k}=`)));
    const linhas = [...modelo, ...Object.entries(trocas).map(([k, v]) => `${k}=${v}`), ''];
    writeFileSync(join(pasta, '.env'), comSegredo(linhas.join('\n'), SEGREDO_PADRAO));

    // Banco com uma chave cifrada com o segredo de fabrica e uma sessao aberta.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(pasta, 'data'), { recursive: true });
    const cliente = createClient({ url: `file:${banco}` });
    const bd = drizzle(cliente, { schema: s });
    await migrate(bd, { migrationsFolder: join(PASTA_API, 'src', 'db', 'migrations') });
    await bd.insert(s.tenants).values({ id: 'tnt_seg', nome: 'Antiga', slug: 'antiga' });
    await bd.insert(s.aiProviders).values({
      id: 'aip_seg',
      tenantId: 'tnt_seg',
      provedor: 'gemini',
      apiKeyCifrada: cifrarCom('AIza-chave-real', SEGREDO_PADRAO)
    });
    cliente.close();

    const rodar = () =>
      spawnSync(process.execPath, ['src/db/preparar-env.js', '--pasta', pasta], {
        cwd: PASTA_API,
        env: ambienteLimpo(),
        encoding: 'utf8'
      });

    const r = rodar();
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /recifradas: 1/);

    const segredo = segredoDo(pasta);
    assert.match(segredo, /^[0-9a-f]{64}$/);

    const depois = createClient({ url: `file:${banco}` });
    const [linha] = (await depois.execute(`select api_key_cifrada from ai_providers where id = 'aip_seg'`)).rows;
    depois.close();
    assert.equal(decifrarCom(linha.api_key_cifrada, segredo), 'AIza-chave-real');

    const backups = readdirSync(join(pasta, 'data', 'backups')).filter((n) => n.includes('antes_de_trocar_segredo'));
    assert.equal(backups.length, 1, 'backup antes da troca');

    // Rodar de novo (todo INICIAR.bat roda) nao muda nada.
    const r2 = rodar();
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(segredoDo(pasta), segredo);
  });
});

describe('env.js', () => {
  const importarEnv = (extra) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config/env.js')"], {
      cwd: PASTA_API,
      env: { ...process.env, APP_SECRET: SEGREDO_PADRAO, ...extra },
      encoding: 'utf8'
    });

  it('recusa o segredo de fabrica fora dos testes (development tambem)', () => {
    for (const NODE_ENV of ['development', 'production']) {
      const r = importarEnv({ NODE_ENV });
      assert.equal(r.status, 1, `${NODE_ENV} devia recusar`);
      assert.match(r.stderr, /INICIAR\.bat/);
    }
  });

  it('aceita com NODE_ENV=test, e aceita um segredo proprio em development', () => {
    assert.equal(importarEnv({ NODE_ENV: 'test' }).status, 0);
    assert.equal(importarEnv({ NODE_ENV: 'development', APP_SECRET: 'c'.repeat(64) }).status, 0);
  });
});
