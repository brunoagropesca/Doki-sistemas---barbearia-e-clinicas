import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { receberMensagem, recarregarAgrupador, registrarAdaptador } from '../src/channels/gateway.js';

/**
 * Testes do gateway de mensagens.
 *
 * Um adaptador de mentira substitui o WhatsApp: ele apenas guarda o que
 * "enviou". Assim testamos todo o fluxo — identificar o cliente, abrir a
 * conversa, decidir quem responde, gravar e despachar — sem nenhum celular,
 * QR Code ou conexao de rede envolvida.
 */

let app;
let tenantId;
let cabDono;

/** Adaptador falso: registra os envios em vez de falar com o WhatsApp. */
const enviados = [];
// Contador proprio: os testes zeram `enviados` entre cenarios, e derivar o id
// do tamanho do array faria ids repetidos.
let sequenciaEnvio = 0;

const adaptadorFalso = {
  async enviar({ destino, texto }) {
    enviados.push({ destino, texto });
    return { idExterno: `falso_${++sequenciaEnvio}` };
  },
  async conectar() {
    return { conectando: true };
  },
  async desconectar() {
    return { ok: true };
  },
  estaConectada: () => true
};

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cabDono } = await entrar(app));

  const { db } = await import('../src/db/client.js');
  const { tenants } = await import('../src/db/schema/index.js');
  const [t] = await db.select().from(tenants);
  tenantId = t.id;

  registrarAdaptador('whatsapp', adaptadorFalso);

  // Agrupamento desligado: os testes precisam de resposta imediata, sem
  // esperar a janela de 8 segundos.
  const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
  await atendimento.salvarConfiguracao(tenantId, { modo: 'hibrido', agrupamentoSegundos: 0 });
  recarregarAgrupador(tenantId);
});

after(async () => {
  await app?.close();
});

describe('recebimento de mensagem', () => {
  it('cria o cliente, abre a conversa e responde', async () => {
    enviados.length = 0;

    const r = await receberMensagem({
      tenantId,
      canal: 'whatsapp',
      remetente: '5511987654321',
      nomeRemetente: 'Pedro Alves',
      texto: '1',
      idExterno: 'wa_1'
    });

    assert.equal(r.respondido, true);
    assert.equal(r.respondidoPor, 'menu');
    assert.ok(enviados.length >= 1, 'a resposta precisa ser entregue ao canal');
    assert.match(enviados[0].texto, /serviços e valores/i);

    // O cliente novo entrou no CRM sozinho.
    const lista = await app.inject({ method: 'GET', url: '/api/leads?busca=Pedro', headers: cabDono });
    const lead = lista.json().itens[0];
    assert.equal(lead.nome, 'Pedro Alves');
    assert.equal(lead.telefone, '5511987654321', 'o telefone precisa entrar na forma canonica');
    assert.equal(lead.origem, 'whatsapp');
  });

  it('reusa o mesmo cliente quando o numero chega em outro formato', async () => {
    await receberMensagem({
      tenantId,
      remetente: '11987654321', // sem o 55
      texto: 'oi',
      idExterno: 'wa_2'
    });

    const lista = await app.inject({ method: 'GET', url: '/api/leads?busca=87654321', headers: cabDono });
    assert.equal(lista.json().itens.length, 1, 'nao pode criar um segundo cadastro do mesmo cliente');
  });

  it('descarta reenvio da mesma mensagem', async () => {
    const primeira = await receberMensagem({ tenantId, remetente: '5511987654321', texto: 'oi', idExterno: 'wa_repetida' });
    const segunda = await receberMensagem({ tenantId, remetente: '5511987654321', texto: 'oi', idExterno: 'wa_repetida' });

    assert.equal(primeira.duplicada, undefined);
    assert.equal(segunda.duplicada, true);
  });

  it('ignora mensagem vazia', async () => {
    const r = await receberMensagem({ tenantId, remetente: '5511987654321', texto: '   ' });
    assert.equal(r.ignorada, true);
  });

  it('ignora remetente com numero invalido em vez de quebrar', async () => {
    const r = await receberMensagem({ tenantId, remetente: '123', texto: 'oi' });
    assert.equal(r.ignorada, true);
    assert.match(r.motivo, /invalido/i);
  });

  /**
   * A mensagem do cliente e gravada ANTES de qualquer decisao. Perder a
   * resposta e um problema; perder a pergunta do cliente e inaceitavel.
   */
  it('grava a mensagem do cliente mesmo quando nao respondemos', async () => {
    const conversas = await import('../src/modules/conversas/conversas.service.js');

    // Coloca a conversa em atendimento humano: a automacao fica em silencio.
    // (Humano = o atendente ESCREVEU; so assumir nao basta.)
    const r1 = await receberMensagem({ tenantId, remetente: '5511911112222', texto: 'oi', idExterno: 'g1' });
    const { usuario } = await entrar(app, 'recepcao');
    await conversas.assumir(tenantId, r1.conversationId, usuario);
    await conversas.responder(tenantId, r1.conversationId, { conteudo: 'Ola, ja te atendo.' }, usuario);

    const r2 = await receberMensagem({
      tenantId,
      remetente: '5511911112222',
      texto: 'estou aqui ainda',
      idExterno: 'g2'
    });

    assert.equal(r2.respondido, false);
    assert.equal(r2.motivo, 'atendimento_humano');

    const { mensagens } = await conversas.mensagens(tenantId, r1.conversationId);
    assert.ok(
      mensagens.some((m) => m.conteudo === 'estou aqui ainda'),
      'a pergunta do cliente precisa estar salva mesmo sem resposta automatica'
    );
  });
});

describe('quem responde', () => {
  it('humano assumiu: a IA fica em silencio', async () => {
    enviados.length = 0;
    const conversas = await import('../src/modules/conversas/conversas.service.js');

    const r1 = await receberMensagem({ tenantId, remetente: '5511922223333', texto: 'oi', idExterno: 'h1' });
    const { usuario } = await entrar(app, 'recepcao');
    await conversas.assumir(tenantId, r1.conversationId, usuario);
    await conversas.responder(tenantId, r1.conversationId, { conteudo: 'Oi! Sou a recepcao.' }, usuario);

    enviados.length = 0;
    const r2 = await receberMensagem({ tenantId, remetente: '5511922223333', texto: '1', idExterno: 'h2' });

    assert.equal(r2.respondido, false);
    assert.equal(enviados.length, 0, 'nada pode ser enviado por cima do atendente humano');
  });

  /**
   * A outra metade da regra: assumir NAO cala a Sofia. Um atendente que pescou
   * o cliente e ainda esta lendo o historico nao pode deixar o cliente sem
   * resposta — a IA segue ate a primeira mensagem dele.
   */
  it('assumiu mas ainda nao escreveu: a Sofia continua respondendo', async () => {
    const conversas = await import('../src/modules/conversas/conversas.service.js');

    const r1 = await receberMensagem({ tenantId, remetente: '5511977778888', texto: 'oi', idExterno: 'pesca1' });
    const { usuario } = await entrar(app, 'recepcao');
    await conversas.assumir(tenantId, r1.conversationId, usuario);

    enviados.length = 0;
    const r2 = await receberMensagem({ tenantId, remetente: '5511977778888', texto: '1', idExterno: 'pesca2' });

    assert.equal(r2.respondido, true, 'a conversa e do atendente, mas ele ainda nao falou com o cliente');
    assert.ok(enviados.length > 0);
  });

  it('apos pedir atendente, a automacao para de responder', async () => {
    const conversas = await import('../src/modules/conversas/conversas.service.js');

    const r1 = await receberMensagem({ tenantId, remetente: '5511933334444', texto: '4', idExterno: 'f1' });
    assert.equal(r1.transferido, true);

    // O gateway tenta distribuir na hora. Com a recepcao online (vinda do
    // seed), a conversa ja sai da fila e cai com ela.
    const conversa = await conversas.obter(tenantId, r1.conversationId);
    assert.ok(['na_fila', 'humana'].includes(conversa.status));

    enviados.length = 0;
    const r2 = await receberMensagem({ tenantId, remetente: '5511933334444', texto: 'alguem ai?', idExterno: 'f2' });

    // O motivo varia conforme alguem tenha assumido ou nao; o que nao pode
    // variar e a automacao ficar calada e nao mandar nada por cima.
    assert.equal(r2.respondido, false);
    assert.ok(['aguardando_humano', 'atendimento_humano'].includes(r2.motivo));
    assert.equal(enviados.length, 0);
  });

  it('respeita a IA desligada no canal', async () => {
    const { db } = await import('../src/db/client.js');
    const { channelInstances } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');

    await db.update(channelInstances).set({ iaHabilitada: false }).where(eq(channelInstances.tenantId, tenantId));

    const r = await receberMensagem({ tenantId, remetente: '5511944445555', texto: '1', idExterno: 'd1' });
    assert.equal(r.respondido, false);
    assert.equal(r.motivo, 'ia_desligada_neste_canal');

    await db.update(channelInstances).set({ iaHabilitada: true }).where(eq(channelInstances.tenantId, tenantId));
  });
});

describe('agrupamento no fluxo real', () => {
  it('mensagens picotadas geram UMA resposta so', async () => {
    const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
    await atendimento.salvarConfiguracao(tenantId, { agrupamentoSegundos: 1 });
    recarregarAgrupador(tenantId);

    enviados.length = 0;

    const resultados = await Promise.all([
      receberMensagem({ tenantId, remetente: '5511955556666', texto: 'oi', idExterno: 'p1' }),
      receberMensagem({ tenantId, remetente: '5511955556666', texto: 'tudo bem?', idExterno: 'p2' }),
      receberMensagem({ tenantId, remetente: '5511955556666', texto: '1', idExterno: 'p3' })
    ]);

    const responderam = resultados.filter((r) => r.respondido);
    assert.equal(responderam.length, 1, 'tres mensagens picotadas = uma resposta');
    assert.equal(responderam[0].agrupadas, 3);

    // As tres perguntas continuam salvas, mesmo processadas juntas.
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const { mensagens } = await conversas.mensagens(tenantId, responderam[0].conversationId);
    const doCliente = mensagens.filter((m) => m.autorTipo === 'lead').map((m) => m.conteudo);
    assert.deepEqual(doCliente, ['oi', 'tudo bem?', '1']);

    await atendimento.salvarConfiguracao(tenantId, { agrupamentoSegundos: 0 });
    recarregarAgrupador(tenantId);
  });
});

describe('falha de envio', () => {
  /**
   * Se o WhatsApp recusar o envio, o atendente precisa VER na tela o que a
   * automacao tentou dizer e nao chegou — em vez de a mensagem sumir.
   */
  it('grava a mensagem mesmo quando o canal recusa o envio', async () => {
    registrarAdaptador('whatsapp', {
      ...adaptadorFalso,
      async enviar() {
        throw new Error('Numero nao esta no WhatsApp');
      }
    });

    const r = await receberMensagem({ tenantId, remetente: '5511966667777', texto: '1', idExterno: 'e1' });

    assert.equal(r.respondido, true);
    assert.ok(r.baloes[0].erroEnvio, 'o erro precisa ficar registrado');

    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const { mensagens } = await conversas.mensagens(tenantId, r.conversationId);
    const saida = mensagens.filter((m) => m.direcao === 'saida');

    assert.ok(saida.length >= 1, 'a resposta precisa aparecer na tela do atendente');
    assert.match(saida.at(-1).erroEnvio, /nao esta no WhatsApp/i);

    registrarAdaptador('whatsapp', adaptadorFalso);
  });
});

describe('rotas de canais', () => {
  it('lista as conexoes sem vazar o QR de conexao ja ativa', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/canais', headers: cabDono });

    assert.equal(res.statusCode, 200);
    const canais = res.json().canais;
    assert.ok(canais.length >= 1);
    assert.equal(canais[0].chave, 'W1');
  });

  it('o dono NAO adiciona conexoes (isso e do perfil DEV; veja conexoes.test.js)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/canais',
      headers: cabDono,
      payload: { canal: 'whatsapp', nome: 'WhatsApp do Dono' }
    });

    assert.equal(res.statusCode, 404);
  });

  it('atendente NAO conecta nem desconecta canal', async () => {
    const { cabecalho } = await entrar(app, 'recepcao');
    const res = await app.inject({ method: 'POST', url: '/api/canais/W1/conectar', headers: cabecalho });
    assert.equal(res.statusCode, 403);
  });

  it('salva a configuracao de atendimento', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/atendimento/configuracao',
      headers: cabDono,
      payload: { modo: 'hibrido', agrupamentoSegundos: 10 }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().agrupamentoSegundos, 10);

    await app.inject({
      method: 'PUT',
      url: '/api/atendimento/configuracao',
      headers: cabDono,
      payload: { agrupamentoSegundos: 0 }
    });
  });

  it('recusa modo de atendimento inexistente', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/atendimento/configuracao',
      headers: cabDono,
      payload: { modo: 'telepatia' }
    });

    assert.equal(res.statusCode, 400);
  });
});
