import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import {
  classificarModelo,
  ehInstavel,
  MAXIMO_RECOMENDADOS,
  ordenarParaExibicao,
  selecionarMelhores
} from '../src/ai/catalogo-modelos.js';
import { ErroDeProvedor } from '../src/ai/providers/base.js';
import { cifrar } from '../src/core/crypto.js';
import {
  acaoEmLoteModelos,
  alternarModelo,
  descobrirModelos,
  iniciarTesteDeModelos,
  salvarProvedor,
  testarModelosNoBoot
} from '../src/modules/ia/ia.service.js';

/**
 * Catalogo de modelos do Gemini: testar todos ao iniciar, separar os melhores
 * para atender no WhatsApp, e deixar a pessoa ajustar sem que o sistema
 * desfaca o que ela fez.
 *
 * Nada aqui fala com o Google: a lista de modelos e a chamada de teste sao
 * injetadas.
 */

let app;
let cab;
let cabRecepcao;
let cabGerente;
let tenantId;
let ctx = {};

const CHAVE = 'AIzaSyD-chave-de-teste-so-para-o-teste-123';

/** Modelo de mentira: falha em quem tiver 'quebrado' no nome. */
const impl = {
  precisaChave: true,
  async gerar({ modelo }) {
    if (modelo.includes('quebrado')) throw new ErroDeProvedor('HTTP 404: modelo nao suportado', { reTentavel: false });
    return { texto: 'funcionando', chamadasDeFerramenta: [], tokens: { entrada: 1, saida: 1 }, modelo };
  }
};

const CATALOGO = [
  { nome: 'models/gemini-est', nomeExibicao: 'Gemini Estavel', limiteEntrada: 1_048_576, limiteSaida: 65_536 },
  { nome: 'models/gemini-x-preview', nomeExibicao: 'Gemini X Preview', limiteEntrada: 1_048_576, limiteSaida: 65_536 },
  { nome: 'models/gemini-tts', nomeExibicao: 'Gemini 2.5 Flash Preview TTS', limiteEntrada: 8192, limiteSaida: 16_384 },
  { nome: 'models/gemini-quebrado', nomeExibicao: 'Gemini Quebrado', limiteEntrada: 8192, limiteSaida: 2048 }
];

const listar = async () => CATALOGO;

async function prepararGemini(extra = {}) {
  await ctx.db.delete(ctx.s.aiProviders).where(eq(ctx.s.aiProviders.tenantId, tenantId));
  await ctx.db.insert(ctx.s.aiProviders).values({
    id: 'aip_gem',
    tenantId,
    provedor: 'gemini',
    apiKeyCifrada: cifrar(CHAVE),
    apiKeySufixo: CHAVE.slice(-4),
    habilitado: true,
    modelos: [],
    ...extra
  });
}

const ler = async () => (await ctx.db.select().from(ctx.s.aiProviders).where(eq(ctx.s.aiProviders.id, 'aip_gem')))[0];
const porNome = (linha) => Object.fromEntries(linha.modelos.map((m) => [m.nome, m]));

async function testar(opts = {}) {
  const { concluido } = await iniciarTesteDeModelos(tenantId, 'gemini', { impl, listar, timeoutMs: 1000, ...opts });
  await concluido;
  return ler();
}

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cab } = await entrar(app));
  ({ cabecalho: cabRecepcao } = await entrar(app, 'recepcao'));

  const { db } = await import('../src/db/client.js');
  const s = await import('../src/db/schema/index.js');
  const [t] = await db.select().from(s.tenants);
  tenantId = t.id;
  ctx = { db, s };

  // Um gerente (admin) para provar que revelar chave e coisa so do DONO.
  await app.inject({
    method: 'POST', url: '/api/usuarios', headers: cab,
    payload: { username: 'gerente', senha: 'senha-longa-123', nome: 'Gerente', cargo: 'admin' }
  });
  ({ cabecalho: cabGerente } = await entrar(app, 'gerente', 'senha-longa-123'));
});

after(async () => {
  await app?.close();
});

// ============================================================================

describe('classificar e escolher modelos', () => {
  it('separa texto, audio, imagem e outros pelo nome', () => {
    assert.equal(classificarModelo({ nome: 'models/gemini-2.5-flash' }), 'texto');
    assert.equal(classificarModelo({ nome: 'models/gemini-2.5-flash-preview-tts' }), 'audio');
    assert.equal(classificarModelo({ nome: 'models/x', nomeExibicao: 'Gemini 3.5 Transcribe' }), 'audio');
    assert.equal(classificarModelo({ nome: 'models/gemini-2.5-flash-image' }), 'imagem');
    assert.equal(classificarModelo({ nome: 'models/x', nomeExibicao: 'Nano Banana' }), 'imagem');
    assert.equal(classificarModelo({ nome: 'models/gemini-robotics-er-2-preview' }), 'outro');
    assert.equal(classificarModelo({ nome: 'models/gemma-4-26b-a4b-it' }), 'texto');
  });

  it('previa e experimental sao instaveis; o resto nao', () => {
    assert.equal(ehInstavel('models/gemini-3-flash-preview'), true);
    assert.equal(ehInstavel('models/gemini-2.0-flash-exp'), true);
    assert.equal(ehInstavel('models/gemini-2.5-flash'), false);
    assert.equal(ehInstavel('models/gemini-flash-latest'), false);
  });

  const m = (nome, extra) => ({ nome, categoria: 'texto', ativo: false, manual: false, ...extra });

  it('recomenda so quem PASSOU e e de TEXTO', () => {
    const { modelos, melhor } = selecionarMelhores([
      m('texto-ok', { ok: true, latenciaMs: 100 }),
      m('texto-falhou', { ok: false, latenciaMs: 50 }),
      m('audio-ok', { ok: true, latenciaMs: 10, categoria: 'audio' }),
      m('nao-testado')
    ]);
    const r = Object.fromEntries(modelos.map((x) => [x.nome, x]));

    assert.equal(r['texto-ok'].recomendado, true);
    assert.equal(r['texto-ok'].ativo, true);
    assert.equal(r['texto-falhou'].ativo, false);
    assert.equal(r['audio-ok'].recomendado, false, 'passou no teste, mas nao e modelo de conversa');
    assert.equal(r['audio-ok'].ativo, false);
    assert.equal(melhor, 'texto-ok');
  });

  it('estavel vem antes de previa, mesmo que a previa seja mais rapida', () => {
    const { melhor } = selecionarMelhores([
      m('rapido-preview', { ok: true, latenciaMs: 50 }),
      m('lento-estavel', { ok: true, latenciaMs: 900 })
    ]);
    assert.equal(melhor, 'lento-estavel', 'previa pode sumir amanha; atendimento precisa de estabilidade');
  });

  it(`liga no maximo ${MAXIMO_RECOMENDADOS} e escolhe os mais rapidos`, () => {
    const lista = Array.from({ length: 20 }, (_, i) => m(`m${i}`, { ok: true, latenciaMs: 1000 - i * 10 }));
    const { modelos } = selecionarMelhores(lista);

    const ligados = modelos.filter((x) => x.ativo).map((x) => x.nome);
    assert.equal(ligados.length, MAXIMO_RECOMENDADOS);
    assert.ok(ligados.includes('m19'), 'o mais rapido (m19) precisa estar entre os ligados');
    assert.ok(!ligados.includes('m0'), 'o mais lento nao');
  });

  /**
   * Sem isto, cada reinicio do sistema desfaria o que a pessoa configurou.
   */
  it('NAO mexe no que a pessoa ligou ou desligou a mao', () => {
    const { modelos } = selecionarMelhores([
      m('bom', { ok: true, latenciaMs: 100 }),
      m('religado-a-mao', { ok: false, ativo: true, manual: true }),
      m('desligado-a-mao', { ok: true, latenciaMs: 50, ativo: false, manual: true })
    ]);
    const r = Object.fromEntries(modelos.map((x) => [x.nome, x]));

    assert.equal(r['religado-a-mao'].ativo, true, 'ligado a mao continua ligado, mesmo tendo falhado');
    assert.equal(r['desligado-a-mao'].ativo, false, 'desligado a mao continua desligado, mesmo sendo bom');
    assert.equal(r['desligado-a-mao'].recomendado, true, 'mas a recomendacao aparece para a pessoa decidir');
  });

  /**
   * Um teste feito durante uma queda do Google reprovaria tudo, e desligar tudo
   * tiraria o Gemini do ar por horas por causa de um soluco.
   */
  it('se NENHUM passou, nao desliga nada', () => {
    const { modelos, melhor, elegiveis } = selecionarMelhores([
      m('a', { ok: false, ativo: true }),
      m('b', { ok: false, ativo: true })
    ]);

    assert.equal(elegiveis, 0);
    assert.equal(melhor, null);
    assert.ok(modelos.every((x) => x.ativo === true), 'o estado anterior precisa ser preservado');
  });

  it('a ordem de exibicao poe os aprovados e ligados primeiro', () => {
    const ordem = ordenarParaExibicao([
      m('desligado-reprovado', { ok: false, ativo: false }),
      m('desligado-aprovado', { ok: true, ativo: false, latenciaMs: 10 }),
      m('ligado-reprovado', { ok: false, ativo: true }),
      m('ligado-lento', { ok: true, ativo: true, latenciaMs: 900 }),
      m('ligado-rapido', { ok: true, ativo: true, latenciaMs: 100 })
    ]).map((x) => x.nome);

    assert.deepEqual(ordem, ['ligado-rapido', 'ligado-lento', 'ligado-reprovado', 'desligado-aprovado', 'desligado-reprovado']);
  });
});

// ============================================================================

describe('descobrir modelos', () => {
  it('guarda nome de exibicao, limites e categoria; modelos novos entram DESLIGADOS', async () => {
    await prepararGemini();
    await descobrirModelos(tenantId, 'gemini', { listar });

    const m = porNome(await ler());
    assert.equal(m['models/gemini-est'].nomeExibicao, 'Gemini Estavel');
    assert.equal(m['models/gemini-est'].limiteEntrada, 1_048_576);
    assert.equal(m['models/gemini-est'].categoria, 'texto');
    assert.equal(m['models/gemini-tts'].categoria, 'audio');
    assert.ok(Object.values(m).every((x) => x.ativo === false), 'so passam a valer depois de testados');
  });

  it('preserva o resultado de testes e escolhas ja feitos', async () => {
    await prepararGemini({
      modelos: [{ nome: 'models/gemini-est', ativo: true, manual: true, ok: true, latenciaMs: 321 }]
    });
    await descobrirModelos(tenantId, 'gemini', { listar });

    const est = porNome(await ler())['models/gemini-est'];
    assert.equal(est.ok, true);
    assert.equal(est.latenciaMs, 321);
    assert.equal(est.ativo, true);
    assert.equal(est.manual, true);
  });

  /**
   * Nao apagamos 41 modelos testados porque a internet piscou.
   */
  it('se a consulta ao Google falha, o catalogo salvo e MANTIDO', async () => {
    await prepararGemini({ modelos: [{ nome: 'models/salvo', ativo: true, ok: true }] });

    const r = await descobrirModelos(tenantId, 'gemini', { listar: async () => null });

    assert.equal(r.modelos.length, 1);
    assert.match(r.aviso, /catálogo salvo foi mantido/);
    assert.equal((await ler()).modelos.length, 1);
  });
});

// ============================================================================

describe('teste completo: escolhe os melhores para WhatsApp', () => {
  it('testa tudo, liga so os recomendados e escolhe o primario sozinho', async () => {
    await prepararGemini();
    const linha = await testar();
    const m = porNome(linha);

    assert.equal(m['models/gemini-est'].ok, true);
    assert.equal(m['models/gemini-quebrado'].ok, false);
    assert.match(m['models/gemini-quebrado'].erro, /404/);

    // Texto que passou: ligado e recomendado.
    assert.equal(m['models/gemini-est'].ativo, true);
    assert.equal(m['models/gemini-est'].recomendado, true);
    assert.equal(m['models/gemini-x-preview'].ativo, true);

    // Audio passou no teste de texto, mas nao e para conversa.
    assert.equal(m['models/gemini-tts'].ok, true);
    assert.equal(m['models/gemini-tts'].ativo, false);
    assert.equal(m['models/gemini-tts'].recomendado, false);

    // Quebrado fica desligado.
    assert.equal(m['models/gemini-quebrado'].ativo, false);

    // O primario e o melhor: estavel antes de previa.
    assert.equal(linha.modeloPadrao, 'models/gemini-est');
    assert.equal(linha.modeloManual, false);
    assert.ok(linha.testadoEm, 'o momento do teste precisa ficar gravado (a validade depende disso)');
  });

  it('a escolha do primario feita pela PESSOA nao e sobrescrita pelo teste', async () => {
    await prepararGemini();
    await testar();

    // A pessoa escolhe a previa como primaria.
    await salvarProvedor(tenantId, 'gemini', { modeloPadrao: 'models/gemini-x-preview' });
    let linha = await ler();
    assert.equal(linha.modeloManual, true);

    // Um novo teste roda (por exemplo, no proximo reinicio).
    linha = await testar();
    assert.equal(linha.modeloPadrao, 'models/gemini-x-preview', 'o teste nao pode desfazer a escolha dela');
  });

  it('escolher como primario um modelo desligado LIGA ele (senao a cascata o ignoraria)', async () => {
    await prepararGemini();
    await testar();
    assert.equal(porNome(await ler())['models/gemini-tts'].ativo, false);

    await salvarProvedor(tenantId, 'gemini', { modeloPadrao: 'models/gemini-tts' });

    const tts = porNome(await ler())['models/gemini-tts'];
    assert.equal(tts.ativo, true);
    assert.equal(tts.manual, true);
  });

  it('o que a pessoa ligou/desligou a mao sobrevive a um novo teste', async () => {
    await prepararGemini();
    await testar();

    await alternarModelo(tenantId, 'gemini', 'models/gemini-est', false); // desliga o melhor
    await alternarModelo(tenantId, 'gemini', 'models/gemini-quebrado', true); // liga o que falhou

    const m = porNome(await testar());
    assert.equal(m['models/gemini-est'].ativo, false);
    assert.equal(m['models/gemini-quebrado'].ativo, true);
  });

  it('teste em que TUDO falha nao desliga o Gemini', async () => {
    await prepararGemini();
    await testar(); // estado bom: alguns ligados
    const ligadosAntes = (await ler()).modelos.filter((m) => m.ativo).length;
    assert.ok(ligadosAntes > 0);

    // Agora o Google "cai": todos os modelos falham.
    const caido = { precisaChave: true, async gerar({ modelo }) { throw new ErroDeProvedor('HTTP 503', { modelo, reTentavel: true }); } };
    const linha = await testar({ impl: caido });

    assert.equal(linha.modelos.filter((m) => m.ativo).length, ligadosAntes, 'uma oscilacao nao pode tirar o Gemini do ar');
    assert.ok(linha.modelos.every((m) => m.ok === false), 'mas os resultados refletem a falha');
  });
});

// ============================================================================

describe('acoes em lote do catalogo', () => {
  it('"Ativar Aprovados" liga so quem passou; "Desativar Reprovados" desliga so quem falhou', async () => {
    await prepararGemini({
      modelos: [
        { nome: 'a', ativo: false, ok: true },
        { nome: 'b', ativo: true, ok: false },
        { nome: 'c', ativo: false }, // nunca testado
        { nome: 'd', ativo: true, ok: true }
      ]
    });

    const r1 = await acaoEmLoteModelos(tenantId, 'gemini', 'ativar_aprovados');
    assert.equal(r1.alterados, 1, 'so o "a" muda: o "d" ja estava ligado');
    let m = porNome(await ler());
    assert.equal(m.a.ativo, true);
    assert.equal(m.c.ativo, false, 'sem teste nao ha base para decidir');

    const r2 = await acaoEmLoteModelos(tenantId, 'gemini', 'desativar_reprovados');
    assert.equal(r2.alterados, 1);
    m = porNome(await ler());
    assert.equal(m.b.ativo, false);
    assert.equal(m.a.manual, true, 'e uma decisao da pessoa: fica protegida dos proximos testes');
  });

  it('a rota exige admin e recusa acao desconhecida', async () => {
    await prepararGemini({ modelos: [{ nome: 'a', ativo: false, ok: true }] });

    const ok = await app.inject({ method: 'POST', url: '/api/ia/provedores/gemini/modelos/lote', headers: cab, payload: { acao: 'ativar_aprovados' } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().alterados, 1);

    const ruim = await app.inject({ method: 'POST', url: '/api/ia/provedores/gemini/modelos/lote', headers: cab, payload: { acao: 'apagar_tudo' } });
    assert.equal(ruim.statusCode, 400);

    const proibido = await app.inject({ method: 'POST', url: '/api/ia/provedores/gemini/modelos/lote', headers: cabRecepcao, payload: { acao: 'ativar_aprovados' } });
    assert.equal(proibido.statusCode, 403);
  });
});

// ============================================================================

describe('teste automatico ao iniciar o sistema', () => {
  it('testa quando nunca foi testado', async () => {
    await prepararGemini();

    const r = await testarModelosNoBoot({ ativo: true, validadeHoras: 6, impl, listar, timeoutMs: 1000 });
    await r.concluido;

    assert.equal(r.iniciados, 1);
    assert.ok((await ler()).modelos.some((m) => m.ok === true), 'o resultado precisa estar la quando alguem abrir a tela');
  });

  /**
   * O `npm run dev` reinicia a cada arquivo salvo: sem a validade, cada Ctrl+S
   * dispararia dezenas de chamadas ao Google.
   */
  it('NAO repete enquanto o ultimo teste ainda e valido', async () => {
    const r = await testarModelosNoBoot({ ativo: true, validadeHoras: 6, impl, listar });
    assert.equal(r.iniciados, 0);
  });

  it('repete quando o ultimo teste venceu', async () => {
    await ctx.db.update(ctx.s.aiProviders).set({ testadoEm: new Date(Date.now() - 7 * 3_600_000) }).where(eq(ctx.s.aiProviders.id, 'aip_gem'));

    const r = await testarModelosNoBoot({ ativo: true, validadeHoras: 6, impl, listar, timeoutMs: 1000 });
    await r.concluido;
    assert.equal(r.iniciados, 1);
  });

  it('desligado por configuracao, nao faz nada', async () => {
    await ctx.db.update(ctx.s.aiProviders).set({ testadoEm: null }).where(eq(ctx.s.aiProviders.id, 'aip_gem'));
    const r = await testarModelosNoBoot({ ativo: false, impl, listar });
    assert.equal(r.iniciados, 0);
  });

  it('provedor sem chave ou desligado e ignorado', async () => {
    await prepararGemini({ apiKeyCifrada: null });
    assert.equal((await testarModelosNoBoot({ ativo: true, validadeHoras: 0, impl, listar })).iniciados, 0);

    await prepararGemini({ habilitado: false });
    assert.equal((await testarModelosNoBoot({ ativo: true, validadeHoras: 0, impl, listar })).iniciados, 0);
  });

  it('em testes, o padrao e DESLIGADO (o .env.test impede falar com o Google)', async () => {
    await prepararGemini();
    const r = await testarModelosNoBoot();
    assert.equal(r.iniciados, 0);
  });

  it('uma falha no teste automatico nao estoura', async () => {
    await prepararGemini();
    const quebrado = { precisaChave: true, gerar: async () => { throw new Error('boom'); } };

    // Nao pode lancar: e chamado no boot e ao salvar chave.
    const r = await testarModelosNoBoot({ ativo: true, validadeHoras: 0, impl: quebrado, listar, timeoutMs: 500 });
    await r.concluido;
    assert.equal(r.iniciados, 1);
  });
});

// ============================================================================

describe('ver a chave de API (o "olho")', () => {
  it('a listagem continua SEM a chave — ela so sai pelo olho', async () => {
    await prepararGemini();
    const res = await app.inject({ method: 'GET', url: '/api/ia/provedores', headers: cab });

    assert.ok(!res.body.includes(CHAVE));
    assert.equal(res.json().provedores[0].chaveSufixo, `••••${CHAVE.slice(-4)}`, 'so o final, para conferir qual e');
  });

  it('o dono ve a chave inteira', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ia/provedores/gemini/chave', headers: cab });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().chave, CHAVE);
  });

  it('a resposta nao pode ficar em cache do navegador', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ia/provedores/gemini/chave', headers: cab });
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  /** A chave da IA gasta dinheiro: e coisa do dono. */
  it('gerente (admin) e atendente NAO veem a chave', async () => {
    for (const headers of [cabGerente, cabRecepcao]) {
      const res = await app.inject({ method: 'GET', url: '/api/ia/provedores/gemini/chave', headers });
      assert.equal(res.statusCode, 403);
      assert.ok(!res.body.includes(CHAVE));
    }
  });

  it('sem login nao ve', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ia/provedores/gemini/chave' });
    assert.equal(res.statusCode, 401);
  });

  it('cada visualizacao fica na auditoria, sem a chave', async () => {
    const logs = await ctx.db.select().from(ctx.s.auditLogs).where(eq(ctx.s.auditLogs.acao, 'ia.chave.revelar'));

    assert.ok(logs.length >= 1);
    assert.equal(logs[0].userNome, 'Ze da Barbearia');
    assert.equal(logs[0].entidadeId, 'gemini');
    assert.ok(!JSON.stringify(logs).includes(CHAVE), 'a chave nao pode vazar para o proprio log de auditoria');
  });

  it('avisa quando nao ha chave cadastrada', async () => {
    await prepararGemini({ apiKeyCifrada: null });
    const res = await app.inject({ method: 'GET', url: '/api/ia/provedores/gemini/chave', headers: cab });

    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /Nenhuma chave/);
  });

  it('avisa com clareza quando a chave nao pode ser lida (segredo do servidor mudou)', async () => {
    await prepararGemini({ apiKeyCifrada: 'v1.lixo.lixo.lixo' });
    const res = await app.inject({ method: 'GET', url: '/api/ia/provedores/gemini/chave', headers: cab });

    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /segredo do servidor mudou/);
  });
});
