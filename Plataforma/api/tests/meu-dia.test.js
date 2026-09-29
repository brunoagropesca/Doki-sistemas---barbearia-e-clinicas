import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { abrirACasa, criarAppDeTeste, entrar } from './helpers/ambiente.js';

/**
 * Login do profissional: ve SO os proprios atendimentos do dia e o painel de
 * cada um. Qualquer outra rota da API responde que ele nao tem acesso — a
 * regra e uma lista de permitidos no plugin de autenticacao, entao uma rota
 * nova ja nasce fechada para ele.
 */

let app;
let cab;
const ctx = {};

const hoje = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

async function marcar(profissional, lead, hora) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agenda',
    headers: cab,
    payload: {
      leadId: lead.id,
      serviceId: profissional.servicos[0].serviceId,
      professionalId: profissional.id,
      data: hoje(),
      hora,
      encaixe: true,
      permitirPassado: true
    }
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().agendamento;
}

describe('login do profissional', () => {
  before(async () => {
    ({ app } = await criarAppDeTeste());
    await abrirACasa();
    cab = (await entrar(app)).cabecalho;

    const { profissionais } = (await app.inject({ method: 'GET', url: '/api/profissionais', headers: cab })).json();
    const comServico = profissionais.filter((p) => p.servicos.length > 0);
    assert.ok(comServico.length >= 2, 'o seed precisa de dois profissionais com servico');
    [ctx.meu, ctx.outro] = comServico;

    const criado = await app.inject({ method: 'POST', url: '/api/leads', headers: cab, payload: { nome: 'Cliente Meu Dia', telefone: '11912398765' } });
    assert.equal(criado.statusCode, 201, criado.body);
    const lead = criado.json().lead;

    ctx.minha = await marcar(ctx.meu, lead, '10:00');
    ctx.doColega = await marcar(ctx.outro, lead, '10:00');
  });

  after(async () => {
    await app?.close();
  });

  describe('acesso do profissional', () => {
    it('a gerencia cria o login pela ficha, ja ligado ao profissional', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/profissionais/${ctx.meu.id}/acesso`,
        headers: cab,
        payload: { username: 'barbeiro.teste', senha: 'senha-forte-1' }
      });
      assert.equal(res.statusCode, 200, res.body);
      const p = res.json().profissional;
      assert.equal(p.acesso.username, 'barbeiro.teste');
      assert.ok(p.userId);

      // Nao aparece entre os atendentes (nem na fila, nem na transferencia).
      const { atendentes } = (await app.inject({ method: 'GET', url: '/api/atendentes', headers: cab })).json();
      assert.ok(!atendentes.some((a) => a.id === p.userId));
    });

    it('o cargo profissional nao pode ser criado solto pela tela de atendentes', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/usuarios',
        headers: cab,
        payload: { username: 'solto', senha: 'senha-forte-1', nome: 'Solto', cargo: 'profissional' }
      });
      assert.equal(res.statusCode, 400);
    });

    it('nao troca o vinculo do login pelo PATCH comum da ficha', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/profissionais/${ctx.meu.id}`,
        headers: cab,
        payload: { userId: null }
      });
      assert.equal(res.statusCode, 422);
    });
  });

  describe('a tela do profissional', () => {
    before(async () => {
      ctx.prof = (await entrar(app, 'barbeiro.teste', 'senha-forte-1')).cabecalho;
    });

    it('sabe quem ele e', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/eu', headers: ctx.prof });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().usuario.cargo, 'profissional');
    });

    it('lista so os atendimentos dele no dia', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/meu-dia?data=${hoje()}`, headers: ctx.prof });
      assert.equal(res.statusCode, 200, res.body);
      const { profissional, agendamentos } = res.json();
      assert.equal(profissional.id, ctx.meu.id);
      assert.deepEqual(
        agendamentos.map((a) => a.id),
        [ctx.minha.id]
      );
    });

    it('abre o painel do proprio atendimento, com o contexto do cliente', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/meu-dia/${ctx.minha.id}`, headers: ctx.prof });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().agendamento.leadNome, 'Cliente Meu Dia');
      assert.ok(res.json().agendamento.contexto?.cliente);
    });

    it('nao abre o atendimento de um colega (404, nao 403)', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/meu-dia/${ctx.doColega.id}`, headers: ctx.prof });
      assert.equal(res.statusCode, 404);
      const mudar = await app.inject({
        method: 'PATCH',
        url: `/api/meu-dia/${ctx.doColega.id}/status`,
        headers: ctx.prof,
        payload: { status: 'em_andamento' }
      });
      assert.equal(mudar.statusCode, 404);
    });

    it('inicia e conclui o proprio atendimento', async () => {
      for (const status of ['em_andamento', 'concluido']) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/api/meu-dia/${ctx.minha.id}/status`,
          headers: ctx.prof,
          payload: { status }
        });
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(res.json().agendamento.status, status);
      }
    });

    it('nao entra em nenhuma outra rota da API', async () => {
      const rotas = [
        ['GET', '/api/agenda'],
        ['GET', `/api/agenda/${ctx.minha.id}`],
        ['GET', '/api/leads'],
        ['GET', '/api/conversas'],
        ['GET', '/api/profissionais'],
        ['GET', '/api/funcoes'],
        ['GET', '/api/empresa'],
        ['GET', '/api/eventos'],
        ['PATCH', '/api/auth/presenca']
      ];
      for (const [method, url] of rotas) {
        const res = await app.inject({ method, url, headers: ctx.prof, payload: method === 'GET' ? undefined : {} });
        assert.equal(res.statusCode, 403, `${method} ${url} devia recusar (veio ${res.statusCode})`);
      }
    });
  });

  describe('tirar o acesso', () => {
    it('exclui o login e derruba a sessao aberta', async () => {
      const res = await app.inject({ method: 'DELETE', url: `/api/profissionais/${ctx.meu.id}/acesso`, headers: cab });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().profissional.acesso, null);
      assert.equal(res.json().profissional.userId, null);

      const depois = await app.inject({ method: 'GET', url: '/api/meu-dia', headers: ctx.prof });
      assert.equal(depois.statusCode, 401);
    });
  });
});
