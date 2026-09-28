import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

/**
 * Prazo de validade dos registros:
 *   - chamadas de IA: detalhe ~90 dias; mes inteiro mais velho vira totais,
 *     e o relatorio do mes continua IGUAL antes e depois;
 *   - auditoria: 2 anos por ano cheio (em 2026 fica 2024+; sai ate 2023);
 *   - notificacoes fechadas ha mais de 30 dias saem; aberta nunca.
 *
 * "Hoje" e fixo (28/09/2026), passado as funcoes. Dados proprios: chamadas de
 * IA com modelo "modelo-retencao", ids "ret_...".
 */

let app;
let cab;
let tenantId;
let usuarioId;
let db;
let s;
let r; // modulo de retencao

const AGORA = new Date('2026-09-28T12:00:00-03:00').getTime();
const em = (iso) => new Date(`${iso}-03:00`);

before(async () => {
  ({ app } = await criarAppDeTeste());
  const dono = await entrar(app);
  cab = dono.cabecalho;
  tenantId = dono.usuario.tenantId;
  usuarioId = dono.usuario.id;
  ({ db } = await import('../src/db/client.js'));
  s = await import('../src/db/schema/index.js');
  r = await import('../src/modules/dados/retencao.js');
  const { eq } = await import('drizzle-orm');
  await db.update(s.tenants).set({ fusoHorario: 'America/Sao_Paulo' }).where(eq(s.tenants.id, tenantId));
});

after(async () => {
  await app?.close();
});

describe('chamadas de IA', () => {
  let seq = 0;
  const chamada = (quando, extra = {}) => ({
    id: `ret_${++seq}`,
    tenantId,
    origem: 'atendimento',
    agentKey: 'atendente',
    provedor: 'gemini',
    modelo: 'modelo-retencao',
    sucesso: true,
    latenciaMs: 1000,
    tokensEntrada: 100,
    tokensSaida: 20,
    createdAt: em(quando),
    ...extra
  });
  const relatorio = async (de, ate) => {
    const res = await app.inject({ method: 'GET', url: `/api/analises?de=${de}&ate=${ate}`, headers: cab });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().ia;
  };
  const doModelo = (ia) => ia.porModelo.find((m) => m.modelo === 'gemini · modelo-retencao');

  it('mes inteiro com mais de 90 dias vira totais; o relatorio do periodo nao muda', async () => {
    const { and, eq, gte, lt } = await import('drizzle-orm');
    await db.insert(s.aiCalls).values([
      chamada('2026-05-02T10:00:00'),
      chamada('2026-05-15T10:00:00', { latenciaMs: 3000, tokensEntrada: 300 }),
      chamada('2026-05-31T23:30:00', { sucesso: false, latenciaMs: 9000 }), // ultimo minuto de maio (fuso)
      chamada('2026-06-15T10:00:00'), // junho contem o limite dos 90 dias: fica em detalhe
      chamada('2026-06-16T10:00:00', { agentKey: null, origem: 'transcricao' })
    ]);

    const antes = await relatorio('2026-05-01', '2026-06-30');
    const res = await r.consolidarUsoDeIaAntigo({ agora: AGORA });
    const depois = await relatorio('2026-05-01', '2026-06-30');

    assert.ok(res.linhasApagadas >= 3, JSON.stringify(res));
    for (const campo of ['chamadas', 'falhas', 'tokensEntrada', 'tokensSaida', 'latenciaMediaMs', 'taxaSucesso']) {
      assert.equal(depois[campo], antes[campo], campo);
    }
    assert.deepEqual(doModelo(depois), doModelo(antes));
    assert.deepEqual(depois.porAgente, antes.porAgente);
    assert.equal(depois.estimado, undefined, 'periodo com meses inteiros e exato');

    const noMes = (ini, fim) =>
      db.select().from(s.aiCalls).where(and(eq(s.aiCalls.modelo, 'modelo-retencao'), gte(s.aiCalls.createdAt, em(ini)), lt(s.aiCalls.createdAt, em(fim))));
    assert.equal((await noMes('2026-05-01T00:00:00', '2026-06-01T00:00:00')).length, 0, 'detalhe de maio saiu');
    assert.equal((await noMes('2026-06-01T00:00:00', '2026-07-01T00:00:00')).length, 2, 'junho continua em detalhe');

    const [maio] = await db.select().from(s.aiCallsMensais).where(and(eq(s.aiCallsMensais.mes, '2026-05'), eq(s.aiCallsMensais.modelo, 'modelo-retencao')));
    assert.equal(maio.chamadas, 3);
    assert.equal(maio.sucessos, 2);
    assert.equal(maio.tokensEntrada, 500);
    assert.equal(maio.latenciaSomaSucessoMs, 4000, 'so a latencia das que deram certo');
  });

  it('rodar de novo nao soma duas vezes', async () => {
    const antes = await relatorio('2026-05-01', '2026-05-31');
    const res = await r.consolidarUsoDeIaAntigo({ agora: AGORA });
    assert.equal(res.linhasApagadas, 0);
    assert.deepEqual(await relatorio('2026-05-01', '2026-05-31'), antes);
  });

  it('periodo que pega um mes antigo pela metade: proporcional e marcado como estimado', async () => {
    const ia = await relatorio('2026-05-01', '2026-05-15');
    assert.equal(ia.estimado, true);
    assert.ok(doModelo(ia).chamadas >= 1 && doModelo(ia).chamadas <= 3);
  });
});

describe('auditoria e notificacoes', () => {
  it('auditoria: 2 anos por ANO CHEIO (em 2026 sai ate 2023, fica 2024 e 2025)', async () => {
    const { eq } = await import('drizzle-orm');
    const linha = (id, quando) => ({ id, tenantId, userNome: 'teste', acao: 'ret.teste', entidade: 'teste', createdAt: em(quando) });
    await db.insert(s.auditLogs).values([
      linha('ret_aud_2023', '2023-12-31T23:00:00'),
      linha('ret_aud_2024', '2024-01-01T00:30:00'),
      linha('ret_aud_2025', '2025-03-01T10:00:00')
    ]);
    const res = await r.expurgarRegistros({ agora: AGORA });
    assert.ok(res.auditoria >= 1);
    const ficou = (await db.select().from(s.auditLogs).where(eq(s.auditLogs.acao, 'ret.teste'))).map((a) => a.id).sort();
    assert.deepEqual(ficou, ['ret_aud_2024', 'ret_aud_2025']);
  });

  it('notificacao fechada ha mais de 30 dias sai; recente e ABERTA ficam', async () => {
    const { inArray } = await import('drizzle-orm');
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const leads = await import('../src/modules/leads/leads.service.js');
    const lead = await leads.encontrarOuCriarPorTelefone(tenantId, '5592900044001', 'Cliente Retencao');
    const conversationId = await conversas.encontrarOuAbrir(tenantId, { leadId: lead.id });
    const dias = (n) => new Date(AGORA - n * 86_400_000);
    const notif = (id, extra) => ({ id, tenantId, userId: usuarioId, conversationId, motivo: 'teste', ...extra });
    await db.insert(s.teamNotifications).values([
      notif('ret_not_velha', { createdAt: dias(60), fechadaEm: dias(40) }),
      notif('ret_not_recente', { createdAt: dias(15), fechadaEm: dias(10) }),
      notif('ret_not_aberta', { createdAt: dias(100), fechadaEm: null })
    ]);
    await r.expurgarRegistros({ agora: AGORA });
    const ficou = (
      await db.select().from(s.teamNotifications).where(inArray(s.teamNotifications.id, ['ret_not_velha', 'ret_not_recente', 'ret_not_aberta']))
    ).map((n) => n.id).sort();
    assert.deepEqual(ficou, ['ret_not_aberta', 'ret_not_recente']);
  });
});
