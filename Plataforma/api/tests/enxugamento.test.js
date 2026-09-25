import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { pareceReclamacao } from '../src/ai/saida.js';

/**
 * Prompt da Sofia mais enxuto, sem ela saber menos.
 *
 *   1. Base de conhecimento: o essencial (endereco, contato, horario,
 *      pagamento) vai em toda mensagem; regras da casa, perguntas frequentes e
 *      extras ela le por `consultar_informacoes` quando o cliente pergunta.
 *   2. O roteiro de reclamacao/irritacao (regras 9 e 10) so entra quando ha
 *      sinal disso nas ultimas mensagens; sem sinal, fica a versao de 1 linha.
 *   3. Descricoes das ferramentas mais curtas (medido abaixo).
 *
 * O modelo e um duble que segue um roteiro; o resto e o sistema de verdade.
 * Textos proprios ("Lim-Enx ...") para nao depender de outros arquivos.
 */

let app;
let cab;
let tenantId;
let responder;

const FAQ_RESPOSTA = 'Temos Wi-Fi Enx-Rede-7 liberado para clientes.';
const REGRA = 'Tolerância Enx de 12 minutos de atraso.';

function provedorFalso(roteiro) {
  const chamadas = [];
  let i = 0;
  const impl = {
    nome: 'falso',
    async gerar({ modelo, systemPrompt, ferramentas, mensagens }) {
      chamadas.push({ systemPrompt, ferramentas: (ferramentas ?? []).map((f) => f.nome), mensagens });
      const passo = roteiro[Math.min(i++, roteiro.length - 1)];
      return { texto: passo.texto ?? '', chamadasDeFerramenta: passo.ferramentas ?? [], tokens: { entrada: 5, saida: 5 }, modelo };
    }
  };
  return { provedores: [{ impl, apiKey: 'x', modelos: ['m'] }], chamadas };
}

const perguntar = async (texto, roteiro, extra = {}) => {
  const falso = provedorFalso(roteiro);
  const r = await responder({
    tenantId, conversationId: null, leadId: null, leadNome: 'Cliente Enx',
    texto, simulacao: true, modoOverride: 'ia', provedores: falso.provedores, ...extra
  });
  return { r, chamadas: falso.chamadas, texto: r.baloes.join('\n') };
};

const salvarBase = (payload) => app.inject({ method: 'PUT', url: '/api/empresa', headers: cab, payload });

before(async () => {
  ({ app } = await criarAppDeTeste());
  const dono = await entrar(app);
  cab = dono.cabecalho;
  tenantId = dono.usuario.tenantId;
  ({ responder } = await import('../src/modules/atendimento/atendimento.service.js'));

  const r = await salvarBase({
    endereco: { logradouro: 'Rua Enx, 77', bairro: 'Centro', cidade: 'Manaus', referencia: '', mapaUrl: '', estacionamento: '' },
    politicas: REGRA,
    faq: [{ pergunta: 'Tem Wi-Fi?', resposta: FAQ_RESPOSTA }],
    extras: 'Estacionamento Enx conveniado custa R$ 7,00 a hora.'
  });
  assert.equal(r.statusCode, 200, r.body);
});

after(async () => {
  await app?.close();
});

describe('base de conhecimento sob demanda', () => {
  it('a previa separa o que vai sempre do que ela consulta', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/empresa/texto-ia', headers: cab });
    const { texto, detalhes } = r.json();
    assert.match(texto, /Endereço: Rua Enx, 77/);
    assert.doesNotMatch(texto, /Enx-Rede-7|Tolerância Enx/);
    assert.match(detalhes, /Tolerância Enx de 12 minutos/);
    assert.match(detalhes, /P: Tem Wi-Fi\?/);
    assert.match(detalhes, /Outras informações: Estacionamento Enx/);
  });

  it('o prompt leva so o essencial e manda consultar o resto', async () => {
    const { chamadas } = await perguntar('onde fica?', [{ texto: 'Ficamos na Rua Enx, 77, no Centro.' }]);
    const prompt = chamadas[0].systemPrompt;
    assert.match(prompt, /Rua Enx, 77/);
    assert.doesNotMatch(prompt, /Enx-Rede-7/, 'FAQ fora do prompt');
    assert.doesNotMatch(prompt, /Tolerância Enx/, 'regras da casa fora do prompt');
    assert.match(prompt, /use consultar_informacoes/);
    assert.ok(chamadas[0].ferramentas.includes('consultar_informacoes'));
  });

  it('perguntou do Wi-Fi: ela consulta e responde com o dado oficial', async () => {
    const { texto, chamadas, r } = await perguntar('tem wifi ai?', [
      { ferramentas: [{ nome: 'consultar_informacoes', argumentos: { assunto: 'wifi' } }] },
      { texto: 'Temos sim! A rede é Enx-Rede-7, liberada para clientes.' }
    ]);
    assert.match(texto, /Enx-Rede-7/);
    // O resultado da consulta volta para o modelo na segunda chamada.
    assert.match(JSON.stringify(chamadas[1].mensagens), /Enx-Rede-7/);
    assert.deepEqual(r.detalhes.consultas.map((c) => c.nome), ['consultar_informacoes']);
  });

  it('valor em R$ que so existe nos detalhes passa na trava de preco (e oficial)', async () => {
    const { texto, chamadas } = await perguntar('quanto e o estacionamento?', [
      { ferramentas: [{ nome: 'consultar_informacoes', argumentos: {} }] },
      { texto: 'O estacionamento conveniado custa R$ 7,00 a hora.' }
    ]);
    assert.match(texto, /R\$ 7,00/);
    assert.equal(chamadas.length, 2, 'sem reescrita da trava de preco');
  });

  it('com a Atena desligada a consulta de informacoes continua disponivel', async () => {
    const { obterAgente, salvarAgente } = await import('../src/modules/ia/ia.service.js');
    const antes = await obterAgente(tenantId, 'atena');
    await salvarAgente(tenantId, 'atena', { ativo: false, ferramentas: antes.ferramentas });
    try {
      const { chamadas } = await perguntar('tem wifi?', [{ texto: 'Vou verificar para você.' }]);
      assert.deepEqual(chamadas[0].ferramentas.sort(), ['consultar_informacoes', 'transferir_para_humano']);
    } finally {
      await salvarAgente(tenantId, 'atena', { ativo: true, ferramentas: antes.ferramentas });
    }
  });

  it('sem regras, FAQ nem extras: nenhuma ferramenta nem instrucao a mais', async () => {
    const r = await salvarBase({ politicas: '', faq: [], extras: '' });
    assert.equal(r.statusCode, 200, r.body);
    try {
      const { chamadas } = await perguntar('onde fica?', [{ texto: 'Na Rua Enx, 77.' }]);
      assert.ok(!chamadas[0].ferramentas.includes('consultar_informacoes'));
      assert.doesNotMatch(chamadas[0].systemPrompt, /consultar_informacoes/);
      assert.match(chamadas[0].systemPrompt, /Rua Enx, 77/);
    } finally {
      await salvarBase({ politicas: REGRA, faq: [{ pergunta: 'Tem Wi-Fi?', resposta: FAQ_RESPOSTA }], extras: 'Estacionamento Enx conveniado custa R$ 7,00 a hora.' });
    }
  });
});

describe('roteiro de reclamacao so quando ha sinal', () => {
  const COMPLETO = /UMA pergunta por mensagem/;

  it('le os sinais comuns de reclamacao (puro)', () => {
    for (const t of ['o corte ficou torto', 'quero fazer uma reclamação', 'fui mal atendido ontem', 'cobraram a mais no cartão', 'quero reembolso'])
      assert.ok(pareceReclamacao(t), t);
    for (const t of ['quero cortar amanha', 'quanto fica a barba?', 'ficou ótimo, obrigado'])
      assert.ok(!pareceReclamacao(t), t);
  });

  it('mensagem comum: so a versao curta (acolher e transferir)', async () => {
    const { chamadas } = await perguntar('quero marcar um corte', [{ texto: 'Claro! Para qual dia?' }]);
    const prompt = chamadas[0].systemPrompt;
    assert.doesNotMatch(prompt, COMPLETO);
    assert.match(prompt, /Reclamação ou irritação: acolha, não prometa nada/);
  });

  it('reclamacao agora: roteiro completo', async () => {
    const { chamadas } = await perguntar('o corte de ontem ficou torto', [{ texto: 'Poxa, sinto muito! O que aconteceu?' }]);
    assert.match(chamadas[0].systemPrompt, COMPLETO);
  });

  it('reclamacao nas mensagens anteriores: o roteiro continua ("foi com o Carlos")', async () => {
    const historico = [
      { papel: 'user', conteudo: 'fui mal atendido ontem' },
      { papel: 'assistant', conteudo: 'Sinto muito! Com qual profissional foi?' }
    ];
    const { chamadas } = await perguntar('foi com o Carlos', [{ texto: 'Obrigada por contar.' }], { historico });
    assert.match(chamadas[0].systemPrompt, COMPLETO);
  });

  it('irritacao: roteiro completo e o aviso da regra 10', async () => {
    const { chamadas } = await perguntar('que palhaçada, ninguém responde???', [{ texto: 'Desculpe a demora!' }]);
    assert.match(chamadas[0].systemPrompt, COMPLETO);
    assert.match(chamadas[0].systemPrompt, /parece irritado/);
  });
});

describe('tamanho', () => {
  it('prompt + ferramentas de uma mensagem comum cabem no novo teto', async () => {
    const { chamadas } = await perguntar('quero marcar um corte', [{ texto: 'Claro! Para qual dia?' }]);
    const { ferramentasDaSofia } = await import('../src/ai/tools/sofia.tools.js');
    const { GRUPOS_ATENA } = await import('../src/ai/agentes-padrao.js');
    const defs = ferramentasDaSofia({ tenantId, fuso: 'America/Manaus', leadId: 'x', gruposAtena: Object.keys(GRUPOS_ATENA), informacoes: 'x' })
      // As 6 que ja existiam (a nova, consultar_informacoes, e o preco da base sob demanda).
      .filter((f) => f.nome !== 'consultar_informacoes')
      .map((f) => JSON.stringify({ nome: f.nome, descricao: f.descricao, parametros: f.parametros }))
      .join('');
    // Antes: ~7.200 caracteres de prompt com a base cheia e 3.141 de ferramentas.
    assert.ok(defs.length < 2600, `ferramentas: ${defs.length} caracteres`);
    assert.ok(chamadas[0].systemPrompt.length < 5200, `prompt: ${chamadas[0].systemPrompt.length} caracteres`);
  });
});

// ============================================================================
// OS RISCOS DO ENXUGAMENTO, COBERTOS EM CODIGO
// ============================================================================

describe('risco 1: tema da base sem consultar', () => {
  const BLOCO = /INFORMAÇÕES OFICIAIS LIGADAS A ESTA MENSAGEM/;

  it('o indice das perguntas cadastradas vai no prompt (ela sabe que a resposta existe)', async () => {
    const { chamadas } = await perguntar('oi', [{ texto: 'Oi! Como posso ajudar?' }]);
    assert.match(chamadas[0].systemPrompt, /perguntas frequentes: Tem Wi-Fi\?/);
    assert.doesNotMatch(chamadas[0].systemPrompt, /Enx-Rede-7/);
  });

  it('"tem internet?": o codigo ja coloca a resposta oficial no prompt, sem depender de consultar', async () => {
    const { chamadas } = await perguntar('vcs tem internet ai?', [{ texto: 'Temos sim, a rede é Enx-Rede-7.' }]);
    assert.match(chamadas[0].systemPrompt, BLOCO);
    assert.match(chamadas[0].systemPrompt, /Enx-Rede-7/);
    assert.equal(chamadas.length, 1, 'ja tinha lido: sem revisao');
  });

  it('mensagem sem tema da base: nenhum bloco a mais no prompt', async () => {
    const { chamadas } = await perguntar('quero marcar um corte', [{ texto: 'Claro! Para qual dia?' }]);
    assert.doesNotMatch(chamadas[0].systemPrompt, BLOCO);
  });

  it('falou de Wi-Fi sem ter lido: a resposta e revisada com a informacao oficial', async () => {
    const { texto, chamadas, r } = await perguntar('tem algo pra fazer enquanto espero?', [
      { texto: 'Temos wifi liberado, a senha é 1234!' },
      { texto: 'Temos Wi-Fi liberado: a rede é Enx-Rede-7.' }
    ]);
    assert.equal(chamadas.length, 2, 'uma revisao');
    assert.match(chamadas[1].systemPrompt, /INFORMAÇÕES OFICIAIS:[\s\S]*Enx-Rede-7/);
    assert.match(texto, /Enx-Rede-7/);
    assert.doesNotMatch(texto, /1234/);
    assert.equal(r.detalhes.revisouComBase, 1);
  });

  it('consultou a base: falar do tema nao dispara revisao', async () => {
    const { chamadas } = await perguntar('tem algo pra fazer enquanto espero?', [
      { ferramentas: [{ nome: 'consultar_informacoes', argumentos: {} }] },
      { texto: 'Temos Wi-Fi liberado, a rede é Enx-Rede-7.' }
    ]);
    assert.equal(chamadas.length, 2, 'consulta + resposta, sem revisao');
  });
});

describe('risco 2: reclamacao sem palavra da lista', () => {
  const COMPLETO = /UMA pergunta por mensagem/;
  let telefone = 5592900077000;

  it('frases novas de reclamacao; "cabelo grosso" nao e reclamacao (puro)', async () => {
    const { pediuDesculpas } = await import('../src/ai/saida.js');
    for (const t of ['o barbeiro foi grosso comigo', 'esperei mais de uma hora', 'nunca mais volto', 'não ficou como eu pedi', 'deu problema no meu corte'])
      assert.ok(pareceReclamacao(t), t);
    for (const t of ['meu cabelo é grosso, dá pra fazer degradê?', 'esperei a mensagem de vocês'])
      assert.ok(!pareceReclamacao(t), t);
    assert.ok(pediuDesculpas('Poxa, sinto muito pelo que aconteceu!'));
    assert.ok(!pediuDesculpas('Claro! Para qual dia?'));
  });

  it('a Sofia pediu desculpas na troca anterior: o roteiro completo continua', async () => {
    const historico = [
      { papel: 'user', conteudo: 'o corte de sabado nao era o que eu queria' },
      { papel: 'assistant', conteudo: 'Poxa, sinto muito! Me conta o que aconteceu?' }
    ];
    const { chamadas } = await perguntar('pedi baixo dos lados e veio alto', [{ texto: 'Entendi.' }], { historico });
    assert.match(chamadas[0].systemPrompt, COMPLETO);
  });

  it('a leitura de humor marcou a conversa como frustrada: roteiro completo', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    telefone += 1;
    const lead = await leads.encontrarOuCriarPorTelefone(tenantId, String(telefone), 'Cliente Enx Humor');
    const conversationId = await conversas.encontrarOuAbrir(tenantId, { leadId: lead.id });

    const calmo = await perguntar('pode ser sabado', [{ texto: 'Certo!' }], { conversationId, leadId: lead.id });
    assert.doesNotMatch(calmo.chamadas[0].systemPrompt, COMPLETO, 'sem sinal ainda');

    await conversas.registrarHumor(tenantId, conversationId, { humor: 'frustrado', resumo: 'insatisfeito com o corte', numeroDaMensagem: 1 });
    const frustrado = await perguntar('pode ser sabado', [{ texto: 'Certo!' }], { conversationId, leadId: lead.id });
    assert.match(frustrado.chamadas[0].systemPrompt, COMPLETO);
  });
});
