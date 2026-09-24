import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { env } from '../src/config/env.js';
import { dataNoFuso, somarDias } from '../src/core/datetime.js';
import { garantirUsuarioDev } from '../src/db/usuario-dev.js';
import { gerarSerial } from '../src/licenca/gerar-serial.js';
import { codigoDaInstalacao, esquecerCacheDaLicenca } from '../src/licenca/licenca.js';

/**
 * Licenca por serial assinado.
 *
 * Os testes geram o PROPRIO par de chaves (a chave privada do fornecedor nunca
 * entra aqui) e ligam a exigencia de licenca so neste arquivo.
 */

let app;
let cabDono;
let cabRecepcao;
let cabDev;
let tenantId;

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const outroPar = generateKeyPairSync('ed25519');
const hoje = () => dataNoFuso(Date.now());
const arquivo = () => resolve(env.LICENCA_ARQUIVO);

const serial = (ate, { codigo = codigoDaInstalacao(), chave = privateKey } = {}) =>
  gerarSerial({ codigo, cliente: 'Barbearia Teste', ate, chavePrivada: chave }).serial;

/** Escreve a licenca direto no arquivo (simula o tempo passando). */
function gravarLicenca(dados) {
  writeFileSync(arquivo(), JSON.stringify(dados));
  esquecerCacheDaLicenca();
}

const ativar = (s, cab = cabDono) => app.inject({ method: 'POST', url: '/api/licenca/ativar', headers: cab, payload: { serial: s } });
const leads = (cab = cabDono) => app.inject({ method: 'GET', url: '/api/leads', headers: cab });
const estado = async () => (await app.inject({ method: 'GET', url: '/api/licenca', headers: cabDono })).json().licenca;

before(async () => {
  ({ app } = await criarAppDeTeste());
  env.LICENCA_EXIGIDA = true;
  env.LICENCA_CHAVE_PUBLICA = publicKey.export({ type: 'spki', format: 'pem' });

  const dono = await entrar(app);
  cabDono = dono.cabecalho;
  tenantId = dono.usuario.tenantId;
  ({ cabecalho: cabRecepcao } = await entrar(app, 'recepcao'));
  await garantirUsuarioDev({ username: 'dev.licenca', nome: 'Dev', senha: 'senha-dev-12345' });
  ({ cabecalho: cabDev } = await entrar(app, 'dev.licenca', 'senha-dev-12345'));
});

beforeEach(() => gravarLicenca({}));

after(async () => {
  env.LICENCA_EXIGIDA = false;
  env.LICENCA_CHAVE_PUBLICA = undefined;
  rmSync(arquivo(), { force: true });
  esquecerCacheDaLicenca();
  await app?.close();
});

describe('sem licenca', () => {
  it('trava a API, mas login, a tela de licenca e o DEV continuam', async () => {
    assert.equal((await leads()).statusCode, 402);
    assert.equal((await leads()).json().erro.codigo, 'LICENCA_BLOQUEADA');
    assert.equal((await app.inject({ method: 'GET', url: '/api/licenca', headers: cabDono })).statusCode, 200);
    await entrar(app); // login continua funcionando
    assert.equal((await leads(cabDev)).statusCode, 200, 'o DEV passa pela trava');
    const e = await estado();
    assert.equal(e.situacao, 'sem_licenca');
    assert.equal(e.codigoInstalacao, codigoDaInstalacao());
  });

  it('WhatsApp: a mensagem e gravada, mas ninguem responde', async () => {
    const gateway = await import('../src/channels/gateway.js');
    const r = await gateway.receberMensagem({ tenantId, remetente: '5511933332222', nomeRemetente: 'Cliente Trava', texto: 'oi', idExterno: 'lic_1' });
    assert.equal(r.respondido, false);
    assert.equal(r.motivo, 'licenca_bloqueada');
    assert.ok(r.conversationId, 'a conversa e a mensagem ficam registradas');
  });
});

describe('ativar serial', () => {
  it('serial mensal valido destrava na hora', async () => {
    const r = await ativar(serial(somarDias(hoje(), 30)));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().licenca.situacao, 'ativa');
    assert.equal((await leads()).statusCode, 200);
  });

  it('recusa serial de outra instalacao, adulterado ou de outra chave', async () => {
    assert.equal((await ativar(serial(somarDias(hoje(), 30), { codigo: 'AAAA-BBBB-CCCC' }))).statusCode, 422);

    const bom = serial(somarDias(hoje(), 30));
    const [corpo, assinatura] = bom.slice(5).split('.');
    const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    dados.ate = '2099-12-31'; // tentando esticar a validade
    const adulterado = `DOKI-${Buffer.from(JSON.stringify(dados)).toString('base64url')}.${assinatura}`;
    assert.equal((await ativar(adulterado)).statusCode, 422);

    assert.equal((await ativar(serial(somarDias(hoje(), 30), { chave: outroPar.privateKey }))).statusCode, 422);
    assert.equal((await ativar('qualquer coisa aqui')).statusCode, 422);
  });

  it('recusa serial vencido e serial que encurtaria a licenca', async () => {
    assert.equal((await ativar(serial(somarDias(hoje(), -10)))).statusCode, 422);
    await ativar(serial(somarDias(hoje(), 60)));
    assert.equal((await ativar(serial(somarDias(hoje(), 30)))).statusCode, 422);
  });

  it('so o dono (ou o DEV) ativa', async () => {
    assert.equal((await ativar(serial(somarDias(hoje(), 30)), cabRecepcao)).statusCode, 403);
  });
});

describe('linha do tempo do serial mensal', () => {
  const com = (dias, extra = {}) => gravarLicenca({ serial: serial(somarDias(hoje(), dias)), ...extra });

  it('faltando 3 dias: aviso, sem travar', async () => {
    com(3);
    const e = await estado();
    assert.equal(e.situacao, 'aviso');
    assert.equal(e.diasRestantes, 3);
    assert.equal((await leads()).statusCode, 200);
  });

  it('vencido ha 3 dias: tolerancia, sem travar', async () => {
    com(-3);
    const e = await estado();
    assert.equal(e.situacao, 'tolerancia');
    assert.equal(e.diasParaTravar, 2);
    assert.equal((await leads()).statusCode, 200);
  });

  it('vencido ha 6 dias: trava', async () => {
    com(-6);
    assert.equal((await estado()).situacao, 'bloqueada');
    assert.equal((await leads()).statusCode, 402);
  });

  it('voltar o relogio do computador nao destrava', async () => {
    // Serial ate daqui a 10 dias, mas o sistema ja "viu" uma data 40 dias a frente.
    com(10, { maiorDataVista: somarDias(hoje(), 40) });
    const e = await estado();
    assert.equal(e.situacao, 'bloqueada');
    assert.equal(e.relogioAtrasado, true);
  });
});

describe('serial permanente', () => {
  it('ativa para sempre e dispensa o mensal', async () => {
    const r = await ativar(serial(null));
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().licenca.tipo, 'permanente');
    assert.equal(r.json().licenca.situacao, 'ativa');
    assert.equal((await ativar(serial(somarDias(hoje(), 30)))).statusCode, 422);
  });
});
