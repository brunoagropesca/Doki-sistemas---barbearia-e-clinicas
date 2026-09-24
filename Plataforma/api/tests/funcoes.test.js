import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { garantirUsuarioDev } from '../src/db/usuario-dev.js';

/**
 * Funcoes matrizes: os interruptores que so o DEV ve.
 *
 * O que importa guardar: desligada, a funcao some de verdade (API responde
 * 404, o motor pula a etapa) — nao so do menu.
 */

let app;
let cabDono;
let cabDev;
let tenantId;

async function definir(chave, ligada) {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/dev/funcoes/${chave}`,
    headers: cabDev,
    payload: { ligada }
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

before(async () => {
  ({ app } = await criarAppDeTeste());
  const dono = await entrar(app);
  cabDono = dono.cabecalho;
  tenantId = dono.usuario.tenantId;
  await garantirUsuarioDev({ username: 'dev.funcoes', nome: 'Dev', senha: 'senha-dev-12345' });
  ({ cabecalho: cabDev } = await entrar(app, 'dev.funcoes', 'senha-dev-12345'));
});

after(async () => {
  await app?.close();
});

describe('pagina DEV de funcoes', () => {
  it('so o DEV enxerga a lista (para os outros a rota nao existe)', async () => {
    const dono = await app.inject({ method: 'GET', url: '/api/dev/funcoes', headers: cabDono });
    assert.equal(dono.statusCode, 404);

    const dev = await app.inject({ method: 'GET', url: '/api/dev/funcoes', headers: cabDev });
    assert.equal(dev.statusCode, 200);
    const { funcoes, grupos } = dev.json();
    assert.ok(grupos.length >= 2);
    assert.ok(funcoes.every((f) => f.ligada === true), 'tudo nasce ligado');
  });

  it('dono nao consegue desligar nada', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/dev/funcoes/campanhas',
      headers: cabDono,
      payload: { ligada: false }
    });
    assert.equal(res.statusCode, 404);
  });

  it('funcao inexistente responde 404', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/dev/funcoes/nao-existe',
      headers: cabDev,
      payload: { ligada: false }
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('desligar uma tela', () => {
  it('campanhas desligadas: a API some e a tela fica sabendo', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/campanhas', headers: cabDono })).statusCode, 200);

    await definir('campanhas', false);
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/api/campanhas', headers: cabDono })).statusCode, 404);
      const { funcoes } = (await app.inject({ method: 'GET', url: '/api/funcoes', headers: cabDono })).json();
      assert.equal(funcoes.campanhas, false);
      assert.equal(funcoes.quadro, true);
    } finally {
      await definir('campanhas', true);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/campanhas', headers: cabDono })).statusCode, 200);
  });

  it('avisos desligados: nao da para mandar e os pendentes somem', async () => {
    const criado = await app.inject({
      method: 'POST',
      url: '/api/usuarios',
      headers: cabDono,
      payload: { username: 'aviso.funcao', nome: 'Pessoa Aviso', senha: 'senha-forte-123' }
    });
    const alvo = criado.json().usuario;
    const mandar = () =>
      app.inject({ method: 'POST', url: `/api/usuarios/${alvo.id}/avisos`, headers: cabDono, payload: { mensagem: 'Oi' } });

    assert.equal((await mandar()).statusCode, 201);
    const pessoa = await entrar(app, 'aviso.funcao', 'senha-forte-123');

    await definir('avisos_gerencia', false);
    try {
      assert.equal((await mandar()).statusCode, 404);
      const pend = (await app.inject({ method: 'GET', url: '/api/avisos/pendentes', headers: pessoa.cabecalho })).json();
      assert.equal(pend.avisos.length, 0);
    } finally {
      await definir('avisos_gerencia', true);
    }
    const pend = (await app.inject({ method: 'GET', url: '/api/avisos/pendentes', headers: pessoa.cabecalho })).json();
    assert.equal(pend.avisos.length, 0, 'desligar cancela os pendentes: religado, o aviso velho nao volta a piscar');
    const { db } = await import('../src/db/client.js');
    const { teamAlerts } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const [aviso] = await db.select().from(teamAlerts).where(eq(teamAlerts.userId, alvo.id));
    assert.ok(aviso.canceladoEm, 'cancelado');
    assert.equal(aviso.lidoEm, null, 'cancelado nao conta como lido');
  });
});

describe('desligar o motor', () => {
  it('IA desligada: a mensagem vai para a fila humana sem chamar modelo', async () => {
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    await definir('atendimento_ia', false);
    try {
      const r = await atendimento.responder({
        tenantId,
        texto: 'quero marcar um corte amanha',
        simulacao: true,
        modoOverride: 'ia',
        // Se o modelo fosse chamado, este provedor quebraria o teste.
        provedores: [{ nome: 'proibido', gerar: () => assert.fail('a IA nao devia ser chamada') }]
      });
      assert.equal(r.transferido, true);
      assert.equal(r.respondidoPor, 'fallback_humano');
    } finally {
      await definir('atendimento_ia', true);
    }
  });

  it('leitura de humor desligada nao roda', async () => {
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    await definir('leitura_humor', false);
    try {
      const r = await atendimento.avaliarHumor({ tenantId, conversationId: 'conv_qualquer', historico: [] });
      assert.equal(r, null);
    } finally {
      await definir('leitura_humor', true);
    }
  });
});

/**
 * Regressoes dos defeitos achados no teste exploratorio das funcoes
 * desligadas. Cada um aqui ja aconteceu de verdade.
 */
describe('regressoes: funcoes desligadas', () => {
  async function conversaNaFila(telefone) {
    const leads = await import('../src/modules/leads/leads.service.js');
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const lead = await leads.encontrarOuCriarPorTelefone(tenantId, telefone, 'Cliente Regressao');
    const id = await conversas.encontrarOuAbrir(tenantId, { leadId: lead.id });
    await conversas.enviarParaFila(tenantId, id);
    return id;
  }

  it('Atena desligada recusa comando do livechat e nao gera resumo', async () => {
    const id = await conversaNaFila('5511922220001');
    await definir('agente_atena', false);
    try {
      const r = await app.inject({
        method: 'POST',
        url: '/api/atena/comando',
        headers: cabDono,
        payload: { conversationId: id, comando: 'ver horarios de amanha' }
      });
      assert.equal(r.statusCode, 422);
      assert.match(r.json().erro.mensagem, /desligada/i);

      const { atenaPermite } = await import('../src/ai/permissoes.js');
      assert.equal(await atenaPermite(tenantId, 'resumo'), false, 'resumo, funil e rotina perguntam por aqui');
      assert.equal(await atenaPermite(tenantId, 'catalogo'), false, 'sem catalogo no prompt da Sofia');
    } finally {
      await definir('agente_atena', true);
    }
  });

  it('modo "so menu" com o menu desligado vai para a fila, sem chamar IA', async () => {
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    await definir('menu_automatico', false);
    try {
      const r = await atendimento.responder({
        tenantId,
        texto: 'oi',
        simulacao: true,
        modoOverride: 'menu',
        provedores: [{ nome: 'proibido', gerar: () => assert.fail('a IA nao devia ser chamada') }]
      });
      assert.equal(r.transferido, true);
      assert.equal(r.respondidoPor, 'fallback_humano');
      assert.ok(r.detalhes.motivoTransferencia, 'a notificacao explica o motivo');
    } finally {
      await definir('menu_automatico', true);
    }
  });

  it('IA desligada: o encaminhamento traz o motivo para a notificacao', async () => {
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    await definir('atendimento_ia', false);
    try {
      const r = await atendimento.responder({ tenantId, texto: 'oi', simulacao: true, modoOverride: 'ia' });
      assert.match(r.detalhes.motivoTransferencia, /IA esta desligada/);
    } finally {
      await definir('atendimento_ia', true);
    }
  });

  it('desligar notificacoes limpa as que estavam na tela (inclusive urgente)', async () => {
    const notificacoes = await import('../src/modules/notificacoes/notificacoes.service.js');
    const id = await conversaNaFila('5511922220002');
    await notificacoes.notificarEncaminhamento(tenantId, id, { motivo: 'x', clienteFrustrado: true });
    const { cabecalho } = await entrar(app, 'recepcao');
    const ver = async () => (await app.inject({ method: 'GET', url: '/api/notificacoes', headers: cabecalho })).json().notificacoes;
    assert.ok((await ver()).some((n) => n.conversationId === id && n.urgente));

    await definir('notificacoes_encaminhamento', false);
    try {
      assert.equal((await ver()).length, 0);
    } finally {
      await definir('notificacoes_encaminhamento', true);
    }
    assert.ok(!(await ver()).some((n) => n.conversationId === id), 'religar nao ressuscita a notificacao velha');
  });

  it('audio que cai na fila sem transcricao notifica a equipe', async () => {
    const gateway = await import('../src/channels/gateway.js');
    await gateway.receberMensagem({
      tenantId,
      remetente: '5511922220003',
      nomeRemetente: 'Cliente Audio',
      texto: '🎤 Áudio',
      idExterno: 'reg_audio_1',
      midia: { tipo: 'audio', url: '/api/arquivos/x.ogg', transcricao: null }
    });
    const { db } = await import('../src/db/client.js');
    const s = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const [lead] = await db.select().from(s.leads).where(eq(s.leads.telefone, '5511922220003'));
    const [conv] = await db.select().from(s.conversations).where(eq(s.conversations.leadId, lead.id));
    const notifs = await db.select().from(s.teamNotifications).where(eq(s.teamNotifications.conversationId, conv.id));
    assert.ok(notifs.length > 0);
    assert.match(notifs[0].motivo, /audio/i);
  });

  it('sem login, rota do DEV responde como rota inexistente', async () => {
    const dev = await app.inject({ method: 'GET', url: '/api/dev/funcoes' });
    const inexistente = await app.inject({ method: 'GET', url: '/api/rota-que-nao-existe' });
    assert.equal(dev.statusCode, 404);
    assert.equal(dev.statusCode, inexistente.statusCode);
    assert.equal(dev.json().erro.codigo, inexistente.json().erro.codigo);
  });
});
