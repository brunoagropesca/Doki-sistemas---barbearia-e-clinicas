import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createClient } from '@libsql/client';

/**
 * Backup incremental: cada foto/audio vai UMA vez para o cofre
 * (data/backups/_midia) e o backup guarda so a lista (midia.json) e o banco
 * compactado (banco.db.gz). Antes, cada backup copiava a pasta de uploads
 * inteira — guardando 14, cada arquivo existia ate 15 vezes.
 *
 * Tudo em pastas TEMPORARIAS do sistema: nem data/ real, nem as pastas de
 * teste compartilhadas. A pasta de uploads e lida no import do modulo de
 * arquivos, por isso ela e trocada ANTES dos imports dinamicos abaixo.
 */

const raiz = mkdtempSync(join(tmpdir(), 'cofre-'));
const uploads = join(raiz, 'uploads');
const backupsDir = join(raiz, 'backups');
mkdirSync(uploads, { recursive: true });
process.env.PASTA_ARQUIVOS = uploads;

let app;
let env;
let b; // modulo de backups
let restauracao;

const gravar = (nome, conteudo) => writeFileSync(join(uploads, nome), conteudo);
const cofre = () => (existsSync(join(backupsDir, '_midia')) ? readdirSync(join(backupsDir, '_midia')).sort() : []);
const lista = (id) => JSON.parse(readFileSync(join(backupsDir, id, 'midia.json'), 'utf8')).map((a) => a.nome).sort();

/** Aplica a restauracao agendada num banco de mentira (o de teste esta aberto). */
function restaurarEm(pastaFalsa) {
  mkdirSync(pastaFalsa, { recursive: true });
  const falso = join(pastaFalsa, 'banco.db');
  writeFileSync(falso, 'banco antigo');
  const original = env.DATABASE_URL;
  env.DATABASE_URL = `file:${falso}`;
  try {
    return { r: restauracao.aplicarRestauracaoPendente(), falso };
  } finally {
    env.DATABASE_URL = original;
  }
}

before(async () => {
  ({ env } = await import('../src/config/env.js'));
  env.BACKUP_DIR = backupsDir;
  const { criarAppDeTeste } = await import('./helpers/ambiente.js');
  ({ app } = await criarAppDeTeste());
  b = await import('../src/modules/dados/backups.js');
  restauracao = await import('../src/db/restauracao.js');
  gravar('audio-cofre-1.ogg', 'audio um');
  gravar('foto-cofre-2.jpg', 'foto dois, um pouco maior');
});

after(async () => {
  await app?.close();
  // No Windows o libsql solta o arquivo do banco so depois do GC: se a pasta
  // temporaria ainda estiver presa, fica para o sistema limpar (e do temp).
  try {
    rmSync(raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* pasta temporaria do sistema */
  }
});

describe('cofre de midia', () => {
  let ids;

  it('3 backups com os mesmos arquivos: cada um aparece UMA vez no cofre', async () => {
    ids = [];
    for (let i = 0; i < 3; i++) ids.push((await b.criarBackup({ motivo: 'manual', incluirArquivos: true })).id);

    assert.deepEqual(cofre(), ['audio-cofre-1.ogg', 'foto-cofre-2.jpg']);
    for (const id of ids) {
      assert.deepEqual(lista(id), ['audio-cofre-1.ogg', 'foto-cofre-2.jpg'], 'cada backup lista o que existia');
      assert.equal(existsSync(join(backupsDir, id, 'arquivos')), false, 'sem copia da pasta inteira');
      assert.equal(existsSync(join(backupsDir, id, 'banco.db')), false, 'banco so compactado');
      assert.ok(existsSync(join(backupsDir, id, 'banco.db.gz')));
    }
    assert.deepEqual(b.resumoDoCofre().arquivos, 2);
  });

  it('o tamanho de cada backup nao conta de novo a midia compartilhada', () => {
    const lidos = b.listarBackups().filter((x) => ids.includes(x.id));
    const soAPasta = (id) => readdirSync(join(backupsDir, id)).length; // sanidade: a pasta existe
    for (const x of lidos) {
      assert.ok(soAPasta(x.id) > 0);
      // O banco compactado de teste e pequeno; a midia (compartilhada por 3) nao entra.
      assert.ok(x.tamanhoBytes < 200_000, `${x.tamanhoBytes} bytes`);
    }
  });

  it('banco.db.gz restaura integro: mesmas linhas do banco de origem', async () => {
    const id = ids.at(-1);
    const { db } = await import('../src/db/client.js');
    const { leads } = await import('../src/db/schema/index.js');
    const noBanco = (await db.select().from(leads)).length;

    const copia = join(raiz, 'conferir.db');
    writeFileSync(copia, gunzipSync(readFileSync(join(backupsDir, id, 'banco.db.gz'))));
    const c = createClient({ url: `file:${copia}` });
    const [{ n }] = (await c.execute('select count(*) as n from leads')).rows;
    c.close();
    assert.equal(Number(n), noBanco);
    assert.ok(noBanco > 0, 'o seed tem clientes');
  });

  it('restaurar um backup novo devolve exatamente os arquivos da lista dele', async () => {
    const id = ids.at(-1);
    rmSync(join(uploads, 'audio-cofre-1.ogg')); // "perdido" depois do backup
    gravar('depois-do-backup.txt', 'nao estava no backup'); // mais novo: nao pode sumir

    await b.agendarRestauracao(id);
    const { r, falso } = restaurarEm(join(raiz, 'restaurar-novo'));
    assert.equal(r.ok, true, r.erro);
    assert.equal(readFileSync(join(uploads, 'audio-cofre-1.ogg'), 'utf8'), 'audio um', 'voltou do cofre');
    assert.ok(existsSync(join(uploads, 'depois-do-backup.txt')), 'restaurar nao apaga arquivo mais novo');
    assert.ok(readFileSync(falso).equals(gunzipSync(readFileSync(join(backupsDir, id, 'banco.db.gz')))));
    rmSync(join(uploads, 'depois-do-backup.txt'));
  });

  it('apagar um backup nao tira do cofre o que outro ainda cita', async () => {
    rmSync(join(uploads, 'foto-cofre-2.jpg')); // saiu dos uploads; so os backups ainda a tem
    b.apagarBackup(ids[0]);
    assert.ok(cofre().includes('foto-cofre-2.jpg'), 'outros 2 backups ainda citam');
    b.apagarBackup(ids[1]);
    assert.ok(cofre().includes('foto-cofre-2.jpg'), 'o 3o ainda cita');
    b.apagarBackup(ids[2]);
    assert.ok(!cofre().includes('foto-cofre-2.jpg'), 'ninguem cita e nao esta nos uploads: sai');
    assert.ok(cofre().includes('audio-cofre-1.ogg'), 'continua nos uploads: fica (o proximo backup cita)');
    gravar('foto-cofre-2.jpg', 'foto dois, um pouco maior');
  });
});

describe('backups do formato antigo', () => {
  const idAntigo = '2026-01-15_10-00-00-000_manual';

  /** Um backup como era antes: banco.db solto + a pasta arquivos/ inteira. */
  async function criarAntigo() {
    const novo = await b.criarBackup({ motivo: 'manual', incluirArquivos: false });
    const pasta = join(backupsDir, idAntigo);
    mkdirSync(join(pasta, 'arquivos'), { recursive: true });
    writeFileSync(join(pasta, 'banco.db'), gunzipSync(readFileSync(join(backupsDir, novo.id, 'banco.db.gz'))));
    writeFileSync(join(pasta, 'arquivos', 'so-no-antigo.png'), 'foto antiga');
    writeFileSync(join(pasta, 'info.json'), JSON.stringify({ id: idAntigo, motivo: 'manual', comArquivos: true }));
    b.apagarBackup(novo.id);
    return pasta;
  }

  it('continua restaurando (banco.db + arquivos/)', async () => {
    await criarAntigo();
    await b.agendarRestauracao(idAntigo);
    const { r } = restaurarEm(join(raiz, 'restaurar-antigo'));
    assert.equal(r.ok, true, r.erro);
    assert.equal(readFileSync(join(uploads, 'so-no-antigo.png'), 'utf8'), 'foto antiga');
    rmSync(join(uploads, 'so-no-antigo.png'));
    b.apagarBackup(idAntigo);
  });

  it('a migracao do boot converte sem perder nada, e ele segue restaurando', async () => {
    const pasta = await criarAntigo();
    const { convertidos } = await b.migrarBackupsAntigos();
    assert.ok(convertidos >= 1);
    assert.equal(existsSync(join(pasta, 'arquivos')), false);
    assert.equal(existsSync(join(pasta, 'banco.db')), false);
    assert.ok(existsSync(join(pasta, 'banco.db.gz')));
    assert.deepEqual(lista(idAntigo), ['so-no-antigo.png']);
    assert.ok(cofre().includes('so-no-antigo.png'));

    await b.agendarRestauracao(idAntigo);
    const { r } = restaurarEm(join(raiz, 'restaurar-migrado'));
    assert.equal(r.ok, true, r.erro);
    assert.equal(readFileSync(join(uploads, 'so-no-antigo.png'), 'utf8'), 'foto antiga');

    const segunda = await b.migrarBackupsAntigos();
    assert.equal(segunda.convertidos, 0, 'rodar de novo nao faz nada');
  });

  it('o download entrega o banco pronto (.db), mesmo guardado compactado', async () => {
    const { id } = await b.criarBackup({ motivo: 'manual', incluirArquivos: false });
    const { stream, nome, tamanho } = b.arquivoDoBackup(id);
    const partes = [];
    for await (const p of stream) partes.push(p);
    assert.equal(nome, `backup-${id}.db`);
    assert.equal(tamanho, null);
    assert.equal(Buffer.concat(partes).subarray(0, 15).toString(), 'SQLite format 3');
  });
});
