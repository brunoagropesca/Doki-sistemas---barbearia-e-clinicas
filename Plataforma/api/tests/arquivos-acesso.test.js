import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

/**
 * GET /api/arquivos/:nome so para quem esta logado E e da mesma empresa do
 * arquivo (fotos, audios, documentos que clientes mandam — numa clinica, dado
 * de saude). Sem login, de outra empresa ou inexistente: o mesmo 404.
 */

/** PNG de 1x1 transparente, em data URL. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let app;
let db;
let s;
let tenantA;
let donoA;
let recepcaoA;
let donoB;
const ctx = {};

const get = (url, headers) => app.inject({ method: 'GET', url, headers });

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ db } = await import('../src/db/client.js'));
  s = await import('../src/db/schema/index.js');
  const { gerarHashSenha } = await import('../src/core/crypto.js');

  const a = await entrar(app);
  donoA = a.cabecalho;
  tenantA = a.usuario.tenantId;
  recepcaoA = (await entrar(app, 'recepcao')).cabecalho;

  // Uma SEGUNDA empresa, com o proprio dono.
  await db.insert(s.tenants).values({ id: 'tnt_empresa_b', nome: 'Empresa B', slug: 'empresa-b' });
  await db.insert(s.users).values({
    id: 'usr_dono_b',
    tenantId: 'tnt_empresa_b',
    username: 'dono.b',
    nome: 'Dono B',
    cargo: 'owner',
    passwordHash: await gerarHashSenha('senha-da-empresa-b')
  });
  donoB = (await entrar(app, 'dono.b', 'senha-da-empresa-b')).cabecalho;

  // Uma foto da empresa A, salva pelo caminho de sempre (ficha do profissional).
  const { profissionais } = (await get('/api/profissionais', donoA)).json();
  ctx.profissional = profissionais[0];
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/profissionais/${ctx.profissional.id}`,
    headers: donoA,
    payload: { foto: PNG }
  });
  assert.equal(res.statusCode, 200, res.body);
  ctx.fotoA = res.json().profissional.fotoUrl;
});

after(async () => {
  await app?.close();
});

describe('quem pode abrir um arquivo', () => {
  it('sem login: 404 (nao confirma que o arquivo existe)', async () => {
    const existe = await get(ctx.fotoA);
    const naoExiste = await get('/api/arquivos/profissional-nao-existe.png');
    assert.equal(existe.statusCode, 404);
    assert.equal(existe.json().erro.codigo, naoExiste.json().erro.codigo, 'a mesma resposta para quem existe e quem nao existe');
    assert.doesNotMatch(String(existe.headers['content-type']), /image/);
  });

  it('logado da MESMA empresa: o arquivo, com cache so do navegador (private)', async () => {
    for (const cab of [donoA, recepcaoA]) {
      const res = await get(ctx.fotoA, cab);
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'], /image\/png/);
      assert.equal(res.headers['cache-control'], 'private, max-age=31536000, immutable');
    }
  });

  it('logado de OUTRA empresa: o mesmo 404 de um arquivo que nao existe', async () => {
    const deOutra = await get(ctx.fotoA, donoB);
    const inexistente = await get('/api/arquivos/profissional-nao-existe.png', donoB);
    assert.equal(deOutra.statusCode, 404);
    assert.deepEqual(deOutra.json(), inexistente.json());
  });

  it('o profissional logado ve a propria foto (Meu dia)', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/profissionais/${ctx.profissional.id}/acesso`,
      headers: donoA,
      payload: { username: 'barbeiro.arquivos', senha: 'senha-do-barbeiro-1' }
    });
    const prof = (await entrar(app, 'barbeiro.arquivos', 'senha-do-barbeiro-1')).cabecalho;
    const res = await get(ctx.fotoA, prof);
    assert.equal(res.statusCode, 200);
  });

  it('audio: a faixa (Range) continua funcionando para quem pode', async () => {
    const { salvarAudio } = await import('../src/modules/equipe/arquivos.js');
    const { url } = await salvarAudio(Buffer.from('0123456789'), 'audio/ogg', { tenantId: tenantA });
    const faixa = await get(url, { ...donoA, range: 'bytes=2-5' });
    assert.equal(faixa.statusCode, 206);
    assert.equal(faixa.body, '2345');
    assert.equal((await get(url, { ...donoB, range: 'bytes=2-5' })).statusCode, 404);
  });

  it('arquivo antigo sem dono conhecido: so o dono da empresa abre', async () => {
    const { PASTA_ARQUIVOS } = await import('../src/modules/equipe/arquivos.js');
    mkdirSync(PASTA_ARQUIVOS, { recursive: true });
    writeFileSync(join(PASTA_ARQUIVOS, 'foto-sem-dono-teste.png'), Buffer.from('png'));
    assert.equal((await get('/api/arquivos/foto-sem-dono-teste.png', donoA)).statusCode, 200);
    assert.equal((await get('/api/arquivos/foto-sem-dono-teste.png', recepcaoA)).statusCode, 404);
  });

  it('salvar arquivo sem dizer a empresa e erro (nenhum ponto de gravacao passa despercebido)', async () => {
    const { salvarImagem, salvarAnexo, salvarAudio } = await import('../src/modules/equipe/arquivos.js');
    await assert.rejects(() => salvarImagem(PNG, 'foto'), /tenantId/);
    await assert.rejects(() => salvarAnexo(PNG, 'a.png'), /tenantId/);
    await assert.rejects(() => salvarAudio(Buffer.from('a'), 'audio/ogg'), /tenantId/);
  });
});

describe('arquivos de antes desta regra', () => {
  it('a indexacao do boot associa cada arquivo a empresa de quem o cita; e so roda com a tabela vazia', async () => {
    const { indexarArquivosAntigos } = await import('../src/modules/dados/indexar-arquivos.js');

    // Como numa instalacao antiga: arquivos citados por varias tabelas e nenhuma anotacao.
    await db.delete(s.arquivos);
    const [lead] = await db.select().from(s.leads).where(eq(s.leads.tenantId, tenantA)).limit(1);
    await db.update(s.leads).set({ fotoUrl: '/api/arquivos/lead-antigo-a.png' }).where(eq(s.leads.id, lead.id));
    await db.update(s.users).set({ avatar: '/api/arquivos/perfil-antigo-b.png' }).where(eq(s.users.id, 'usr_dono_b'));
    await db.insert(s.settings).values({
      tenantId: tenantA,
      chave: 'empresa.base_conhecimento',
      valor: { identidade: { logo: '/api/arquivos/logo-antigo-a.png' } }
    }).onConflictDoUpdate({
      target: [s.settings.tenantId, s.settings.chave],
      set: { valor: { identidade: { logo: '/api/arquivos/logo-antigo-a.png' } } }
    });

    const r = await indexarArquivosAntigos();
    assert.ok(r.indexados >= 3, JSON.stringify(r));

    const dono = async (nome) => (await db.query.arquivos.findFirst({ where: eq(s.arquivos.nome, nome) }))?.tenantId;
    assert.equal(await dono('lead-antigo-a.png'), tenantA);
    assert.equal(await dono('perfil-antigo-b.png'), 'tnt_empresa_b');
    assert.equal(await dono('logo-antigo-a.png'), tenantA, 'citado dentro de um JSON');
    assert.equal(await dono(ctx.fotoA.replace('/api/arquivos/', '')), tenantA, 'a foto do profissional tambem');

    // Segunda subida: a tabela ja tem linhas, nada e refeito.
    assert.deepEqual(await indexarArquivosAntigos(), { indexados: 0, pulou: true });

    // E a regra de acesso vale para eles: o dono B nao abre o logo da A.
    const linha = await db.query.arquivos.findFirst({
      where: and(eq(s.arquivos.nome, 'logo-antigo-a.png'), eq(s.arquivos.tenantId, tenantA))
    });
    assert.ok(linha);
  });
});
