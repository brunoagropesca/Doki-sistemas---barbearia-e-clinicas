import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { abrirACasa, criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { receberMensagem, recarregarAgrupador, registrarAdaptador } from '../src/channels/gateway.js';

/**
 * Entrega das respostas do atendente com a conexao instavel (bug das fotos
 * do Lyu): a conexao caiu por segundos e a foto falhava na hora; o servidor
 * reiniciou no meio e a mensagem virava "confira no celular" mesmo sem ter
 * saido. Agora: espera a conexao voltar, repete sozinha o que COM CERTEZA
 * nao saiu, nunca repete o que pode ter chegado, mantem a ordem da conversa
 * e, num reinicio, retoma o que ainda estava na fila.
 *
 * WhatsApp de mentira com conexao controlada. Telefones proprios (5592900097xxx).
 */

let app;
let tenantId;
let cab;
let db;
let s;
let entrega;
let telefone = 5592900097000;

const estado = { conectada: true, falhas: [], atrasoMs: 0, chamadas: 0 };
const enviados = [];
let seq = 0;

const naoSaiu = (msg) => Object.assign(new Error(msg), { naoSaiu: true });

registrarAdaptador('whatsapp', {
  async enviar({ destino, texto, midia, aoFase }) {
    estado.chamadas += 1;
    if (!estado.conectada) throw naoSaiu('A conexão "W1" do WhatsApp não está conectada.');
    await aoFase?.('enviando');
    if (estado.atrasoMs) await new Promise((r) => setTimeout(r, estado.atrasoMs));
    const falha = estado.falhas.shift();
    if (falha) throw falha;
    enviados.push({ destino, texto: texto ?? midia?.legenda ?? '(midia)' });
    return { idExterno: `fila_${++seq}` };
  },
  async conectar() {
    return { conectando: true };
  },
  async desconectar() {
    return { ok: true };
  },
  estaConectada: () => estado.conectada
});

/** Conversa nova, ja com o atendente (a primeira resposta humana a assume). */
async function conversaComAtendente() {
  const numero = String(++telefone);
  const r = await receberMensagem({ tenantId, canal: 'whatsapp', instanciaChave: 'W1', remetente: numero, texto: 'oi', nome: 'Cliente Fila' });
  // O menu respondeu ao "oi": fora da conta, so interessam as do atendente.
  for (let i = enviados.length - 1; i >= 0; i--) if (enviados[i].destino === numero) enviados.splice(i, 1);
  estado.chamadas = 0;
  return { numero, id: r.conversationId };
}

const responder = (id, conteudo) =>
  app.inject({ method: 'POST', url: `/api/conversas/${id}/mensagens`, headers: cab, payload: { conteudo } });

const ler = async (mid) => (await db.select().from(s.messages).where(eq(s.messages.id, mid)))[0];
const doNumero = (numero) => enviados.filter((e) => e.destino === numero).map((e) => e.texto);

before(async () => {
  ({ app } = await criarAppDeTeste());
  await abrirACasa();
  const dono = await entrar(app);
  cab = dono.cabecalho;
  tenantId = dono.usuario.tenantId;
  ({ db } = await import('../src/db/client.js'));
  s = await import('../src/db/schema/index.js');
  entrega = await import('../src/modules/conversas/entrega.service.js');

  const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
  await atendimento.salvarConfiguracao(tenantId, { modo: 'menu', agrupamentoSegundos: 0 });
  recarregarAgrupador(tenantId);
});

beforeEach(() => {
  Object.assign(estado, { conectada: true, falhas: [], atrasoMs: 0, chamadas: 0 });
  Object.assign(entrega.tempos, { aguardarConexaoMs: 300, esperasNovaTentativaMs: [20, 50], checarConexaoMs: 20, esperaNaTelaMs: null });
});

after(async () => {
  await app?.close();
});

describe('conexao instavel', () => {
  it('conexao fora por um instante: espera ela voltar e entrega (antes: falhava na hora)', async () => {
    const { numero, id } = await conversaComAtendente();
    estado.conectada = false;
    setTimeout(() => (estado.conectada = true), 100);

    const r = await responder(id, 'Chegou a foto?');
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().entrega.entregue, true);
    assert.deepEqual(doNumero(numero), ['Chegou a foto?']);
    const m = await ler(r.json().id);
    assert.ok(m.entregueEm);
    assert.equal(m.erroEnvio, null);
  });

  it('falhou com certeza de que NAO saiu: tenta de novo sozinha e o cliente recebe UMA vez', async () => {
    const { numero, id } = await conversaComAtendente();
    estado.falhas.push(naoSaiu('A mídia não chegou a subir para o WhatsApp.'));

    const r = await responder(id, 'Segue o orçamento');
    assert.equal(r.json().entrega.entregue, true);
    assert.deepEqual(doNumero(numero), ['Segue o orçamento']);
  });

  it('falha AMBIGUA (pode ter chegado): nunca repete sozinha — fica "nao entregue" com o motivo', async () => {
    const { numero, id } = await conversaComAtendente();
    estado.falhas.push(new Error('O WhatsApp não confirmou o envio. Confira no celular se a mensagem saiu antes de reenviar.'));

    const r = await responder(id, 'Mensagem duvidosa');
    assert.equal(r.json().entrega.entregue, false);
    assert.match(r.json().entrega.erro, /Confira no celular/);
    assert.deepEqual(doNumero(numero), [], 'nenhuma segunda tentativa automatica');
    assert.match((await ler(r.json().id)).erroEnvio, /Confira no celular/);
  });

  it('conexao nao volta: desiste depois da espera, sem repetir a espera', async () => {
    const { numero, id } = await conversaComAtendente();
    estado.conectada = false;

    const r = await responder(id, 'Ninguém vai receber');
    assert.equal(r.json().entrega.entregue, false);
    assert.match(r.json().entrega.erro, /não está conectada/);
    assert.equal(estado.chamadas, 1, 'ja esperou a conexao o tempo todo: nao tenta (nem espera) de novo');
    assert.deepEqual(doNumero(numero), []);
  });

  it('as respostas saem na ORDEM escrita, mesmo com a primeira demorando', async () => {
    const { numero, id } = await conversaComAtendente();
    estado.atrasoMs = 80;
    const [a, b] = await Promise.all([responder(id, 'primeira'), responder(id, 'segunda')]);
    assert.equal(a.json().entrega.entregue, true);
    assert.equal(b.json().entrega.entregue, true);
    assert.deepEqual(doNumero(numero), ['primeira', 'segunda']);
  });
});

describe('a tela nao fica presa', () => {
  it('passou do tempo da tela: responde "pendente" e a entrega termina sozinha', async () => {
    entrega.tempos.esperaNaTelaMs = 30;
    entrega.tempos.aguardarConexaoMs = 2_000;
    const { numero, id } = await conversaComAtendente();
    estado.conectada = false;
    setTimeout(() => (estado.conectada = true), 150);

    const r = await responder(id, 'Vai chegar já já');
    assert.equal(r.statusCode, 201);
    assert.equal(r.json().entrega.pendente, true);
    const durante = await ler(r.json().id);
    assert.equal(durante.entregueEm, null);
    assert.equal(durante.metadados.entregaFase, 'aguardando_conexao', 'o balao mostra "aguardando a conexao"');

    await entrega.aguardarEntregas();
    const depois = await ler(r.json().id);
    assert.ok(depois.entregueEm);
    assert.deepEqual(doNumero(numero), ['Vai chegar já já']);
  });
});

describe('servidor reiniciou no meio', () => {
  async function presa(id, fase, { minutosAtras = 1 } = {}) {
    const { usuario } = await entrar(app);
    const repo = await import('../src/modules/conversas/conversas.repo.js');
    const mid = await repo.registrarMensagem(tenantId, id, {
      direcao: 'saida',
      autorTipo: 'humano',
      autorUserId: usuario.id,
      tipo: 'texto',
      conteudo: `presa em ${fase}`,
      metadados: fase ? { entregaFase: fase } : {}
    });
    await db.update(s.messages).set({ createdAt: new Date(Date.now() - minutosAtras * 60_000) }).where(eq(s.messages.id, mid));
    return mid;
  }

  it('o que nao tinha saido volta para a fila; o que pode ter chegado pede conferencia', async () => {
    const { numero, id } = await conversaComAtendente();
    await responder(id, 'assume a conversa'); // vira "humana"

    const naFila = await presa(id, 'fila');
    const subindo = await presa(id, 'subindo');
    const velha = await presa(id, 'subindo', { minutosAtras: 30 });
    const saindo = await presa(id, 'enviando');
    const semFase = await presa(id, null);

    const retomar = [];
    const marcadas = await entrega.marcarEntregasInterrompidas({ aoRetomar: (p) => retomar.push(p) });
    assert.ok(marcadas >= 3);
    assert.deepEqual(retomar.map((p) => p.id).sort(), [naFila, subindo].sort());

    assert.match((await ler(velha)).erroEnvio, /não chegou ao cliente. Pode reenviar/);
    assert.match((await ler(saindo)).erroEnvio, /Confira no celular/);
    assert.match((await ler(semFase)).erroEnvio, /Confira no celular/);

    // O boot entrega as retomadas: o cliente recebe, sem ninguem clicar.
    for (const p of retomar) await entrega.entregarMensagem(p.tenantId, p.conversationId, p.id);
    assert.ok((await ler(naFila)).entregueEm);
    assert.ok((await ler(subindo)).entregueEm);
    assert.deepEqual(doNumero(numero).slice(-2).sort(), ['presa em fila', 'presa em subindo']);
  });

  it('conversa que ja nao esta com o atendente: nao retoma (chegaria fora de contexto)', async () => {
    const { id } = await conversaComAtendente();
    await responder(id, 'assume');
    const mid = await presa(id, 'fila');
    await db.update(s.conversations).set({ status: 'bot' }).where(eq(s.conversations.id, id));

    const retomar = [];
    await entrega.marcarEntregasInterrompidas({ aoRetomar: (p) => retomar.push(p) });
    assert.ok(!retomar.some((p) => p.id === mid));
    assert.match((await ler(mid)).erroEnvio, /Pode reenviar/);
  });
});
