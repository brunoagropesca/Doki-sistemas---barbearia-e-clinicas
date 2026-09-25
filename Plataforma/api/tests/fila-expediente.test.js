import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { abrirACasa, criarAppDeTeste } from './helpers/ambiente.js';
import { receberMensagem, recarregarAgrupador, registrarAdaptador } from '../src/channels/gateway.js';
import { dataNoFuso, diaDaSemana, somarDias } from '../src/core/datetime.js';
import { NOMES_DIAS } from '../src/core/datas-naturais.js';

/**
 * Cliente que pediu uma pessoa nao pode ficar falando sozinho.
 *
 * BUGS: (a) depois de "quero falar com uma pessoa", tudo o que o cliente
 * escrevia ficava sem resposta ate alguem assumir — inclusive a noite e por
 * dias; (b) as 23h ele recebia "Um instante! 🙏" sem ninguem na loja; (c) a
 * conversa cujo atendente esqueceu de finalizar ficava muda para sempre.
 *
 * A IA e um Ollama de mentira: o `fetch` e trocado por um que responde na hora
 * e guarda o que o modelo recebeu (o prompt, para conferir o aviso de "ja pediu
 * um atendente"). O WhatsApp e um adaptador que so anota o que "enviou".
 */

const FUSO = 'America/Sao_Paulo';
let tenantId;
let db;
let s;
let app;
const enviados = [];
const fetchOriginal = globalThis.fetch;
let chamadasSofia = [];

/** Pedido de pessoa (na ULTIMA mensagem do cliente) vira transferencia; o resto, texto. */
function respostaDoModelo(corpo) {
  const ultima = corpo.messages.at(-1);
  const ultimaDoCliente = [...corpo.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (/falar com uma pessoa/.test(ultimaDoCliente) && ultima.role !== 'tool' && corpo.tools?.length) {
    return {
      content: '',
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'transferir_para_humano', arguments: '{"motivo":"Cliente pediu uma pessoa."}' } }]
    };
  }
  if (ultima.role === 'tool') return { content: 'Claro, vou te passar para um atendente agora.' };
  return { content: 'O corte social sai por R$ 45,00.' };
}

const doCliente = (tel) => enviados.filter((e) => e.destino === tel).map((e) => e.texto);
const conversaDe = async (tel) => {
  const [lead] = await db.select().from(s.leads).where(and(eq(s.leads.tenantId, tenantId), eq(s.leads.telefone, tel)));
  const [c] = await db.select().from(s.conversations).where(eq(s.conversations.leadId, lead.id));
  return c;
};
const falar = (tel, texto, i) => receberMensagem({ tenantId, remetente: tel, texto, idExterno: `fila_${tel}_${i}` });

/** Jornada de todos os profissionais: so um dia da semana, 09:00-18:00. */
async function soAbreNoDia(dia) {
  await db.update(s.professionals).set({ jornada: { dias: { [dia]: [{ inicio: '09:00', fim: '18:00' }] }, intervaloMinutos: 30 } });
}

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ db } = await import('../src/db/client.js'));
  s = await import('../src/db/schema/index.js');
  [{ id: tenantId }] = await db.select().from(s.tenants);

  registrarAdaptador('whatsapp', {
    async enviar({ destino, texto }) {
      enviados.push({ destino, texto });
      return { idExterno: `fila_env_${enviados.length}` };
    },
    estaConectada: () => true
  });

  await db.insert(s.aiProviders).values({
    id: 'aip_fila_expediente',
    tenantId,
    provedor: 'ollama',
    habilitado: true,
    prioridade: 0,
    baseUrl: 'http://ia-falsa.local/v1',
    modelos: [{ nome: 'modelo-falso', ativo: true }]
  });
  globalThis.fetch = async (url, opcoes = {}) => {
    if (!String(url).startsWith('http://ia-falsa.local')) return fetchOriginal(url, opcoes);
    const corpo = JSON.parse(opcoes.body);
    // Chamadas da Sofia levam as ferramentas dela (a leitura de humor, nao).
    if ((corpo.tools ?? []).some((t) => t.function?.name === 'transferir_para_humano')) chamadasSofia.push(corpo);
    const dados = { choices: [{ message: respostaDoModelo(corpo), finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } };
    return { ok: true, status: 200, json: async () => dados, text: async () => JSON.stringify(dados) };
  };

  const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
  await atendimento.salvarConfiguracao(tenantId, { modo: 'hibrido', agrupamentoSegundos: 0 });
  recarregarAgrupador(tenantId);
});

after(async () => {
  globalThis.fetch = fetchOriginal;
  await app?.close();
});

describe('casa fechada', () => {
  it('pediu pessoa: recebe QUANDO a equipe volta, e a Sofia continua ajudando na fila', async () => {
    // Abre so daqui a 2 dias (nunca "hoje" nem "amanha"): fechado agora, em qualquer horario da suite.
    const dia = somarDias(dataNoFuso(Date.now(), FUSO), 2);
    await soAbreNoDia(diaDaSemana(dia));
    const tel = '5511955510001';
    chamadasSofia = [];

    const pedido = await falar(tel, 'quero falar com uma pessoa', 1);
    assert.equal(pedido.transferido, true);
    const [aviso] = doCliente(tel);
    assert.match(aviso, new RegExp(`${NOMES_DIAS[diaDaSemana(dia)]} às 09:00`), aviso);
    assert.doesNotMatch(aviso, /um instante/i, 'nada de "um instante" com a casa fechada');
    assert.doesNotMatch(aviso, /vou te passar/i, 'nem a despedida da Sofia, que prometeria o mesmo');
    assert.equal((await conversaDe(tel)).status, 'na_fila');

    const seguinte = await falar(tel, 'e quanto custa o corte?', 2);
    assert.equal(seguinte.respondido, true);
    assert.equal(seguinte.respondidoPor, 'ia');
    assert.equal((await conversaDe(tel)).status, 'na_fila', 'continua esperando uma pessoa');
    const prompt = chamadasSofia.at(-1).messages.find((m) => m.role === 'system').content;
    assert.match(prompt, /já pediu um atendente e a equipe já foi avisada/);
  });
});

describe('casa aberta', () => {
  before(abrirACasa);

  it('pediu pessoa: aviso normal; na fila recente, silencio; fila parada 31 min, a Sofia volta', async () => {
    const tel = '5511955510002';
    const pedido = await falar(tel, 'quero falar com uma pessoa', 1);
    assert.equal(pedido.transferido, true);
    assert.doesNotMatch(doCliente(tel)[0], /fora do horário/, 'casa aberta: o aviso de sempre');
    const conversa = await conversaDe(tel);
    assert.equal(conversa.status, 'na_fila');
    assert.ok(conversa.naFilaDesde, 'a entrada na fila fica marcada');

    const logo = await falar(tel, 'alguém aí?', 2);
    assert.equal(logo.respondido, false);
    assert.equal(logo.motivo, 'aguardando_humano');

    await db
      .update(s.conversations)
      .set({ naFilaDesde: new Date(Date.now() - 31 * 60_000) })
      .where(eq(s.conversations.id, conversa.id));
    const depois = await falar(tel, 'e quanto custa o corte?', 3);
    assert.equal(depois.respondidoPor, 'ia', 'ninguem assumiu em 30 min: a Sofia ajuda');
    assert.equal((await conversaDe(tel)).status, 'na_fila');
  });

  it('entrar de novo na fila nao zera o tempo de espera', async () => {
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const c = await conversaDe('5511955510002');
    await conversas.enviarParaFila(tenantId, c.id);
    assert.equal((await conversaDe('5511955510002')).naFilaDesde.getTime(), c.naFilaDesde.getTime());
  });
});

describe('atendente que sumiu', () => {
  before(abrirACasa);

  /** Conversa assumida pela recepcao, com a ultima mensagem dela ha `horas`. */
  async function comAtendente(tel, horas) {
    await falar(tel, 'oi', 1);
    const [recepcao] = await db.select().from(s.users).where(and(eq(s.users.tenantId, tenantId), eq(s.users.username, 'recepcao')));
    const c = await conversaDe(tel);
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    await conversas.registrarEnviada(tenantId, c.id, { conteudo: 'Oi! Já te ajudo.', autorTipo: 'humano' });
    const quando = new Date(Date.now() - horas * 3_600_000);
    await db
      .update(s.messages)
      .set({ createdAt: quando })
      .where(and(eq(s.messages.conversationId, c.id), eq(s.messages.autorTipo, 'humano')));
    await db
      .update(s.conversations)
      .set({ status: 'humana', assignedUserId: recepcao.id, assumidaEm: quando })
      .where(eq(s.conversations.id, c.id));
    return recepcao;
  }

  it('13 h sem o atendente escrever: a Sofia responde e ele continua dono da conversa', async () => {
    const tel = '5511955510003';
    const recepcao = await comAtendente(tel, 13);

    const r = await falar(tel, 'e quanto custa o corte?', 2);
    assert.equal(r.respondidoPor, 'ia');
    const c = await conversaDe(tel);
    assert.equal(c.status, 'bot');
    assert.equal(c.assignedUserId, recepcao.id, 'o atendente continua dono do cliente e dos horarios');
  });

  it('atendente escreveu ha 1 h: silencio, como sempre', async () => {
    const tel = '5511955510004';
    await comAtendente(tel, 1);

    const r = await falar(tel, 'e quanto custa o corte?', 2);
    assert.equal(r.respondido, false);
    assert.equal(r.motivo, 'atendimento_humano');
    assert.equal((await conversaDe(tel)).status, 'humana');
  });
});
