import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { audioDataUrl } from './helpers/audio-fixture.js';

let app;
let cabDono;
let cabRecepcao;
let recepcao;
let dono;
let ctx = {};

/** Abre uma conversa com mensagem do cliente, como o gateway faria. */
async function abrirConversaCom(texto = 'Oi, tem horario hoje?') {
  const service = await import('../src/modules/conversas/conversas.service.js');
  const { db } = await import('../src/db/client.js');
  const { leads, channelInstances } = await import('../src/db/schema/index.js');

  // Cliente NOVO a cada conversa. Reaproveitar os do seed faz um teste herdar a
  // conversa (e as mensagens) que outro deixou aberta, e as contagens deixam de
  // bater — foi o que aconteceu quando "assumir" passou a poder ser seguido de
  // uma mensagem no teste anterior.
  const leadsService = await import('../src/modules/leads/leads.service.js');
  const telefone = `551196${String(1000000 + ctx.proximoLead++).slice(-7)}`;
  const lead = await leadsService.encontrarOuCriarPorTelefone(ctx.tenantId, telefone, `Cliente Conversas ${ctx.proximoLead}`);
  const [canal] = await db.select().from(channelInstances);

  const conversationId = await service.encontrarOuAbrir(ctx.tenantId, {
    leadId: lead.id,
    canal: 'whatsapp',
    channelInstanceId: canal.id
  });

  await service.registrarRecebida(ctx.tenantId, conversationId, { conteudo: texto });
  return conversationId;
}

before(async () => {
  const criado = await criarAppDeTeste();
  app = criado.app;

  const l1 = await entrar(app);
  cabDono = l1.cabecalho;
  dono = l1.usuario;
  ctx.tenantId = dono.tenantId;

  const l2 = await entrar(app, 'recepcao');
  cabRecepcao = l2.cabecalho;
  recepcao = l2.usuario;

  ctx.proximoLead = 0;
});

after(async () => {
  await app?.close();
});

describe('abertura e mensagens', () => {
  it('abre conversa e mantem a previa da ultima mensagem', async () => {
    const id = await abrirConversaCom('Bom dia, queria marcar um corte');
    ctx.conversaId = id;

    const res = await app.inject({ method: 'GET', url: `/api/conversas/${id}`, headers: cabDono });
    assert.equal(res.statusCode, 200);

    const c = res.json().conversa;
    assert.equal(c.status, 'bot', 'conversa nova comeca com a IA');
    assert.equal(c.ultimaMensagemPreview, 'Bom dia, queria marcar um corte');
    assert.equal(c.naoLidas, 1);
    assert.equal(c.totalMensagensCliente, 1);
  });

  /**
   * Era a coluna `last_message` que o sistema antigo tentava escrever e que
   * nunca existiu — derrubando todo o motor de campanhas.
   */
  it('a previa acompanha a mensagem mais recente', async () => {
    const service = await import('../src/modules/conversas/conversas.service.js');
    await service.registrarRecebida(ctx.tenantId, ctx.conversaId, { conteudo: 'Pode ser amanha?' });

    const res = await app.inject({ method: 'GET', url: `/api/conversas/${ctx.conversaId}`, headers: cabDono });
    const c = res.json().conversa;

    assert.equal(c.ultimaMensagemPreview, 'Pode ser amanha?');
    assert.equal(c.naoLidas, 2);
  });

  it('reusa a conversa aberta do mesmo cliente em vez de criar outra', async () => {
    const service = await import('../src/modules/conversas/conversas.service.js');
    const { db } = await import('../src/db/client.js');
    const { leads } = await import('../src/db/schema/index.js');
    const [lead] = await db.select().from(leads);

    const a = await service.encontrarOuAbrir(ctx.tenantId, { leadId: lead.id });
    const b = await service.encontrarOuAbrir(ctx.tenantId, { leadId: lead.id });

    assert.equal(a, b, 'o mesmo cliente nao pode abrir duas conversas simultaneas');
  });

  /**
   * WhatsApp e Telegram reenviam mensagens quando acham que nao confirmamos.
   * Sem deduplicar, a mesma fala aparece duas vezes e a IA responde duas vezes.
   */
  it('descarta reenvio da mesma mensagem externa', async () => {
    const service = await import('../src/modules/conversas/conversas.service.js');

    const primeira = await service.registrarRecebida(ctx.tenantId, ctx.conversaId, {
      conteudo: 'Mensagem unica',
      externalId: 'wa_msg_123'
    });
    const segunda = await service.registrarRecebida(ctx.tenantId, ctx.conversaId, {
      conteudo: 'Mensagem unica',
      externalId: 'wa_msg_123'
    });

    assert.equal(primeira.duplicada, false);
    assert.equal(segunda.duplicada, true);
  });

  it('lista as mensagens na ordem de leitura', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/conversas/${ctx.conversaId}/mensagens`,
      headers: cabDono
    });

    assert.equal(res.statusCode, 200);
    const { mensagens } = res.json();

    assert.ok(mensagens.length >= 3);
    assert.equal(mensagens[0].conteudo, 'Bom dia, queria marcar um corte', 'a mais antiga vem primeiro');
    assert.ok(mensagens[0].createdAt <= mensagens.at(-1).createdAt);
  });
});

describe('assumir e devolver', () => {
  /**
   * Assumir e ATENDER sao coisas diferentes: o primeiro "pesca" a conversa, o
   * segundo acontece quando a pessoa escreve. So o segundo cala a Sofia.
   */
  it('assumir pesca a conversa, mas so escrever a torna humana', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${ctx.conversaId}/assumir`,
      headers: cabRecepcao
    });

    assert.equal(res.statusCode, 200);
    const pescada = res.json().conversa;

    assert.equal(pescada.assignedUserId, recepcao.id, 'passou a ser do atendente');
    assert.notEqual(pescada.status, 'humana', 'ainda nao escreveu: a Sofia nao pode ser calada');
    assert.equal(pescada.naoLidas, 0);
    assert.equal(pescada.primeiraRespostaSegundos, null, 'ninguem respondeu ao cliente ainda');

    const resp = await app.inject({
      method: 'POST',
      url: `/api/conversas/${ctx.conversaId}/mensagens`,
      headers: cabRecepcao,
      payload: { conteudo: 'Ola! Ja vou te ajudar.' }
    });
    assert.equal(resp.statusCode, 201, resp.body);

    const c = resp.json().conversa;
    assert.equal(c.status, 'humana', 'a primeira mensagem do atendente torna a conversa humana');
    assert.equal(c.assignedUserId, recepcao.id);
    assert.ok(c.primeiraRespostaSegundos != null, 'o tempo de espera do cliente precisa ser gravado');
  });

  it('outro atendente nao rouba conversa ja assumida', async () => {
    const id = await abrirConversaCom('Preciso de ajuda');

    await app.inject({ method: 'POST', url: `/api/conversas/${id}/assumir`, headers: cabRecepcao });

    // Cria um segundo atendente e tenta assumir a mesma conversa.
    await app.inject({
      method: 'POST',
      url: '/api/usuarios',
      headers: cabDono,
      payload: { username: 'outro.atendente', senha: 'senha-longa-123', nome: 'Outro', cargo: 'atendente' }
    });
    const { cabecalho: cabOutro } = await entrar(app, 'outro.atendente', 'senha-longa-123');

    const res = await app.inject({ method: 'POST', url: `/api/conversas/${id}/assumir`, headers: cabOutro });

    assert.equal(res.statusCode, 409);
    assert.match(res.json().erro.mensagem, /ja esta atendendo/i);
  });

  it('gerencia pode entrar em qualquer conversa', async () => {
    const id = await abrirConversaCom('Reclamacao');
    await app.inject({ method: 'POST', url: `/api/conversas/${id}/assumir`, headers: cabRecepcao });

    // O dono finaliza a conversa de outro atendente — permitido por cargo.
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/finalizar`,
      headers: cabDono,
      payload: {}
    });

    assert.equal(res.statusCode, 200);
  });

  it('devolver para a IA solta a conversa', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${ctx.conversaId}/devolver`,
      headers: cabRecepcao
    });

    assert.equal(res.statusCode, 200);
    const c = res.json().conversa;
    assert.equal(c.status, 'bot');
    assert.equal(c.assignedUserId, null);
  });
});

describe('responder', () => {
  it('responder assume a conversa automaticamente', async () => {
    const id = await abrirConversaCom('Qual o valor do corte?');

    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/mensagens`,
      headers: cabRecepcao,
      payload: { conteudo: 'Oi! O corte social sai por R$ 45,00.' }
    });

    assert.equal(res.statusCode, 201);
    const c = res.json().conversa;

    assert.equal(c.status, 'humana', 'digitar ja assume — sem passo extra com o cliente esperando');
    assert.equal(c.assignedUserId, recepcao.id);
    assert.equal(c.totalMensagensHumano, 1);
    assert.equal(c.naoLidas, 0, 'responder zera as nao lidas');

    ctx.conversaRespondida = id;
  });

  it('recusa mensagem vazia', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${ctx.conversaRespondida}/mensagens`,
      headers: cabRecepcao,
      payload: { conteudo: '   ' }
    });

    assert.equal(res.statusCode, 400);
  });

  it('recusa mensagem acima do limite do WhatsApp', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${ctx.conversaRespondida}/mensagens`,
      headers: cabRecepcao,
      payload: { conteudo: 'a'.repeat(5000) }
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().erro.detalhes.campos[0].mensagem, /4096/);
  });
});

describe('responder com audio', () => {
  it('grava o audio convertido, com transcricao quando ha provedor (aqui, sem: usa o rotulo)', async () => {
    const id = await abrirConversaCom('Oi, queria saber o preço');

    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/mensagens`,
      headers: cabRecepcao,
      payload: { audio: audioDataUrl(), duracaoSegundos: 4.2 }
    });

    assert.equal(res.statusCode, 201, res.body);
    const mensagemId = res.json().id;

    const lista = await app.inject({ method: 'GET', url: `/api/conversas/${id}/mensagens`, headers: cabRecepcao });
    const audio = lista.json().mensagens.find((m) => m.id === mensagemId);

    assert.equal(audio.tipo, 'audio');
    assert.equal(audio.direcao, 'saida');
    assert.equal(audio.autorTipo, 'humano');
    assert.match(audio.midiaUrl, /^\/api\/arquivos\/audio-.+\.ogg$/, 'foi convertido para ogg — o formato que o WhatsApp toca');
    // Sem provedor de IA configurado no ambiente de teste: a transcricao fica
    // vazia e o CONTEUDO cai no rotulo, do mesmo jeito que no audio recebido.
    assert.equal(audio.transcricao, null);
    assert.equal(audio.conteudo, '🎤 Áudio');
    assert.equal(audio.metadados.duracaoSegundos, 4.2);
  });

  it('recusa texto e audio juntos', async () => {
    const id = await abrirConversaCom('Oi');
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/mensagens`,
      headers: cabRecepcao,
      payload: { conteudo: 'Oi!', audio: audioDataUrl() }
    });
    assert.equal(res.statusCode, 400);
  });

  it('recusa audio que nao e audio nenhum (o ffmpeg nao decodifica)', async () => {
    const id = await abrirConversaCom('Oi');
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/mensagens`,
      headers: cabRecepcao,
      payload: { audio: 'data:audio/webm;base64,aXNzbyBuYW8gZSBhdWRpbyBuZW5odW0=' }
    });
    // 422: chegou um dado valido (uma data URL), mas a regra de negocio
    // recusa — igual a qualquer outra falha de "isto nao pode ser processado".
    assert.equal(res.statusCode, 422);
  });
});

describe('responder com anexo', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const enviar = (id, payload) =>
    app.inject({ method: 'POST', url: `/api/conversas/${id}/mensagens`, headers: cabRecepcao, payload });

  it('foto sem legenda: grava o arquivo e usa o rotulo como previa', async () => {
    const id = await abrirConversaCom('Manda uma foto do corte?');
    const res = await enviar(id, { anexo: { dataUrl: `data:image/png;base64,${PNG}`, nome: 'corte.png' } });
    assert.equal(res.statusCode, 201, res.body);

    const m = (await app.inject({ method: 'GET', url: `/api/conversas/${id}/mensagens`, headers: cabRecepcao }))
      .json()
      .mensagens.find((x) => x.id === res.json().id);
    assert.equal(m.tipo, 'imagem');
    assert.equal(m.conteudo, '📷 Foto');
    assert.match(m.midiaUrl, /^\/api\/arquivos\/anexo-.+\.png$/);
    assert.equal(m.metadados.nomeArquivo, 'corte.png');
    assert.equal(m.metadados.legenda, null);

    const arquivo = await app.inject({ method: 'GET', url: m.midiaUrl });
    assert.equal(arquivo.statusCode, 200);
    assert.equal(arquivo.headers['content-type'], 'image/png');
  });

  it('documento: a legenda vira o conteudo e o arquivo so e servido como download', async () => {
    const id = await abrirConversaCom('Tem a tabela de precos?');
    const pdf = Buffer.from('%PDF-1.4 tabela').toString('base64');
    const res = await enviar(id, {
      conteudo: 'Segue a tabela',
      anexo: { dataUrl: `data:application/pdf;base64,${pdf}`, nome: 'C:\\fakepath\\Tabela.pdf' }
    });
    assert.equal(res.statusCode, 201, res.body);

    const m = (await app.inject({ method: 'GET', url: `/api/conversas/${id}/mensagens`, headers: cabRecepcao }))
      .json()
      .mensagens.find((x) => x.id === res.json().id);
    assert.equal(m.tipo, 'documento');
    assert.equal(m.conteudo, 'Segue a tabela');
    assert.equal(m.metadados.nomeArquivo, 'Tabela.pdf', 'o caminho do computador de quem enviou nao vaza');

    const arquivo = await app.inject({ method: 'GET', url: m.midiaUrl });
    assert.equal(arquivo.headers['content-disposition'], 'attachment');
    assert.equal(arquivo.headers['x-content-type-options'], 'nosniff');
  });

  it('recusa arquivo que poderia rodar como pagina (html), mesmo disfarcado de documento', async () => {
    const id = await abrirConversaCom('Oi');
    const html = Buffer.from('<script>alert(1)</script>').toString('base64');
    const r1 = await enviar(id, { anexo: { dataUrl: `data:text/html;base64,${html}`, nome: 'pagina.html' } });
    assert.equal(r1.statusCode, 422);
    const r2 = await enviar(id, { anexo: { dataUrl: `data:image/svg+xml;base64,${html}`, nome: 'x.svg' } });
    assert.equal(r2.statusCode, 422);
  });

  it('recusa audio e anexo juntos', async () => {
    const id = await abrirConversaCom('Oi');
    const res = await enviar(id, { audio: audioDataUrl(), anexo: { dataUrl: `data:image/png;base64,${PNG}` } });
    assert.equal(res.statusCode, 400);
  });
});

describe('fila e distribuicao', () => {
  it('distribui para o atendente online menos carregado', async () => {
    // Os testes de cima deixaram varias conversas com a recepcao. Com a carga
    // contada de verdade ela ja estaria no limite; aqui o assunto e so a
    // escolha, entao ela ganha folga (o limite tem teste proprio logo abaixo).
    const { db } = await import('../src/db/client.js');
    const { users } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    await db.update(users).set({ capacidadeSimultanea: 99 }).where(eq(users.id, recepcao.id));

    const id = await abrirConversaCom('Quero falar com alguem');
    // Chega na fila como chegaria de verdade: a IA pediu um humano.
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    await conversas.enviarParaFila(ctx.tenantId, id);

    const res = await app.inject({ method: 'POST', url: `/api/conversas/${id}/distribuir`, headers: cabDono });

    assert.equal(res.statusCode, 200);
    const r = res.json();

    assert.equal(r.atribuida, true);
    assert.equal(r.conversa.status, 'na_fila', 'atribuida, mas aguardando a primeira mensagem dele');
    assert.equal(r.conversa.assignedUserId, recepcao.id);
    // Só 'recepcao' está online no seed; o dono está offline.
    assert.equal(r.atendente.id, recepcao.id);
  });

  it('quem ja esta no limite de conversas nao recebe mais — a conversa espera na fila', async () => {
    const { db } = await import('../src/db/client.js');
    const { users, conversations } = await import('../src/db/schema/index.js');
    const { and, eq, ne, isNull, count } = await import('drizzle-orm');

    // O limite da recepcao passa a ser exatamente o que ela ja tem aberto.
    const [{ total }] = await db
      .select({ total: count() })
      .from(conversations)
      .where(and(eq(conversations.assignedUserId, recepcao.id), ne(conversations.status, 'finalizada'), isNull(conversations.deletedAt)));
    await db.update(users).set({ capacidadeSimultanea: Math.max(1, Number(total)) }).where(eq(users.id, recepcao.id));

    const id = await abrirConversaCom('Tem alguem livre?');
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    await conversas.enviarParaFila(ctx.tenantId, id);

    const r = (await app.inject({ method: 'POST', url: `/api/conversas/${id}/distribuir`, headers: cabDono })).json();
    assert.equal(r.atribuida, false, 'ela esta cheia: nao pode receber a conversa');

    await db.update(users).set({ capacidadeSimultanea: 99 }).where(eq(users.id, recepcao.id));
  });

  /**
   * Empurrar conversa pra quem ja esta afogado e pior do que deixar na fila:
   * o cliente espera igual, mas agora sem ninguem monitorando a fila.
   */
  it('sem atendente disponivel, a conversa fica na fila', async () => {
    const { db } = await import('../src/db/client.js');
    const { users } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');

    // Tira todo mundo de online.
    await db.update(users).set({ statusPresenca: 'offline' }).where(eq(users.tenantId, ctx.tenantId));

    const id = await abrirConversaCom('Alguem ai?');
    const res = await app.inject({ method: 'POST', url: `/api/conversas/${id}/distribuir`, headers: cabDono });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().atribuida, false);
    assert.equal(res.json().conversa.status, 'na_fila');

    // Devolve a recepcao para online para os proximos testes.
    await db.update(users).set({ statusPresenca: 'online' }).where(eq(users.id, recepcao.id));
  });

  it('filtro de fila mostra so quem espera humano', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/conversas?filtro=fila', headers: cabDono });

    assert.equal(res.statusCode, 200);
    const itens = res.json().itens;
    assert.ok(itens.length >= 1);
    assert.ok(itens.every((c) => c.status === 'na_fila'));
  });

  it('filtro "minhas" mostra so as do atendente logado', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/conversas?filtro=minhas', headers: cabRecepcao });

    const itens = res.json().itens;
    assert.ok(itens.length >= 1);
    assert.ok(itens.every((c) => c.assignedUserId === recepcao.id));
  });
});

describe('transferencia', () => {
  it('transfere e deixa o rastro no fio da conversa', async () => {
    const id = await abrirConversaCom('Assunto complicado');
    await app.inject({ method: 'POST', url: `/api/conversas/${id}/assumir`, headers: cabRecepcao });

    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/transferir`,
      headers: cabRecepcao,
      payload: { paraUserId: dono.id, motivo: 'Cliente quer falar com o dono' }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().conversa.assignedUserId, dono.id);

    // O proximo atendente precisa entender o contexto sem sair da tela.
    const msgs = await app.inject({
      method: 'GET',
      url: `/api/conversas/${id}/mensagens`,
      headers: cabDono
    });

    const sistema = msgs.json().mensagens.filter((m) => m.autorTipo === 'sistema');
    assert.equal(sistema.length, 1);
    assert.match(sistema[0].conteudo, /transferida.*Cliente quer falar com o dono/i);
  });

  it('recusa transferir para quem nao existe', async () => {
    const id = await abrirConversaCom('Teste');
    await app.inject({ method: 'POST', url: `/api/conversas/${id}/assumir`, headers: cabRecepcao });

    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/transferir`,
      headers: cabRecepcao,
      payload: { paraUserId: 'usr_fantasma' }
    });

    assert.equal(res.statusCode, 404);
  });
});

describe('finalizar e reabrir', () => {
  it('finaliza guardando o resumo', async () => {
    const id = await abrirConversaCom('Obrigado!');
    await app.inject({ method: 'POST', url: `/api/conversas/${id}/assumir`, headers: cabRecepcao });

    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/finalizar`,
      headers: cabRecepcao,
      payload: { resumo: 'Cliente agendou corte para sabado.' }
    });

    assert.equal(res.statusCode, 200);
    const c = res.json().conversa;
    assert.equal(c.status, 'finalizada');
    assert.equal(c.resumo, 'Cliente agendou corte para sabado.');

    ctx.finalizadaId = id;
  });

  it('nao aceita mensagem em conversa finalizada', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${ctx.finalizadaId}/mensagens`,
      headers: cabRecepcao,
      payload: { conteudo: 'Mais uma coisa...' }
    });

    assert.equal(res.statusCode, 422);
    assert.match(res.json().erro.mensagem, /finalizada/i);
  });

  it('reabre e volta a aceitar mensagem', async () => {
    const reabrir = await app.inject({
      method: 'POST',
      url: `/api/conversas/${ctx.finalizadaId}/reabrir`,
      headers: cabRecepcao
    });
    assert.equal(reabrir.statusCode, 200);

    const responder = await app.inject({
      method: 'POST',
      url: `/api/conversas/${ctx.finalizadaId}/mensagens`,
      headers: cabRecepcao,
      payload: { conteudo: 'Claro, pode falar!' }
    });
    assert.equal(responder.statusCode, 201);
  });
});

describe('metricas da mesa', () => {
  it('resume o estado das conversas e a carga dos atendentes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/conversas/metricas', headers: cabDono });

    assert.equal(res.statusCode, 200);
    const m = res.json();

    assert.ok(m.total >= 1);
    assert.ok('comBot' in m && 'naFila' in m && 'comHumano' in m);
    assert.ok(Array.isArray(m.atendentes));

    const rec = m.atendentes.find((a) => a.id === recepcao.id);
    assert.ok(rec, 'a recepcao esta online e precisa aparecer');
    assert.ok('disponivel' in rec);
  });
});

describe('permissao', () => {
  it('sem login nao ve conversa nenhuma', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/conversas' });
    assert.equal(res.statusCode, 401);
  });
});

describe('OS vinculada a sessao de atendimento', () => {
  /** Cria uma OS ligada a conversa direto na camada de servico. */
  async function criarOs(conversationId, { inicioEm, status = 'confirmado' }) {
    const { db } = await import('../src/db/client.js');
    const { appointments, conversations, services, professionals } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    const [svc] = await db.select().from(services);
    const [prof] = await db.select().from(professionals);
    const id = `apt_teste_${Math.random().toString(36).slice(2)}`;
    await db.insert(appointments).values({
      id,
      tenantId: ctx.tenantId,
      leadId: conv.leadId,
      serviceId: svc.id,
      professionalId: prof.id,
      conversationId,
      inicioEm: new Date(inicioEm),
      fimEm: new Date(inicioEm + 30 * 60000),
      status,
      precoCentavos: 4500
    });
    return id;
  }

  it('ao finalizar, anexa o resumo e conclui so a OS que ja comecou', async () => {
    const id = await abrirConversaCom('Quero cortar o cabelo');

    const passada = await criarOs(id, { inicioEm: Date.now() - 3600_000 });
    const futura = await criarOs(id, { inicioEm: Date.now() + 5 * 86400_000 });

    const antes = await app.inject({ method: 'GET', url: `/api/agenda/${passada}`, headers: cabDono });
    assert.equal(antes.json().agendamento.sessaoAtiva, true);

    const fin = await app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/finalizar`,
      headers: cabDono,
      payload: { resumo: 'Corte social confirmado.' }
    });
    assert.equal(fin.statusCode, 200, fin.body);

    const a = (await app.inject({ method: 'GET', url: `/api/agenda/${passada}`, headers: cabDono })).json().agendamento;
    assert.equal(a.status, 'concluido');
    assert.equal(a.resumoAtendimento, 'Corte social confirmado.');
    assert.equal(a.sessaoAtiva, false);

    const f = (await app.inject({ method: 'GET', url: `/api/agenda/${futura}`, headers: cabDono })).json().agendamento;
    assert.equal(f.status, 'confirmado');
    assert.equal(f.resumoAtendimento, 'Corte social confirmado.');
  });

  it('lista o historico do cliente para o perfil', async () => {
    const id = await abrirConversaCom('Oi');
    const os = await criarOs(id, { inicioEm: Date.now() + 86400_000 });
    const { agendamento } = (await app.inject({ method: 'GET', url: `/api/agenda/${os}`, headers: cabDono })).json();

    const res = await app.inject({ method: 'GET', url: `/api/agenda/cliente/${agendamento.leadId}`, headers: cabDono });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().agendamentos.some((x) => x.id === os));
  });
});
