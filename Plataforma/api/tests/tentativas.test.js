import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste } from './helpers/ambiente.js';
import * as tentativas from '../src/modules/auth/tentativas.js';
import { _picoScrypt } from '../src/core/crypto.js';

/**
 * Limite de tentativas de login (modules/auth/tentativas.js).
 * 5 erros seguidos no mesmo login → 15 min; 20 erros do mesmo aparelho em
 * 15 min → 15 min. O relogio e de mentira: nada aqui espera 15 minutos.
 */

const MIN = 60_000;
let agora;
const relogio = () => agora;
const andar = (ms) => {
  agora += ms;
};

beforeEach(() => {
  agora = Date.UTC(2026, 8, 30, 12, 0, 0);
  tentativas._paraTestes({ relogio });
});

after(() => tentativas._paraTestes());

describe('os contadores', () => {
  const chave = { usuario: '|dono', ip: '10.0.0.1' };

  it('5 erros seguidos bloqueiam o login por 15 min, contados do ultimo erro', () => {
    for (let i = 1; i <= 4; i++) {
      assert.equal(tentativas.registrarErro(chave), null);
      andar(MIN);
    }
    assert.equal(tentativas.bloqueio(chave), 0, '4 erros ainda deixam tentar');
    assert.equal(tentativas.registrarErro(chave), 'usuario');
    assert.equal(tentativas.bloqueio(chave), 15 * MIN);

    andar(15 * MIN - 1);
    assert.ok(tentativas.bloqueio(chave) > 0);
    andar(1);
    assert.equal(tentativas.bloqueio(chave), 0);
  });

  it('acertar na 4a zera a sequencia do login', () => {
    for (let i = 0; i < 4; i++) tentativas.registrarErro(chave);
    tentativas.registrarAcerto(chave);
    for (let i = 0; i < 4; i++) tentativas.registrarErro(chave);
    assert.equal(tentativas.bloqueio(chave), 0);
  });

  it('erro depois de 15 min sem erros comeca uma sequencia nova', () => {
    for (let i = 0; i < 4; i++) tentativas.registrarErro(chave);
    andar(15 * MIN);
    tentativas.registrarErro(chave);
    assert.equal(tentativas.bloqueio(chave), 0);
  });

  it('20 erros do mesmo aparelho em 15 min, variando o login, bloqueiam o aparelho — acerto nao apaga', () => {
    for (let i = 0; i < 19; i++) tentativas.registrarErro({ usuario: `|chute${i}`, ip: '10.0.0.9' });
    tentativas.registrarAcerto({ usuario: '|dono', ip: '10.0.0.9' });
    assert.equal(tentativas.registrarErro({ usuario: '|chute19', ip: '10.0.0.9' }), 'ip');
    assert.ok(tentativas.bloqueio({ usuario: '|qualquer', ip: '10.0.0.9' }) > 0);
    assert.equal(tentativas.bloqueio({ usuario: '|qualquer', ip: '10.0.0.10' }), 0, 'outro aparelho segue livre');
  });

  it('20 erros espalhados por mais de 15 min nao bloqueiam o aparelho', () => {
    for (let i = 0; i < 20; i++) {
      tentativas.registrarErro({ usuario: `|u${i}`, ip: '10.0.0.3' });
      andar(MIN);
    }
    assert.equal(tentativas.bloqueio({ usuario: '|x', ip: '10.0.0.3' }), 0);
  });
});

describe('no login', () => {
  let app;

  before(async () => {
    ({ app } = await criarAppDeTeste());
  });

  after(async () => {
    await app?.close();
  });

  const login = (username, senha, extra = {}) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, senha }, ...extra });

  it('5 senhas erradas: a 6a tentativa da 429 mesmo com a senha CERTA; 15 min depois entra', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await login('dono', 'errada-123')).statusCode, 401);

    const bloqueado = await login('dono', 'trocar@123');
    assert.equal(bloqueado.statusCode, 429);
    assert.equal(bloqueado.json().erro.codigo, 'MUITAS_TENTATIVAS');
    assert.match(bloqueado.json().erro.mensagem, /Tente de novo em 15 minutos/);

    andar(15 * MIN);
    assert.equal((await login('dono', 'trocar@123')).statusCode, 200);
  });

  it('o bloqueio fica na auditoria (sem a senha)', async () => {
    for (let i = 0; i < 5; i++) await login('dono', 'errada-456');
    const { db } = await import('../src/db/client.js');
    const s = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const linhas = await db.select().from(s.auditLogs).where(eq(s.auditLogs.acao, 'auth.bloqueio'));
    assert.ok(linhas.length >= 1);
    const texto = JSON.stringify(linhas.at(-1));
    assert.match(texto, /dono/);
    assert.doesNotMatch(texto, /errada-456/);
  });

  it('login que NAO existe bloqueia igual, com a mesma resposta (nao revela quem existe)', async () => {
    for (let i = 0; i < 5; i++) await login('dono', 'errada-789');
    for (let i = 0; i < 5; i++) await login('ninguem.aqui', 'errada-789');
    const existe = await login('dono', 'errada-789');
    const naoExiste = await login('ninguem.aqui', 'errada-789');
    assert.equal(existe.statusCode, 429);
    assert.equal(naoExiste.statusCode, 429);
    assert.deepEqual(naoExiste.json(), existe.json());
  });

  it('bloqueado nao chega a calcular senha (a fila do scrypt fica livre)', async () => {
    for (let i = 0; i < 5; i++) await login('dono', 'errada-000');
    _picoScrypt(); // zera o medidor
    const respostas = await Promise.all(Array.from({ length: 10 }, () => login('dono', 'trocar@123')));
    assert.ok(respostas.every((r) => r.statusCode === 429));
    assert.equal(_picoScrypt(), 0, 'nenhum scrypt rodou');
  });

  it('20 erros de um aparelho, variando o login, bloqueiam o aparelho; outro aparelho entra', async () => {
    const deste = { remoteAddress: '192.168.0.50' };
    for (let i = 0; i < 20; i++) await login(`chute.${i}`, 'errada-111', deste);
    assert.equal((await login('dono', 'trocar@123', deste)).statusCode, 429);
    assert.equal((await login('dono', 'trocar@123', { remoteAddress: '192.168.0.51' })).statusCode, 200);
  });

  it('o aparelho nao escapa mandando outro IP no cabecalho X-Forwarded-For', async () => {
    for (let i = 0; i < 20; i++) {
      await login(`forja.${i}`, 'errada-222', { remoteAddress: '192.168.0.60', headers: { 'x-forwarded-for': `10.9.9.${i}` } });
    }
    const res = await login('dono', 'trocar@123', { remoteAddress: '192.168.0.60', headers: { 'x-forwarded-for': '10.9.9.99' } });
    assert.equal(res.statusCode, 429);
  });

  it('pelo proxy desta maquina (acesso pela rede), vale o IP do aparelho repassado', async () => {
    const peloProxy = (ip) => ({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < 20; i++) await login(`celular.${i}`, 'errada-333', peloProxy('192.168.0.70'));
    assert.equal((await login('dono', 'trocar@123', peloProxy('192.168.0.70'))).statusCode, 429);
    // Outro aparelho pela mesma rede (mesmo proxy) nao e pego junto.
    assert.equal((await login('dono', 'trocar@123', peloProxy('192.168.0.71'))).statusCode, 200);
  });
});
