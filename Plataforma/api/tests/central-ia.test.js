import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { MAX_MODELOS_POR_PROVEDOR, montarFilaDeModelos } from '../src/ai/cascade.js';
import { ollama } from '../src/ai/providers/openai-compat.js';
import { ErroDeProvedor } from '../src/ai/providers/base.js';
import { transcreverAudio } from '../src/ai/transcricao.js';
import { salvarAudio } from '../src/modules/equipe/arquivos.js';
import { paraOggOpus } from '../src/core/audio.js';
import { webmDeMentira } from './helpers/audio-fixture.js';
import { spawnSync } from 'node:child_process';
import ffmpegBin from 'ffmpeg-static';
import { cifrar } from '../src/core/crypto.js';
import { iniciarTesteDeModelos, progressoDoTeste } from '../src/modules/ia/ia.service.js';
import { simular } from '../src/modules/atendimento/simulador.service.js';
import { historicoParaIa, salvarConfiguracao } from '../src/modules/atendimento/atendimento.service.js';

/**
 * Tudo o que sustenta a tela "Central de Configuracao da IA":
 * o simulador, a fila de modelos, o teste em lote, as metricas.
 */

let app;
let cab;
let cabRecepcao;
let tenantId;
let ctx = {};

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cab } = await entrar(app));
  ({ cabecalho: cabRecepcao } = await entrar(app, 'recepcao'));

  const { db } = await import('../src/db/client.js');
  const s = await import('../src/db/schema/index.js');
  const [t] = await db.select().from(s.tenants);
  tenantId = t.id;
  ctx.db = db;
  ctx.s = s;
});

after(async () => {
  await app?.close();
});

// ============================================================================

describe('simulador de atendimento', () => {
  const simularViaApi = (payload, headers = cab) =>
    app.inject({ method: 'POST', url: '/api/ia/simular', headers, payload });

  it('o modo menu responde SEM gastar IA e mostra isso nos bastidores', async () => {
    const res = await simularViaApi({ mensagem: '1', modo: 'menu' });

    assert.equal(res.statusCode, 200);
    const r = res.json();

    assert.equal(r.respondidoPor, 'menu');
    assert.equal(r.bastidores.custoIa, 0);
    assert.equal(r.bastidores.modo, 'menu');
    assert.match(r.baloes.join('\n'), /Corte Degrade/, 'lista os servicos reais do banco');
    assert.ok(r.bastidores.duracaoMs >= 0);
  });

  it('o modo pode ser forcado sem mudar a configuracao da empresa', async () => {
    const antes = (await app.inject({ method: 'GET', url: '/api/atendimento/configuracao', headers: cab })).json().modo;

    await simularViaApi({ mensagem: '1', modo: 'menu' });
    await simularViaApi({ mensagem: '1', modo: 'ia' });

    const depois = (await app.inject({ method: 'GET', url: '/api/atendimento/configuracao', headers: cab })).json().modo;
    assert.equal(depois, antes, 'simular nao pode alterar a configuracao real');
  });

  it('nao envia nada a canal nenhum nem cria conversa real', async () => {
    const conversasAntes = (await ctx.db.select().from(ctx.s.conversations)).length;
    const mensagensAntes = (await ctx.db.select().from(ctx.s.messages)).length;

    // Modo IA sem provedor configurado: cai no fallback humano, que numa
    // conversa real colocaria o cliente na fila.
    const res = await simularViaApi({ mensagem: 'quanto custa o corte?', modo: 'ia' });
    const r = res.json();

    assert.equal(r.respondidoPor, 'fallback_humano');
    assert.equal(r.transferido, true);

    assert.equal((await ctx.db.select().from(ctx.s.conversations)).length, conversasAntes, 'nenhuma conversa pode ter sido criada');
    assert.equal((await ctx.db.select().from(ctx.s.messages)).length, mensagensAntes, 'nenhuma mensagem pode ter sido gravada');
  });

  it('o cliente de teste e marcado e nunca entra em campanha', async () => {
    await simularViaApi({ mensagem: '1', modo: 'menu' });
    await simularViaApi({ mensagem: '1', modo: 'menu' });

    const todos = await ctx.db.select().from(ctx.s.leads);
    const simuladores = todos.filter((l) => l.origem === 'simulador');

    assert.equal(simuladores.length, 1, 'simular varias vezes nao pode criar varios clientes de teste');
    assert.equal(simuladores[0].aceitaCampanha, false);
    assert.deepEqual(simuladores[0].tags, ['simulador']);
  });

  it('valida a entrada', async () => {
    assert.equal((await simularViaApi({ mensagem: '   ' })).statusCode, 400);
    assert.equal((await simularViaApi({ mensagem: 'oi', modo: 'telepatia' })).statusCode, 400);
    assert.equal((await simularViaApi({ mensagem: 'oi', historico: [{ papel: 'admin', conteudo: 'x' }] })).statusCode, 400);
  });

  it('atendente NAO usa o simulador (ele revela prompts e ferramentas)', async () => {
    const res = await simularViaApi({ mensagem: 'oi' }, cabRecepcao);
    assert.equal(res.statusCode, 403);
  });

  it('o padrao e somente leitura: a Atena nao grava a menos que se peca', async () => {
    // Um provedor de mentira que tenta criar um agendamento.
    const [carlos] = (await ctx.db.select().from(ctx.s.professionals)).filter((p) => p.nome.startsWith('Carlos'));
    const [servico] = (await ctx.db.select().from(ctx.s.services)).filter((x) => x.nome === 'Corte Social');

    let i = 0;
    const roteiro = [
      { ferramentas: [{ nome: 'consultar_atena', argumentos: { pedido: 'marcar corte amanha 10h' } }] },
      { ferramentas: [{ nome: 'criar_agendamento', argumentos: { servicoId: servico.id, profissionalId: carlos.id, data: 'amanha', hora: '10:00' } }] },
      { texto: 'nao consegui' },
      { texto: 'Nao consegui marcar.' }
    ];
    const provedores = [{
      impl: { nome: 'falso', async gerar({ modelo }) {
        const p = roteiro[Math.min(i++, roteiro.length - 1)];
        return { texto: p.texto ?? '', chamadasDeFerramenta: p.ferramentas ?? [], tokens: { entrada: 1, saida: 1 }, modelo };
      } },
      apiKey: 'x', modelos: ['m']
    }];

    const antes = (await ctx.db.select().from(ctx.s.appointments)).length;
    const r = await simular({ tenantId, mensagem: 'quero marcar amanha 10h', modo: 'ia', provedores });

    assert.equal(r.bastidores.permitiuEscrita, false);
    assert.equal((await ctx.db.select().from(ctx.s.appointments)).length, antes, 'nada pode ter sido criado');
    assert.match(JSON.stringify(r.bastidores.atena[0].ferramentas[0].resultado), /nao existe/);
  });
});

// ============================================================================

describe('fila de modelos da cascata', () => {
  const impl = { modelosPadrao: ['padrao-1'] };

  it('o modelo PRIMARIO vem primeiro, mesmo que o ultimo teste tenha falhado', () => {
    const fila = montarFilaDeModelos(
      {
        modeloPadrao: 'escolhido',
        modelos: [
          { nome: 'escolhido', ativo: true, ok: false },
          { nome: 'rapido', ativo: true, ok: true, latenciaMs: 100 }
        ]
      },
      impl
    );
    assert.equal(fila[0], 'escolhido', 'a decisao de trocar e da pessoa, nao nossa');
  });

  it('modelos que FALHARAM no teste ficam de fora', () => {
    const fila = montarFilaDeModelos(
      { modeloPadrao: null, modelos: [{ nome: 'quebrado', ativo: true, ok: false }, { nome: 'bom', ativo: true, ok: true, latenciaMs: 50 }] },
      impl
    );
    assert.ok(!fila.includes('quebrado'));
    assert.ok(fila.includes('bom'));
  });

  it('modelos DESATIVADOS ficam de fora, inclusive os sugeridos', () => {
    const fila = montarFilaDeModelos(
      { modeloPadrao: 'desligado', modelos: [{ nome: 'desligado', ativo: false }, { nome: 'padrao-1', ativo: false }] },
      impl
    );
    assert.ok(!fila.includes('desligado'));
    assert.ok(!fila.includes('padrao-1'));
  });

  it('os aprovados vem do mais rapido para o mais lento, antes dos nao testados', () => {
    const fila = montarFilaDeModelos(
      {
        modeloPadrao: null,
        modelos: [
          { nome: 'nao-testado', ativo: true },
          { nome: 'lento', ativo: true, ok: true, latenciaMs: 900 },
          { nome: 'rapido', ativo: true, ok: true, latenciaMs: 80 }
        ]
      },
      impl
    );
    assert.deepEqual(fila.slice(0, 3), ['rapido', 'lento', 'nao-testado']);
  });

  /**
   * O catalogo do Gemini chega a 41 modelos. Sem teto, um provedor com cota
   * esgotada faria a cascata gastar a espera de cada um antes de tentar o Groq.
   */
  it(`limita a ${MAX_MODELOS_POR_PROVEDOR} modelos por provedor`, () => {
    const modelos = Array.from({ length: 41 }, (_, i) => ({ nome: `m${i}`, ativo: true }));
    const fila = montarFilaDeModelos({ modeloPadrao: null, modelos }, impl);
    assert.equal(fila.length, MAX_MODELOS_POR_PROVEDOR);
  });

  /**
   * O Gemini e a excecao ao teto: a curadoria automatica (`selecionarMelhores`,
   * em catalogo-modelos.js) ja liga no maximo os 8 melhores para WhatsApp, entao
   * o risco que o teto existia para evitar (esperar 41 modelos falharem) ja foi
   * resolvido antes de chegar na cascata. Todos os ativos entram na tentativa
   * antes de pular para o proximo provedor.
   */
  it('o Gemini NAO tem teto: tenta todos os modelos ativos antes de pular para o proximo provedor', () => {
    const modelos = Array.from({ length: 12 }, (_, i) => ({ nome: `gemini-${i}`, ativo: true }));
    const fila = montarFilaDeModelos({ modeloPadrao: null, modelos }, { nome: 'gemini', modelosPadrao: [] });
    assert.equal(fila.length, 12, 'nenhum modelo ativo do Gemini pode ser cortado pelo teto');
  });

  it('sem nenhuma configuracao, usa os modelos sugeridos do provedor', () => {
    assert.deepEqual(montarFilaDeModelos({ modeloPadrao: null, modelos: [] }, impl), ['padrao-1']);
  });
});

// ============================================================================

describe('teste em lote dos modelos', () => {
  async function prepararGemini(modelos) {
    await ctx.db.delete(ctx.s.aiProviders).where(eq(ctx.s.aiProviders.tenantId, tenantId));
    await ctx.db.insert(ctx.s.aiProviders).values({
      id: 'aip_teste_lote',
      tenantId,
      provedor: 'gemini',
      apiKeyCifrada: cifrar('chave-de-teste-1234567890'),
      habilitado: true,
      modelos
    });
  }

  const lerModelos = async () =>
    (await ctx.db.select().from(ctx.s.aiProviders).where(eq(ctx.s.aiProviders.id, 'aip_teste_lote')))[0].modelos;

  // Nenhum destes testes pode falar com o Google de verdade: o `listar` e
  // injetado, devolvendo o mesmo catalogo que ja esta salvo.
  const listarIgual = (modelos) => async () => modelos.map((m) => ({ nome: m.nome, nomeExibicao: m.nome }));

  it('testa TODOS os modelos, inclusive os desligados, e grava o resultado de cada um', async () => {
    const catalogo = [
      { nome: 'models/bom', ativo: true },
      { nome: 'models/quebrado', ativo: true },
      { nome: 'models/desligado', ativo: false }
    ];
    await prepararGemini(catalogo);

    const impl = {
      precisaChave: true,
      async gerar({ modelo }) {
        if (modelo === 'models/quebrado') throw new ErroDeProvedor('HTTP 429: cota', { reTentavel: true });
        return { texto: 'funcionando', chamadasDeFerramenta: [], tokens: { entrada: 1, saida: 1 }, modelo };
      }
    };

    const { total, concluido } = await iniciarTesteDeModelos(tenantId, 'gemini', {
      impl, timeoutMs: 1000, listar: listarIgual(catalogo)
    });
    // E o teste que descobre se vale ligar um modelo desligado.
    assert.equal(total, 3);
    await concluido;

    const m = Object.fromEntries((await lerModelos()).map((x) => [x.nome, x]));

    assert.equal(m['models/bom'].ok, true);
    assert.ok(m['models/bom'].latenciaMs >= 0);
    assert.equal(m['models/quebrado'].ok, false);
    assert.match(m['models/quebrado'].erro, /429/);
    assert.equal(m['models/desligado'].ok, true, 'o desligado tambem foi testado');
  });

  it('o resultado alimenta a cascata: o que falhou sai da fila', async () => {
    const [linha] = await ctx.db.select().from(ctx.s.aiProviders).where(eq(ctx.s.aiProviders.id, 'aip_teste_lote'));
    const fila = montarFilaDeModelos(linha, { modelosPadrao: [] });

    assert.ok(fila.includes('models/bom'));
    assert.ok(!fila.includes('models/quebrado'), 'quem falhou no teste nao entra na cascata');
  });

  it('nao roda dois testes ao mesmo tempo no mesmo provedor', async () => {
    await prepararGemini([{ nome: 'models/lento', ativo: true }]);

    let liberar;
    const portao = new Promise((r) => (liberar = r));
    const impl = { precisaChave: true, async gerar({ modelo }) { await portao; return { texto: 'ok', chamadasDeFerramenta: [], tokens: { entrada: 1, saida: 1 }, modelo }; } };

    const listar = listarIgual([{ nome: 'models/lento' }]);
    const primeiro = await iniciarTesteDeModelos(tenantId, 'gemini', { impl, listar });

    assert.equal(progressoDoTeste(tenantId, 'gemini').rodando, true);
    await assert.rejects(() => iniciarTesteDeModelos(tenantId, 'gemini', { impl, listar }), /andamento/);

    liberar();
    await primeiro.concluido;
    assert.equal(progressoDoTeste(tenantId, 'gemini').rodando, false);
    assert.equal(progressoDoTeste(tenantId, 'gemini').feitos, 1);
  });

  it('exige a chave antes de testar', async () => {
    await ctx.db.delete(ctx.s.aiProviders).where(eq(ctx.s.aiProviders.tenantId, tenantId));
    await ctx.db.insert(ctx.s.aiProviders).values({ id: 'aip_sem_chave', tenantId, provedor: 'groq', modelos: [{ nome: 'x', ativo: true }] });

    await assert.rejects(
      () => iniciarTesteDeModelos(tenantId, 'groq', { impl: { precisaChave: true, gerar: async () => ({}) } }),
      /chave de API/
    );
  });

  it('a rota inicia o teste e responde na hora', async () => {
    // A rota usa o provedor real, que falaria com o Google. Trocamos o `fetch`
    // por um que recusa tudo: o teste continua hermetico (nada sai da maquina)
    // e a chave de mentira nunca chega a um servidor de verdade.
    const original = globalThis.fetch;
    const chamadas = [];
    globalThis.fetch = async (url) => {
      chamadas.push(String(url));
      return { ok: false, status: 400, text: async () => 'chave invalida', json: async () => ({}) };
    };

    try {
      await prepararGemini([{ nome: 'models/a', ativo: true }]);
      const res = await app.inject({ method: 'POST', url: '/api/ia/provedores/gemini/testar-modelos', headers: cab });

      // O teste roda em segundo plano: o que se garante e que a rota NAO
      // ficou esperando por ele.
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().iniciado, true);
      // A consulta ao Google falhou, entao o catalogo salvo foi mantido.
      assert.equal(res.json().total, 1);

      // Espera o teste de fundo terminar antes de devolver o fetch real.
      for (let i = 0; i < 50 && progressoDoTeste(tenantId, 'gemini')?.rodando; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(chamadas.every((u) => u.startsWith('https://generativelanguage.googleapis.com')), 'so pode ter tentado o Google');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('atendente NAO dispara teste de modelos', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ia/provedores/gemini/testar-modelos', headers: cabRecepcao });
    assert.equal(res.statusCode, 403);
  });
});

// ============================================================================

describe('Ollama', () => {
  /**
   * A tela pede `http://localhost:11434`, mas a rota de chat fica em /v1.
   * Sem completar, a chamada iria para um endereco que nao existe.
   */
  it('completa o /v1 quando a pessoa informa so o endereco da maquina', async () => {
    const original = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'oi' } }], usage: {} }), text: async () => '' };
    };

    try {
      const base = { modelo: 'llama3.2', mensagens: [{ papel: 'user', conteudo: 'oi' }] };
      await ollama.gerar({ ...base, baseUrl: 'http://localhost:11434' });
      await ollama.gerar({ ...base, baseUrl: 'http://localhost:11434/' });
      await ollama.gerar({ ...base, baseUrl: 'http://localhost:11434/v1' });
      await ollama.gerar({ ...base }); // sem nada: usa o padrao
    } finally {
      globalThis.fetch = original;
    }

    assert.deepEqual([...new Set(urls)], ['http://localhost:11434/v1/chat/completions']);
  });
});

// ============================================================================

describe('janela de contexto', () => {
  /**
   * A tela gravava o valor, mas o codigo usava 8 fixo: mexer na opcao nao
   * mudava nada e a empresa achava que estava economizando tokens.
   */
  it('o historico respeita o tamanho configurado', async () => {
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const [lead] = await ctx.db.select().from(ctx.s.leads);
    const id = await conversas.encontrarOuAbrir(tenantId, { leadId: lead.id });

    for (let i = 1; i <= 12; i++) {
      await conversas.registrarRecebida(tenantId, id, { conteudo: `mensagem ${i}` });
    }

    await salvarConfiguracao(tenantId, { janelaContextoMensagens: 4 });
    const pequena = await historicoParaIa(tenantId, id);
    // 4 anteriores + a mensagem que acabou de chegar (o gateway retira essa).
    assert.equal(pequena.length, 5);

    await salvarConfiguracao(tenantId, { janelaContextoMensagens: 10 });
    const grande = await historicoParaIa(tenantId, id);
    assert.equal(grande.length, 11);

    // E sao sempre as MAIS RECENTES.
    assert.equal(grande.at(-1).conteudo, 'mensagem 12');
  });
});

// ============================================================================

describe('metricas e banco', () => {
  it('conta os registros das tabelas principais e o tamanho do arquivo', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ia/banco', headers: cab });

    assert.equal(res.statusCode, 200);
    const b = res.json();

    const contatos = b.tabelas.find((t) => t.rotulo === 'Contatos');
    assert.ok(contatos.registros >= 3);
    assert.ok(b.tabelas.some((t) => t.rotulo === 'Agendamentos'));
    assert.ok(b.arquivo.tamanhoBytes > 0);
    assert.equal(b.motor, 'SQLite');
  });

  it('o uso separa o custo da Sofia do da Atena', async () => {
    const { gerar } = await import('../src/ai/cascade.js');
    const falso = [{ impl: { nome: 'falso', async gerar({ modelo }) { return { texto: 'ok', chamadasDeFerramenta: [], tokens: { entrada: 100, saida: 10 }, modelo }; } }, apiKey: 'x', modelos: ['m'] }];

    const ler = async () => {
      const u = (await app.inject({ method: 'GET', url: '/api/ia/uso?dias=1', headers: cab })).json();
      const por = (chave) => u.porAgente.find((a) => a.agente === chave) ?? { chamadas: 0, tokens: 0 };
      return { atena: por('atena'), sofia: por('atendente') };
    };

    // Compara ANTES e DEPOIS: os testes anteriores deste arquivo ja fizeram
    // chamadas reais da Atena, e assumir um banco vazio seria fragil.
    const antes = await ler();

    for (const [origem, agentKey] of [['atendimento', 'atendente'], ['atena', 'atena'], ['atena', 'atena']]) {
      await gerar({ tenantId, origem, agentKey, mensagens: [{ papel: 'user', conteudo: 'x' }], provedores: falso });
    }

    const depois = await ler();

    assert.equal(depois.atena.chamadas - antes.atena.chamadas, 2);
    assert.equal(depois.sofia.chamadas - antes.sofia.chamadas, 1);
    assert.equal(depois.atena.tokens - antes.atena.tokens, 220);
  });

  it('atendente NAO ve o banco', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/ia/banco', headers: cabRecepcao });
    assert.equal(res.statusCode, 403);
  });
});

// ============================================================================

/**
 * Transcricao de audio.
 *
 * Nenhum destes testes fala com o Groq nem com o Google: o `fetch` e trocado
 * por um dublê. O que se prova e a CASCATA de transcricao — quem e tentado
 * primeiro, o que acontece quando o primeiro falha e, principalmente, que uma
 * falha nunca lanca (o audio do cliente nao pode se perder por causa disso).
 */
describe('transcricao de audio', () => {
  const BYTES = Buffer.from('bytes-de-um-audio');
  const fetchOriginal = globalThis.fetch;

  /** Liga um provedor com chave, para `transcreverAudio` enxerga-lo. */
  async function ligarProvedor(provedor, prioridade) {
    await ctx.db.insert(ctx.s.aiProviders).values({
      id: `aip_tr_${provedor}`,
      tenantId,
      provedor,
      apiKeyCifrada: cifrar('chave-de-teste-1234567890'),
      habilitado: true,
      prioridade,
      modelos: []
    });
  }

  async function limparProvedores() {
    await ctx.db.delete(ctx.s.aiProviders).where(eq(ctx.s.aiProviders.tenantId, tenantId));
  }

  after(() => {
    globalThis.fetch = fetchOriginal;
  });

  it('sem nenhum provedor ligado, devolve null em vez de lancar', async () => {
    await limparProvedores();
    globalThis.fetch = async () => assert.fail('nao pode tentar rede sem provedor');

    assert.equal(await transcreverAudio({ tenantId, bytes: BYTES }), null);
  });

  it('usa o Groq (Whisper) primeiro: e o modelo feito para isto', async () => {
    await limparProvedores();
    await ligarProvedor('groq', 2);
    await ligarProvedor('gemini', 1);

    const chamadas = [];
    globalThis.fetch = async (url) => {
      chamadas.push(String(url));
      return new Response('Oi, queria marcar um horário', { status: 200 });
    };

    const r = await transcreverAudio({ tenantId, bytes: BYTES });

    assert.equal(r.texto, 'Oi, queria marcar um horário');
    assert.equal(r.provedor, 'groq');
    assert.equal(chamadas.length, 1, 'acertando de primeira, nao pode chamar o reserva');
    assert.match(chamadas[0], /audio\/transcriptions/);
  });

  it('Groq fora do ar: cai para o Gemini', async () => {
    await limparProvedores();
    await ligarProvedor('groq', 2);
    await ligarProvedor('gemini', 1);

    const chamadas = [];
    globalThis.fetch = async (url) => {
      chamadas.push(String(url));
      if (String(url).includes('groq')) return new Response('cota', { status: 429 });
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'tem horário amanhã?' }] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const r = await transcreverAudio({ tenantId, bytes: BYTES });

    assert.equal(r.texto, 'tem horário amanhã?');
    assert.equal(r.provedor, 'gemini');
    assert.equal(chamadas.length, 2);
  });

  it('os dois falhando, devolve null — quem chamou manda a conversa para uma pessoa', async () => {
    await limparProvedores();
    await ligarProvedor('groq', 2);
    await ligarProvedor('gemini', 1);
    globalThis.fetch = async () => new Response('fora do ar', { status: 500 });

    assert.equal(await transcreverAudio({ tenantId, bytes: BYTES }), null);
  });

  /**
   * Audio mudo (toque sem querer, bolso) nao e falha de provedor: tentar o
   * reserva so gastaria dinheiro para ouvir o mesmo silencio.
   */
  it('audio sem fala vira null, sem tentar o reserva', async () => {
    await limparProvedores();
    await ligarProvedor('groq', 2);
    await ligarProvedor('gemini', 1);

    let chamadas = 0;
    globalThis.fetch = async () => {
      chamadas += 1;
      return new Response('(sem fala)', { status: 200 });
    };

    assert.equal(await transcreverAudio({ tenantId, bytes: BYTES }), null);
    assert.equal(chamadas, 1);
  });

  it('audio grande demais nem chega a ser enviado', async () => {
    await limparProvedores();
    await ligarProvedor('groq', 2);
    globalThis.fetch = async () => assert.fail('nao pode mandar um arquivo enorme para a API');

    assert.equal(await transcreverAudio({ tenantId, bytes: Buffer.alloc(9 * 1024 * 1024) }), null);
  });
});

describe('arquivo de audio recebido', () => {
  it('a extensao sai do mimetype do canal, mesmo com o "codecs" junto', async () => {
    const ogg = await salvarAudio(Buffer.from('a'), 'audio/ogg; codecs=opus', { tenantId });
    assert.match(ogg.url, /^\/api\/arquivos\/audio-.+\.ogg$/);

    assert.match((await salvarAudio(Buffer.from('a'), 'audio/mpeg', { tenantId })).url, /\.mp3$/);
    assert.match((await salvarAudio(Buffer.from('a'), 'audio/mp4', { tenantId })).url, /\.m4a$/);
  });

  /** Melhor um arquivo com extensao generica do que perder o recado do cliente. */
  it('mimetype desconhecido vira .ogg, que e o que o WhatsApp manda', async () => {
    assert.match((await salvarAudio(Buffer.from('a'), 'audio/esquisito', { tenantId })).url, /\.ogg$/);
  });

  it('audio vazio e recusado', async () => {
    await assert.rejects(() => salvarAudio(Buffer.alloc(0), 'audio/ogg', { tenantId }), /vazio/i);
  });
});

// ============================================================================

/**
 * Remux webm -> ogg (a conversao que o audio ENVIADO pelo atendente passa).
 *
 * Roda o ffmpeg de verdade (binario local, empacotado por `ffmpeg-static`,
 * sem rede): o que se prova aqui e exatamente o que o navegador do atendente
 * vai disparar quando alguem gravar um audio de verdade.
 */
describe('conversao de audio (webm do navegador -> ogg do WhatsApp)', () => {
  it('converte webm/opus para ogg/opus de voz — mesmo audio, arquivo menor', async () => {
    const webm = webmDeMentira({ segundos: 1 });
    assert.equal(webm.subarray(0, 4).toString('hex'), '1a45dfa3', 'a fixture precisa ser webm de verdade (assinatura EBML)');

    const ogg = await paraOggOpus(webm);

    assert.equal(ogg.subarray(0, 4).toString('ascii'), 'OggS', 'container ogg de verdade — o que o WhatsApp espera');
    // A conversao agora RECODIFICA para 32 kbit/s (arquivo menor de proposito),
    // entao o tamanho nao prova mais nada. O que prova que nao se perdeu audio
    // (nem foi truncado) e a DURACAO: a mesma do original.
    const duracao = (bytes) => {
      const r = spawnSync(ffmpegBin, ['-hide_banner', '-i', 'pipe:0', '-f', 'null', '-'], { input: bytes });
      const m = /time=(\d+):(\d+):([\d.]+)/g;
      let ultimo = null;
      for (const x of String(r.stderr).matchAll(m)) ultimo = Number(x[1]) * 3600 + Number(x[2]) * 60 + Number(x[3]);
      return ultimo;
    };
    assert.ok(Math.abs(duracao(ogg) - duracao(webm)) < 0.1, `duracao ${duracao(ogg)} s x ${duracao(webm)} s`);
  });

  it('audio que nao e audio nenhum: rejeita, nao trava', async () => {
    await assert.rejects(() => paraOggOpus(Buffer.from('isto nao e audio nenhum')), /Nao foi possivel converter/);
  });

  it('buffer vazio: rejeita', async () => {
    await assert.rejects(() => paraOggOpus(Buffer.alloc(0)));
  });
});
