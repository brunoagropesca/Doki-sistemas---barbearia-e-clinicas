import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { abrirACasa, criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { receberMensagem, recarregarAgrupador, registrarAdaptador } from '../src/channels/gateway.js';
import { assinar, nomeDeAssinatura } from '../src/modules/equipe/equipe.config.js';

/**
 * Assinatura: o nome de quem respondeu no topo da mensagem que o CLIENTE
 * recebe (Equipe > Atendentes > Privacidade). Duas chaves: atendentes e Sofia.
 * O texto gravado na conversa fica sem — o livechat ja mostra o autor.
 *
 * WhatsApp e IA de mentira (o adaptador guarda o que "enviou"; o fetch da IA
 * devolve uma resposta fixa). Telefones proprios (5592900099xxx).
 */

let app;
let tenantId;
let cabDono;
let nomeDono;
let telefone = 5592900099000;

const enviados = [];
let seq = 0;
const adaptadorFalso = {
  async enviar({ destino, texto, midia }) {
    enviados.push({ destino, texto, legenda: midia?.legenda });
    return { idExterno: `assin_${++seq}` };
  },
  async conectar() {
    return { conectando: true };
  },
  async desconectar() {
    return { ok: true };
  },
  estaConectada: () => true
};

const fetchOriginal = globalThis.fetch;
const configurar = (dados) => app.inject({ method: 'PUT', url: '/api/equipe/configuracao', headers: cabDono, payload: dados });
const doNumero = (numero) => enviados.filter((e) => e.destino === numero).map((e) => e.texto);

before(async () => {
  ({ app } = await criarAppDeTeste());
  await abrirACasa();
  const dono = await entrar(app);
  cabDono = dono.cabecalho;
  tenantId = dono.usuario.tenantId;
  nomeDono = dono.usuario.nome;
  registrarAdaptador('whatsapp', adaptadorFalso);

  const { db } = await import('../src/db/client.js');
  const { aiProviders } = await import('../src/db/schema/index.js');
  await db.insert(aiProviders).values({
    id: 'aip_assinatura',
    tenantId,
    provedor: 'ollama',
    habilitado: true,
    prioridade: 0,
    baseUrl: 'http://ia-assinatura.local/v1',
    modelos: [{ nome: 'modelo-falso', ativo: true }]
  });
  globalThis.fetch = async (url, opcoes) => {
    if (!String(url).startsWith('http://ia-assinatura.local')) return fetchOriginal(url, opcoes);
    const dados = {
      choices: [{ message: { content: 'Oi! Seu horário está confirmado.[BALAO]Até sexta!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 }
    };
    return { ok: true, status: 200, json: async () => dados, text: async () => JSON.stringify(dados) };
  };

  // Direto na Sofia (sem menu) e sem esperar a janela de agrupamento.
  const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
  await atendimento.salvarConfiguracao(tenantId, { modo: 'ia', agrupamentoSegundos: 0 });
  recarregarAgrupador(tenantId);
});

after(async () => {
  globalThis.fetch = fetchOriginal;
  const { db } = await import('../src/db/client.js');
  const { aiProviders } = await import('../src/db/schema/index.js');
  const { eq } = await import('drizzle-orm');
  await db.delete(aiProviders).where(eq(aiProviders.id, 'aip_assinatura'));
  await app?.close();
});

describe('formato (puro)', () => {
  it('nome em negrito na primeira linha; sem nome ou sem texto, volta como veio', () => {
    assert.equal(assinar('Carlos', 'Pode vir às 15h'), '*Carlos:*\nPode vir às 15h');
    assert.equal(assinar('', 'Pode vir'), 'Pode vir');
    assert.equal(assinar(null, 'Pode vir'), 'Pode vir');
    assert.equal(assinar('Carlos', '   '), '   ');
  });

  it('o nome do perfil da Sofia perde a descricao', () => {
    assert.equal(nomeDeAssinatura('Sofia - Atendente WhatsApp'), 'Sofia');
    assert.equal(nomeDeAssinatura('Bia'), 'Bia');
  });
});

describe('configuracao', () => {
  it('vem DESLIGADA por padrao (ligar muda o que o cliente ve)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/equipe/configuracao', headers: cabDono });
    assert.equal(r.json().configuracao.assinaturaAtendente, false);
    assert.equal(r.json().configuracao.assinaturaSofia, false);
  });

  it('so o dono altera', async () => {
    const { cabecalho } = await entrar(app, 'recepcao');
    const r = await app.inject({ method: 'PUT', url: '/api/equipe/configuracao', headers: cabecalho, payload: { assinaturaSofia: true } });
    assert.equal(r.statusCode, 403);
  });
});

describe('no WhatsApp do cliente', () => {
  let numero;
  let conversationId;

  it('Sofia assinada: so o PRIMEIRO balao leva o nome; a conversa gravada fica sem', async () => {
    assert.equal((await configurar({ assinaturaSofia: true })).statusCode, 200);
    numero = String(++telefone);
    const r = await receberMensagem({ tenantId, remetente: numero, texto: 'oi, tem horário sexta?', idExterno: `assin-in-${numero}` });
    conversationId = r.conversationId;

    assert.deepEqual(doNumero(numero), ['*Sofia:*\nOi! Seu horário está confirmado.', 'Até sexta!']);

    const lista = (await app.inject({ method: 'GET', url: `/api/conversas/${conversationId}/mensagens`, headers: cabDono })).json().mensagens;
    const daIa = lista.filter((m) => m.autorTipo === 'ia').map((m) => m.conteudo);
    assert.deepEqual(daIa, ['Oi! Seu horário está confirmado.', 'Até sexta!']);
  });

  it('atendente assinado: texto e legenda levam o nome; o gravado fica sem', async () => {
    assert.equal((await configurar({ assinaturaAtendente: true })).statusCode, 200);
    const r = await app.inject({
      method: 'POST',
      url: `/api/conversas/${conversationId}/mensagens`,
      headers: cabDono,
      payload: { conteudo: 'Pode vir às 15h' }
    });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().entrega.entregue, true, JSON.stringify(r.json().entrega));
    assert.equal(doNumero(numero).at(-1), `*${nomeDono}:*\nPode vir às 15h`);

    const lista = (await app.inject({ method: 'GET', url: `/api/conversas/${conversationId}/mensagens`, headers: cabDono })).json().mensagens;
    assert.equal(lista.find((m) => m.id === r.json().id).conteudo, 'Pode vir às 15h');

    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await app.inject({
      method: 'POST',
      url: `/api/conversas/${conversationId}/mensagens`,
      headers: cabDono,
      payload: { conteudo: 'Esse é o corte', anexo: { dataUrl: `data:image/png;base64,${PNG}`, nome: 'corte.png' } }
    });
    assert.equal(enviados.at(-1).legenda, `*${nomeDono}:*\nEsse é o corte`);
  });

  it('desligadas: nada muda no que o cliente recebe', async () => {
    await configurar({ assinaturaAtendente: false, assinaturaSofia: false });
    await app.inject({ method: 'POST', url: `/api/conversas/${conversationId}/mensagens`, headers: cabDono, payload: { conteudo: 'Combinado!' } });
    assert.equal(doNumero(numero).at(-1), 'Combinado!');
  });
});
