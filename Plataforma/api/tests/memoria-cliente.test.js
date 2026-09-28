import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

/**
 * Memoria da Sofia: a ficha do cliente que VOLTA.
 *
 * A agenda (servico de sempre, profissional, ultima visita) sai do historico
 * de atendimentos, sem IA; o que o cliente disse sai de uma chamada curta de
 * IA sobre o resumo final. O modelo e um duble; o resto e o sistema de verdade.
 * Clientes e telefones proprios ("Mem ...", 55119123409xx).
 */

let app;
let cabDono;
let cabRecepcao;
let dono;
let tenantId;
let db;
let s; // schema
let mem; // leads/memoria.js
let conv; // conversas.service.js
let responder;

const DIA = 86_400_000;
const PROMPT_BLOCO = 'O QUE VOCÊ JÁ SABE DESTE CLIENTE';

function provedorFalso(roteiro) {
  const chamadas = [];
  let i = 0;
  const impl = {
    nome: 'falso',
    async gerar({ modelo, systemPrompt, mensagens }) {
      chamadas.push({ systemPrompt, mensagens });
      const passo = roteiro[Math.min(i++, roteiro.length - 1)];
      return { texto: passo.texto ?? '', chamadasDeFerramenta: [], tokens: { entrada: 5, saida: 5 }, modelo };
    }
  };
  return { provedores: [{ impl, apiKey: 'x', modelos: ['m'] }], chamadas };
}

async function novoCliente(nome, telefone) {
  const r = await app.inject({ method: 'POST', url: '/api/leads', headers: cabDono, payload: { nome, telefone } });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().lead.id;
}

const porNome = async (tabela, nome) => (await db.select().from(tabela).where(eq(tabela.nome, nome)))[0];

/** Um atendimento CONCLUIDO no passado, gravado pelo caminho real (registrarDesfecho). */
async function visitaConcluida(leadId, servico, profissional, diasAtras, sufixo) {
  const { registrarDesfecho } = await import('../src/modules/historico/historico.service.js');
  const inicio = new Date(Date.now() - diasAtras * DIA);
  const id = `apt_memtest_${sufixo}`;
  await db.insert(s.appointments).values({
    id,
    tenantId,
    leadId,
    serviceId: servico.id,
    professionalId: profissional.id,
    inicioEm: inicio,
    fimEm: new Date(inicio.getTime() + 30 * 60_000),
    status: 'concluido',
    precoCentavos: servico.precoCentavos,
    concluidoEm: new Date(inicio.getTime() + 30 * 60_000)
  });
  assert.equal(await registrarDesfecho(tenantId, id), true);
}

/** Conversa do cliente, finalizada com um resumo escrito pelo atendente. */
async function finalizarConversa(leadId, resumo, respostaDaIa) {
  const [canal] = await db.select().from(s.channelInstances);
  const id = await conv.encontrarOuAbrir(tenantId, { leadId, canal: 'whatsapp', channelInstanceId: canal.id });
  await conv.registrarRecebida(tenantId, id, { conteudo: 'Oi, tudo bem? Queria marcar de novo.' });
  const falso = provedorFalso([{ texto: respostaDaIa }]);
  await conv.finalizar(tenantId, id, { resumo }, { ...dono }, { provedores: falso.provedores, pedirAvaliacao: false });
  await conv.aguardarResumos();
  return { id, falso };
}

/** O system prompt da Sofia numa conversa nova deste cliente. */
async function promptDa(leadId, leadNome) {
  const falso = provedorFalso([{ texto: 'Oi! Tudo ótimo por aqui.' }]);
  await responder({
    tenantId, conversationId: null, leadId, leadNome, texto: 'oi, quero marcar',
    simulacao: true, modoOverride: 'ia', provedores: falso.provedores
  });
  return falso.chamadas[0].systemPrompt;
}

const lerMemoria = (leadId, cab = cabDono) =>
  app.inject({ method: 'GET', url: `/api/leads/${leadId}/memoria`, headers: cab });

before(async () => {
  ({ app } = await criarAppDeTeste());
  const d = await entrar(app);
  cabDono = d.cabecalho;
  dono = d.usuario;
  tenantId = d.usuario.tenantId;
  ({ cabecalho: cabRecepcao } = await entrar(app, 'recepcao'));
  ({ db } = await import('../src/db/client.js'));
  s = await import('../src/db/schema/index.js');
  mem = await import('../src/modules/leads/memoria.js');
  conv = await import('../src/modules/conversas/conversas.service.js');
  ({ responder } = await import('../src/modules/atendimento/atendimento.service.js'));
  // A Atena pode resumir (e, portanto, ler preferencias do resumo).
  await app.inject({
    method: 'PUT', url: '/api/ia/agentes/atena', headers: cabDono,
    payload: { ferramentas: ['catalogo', 'horarios', 'criar', 'editar', 'cancelar', 'funil', 'resumo', 'rotina', 'historico'] }
  });
});

after(async () => {
  await app?.close();
});

describe('cliente que volta', () => {
  let leadId;

  it('2 cortes com o Carlos: a ficha diz corte e Carlos (agenda, sem IA)', async () => {
    leadId = await novoCliente('Mem Otavio', '11912340901');
    const corte = await porNome(s.services, 'Corte Social');
    const barba = await porNome(s.services, 'Barba Terapia');
    const carlos = await porNome(s.professionals, 'Carlos Mendes');
    const julia = await porNome(s.professionals, 'Julia Rocha');

    await visitaConcluida(leadId, barba, julia, 60, 'a');
    await visitaConcluida(leadId, corte, carlos, 30, 'b');
    await visitaConcluida(leadId, corte, carlos, 8, 'c');

    const { memoria } = (await lerMemoria(leadId)).json();
    const fato = Object.fromEntries(memoria.agenda.map((f) => [f.chave, f]));
    assert.equal(fato.servicoFrequente.nome, 'Corte Social');
    assert.equal(fato.servicoFrequente.vezes, 2);
    assert.equal(fato.profissionalPreferido.nome, 'Carlos Mendes');
    assert.equal(fato.ultimaVisita.servico, 'Corte Social');
  });

  it('ao finalizar, a IA so ACRESCENTA o que o cliente disse; nada novo, nada muda', async () => {
    const { falso } = await finalizarConversa(
      leadId,
      'Cliente pediu corte para sexta; disse que prefere horário de manhã e é alérgico a pomada com álcool.',
      '{"preferencias":["Prefere horário de manhã"],"observacoes":["Alérgico a pomada com álcool"]}'
    );
    assert.equal(falso.chamadas.length, 1, 'uma chamada curta, so sobre o resumo');
    assert.match(falso.chamadas[0].mensagens[0].conteudo, /prefere horário de manhã/);

    let { memoria } = (await lerMemoria(leadId)).json();
    assert.deepEqual(memoria.preferencias, ['Prefere horário de manhã']);
    assert.deepEqual(memoria.observacoes, ['Alérgico a pomada com álcool']);

    // Segunda conversa sem fato novo: a ficha fica igual (e repetido nao duplica).
    await finalizarConversa(leadId, 'Cliente tirou uma dúvida de horário.', '{"preferencias":["prefere horário de manhã"],"observacoes":[]}');
    ({ memoria } = (await lerMemoria(leadId)).json());
    assert.deepEqual(memoria.preferencias, ['Prefere horário de manhã']);

    // Resposta que nao e JSON (ou preco inventado) nao vira memoria.
    await finalizarConversa(leadId, 'Cliente perguntou o preço.', 'Ele prefere pagar R$ 30 no corte.');
    ({ memoria } = (await lerMemoria(leadId)).json());
    assert.equal(memoria.preferencias.length, 1);
    assert.ok(!JSON.stringify(memoria).includes('R$'));
  });

  it('a ficha entra no prompt da conversa seguinte', async () => {
    const prompt = await promptDa(leadId, 'Mem Otavio');
    assert.ok(prompt.includes(PROMPT_BLOCO));
    assert.match(prompt, /Serviço de sempre: Corte Social \(2 vezes\)/);
    assert.match(prompt, /Costuma ser atendido por: Carlos Mendes/);
    assert.match(prompt, /Prefere horário de manhã/);
    assert.match(prompt, /Nunca diga que "consta no sistema"/);
    // A ficha vem depois do bloco fixo (nao quebra o reaproveitamento do inicio).
    assert.ok(prompt.indexOf(PROMPT_BLOCO) > prompt.indexOf('CONTEXTO:'));
  });

  it('cliente novo nao tem bloco (nem ficha)', async () => {
    const novo = await novoCliente('Mem Novato', '11912340902');
    const prompt = await promptDa(novo, 'Mem Novato');
    assert.ok(!prompt.includes(PROMPT_BLOCO));
    const [linha] = await db.select({ memoria: s.leads.memoria }).from(s.leads).where(eq(s.leads.id, novo));
    assert.equal(linha.memoria, null);
  });

  it('apagar um item pela tela tira do prompt (e fica na auditoria)', async () => {
    const r = await app.inject({
      method: 'PUT', url: `/api/leads/${leadId}/memoria`, headers: cabDono,
      payload: { preferencias: [], esquecer: ['profissionalPreferido'] }
    });
    assert.equal(r.statusCode, 200, r.body);
    const prompt = await promptDa(leadId, 'Mem Otavio');
    assert.ok(!/manhã/.test(prompt), 'preferencia apagada saiu');
    assert.ok(!prompt.includes('Costuma ser atendido por'), 'profissional esquecido saiu');
    assert.match(prompt, /Alérgico a pomada com álcool/, 'o resto continua');

    const [aud] = await db
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.tenantId, tenantId), eq(s.auditLogs.acao, 'lead.memoria')));
    assert.ok(aud, 'correcao auditada');
  });

  it('corrigir um item troca o texto', async () => {
    const r = await app.inject({
      method: 'PUT', url: `/api/leads/${leadId}/memoria`, headers: cabDono,
      payload: { observacoes: ['Alérgico a produtos com álcool'] }
    });
    assert.deepEqual(r.json().memoria.observacoes, ['Alérgico a produtos com álcool']);
  });
});

describe('limite e privacidade', () => {
  it('o texto da ficha nunca passa do limite (~100 tokens)', async () => {
    const longo = (n) => `${'Preferência muito detalhada número '.repeat(3)}${n}`;
    const ficha = {
      agenda: {
        servicoFrequente: { nome: 'Corte Degrade com acabamento na navalha e desenho', vezes: 12 },
        profissionalPreferido: { nome: 'Profissional Com Nome Bem Comprido da Silva', vezes: 9 },
        ultimaVisita: { data: '2026-09-01', servico: 'Corte + Barba', profissional: 'Carlos Mendes' }
      },
      preferencias: [1, 2, 3, 4, 5, 6, 7].map(longo),
      observacoes: [1, 2, 3, 4].map(longo)
    };
    const texto = mem.textoDaMemoria(ficha);
    assert.ok(texto.length <= mem.LIMITE_TEXTO, `${texto.length} caracteres`);
    assert.ok(texto.split('\n').every((l) => l.length <= 100), 'cada item e curto');

    // Pela tela tambem: a API recusa lista maior que o teto.
    const leadId = await novoCliente('Mem Limite', '11912340903');
    const r = await app.inject({
      method: 'PUT', url: `/api/leads/${leadId}/memoria`, headers: cabDono,
      payload: { preferencias: [1, 2, 3, 4, 5, 6].map(String) }
    });
    assert.equal(r.statusCode, 400);
  });

  it('atendente que nao ve nenhuma conversa do cliente nao ve a ficha', async () => {
    const leadId = await novoCliente('Mem Privado', '11912340904');
    const [canal] = await db.select().from(s.channelInstances);
    const id = await conv.encontrarOuAbrir(tenantId, { leadId, canal: 'whatsapp', channelInstanceId: canal.id });
    await db.update(s.conversations).set({ assignedUserId: dono.id }).where(eq(s.conversations.id, id));
    await mem.corrigirMemoria(tenantId, leadId, { preferencias: ['Gosta de café'] });

    const r = (await lerMemoria(leadId, cabRecepcao)).json();
    assert.equal(r.restrita, true);
    assert.equal(r.memoria, null);
    const put = await app.inject({
      method: 'PUT', url: `/api/leads/${leadId}/memoria`, headers: cabRecepcao, payload: { preferencias: [] }
    });
    assert.equal(put.statusCode, 403);
    assert.equal((await lerMemoria(leadId)).json().memoria.preferencias[0], 'Gosta de café', 'o dono ve');
  });
});

describe('LGPD', () => {
  it('excluir o cliente apaga a ficha', async () => {
    const leadId = await novoCliente('Mem Excluido', '11912340905');
    await mem.corrigirMemoria(tenantId, leadId, { preferencias: ['Prefere a tarde'] });
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/leads/${leadId}`, headers: cabDono })).statusCode, 200);
    const [linha] = await db.select({ memoria: s.leads.memoria }).from(s.leads).where(eq(s.leads.id, leadId));
    assert.equal(linha.memoria, null);
  });
});
