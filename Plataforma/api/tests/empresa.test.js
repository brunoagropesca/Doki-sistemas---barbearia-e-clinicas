import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

/**
 * Base de conhecimento da empresa: o que a empresa cadastra (endereco, Pix,
 * horario, regras) e o que a Sofia passa a saber a partir disso.
 */

let app;
let cabDono;
let cabRecepcao;
let tenantId;

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

before(async () => {
  ({ app } = await criarAppDeTeste());
  const dono = await entrar(app);
  cabDono = dono.cabecalho;
  tenantId = dono.usuario.tenantId;
  ({ cabecalho: cabRecepcao } = await entrar(app, 'recepcao'));
});

after(async () => {
  await app?.close();
});

const chamar = (method, url, cab, payload) => app.inject({ method, url, headers: cab, payload });

describe('base de conhecimento', () => {
  it('sem nada cadastrado, vem o documento vazio (todos os campos existem)', async () => {
    const r = await chamar('GET', '/api/empresa', cabRecepcao);
    assert.equal(r.statusCode, 200, r.body);
    const e = r.json().empresa;
    assert.ok(e.nome);
    assert.equal(e.logo, null);
    assert.deepEqual(e.faq, []);
    assert.equal(e.pagamento.pix.chave, '');
  });

  it('o dono salva nome, endereco, Pix e horario; so o que veio muda', async () => {
    const r = await chamar('PUT', '/api/empresa', cabDono, {
      nome: 'Barbearia do Zé',
      endereco: { logradouro: 'Rua das Flores, 45', bairro: 'Centro', cidade: 'Campinas', referencia: '', mapaUrl: '', estacionamento: '' },
      pagamento: { pix: { tipo: 'cnpj', chave: '12.345.678/0001-90', titular: 'Zé Barbearia LTDA', banco: '' }, formas: ['Pix', 'Cartão'], observacao: '' },
      horario: { dias: { 1: [{ inicio: '09:00', fim: '19:00' }], 6: [{ inicio: '08:00', fim: '14:00' }] }, observacao: '' }
    });
    assert.equal(r.statusCode, 200, r.body);
    const e = r.json().empresa;
    assert.equal(e.nome, 'Barbearia do Zé');
    assert.equal(e.endereco.bairro, 'Centro');

    // Segunda gravacao, so com o "sobre": o resto continua la.
    const r2 = await chamar('PUT', '/api/empresa', cabDono, { sobre: 'Barbearia clássica desde 2010.' });
    assert.equal(r2.json().empresa.pagamento.pix.chave, '12.345.678/0001-90');
    assert.equal(r2.json().empresa.sobre, 'Barbearia clássica desde 2010.');
  });

  it('o nome novo vale para o sistema inteiro (e o que a IA chama de "empresa")', async () => {
    const { db } = await import('../src/db/client.js');
    const { tenants } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    assert.equal(t.nome, 'Barbearia do Zé');
  });

  it('atendente le, mas nao altera', async () => {
    const r = await chamar('PUT', '/api/empresa', cabRecepcao, { sobre: 'x' });
    assert.equal(r.statusCode, 403);
  });

  it('recusa hora fora do formato e campo desconhecido', async () => {
    const r1 = await chamar('PUT', '/api/empresa', cabDono, { horario: { dias: { 1: [{ inicio: '9h', fim: '18:00' }] }, observacao: '' } });
    assert.equal(r1.statusCode, 400);
    const r2 = await chamar('PUT', '/api/empresa', cabDono, { senhaDoWifi: '123' });
    assert.equal(r2.statusCode, 400);
  });

  it('logo: envia, troca (a antiga some do disco) e remove', async () => {
    const r1 = await chamar('PUT', '/api/empresa', cabDono, { logoArquivo: PNG });
    const logo1 = r1.json().empresa.logo;
    assert.match(logo1, /^\/api\/arquivos\/logo-/);
    assert.equal((await app.inject({ method: 'GET', url: logo1, headers: cabDono })).statusCode, 200);

    const r2 = await chamar('PUT', '/api/empresa', cabDono, { logoArquivo: PNG });
    assert.notEqual(r2.json().empresa.logo, logo1);
    assert.equal((await app.inject({ method: 'GET', url: logo1, headers: cabDono })).statusCode, 404);

    const r3 = await chamar('PUT', '/api/empresa', cabDono, { removerLogo: true });
    assert.equal(r3.json().empresa.logo, null);
  });
});

describe('o que a Sofia sabe', () => {
  it('o texto para a IA traz so o que foi preenchido, com o horario dia a dia', async () => {
    const r = await chamar('GET', '/api/empresa/texto-ia', cabDono);
    const t = r.json().texto;
    assert.match(t, /Endereço: Rua das Flores, 45, Centro, Campinas/);
    assert.match(t, /Pix: CNPJ 12\.345\.678\/0001-90 \(em nome de Zé Barbearia LTDA\)/);
    assert.match(t, /Segunda: 09:00 às 19:00/);
    assert.match(t, /Domingo: fechado/);
    assert.doesNotMatch(t, /Instagram/, 'campo vazio nao entra no prompt');
  });

  it('a base entra no prompt da Sofia; sem base, o bloco nao aparece', async () => {
    const { montarSystemPrompt } = await import('../src/modules/atendimento/atendimento.service.js');
    const comum = { agente: {}, nomeEmpresa: 'X', fuso: 'America/Sao_Paulo', hoje: '2026-09-24', horaAtual: '10:00', atenaAtiva: true };

    const com = montarSystemPrompt({ ...comum, baseConhecimento: '- Pix: CNPJ 123' });
    assert.match(com, /BASE DE CONHECIMENTO/);
    assert.match(com, /Pix: CNPJ 123/);
    // Fica antes do CONTEXTO (a parte que muda a cada mensagem).
    assert.ok(com.indexOf('BASE DE CONHECIMENTO') < com.indexOf('CONTEXTO:'));

    assert.doesNotMatch(montarSystemPrompt({ ...comum, baseConhecimento: '' }), /BASE DE CONHECIMENTO/);
  });
});
