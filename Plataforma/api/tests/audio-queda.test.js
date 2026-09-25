import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { mp4DoSafari, webmDeMentira } from './helpers/audio-fixture.js';

/**
 * A queda do servidor ao enviar um audio pela plataforma.
 *
 * O que ficou provado na investigacao (e o que estes testes guardam):
 *   1. a queda nao deixava rastro: o erro so ia para o terminal — agora vai
 *      para data/logs/falhas.log, com a pilha;
 *   2. a resposta que estava saindo ficava sem "entregue" e sem "falhou",
 *      parecendo enviada para sempre — agora o boot a marca como nao entregue;
 *   3. (achado junto) o audio gravado no iPhone/Safari (mp4 com AAC) era
 *      sempre recusado — agora e recodificado para Opus.
 * A religacao automatica fica no painel (painel.mjs), fora da API.
 * Telefones proprios (5592900088xxx).
 */

let app;
let cab;
let tenantId;
let telefone = 5592900088000;

async function novaConversa(nome) {
  const leads = await import('../src/modules/leads/leads.service.js');
  const conversas = await import('../src/modules/conversas/conversas.service.js');
  telefone += 1;
  const lead = await leads.encontrarOuCriarPorTelefone(tenantId, String(telefone), nome);
  return conversas.encontrarOuAbrir(tenantId, { leadId: lead.id });
}

before(async () => {
  ({ app } = await criarAppDeTeste());
  const dono = await entrar(app);
  cab = dono.cabecalho;
  tenantId = dono.usuario.tenantId;
});

after(async () => {
  await app?.close();
});

describe('conversao do audio gravado no navegador', () => {
  it('Chrome/Edge (webm/opus): vira ogg/opus', async () => {
    const { paraOggOpus } = await import('../src/core/audio.js');
    const ogg = await paraOggOpus(webmDeMentira());
    assert.equal(ogg.subarray(0, 4).toString(), 'OggS');
    assert.ok(ogg.includes('OpusHead'));
  });

  it('Safari/iPhone (mp4 com AAC): antes recusado, agora recodificado para ogg/opus', async () => {
    const { paraOggOpus } = await import('../src/core/audio.js');
    const ogg = await paraOggOpus(mp4DoSafari());
    assert.equal(ogg.subarray(0, 4).toString(), 'OggS');
    assert.ok(ogg.includes('OpusHead'), 'o WhatsApp so desenha a bolha de voz para Opus');
  });

  it('pela rota da tela: o audio do iPhone e aceito', async () => {
    const id = await novaConversa('Cliente Audio iPhone');
    const r = await app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/mensagens`,
      headers: cab,
      payload: { audio: `data:audio/mp4;base64,${mp4DoSafari().toString('base64')}`, duracaoSegundos: 1 }
    });
    assert.equal(r.statusCode, 201, r.body);
  });

  it('varios audios ao mesmo tempo: nenhum sai cortado nem falha', async () => {
    // Com o fluent-ffmpeg, 60 simultaneos davam 15 cortados (como sucesso) e
    // 27 "Output stream closed": o "fim" vinha antes de a saida chegar inteira.
    const { paraOggOpus } = await import('../src/core/audio.js');
    const webm = webmDeMentira({ segundos: 5 });
    const referencia = (await paraOggOpus(webm)).length;
    const r = await Promise.allSettled(Array.from({ length: 30 }, () => paraOggOpus(webm)));
    assert.equal(r.filter((x) => x.status === 'rejected').length, 0, 'nenhuma falha');
    assert.deepEqual([...new Set(r.map((x) => x.value.length))], [referencia], 'todos inteiros, do mesmo tamanho');
  });

  it('bytes que nao sao audio continuam recusados com mensagem clara (sem derrubar nada)', async () => {
    const { paraOggOpus } = await import('../src/core/audio.js');
    await assert.rejects(() => paraOggOpus(Buffer.from('isto nao e audio '.repeat(40))), /Nao foi possivel converter o audio/);
  });
});

describe('o audio nao espera a transcricao', () => {
  /**
   * Medido no uso real: a transcricao (Gemini) levava 2,2 a 4,5 s e o audio so
   * saia para o cliente depois dela. Aqui o provedor falso demora 1,5 s: o
   * envio tem de responder antes disso, e o texto chegar depois.
   */
  it('o envio responde sem esperar; o texto falado aparece depois no balao', async () => {
    const { db } = await import('../src/db/client.js');
    const { aiProviders, messages } = await import('../src/db/schema/index.js');
    const { cifrar } = await import('../src/core/crypto.js');
    const { eq } = await import('drizzle-orm');

    await db.insert(aiProviders).values({
      id: 'aip_audio_lento',
      tenantId,
      provedor: 'groq',
      apiKeyCifrada: cifrar('chave-de-teste-audio-1234567890'),
      habilitado: true,
      modelos: [{ nome: 'whisper', ativo: true }]
    });
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = async (url, opcoes) => {
      if (!String(url).includes('/audio/transcriptions')) return fetchOriginal(url, opcoes);
      await new Promise((r) => setTimeout(r, 1500));
      return new Response('Oi, seu horário de sexta está confirmado', { status: 200 });
    };

    try {
      const id = await novaConversa('Cliente Audio Rapido');
      const inicio = Date.now();
      const r = await app.inject({
        method: 'POST',
        url: `/api/conversas/${id}/mensagens`,
        headers: cab,
        payload: { audio: `data:audio/webm;codecs=opus;base64,${webmDeMentira().toString('base64')}`, duracaoSegundos: 1 }
      });
      const tempo = Date.now() - inicio;
      assert.equal(r.statusCode, 201, r.body);
      assert.ok(tempo < 1500, `respondeu em ${tempo} ms, sem esperar os 1500 ms da transcricao`);

      const ler = async () => (await db.select().from(messages).where(eq(messages.id, r.json().id)))[0];
      assert.equal((await ler()).conteudo, '🎤 Áudio', 'na hora: o rotulo');

      let m;
      for (let i = 0; i < 40 && !(m = await ler()).transcricao; i++) await new Promise((res) => setTimeout(res, 100));
      assert.equal(m.transcricao, 'Oi, seu horário de sexta está confirmado');
      assert.equal(m.conteudo, 'Oi, seu horário de sexta está confirmado', 'a previa e a busca passam a ter o texto');
    } finally {
      globalThis.fetch = fetchOriginal;
      await db.delete(aiProviders).where(eq(aiProviders.id, 'aip_audio_lento'));
    }
  });
});

describe('"Transcrevendo..." dos dois lados da conversa', () => {
  const lerMensagem = async (id) => {
    const { db } = await import('../src/db/client.js');
    const { messages } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    return (await db.select().from(messages).where(eq(messages.id, id)))[0];
  };

  it('audio do CLIENTE: aparece gravado como pendente ANTES de transcrever; depois vira texto', async () => {
    const { receberMensagem } = await import('../src/channels/gateway.js');
    const { db } = await import('../src/db/client.js');
    const { messages } = await import('../src/db/schema/index.js');
    const { and, eq } = await import('drizzle-orm');
    telefone += 1;
    const numero = String(telefone);

    let noMomentoDaTranscricao;
    const r = await receberMensagem({
      tenantId,
      remetente: numero,
      texto: '🎤 Áudio',
      idExterno: `aud-pend-${numero}`,
      midia: {
        tipo: 'audio',
        url: '/api/arquivos/audio-teste-pendente.ogg',
        transcricao: null,
        async transcrever() {
          // O balao ja existe quando a IA comeca a ouvir.
          [noMomentoDaTranscricao] = await db
            .select()
            .from(messages)
            .where(and(eq(messages.tenantId, tenantId), eq(messages.externalId, `aud-pend-${numero}`)));
          return { texto: 'Queria marcar um corte amanhã' };
        }
      }
    });

    assert.ok(noMomentoDaTranscricao, 'a mensagem ja estava gravada');
    assert.equal(noMomentoDaTranscricao.metadados.statusTranscricao, 'pendente');
    assert.equal(noMomentoDaTranscricao.transcricao, null);

    const depois = await lerMensagem(noMomentoDaTranscricao.id);
    assert.equal(depois.transcricao, 'Queria marcar um corte amanhã');
    assert.equal(depois.conteudo, 'Queria marcar um corte amanhã');
    assert.equal(depois.metadados.statusTranscricao, undefined, 'estado some quando o texto chega');
    assert.ok(r.conversationId);
  });

  it('audio do cliente sem fala: o balao diz "sem fala" e uma pessoa assume (regra de sempre)', async () => {
    const { receberMensagem } = await import('../src/channels/gateway.js');
    telefone += 1;
    const numero = String(telefone);
    const r = await receberMensagem({
      tenantId,
      remetente: numero,
      texto: '🎤 Áudio',
      idExterno: `aud-mudo-${numero}`,
      midia: {
        tipo: 'audio',
        url: '/api/arquivos/audio-teste-mudo.ogg',
        transcricao: null,
        async transcrever(detalhe) {
          detalhe.semFala = true;
          return null;
        }
      }
    });
    assert.equal(r.motivo, 'audio_sem_transcricao');
    const { db } = await import('../src/db/client.js');
    const { messages } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const [m] = await db.select().from(messages).where(eq(messages.externalId, `aud-mudo-${numero}`));
    assert.equal(m.metadados.statusTranscricao, 'sem_fala');
  });

  it('audio do ATENDENTE: nasce pendente; sem provedor, fecha como "falhou" (nao fica transcrevendo)', async () => {
    const id = await novaConversa('Cliente Audio Estado');
    const r = await app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/mensagens`,
      headers: cab,
      payload: { audio: `data:audio/webm;codecs=opus;base64,${webmDeMentira().toString('base64')}` }
    });
    assert.equal(r.statusCode, 201, r.body);
    const { transcreverRespostaDeAudio } = await import('../src/modules/conversas/conversas.service.js');
    await transcreverRespostaDeAudio(tenantId, id, r.json().id);
    const m = await lerMensagem(r.json().id);
    assert.equal(m.metadados.statusTranscricao, 'falhou');
  });
});

describe('registro da queda em arquivo', () => {
  let pasta;
  before(() => {
    pasta = mkdtempSync(join(tmpdir(), 'falhas-'));
  });
  after(() => rmSync(pasta, { recursive: true, force: true }));

  it('grava tipo, horario, pilha e a causa encadeada', async () => {
    const { gravarFalhaFatal } = await import('../src/core/falhas.js');
    const erro = new Error('Falhou ao enviar o audio', { cause: new Error('socket fechado no meio do upload') });
    const arquivo = gravarFalhaFatal('unhandledRejection', erro, { pasta });
    const texto = readFileSync(arquivo, 'utf8');
    assert.match(texto, /^===== \d{4}-\d{2}-\d{2}T.* · unhandledRejection · pid \d+/);
    assert.match(texto, /Error: Falhou ao enviar o audio\n\s+at /, 'com a pilha');
    assert.match(texto, /Causado por: Error: socket fechado no meio do upload/);
  });

  it('o boot acha a queda recente (e ignora uma antiga)', async () => {
    const { gravarFalhaFatal, quedaRecente } = await import('../src/core/falhas.js');
    gravarFalhaFatal('uncaughtException', new TypeError('x is not a function'), { pasta });
    const q = quedaRecente({ pasta });
    assert.equal(q.tipo, 'uncaughtException');
    assert.match(q.resumo, /TypeError: x is not a function/);
    assert.equal(quedaRecente({ pasta, agora: Date.now() + 60 * 60_000 }), null, 'uma hora depois ja nao e "recente"');
  });

  it('nunca lanca, mesmo sem conseguir escrever', async () => {
    const { gravarFalhaFatal } = await import('../src/core/falhas.js');
    const arquivoNoLugarDaPasta = join(pasta, 'nao-e-pasta');
    writeFileSync(arquivoNoLugarDaPasta, 'x');
    assert.equal(gravarFalhaFatal('uncaughtException', new Error('y'), { pasta: arquivoNoLugarDaPasta }), null);
  });
});

describe('resposta que estava saindo quando o servidor caiu', () => {
  it('fica como NAO entregue (com Reenviar), e so ela', async () => {
    const repo = await import('../src/modules/conversas/conversas.repo.js');
    const { marcarEntregasInterrompidas } = await import('../src/modules/conversas/entrega.service.js');
    const { db } = await import('../src/db/client.js');
    const { messages } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const { usuario } = await entrar(app);

    const id = await novaConversa('Cliente Queda Envio');
    const humana = (extra = {}) =>
      repo.registrarMensagem(tenantId, id, { direcao: 'saida', autorTipo: 'humano', autorUserId: usuario.id, tipo: 'texto', conteudo: 'oi', ...extra });

    const noLimbo = await humana();
    const entregue = await humana({ entregueEm: new Date() });
    const falhou = await humana({ erroEnvio: 'WhatsApp desconectado' });
    const antiga = await humana();
    await db.update(messages).set({ createdAt: new Date(Date.now() - 3 * 24 * 3_600_000) }).where(eq(messages.id, antiga));
    const daIa = await repo.registrarMensagem(tenantId, id, { direcao: 'saida', autorTipo: 'ia', tipo: 'texto', conteudo: 'ola' });

    assert.ok((await marcarEntregasInterrompidas()) >= 1);

    const ler = async (mid) => (await db.select().from(messages).where(eq(messages.id, mid)))[0];
    assert.match((await ler(noLimbo)).erroEnvio, /reiniciou durante o envio/);
    assert.equal((await ler(entregue)).erroEnvio, null);
    assert.equal((await ler(falhou)).erroEnvio, 'WhatsApp desconectado', 'o motivo real nao e trocado');
    assert.equal((await ler(antiga)).erroEnvio, null, 'mais de 24 h: fica como estava');
    assert.equal((await ler(daIa)).erroEnvio, null, 'so respostas de atendente');

    // O Reenviar aceita a marcada (e o caminho da tela). Como no caso real, a
    // conversa esta com o atendente que respondeu. Sem WhatsApp no teste, a
    // nova tentativa volta como nao entregue — mas e ACEITA (antes: "nao falhou").
    await repo.atualizar(tenantId, id, { status: 'humana', assignedUserId: usuario.id });
    const reenvio = await app.inject({ method: 'POST', url: `/api/conversas/${id}/mensagens/${noLimbo}/reenviar`, headers: cab });
    assert.equal(reenvio.statusCode, 200, reenvio.body);
  });
});
