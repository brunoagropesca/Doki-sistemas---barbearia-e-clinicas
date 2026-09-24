import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { garantirUsuarioDev } from '../src/db/usuario-dev.js';
import { limparEventos, listarEventos, registrarEvento, ultimoIdDeEvento } from '../src/channels/eventos.js';
import { CONFIG_PADRAO, MENSAGEM_CHAMADA_PADRAO, configEfetiva } from '../src/channels/whatsapp/handlers.js';

/**
 * Perfil DEV (invisivel) e permissoes das conexoes de WhatsApp.
 *
 * A regra que estes testes seguram: o DONO opera a conta que ja existe
 * (conecta, desconecta, sai, ajusta preferencias) mas NAO adiciona nem remove
 * sessoes — isso e do DEV, que nao aparece em lugar nenhum e cujas rotas
 * respondem para os demais exatamente como uma rota que nao existe.
 */

let app;
let tenantId;
let cabDono;
let cabDev;
let cabRecepcao;
let usuarioDev;

const SENHA_DEV = 'senha-do-dev-123';

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cabDono } = await entrar(app));
  ({ cabecalho: cabRecepcao } = await entrar(app, 'recepcao'));

  const { db } = await import('../src/db/client.js');
  const { tenants } = await import('../src/db/schema/index.js');
  [{ id: tenantId }] = await db.select().from(tenants);

  const r = await garantirUsuarioDev({ username: 'bruno.dev', nome: 'Bruno Dev', senha: SENHA_DEV });
  usuarioDev = r.usuario;
  ({ cabecalho: cabDev } = await entrar(app, 'bruno.dev', SENHA_DEV));
});

after(async () => {
  await app?.close();
});

/** Corpo que uma rota inexistente devolve, para comparar com o da rota escondida. */
async function corpoDeRotaInexistente(metodo) {
  const res = await app.inject({ method: metodo, url: '/api/isto/nao/existe', headers: cabDono });
  return res;
}

describe('o perfil DEV', () => {
  it('nasce pelo comando e consegue entrar', async () => {
    const eu = await app.inject({ method: 'GET', url: '/api/auth/eu', headers: cabDev });
    assert.equal(eu.statusCode, 200);
    assert.equal(eu.json().usuario.cargo, 'dev');
  });

  it('rodar o comando de novo com o mesmo login so troca a senha e derruba as sessoes', async () => {
    const antes = await entrar(app, 'bruno.dev', SENHA_DEV);

    const r = await garantirUsuarioDev({ username: 'bruno.dev', nome: 'Bruno Dev', senha: 'outra-senha-456' });
    assert.equal(r.acao, 'senha_redefinida');
    assert.equal(r.usuario.id, usuarioDev.id, 'nao pode criar um segundo usuario');

    const velha = await app.inject({ method: 'GET', url: '/api/auth/eu', headers: antes.cabecalho });
    assert.equal(velha.statusCode, 401, 'a sessao antiga precisa cair');

    await entrar(app, 'bruno.dev', 'outra-senha-456');
    // Volta a senha original para os demais testes.
    await garantirUsuarioDev({ username: 'bruno.dev', nome: 'Bruno Dev', senha: SENHA_DEV });
    ({ cabecalho: cabDev } = await entrar(app, 'bruno.dev', SENHA_DEV));
  });

  it('o comando NUNCA mexe na senha de um usuario comum', async () => {
    await assert.rejects(
      () => garantirUsuarioDev({ username: 'dono', nome: 'Tentativa', senha: 'senha-nova-999' }),
      /usuario comum/i
    );
    // A senha do dono continua a original.
    await entrar(app, 'dono', 'trocar@123');
  });

  it('o comando valida login e senha', async () => {
    await assert.rejects(() => garantirUsuarioDev({ username: 'x', nome: 'Fulano', senha: 'senha-longa-1' }));
    await assert.rejects(() => garantirUsuarioDev({ username: 'outro.dev', nome: 'Fulano', senha: 'curta' }));
  });

  it('a API nao cria usuario DEV — nem para o dono, nem para o proprio DEV', async () => {
    for (const cab of [cabDono, cabDev]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/usuarios',
        headers: cab,
        payload: { username: 'segundo.dev', senha: 'senha-longa-123', nome: 'Segundo', cargo: 'dev' }
      });
      assert.equal(res.statusCode, 400);
      // A mensagem de validacao lista as opcoes validas: nao pode citar o dev.
      assert.doesNotMatch(res.body, /\bdev\b/i, 'a validacao nao pode revelar que o cargo existe');
    }
  });

  it('nao aparece como destino de transferencia nem na fila de atendimento', async () => {
    const { db } = await import('../src/db/client.js');
    const { users } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    await db.update(users).set({ statusPresenca: 'online' }).where(eq(users.id, usuarioDev.id));

    const conversas = await import('../src/modules/conversas/conversas.repo.js');
    const disponiveis = await conversas.atendentesDisponiveis(tenantId);
    assert.ok(!disponiveis.some((a) => a.id === usuarioDev.id), 'DEV online nao entra na distribuicao');
    assert.equal(await conversas.buscarUsuario(tenantId, usuarioDev.id), undefined);

    await db.update(users).set({ statusPresenca: 'offline' }).where(eq(users.id, usuarioDev.id));
  });

  it('herda tudo o que o dono faz (nivel acima)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/canais', headers: cabDev });
    assert.equal(res.statusCode, 200);
    const eventos = await app.inject({ method: 'GET', url: '/api/canais/eventos', headers: cabDev });
    assert.equal(eventos.statusCode, 200);
  });
});

describe('rotas do DEV parecem inexistentes para os demais', () => {
  const casos = [
    ['POST', '/api/canais', { nome: 'Invasao', canal: 'whatsapp' }],
    ['PATCH', '/api/canais/W1', { nome: 'Renomeado' }],
    ['DELETE', '/api/canais/W1', undefined]
  ];

  for (const [metodo, url, payload] of casos) {
    for (const [quem, cab] of [
      ['dono', () => cabDono],
      ['atendente', () => cabRecepcao]
    ]) {
      it(`${metodo} ${url} como ${quem}: 404 identico ao de uma rota que nao existe`, async () => {
        const res = await app.inject({ method: metodo, url, headers: cab(), payload });
        assert.equal(res.statusCode, 404);

        const inexistente = await corpoDeRotaInexistente(metodo);
        assert.equal(inexistente.statusCode, 404);

        // Mesma forma e mesmo codigo; o texto so difere na URL pedida.
        const a = res.json();
        const b = inexistente.json();
        assert.deepEqual(Object.keys(a), Object.keys(b));
        assert.deepEqual(Object.keys(a.erro), Object.keys(b.erro));
        assert.equal(a.erro.codigo, b.erro.codigo);
        assert.equal(a.erro.mensagem, `Nao existe ${metodo} ${url} nesta API.`);
        assert.doesNotMatch(res.body, /dev|perfil|permiss/i);
      });
    }
  }

  it('e nada foi alterado pelas tentativas', async () => {
    const lista = await app.inject({ method: 'GET', url: '/api/canais', headers: cabDono });
    const canais = lista.json().canais;
    assert.equal(canais.length, 1);
    assert.equal(canais[0].chave, 'W1');
    assert.notEqual(canais[0].nome, 'Renomeado');
  });
});

describe('o DEV adiciona e remove sessoes', () => {
  it('adiciona ate 5 e recusa a sexta', async () => {
    for (let i = 2; i <= 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/canais',
        headers: cabDev,
        payload: { nome: `Numero ${i}`, canal: 'whatsapp' }
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(res.json().canal.chave, `W${i}`);
    }

    const sexta = await app.inject({
      method: 'POST',
      url: '/api/canais',
      headers: cabDev,
      payload: { nome: 'Numero 6', canal: 'whatsapp' }
    });
    assert.equal(sexta.statusCode, 409);
    assert.match(sexta.json().erro.mensagem, /limite de 5/i);
  });

  it('cinco criacoes simultaneas nunca passam do limite nem repetem chave', async () => {
    // Estado atual: W1..W5 cheios. Remove duas e tenta recriar cinco de uma vez.
    await app.inject({ method: 'DELETE', url: '/api/canais/W4', headers: cabDev });
    await app.inject({ method: 'DELETE', url: '/api/canais/W5', headers: cabDev });

    const respostas = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/api/canais',
          headers: cabDev,
          payload: { nome: `Concorrente ${i}`, canal: 'whatsapp' }
        })
      )
    );

    const criadas = respostas.filter((r) => r.statusCode === 201);
    const recusadas = respostas.filter((r) => r.statusCode === 409);
    assert.equal(criadas.length, 2, 'so cabem duas');
    assert.equal(recusadas.length, 3);

    const chaves = criadas.map((r) => r.json().canal.chave).sort();
    assert.deepEqual(chaves, ['W4', 'W5']);
  });

  it('a chave de uma sessao removida pode ser reaproveitada (o indice unico nao trava)', async () => {
    const del = await app.inject({ method: 'DELETE', url: '/api/canais/W3', headers: cabDev });
    assert.equal(del.statusCode, 200);

    const lista = await app.inject({ method: 'GET', url: '/api/canais', headers: cabDono });
    assert.ok(!lista.json().canais.some((c) => c.chave === 'W3'));

    const nova = await app.inject({
      method: 'POST',
      url: '/api/canais',
      headers: cabDev,
      payload: { nome: 'Recriada', canal: 'whatsapp' }
    });
    assert.equal(nova.statusCode, 201);
    assert.equal(nova.json().canal.chave, 'W3');
  });

  it('uma sessao removida some das rotas de operacao', async () => {
    await app.inject({ method: 'DELETE', url: '/api/canais/W5', headers: cabDev });

    for (const [metodo, url] of [
      ['POST', '/api/canais/W5/conectar'],
      ['GET', '/api/canais/W5/status'],
      ['POST', '/api/canais/W5/desconectar'],
      ['PATCH', '/api/canais/W5/config']
    ]) {
      const res = await app.inject({ method: metodo, url, headers: cabDev, payload: { marcarComoLida: true } });
      assert.equal(res.statusCode, 404, `${metodo} ${url}`);
    }
  });

  it('so cria conexao de WhatsApp (Telegram e Instagram ainda nao tem adaptador)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/canais',
      headers: cabDev,
      payload: { nome: 'Bot', canal: 'telegram' }
    });
    assert.equal(res.statusCode, 400);
  });

  it('valida o nome', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/canais', headers: cabDev, payload: { nome: 'a' } });
    assert.equal(res.statusCode, 400);
  });

  it('renomeia e desativa; sessao desativada nao conecta', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/canais/W2',
      headers: cabDev,
      payload: { nome: 'Recepcao Nova', ativo: false }
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().canal.nome, 'Recepcao Nova');
    assert.equal(r.json().canal.ativo, false);

    const conectar = await app.inject({ method: 'POST', url: '/api/canais/W2/conectar', headers: cabDono });
    assert.equal(conectar.statusCode, 422);
    assert.match(conectar.json().erro.mensagem, /desativada/i);

    await app.inject({ method: 'PATCH', url: '/api/canais/W2', headers: cabDev, payload: { ativo: true } });
  });

  it('PATCH sem campo nenhum e recusado', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/canais/W2', headers: cabDev, payload: {} });
    assert.equal(res.statusCode, 400);
  });
});

describe('o dono opera a conta que ja existe', () => {
  it('ve a lista com o limite', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/canais', headers: cabDono });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().limite, 5);
    const w1 = res.json().canais.find((c) => c.chave === 'W1');
    assert.deepEqual(w1.config, CONFIG_PADRAO);
  });

  it('ajusta as preferencias (e elas se acumulam, sem apagar as outras)', async () => {
    let res = await app.inject({
      method: 'PATCH',
      url: '/api/canais/W1/config',
      headers: cabDono,
      payload: { rejeitarChamadas: true }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().canal.config.rejeitarChamadas, true);
    assert.equal(res.json().canal.config.marcarComoLida, false);

    res = await app.inject({
      method: 'PATCH',
      url: '/api/canais/W1/config',
      headers: cabDono,
      payload: { marcarComoLida: true, iaHabilitada: false, mensagemChamada: 'Só por texto, por favor.' }
    });
    const c = res.json().canal;
    assert.equal(c.config.rejeitarChamadas, true, 'a opcao anterior continua');
    assert.equal(c.config.marcarComoLida, true);
    assert.equal(c.config.mensagemChamada, 'Só por texto, por favor.');
    assert.equal(c.iaHabilitada, false);

    await app.inject({
      method: 'PATCH',
      url: '/api/canais/W1/config',
      headers: cabDono,
      payload: { rejeitarChamadas: false, marcarComoLida: false, iaHabilitada: true }
    });
  });

  it('recusa configuracao invalida', async () => {
    for (const payload of [{}, { rejeitarChamadas: 'sim' }, { mensagemChamada: 'ok' }, { mensagemChamada: 'x'.repeat(501) }]) {
      const res = await app.inject({ method: 'PATCH', url: '/api/canais/W1/config', headers: cabDono, payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
  });

  it('o nome e a ativacao NAO se mudam por aqui (o campo e ignorado, nao aplicado)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/canais/W1/config',
      headers: cabDono,
      payload: { marcarComoLida: false, nome: 'Trocado pelo dono', ativo: false }
    });
    assert.equal(res.statusCode, 200);
    assert.notEqual(res.json().canal.nome, 'Trocado pelo dono');
    assert.equal(res.json().canal.ativo, true);
  });

  it('atendente nao ajusta nem conecta', async () => {
    for (const [metodo, url] of [
      ['PATCH', '/api/canais/W1/config'],
      ['POST', '/api/canais/W1/conectar'],
      ['POST', '/api/canais/W1/desconectar'],
      ['GET', '/api/canais/W1/status'],
      ['GET', '/api/canais/eventos']
    ]) {
      const res = await app.inject({ method: metodo, url, headers: cabRecepcao, payload: { marcarComoLida: true } });
      assert.equal(res.statusCode, 403, `${metodo} ${url}`);
    }
  });

  it('sem login ninguem mexe em nada', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/canais/W1/config', payload: { marcarComoLida: true } });
    assert.equal(res.statusCode, 401);
  });

  it('o QR Code so aparece para quem pode conectar', async () => {
    const { db } = await import('../src/db/client.js');
    const { channelInstances } = await import('../src/db/schema/index.js');
    const { and, eq } = await import('drizzle-orm');
    await db
      .update(channelInstances)
      .set({ status: 'aguardando_qr', qrCode: 'data:image/png;base64,AAAA', qrExpiraEm: new Date(Date.now() + 60_000) })
      .where(and(eq(channelInstances.tenantId, tenantId), eq(channelInstances.chave, 'W1')));

    const dono = (await app.inject({ method: 'GET', url: '/api/canais', headers: cabDono })).json().canais[0];
    const recepcao = (await app.inject({ method: 'GET', url: '/api/canais', headers: cabRecepcao })).json().canais[0];

    assert.equal(dono.qrCode, 'data:image/png;base64,AAAA');
    assert.ok(dono.qrExpiraEm > Date.now());
    assert.equal(recepcao.qrCode, null, 'quem le o QR assume o numero: atendente nao ve');
    assert.equal(recepcao.qrExpiraEm, null);

    await db
      .update(channelInstances)
      .set({ status: 'desconectado', qrCode: null, qrExpiraEm: null })
      .where(and(eq(channelInstances.tenantId, tenantId), eq(channelInstances.chave, 'W1')));
  });
});

describe('console de conexoes (eventos)', () => {
  it('registra o que as pessoas fazem, sem citar o nome do DEV', async () => {
    limparEventos(tenantId);

    await app.inject({ method: 'POST', url: '/api/canais', headers: cabDev, payload: { nome: 'Console', canal: 'whatsapp' } });
    await app.inject({
      method: 'PATCH',
      url: '/api/canais/W1/config',
      headers: cabDev,
      payload: { marcarComoLida: true }
    });
    await app.inject({
      method: 'PATCH',
      url: '/api/canais/W1/config',
      headers: cabDono,
      payload: { marcarComoLida: false }
    });

    const res = await app.inject({ method: 'GET', url: '/api/canais/eventos', headers: cabDono });
    assert.equal(res.statusCode, 200);
    const { eventos, ultimoId } = res.json();

    assert.ok(eventos.length >= 3);
    assert.equal(ultimoId, eventos.at(-1).id);
    assert.ok(eventos.some((e) => /adicionada/.test(e.mensagem)));
    assert.ok(eventos.some((e) => /Ze da Barbearia/.test(e.mensagem)), 'o dono aparece pelo nome');

    const tudo = JSON.stringify(eventos);
    assert.doesNotMatch(tudo, /Bruno/, 'o nome do DEV nao pode vazar');
    assert.match(tudo, /equipe técnica/);
  });

  it('a sondagem devolve so o que veio depois', async () => {
    const primeira = (await app.inject({ method: 'GET', url: '/api/canais/eventos', headers: cabDono })).json();

    registrarEvento(tenantId, { chave: 'W1', nivel: 'erro', tipo: 'conexao', mensagem: 'Caiu de novo' });

    const seguinte = (
      await app.inject({ method: 'GET', url: `/api/canais/eventos?depoisDe=${primeira.ultimoId}`, headers: cabDono })
    ).json();
    assert.equal(seguinte.eventos.length, 1);
    assert.equal(seguinte.eventos[0].mensagem, 'Caiu de novo');
    assert.equal(seguinte.eventos[0].nivel, 'erro');
  });

  it('valida os parametros', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/canais/eventos?limite=999999', headers: cabDono });
    assert.equal(res.statusCode, 400);
  });
});

describe('eventos (unidade)', () => {
  it('cada empresa tem o seu anel', () => {
    limparEventos();
    registrarEvento('t1', { mensagem: 'a' });
    registrarEvento('t2', { mensagem: 'b' });
    assert.equal(listarEventos('t1').length, 1);
    assert.equal(listarEventos('t2')[0].mensagem, 'b');
    assert.equal(listarEventos('t3').length, 0);
  });

  it('o anel e limitado e descarta os mais antigos', () => {
    limparEventos();
    for (let i = 0; i < 350; i++) registrarEvento('t1', { mensagem: `e${i}` });
    const todos = listarEventos('t1', { limite: 300 });
    assert.equal(todos.length, 300);
    assert.equal(todos[0].mensagem, 'e50');
    assert.equal(todos.at(-1).mensagem, 'e349');
  });

  it('ids crescem e depoisDe filtra', () => {
    limparEventos();
    const a = registrarEvento('t1', { mensagem: 'a' });
    const b = registrarEvento('t1', { mensagem: 'b' });
    assert.ok(b.id > a.id);
    assert.deepEqual(
      listarEventos('t1', { depoisDe: a.id }).map((e) => e.mensagem),
      ['b']
    );
    assert.equal(ultimoIdDeEvento('t1'), b.id);
    assert.equal(ultimoIdDeEvento('t-vazio'), 0);
  });

  it('ignora evento sem mensagem ou sem empresa; corta texto enorme; normaliza nivel', () => {
    limparEventos();
    assert.equal(registrarEvento('t1', { mensagem: '' }), null);
    assert.equal(registrarEvento(null, { mensagem: 'x' }), null);
    const e = registrarEvento('t1', { mensagem: 'x'.repeat(1000), nivel: 'catastrofe' });
    assert.equal(e.mensagem.length, 300);
    assert.equal(e.nivel, 'info');
  });
});

describe('preferencias da conexao (unidade)', () => {
  it('sem nada salvo, tudo desligado e mensagem padrao', () => {
    assert.deepEqual(configEfetiva(undefined), CONFIG_PADRAO);
    assert.deepEqual(configEfetiva({}), CONFIG_PADRAO);
    assert.equal(CONFIG_PADRAO.mensagemChamada, MENSAGEM_CHAMADA_PADRAO);
  });

  it('so valores booleanos de verdade ligam uma opcao', () => {
    const c = configEfetiva({ rejeitarChamadas: 'sim', marcarComoLida: 1, mensagemChamada: '   ' });
    assert.equal(c.rejeitarChamadas, false);
    assert.equal(c.marcarComoLida, false);
    assert.equal(c.mensagemChamada, MENSAGEM_CHAMADA_PADRAO);
  });

  it('sincronizar contatos vem LIGADA e so um false de verdade desliga', () => {
    assert.equal(configEfetiva({}).sincronizarContatos, true);
    assert.equal(configEfetiva({ sincronizarContatos: 'nao' }).sincronizarContatos, true);
    assert.equal(configEfetiva({ sincronizarContatos: false }).sincronizarContatos, false);
  });

  it('config quebrada (nao objeto) nao derruba', () => {
    assert.deepEqual(configEfetiva('lixo'), CONFIG_PADRAO);
    assert.deepEqual(configEfetiva(null), CONFIG_PADRAO);
  });
});
