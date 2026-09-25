import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { abrirACasa, criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { garantirUsuarioDev } from '../src/db/usuario-dev.js';

/**
 * Textos do sistema editaveis pelo DEV: trocas da tela e mensagens ao cliente.
 */

let app;
let cabDono;
let cabDev;
let tenantId;

const trocar = (original, novo, cab = cabDev) =>
  app.inject({ method: 'PUT', url: '/api/dev/textos/interface', headers: cab, payload: { original, novo } });

before(async () => {
  ({ app } = await criarAppDeTeste());
  await abrirACasa();
  const dono = await entrar(app);
  cabDono = dono.cabecalho;
  tenantId = dono.usuario.tenantId;
  await garantirUsuarioDev({ username: 'dev.textos', nome: 'Dev', senha: 'senha-dev-12345' });
  ({ cabecalho: cabDev } = await entrar(app, 'dev.textos', 'senha-dev-12345'));
});

after(async () => {
  await app?.close();
});

describe('textos da tela', () => {
  it('so o DEV troca; a troca chega para todos, inclusive antes do login', async () => {
    assert.equal((await trocar('Salvar', 'Gravar', cabDono)).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/dev/textos', headers: cabDono })).statusCode, 404);

    const r = await trocar('  Salvar  ', 'Gravar');
    assert.equal(r.statusCode, 200, r.body);

    const logado = (await app.inject({ method: 'GET', url: '/api/textos', headers: cabDono })).json();
    assert.equal(logado.textos.Salvar, 'Gravar', 'espacos nas bordas nao fazem parte do texto');

    const publico = (await app.inject({ method: 'GET', url: '/api/textos' })).json();
    assert.equal(publico.textos.Salvar, 'Gravar', 'a tela de login tambem recebe as trocas');
  });

  it('novo texto vazio (ou igual ao original) desfaz a troca', async () => {
    await trocar('Cancelar', 'Desistir');
    await trocar('Cancelar', '');
    await trocar('Excluir', 'Excluir');
    const { textos } = (await app.inject({ method: 'GET', url: '/api/textos', headers: cabDono })).json();
    assert.equal(textos.Cancelar, undefined);
    assert.equal(textos.Excluir, undefined);
  });

  it('recusa troca em cadeia (A -> B quando B ja e original de outra troca)', async () => {
    await trocar('Agenda', 'Calendario');
    const r = await trocar('Painel', 'Agenda');
    assert.equal(r.statusCode, 422);
  });

  it('recusa texto longo demais', async () => {
    const r = await trocar('Entrar', 'x'.repeat(1001));
    assert.equal(r.statusCode, 400);
  });

  it('voltar tudo ao original limpa as trocas da tela', async () => {
    const r = await app.inject({ method: 'DELETE', url: '/api/dev/textos/interface', headers: cabDev });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().interface, []);
  });
});

describe('mensagens automaticas ao cliente', () => {
  it('a mensagem alterada e a que o cliente recebe', async () => {
    const { funcaoLigada, definirFuncao } = await import('../src/modules/funcoes/funcoes.js');
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');

    const r = await app.inject({
      method: 'PUT',
      url: '/api/dev/textos/mensagens/fila.ia_desligada',
      headers: cabDev,
      payload: { texto: 'Um momento, ja te chamo alguem da equipe!' }
    });
    assert.equal(r.statusCode, 200, r.body);

    await definirFuncao(tenantId, 'atendimento_ia', false);
    try {
      assert.equal(await funcaoLigada(tenantId, 'atendimento_ia'), false);
      const resposta = await atendimento.responder({ tenantId, texto: 'oi', simulacao: true, modoOverride: 'ia' });
      assert.deepEqual(resposta.baloes, ['Um momento, ja te chamo alguem da equipe!']);

      // Em branco volta ao padrao.
      await app.inject({ method: 'PUT', url: '/api/dev/textos/mensagens/fila.ia_desligada', headers: cabDev, payload: { texto: '' } });
      const padrao = await atendimento.responder({ tenantId, texto: 'oi', simulacao: true, modoOverride: 'ia' });
      assert.match(padrao.baloes[0], /Vou chamar um de nossos atendentes/);
    } finally {
      await definirFuncao(tenantId, 'atendimento_ia', true);
    }
  });

  it('mensagem desconhecida responde 404', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/dev/textos/mensagens/nao.existe', headers: cabDev, payload: { texto: 'x' } });
    assert.equal(r.statusCode, 404);
  });
});
