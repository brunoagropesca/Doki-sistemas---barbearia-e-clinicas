import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { assinar } from '../src/core/eventos.js';

/**
 * Gerencia da equipe: editar, excluir e mandar aviso para um atendente.
 *
 * As travas testadas aqui sao as que impedem a empresa de se trancar do lado
 * de fora (dono sem dono, admin rebaixando dono) e um atendente de mexer no
 * aviso de outro.
 */

let app;
let cabDono;
let dono;

const SENHA = 'senha-forte-123';

async function criarFuncionario(username, cargo = 'atendente') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/usuarios',
    headers: cabDono,
    payload: { username, nome: `Pessoa ${username}`, senha: SENHA, cargo }
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().usuario;
}

before(async () => {
  ({ app } = await criarAppDeTeste());
  const l = await entrar(app);
  cabDono = l.cabecalho;
  dono = l.usuario;
});

after(async () => {
  await app?.close();
});

describe('editar funcionario', () => {
  it('muda nome, capacidade e cargo', async () => {
    const u = await criarFuncionario('edit.um');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/usuarios/${u.id}`,
      headers: cabDono,
      payload: { nome: 'Nome Novo', capacidadeSimultanea: 8, cargo: 'admin' }
    });
    assert.equal(res.statusCode, 200, res.body);
    const { usuario } = res.json();
    assert.equal(usuario.nome, 'Nome Novo');
    assert.equal(usuario.capacidadeSimultanea, 8);
    assert.equal(usuario.cargo, 'admin');
  });

  it('redefinir a senha derruba a sessao antiga e a nova senha entra', async () => {
    const u = await criarFuncionario('edit.senha');
    const antiga = await entrar(app, 'edit.senha', SENHA);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/usuarios/${u.id}`,
      headers: cabDono,
      payload: { novaSenha: 'outra-senha-456' }
    });
    assert.equal(res.statusCode, 200, res.body);

    const eu = await app.inject({ method: 'GET', url: '/api/auth/eu', headers: antiga.cabecalho });
    assert.equal(eu.statusCode, 401);
    await entrar(app, 'edit.senha', 'outra-senha-456');
  });

  it('o dono nao troca o proprio cargo nem se desativa', async () => {
    for (const payload of [{ cargo: 'admin' }, { ativo: false }]) {
      const res = await app.inject({ method: 'PATCH', url: `/api/usuarios/${dono.id}`, headers: cabDono, payload });
      assert.equal(res.statusCode, 422, res.body);
    }
  });

  it('admin nao mexe no dono nem promove alguem a dono', async () => {
    await criarFuncionario('admin.limite', 'admin');
    const { cabecalho } = await entrar(app, 'admin.limite', SENHA);
    const alvo = await criarFuncionario('alvo.admin');

    const noDono = await app.inject({
      method: 'PATCH',
      url: `/api/usuarios/${dono.id}`,
      headers: cabecalho,
      payload: { nome: 'Hackeado' }
    });
    assert.equal(noDono.statusCode, 403);

    const promover = await app.inject({
      method: 'PATCH',
      url: `/api/usuarios/${alvo.id}`,
      headers: cabecalho,
      payload: { cargo: 'owner' }
    });
    assert.equal(promover.statusCode, 403);
  });

  it('atendente nao edita ninguem', async () => {
    const alvo = await criarFuncionario('alvo.atendente');
    await criarFuncionario('atendente.curioso');
    const { cabecalho } = await entrar(app, 'atendente.curioso', SENHA);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/usuarios/${alvo.id}`,
      headers: cabecalho,
      payload: { nome: 'X' }
    });
    assert.equal(res.statusCode, 403);
  });
});

describe('excluir funcionario', () => {
  it('some da lista, perde o acesso e libera o nome de usuario', async () => {
    const u = await criarFuncionario('sai.daqui');
    const sessao = await entrar(app, 'sai.daqui', SENHA);

    const res = await app.inject({ method: 'DELETE', url: `/api/usuarios/${u.id}`, headers: cabDono });
    assert.equal(res.statusCode, 200, res.body);

    const eu = await app.inject({ method: 'GET', url: '/api/auth/eu', headers: sessao.cabecalho });
    assert.equal(eu.statusCode, 401);

    const { atendentes } = (await app.inject({ method: 'GET', url: '/api/atendentes', headers: cabDono })).json();
    assert.ok(!atendentes.some((a) => a.id === u.id));

    // O mesmo login pode ser cadastrado de novo.
    await criarFuncionario('sai.daqui');
  });

  it('ninguem exclui a propria conta', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/usuarios/${dono.id}`, headers: cabDono });
    assert.equal(res.statusCode, 422);
  });
});

describe('aviso para o atendente', () => {
  it('chega so na tela do destinatario e sai quando ele confirma', async () => {
    const u = await criarFuncionario('recebe.aviso');
    await criarFuncionario('outro.atendente');
    const destinatario = await entrar(app, 'recebe.aviso', SENHA);
    const outro = await entrar(app, 'outro.atendente', SENHA);

    const doDestinatario = [];
    const doOutro = [];
    const cancelar1 = assinar(dono.tenantId, (e) => doDestinatario.push(e), { userId: u.id });
    const cancelar2 = assinar(dono.tenantId, (e) => doOutro.push(e), { userId: outro.usuario.id });

    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/usuarios/${u.id}/avisos`,
        headers: cabDono,
        payload: { mensagem: 'Reuniao em 5 minutos na recepcao.' }
      });
      assert.equal(res.statusCode, 201, res.body);
      await new Promise((r) => setTimeout(r, 150));

      assert.ok(doDestinatario.some((e) => e.tipo === 'aviso.novo'));
      assert.ok(!doOutro.some((e) => e.tipo === 'aviso.novo'), 'o aviso vazou para outra pessoa');
    } finally {
      cancelar1();
      cancelar2();
    }

    const pendentes = (
      await app.inject({ method: 'GET', url: '/api/avisos/pendentes', headers: destinatario.cabecalho })
    ).json().avisos;
    assert.equal(pendentes.length, 1);
    assert.equal(pendentes[0].mensagem, 'Reuniao em 5 minutos na recepcao.');
    assert.equal(pendentes[0].deNome, dono.nome);

    // Outro atendente nao ve nem confirma o aviso alheio.
    const alheios = (await app.inject({ method: 'GET', url: '/api/avisos/pendentes', headers: outro.cabecalho })).json();
    assert.equal(alheios.avisos.length, 0);
    const roubo = await app.inject({
      method: 'POST',
      url: `/api/avisos/${pendentes[0].id}/lido`,
      headers: outro.cabecalho
    });
    assert.equal(roubo.statusCode, 404);

    const ok = await app.inject({
      method: 'POST',
      url: `/api/avisos/${pendentes[0].id}/lido`,
      headers: destinatario.cabecalho
    });
    assert.equal(ok.statusCode, 200);

    const depois = (
      await app.inject({ method: 'GET', url: '/api/avisos/pendentes', headers: destinatario.cabecalho })
    ).json();
    assert.equal(depois.avisos.length, 0);
  });

  it('recusa aviso vazio', async () => {
    const u = await criarFuncionario('aviso.vazio');
    const res = await app.inject({
      method: 'POST',
      url: `/api/usuarios/${u.id}/avisos`,
      headers: cabDono,
      payload: { mensagem: '   ' }
    });
    assert.equal(res.statusCode, 400);
  });
});
