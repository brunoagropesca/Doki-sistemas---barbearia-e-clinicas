import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Backups e armazenamento — a pagina do DONO (/api/backups).
 *
 * Pastas TEMPORARIAS do sistema para backups, uploads e a "pasta externa"
 * (fazendo o papel do pendrive). A de uploads e lida no import do modulo de
 * arquivos, por isso e trocada antes dos imports dinamicos.
 */

const raiz = mkdtempSync(join(tmpdir(), 'bkdono-'));
const uploads = join(raiz, 'dados', 'uploads');
const backupsDir = join(raiz, 'dados', 'backups');
const pendrive = join(raiz, 'pendrive');
mkdirSync(uploads, { recursive: true });
mkdirSync(pendrive, { recursive: true });
process.env.PASTA_ARQUIVOS = uploads;

let app;
let cabDono;
let cabAtendente;
let cabAdmin;
let ce; // modulo da copia externa

const chamar = (method, url, cab, payload) => app.inject({ method, url, headers: cab, payload });

before(async () => {
  const { env } = await import('../src/config/env.js');
  env.BACKUP_DIR = backupsDir;
  const { criarAppDeTeste, entrar } = await import('./helpers/ambiente.js');
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cabDono } = await entrar(app));
  ({ cabecalho: cabAtendente } = await entrar(app, 'recepcao'));
  await chamar('POST', '/api/usuarios', cabDono, { username: 'gerente.bk', senha: 'senha-longa-123', nome: 'Gerente Bk', cargo: 'admin' });
  ({ cabecalho: cabAdmin } = await entrar(app, 'gerente.bk', 'senha-longa-123'));
  ce = await import('../src/modules/dados/copia-externa.js');
  writeFileSync(join(uploads, 'bkdono-foto.jpg'), 'foto');
});

after(async () => {
  await app?.close();
  try {
    rmSync(raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* pasta temporaria do sistema */
  }
});

describe('quem alcanca', () => {
  it('atendente e admin recebem 403; o dono entra', async () => {
    for (const cab of [cabAtendente, cabAdmin]) {
      assert.equal((await chamar('GET', '/api/backups', cab)).statusCode, 403);
      assert.equal((await chamar('POST', '/api/backups', cab, {})).statusCode, 403);
    }
    assert.equal((await chamar('GET', '/api/backups', cabDono)).statusCode, 200);
  });
});

describe('o dono cuida dos backups', () => {
  let id;

  it('cria, lista (com o uso do disco) e baixa', async () => {
    const r = await chamar('POST', '/api/backups', cabDono, {});
    assert.equal(r.statusCode, 201, r.body);
    id = r.json().backup.id;

    const lista = (await chamar('GET', '/api/backups', cabDono)).json();
    assert.ok(lista.backups.some((b) => b.id === id));
    assert.equal(lista.backups.find((b) => b.id === id).motivoTexto, 'Feito manualmente');
    const cats = Object.fromEntries(lista.armazenamento.categorias.map((c) => [c.chave, c.bytes]));
    assert.ok(cats.banco > 0 && cats.midia > 0 && cats.backups > 0 && cats.cofre > 0);
    assert.equal(lista.armazenamento.midiaPorAno[0].arquivos, 1);
    assert.equal(lista.armazenamento.copiaExterna.atrasada, true, 'sem pasta externa: aviso');

    const baixar = await chamar('GET', `/api/backups/${id}/baixar`, cabDono);
    assert.equal(baixar.statusCode, 200);
    assert.equal(baixar.rawPayload.subarray(0, 15).toString(), 'SQLite format 3');
  });

  it('restaurar sem digitar RESTAURAR: 400; com a palavra, agenda (e da para cancelar)', async () => {
    assert.equal((await chamar('POST', `/api/backups/${id}/restaurar`, cabDono, {})).statusCode, 400);
    assert.equal((await chamar('POST', `/api/backups/${id}/restaurar`, cabDono, { confirmacao: 'restaurar' })).statusCode, 400);
    const ok = await chamar('POST', `/api/backups/${id}/restaurar`, cabDono, { confirmacao: 'RESTAURAR' });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok(ok.json().restauracaoPendente.backupDeSeguranca, 'o estado de agora virou backup');
    assert.equal((await chamar('DELETE', '/api/backups-restauracao', cabDono)).statusCode, 200);
    assert.equal((await chamar('GET', '/api/backups', cabDono)).json().restauracaoPendente, null);
  });

  it('apaga so backup MANUAL (o de seguranca fica)', async () => {
    const { backups } = (await chamar('GET', '/api/backups', cabDono)).json();
    const seguranca = backups.find((b) => b.motivo === 'antes_de_restaurar');
    assert.equal((await chamar('DELETE', `/api/backups/${seguranca.id}`, cabDono)).statusCode, 422);
    assert.equal((await chamar('DELETE', `/api/backups/${id}`, cabDono)).statusCode, 200);
  });
});

describe('copia fora do computador', () => {
  it('pasta invalida e recusada (caminho relativo, inexistente, dentro da pasta do sistema)', async () => {
    for (const pasta of ['backups-relativo', join(raiz, 'nao-existe'), backupsDir]) {
      const r = await chamar('PUT', '/api/backups/copia-externa', cabDono, { pasta });
      assert.equal(r.statusCode, 422, `${pasta}: ${r.body}`);
    }
    const teste = (await chamar('POST', '/api/backups/copia-externa/testar', cabDono, { pasta: pendrive })).json();
    assert.equal(teste.ok, true);
  });

  it('copia so o que falta, e espelha o que sai do local', async () => {
    assert.equal((await chamar('PUT', '/api/backups/copia-externa', cabDono, { pasta: pendrive })).statusCode, 200);
    const b1 = (await chamar('POST', '/api/backups', cabDono, {})).json().backup.id;

    const primeira = ce.copiarParaExterna();
    assert.equal(primeira.ok, true, primeira.erro);
    const destino = join(pendrive, 'Doki-backups');
    assert.ok(existsSync(join(destino, b1, 'banco.db.gz')));
    assert.ok(existsSync(join(destino, '_midia', 'bkdono-foto.jpg')));
    assert.ok(existsSync(join(destino, 'LEIA-ME.txt')));

    const segunda = ce.copiarParaExterna();
    assert.equal(segunda.bytesCopiados, 0, 'nada novo: nada copiado');

    await chamar('DELETE', `/api/backups/${b1}`, cabDono);
    ce.copiarParaExterna();
    assert.ok(!existsSync(join(destino, b1)), 'backup que saiu do local sai do espelho');

    const { armazenamento } = (await chamar('GET', '/api/backups', cabDono)).json();
    assert.equal(armazenamento.copiaExterna.atrasada, false);
    assert.ok(armazenamento.copiaExterna.ultimaCopiaEm);
  });

  it('pendrive desconectado: o backup sai do mesmo jeito e a tela recebe o aviso', async () => {
    const tirado = join(raiz, 'pendrive-tirado');
    mkdirSync(tirado);
    assert.equal((await chamar('PUT', '/api/backups/copia-externa', cabDono, { pasta: tirado })).statusCode, 200);
    rmSync(tirado, { recursive: true, force: true }); // "tirou o pendrive"

    const r = await chamar('POST', '/api/backups', cabDono, {});
    assert.equal(r.statusCode, 201, 'o backup nao depende da copia externa');
    const tentativa = ce.copiarParaExterna();
    assert.equal(tentativa.ok, false);
    const { armazenamento } = (await chamar('GET', '/api/backups', cabDono)).json();
    assert.match(armazenamento.copiaExterna.ultimoErro, /não encontrada/);
    assert.ok(readdirSync(backupsDir).some((n) => n === r.json().backup.id), 'backup local existe');
  });
});
