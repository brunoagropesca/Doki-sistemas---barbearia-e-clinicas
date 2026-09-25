import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste } from './helpers/ambiente.js';
import { ErroDeProvedor } from '../src/ai/providers/base.js';
import { consultarAtena } from '../src/ai/atena.js';
import { responder } from '../src/modules/atendimento/atendimento.service.js';
import * as agenda from '../src/modules/agenda/agenda.service.js';
import { dataNoFuso, diaDaSemana, somarDias } from '../src/core/datetime.js';

/**
 * As falhas das conversas de teste de 23/09/2026 (Débora e Lyu), uma a uma.
 *
 * Cada `it` e um defeito que chegou a um cliente de verdade. O modelo e de
 * mentira (segue um roteiro); ferramentas, agenda e banco rodam de verdade.
 * Se um destes quebrar, o defeito voltou.
 */

const FUSO = 'America/Sao_Paulo';

let tenantId;
let ctx = {};

/** Proxima segunda (Carlos atende 09-18; Julia nao trabalha segunda). */
function proximaSegunda() {
  let data = dataNoFuso(Date.now(), FUSO);
  for (let i = 0; i < 14; i++) {
    data = somarDias(data, 1);
    if (diaDaSemana(data) === 1) return data;
  }
  throw new Error('sem segunda-feira');
}
const SEGUNDA = proximaSegunda();
/** Como o cliente diria essa data: "dia 28". */
const DIA_DA_SEGUNDA = `dia ${Number(SEGUNDA.slice(8))}`;

const TRES = ['Corte Social', 'Barba Terapia', 'Pezinho'];

function provedorFalso(roteiro) {
  const chamadas = [];
  let i = 0;
  const impl = {
    nome: 'falso',
    async gerar({ modelo, systemPrompt, mensagens, ferramentas }) {
      chamadas.push({ systemPrompt, ferramentas: (ferramentas ?? []).map((f) => f.nome), mensagens: mensagens.map((m) => ({ ...m })) });
      const passo = roteiro[Math.min(i++, roteiro.length - 1)];
      if (passo.erro) throw new ErroDeProvedor(passo.erro, { provedor: 'falso', modelo, reTentavel: true });
      return { texto: passo.texto ?? '', chamadasDeFerramenta: passo.ferramentas ?? [], tokens: { entrada: 10, saida: 5 }, modelo };
    }
  };
  return { provedores: [{ impl, apiKey: 'x', modelos: ['modelo-falso'] }], chamadas };
}

const pedirAAtena = (roteiro, lead = ctx.lead1) => {
  const falso = provedorFalso(roteiro);
  return consultarAtena({
    tenantId,
    pedido: 'pedido de teste',
    leadId: lead.id,
    leadNome: lead.nome,
    fuso: FUSO,
    provedores: falso.provedores
  }).then((r) => ({ ...r, chamadas: falso.chamadas }));
};

const falarComSofia = (texto, roteiro) => {
  const falso = provedorFalso(roteiro);
  return responder({
    tenantId,
    conversationId: null,
    leadId: ctx.lead1.id,
    leadNome: ctx.lead1.nome,
    texto,
    simulacao: true,
    modoOverride: 'ia',
    provedores: falso.provedores
  }).then((r) => ({ ...r, chamadas: falso.chamadas }));
};

const doClienteNoDia = async (leadId, data) =>
  (await agenda.listarDoCliente(tenantId, leadId, { apenasFuturos: true, limite: 100 })).filter((a) => a.data === data);

before(async () => {
  let app;
  ({ app } = await criarAppDeTeste());
  ctx.app = app;

  const { db } = await import('../src/db/client.js');
  const s = await import('../src/db/schema/index.js');
  const [t] = await db.select().from(s.tenants);
  tenantId = t.id;

  const [profs, lds] = await Promise.all([db.select().from(s.professionals), db.select().from(s.leads)]);
  ctx.carlos = profs.find((p) => p.nome.startsWith('Carlos'));
  ctx.lead1 = lds[0];
  ctx.lead2 = lds[1];
  ctx.lead3 = lds[2];
});

after(async () => {
  await ctx.app?.close();
});

// ============================================================================

describe('Débora: "quero todos os 3"', () => {
  it('marca os tres em sequencia — um depois do outro, mesma visita', async () => {
    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'agendar_varios_servicos', argumentos: { servicos: TRES, data: DIA_DA_SEGUNDA, hora: '14:00' } }] },
      { texto: 'FEITO: três serviços a partir das 14:00.' }
    ]);

    const resultado = r.trace.ferramentas[0].resultado;
    assert.equal(resultado.sucesso, true, JSON.stringify(resultado));
    assert.match(resultado.dia, /^segunda-feira/, 'a data volta por extenso para a Sofia repassar');
    assert.deepEqual(
      resultado.agendamentos.map((a) => [a.servico, a.hora]),
      [['Corte Social', '14:00'], ['Barba Terapia', '14:30'], ['Pezinho', '15:00']]
    );

    const marcados = await doClienteNoDia(ctx.lead1.id, SEGUNDA);
    assert.equal(marcados.length, 3);
    assert.equal(r.trace.escritas, 1, 'e UMA operacao: conta uma escrita so');
  });

  it('pedir de novo o mesmo (a IA repetindo) devolve o que ja existe, sem duplicar', async () => {
    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'agendar_varios_servicos', argumentos: { servicos: TRES, data: DIA_DA_SEGUNDA, hora: '14:00' } }] },
      { texto: 'ok' }
    ]);
    const resultado = r.trace.ferramentas[0].resultado;
    assert.equal(resultado.jaExistia, true, JSON.stringify(resultado));
    assert.equal((await doClienteNoDia(ctx.lead1.id, SEGUNDA)).length, 3);
  });

  it('se um dos tres nao cabe, NENHUM e marcado (antes: 1 marcado e 2 "dados invalidos")', async () => {
    // Outro cliente tem o Carlos das 10:30 as 11:30 — bem onde o resto cairia,
    // e mais longo que a espera maxima entre servicos (30 min).
    await agenda.criar(tenantId, { leadId: ctx.lead2.id, serviceId: (await servicoPorNome('Barba Terapia')).id, professionalId: ctx.carlos.id, data: SEGUNDA, hora: '10:30' });
    await agenda.criar(tenantId, { leadId: ctx.lead2.id, serviceId: (await servicoPorNome('Corte Social')).id, professionalId: ctx.carlos.id, data: SEGUNDA, hora: '11:00' });

    const r = await pedirAAtena(
      [
        { ferramentas: [{ nome: 'agendar_varios_servicos', argumentos: { servicos: TRES, data: DIA_DA_SEGUNDA, hora: '10:00' } }] },
        { texto: 'NÃO FEITO.' }
      ],
      ctx.lead3
    );

    assert.ok(r.trace.ferramentas[0].resultado.erro, 'a recusa precisa voltar para a Atena');
    assert.equal((await doClienteNoDia(ctx.lead3.id, SEGUNDA)).length, 0, 'nada pela metade');
  });

  /**
   * Lyu: "não dá pra marcar esse de meio-dia e os outros em seguida?". A
   * resposta era so "nao da", e a Sofia inventou um horario que tambem nao
   * existia. Agora vem as opcoes REAIS mais perto da hora pedida.
   */
  it('hora que nao cabe: devolve as opcoes reais mais proximas dela', async () => {
    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'consultar_varios_servicos', argumentos: { servicos: TRES, data: DIA_DA_SEGUNDA, hora: '10:00' } }] },
      { texto: 'OPÇÕES' }
    ], ctx.lead3);

    const resultado = r.trace.ferramentas[0].resultado;
    assert.match(resultado.aviso, /mais próximas/);
    assert.ok(resultado.opcoes.length > 0 && resultado.opcoes.length <= 3, JSON.stringify(resultado));
    assert.ok(!resultado.opcoes.some((o) => o.inicio === '10:00'));
    const minutos = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3));
    assert.ok(resultado.opcoes.every((o) => Math.abs(minutos(o.inicio) - 600) <= 120), 'perto das 10:00, nao no fim do dia');
  });

  it('a consulta mostra a visita inteira em cada opcao', async () => {
    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'consultar_varios_servicos', argumentos: { servicos: TRES, data: DIA_DA_SEGUNDA } }] },
      { texto: 'OPÇÕES: ...' }
    ], ctx.lead3);

    const resultado = r.trace.ferramentas[0].resultado;
    assert.equal(resultado.data, SEGUNDA);
    assert.ok(resultado.opcoes.length > 0);
    for (const o of resultado.opcoes) {
      for (const nome of TRES) assert.match(o.ordem, new RegExp(nome), `cada opcao traz os tres: ${o.ordem}`);
    }
    assert.ok(!resultado.opcoes.some((o) => o.inicio === '14:00'), 'o Carlos ja esta com a Débora as 14:00');
  });
});

describe('Lyu: "qual dia os três estão livres?"', () => {
  it('sem data, a consulta ja acha o proximo dia com vaga para todos', async () => {
    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'consultar_varios_servicos', argumentos: { servicos: TRES } }] },
      { texto: 'OPÇÕES: ...' }
    ], ctx.lead3);

    const resultado = r.trace.ferramentas[0].resultado;
    assert.ok(resultado.data, JSON.stringify(resultado));
    assert.ok(resultado.dia);
    assert.ok(resultado.opcoes.length > 0);
  });

  it('dia sem expediente: a resposta ja traz o proximo dia com vaga (sem outra volta de modelo)', async () => {
    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'consultar_horarios', argumentos: { servicoId: 'Barba Terapia', data: 'domingo' } }] },
      { texto: 'NÃO FEITO: domingo fechado. OPÇÕES: ...' }
    ], ctx.lead3);

    const resultado = r.trace.ferramentas[0].resultado;
    assert.deepEqual(resultado.horariosLivres, []);
    assert.match(resultado.dia, /domingo/);
    assert.ok(resultado.proximaDataComVaga?.data, JSON.stringify(resultado));
    assert.ok(resultado.proximaDataComVaga.horarios.length > 0);
  });
});

describe('Débora: "quero agendar pra sexta" (a Atena em laco)', () => {
  it('as ferramentas entendem a data como o cliente falou', async () => {
    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'consultar_horarios', argumentos: { servicoId: 'Corte Social', profissionalId: 'Carlos', data: DIA_DA_SEGUNDA } }] },
      { texto: 'OPÇÕES' }
    ], ctx.lead3);
    const resultado = r.trace.ferramentas[0].resultado;
    assert.equal(resultado.data, SEGUNDA);
    assert.ok(resultado.horariosLivres.length > 0);
  });

  it('repetir a mesma consulta encerra na hora, e a Sofia recebe FATOS — nao "já te respondo"', async () => {
    const r = await pedirAAtena([
      { ferramentas: [{ nome: 'consultar_horarios', argumentos: { servicoId: 'Corte Máquina', data: 'sexta' } }] }
    ]);

    assert.equal(r.chamadas.length, 2, 'antes eram 4 chamadas iguais ate o limite');
    assert.match(r.resposta, /NÃO FEITO/);
    assert.match(r.resposta, /Não encontrei o serviço/, 'o motivo real vai para a Sofia');
    assert.match(r.resposta, /Não prometa retorno/);
    assert.doesNotMatch(r.resposta, /já te respondo|ja te respondo/i);
    assert.equal(r.trace.semConclusao, true);
  });

  it('o prompt da Atena leva so o dia de hoje (o calendario e conta do codigo)', async () => {
    const r = await pedirAAtena([{ texto: 'ok' }]);
    const prompt = r.chamadas[0].systemPrompt;
    assert.match(prompt, /Hoje é (segunda|terça|quarta|quinta|sexta)-feira|Hoje é (sábado|domingo)/);
    assert.doesNotMatch(prompt, /amanhã é/);
    assert.ok(r.chamadas[0].ferramentas.includes('consultar_varios_servicos'));
    assert.ok(r.chamadas[0].ferramentas.includes('agendar_varios_servicos'));
  });
});

describe('o que chega ao WhatsApp do cliente', () => {
  it('"a Atena pediu um instante": a resposta e reescrita sem os bastidores', async () => {
    const r = await falarComSofia('Quero agendar um corte pra sexta', [
      { texto: 'Oi Débora! A Atena pediu um instante para eu verificar a disponibilidade da sexta.' },
      { texto: 'Oi Débora! Qual corte você prefere? Assim eu já vejo os horários de sexta.' }
    ]);

    assert.doesNotMatch(r.baloes.join(' '), /atena/i);
    assert.match(r.baloes.join(' '), /Qual corte/);
    assert.match(r.chamadas[1].systemPrompt, /Reescreva a mensagem/, 'a reescrita e uma chamada curta, so com o rascunho');
    assert.equal(r.chamadas[1].mensagens.length, 1, 'nao reenvia a conversa inteira');
  });

  it('se a reescrita tambem vazar, sai sem as frases culpadas', async () => {
    const r = await falarComSofia('quero os 3', [
      { texto: 'Seu horário das 15:30 está marcado! O sistema indicou que os outros dados não constam.' },
      { texto: 'A Atena disse que não deu.' }
    ]);
    assert.equal(r.baloes.join(' '), 'Seu horário das 15:30 está marcado!');
  });

  it('**negrito** do Markdown sai como *negrito* do WhatsApp', async () => {
    // Preco do catalogo do seed: um valor fora dele cairia na trava de preco
    // inventado (alucinacao.test.js) e o teste deixaria de medir a formatacao.
    const r = await falarComSofia('quais serviços?', [
      { texto: '- **Corte Degradê**: *R$ 55,00*' }
    ]);
    assert.equal(r.baloes[0], '- *Corte Degradê*: *R$ 55,00*');
  });

  it('a Sofia sem resposta (repetiu o pedido) passa para uma pessoa, sem prometer retorno', async () => {
    const pedido = { nome: 'consultar_atena', argumentos: { pedido: 'horários de sexta para corte' } };
    const r = await falarComSofia('quero sexta', [
      { ferramentas: [pedido] }, // Sofia pede
      { texto: 'NÃO FEITO: falta o serviço.' }, // Atena relata
      { ferramentas: [pedido] } // Sofia pede DE NOVO a mesma coisa
    ]);

    assert.equal(r.respondidoPor, 'fallback_humano');
    assert.equal(r.transferido, true);
    assert.doesNotMatch(r.baloes.join(' '), /já te respondo|ja te respondo/i);
  });

  it('cliente irritado: a Sofia e avisada para resolver ou transferir, nao investigar', async () => {
    const r = await falarComSofia('Qual é a data aí que os três estão aí pra fazer esse trabalho, porra?', [{ texto: 'Já vejo!' }]);
    assert.match(r.chamadas[0].systemPrompt, /parece irritado/);

    const calmo = await falarComSofia('Quero agendar um corte', [{ texto: 'Claro!' }]);
    assert.doesNotMatch(calmo.chamadas[0].systemPrompt, /parece irritado/);
  });

  it('o prompt da Sofia nao carrega calendario, e manda repassar a data como o cliente falou', async () => {
    const r = await falarComSofia('oi', [{ texto: 'Oi!' }]);
    const prompt = r.chamadas[0].systemPrompt;
    assert.match(prompt, /Hoje é /);
    assert.doesNotMatch(prompt, /Amanha sera/);
    assert.match(prompt, /como o cliente\s+falou/);
    assert.match(prompt, /Nunca cite a Atena/);
  });
});

async function servicoPorNome(nome) {
  const { db } = await import('../src/db/client.js');
  const s = await import('../src/db/schema/index.js');
  const lista = await db.select().from(s.services);
  return lista.find((x) => x.nome === nome);
}
