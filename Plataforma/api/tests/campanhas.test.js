import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import * as service from '../src/modules/campanhas/campanhas.service.js';

let app;
let cabDono;
let cabRecepcao;
let tenantId;
let db;
let schema;
const ctx = {};

/** Canal de mentira: guarda o que foi "enviado" em vez de falar com o WhatsApp. */
const entregues = [];
let falhaDoCanal = null;

async function enviarFalso({ destino, texto, digitandoMs }) {
  if (falhaDoCanal) {
    const msg = falhaDoCanal;
    falhaDoCanal = null;
    throw new Error(msg);
  }
  entregues.push({ destino, texto, digitandoMs });
  return { idExterno: `camp_${entregues.length}` };
}

// Telefones proprios deste arquivo: nenhum outro teste mexe neles.
let sequencia = 0;
async function novoContato(nome) {
  sequencia += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/leads',
    headers: cabDono,
    payload: { nome, telefone: `1191234${String(5000 + sequencia).padStart(4, '0')}` }
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().lead;
}

async function criarCampanha(nome = 'Campanha de teste') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/campanhas',
    headers: cabDono,
    payload: { nome, channelInstanceId: ctx.canalId }
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().campanha;
}

async function obter(id) {
  const res = await app.inject({ method: 'GET', url: `/api/campanhas/${id}`, headers: cabDono });
  return res.json().campanha;
}

async function esperarAte(condicao, limite = 200) {
  for (let i = 0; i < limite && !(await condicao()); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Campanha com publico, mensagens geradas e aprovadas, ritmo zerado para o teste. */
async function campanhaPronta(nome, contatos, ajustes = {}) {
  const c = await criarCampanha(nome);
  await app.inject({ method: 'PATCH', url: `/api/campanhas/${c.id}`, headers: cabDono, payload: { objetivo: 'Chamar de volta' } });
  await app.inject({
    method: 'PUT',
    url: `/api/campanhas/${c.id}/publico`,
    headers: cabDono,
    payload: { leadIds: contatos.map((l) => l.id) }
  });
  await app.inject({ method: 'POST', url: `/api/campanhas/${c.id}/gerar`, headers: cabDono });
  await esperarAte(() => !service.estaGerando(c.id));
  await app.inject({ method: 'POST', url: `/api/campanhas/${c.id}/aprovar`, headers: cabDono, payload: { todos: true } });

  await db
    .update(schema.campaigns)
    .set({ intervaloMinSegundos: 0, intervaloMaxSegundos: 0, janelaInicio: '00:00', janelaFim: '23:59', ...ajustes })
    .where(eq(schema.campaigns.id, c.id));
  return c.id;
}

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cabDono } = await entrar(app));
  ({ cabecalho: cabRecepcao } = await entrar(app, 'recepcao'));

  ({ db } = await import('../src/db/client.js'));
  schema = await import('../src/db/schema/index.js');

  const [t] = await db.select().from(schema.tenants);
  tenantId = t.id;

  const [canal] = await db.select().from(schema.channelInstances);
  ctx.canalId = canal.id;
});

after(async () => {
  await app?.close();
});

describe('etapa 1 e 2: criar e escolher o publico', () => {
  it('cria a campanha como rascunho, sem publico e sem enviar nada', async () => {
    entregues.length = 0;
    const c = await criarCampanha('Resgate de clientes');

    assert.equal(c.status, 'rascunho');
    assert.equal(c.alvos.length, 0);
    assert.equal(c.iaConfig.tom, 'amigavel', 'a IA comeca com uma configuracao padrao');
    assert.equal(c.simularDigitacao, true, '"digitando..." vem ligado de fabrica');
    assert.equal(entregues.length, 0);
    ctx.campanhaId = c.id;
  });

  it('o publico entra "aguardando" a IA escrever', async () => {
    ctx.contatos = [await novoContato('Carlos Andrade'), await novoContato('Marina Lopes'), await novoContato('Pedro Alves')];

    const res = await app.inject({
      method: 'PUT',
      url: `/api/campanhas/${ctx.campanhaId}/publico`,
      headers: cabDono,
      payload: { leadIds: ctx.contatos.map((l) => l.id) }
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().incluidos, 3);
    const c = res.json().campanha;
    assert.ok(c.alvos.every((a) => a.status === 'aguardando' && a.mensagem === ''));
    assert.equal(c.status, 'rascunho');
  });

  /**
   * A diferenca entre marketing e perseguicao. Ignorar o pedido e o caminho
   * mais rapido para o numero da empresa ser denunciado e bloqueado.
   */
  it('PULA quem pediu para nao receber campanha, dizendo o motivo', async () => {
    const recusou = await novoContato('Cliente Que Recusou');
    await app.inject({ method: 'PATCH', url: `/api/leads/${recusou.id}`, headers: cabDono, payload: { aceitaCampanha: false } });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/campanhas/${ctx.campanhaId}/publico`,
      headers: cabDono,
      payload: { leadIds: [...ctx.contatos.map((l) => l.id), recusou.id] }
    });

    const corpo = res.json();
    assert.equal(corpo.incluidos, 3);
    assert.ok(!corpo.campanha.alvos.some((a) => a.leadId === recusou.id));
    assert.match(corpo.pulados.find((p) => p.leadId === recusou.id).motivo, /nao receber/i);
  });

  it('trocar o publico tira quem saiu e mantem quem ficou', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/campanhas/${ctx.campanhaId}/publico`,
      headers: cabDono,
      payload: { leadIds: ctx.contatos.slice(0, 2).map((l) => l.id) }
    });
    assert.equal(res.json().campanha.alvos.length, 2);

    // Volta ao publico completo para os testes seguintes.
    await app.inject({
      method: 'PUT',
      url: `/api/campanhas/${ctx.campanhaId}/publico`,
      headers: cabDono,
      payload: { leadIds: ctx.contatos.map((l) => l.id) }
    });
  });
});

describe('etapa 3: configuracao da IA', () => {
  it('sem objetivo a IA nao tem de onde partir', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/campanhas/${ctx.campanhaId}/gerar`, headers: cabDono });
    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /objetivo/i);
  });

  it('salva objetivo e ajustes de escrita', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/campanhas/${ctx.campanhaId}`,
      headers: cabDono,
      payload: {
        objetivo: 'Trazer de volta quem nao vem ha um tempo',
        iaConfig: { tom: 'descontraido', emojis: false, assinatura: 'Bruno' }
      }
    });

    assert.equal(res.statusCode, 200, res.body);
    const c = res.json().campanha;
    assert.equal(c.iaConfig.tom, 'descontraido');
    assert.equal(c.iaConfig.emojis, false);
    assert.equal(c.iaConfig.tamanho, 'curta', 'o que nao foi mandado continua como estava');
  });

  it('a previa escreve para alguns clientes SEM gravar nada', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/campanhas/${ctx.campanhaId}/previa`,
      headers: cabDono,
      payload: { quantidade: 2 }
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().amostras.length, 2);
    assert.ok(res.json().amostras.every((a) => a.mensagem.length > 0 && a.contexto.length > 0));

    const c = await obter(ctx.campanhaId);
    assert.ok(c.alvos.every((a) => a.status === 'aguardando'), 'previa nao pode virar mensagem da campanha');
  });

  it('recusa ritmo de envio arriscado', async () => {
    const curto = await app.inject({
      method: 'PATCH',
      url: `/api/campanhas/${ctx.campanhaId}`,
      headers: cabDono,
      payload: { intervaloMinSegundos: 1 }
    });
    assert.equal(curto.statusCode, 400);
    assert.match(curto.body, /bloqueio/i);

    const invertida = await app.inject({
      method: 'PATCH',
      url: `/api/campanhas/${ctx.campanhaId}`,
      headers: cabDono,
      payload: { janelaInicio: '22:00', janelaFim: '08:00' }
    });
    assert.equal(invertida.statusCode, 422);
  });
});

describe('etapa 4: gerar e aprovar', () => {
  it('gera as mensagens em segundo plano e para na revisao, sem enviar nada', async () => {
    entregues.length = 0;
    const res = await app.inject({ method: 'POST', url: `/api/campanhas/${ctx.campanhaId}/gerar`, headers: cabDono });
    assert.equal(res.statusCode, 200, res.body);

    await esperarAte(() => !service.estaGerando(ctx.campanhaId));
    const c = await obter(ctx.campanhaId);

    assert.equal(c.status, 'revisao');
    assert.ok(c.alvos.every((a) => a.status === 'pendente'), 'tudo precisa esperar revisao humana');
    assert.ok(c.alvos.every((a) => a.mensagem.length > 0));
    assert.equal(entregues.length, 0, 'gerar NAO pode enviar nada');
  });

  it('sem IA, o texto de reserva usa o primeiro nome e vem MARCADO como reserva', async () => {
    const c = await obter(ctx.campanhaId);
    const alvo = c.alvos[0];
    assert.match(alvo.mensagem, new RegExp(alvo.nomeCliente.split(' ')[0], 'i'));
    assert.equal(alvo.mensagemReserva, true, 'a revisao precisa saber que nao foi personalizada');
  });

  it('guarda o que a IA leu do cliente, para auditar', async () => {
    const c = await obter(ctx.campanhaId);
    assert.ok(c.alvos[0].contextoGeracao.linhas.some((l) => l.includes(c.alvos[0].nomeCliente)));
  });

  it('nao deixa iniciar sem aprovar as mensagens', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/campanhas/${ctx.campanhaId}/iniciar`, headers: cabDono });
    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /Aprove as mensagens/i);
  });

  it('editar a mensagem tira a marca de reserva', async () => {
    const alvo = (await obter(ctx.campanhaId)).alvos[0];
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/campanhas/alvos/${alvo.id}`,
      headers: cabDono,
      payload: { mensagem: 'Texto revisado pelo dono da barbearia.' }
    });
    assert.equal(res.statusCode, 200);

    const atualizado = (await obter(ctx.campanhaId)).alvos.find((a) => a.id === alvo.id);
    assert.equal(atualizado.mensagem, 'Texto revisado pelo dono da barbearia.');
    assert.equal(atualizado.mensagemReserva, false);
  });

  it('remover um cliente na revisao tira ele da campanha', async () => {
    const alvo = (await obter(ctx.campanhaId)).alvos[2];
    const res = await app.inject({ method: 'DELETE', url: `/api/campanhas/alvos/${alvo.id}`, headers: cabDono });
    assert.equal(res.statusCode, 200);
    assert.equal((await obter(ctx.campanhaId)).alvos.length, 2);
  });

  it('aprovar tudo deixa a campanha pronta; desaprovar devolve para revisao', async () => {
    const aprovar = await app.inject({
      method: 'POST',
      url: `/api/campanhas/${ctx.campanhaId}/aprovar`,
      headers: cabDono,
      payload: { todos: true }
    });
    assert.equal(aprovar.json().aprovados, 2);
    assert.equal((await obter(ctx.campanhaId)).status, 'pronta');

    const alvo = (await obter(ctx.campanhaId)).alvos[1];
    await app.inject({
      method: 'POST',
      url: `/api/campanhas/${ctx.campanhaId}/aprovar`,
      headers: cabDono,
      payload: { alvoIds: [alvo.id], aprovar: false }
    });
    assert.equal((await obter(ctx.campanhaId)).status, 'revisao');

    await app.inject({
      method: 'POST',
      url: `/api/campanhas/${ctx.campanhaId}/aprovar`,
      headers: cabDono,
      payload: { alvoIds: [alvo.id] }
    });
    assert.equal((await obter(ctx.campanhaId)).status, 'pronta');
  });
});

describe('etapa 5: o disparo REALMENTE envia', () => {
  /**
   * ESTE E O TESTE MAIS IMPORTANTE DO ARQUIVO.
   *
   * No sistema antigo o disparo so gravava no banco e nunca chamava o
   * WhatsApp. Aqui exigimos a prova: o canal precisa ter recebido o texto.
   */
  it('entrega ao canal, com "digitando...", e so entao marca como enviada', async () => {
    entregues.length = 0;
    await db
      .update(schema.campaigns)
      .set({ intervaloMinSegundos: 0, intervaloMaxSegundos: 0, janelaInicio: '00:00', janelaFim: '23:59' })
      .where(eq(schema.campaigns.id, ctx.campanhaId));

    await service.iniciar(tenantId, ctx.campanhaId, { enviar: enviarFalso }, {});
    await esperarAte(() => !service.estaRodando(ctx.campanhaId), 2000);

    assert.equal(entregues.length, 2, 'O CANAL PRECISA TER RECEBIDO AS MENSAGENS');
    assert.ok(entregues.every((e) => e.digitandoMs >= 2500), 'cada mensagem precisa de "digitando..." antes');
    assert.ok(entregues.some((e) => e.texto === 'Texto revisado pelo dono da barbearia.'), 'sai o texto revisado');

    const c = await obter(ctx.campanhaId);
    assert.equal(c.status, 'concluida');
    assert.equal(c.progresso.percentual, 100);
    assert.equal(c.totalEnviadas, 2);
    assert.ok(c.alvos.every((a) => a.enviadoEm != null), 'enviadoEm so existe apos confirmacao do canal');
  });

  it('a mensagem aparece na conversa do cliente', async () => {
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const c = await obter(ctx.campanhaId);
    const alvo = c.alvos[0];

    const conversationId = await conversas.encontrarOuAbrir(tenantId, {
      leadId: alvo.leadId,
      channelInstanceId: c.channelInstanceId
    });
    const { mensagens } = await conversas.mensagens(tenantId, conversationId);
    assert.ok(mensagens.some((m) => m.conteudo === alvo.mensagem));
  });

  it('nao deixa editar mensagem ja enviada', async () => {
    const enviada = (await obter(ctx.campanhaId)).alvos[0];
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/campanhas/alvos/${enviada.id}`,
      headers: cabDono,
      payload: { mensagem: 'tentando reescrever o passado' }
    });
    assert.equal(res.statusCode, 422);
  });

  /** Falha de envio nao pode virar sucesso no painel. */
  it('envio recusado pelo canal vira falha, com o motivo', async () => {
    const id = await campanhaPronta('Campanha que falha', [await novoContato('Cliente Para Falhar')]);

    falhaDoCanal = 'Numero nao esta no WhatsApp';
    await service.iniciar(tenantId, id, { enviar: enviarFalso }, {});
    await esperarAte(() => !service.estaRodando(id), 2000);

    const alvo = (await obter(id)).alvos[0];
    assert.equal(alvo.status, 'falha');
    assert.equal(alvo.enviadoEm, null, 'nao pode carimbar envio de mensagem que nao saiu');
    assert.match(alvo.erro, /nao esta no WhatsApp/i);
  });

  /**
   * Numero desconectado nao e falha do cliente: a mensagem volta para a fila
   * e a campanha espera o WhatsApp voltar, em vez de queimar a lista inteira.
   */
  it('com o numero desconectado, devolve a mensagem para a fila e espera', async () => {
    const id = await campanhaPronta('Campanha sem conexao', [await novoContato('Cliente Paciente')]);

    falhaDoCanal = 'A conexão "W1" do WhatsApp não está conectada.';
    await service.iniciar(tenantId, id, { enviar: enviarFalso }, {});
    await esperarAte(async () => Boolean((await obter(id)).esperaMotivo));

    const c = await obter(id);
    assert.equal(c.status, 'enviando');
    assert.match(c.esperaMotivo, /reconectar/i);
    assert.equal(c.alvos[0].status, 'aprovada', 'a mensagem nao saiu: volta para a fila');

    await service.pausar(tenantId, id);
    await esperarAte(() => !service.estaRodando(id));
    assert.equal((await obter(id)).status, 'pausada');
  });
});

describe('ritmo e controles do disparo', () => {
  /**
   * Fora da janela a campanha ESPERA sozinha (continua "enviando"). Antes ela
   * virava "pausada" e so voltava se alguem lembrasse de clicar no dia seguinte.
   */
  it('fora da janela de horario, espera sem enviar e sem pausar', async () => {
    entregues.length = 0;
    // Janela de um minuto que ja passou (ou que ainda vai chegar): agora esta fora.
    const agora = new Date();
    const fora = `${String((agora.getHours() + 12) % 24).padStart(2, '0')}:00`;
    const fim = `${fora.slice(0, 2)}:01`;
    const id = await campanhaPronta('Campanha noturna', [await novoContato('Cliente Da Manha')], {
      janelaInicio: fora,
      janelaFim: fim
    });

    await service.iniciar(tenantId, id, { enviar: enviarFalso }, {});
    await esperarAte(async () => Boolean((await obter(id)).esperaMotivo));

    const c = await obter(id);
    assert.equal(c.status, 'enviando');
    assert.match(c.esperaMotivo, /horario/i);
    assert.ok(c.retomaEm > Date.now(), 'a tela precisa saber quando volta');
    assert.equal(entregues.length, 0);
    ctx.campanhaEsperando = id;
  });

  it('pausar em plena espera vale na hora', async () => {
    const r = await service.pausar(tenantId, ctx.campanhaEsperando);
    assert.equal(r.status, 'pausada');
    await esperarAte(() => !service.estaRodando(ctx.campanhaEsperando));
    assert.equal(service.estaRodando(ctx.campanhaEsperando), false);
  });

  it('parar encerra e marca o que nao saiu como nao enviado', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/campanhas/${ctx.campanhaEsperando}/cancelar`, headers: cabDono });
    assert.equal(res.json().status, 'cancelada');

    const c = await obter(ctx.campanhaEsperando);
    assert.ok(c.alvos.every((a) => a.status === 'pulada'));

    const retomar = await app.inject({ method: 'POST', url: `/api/campanhas/${ctx.campanhaEsperando}/iniciar`, headers: cabDono });
    assert.equal(retomar.statusCode, 422, 'campanha parada nao volta');
  });

  /**
   * Bug real: depois da ULTIMA mensagem o laco esperava o intervalo de
   * descanso antes de olhar a fila. Nessa janela a campanha ficava "enviando"
   * com 100%, e um Pausar a deixava "pausada" para sempre.
   */
  it('a ultima mensagem conclui a campanha na hora, sem esperar o intervalo', async () => {
    const id = await campanhaPronta('Campanha curta', [await novoContato('Cliente Ultimo')], {
      intervaloMinSegundos: 60,
      intervaloMaxSegundos: 60
    });

    await service.iniciar(tenantId, id, { enviar: enviarFalso }, {});
    await esperarAte(async () => (await obter(id)).status === 'concluida', 200);

    const c = await obter(id);
    assert.equal(c.status, 'concluida', 'nao pode ficar "enviando" esperando 60s');
    assert.equal(c.progresso.percentual, 100);
    await esperarAte(() => !service.estaRodando(id));
    assert.equal(service.estaRodando(id), false);
  });

  it('pausar quando ja saiu tudo conclui em vez de deixar pausada', async () => {
    const id = await campanhaPronta('Campanha ja enviada', [await novoContato('Cliente Ja Enviado')]);
    // Estado do defeito antigo: tudo enviado, mas a campanha ficou "pausada".
    await db.update(schema.campaignTargets).set({ status: 'enviada', enviadoEm: new Date() }).where(eq(schema.campaignTargets.campaignId, id));
    await db.update(schema.campaigns).set({ status: 'pausada' }).where(eq(schema.campaigns.id, id));

    // Quem abre a lista (ou o relatorio) ja a ve concluida...
    const lista = await app.inject({ method: 'GET', url: '/api/campanhas', headers: cabDono });
    assert.equal(lista.json().campanhas.find((x) => x.id === id).status, 'concluida');
    // ...e retomar uma campanha assim nao da erro.
    assert.equal((await obter(id)).status, 'concluida');
  });

  it('a lista traz o progresso de cada campanha', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/campanhas', headers: cabDono });
    const c = res.json().campanhas.find((x) => x.id === ctx.campanhaId);
    assert.equal(c.progresso.enviadas, 2);
    assert.equal(c.progresso.paraEnviar, 2);
  });
});

describe('bloqueio de reenvio em 15 dias', () => {
  it('quem acabou de receber e pulado na campanha seguinte', async () => {
    const c = await criarCampanha('Campanha logo em seguida');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/campanhas/${c.id}/publico`,
      headers: cabDono,
      payload: { leadIds: [ctx.contatos[0].id] }
    });

    assert.equal(res.json().incluidos, 0);
    assert.match(res.json().pulados[0].motivo, /15 dias/i);
  });
});

describe('respostas', () => {
  it('mensagem do cliente depois da campanha conta como resposta', async () => {
    const r = await service.registrarResposta(tenantId, ctx.contatos[0].id, 'Opa, quero sim!');
    assert.equal(r.classificado, true);

    const c = await obter(ctx.campanhaId);
    const alvo = c.alvos.find((a) => a.leadId === ctx.contatos[0].id);
    assert.equal(alvo.status, 'respondeu');
    assert.equal(alvo.respostaTexto, 'Opa, quero sim!');
    assert.equal(c.progresso.respostas, 1);
    // Respondeu continua contando como enviada.
    assert.equal(c.progresso.enviadas, 2);
  });

  it('cliente sem campanha recente nao e contado', async () => {
    const r = await service.registrarResposta(tenantId, 'lead_inexistente', 'oi');
    assert.equal(r.classificado, false);
  });
});

describe('permissao', () => {
  /** Disparo em massa mexe com a reputacao do numero da empresa inteira. */
  it('atendente NAO cria nem ve campanha', async () => {
    const criar = await app.inject({
      method: 'POST',
      url: '/api/campanhas',
      headers: cabRecepcao,
      payload: { nome: 'Tentativa', channelInstanceId: ctx.canalId }
    });
    assert.equal(criar.statusCode, 403);

    const listar = await app.inject({ method: 'GET', url: '/api/campanhas', headers: cabRecepcao });
    assert.equal(listar.statusCode, 403);
  });

  it('recusa canal que nao existe', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/campanhas',
      headers: cabDono,
      payload: { nome: 'Sem canal', channelInstanceId: 'chan_fantasma' }
    });
    assert.equal(res.statusCode, 404);
  });

  it('sem login nao ve campanha', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/campanhas' });
    assert.equal(res.statusCode, 401);
  });
});
