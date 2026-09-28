import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { ativarAutoVacuumIncremental, devolverEspacoLivre, manutencaoDiaria } from '../src/db/manutencao.js';

/**
 * Manutencao do SQLite: depois de apagar linhas, o arquivo do banco encolhe.
 *
 * Banco TEMPORARIO (nada do data/), no mesmo modo do sistema (WAL), criado
 * como os bancos que ja existem: sem auto_vacuum.
 */

const pasta = mkdtempSync(join(tmpdir(), 'manut-'));
const arquivo = join(pasta, 'teste.db');
const url = `file:${arquivo}`;
let c;

const valor = async (pragma) => Number(Object.values((await c.execute(`PRAGMA ${pragma}`)).rows[0])[0]);
const tamanho = () => statSync(arquivo).size;

before(async () => {
  c = createClient({ url });
  await c.execute('PRAGMA journal_mode = WAL');
  await c.execute('create table mensagens (id integer primary key, texto text)');
  // ~2,5 MB de linhas: o bastante para a diferenca de tamanho ser inequivoca.
  await c.batch(
    Array.from({ length: 2500 }, (_, i) => ({ sql: 'insert into mensagens (texto) values (?)', args: [`m${i} ${'x'.repeat(1000)}`] })),
    'write'
  );
  await c.execute('PRAGMA wal_checkpoint(TRUNCATE)');
});

after(() => {
  c?.close();
  try {
    rmSync(pasta, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* pasta temporaria do sistema (o Windows as vezes segura o arquivo) */
  }
});

describe('manutencao do banco', () => {
  it('sem auto_vacuum, apagar linhas NAO encolhe o arquivo (o problema)', async () => {
    assert.equal(await valor('auto_vacuum'), 0);
    const antes = tamanho();
    await c.execute('delete from mensagens where id <= 1250');
    await c.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.ok(await valor('freelist_count') > 0, 'paginas livres ficam dentro do arquivo');
    assert.equal(tamanho(), antes, 'o arquivo nao diminui');
  });

  it('a conversao unica liga o INCREMENTAL (com VACUUM) e na segunda vez nao faz nada', async () => {
    const r = await ativarAutoVacuumIncremental(c, url);
    assert.ok(r, 'converteu');
    assert.equal(await valor('auto_vacuum'), 2, 'INCREMENTAL');
    assert.ok(r.depois < r.antes, `o VACUUM ja devolveu o espaco (${r.antes} -> ${r.depois})`);
    assert.equal(await ativarAutoVacuumIncremental(c, url), null, 'ja convertido: nao roda VACUUM de novo');
  });

  it('depois de apagar, o incremental_vacuum zera as paginas livres e o arquivo encolhe', async () => {
    const antes = tamanho();
    await c.execute('delete from mensagens');
    assert.ok(await valor('freelist_count') > 0);

    const r = await devolverEspacoLivre(c);
    assert.ok(r.paginasLiberadas > 0);
    assert.equal(await valor('freelist_count'), 0);
    assert.ok(tamanho() < antes / 2, `encolheu: ${antes} -> ${tamanho()} bytes`);
  });

  it('a diaria (optimize + checkpoint) zera o WAL', async () => {
    await c.execute("insert into mensagens (texto) values ('depois')");
    await manutencaoDiaria(c);
    assert.equal(statSync(`${arquivo}-wal`).size, 0);
    assert.equal(Number((await c.execute('select count(*) n from mensagens')).rows[0].n), 1, 'nada se perde');
  });
});
