import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { env } from '../src/config/env.js';

/**
 * Senha PROVISORIA: definida por outra pessoa (instalacao, gerencia, acesso do
 * profissional). Enquanto a pessoa nao cria a propria, o login so serve para
 * isso — quem sabe a provisoria nao continua entrando como ela.
 *
 * Nos outros arquivos a trava fica desligada (SENHA_PROVISORIA_NOS_TESTES, que
 * so existe nos testes): eles entram com a senha do seed. Aqui ela e ligada.
 */

let app;
let tenantId;
const SENHA_DONO = 'senha-do-dono-2026';

const pedir = (method, url, headers, payload) => app.inject({ method, url, headers, payload });
const codigo = (res) => res.json().erro?.codigo;

async function trocar(cab, senhaAtual, novaSenha) {
  return pedir('POST', '/api/auth/trocar-senha', cab, { senhaAtual, novaSenha });
}

describe('senha provisoria', () => {
  before(async () => {
    const criado = await criarAppDeTeste();
    app = criado.app;
    tenantId = criado.tenant.id;
    env.SENHA_PROVISORIA_NOS_TESTES = true;
  });

  after(async () => {
    env.SENHA_PROVISORIA_NOS_TESTES = false;
    await app?.close();
  });

  describe('o dono da instalacao (senha de fabrica)', () => {
    let cab;

    it('entra, sabe que a senha e provisoria e nao faz mais nada', async () => {
      const login = await entrar(app, 'dono', 'trocar@123');
      cab = login.cabecalho;
      assert.equal(login.usuario.senhaProvisoria, true);

      const eu = await pedir('GET', '/api/auth/eu', cab);
      assert.equal(eu.statusCode, 200);
      assert.equal(eu.json().usuario.senhaProvisoria, true);

      for (const url of ['/api/agenda', '/api/leads', '/api/profissionais', '/api/funcoes']) {
        const res = await pedir('GET', url, cab);
        assert.equal(res.statusCode, 403, url);
        assert.equal(codigo(res), 'SENHA_PROVISORIA', url);
      }
    });

    it('nao aceita a senha de fabrica como nova, e senha atual errada nao derruba a sessao (422, nao 401)', async () => {
      const outraVezAFabrica = await trocar(cab, 'trocar@123', 'trocar@123');
      assert.equal(outraVezAFabrica.statusCode, 400);

      const atualErrada = await trocar(cab, 'nao-e-essa', 'uma-senha-nova-1');
      assert.equal(atualErrada.statusCode, 422);
      assert.equal((await pedir('GET', '/api/auth/eu', cab)).statusCode, 200, 'a sessao continua');
    });

    it('cria a propria senha: a sessao antiga cai e o login novo entra em tudo', async () => {
      const res = await trocar(cab, 'trocar@123', SENHA_DONO);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((await pedir('GET', '/api/auth/eu', cab)).statusCode, 401);

      const novo = await entrar(app, 'dono', SENHA_DONO);
      assert.equal(novo.usuario.senhaProvisoria, false);
      assert.equal((await pedir('GET', '/api/agenda', novo.cabecalho)).statusCode, 200);
    });
  });

  describe('senha definida pela gerencia', () => {
    let dono;
    let atendente;

    before(async () => {
      dono = (await entrar(app, 'dono', SENHA_DONO)).cabecalho;
    });

    it('atendente cadastrado entra com senha provisoria e so passa depois de criar a sua', async () => {
      const criado = await pedir('POST', '/api/usuarios', dono, {
        username: 'atendente.nova',
        senha: 'senha-que-o-dono-sabe',
        nome: 'Atendente Nova',
        cargo: 'atendente'
      });
      assert.equal(criado.statusCode, 201, criado.body);
      atendente = criado.json().usuario;

      const login = await entrar(app, 'atendente.nova', 'senha-que-o-dono-sabe');
      assert.equal(login.usuario.senhaProvisoria, true);
      assert.equal(codigo(await pedir('GET', '/api/conversas', login.cabecalho)), 'SENHA_PROVISORIA');

      assert.equal((await trocar(login.cabecalho, 'senha-que-o-dono-sabe', 'so-eu-sei-esta-1')).statusCode, 200);
      const depois = await entrar(app, 'atendente.nova', 'so-eu-sei-esta-1');
      assert.equal(depois.usuario.senhaProvisoria, false);
      assert.equal((await pedir('GET', '/api/conversas', depois.cabecalho)).statusCode, 200);
    });

    it('a gerencia redefine a senha: volta a ser provisoria', async () => {
      const res = await pedir('PATCH', `/api/usuarios/${atendente.id}`, dono, { novaSenha: 'redefinida-pelo-dono' });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().usuario.senhaProvisoria, true);

      const login = await entrar(app, 'atendente.nova', 'redefinida-pelo-dono');
      assert.equal(login.usuario.senhaProvisoria, true);
    });

    it('quem muda a PROPRIA senha pela Equipe nao fica provisorio', async () => {
      const eu = (await pedir('GET', '/api/auth/eu', dono)).json().usuario;
      const res = await pedir('PATCH', `/api/usuarios/${eu.id}`, dono, { novaSenha: 'outra-do-dono-2026' });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().usuario.senhaProvisoria, false);
      dono = (await entrar(app, 'dono', 'outra-do-dono-2026')).cabecalho;
    });

    it('acesso do profissional: provisorio ate ele criar a senha, depois ve o Meu dia', async () => {
      const { profissionais } = (await pedir('GET', '/api/profissionais', dono)).json();
      const res = await pedir('PUT', `/api/profissionais/${profissionais[0].id}/acesso`, dono, {
        username: 'barbeiro.provisorio',
        senha: 'senha-do-barbeiro-1'
      });
      assert.equal(res.statusCode, 200, res.body);

      const login = await entrar(app, 'barbeiro.provisorio', 'senha-do-barbeiro-1');
      assert.equal(login.usuario.senhaProvisoria, true);
      assert.equal(codigo(await pedir('GET', '/api/meu-dia', login.cabecalho)), 'SENHA_PROVISORIA');

      assert.equal((await trocar(login.cabecalho, 'senha-do-barbeiro-1', 'a-minha-do-barbeiro')).statusCode, 200);
      const depois = await entrar(app, 'barbeiro.provisorio', 'a-minha-do-barbeiro');
      assert.equal((await pedir('GET', '/api/meu-dia', depois.cabecalho)).statusCode, 200);
    });
  });

  describe('instalacao antiga (antes desta regra existir)', () => {
    it('no boot, quem ainda usa a senha de fabrica passa a ser provisorio — uma vez por empresa', async () => {
      const { db } = await import('../src/db/client.js');
      const s = await import('../src/db/schema/index.js');
      const repo = await import('../src/modules/auth/auth.repo.js');
      const { gerarHashSenha } = await import('../src/core/crypto.js');
      const { marcarSenhasDeFabrica } = await import('../src/modules/auth/auth.service.js');

      // Como era antes: senha de fabrica, sem a marca de provisoria.
      const antigo = await repo.criarUsuario({
        tenantId,
        username: 'recepcao.antiga',
        nome: 'Recepcao Antiga',
        cargo: 'atendente',
        passwordHash: await gerarHashSenha('trocar@123'),
        senhaProvisoria: false
      });
      const outro = await repo.criarUsuario({
        tenantId,
        username: 'ja.trocou',
        nome: 'Ja Trocou',
        cargo: 'atendente',
        passwordHash: await gerarHashSenha('a-senha-dele-2026'),
        senhaProvisoria: false
      });
      await db
        .delete(s.settings)
        .where(and(eq(s.settings.tenantId, tenantId), eq(s.settings.chave, 'auth.senhas_de_fabrica_conferidas')));

      assert.ok((await marcarSenhasDeFabrica()) >= 1);
      assert.equal((await repo.buscarUsuarioPorId(antigo.id)).senhaProvisoria, true);
      assert.equal((await repo.buscarUsuarioPorId(outro.id)).senhaProvisoria, false, 'quem ja tem senha propria nao muda');

      // Segunda subida: a empresa ja foi conferida, nada e refeito.
      await repo.atualizarUsuario(antigo.id, { senhaProvisoria: false });
      assert.equal(await marcarSenhasDeFabrica(), 0);
      assert.equal((await repo.buscarUsuarioPorId(antigo.id)).senhaProvisoria, false);
    });
  });
});
