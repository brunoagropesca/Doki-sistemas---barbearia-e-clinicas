import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

let app;
let cabDono;
let cabRecepcao;

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cabDono } = await entrar(app));
  ({ cabecalho: cabRecepcao } = await entrar(app, 'recepcao'));
});

after(async () => {
  await app?.close();
});

const chamar = (method, url, cab, payload) => app.inject({ method, url, headers: cab, payload });

describe('meu perfil', () => {
  it('a pessoa edita o proprio nome, e-mail e telefone; e-mail apagado vira nulo', async () => {
    const r = await chamar('PATCH', '/api/perfil', cabRecepcao, {
      nome: 'Beatriz Recepção',
      email: 'bia@barbearia.com',
      telefone: '11 99999-0000'
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().usuario.nome, 'Beatriz Recepção');

    const eu = await chamar('GET', '/api/auth/eu', cabRecepcao);
    assert.equal(eu.json().usuario.email, 'bia@barbearia.com');

    const limpo = await chamar('PATCH', '/api/perfil', cabRecepcao, { email: '' });
    assert.equal(limpo.json().usuario.email, null);
  });

  it('nao aceita trocar cargo nem usuario de login por aqui', async () => {
    const r = await chamar('PATCH', '/api/perfil', cabRecepcao, { nome: 'Bia', cargo: 'owner', username: 'chefe' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().usuario.cargo, 'atendente');
    assert.equal(r.json().usuario.username, 'recepcao');
  });

  it('valida e-mail e nome', async () => {
    assert.equal((await chamar('PATCH', '/api/perfil', cabRecepcao, { email: 'nao-e-email' })).statusCode, 400);
    assert.equal((await chamar('PATCH', '/api/perfil', cabRecepcao, { nome: 'B' })).statusCode, 400);
  });
});

describe('respostas rapidas', () => {
  it('cria, lista, edita e apaga — tirando a barra do atalho', async () => {
    const criada = await chamar('POST', '/api/perfil/respostas-rapidas', cabRecepcao, {
      atalho: '/Ola',
      texto: 'Olá {nome}! Aqui é a Bia, tudo bem?'
    });
    assert.equal(criada.statusCode, 201, criada.body);
    const { id, atalho } = criada.json().resposta;
    assert.equal(atalho, 'ola');

    const lista = await chamar('GET', '/api/perfil/respostas-rapidas', cabRecepcao);
    assert.deepEqual(lista.json().respostas.map((r) => r.atalho), ['ola']);

    const editada = await chamar('PUT', `/api/perfil/respostas-rapidas/${id}`, cabRecepcao, { atalho: 'oi', texto: 'Oi!' });
    assert.equal(editada.statusCode, 200);
    assert.equal(editada.json().resposta.texto, 'Oi!');

    const apagada = await chamar('DELETE', `/api/perfil/respostas-rapidas/${id}`, cabRecepcao);
    assert.equal(apagada.statusCode, 200);
    assert.equal((await chamar('GET', '/api/perfil/respostas-rapidas', cabRecepcao)).json().respostas.length, 0);
  });

  it('sao de cada pessoa: o dono nao ve, nao edita e nao apaga as da recepcao', async () => {
    const criada = await chamar('POST', '/api/perfil/respostas-rapidas', cabRecepcao, { atalho: 'preco', texto: 'Corte R$ 40' });
    const id = criada.json().resposta.id;

    const doDono = await chamar('GET', '/api/perfil/respostas-rapidas', cabDono);
    assert.equal(doDono.json().respostas.length, 0);

    assert.equal((await chamar('PUT', `/api/perfil/respostas-rapidas/${id}`, cabDono, { atalho: 'x', texto: 'x' })).statusCode, 404);
    assert.equal((await chamar('DELETE', `/api/perfil/respostas-rapidas/${id}`, cabDono)).statusCode, 404);

    // O mesmo atalho em pessoas diferentes nao conflita.
    const mesmo = await chamar('POST', '/api/perfil/respostas-rapidas', cabDono, { atalho: 'preco', texto: 'Corte R$ 45' });
    assert.equal(mesmo.statusCode, 201);
  });

  it('recusa atalho repetido, o reservado "atena" e atalho com espaco', async () => {
    const repetido = await chamar('POST', '/api/perfil/respostas-rapidas', cabRecepcao, { atalho: 'preco', texto: 'outro' });
    assert.equal(repetido.statusCode, 409);

    const atena = await chamar('POST', '/api/perfil/respostas-rapidas', cabRecepcao, { atalho: '/atena', texto: 'x' });
    assert.equal(atena.statusCode, 400);

    const espaco = await chamar('POST', '/api/perfil/respostas-rapidas', cabRecepcao, { atalho: 'bom dia', texto: 'x' });
    assert.equal(espaco.statusCode, 400);
  });

  it('exige login', async () => {
    assert.equal((await chamar('GET', '/api/perfil/respostas-rapidas', {})).statusCode, 401);
  });
});
