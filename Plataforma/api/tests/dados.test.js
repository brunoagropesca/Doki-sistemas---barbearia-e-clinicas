import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { env } from '../src/config/env.js';
import { garantirUsuarioDev } from '../src/db/usuario-dev.js';

/**
 * Backups e limpeza de dados (perfil DEV).
 *
 * O que importa guardar: apagar SEMPRE deixa um backup antes, nunca leva os
 * donos, e a restauracao troca o banco inteiro so no proximo inicio.
 */

let app;
let cabDono;
let cabDev;
let tenantId;
let db;
let s;

const pastaBackups = () => resolve(env.BACKUP_DIR);

before(async () => {
  rmSync(pastaBackups(), { recursive: true, force: true });
  ({ app } = await criarAppDeTeste());
  const dono = await entrar(app);
  cabDono = dono.cabecalho;
  tenantId = dono.usuario.tenantId;
  await garantirUsuarioDev({ username: 'dev.dados', nome: 'Dev Dados', senha: 'senha-dev-12345' });
  ({ cabecalho: cabDev } = await entrar(app, 'dev.dados', 'senha-dev-12345'));
  ({ db } = await import('../src/db/client.js'));
  s = await import('../src/db/schema/index.js');
});

after(async () => {
  await app?.close();
  rmSync(pastaBackups(), { recursive: true, force: true });
});

const contar = async (tabela) => (await db.select().from(tabela).where(eq(tabela.tenantId, tenantId))).length;

describe('backups', () => {
  it('so o DEV alcanca as rotas', async () => {
    for (const [method, url] of [
      ['GET', '/api/dev/backups'],
      ['POST', '/api/dev/backups'],
      ['POST', '/api/dev/dados/apagar']
    ]) {
      const r = await app.inject({ method, url, headers: cabDono, payload: {} });
      assert.equal(r.statusCode, 404, `${method} ${url}`);
    }
  });

  it('cria, lista e baixa um backup valido do banco', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/dev/backups', headers: cabDev, payload: { incluirArquivos: false } });
    assert.equal(r.statusCode, 201, r.body);
    const { backup } = r.json();
    assert.equal(backup.motivo, 'manual');
    assert.ok(backup.resumo.clientes > 0, 'o resumo conta o que havia no banco');

    const { backups } = (await app.inject({ method: 'GET', url: '/api/dev/backups', headers: cabDev })).json();
    assert.ok(backups.some((b) => b.id === backup.id));

    const baixar = await app.inject({ method: 'GET', url: `/api/dev/backups/${backup.id}/baixar`, headers: cabDev });
    assert.equal(baixar.statusCode, 200);
    assert.equal(baixar.rawPayload.subarray(0, 15).toString(), 'SQLite format 3', 'e um arquivo SQLite de verdade');
  });

  it('id malicioso nao sai da pasta de backups', async () => {
    for (const id of ['..%2F..%2Fplataforma', '..', 'x']) {
      const r = await app.inject({ method: 'GET', url: `/api/dev/backups/${id}/baixar`, headers: cabDev });
      assert.equal(r.statusCode, 404, id);
    }
  });
});

describe('apagar dados', () => {
  it('exige digitar APAGAR e respeita as dependencias entre grupos', async () => {
    const semConfirmar = await app.inject({
      method: 'POST',
      url: '/api/dev/dados/apagar',
      headers: cabDev,
      payload: { grupos: ['atendimento'], confirmacao: 'apagar' }
    });
    assert.equal(semConfirmar.statusCode, 400);

    const catalogoSozinho = await app.inject({
      method: 'POST',
      url: '/api/dev/dados/apagar',
      headers: cabDev,
      payload: { grupos: ['catalogo'], confirmacao: 'APAGAR' }
    });
    assert.equal(catalogoSozinho.statusCode, 422);
  });

  it('apaga o grupo pedido, faz backup antes e deixa o resto', async () => {
    const antes = { clientes: await contar(s.leads), profissionais: await contar(s.professionals) };
    assert.ok(antes.clientes > 0);

    const r = await app.inject({
      method: 'POST',
      url: '/api/dev/dados/apagar',
      headers: cabDev,
      payload: { grupos: ['atendimento', 'equipe'], confirmacao: 'APAGAR' }
    });
    assert.equal(r.statusCode, 200, r.body);
    const { backup } = r.json();

    assert.equal(await contar(s.leads), 0);
    assert.equal(await contar(s.appointments), 0);
    assert.equal(await contar(s.conversations), 0);
    assert.equal(await contar(s.professionals), antes.profissionais, 'catalogo nao foi pedido');

    // A equipe saiu, os donos e o DEV ficaram.
    const usuarios = await db.select().from(s.users).where(eq(s.users.tenantId, tenantId));
    assert.ok(usuarios.every((u) => ['owner', 'dev'].includes(u.cargo)));
    await entrar(app); // o dono continua entrando

    const { backups } = (await app.inject({ method: 'GET', url: '/api/dev/backups', headers: cabDev })).json();
    const feito = backups.find((b) => b.id === backup);
    assert.equal(feito.motivo, 'antes_de_apagar');
    assert.ok(feito.resumo.clientes > 0, 'o backup guardou os clientes que foram apagados');
  });
});

describe('restaurar', () => {
  it('agenda, pode cancelar, e no inicio troca o banco pelo do backup', async () => {
    const { backups } = (await app.inject({ method: 'GET', url: '/api/dev/backups', headers: cabDev })).json();
    const alvo = backups.find((b) => b.motivo === 'antes_de_apagar');

    const agendar = await app.inject({ method: 'POST', url: `/api/dev/backups/${alvo.id}/restaurar`, headers: cabDev });
    assert.equal(agendar.statusCode, 200, agendar.body);
    const pendente = (await app.inject({ method: 'GET', url: '/api/dev/backups', headers: cabDev })).json();
    assert.equal(pendente.restauracaoPendente.id, alvo.id);
    assert.ok(
      pendente.backups.some((b) => b.motivo === 'antes_de_restaurar'),
      'antes de agendar, guarda o estado atual'
    );

    // Backup agendado nao pode ser apagado.
    const apagarAgendado = await app.inject({ method: 'DELETE', url: `/api/dev/backups/${alvo.id}`, headers: cabDev });
    assert.equal(apagarAgendado.statusCode, 422);

    // Aplica num banco de mentira (o de teste esta aberto por este processo).
    const { aplicarRestauracaoPendente } = await import('../src/db/restauracao.js');
    const tmp = resolve('data/restaurar-teste');
    mkdirSync(tmp, { recursive: true });
    const falso = join(tmp, 'banco.db');
    copyFileSync(resolve('package.json'), falso); // qualquer arquivo diferente do backup
    const original = env.DATABASE_URL;
    env.DATABASE_URL = `file:${falso}`;
    try {
      const r = aplicarRestauracaoPendente();
      assert.equal(r.ok, true, r.erro);
      // O backup guarda o banco compactado: o restaurado e o conteudo dele, byte a byte.
      const guardado = gunzipSync(readFileSync(join(pastaBackups(), alvo.id, 'banco.db.gz')));
      assert.ok(readFileSync(falso).equals(guardado));
    } finally {
      env.DATABASE_URL = original;
      rmSync(tmp, { recursive: true, force: true });
    }

    const depois = (await app.inject({ method: 'GET', url: '/api/dev/backups', headers: cabDev })).json();
    assert.equal(depois.restauracaoPendente, null, 'o pedido e consumido');
    assert.equal(depois.ultimaRestauracao.id, alvo.id);
    assert.equal(existsSync(join(pastaBackups(), 'RESTAURAR.json')), false);
  });

  it('cancelar tira o pedido', async () => {
    const { backups } = (await app.inject({ method: 'GET', url: '/api/dev/backups', headers: cabDev })).json();
    await app.inject({ method: 'POST', url: `/api/dev/backups/${backups[0].id}/restaurar`, headers: cabDev });
    const cancelar = await app.inject({ method: 'DELETE', url: '/api/dev/backups-restauracao', headers: cabDev });
    assert.equal(cancelar.statusCode, 200);
    const r = (await app.inject({ method: 'GET', url: '/api/dev/backups', headers: cabDev })).json();
    assert.equal(r.restauracaoPendente, null);
  });
});
