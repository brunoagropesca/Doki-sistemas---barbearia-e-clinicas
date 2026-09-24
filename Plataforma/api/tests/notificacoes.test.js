import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

/**
 * Notificacao de encaminhamento da IA para o atendente.
 *
 * O que importa guardar: a notificacao de cliente FRUSTRADO nao sai da tela
 * no "x" — so atendendo — e quando alguem atende, ela some da tela de todos.
 */

let app;
let tenantId;
let leads;
let conversas;
let notificacoes;

const SENHA = 'senha-forte-123';
let cabDono;

async function criarAtendente(username) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/usuarios',
    headers: cabDono,
    payload: { username, nome: `Atendente ${username}`, senha: SENHA, cargo: 'atendente' }
  });
  assert.equal(res.statusCode, 201, res.body);
  return entrar(app, username, SENHA);
}

let telefone = 5511900001000;
async function conversaNaFila() {
  telefone += 1;
  const lead = await leads.encontrarOuCriarPorTelefone(tenantId, String(telefone), 'Cliente Bravo');
  const id = await conversas.encontrarOuAbrir(tenantId, { leadId: lead.id });
  await conversas.enviarParaFila(tenantId, id);
  return id;
}

const minhas = async (cab) =>
  (await app.inject({ method: 'GET', url: '/api/notificacoes', headers: cab })).json().notificacoes;

before(async () => {
  ({ app } = await criarAppDeTeste());
  const l = await entrar(app);
  cabDono = l.cabecalho;
  tenantId = l.usuario.tenantId;
  leads = await import('../src/modules/leads/leads.service.js');
  conversas = await import('../src/modules/conversas/conversas.service.js');
  notificacoes = await import('../src/modules/notificacoes/notificacoes.service.js');
});

after(async () => {
  await app?.close();
});

describe('encaminhamento da IA', () => {
  it('cliente frustrado: nao fecha no x, so atendendo — e some da tela de todos', async () => {
    const ana = await criarAtendente('ntf.ana');
    const bia = await criarAtendente('ntf.bia');
    const id = await conversaNaFila();

    await notificarEncaminhamento(id, { motivo: 'Corte saiu torto, quer refazer', clienteFrustrado: true });

    const daAna = (await minhas(ana.cabecalho)).find((n) => n.conversationId === id);
    const daBia = (await minhas(bia.cabecalho)).find((n) => n.conversationId === id);
    assert.ok(daAna && daBia, 'sem dono, toda a equipe da fila e notificada');
    assert.equal(daAna.urgente, true);
    assert.equal(daAna.motivo, 'Corte saiu torto, quer refazer');
    assert.equal(daAna.leadNome, 'Cliente Bravo');

    const fechar = await app.inject({ method: 'POST', url: `/api/notificacoes/${daAna.id}/fechar`, headers: ana.cabecalho });
    assert.equal(fechar.statusCode, 422);

    const atender = await app.inject({
      method: 'POST',
      url: `/api/notificacoes/${daAna.id}/atender`,
      headers: ana.cabecalho
    });
    assert.equal(atender.statusCode, 200, atender.body);
    assert.equal(atender.json().conversationId, id);

    assert.ok(!(await minhas(ana.cabecalho)).some((n) => n.conversationId === id));
    assert.ok(!(await minhas(bia.cabecalho)).some((n) => n.conversationId === id), 'a da colega devia sumir');
  });

  it('encaminhamento comum pode ser dispensado no x', async () => {
    const caio = await criarAtendente('ntf.caio');
    const id = await conversaNaFila();
    await notificarEncaminhamento(id, { motivo: 'Quer falar com uma pessoa' });

    const n = (await minhas(caio.cabecalho)).find((x) => x.conversationId === id);
    assert.equal(n.urgente, false);

    const fechar = await app.inject({ method: 'POST', url: `/api/notificacoes/${n.id}/fechar`, headers: caio.cabecalho });
    assert.equal(fechar.statusCode, 200);
    assert.ok(!(await minhas(caio.cabecalho)).some((x) => x.conversationId === id));
  });

  it('conversa distribuida notifica so quem a recebeu', async () => {
    const dani = await criarAtendente('ntf.dani');
    const edu = await criarAtendente('ntf.edu');
    const id = await conversaNaFila();
    const conversationRepo = await import('../src/modules/conversas/conversas.repo.js');
    await conversationRepo.atualizar(tenantId, id, { assignedUserId: dani.usuario.id });

    await notificarEncaminhamento(id, { motivo: 'x' });

    assert.ok((await minhas(dani.cabecalho)).some((n) => n.conversationId === id));
    assert.ok(!(await minhas(edu.cabecalho)).some((n) => n.conversationId === id));
  });

  it('humor ja lido como frustrado tambem torna a notificacao urgente', async () => {
    const fabi = await criarAtendente('ntf.fabi');
    const id = await conversaNaFila();
    await conversas.registrarHumor(tenantId, id, { humor: 'frustrado', resumo: 'reclamando', numeroDaMensagem: 1 });

    await notificarEncaminhamento(id, { motivo: 'pediu gente' });
    const n = (await minhas(fabi.cabecalho)).find((x) => x.conversationId === id);
    assert.equal(n.urgente, true);
  });

  it('atender pelo livechat tambem fecha a notificacao', async () => {
    const gabi = await criarAtendente('ntf.gabi');
    const id = await conversaNaFila();
    await notificarEncaminhamento(id, { motivo: 'x', clienteFrustrado: true });

    const assumir = await app.inject({ method: 'POST', url: `/api/conversas/${id}/assumir`, headers: gabi.cabecalho });
    assert.equal(assumir.statusCode, 200, assumir.body);
    assert.ok(!(await minhas(gabi.cabecalho)).some((n) => n.conversationId === id));
  });

  it('ninguem atende a notificacao de outra pessoa', async () => {
    const hugo = await criarAtendente('ntf.hugo');
    const ivo = await criarAtendente('ntf.ivo');
    const id = await conversaNaFila();
    await notificarEncaminhamento(id, { motivo: 'x' });

    const doHugo = (await minhas(hugo.cabecalho)).find((n) => n.conversationId === id);
    const res = await app.inject({ method: 'POST', url: `/api/notificacoes/${doHugo.id}/atender`, headers: ivo.cabecalho });
    assert.equal(res.statusCode, 404);
  });
});

function notificarEncaminhamento(id, opcoes) {
  return notificacoes.notificarEncaminhamento(tenantId, id, opcoes);
}
