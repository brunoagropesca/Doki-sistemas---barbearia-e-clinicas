import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { env } from '../src/config/env.js';
import { garantirUsuarioDev } from '../src/db/usuario-dev.js';

/**
 * Banco de DEMONSTRACAO: o DEV liga no navegador dele e passa a ver uma
 * empresa ficticia, enquanto o resto do sistema segue no banco de verdade.
 * O que mais importa: nada feito na demonstracao sai pelo WhatsApp real.
 */

let app;
let dev;
let dono;
const chaveOriginal = env.DEV_ARQUIVO_CHAVE;
const COOKIE = { cookie: 'plataforma_demonstracao=1' };

const pedir = (method, url, cab, payload) => app.inject({ method, url, headers: cab, payload });

async function esperarGeracao() {
  for (let i = 0; i < 600; i++) {
    const r = (await pedir('GET', '/api/dev/demonstracao', dev)).json();
    if (!r.geracao.rodando) return r;
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error('A geracao nao terminou a tempo');
}

before(async () => {
  ({ app } = await criarAppDeTeste());
  const pasta = mkdtempSync(join(tmpdir(), 'dev-chave-'));
  env.DEV_ARQUIVO_CHAVE = join(pasta, 'chave');
  writeFileSync(env.DEV_ARQUIVO_CHAVE, 'ok');
  await garantirUsuarioDev({ username: 'dev.demo', nome: 'Dev Demo', senha: 'senha-do-dev-demo-1' });
  dev = (await entrar(app, 'dev.demo', 'senha-do-dev-demo-1')).cabecalho;
  dono = (await entrar(app)).cabecalho;
});

after(async () => {
  // Nao deixa o arquivo da demonstracao dos testes para tras.
  await pedir('DELETE', '/api/dev/demonstracao', dev).catch(() => {});
  env.DEV_ARQUIVO_CHAVE = chaveOriginal;
  await app?.close();
});

describe('banco de demonstracao', () => {
  it('so o DEV ve a rota (para os outros ela nao existe)', async () => {
    assert.equal((await pedir('GET', '/api/dev/demonstracao', dono)).statusCode, 404);
  });

  it('gera 3 meses de empresa ficticia: 20 profissionais, 5 atendentes, 40 servicos, 100+ produtos', { timeout: 180_000 }, async () => {
    const r = await pedir('POST', '/api/dev/demonstracao/gerar', dev);
    assert.equal(r.statusCode, 202, r.body);
    const estado = await esperarGeracao();
    assert.equal(estado.geracao.erro, null);
    assert.equal(estado.existe, true);
    const x = estado.resumo;
    assert.equal(x.profissionais, 20);
    assert.equal(x.servicos, 40);
    assert.ok(x.produtos >= 100, `produtos: ${x.produtos}`);
    assert.ok(x.equipe >= 7, 'dono, gerente e 5 atendentes');
    assert.ok(x.conversas > 1000, `conversas: ${x.conversas}`);
    assert.ok(x.agendamentos > 3000, `agendamentos: ${x.agendamentos}`);
    assert.ok(x.campanhas >= 5);
  });

  it('com a demonstracao ligada, o DEV ve a empresa ficticia; sem ela, a real', async () => {
    assert.equal((await pedir('POST', '/api/dev/demonstracao/entrar', dev)).statusCode, 200);

    const eu = (await pedir('GET', '/api/auth/eu', { ...dev, ...COOKIE })).json().usuario;
    assert.equal(eu.demonstracao, true);

    const naDemo = (await pedir('GET', '/api/profissionais', { ...dev, ...COOKIE })).json().profissionais;
    const noReal = (await pedir('GET', '/api/profissionais', dev)).json().profissionais;
    assert.equal(naDemo.length, 19, '20 cadastrados, 1 inativo');
    assert.ok(noReal.length < 19, 'o banco real continua com os seus');
  });

  it('o cookie da demonstracao nao vale para quem nao e DEV', async () => {
    const eu = (await pedir('GET', '/api/auth/eu', { ...dono, ...COOKIE })).json().usuario;
    assert.equal(eu.demonstracao, undefined);
  });

  it('a mesa ja vem cheia: conversas com a IA, na fila e com cada atendente', async () => {
    const lista = (filtro) => pedir('GET', `/api/conversas?filtro=${filtro}`, { ...dev, ...COOKIE }).then((r) => r.json().itens);
    assert.ok((await lista('fila')).length >= 5);
    assert.ok((await lista('bot')).length >= 10);
    assert.ok((await lista('ativas')).length >= 30);
  });

  it('responder um cliente na demonstracao NAO chega ao WhatsApp de verdade', async () => {
    const { registrarAdaptador, obterAdaptador } = await import('../src/channels/gateway.js');
    const original = obterAdaptador('whatsapp');
    const enviadosDeVerdade = [];
    registrarAdaptador('whatsapp', { enviar: async (m) => enviadosDeVerdade.push(m) });

    try {
      const conversa = (await pedir('GET', '/api/conversas?filtro=fila', { ...dev, ...COOKIE })).json().itens[0];
      const r = await pedir('POST', `/api/conversas/${conversa.id}/mensagens`, { ...dev, ...COOKIE }, { conteudo: 'Oi! Já vou te ajudar.' });
      assert.equal(r.statusCode, 201, r.body);
      await new Promise((ok) => setTimeout(ok, 300));

      assert.equal(enviadosDeVerdade.length, 0, 'nada saiu pelo adaptador real');
      const msgs = (await pedir('GET', `/api/conversas/${conversa.id}/mensagens`, { ...dev, ...COOKIE })).json().mensagens;
      const minha = msgs.find((m) => m.id === r.json().id);
      assert.ok(minha.entregueEm, 'na demonstracao o envio "da certo" (simulado)');
    } finally {
      if (original) registrarAdaptador('whatsapp', original);
    }
  });

  it('conectar um numero na demonstracao e recusado', async () => {
    const r = await pedir('POST', '/api/canais/W2/conectar', { ...dev, ...COOKIE });
    assert.equal(r.statusCode, 422);
    assert.match(r.json().erro.mensagem, /demonstra/i);
  });

  it('excluir apaga o arquivo e libera o espaco', async () => {
    const r = await pedir('DELETE', '/api/dev/demonstracao', dev);
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(r.json().liberados > 0);
    const { caminhoDoArquivo } = await import('../src/modules/demonstracao/demonstracao.js');
    assert.equal(existsSync(caminhoDoArquivo()), false);
    // Com o arquivo apagado, o cookie esquecido nao quebra nada: volta ao real.
    const eu = (await pedir('GET', '/api/auth/eu', { ...dev, ...COOKIE })).json().usuario;
    assert.equal(eu.demonstracao, undefined);
  });
});
