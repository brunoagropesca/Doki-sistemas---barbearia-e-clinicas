import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste } from './helpers/ambiente.js';
import { precosEmReais, precosNaoVerificados, precosPermitidos } from '../src/ai/saida.js';

/**
 * A Sofia nao pode inventar servico nem preco.
 *
 * Caso real: com ZERO servicos cadastrados, ela respondeu uma tabela inteira
 * ("Corte Masculino: R$ 45,00 / Barba: R$ 35,00..."). Duas camadas:
 *   1. o prompt DIZ que o catalogo esta vazio (antes, a regra "use o CATALOGO
 *      abaixo" apontava para o nada);
 *   2. uma trava em codigo: todo "R$" da resposta precisa existir no catalogo
 *      (ou numa consulta do turno). Nao existe: reescreve uma vez; insistiu,
 *      a resposta nao sai e uma pessoa assume.
 * O modelo e um dublê que segue um roteiro; o resto e o sistema de verdade.
 */

let app;
let tenantId;
let responder;

function provedorFalso(roteiro) {
  const chamadas = [];
  let i = 0;
  const impl = {
    nome: 'falso',
    async gerar({ modelo, systemPrompt }) {
      chamadas.push({ systemPrompt });
      const passo = roteiro[Math.min(i++, roteiro.length - 1)];
      return { texto: passo.texto ?? '', chamadasDeFerramenta: passo.ferramentas ?? [], tokens: { entrada: 5, saida: 5 }, modelo };
    }
  };
  return { provedores: [{ impl, apiKey: 'x', modelos: ['m'] }], chamadas };
}

const perguntar = async (texto, roteiro) => {
  const falso = provedorFalso(roteiro);
  const r = await responder({
    tenantId, conversationId: null, leadId: null, leadNome: 'Cliente Teste',
    texto, simulacao: true, modoOverride: 'ia', provedores: falso.provedores
  });
  return { r, chamadas: falso.chamadas, texto: r.baloes.join('\n') };
};

before(async () => {
  ({ app } = await criarAppDeTeste());
  const { db } = await import('../src/db/client.js');
  const s = await import('../src/db/schema/index.js');
  [{ id: tenantId }] = await db.select().from(s.tenants);
  ({ responder } = await import('../src/modules/atendimento/atendimento.service.js'));
});

after(async () => {
  await app?.close();
});

describe('leitura de precos (pura)', () => {
  it('le os formatos comuns de R$', () => {
    assert.deepEqual(precosEmReais('R$ 45,00, R$45 e R$ 1.234,56 · R$ 30,5'), [4500, 4500, 123456, 3050]);
    assert.deepEqual(precosEmReais('sem preco nenhum, 45 reais'), []);
  });

  it('permitidos: catalogo, somas de ate 3 itens e valores de textos verificados', () => {
    const p = precosPermitidos([4500, 4000], ['{"preco":"R$ 12,00"}']);
    for (const v of [4500, 4000, 8500, 9000, 13000, 1200]) assert.ok(p.has(v), String(v));
    assert.deepEqual(precosNaoVerificados('Sai R$ 85,00 e a taxa R$ 7,00', p), [700]);
  });
});

describe('com catalogo', () => {
  it('preco do catalogo passa direto (sem chamada extra)', async () => {
    const { texto, chamadas } = await perguntar('quanto e o corte social?', [{ texto: 'O Corte Social sai por R$ 45,00.' }]);
    assert.match(texto, /R\$ 45,00/);
    assert.equal(chamadas.length, 1);
  });

  it('soma de servicos do catalogo tambem passa (corte + barba)', async () => {
    const { texto } = await perguntar('corte social e barba terapia juntos?', [{ texto: 'Os dois juntos ficam R$ 85,00.' }]);
    assert.match(texto, /R\$ 85,00/);
  });

  it('preco inventado: a resposta e reescrita sem ele', async () => {
    const { texto, chamadas } = await perguntar('tem pigmentacao?', [
      { texto: 'Temos sim! A Pigmentação sai por R$ 30,00.' },
      { texto: 'Esse serviço e o valor a equipe confirma para você. Quer que eu chame um atendente?' }
    ]);
    assert.doesNotMatch(texto, /R\$/);
    assert.equal(chamadas.length, 2, 'uma reescrita');
    assert.match(chamadas[1].systemPrompt, /NÃO existem no catálogo/);
  });

  it('insistiu no preco inventado: a resposta NAO sai e uma pessoa assume', async () => {
    const { r, texto } = await perguntar('tem pigmentacao?', [
      { texto: 'A Pigmentação sai por R$ 30,00.' },
      { texto: 'Pigmentação: R$ 30,00.' }
    ]);
    assert.equal(r.transferido, true);
    assert.equal(r.respondidoPor, 'fallback_humano');
    assert.equal(r.detalhes.motivo, 'preco_nao_verificado');
    assert.doesNotMatch(texto, /30,00/);
  });

  it('preco dito pelo CLIENTE nao vira preco confirmado', async () => {
    const { texto } = await perguntar('o corte social e R$ 10, ne?', [
      { texto: 'Isso, o Corte Social é R$ 10,00!' },
      { texto: 'O Corte Social sai por R$ 45,00.' }
    ]);
    assert.doesNotMatch(texto, /R\$ 10/);
  });
});

describe('sem nenhum servico cadastrado (o caso real)', () => {
  before(async () => {
    const { db } = await import('../src/db/client.js');
    const s = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    await db.update(s.services).set({ ativo: false }).where(eq(s.services.tenantId, tenantId));
    (await import('../src/ai/tools/catalogo-cache.js')).invalidarCatalogo(tenantId);
  });

  it('o prompt diz que nao ha servicos, e a tabela inventada nao chega ao cliente', async () => {
    const { texto, chamadas } = await perguntar('quais os servicos que tem?', [
      { texto: 'Temos vários! • Corte Masculino: R$ 45,00 • Barba: R$ 35,00 • Pezinho: R$ 20,00' },
      { texto: 'Os serviços e valores a nossa equipe te passa. Quer que eu chame um atendente?' }
    ]);
    assert.match(chamadas[0].systemPrompt, /NENHUM serviço cadastrado ainda/);
    assert.doesNotMatch(chamadas[0].systemPrompt, /CATALOGO \(dados verificados/);
    assert.doesNotMatch(texto, /R\$/);
  });
});
