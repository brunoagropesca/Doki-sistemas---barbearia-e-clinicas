import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { env } from '../src/config/env.js';
import { garantirUsuarioDev } from '../src/db/usuario-dev.js';

/**
 * O perfil DEV e descartavel e depende de uma chave fisica.
 *
 *   - so entra com o CRIAR-DEV.bat na pasta (e cai se ele sumir);
 *   - ao sair, e apagado do banco de verdade.
 */

let app;
const SENHA = 'senha-do-dev-789';
const chaveOriginal = env.DEV_ARQUIVO_CHAVE;

async function devExiste(username) {
  const { db } = await import('../src/db/client.js');
  const { users } = await import('../src/db/schema/index.js');
  const [linha] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
  return Boolean(linha);
}

before(async () => {
  ({ app } = await criarAppDeTeste());
});

after(async () => {
  env.DEV_ARQUIVO_CHAVE = chaveOriginal;
  await app?.close();
});

describe('perfil DEV', () => {
  it('sem o arquivo-chave, nao entra e quem estava dentro cai', async () => {
    await garantirUsuarioDev({ username: 'dev.chave', nome: 'Dev Chave', senha: SENHA });
    const { cabecalho } = await entrar(app, 'dev.chave', SENHA);

    env.DEV_ARQUIVO_CHAVE = `${chaveOriginal}.nao-existe`;
    try {
      const eu = await app.inject({ method: 'GET', url: '/api/auth/eu', headers: cabecalho });
      assert.equal(eu.statusCode, 401, 'a sessao aberta devia cair');

      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'dev.chave', senha: SENHA }
      });
      assert.equal(login.statusCode, 401);
      // Mesma mensagem de senha errada: nao revela que o DEV existe.
      assert.match(login.json().erro.mensagem, /usuario ou senha incorretos/i);
    } finally {
      env.DEV_ARQUIVO_CHAVE = chaveOriginal;
    }

    // Com a chave de volta, entra normalmente.
    await entrar(app, 'dev.chave', SENHA);
  });

  it('ao sair, o DEV e apagado do banco', async () => {
    await garantirUsuarioDev({ username: 'dev.sai', nome: 'Dev Sai', senha: SENHA });
    const { cabecalho } = await entrar(app, 'dev.sai', SENHA);
    assert.equal(await devExiste('dev.sai'), true);

    const sair = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: cabecalho });
    assert.equal(sair.statusCode, 200);

    assert.equal(await devExiste('dev.sai'), false, 'o DEV devia sumir do banco');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'dev.sai', senha: SENHA } });
    assert.equal(login.statusCode, 401);
  });

  it('usuario comum que sai continua existindo', async () => {
    const { cabecalho } = await entrar(app, 'recepcao');
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: cabecalho });
    assert.equal(await devExiste('recepcao'), true);
  });

  it('no boot, some o DEV abandonado ha mais de um dia — nao o recem-criado', async () => {
    const { removerDevsAbandonados } = await import('../src/modules/auth/auth.service.js');
    const { db } = await import('../src/db/client.js');
    const { users } = await import('../src/db/schema/index.js');

    await garantirUsuarioDev({ username: 'dev.velho', nome: 'Dev Velho', senha: SENHA });
    await garantirUsuarioDev({ username: 'dev.novo', nome: 'Dev Novo', senha: SENHA });
    await db
      .update(users)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(users.username, 'dev.velho'));

    await removerDevsAbandonados();

    assert.equal(await devExiste('dev.velho'), false);
    assert.equal(await devExiste('dev.novo'), true);
  });
});
