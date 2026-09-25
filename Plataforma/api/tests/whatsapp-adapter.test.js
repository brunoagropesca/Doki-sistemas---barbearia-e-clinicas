import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { audioDataUrl } from './helpers/audio-fixture.js';
import { env } from '../src/config/env.js';
import {
  atrasoDeReconexao,
  conectar,
  desconectar,
  encerrarTodas,
  enviar,
  estaConectada,
  ganchosDeTeste,
  instalarAdaptadorWhatsapp,
  presenca,
  reconectarInstanciasSalvas
} from '../src/channels/whatsapp/baileys.adapter.js';
import { criarTratadorDeChamadas, extrairTexto, MENSAGEM_CHAMADA_PADRAO } from '../src/channels/whatsapp/handlers.js';
import { limparEventos, listarEventos } from '../src/channels/eventos.js';
import { recarregarAgrupador, receberMensagem } from '../src/channels/gateway.js';

/**
 * O adaptador do WhatsApp, sem WhatsApp.
 *
 * Um socket de mentira faz o papel do Baileys: os testes "emitem" eventos
 * (QR, conectou, caiu, ligacao, mensagem) e conferem o que o sistema FEZ. E
 * aqui que se prova o que quebra em producao quando ninguem esta olhando —
 * reconexao em laco, conta derrubada por conexao dupla, ligacao que nao e
 * recusada, resposta do atendente que some.
 */

let app;
let tenantId;
let cabDono;
let cabRecepcao;
let db;
let tabela;

const fabricados = []; // { sock, state } de cada socket criado
const agendados = []; // reconexoes pedidas: { fn, ms }
let sequenciaMsg = 0;

/** Espera uma condicao (assincrona) ficar verdadeira, sem `sleep` fixo. */
async function esperar(condicao, { ms = 3000, descricao = 'condicao' } = {}) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (await condicao()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Tempo esgotado esperando: ${descricao}`);
}

/**
 * Espera a Sofia TERMINAR de responder, nao so comecar.
 *
 * Os baloes saem com 700ms de pausa entre si. Esperar so o primeiro deixava
 * os seguintes caindo no socket do teste SEGUINTE — que entao via mensagens
 * "enviadas" que nao eram dele e falhava de vez em quando ("ignora grupo...",
 * "audio sem texto..."). Considera terminado depois de 1s sem balao novo.
 */
async function esperarFimDaResposta(sock, { quieto = 1000, ms = 10_000 } = {}) {
  await esperar(() => sock.enviados.length >= 1, { ms, descricao: 'a primeira resposta' });
  const limite = Date.now() + ms;
  let visto = sock.enviados.length;
  let desde = Date.now();
  while (Date.now() < limite) {
    if (sock.enviados.length !== visto) {
      visto = sock.enviados.length;
      desde = Date.now();
    } else if (Date.now() - desde >= quieto) {
      return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Da tempo para algo que NAO deveria acontecer acontecer (e falhar o teste). */
const aguardar = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function criarSocketFalso({ pareado = true } = {}) {
  const ev = new EventEmitter();
  const sock = {
    ev: { on: (nome, fn) => ev.on(nome, fn) },
    emitir: (nome, dados) => ev.emit(nome, dados),
    user: { id: '5511999998888:12@s.whatsapp.net', name: 'Barbearia' },
    enviados: [],
    recusadas: [],
    lidas: [],
    encerrado: false,
    saiu: false,
    falharEnvio: null,
    atrasoEnvio: 0,
    async sendMessage(jid, conteudo) {
      if (sock.atrasoEnvio) await new Promise((r) => setTimeout(r, sock.atrasoEnvio));
      if (sock.falharEnvio) throw new Error(sock.falharEnvio);
      sock.enviados.push({ jid, ...conteudo });
      return { key: { id: `WA${++sequenciaMsg}` } };
    },
    async rejectCall(id, from) {
      sock.recusadas.push({ id, from });
    },
    async readMessages(chaves) {
      sock.lidas.push(...chaves);
    },
    presencas: [],
    falharPresenca: false,
    async sendPresenceUpdate(estado, jid) {
      if (sock.falharPresenca) throw new Error('presenca recusada');
      sock.presencas.push({ estado, jid });
    },
    end() {
      sock.encerrado = true;
    },
    async logout() {
      sock.saiu = true;
    }
  };
  const state = { creds: { me: pareado ? { id: '5511999998888:12@s.whatsapp.net' } : undefined } };
  return { sock, state, saveCreds: async () => {} };
}

const pastaAuth = (chave) => resolve(env.WHATSAPP_AUTH_DIR, tenantId, chave);

function criarSessaoEmDisco(chave) {
  mkdirSync(pastaAuth(chave), { recursive: true });
  writeFileSync(resolve(pastaAuth(chave), 'creds.json'), '{}');
}

const instancia = (chave) =>
  db.query.channelInstances.findFirst({
    where: (t, { and, eq }) => and(eq(t.tenantId, tenantId), eq(t.chave, chave))
  });

async function criarInstanciaNoBanco(chave, campos = {}) {
  const { ID } = await import('../src/core/ids.js');
  await db.insert(tabela).values({
    id: ID.canal(),
    tenantId,
    canal: 'whatsapp',
    chave,
    nome: `Numero ${chave}`,
    status: 'desconectado',
    ...campos
  });
}

async function definirConfig(chave, config) {
  const { and, eq } = await import('drizzle-orm');
  await db
    .update(tabela)
    .set({ config })
    .where(and(eq(tabela.tenantId, tenantId), eq(tabela.chave, chave)));
}

/** Conecta a W1 (ou outra) e a deixa "aberta", pronta para enviar. */
async function conectarEAbrir(chave = 'W1', opcoes) {
  await conectar(tenantId, chave);
  const f = fabricados.at(-1);
  f.sock.emitir('connection.update', { connection: 'open' });
  await esperar(() => estaConectada(tenantId, chave), { descricao: 'conexao abrir' });
  return f;
}

/** Uma imagem PNG de verdade, 1x1 pixel: o `salvarAnexo` aceita e grava. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/** A conversa de UM telefone (pelo banco) e as mensagens dela (pela API, como a tela). */
async function mensagensDoTelefone(telefone) {
  const { eq, and } = await import('drizzle-orm');
  const s = await import('../src/db/schema/index.js');
  const [lead] = await db.select().from(s.leads).where(eq(s.leads.telefone, telefone));
  if (!lead) return { conversa: null, mensagens: [] };
  const [conversa] = await db
    .select()
    .from(s.conversations)
    .where(and(eq(s.conversations.tenantId, tenantId), eq(s.conversations.leadId, lead.id)));
  if (!conversa) return { conversa: null, mensagens: [] };
  const m = await app.inject({ method: 'GET', url: `/api/conversas/${conversa.id}/mensagens`, headers: cabDono });
  return { conversa, mensagens: m.json().mensagens };
}

function mensagemRecebida({ de = '5511988887777', texto = '1', id, extra = {} } = {}) {
  return {
    messages: [
      {
        key: { remoteJid: `${de}@s.whatsapp.net`, fromMe: false, id: id ?? `IN${++sequenciaMsg}`, ...extra.key },
        pushName: 'Cliente Teste',
        message: { conversation: texto },
        ...extra.msg
      }
    ],
    type: 'notify'
  };
}

before(async () => {
  ({ app } = await criarAppDeTeste());
  ({ cabecalho: cabDono } = await entrar(app));
  ({ cabecalho: cabRecepcao } = await entrar(app, 'recepcao'));

  ({ db } = await import('../src/db/client.js'));
  const schema = await import('../src/db/schema/index.js');
  tabela = schema.channelInstances;
  const [t] = await db.select().from(schema.tenants);
  tenantId = t.id;

  ganchosDeTeste.fabrica = async () => {
    const f = criarSocketFalso({ pareado: ganchosDeTeste.pareado !== false });
    if (ganchosDeTeste.aoFabricar) await ganchosDeTeste.aoFabricar(f);
    fabricados.push(f);
    return f;
  };
  ganchosDeTeste.agendar = (fn, ms) => {
    agendados.push({ fn, ms });
    return { falso: true };
  };

  instalarAdaptadorWhatsapp();

  const atendimento = await import('../src/modules/atendimento/atendimento.service.js');
  await atendimento.salvarConfiguracao(tenantId, { modo: 'hibrido', agrupamentoSegundos: 0 });
  recarregarAgrupador(tenantId);
});

afterEach(async () => {
  encerrarTodas();
  fabricados.length = 0;
  agendados.length = 0;
  ganchosDeTeste.pareado = true;
  ganchosDeTeste.aoFabricar = null;
  ganchosDeTeste.baixarMidia = null;
  ganchosDeTeste.transcrever = null;

  const { and, eq } = await import('drizzle-orm');
  await db
    .update(tabela)
    .set({ status: 'desconectado', qrCode: null, qrExpiraEm: null, ultimoErro: null, identificador: null, config: {} })
    .where(and(eq(tabela.tenantId, tenantId), eq(tabela.chave, 'W1')));

  // As instancias extras que os testes criam saem daqui: cada teste comeca so com a W1.
  const { inArray } = await import('drizzle-orm');
  await db.delete(tabela).where(and(eq(tabela.tenantId, tenantId), inArray(tabela.chave, ['W2', 'W3', 'W4', 'W5'])));

  for (const chave of ['W1', 'W2', 'W3', 'W4', 'W5']) await rm(pastaAuth(chave), { recursive: true, force: true });
  limparEventos(tenantId);
});

after(async () => {
  encerrarTodas();
  ganchosDeTeste.fabrica = null;
  ganchosDeTeste.agendar = null;
  await app?.close();
});

const fechar = (sock, statusCode, message = 'falha') =>
  sock.emitir('connection.update', {
    connection: 'close',
    lastDisconnect: { error: Object.assign(new Error(message), { output: { statusCode } }) }
  });

// ============================================================================

describe('intervalo de reconexao', () => {
  it('dobra a cada queda e para em um minuto', () => {
    assert.equal(atrasoDeReconexao(1), 2_000);
    assert.equal(atrasoDeReconexao(2), 4_000);
    assert.equal(atrasoDeReconexao(3), 8_000);
    assert.equal(atrasoDeReconexao(5), 32_000);
    assert.equal(atrasoDeReconexao(6), 60_000);
    assert.equal(atrasoDeReconexao(50), 60_000);
    assert.equal(atrasoDeReconexao(0), 2_000);
  });
});

describe('conectar: QR Code, abrir e enviar', () => {
  it('marca "conectando", guarda o QR como imagem e depois conecta', async () => {
    const r = await conectar(tenantId, 'W1');
    assert.deepEqual(r, { conectando: true });
    assert.equal(fabricados.length, 1);
    assert.equal((await instancia('W1')).status, 'conectando');

    const { sock } = fabricados[0];
    sock.emitir('connection.update', { qr: '2@primeiro' });
    await esperar(async () => (await instancia('W1')).status === 'aguardando_qr', { descricao: 'status aguardando_qr' });

    let i = await instancia('W1');
    assert.match(i.qrCode, /^data:image\/png;base64,/);
    const restante = i.qrExpiraEm.getTime() - Date.now();
    assert.ok(restante > 50_000 && restante <= 60_000, `o primeiro QR vale ~60s (${restante}ms)`);

    // O segundo QR vale menos: o WhatsApp troca a cada ~20s.
    sock.emitir('connection.update', { qr: '2@segundo' });
    await esperar(async () => (await instancia('W1')).qrExpiraEm.getTime() - Date.now() < 30_000, {
      descricao: 'segundo QR com validade curta'
    });

    sock.emitir('connection.update', { connection: 'open' });
    await esperar(async () => (await instancia('W1')).status === 'conectado', { descricao: 'status conectado' });

    i = await instancia('W1');
    assert.equal(i.identificador, '5511999998888');
    assert.equal(i.nomePerfil, 'Barbearia');
    assert.equal(i.qrCode, null);
    assert.equal(i.ultimoErro, null);
    assert.ok(i.conectadoEm);
    assert.ok(estaConectada(tenantId, 'W1'));
  });

  it('so envia depois de aberta, e para o JID certo', async () => {
    await conectar(tenantId, 'W1');
    await assert.rejects(
      () => enviar({ tenantId, instanciaChave: 'W1', destino: '11987654321', texto: 'oi' }),
      /não está conectada/
    );

    const { sock } = fabricados[0];
    sock.emitir('connection.update', { connection: 'open' });
    await esperar(() => estaConectada(tenantId, 'W1'));

    const r = await enviar({ tenantId, instanciaChave: 'W1', destino: '(11) 98765-4321', texto: 'oi' });
    assert.equal(sock.enviados[0].jid, '5511987654321@s.whatsapp.net');
    assert.equal(sock.enviados[0].text, 'oi');
    assert.match(r.idExterno, /^WA/);
  });

  it('duas chamadas quase juntas abrem UM socket so', async () => {
    const [a, b] = await Promise.all([conectar(tenantId, 'W1'), conectar(tenantId, 'W1')]);
    assert.equal(fabricados.length, 1, 'dois sockets na mesma conta se derrubariam em ciclo');
    assert.ok([a, b].some((r) => r.jaAtiva));
  });

  it('falha ao montar o socket: reporta, marca erro e permite tentar de novo', async () => {
    ganchosDeTeste.aoFabricar = async () => {
      throw new Error('sem disco');
    };
    await assert.rejects(() => conectar(tenantId, 'W1'), /sem disco/);

    const i = await instancia('W1');
    assert.equal(i.status, 'erro');
    assert.match(i.ultimoErro, /sem disco/);
    assert.ok(listarEventos(tenantId).some((e) => e.nivel === 'erro' && /sem disco/.test(e.mensagem)));

    ganchosDeTeste.aoFabricar = null;
    const r = await conectar(tenantId, 'W1');
    assert.deepEqual(r, { conectando: true }, 'a vaga nao pode ter ficado presa');
  });

  it('desconectar enquanto o socket ainda esta sendo montado nao deixa socket orfao', async () => {
    let liberar;
    const trava = new Promise((r) => (liberar = r));
    ganchosDeTeste.aoFabricar = () => trava;

    const conectando = conectar(tenantId, 'W1');
    await desconectar(tenantId, 'W1');
    liberar();

    assert.deepEqual(await conectando, { cancelada: true });
    assert.equal(fabricados[0].sock.encerrado, true);
    assert.equal(estaConectada(tenantId, 'W1'), false);
  });
});

describe('quando a conexao fecha', () => {
  it('desconectar de proposito NAO reconecta sozinho', async () => {
    const { sock } = await conectarEAbrir();
    await desconectar(tenantId, 'W1');

    assert.equal(sock.encerrado, true);
    assert.equal((await instancia('W1')).status, 'desconectado');

    // O socket avisa que fechou — como o Baileys faz apos end().
    fechar(sock, 428, 'Connection Closed');
    await aguardar();

    assert.equal(agendados.length, 0, 'nao pode agendar reconexao');
    assert.equal(estaConectada(tenantId, 'W1'), false);
    assert.equal((await instancia('W1')).status, 'desconectado');
  });

  it('queda de rede: reconecta com intervalo crescente e recomeca depois de conectar', async () => {
    const { sock } = await conectarEAbrir();

    fechar(sock, 408, 'Connection Lost');
    await esperar(() => agendados.length === 1, { descricao: '1a reconexao agendada' });
    assert.equal(agendados[0].ms, 2_000);

    let i = await instancia('W1');
    assert.equal(i.status, 'conectando');
    assert.match(i.ultimoErro, /Nova tentativa em 2s/);
    assert.equal(estaConectada(tenantId, 'W1'), false);

    // Executa a reconexao; o novo socket tambem cai antes de abrir.
    agendados[0].fn();
    await esperar(() => fabricados.length === 2, { descricao: '2o socket' });
    fechar(fabricados[1].sock, 408);
    await esperar(() => agendados.length === 2);
    assert.equal(agendados[1].ms, 4_000);

    agendados[1].fn();
    await esperar(() => fabricados.length === 3);
    fechar(fabricados[2].sock, 408);
    await esperar(() => agendados.length === 3);
    assert.equal(agendados[2].ms, 8_000);

    // Agora conecta de verdade: o contador zera.
    agendados[2].fn();
    await esperar(() => fabricados.length === 4);
    fabricados[3].sock.emitir('connection.update', { connection: 'open' });
    await esperar(() => estaConectada(tenantId, 'W1'));
    fechar(fabricados[3].sock, 408);
    await esperar(() => agendados.length === 4);
    assert.equal(agendados[3].ms, 2_000, 'depois de conectar, o intervalo recomeca');

    assert.ok(listarEventos(tenantId).some((e) => /Tentativa 1 de reconexão/.test(e.mensagem)));
  });

  it('a reconexao automatica nao apaga a mensagem da queda; a manual apaga', async () => {
    const { sock } = await conectarEAbrir();
    fechar(sock, 408, 'Connection Lost');
    await esperar(() => agendados.length === 1);

    agendados[0].fn();
    await esperar(() => fabricados.length === 2);
    assert.match((await instancia('W1')).ultimoErro ?? '', /Nova tentativa/, 'automatica: o motivo continua visivel');

    await desconectar(tenantId, 'W1');
    await conectar(tenantId, 'W1');
    assert.equal((await instancia('W1')).ultimoErro, null, 'manual: recomeca limpo');
  });

  it('sessao encerrada pelo celular: NAO reconecta e apaga a sessao', async () => {
    criarSessaoEmDisco('W1');
    const { sock } = await conectarEAbrir();

    fechar(sock, 401, 'Logged Out');
    await esperar(async () => (await instancia('W1')).status === 'desconectado');

    const i = await instancia('W1');
    assert.match(i.ultimoErro, /encerrada pelo celular/);
    assert.equal(existsSync(pastaAuth('W1')), false, 'credenciais mortas nao podem ficar');
    await aguardar();
    assert.equal(agendados.length, 0);
  });

  it('conta aberta em outro lugar: NAO reconecta (senao os dois se derrubam para sempre)', async () => {
    const { sock } = await conectarEAbrir();
    fechar(sock, 440, 'Stream Errored (conflict)');
    await esperar(async () => (await instancia('W1')).status === 'erro');

    assert.match((await instancia('W1')).ultimoErro, /outro computador/);
    await aguardar();
    assert.equal(agendados.length, 0);
  });

  it('sessao corrompida (500) ou incompativel (411): apaga e pede novo QR', async () => {
    for (const codigo of [500, 411]) {
      criarSessaoEmDisco('W1');
      const { sock } = await conectarEAbrir();
      fechar(sock, codigo);
      await esperar(async () => (await instancia('W1')).status === 'desconectado');
      assert.match((await instancia('W1')).ultimoErro, /inválida/);
      // O adaptador grava o status e SO DEPOIS apaga a pasta: conferir a pasta
      // no mesmo instante perdia a corrida quando a maquina estava ocupada.
      await esperar(() => !existsSync(pastaAuth('W1')), { descricao: 'a sessao salva ser apagada' });
      assert.equal(existsSync(pastaAuth('W1')), false);
      assert.equal(agendados.length, 0);
      encerrarTodas();
    }
  });

  it('conta recusada pelo WhatsApp (403): para de insistir', async () => {
    const { sock } = await conectarEAbrir();
    fechar(sock, 403);
    await esperar(async () => (await instancia('W1')).status === 'erro');
    assert.match((await instancia('W1')).ultimoErro, /recusou/);
    await aguardar();
    assert.equal(agendados.length, 0);
  });

  it('ninguem leu o QR (conta nunca pareada): NAO fica gerando QR para sempre', async () => {
    ganchosDeTeste.pareado = false;
    await conectar(tenantId, 'W1');
    const { sock } = fabricados[0];
    sock.emitir('connection.update', { qr: '2@a' });
    await esperar(async () => (await instancia('W1')).status === 'aguardando_qr');

    fechar(sock, 408, 'QR refs attempts ended');
    await esperar(async () => (await instancia('W1')).status === 'desconectado');

    const i = await instancia('W1');
    assert.match(i.ultimoErro, /QR Code expirou/);
    assert.equal(i.qrCode, null);
    await aguardar();
    assert.equal(agendados.length, 0);
  });

  it('reinicio exigido apos ler o QR (515) reconecta na hora, sem contar como erro', async () => {
    await conectar(tenantId, 'W1');
    const { sock, state } = fabricados[0];
    state.creds.me = { id: '5511999998888:1@s.whatsapp.net' }; // o pareamento acabou de gravar
    fechar(sock, 515, 'Stream Errored (restart required)');

    await esperar(() => agendados.length === 1);
    assert.equal(agendados[0].ms, 0);
    agendados[0].fn();
    await esperar(() => fabricados.length === 2);
    assert.equal((await instancia('W1')).status, 'conectando');
  });

  it('evento de um socket antigo e ignorado (nao derruba a conexao nova)', async () => {
    const { sock: velho } = await conectarEAbrir();
    await desconectar(tenantId, 'W1');
    await conectarEAbrir();
    assert.ok(estaConectada(tenantId, 'W1'));

    fechar(velho, 428, 'Connection Closed');
    velho.emitir('connection.update', { qr: '2@fantasma' });
    await aguardar();

    assert.ok(estaConectada(tenantId, 'W1'), 'a conexao nova precisa continuar de pe');
    assert.equal(agendados.length, 0);
    assert.equal((await instancia('W1')).status, 'conectado');
  });

  it('sair da conta: faz logout, apaga a sessao e limpa o numero', async () => {
    criarSessaoEmDisco('W1');
    const { sock } = await conectarEAbrir();

    await desconectar(tenantId, 'W1', { sair: true });

    assert.equal(sock.saiu, true);
    assert.equal(existsSync(pastaAuth('W1')), false);
    const i = await instancia('W1');
    assert.equal(i.status, 'desconectado');
    assert.equal(i.identificador, null);
    assert.equal(i.nomePerfil, null);
  });

  it('desconectar sem sair GUARDA a sessao', async () => {
    criarSessaoEmDisco('W1');
    await conectarEAbrir();
    await desconectar(tenantId, 'W1');
    assert.equal(existsSync(pastaAuth('W1')), true);
  });
});

describe('nenhum evento pode derrubar o servidor', () => {
  it('eventos malformados nao viram "promise rejeitada" (o main.js encerraria tudo)', async () => {
    const rejeicoes = [];
    const ouvinte = (motivo) => rejeicoes.push(motivo);
    process.on('unhandledRejection', ouvinte);

    try {
      const { sock } = await conectarEAbrir();

      sock.emitir('connection.update', {});
      sock.emitir('call', [null, {}, { status: 'offer' }, { status: 'offer', id: 'x' }]);
      sock.emitir('call', undefined);
      sock.emitir('messages.upsert', { messages: [null, {}, { key: null }], type: 'notify' });
      sock.emitir('messages.upsert', { messages: undefined, type: 'notify' });
      sock.emitir('messages.upsert', undefined);
      fechar(sock, undefined);

      await aguardar(200);
      assert.deepEqual(rejeicoes, []);
    } finally {
      process.off('unhandledRejection', ouvinte);
    }
  });
});

describe('ligacoes', () => {
  it('desligado: nao recusa (so registra); ligado: recusa e avisa por texto — sem reconectar', async () => {
    const { sock } = await conectarEAbrir();

    sock.emitir('call', [{ id: 'c1', from: '5511977776666@s.whatsapp.net', status: 'offer' }]);
    await esperar(() => listarEventos(tenantId).some((e) => e.tipo === 'chamada'));
    assert.equal(sock.recusadas.length, 0);
    assert.match(listarEventos(tenantId).find((e) => e.tipo === 'chamada').mensagem, /não recusada/);

    // O dono liga a opcao pela API; vale na proxima ligacao, sem reconectar.
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/canais/W1/config',
      headers: cabDono,
      payload: { rejeitarChamadas: true }
    });
    assert.equal(res.statusCode, 200);

    sock.emitir('call', [{ id: 'c2', from: '5511977776666@s.whatsapp.net', status: 'offer' }]);
    await esperar(() => sock.recusadas.length === 1, { descricao: 'chamada recusada' });
    await esperar(() => sock.enviados.length === 1, { descricao: 'aviso por texto' });

    assert.equal(sock.recusadas[0].id, 'c2');
    assert.equal(sock.recusadas[0].from, '5511977776666@s.whatsapp.net');
    assert.equal(sock.enviados[0].jid, '5511977776666@s.whatsapp.net');
    assert.equal(sock.enviados[0].text, MENSAGEM_CHAMADA_PADRAO);
    assert.ok(listarEventos(tenantId).some((e) => e.nivel === 'sucesso' && /recusada automaticamente/.test(e.mensagem)));

    // O console nunca mostra o numero inteiro.
    assert.doesNotMatch(JSON.stringify(listarEventos(tenantId)), /5511977776666/);
  });

  it('usa a mensagem personalizada do dono', async () => {
    const { sock } = await conectarEAbrir();
    await definirConfig('W1', { rejeitarChamadas: true, mensagemChamada: 'Só mensagem, obrigado!' });

    sock.emitir('call', [{ id: 'c1', from: '5511977776666@s.whatsapp.net', status: 'offer' }]);
    await esperar(() => sock.enviados.length === 1);
    assert.equal(sock.enviados[0].text, 'Só mensagem, obrigado!');
  });

  it('LID: recusa pelo identificador da chamada e avisa no telefone real', async () => {
    const { sock } = await conectarEAbrir();
    await definirConfig('W1', { rejeitarChamadas: true });

    sock.emitir('call', [
      { id: 'c1', from: '99887766@lid', callerPn: '5511977776666@s.whatsapp.net', status: 'offer', isVideo: true }
    ]);
    await esperar(() => sock.enviados.length === 1);

    assert.equal(sock.recusadas[0].from, '99887766@lid');
    assert.equal(sock.enviados[0].jid, '5511977776666@s.whatsapp.net');
    assert.ok(listarEventos(tenantId).some((e) => /vídeo/.test(e.mensagem)));
  });

  it('chamada de grupo e estados que nao sao o toque inicial sao ignorados', async () => {
    const { sock } = await conectarEAbrir();
    await definirConfig('W1', { rejeitarChamadas: true });

    sock.emitir('call', [
      { id: 'g1', from: '5511977776666@s.whatsapp.net', status: 'offer', isGroup: true },
      { id: 'c1', from: '5511977776666@s.whatsapp.net', status: 'ringing' },
      { id: 'c1', from: '5511977776666@s.whatsapp.net', status: 'terminate' }
    ]);
    await aguardar(100);
    assert.equal(sock.recusadas.length, 0);
    assert.equal(sock.enviados.length, 0);
  });

  it('se o aviso por texto falhar, a chamada continua recusada e nada estoura', async () => {
    const { sock } = await conectarEAbrir();
    await definirConfig('W1', { rejeitarChamadas: true });
    sock.falharEnvio = 'sem rede';

    sock.emitir('call', [{ id: 'c1', from: '5511977776666@s.whatsapp.net', status: 'offer' }]);
    await esperar(() => listarEventos(tenantId).some((e) => e.nivel === 'aviso'));

    assert.equal(sock.recusadas.length, 1);
    assert.match(listarEventos(tenantId).find((e) => e.nivel === 'aviso').mensagem, /aviso por texto/);
  });

  it('se recusar falhar, registra erro e segue', async () => {
    const { sock } = await conectarEAbrir();
    await definirConfig('W1', { rejeitarChamadas: true });
    sock.rejectCall = async () => {
      throw new Error('nao deu');
    };

    sock.emitir('call', [{ id: 'c1', from: '5511977776666@s.whatsapp.net', status: 'offer' }]);
    await esperar(() => listarEventos(tenantId).some((e) => e.nivel === 'erro'));
    assert.equal(sock.enviados.length, 0, 'sem ter recusado, nao avisa o cliente');
  });
});

describe('tratador de ligacoes (relogio controlado)', () => {
  function montar(config) {
    const sock = criarSocketFalso().sock;
    let agora = 1_000_000;
    const tratar = criarTratadorDeChamadas({
      sock,
      tenantId,
      chave: 'W1',
      lerConfig: async () => config,
      agora: () => agora
    });
    return { sock, tratar, avancar: (ms) => (agora += ms) };
  }
  const oferta = (id, quem = '5511977776666@s.whatsapp.net') => ({ id, from: quem, status: 'offer' });

  it('a mesma ligacao repetida pelo WhatsApp conta uma vez', async () => {
    const { sock, tratar } = montar({ rejeitarChamadas: true });
    await tratar([oferta('c1'), oferta('c1')]);
    await tratar([oferta('c1')]);
    assert.equal(sock.recusadas.length, 1);
  });

  it('quem liga varias vezes recebe UM aviso a cada 10 minutos, mas todas sao recusadas', async () => {
    const { sock, tratar, avancar } = montar({ rejeitarChamadas: true });

    await tratar([oferta('c1')]);
    await tratar([oferta('c2')]);
    await tratar([oferta('c3')]);
    assert.equal(sock.recusadas.length, 3);
    assert.equal(sock.enviados.length, 1);

    avancar(10 * 60_000 + 1);
    await tratar([oferta('c4')]);
    assert.equal(sock.recusadas.length, 4);
    assert.equal(sock.enviados.length, 2);
  });

  it('cada pessoa recebe o proprio aviso', async () => {
    const { sock, tratar } = montar({ rejeitarChamadas: true });
    await tratar([oferta('c1', '5511977776666@s.whatsapp.net'), oferta('c2', '5511966665555@s.whatsapp.net')]);
    assert.equal(sock.enviados.length, 2);
  });

  it('config quebrada nao liga a opcao', async () => {
    const { sock, tratar } = montar({ rejeitarChamadas: 'true' });
    await tratar([oferta('c1')]);
    assert.equal(sock.recusadas.length, 0);
  });
});

describe('mensagens recebidas', () => {
  it('responde pelo menu e o cliente entra no CRM (fluxo completo, sem WhatsApp)', async () => {
    const { sock } = await conectarEAbrir();

    sock.emitir('messages.upsert', mensagemRecebida({ de: '5511988887777', texto: '1', id: 'IN_menu' }));
    await esperar(() => sock.enviados.length >= 1, { descricao: 'resposta do menu' });

    assert.equal(sock.enviados[0].jid, '5511988887777@s.whatsapp.net');
    assert.match(sock.enviados[0].text, /serviços e valores/i);

    const busca = await app.inject({ method: 'GET', url: '/api/leads?busca=88887777', headers: cabDono });
    assert.equal(busca.json().itens.length, 1);
    assert.equal(busca.json().itens[0].telefone, '5511988887777');
  });

  it('marca como lida SO quando a opcao esta ligada — e ja com a resposta em andamento', async () => {
    const { sock } = await conectarEAbrir();

    sock.emitir('messages.upsert', mensagemRecebida({ de: '5511988880001', id: 'IN_a' }));
    await esperarFimDaResposta(sock);
    assert.equal(sock.lidas.length, 0, 'desligado: nao marca');

    await definirConfig('W1', { marcarComoLida: true });
    sock.emitir('messages.upsert', mensagemRecebida({ de: '5511988880002', id: 'IN_b' }));
    await esperar(() => sock.lidas.length === 1, { descricao: 'marcar como lida' });

    assert.equal(sock.lidas[0].id, 'IN_b');
    assert.equal(sock.lidas[0].remoteJid, '5511988880002@s.whatsapp.net');
  });

  it('falha ao marcar como lida nao impede o atendimento', async () => {
    const { sock } = await conectarEAbrir();
    await definirConfig('W1', { marcarComoLida: true });
    sock.readMessages = async () => {
      throw new Error('nao foi');
    };

    sock.emitir('messages.upsert', mensagemRecebida({ de: '5511988880003', id: 'IN_c' }));
    await esperar(() => sock.enviados.length >= 1, { descricao: 'resposta mesmo assim' });
  });

  it('contato com LID: usa o telefone real quando o WhatsApp informa', async () => {
    const { sock } = await conectarEAbrir();

    sock.emitir('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '99887766@lid', remoteJidAlt: '5511966665555@s.whatsapp.net', fromMe: false, id: 'IN_lid1' },
          pushName: 'Contato LID',
          message: { conversation: '1' }
        }
      ]
    });
    await esperarFimDaResposta(sock);
    assert.equal(sock.enviados[0].jid, '5511966665555@s.whatsapp.net');
  });

  it('contato com LID sem telefone: ignora e AVISA no console (sem inventar cliente)', async () => {
    const { sock } = await conectarEAbrir();

    sock.emitir('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '55443322@lid', fromMe: false, id: 'IN_lid2' }, message: { conversation: 'oi' } }]
    });
    await esperar(() => listarEventos(tenantId).some((e) => /identificador interno/.test(e.mensagem)));
    assert.equal(sock.enviados.length, 0);
  });

  it('ignora grupo, mensagem propria e historico (type != notify)', async () => {
    const { sock } = await conectarEAbrir();
    await definirConfig('W1', { marcarComoLida: true });

    sock.emitir('messages.upsert', {
      type: 'notify',
      messages: [
        { key: { remoteJid: '1203630@g.us', participant: '5511988880009@s.whatsapp.net', fromMe: false, id: 'G1' }, message: { conversation: '1' } },
        { key: { remoteJid: '5511988880010@s.whatsapp.net', fromMe: true, id: 'M1' }, message: { conversation: '1' } },
        { key: { remoteJid: 'status@broadcast', fromMe: false, id: 'B1' }, message: { conversation: '1' } }
      ]
    });
    sock.emitir('messages.upsert', { ...mensagemRecebida({ de: '5511988880011', id: 'H1' }), type: 'append' });
    await aguardar(150);

    assert.equal(sock.enviados.length, 0);
    assert.equal(sock.lidas.length, 0);
  });

  /**
   * Antes este teste garantia o BUG: a foto era descartada ("sem_texto") e so
   * o console sabia. Agora ela entra na conversa e uma pessoa confere.
   */
  it('imagem sem legenda: entra na conversa e vai para um atendente', async () => {
    const telefone = '5511988880012';
    ganchosDeTeste.baixarMidia = async () => PNG_1X1;
    const { sock } = await conectarEAbrir();
    sock.emitir('messages.upsert', {
      type: 'notify',
      messages: [
        { key: { remoteJid: `${telefone}@s.whatsapp.net`, fromMe: false, id: 'A1' }, message: { imageMessage: { mimetype: 'image/png' } } }
      ]
    });
    await esperarFimDaResposta(sock);

    assert.equal(sock.enviados.length, 1, 'um aviso ao cliente de que chegou');
    const { conversa, mensagens } = await mensagensDoTelefone(telefone);
    assert.equal(conversa.status, 'na_fila');
    assert.ok(mensagens.some((m) => m.tipo === 'imagem' && m.direcao === 'entrada'), 'a foto fica gravada na conversa');
  });

  it('extrairTexto entende os formatos comuns', () => {
    assert.equal(extrairTexto({ message: { conversation: 'a' } }), 'a');
    assert.equal(extrairTexto({ message: { extendedTextMessage: { text: 'b' } } }), 'b');
    assert.equal(extrairTexto({ message: { imageMessage: { caption: 'c' } } }), 'c');
    assert.equal(extrairTexto({ message: { documentMessage: { caption: 'comprovante' } } }), 'comprovante');
    assert.equal(extrairTexto({ message: { audioMessage: {} } }), null);
    assert.equal(extrairTexto(null), null);
  });

  // O Baileys NAO desembrulha estes envelopes ao receber: sem isto, o cliente
  // com mensagens temporarias falava sozinho.
  it('extrairTexto abre mensagem temporaria, visualizacao unica, documento com legenda e editada', () => {
    const temporaria = { ephemeralMessage: { message: { extendedTextMessage: { text: 'quero marcar' } } } };
    assert.equal(extrairTexto({ message: temporaria }), 'quero marcar');
    assert.equal(
      extrairTexto({ message: { ephemeralMessage: { message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'esse corte' } } } } } } }),
      'esse corte',
      'temporaria + visualizacao unica'
    );
    assert.equal(extrairTexto({ message: { viewOnceMessage: { message: { videoMessage: { caption: 'v' } } } } }), 'v');
    assert.equal(
      extrairTexto({ message: { documentWithCaptionMessage: { message: { documentMessage: { caption: 'pix pago' } } } } }),
      'pix pago'
    );
    assert.equal(
      extrairTexto({ message: { editedMessage: { message: { protocolMessage: { editedMessage: { conversation: 'as 15h, nao 14h' } } } } } }),
      'as 15h, nao 14h'
    );
  });
});

/**
 * Foto, PDF, figurinha, localizacao e contato recebidos.
 *
 * Antes TODOS eram descartados ("sem_texto"): o comprovante de PIX e a foto
 * do corte de referencia nunca apareciam para a equipe. O `baixarMidia`
 * entrega bytes de verdade (PNG 1x1, PDF minimo) e o `salvarAnexo` real grava
 * na pasta dos testes (PASTA_ARQUIVOS do .env.test).
 */
describe('arquivos e outros tipos recebidos do cliente', () => {
  const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

  const recebida = (de, id, message) => ({
    type: 'notify',
    messages: [{ key: { remoteJid: `${de}@s.whatsapp.net`, fromMe: false, id }, pushName: 'Cliente Arquivo', message }]
  });
  const doCliente = (mensagens) => mensagens.filter((m) => m.direcao === 'entrada');

  it('foto sem legenda: guardada, rotulo "📷 Foto", fila e um aviso', async () => {
    const tel = '5511977002001';
    ganchosDeTeste.baixarMidia = async () => PNG_1X1;
    const { sock } = await conectarEAbrir();
    sock.emitir('messages.upsert', recebida(tel, 'ARQ1', { imageMessage: { mimetype: 'image/png' } }));
    await esperarFimDaResposta(sock);

    const { conversa, mensagens } = await mensagensDoTelefone(tel);
    const [foto] = doCliente(mensagens);
    assert.equal(foto.tipo, 'imagem');
    assert.equal(foto.conteudo, '📷 Foto');
    assert.match(foto.midiaUrl, /^\/api\/arquivos\/anexo-.+\.png$/);
    assert.equal(conversa.status, 'na_fila');
    assert.equal(sock.enviados.length, 1);
    assert.ok(mensagens.some((m) => m.direcao === 'saida' && m.conteudo === sock.enviados[0].text), 'o aviso tambem fica na conversa');
  });

  it('comprovante em PDF (mensagem temporaria): documento guardado com o nome, e vai para a fila', async () => {
    const tel = '5511977002002';
    ganchosDeTeste.baixarMidia = async () => PDF;
    const { sock } = await conectarEAbrir();
    const doc = { documentMessage: { mimetype: 'application/pdf', fileName: 'comprovante.pdf' } };
    sock.emitir('messages.upsert', recebida(tel, 'ARQ2', { ephemeralMessage: { message: doc } }));
    await esperarFimDaResposta(sock);

    const { conversa, mensagens } = await mensagensDoTelefone(tel);
    const [pdf] = doCliente(mensagens);
    assert.equal(pdf.tipo, 'documento');
    assert.equal(pdf.conteudo, '📄 comprovante.pdf');
    assert.match(pdf.midiaUrl, /\.pdf$/);
    assert.equal(pdf.metadados.nomeArquivo, 'comprovante.pdf');
    assert.equal(conversa.status, 'na_fila');
  });

  it('PDF sem nome de arquivo nao e recusado: o tipo da a extensao', async () => {
    const tel = '5511977002003';
    ganchosDeTeste.baixarMidia = async () => PDF;
    const { sock } = await conectarEAbrir();
    sock.emitir('messages.upsert', recebida(tel, 'ARQ3', { documentMessage: { mimetype: 'application/pdf' } }));
    await esperarFimDaResposta(sock);

    const [pdf] = doCliente((await mensagensDoTelefone(tel)).mensagens);
    assert.equal(pdf.tipo, 'documento');
    assert.match(pdf.midiaUrl, /\.pdf$/);
  });

  it('foto COM legenda: guardada, e a legenda segue o fluxo normal (aqui, o menu)', async () => {
    const tel = '5511977002004';
    ganchosDeTeste.baixarMidia = async () => PNG_1X1;
    const { sock } = await conectarEAbrir();
    sock.emitir('messages.upsert', recebida(tel, 'ARQ4', { imageMessage: { mimetype: 'image/png', caption: '1' } }));
    await esperarFimDaResposta(sock);

    const { conversa, mensagens } = await mensagensDoTelefone(tel);
    const [foto] = doCliente(mensagens);
    assert.equal(foto.tipo, 'imagem');
    assert.equal(foto.conteudo, '1');
    assert.equal(foto.metadados.legenda, '1');
    assert.match(sock.enviados[0].text, /serviços e valores/i, 'a legenda "1" foi respondida pelo menu');
    assert.notEqual(conversa.status, 'na_fila');
  });

  it('download falhou: a mensagem entra com o aviso para pedir de novo, e vai para a fila', async () => {
    const tel = '5511977002005';
    ganchosDeTeste.baixarMidia = async () => {
      throw new Error('midia expirada');
    };
    const { sock } = await conectarEAbrir();
    sock.emitir('messages.upsert', recebida(tel, 'ARQ5', { imageMessage: { mimetype: 'image/png' } }));
    await esperarFimDaResposta(sock);

    const { conversa, mensagens } = await mensagensDoTelefone(tel);
    const [msg] = doCliente(mensagens);
    assert.equal(msg.tipo, 'texto');
    assert.match(msg.conteudo, /não foi possível baixar/);
    assert.equal(conversa.status, 'na_fila');
  });

  it('figurinha: registrada na conversa, sem resposta automatica', async () => {
    const tel = '5511977002006';
    const { sock } = await conectarEAbrir();
    sock.emitir('messages.upsert', recebida(tel, 'ARQ6', { stickerMessage: { mimetype: 'image/webp' } }));
    await esperar(async () => doCliente((await mensagensDoTelefone(tel)).mensagens).length === 1, { descricao: 'figurinha gravada' });
    await new Promise((r) => setTimeout(r, 300));

    const { conversa, mensagens } = await mensagensDoTelefone(tel);
    assert.equal(doCliente(mensagens)[0].conteudo, '🙂 Figurinha');
    assert.equal(sock.enviados.length, 0, 'ninguem responde a uma figurinha');
    assert.equal(conversa.status, 'bot');
  });

  it('localizacao e contato viram texto na conversa', async () => {
    const tel = '5511977002007';
    const { sock } = await conectarEAbrir();
    sock.emitir('messages.upsert', recebida(tel, 'ARQ7', { locationMessage: { degreesLatitude: -23.55, degreesLongitude: -46.63 } }));
    sock.emitir('messages.upsert', recebida(tel, 'ARQ8', { contactMessage: { displayName: 'Maria Souza' } }));
    await esperar(async () => doCliente((await mensagensDoTelefone(tel)).mensagens).length === 2, { descricao: 'as duas gravadas' });
    await esperarFimDaResposta(sock).catch(() => {});

    const conteudos = doCliente((await mensagensDoTelefone(tel)).mensagens).map((m) => m.conteudo);
    assert.ok(conteudos.includes('📍 Localização: https://maps.google.com/?q=-23.55,-46.63'), conteudos.join(' | '));
    assert.ok(conteudos.includes('👤 Contato: Maria Souza'));
  });

  it('presenca: "digitando" chega ao cliente certo; conexao fechada ou recusa nunca lancam', async () => {
    // Sem conexao aberta: nao faz nada e nao lanca.
    await presenca({ tenantId, instanciaChave: 'W1', destino: '5511977002009', estado: 'composing' });

    const { sock } = await conectarEAbrir();
    await presenca({ tenantId, instanciaChave: 'W1', destino: '11977002009', estado: 'composing' });
    await presenca({ tenantId, instanciaChave: 'W1', destino: '5511977002009', estado: 'paused' });
    assert.deepEqual(sock.presencas, [
      { estado: 'composing', jid: '5511977002009@s.whatsapp.net' },
      { estado: 'paused', jid: '5511977002009@s.whatsapp.net' }
    ]);

    sock.falharPresenca = true;
    await presenca({ tenantId, instanciaChave: 'W1', destino: '5511977002009', estado: 'composing' });
  });

  it('mensagem temporaria de texto e respondida (antes o cliente falava sozinho)', async () => {
    const tel = '5511977002008';
    const { sock } = await conectarEAbrir();
    sock.emitir('messages.upsert', recebida(tel, 'ARQ9', { ephemeralMessage: { message: { extendedTextMessage: { text: '1' } } } }));
    await esperarFimDaResposta(sock);
    assert.match(sock.enviados[0].text, /serviços e valores/i);
  });
});

describe('reconexao ao iniciar o sistema', () => {
  it('reconecta so quem estava em uso, ativo e com sessao salva', async () => {
    const { and, eq } = await import('drizzle-orm');

    await criarInstanciaNoBanco('W2', { status: 'conectado' }); // deve reconectar
    await criarInstanciaNoBanco('W3', { status: 'conectado' }); // sem sessao em disco
    await criarInstanciaNoBanco('W4', { status: 'aguardando_qr', qrCode: 'data:x' }); // QR morto
    await criarInstanciaNoBanco('W5', { status: 'conectado', ativo: false }); // desativada
    await db
      .update(tabela)
      .set({ status: 'desconectado' })
      .where(and(eq(tabela.tenantId, tenantId), eq(tabela.chave, 'W1'))); // desligada de proposito

    // A W3 fica SEM sessao em disco de proposito.
    for (const c of ['W1', 'W2', 'W5']) criarSessaoEmDisco(c);

    await reconectarInstanciasSalvas();

    assert.equal(fabricados.length, 1, 'so a W2 reconecta');
    assert.ok(!estaConectada(tenantId, 'W1'));

    assert.equal((await instancia('W3')).status, 'desconectado');
    assert.match((await instancia('W3')).ultimoErro, /não foi encontrada/);

    const w4 = await instancia('W4');
    assert.equal(w4.status, 'desconectado');
    assert.equal(w4.qrCode, null, 'QR de antes do reinicio nao serve mais');

    assert.equal((await instancia('W5')).status, 'conectado', 'desativada nao e tocada');

    // Queda de rede na hora do reinicio (status "erro") tambem volta.
    encerrarTodas();
    fabricados.length = 0;
    await db.update(tabela).set({ status: 'erro' }).where(and(eq(tabela.tenantId, tenantId), eq(tabela.chave, 'W2')));
    await reconectarInstanciasSalvas();
    assert.equal(fabricados.length, 1);
  });
});

describe('respostas do atendente chegam ao cliente (ou avisam que nao chegaram)', () => {
  let conversaId;
  const telefoneCliente = '5511955554444';
  let atendenteNovo;
  let usuarioDev;
  let cabDev;

  async function responder(texto, cab = cabRecepcao) {
    return app.inject({
      method: 'POST',
      url: `/api/conversas/${conversaId}/mensagens`,
      headers: cab,
      payload: { conteudo: texto }
    });
  }
  async function mensagens() {
    const res = await app.inject({ method: 'GET', url: `/api/conversas/${conversaId}/mensagens`, headers: cabDono });
    return res.json().mensagens;
  }
  const reenviar = (id, cab = cabRecepcao, conversa = conversaId) =>
    app.inject({ method: 'POST', url: `/api/conversas/${conversa}/mensagens/${id}/reenviar`, headers: cab });

  before(async () => {
    // Um segundo atendente, para provar que conversa de um nao e mexida por outro.
    const r = await app.inject({
      method: 'POST',
      url: '/api/usuarios',
      headers: cabDono,
      payload: { username: 'outro.atendente', senha: 'senha-longa-123', nome: 'Outro Atendente', cargo: 'atendente' }
    });
    atendenteNovo = r.json().usuario;

    const { garantirUsuarioDev } = await import('../src/db/usuario-dev.js');
    ({ usuario: usuarioDev } = await garantirUsuarioDev({
      username: 'dev.entrega',
      nome: 'Dev Entrega',
      senha: 'senha-dev-12345'
    }));
    ({ cabecalho: cabDev } = await entrar(app, 'dev.entrega', 'senha-dev-12345'));
  });

  it('entrega a resposta pelo WhatsApp e grava que foi entregue', async () => {
    const { sock } = await conectarEAbrir();
    sock.emitir('messages.upsert', mensagemRecebida({ de: telefoneCliente, id: 'IN_conv' }));
    await esperarFimDaResposta(sock);

    const lista = await app.inject({ method: 'GET', url: '/api/conversas', headers: cabDono });
    conversaId = lista.json().itens.find((c) => c.leadTelefone === telefoneCliente).id;
    const antes = sock.enviados.length;

    const res = await responder('Olá, aqui é a Beatriz. Posso ajudar?');
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(res.json().entrega, { entregue: true });

    assert.equal(sock.enviados.length, antes + 1);
    assert.equal(sock.enviados.at(-1).jid, `${telefoneCliente}@s.whatsapp.net`);
    assert.equal(sock.enviados.at(-1).text, 'Olá, aqui é a Beatriz. Posso ajudar?');

    const ultima = (await mensagens()).at(-1);
    assert.equal(ultima.autorTipo, 'humano');
    assert.ok(ultima.entregueEm);
    assert.equal(ultima.erroEnvio, null);
  });

  /**
   * O audio gravado pelo atendente precisa chegar como MENSAGEM DE VOZ de
   * verdade (a bolha de microfone com a onda sonora), nao um anexo generico —
   * e por isso `ptt: true` e o formato `ogg/opus`, que e o que o proprio
   * WhatsApp grava. Ver core/audio.js para o porque da conversao.
   */
  it('audio gravado pelo atendente chega como mensagem de voz (ptt), convertido para ogg/opus', async () => {
    const { sock } = await conectarEAbrir();
    const antes = sock.enviados.length;

    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${conversaId}/mensagens`,
      headers: cabRecepcao,
      payload: { audio: audioDataUrl(), duracaoSegundos: 2.5 }
    });

    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(res.json().entrega, { entregue: true });

    assert.equal(sock.enviados.length, antes + 1);
    const ultimoEnvio = sock.enviados.at(-1);
    assert.equal(ultimoEnvio.jid, `${telefoneCliente}@s.whatsapp.net`);
    assert.equal(ultimoEnvio.ptt, true, 'sem isto o WhatsApp mostra um anexo, nao a bolha de voz');
    assert.equal(ultimoEnvio.mimetype, 'audio/ogg; codecs=opus');
    assert.ok(Buffer.isBuffer(ultimoEnvio.audio) && ultimoEnvio.audio.length > 0, 'os bytes precisam ser o arquivo de verdade');
    // O container e ogg (assinatura "OggS"), nao mais webm — a conversao aconteceu.
    assert.equal(ultimoEnvio.audio.subarray(0, 4).toString('ascii'), 'OggS');

    const ultima = (await mensagens()).at(-1);
    assert.equal(ultima.tipo, 'audio');
    assert.ok(ultima.entregueEm);
    assert.match(ultima.midiaUrl, /\.ogg$/);
  });

  it('foto com legenda chega como imagem, e documento chega com o nome original', async () => {
    const { sock } = await conectarEAbrir();
    const antes = sock.enviados.length;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

    const foto = await app.inject({
      method: 'POST',
      url: `/api/conversas/${conversaId}/mensagens`,
      headers: cabRecepcao,
      payload: { conteudo: 'Olha o corte', anexo: { dataUrl: `data:image/png;base64,${png.toString('base64')}`, nome: 'corte.png' } }
    });
    assert.equal(foto.statusCode, 201, foto.body);
    assert.deepEqual(foto.json().entrega, { entregue: true });
    const envioFoto = sock.enviados.at(-1);
    assert.ok(Buffer.isBuffer(envioFoto.image) && envioFoto.image.equals(png), 'manda os bytes da foto');
    assert.equal(envioFoto.caption, 'Olha o corte');

    const doc = await app.inject({
      method: 'POST',
      url: `/api/conversas/${conversaId}/mensagens`,
      headers: cabRecepcao,
      payload: { anexo: { dataUrl: `data:application/pdf;base64,${Buffer.from('%PDF-1.4 teste').toString('base64')}`, nome: 'Tabela de preços.pdf' } }
    });
    assert.equal(doc.statusCode, 201, doc.body);
    const envioDoc = sock.enviados.at(-1);
    assert.equal(sock.enviados.length, antes + 2);
    assert.equal(envioDoc.fileName, 'Tabela de preços.pdf');
    assert.equal(envioDoc.mimetype, 'application/pdf');
    assert.equal(envioDoc.caption, undefined);
  });

  it('WhatsApp fora do ar: a resposta fica SALVA, marcada como nao entregue, e o console avisa', async () => {
    // Nenhum socket conectado (afterEach zerou tudo).
    const res = await responder('Ainda aí?');
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().entrega.entregue, false);
    assert.match(res.json().entrega.erro, /não está conectada/);

    const ultima = (await mensagens()).at(-1);
    assert.equal(ultima.conteudo, 'Ainda aí?');
    assert.equal(ultima.entregueEm, null);
    assert.match(ultima.erroEnvio, /não está conectada/);

    assert.ok(listarEventos(tenantId).some((e) => e.tipo === 'envio' && e.nivel === 'erro'));
    assert.doesNotMatch(JSON.stringify(listarEventos(tenantId)), new RegExp(telefoneCliente), 'so o telefone mascarado');
  });

  it('o WhatsApp recusar o envio tambem vira "nao entregue", com o motivo', async () => {
    const { sock } = await conectarEAbrir();
    sock.falharEnvio = 'Connection Closed';

    const res = await responder('Tem horário hoje?');
    assert.equal(res.statusCode, 201);
    assert.match(res.json().entrega.erro, /Connection Closed/);
    assert.match((await mensagens()).at(-1).erroEnvio, /Connection Closed/);
  });

  it('quem nao e o responsavel nao reenvia a mensagem do colega', async () => {
    const { cabecalho: cabOutro } = await entrar(app, 'outro.atendente', 'senha-longa-123');
    const falhada = (await mensagens()).filter((m) => m.erroEnvio && m.autorTipo === 'humano').at(-1);

    const res = await reenviar(falhada.id, cabOutro);
    assert.equal(res.statusCode, 403);
    assert.ok(atendenteNovo.id);
  });

  it('reenviar entrega e depois recusa reenviar de novo (nada duplica no celular do cliente)', async () => {
    const falhadas = (await mensagens()).filter((m) => m.erroEnvio && m.autorTipo === 'humano');
    assert.ok(falhadas.length >= 2);

    const { sock } = await conectarEAbrir();
    const alvo = falhadas.find((m) => m.conteudo === 'Ainda aí?');
    const antes = sock.enviados.length;

    const res = await reenviar(alvo.id);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().entrega, { entregue: true });
    assert.equal(sock.enviados.length, antes + 1);
    assert.equal(sock.enviados.at(-1).text, 'Ainda aí?');

    const depois = (await mensagens()).find((m) => m.id === alvo.id);
    assert.ok(depois.entregueEm);
    assert.equal(depois.erroEnvio, null);
    assert.ok(listarEventos(tenantId).some((e) => e.nivel === 'sucesso' && /reenvio/.test(e.mensagem)));

    const outra = await reenviar(alvo.id);
    assert.equal(outra.statusCode, 200);
    assert.equal(outra.json().entrega.jaEntregue, true);
    assert.equal(sock.enviados.length, antes + 1, 'o reenvio de algo entregue nao manda de novo');
  });

  it('dois cliques em "Reenviar" ao mesmo tempo mandam UMA vez', async () => {
    const { sock } = await conectarEAbrir();
    sock.falharEnvio = 'Connection Closed';
    const r = await responder('Mensagem do clique duplo');
    assert.equal(r.json().entrega.entregue, false);
    const id = (await mensagens()).at(-1).id;

    sock.falharEnvio = null;
    sock.atrasoEnvio = 100;
    const antes = sock.enviados.length;

    const [a, b] = await Promise.all([reenviar(id), reenviar(id)]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    assert.equal(sock.enviados.length, antes + 1);
  });

  it('so respostas de atendente que falharam podem ser reenviadas', async () => {
    const todas = await mensagens();

    const doMenu = todas.find((m) => m.autorTipo === 'menu' || m.autorTipo === 'ia');
    assert.equal((await reenviar(doMenu.id)).statusCode, 422);

    const entrada = todas.find((m) => m.direcao === 'entrada');
    assert.equal((await reenviar(entrada.id)).statusCode, 422);

    assert.equal((await reenviar('msg_inexistente')).statusCode, 404);
  });

  it('a mensagem nao e alcancada por um id de outra conversa', async () => {
    const outra = await receberMensagem({
      tenantId,
      canal: 'whatsapp',
      instanciaChave: 'W1',
      remetente: '5511933332222',
      texto: '1',
      idExterno: 'IN_outra'
    });
    const alvo = (await mensagens()).find((m) => m.autorTipo === 'humano');
    const res = await reenviar(alvo.id, cabRecepcao, outra.conversationId);
    assert.equal(res.statusCode, 404);
  });

  it('atendente nao pode escolher o DEV como destino de uma transferencia', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/conversas/${conversaId}/transferir`,
      headers: cabRecepcao,
      payload: { paraUserId: usuarioDev.id, motivo: 'teste' }
    });
    assert.equal(res.statusCode, 404);
    assert.match(res.json().erro.mensagem, /Atendente de destino/);
  });

  it('conversa de uma conexao removida diz isso, em vez de tentar enviar', async () => {
    await criarInstanciaNoBanco('W2', { status: 'desconectado' });
    const r = await receberMensagem({
      tenantId,
      canal: 'whatsapp',
      instanciaChave: 'W2',
      remetente: '5511922221111',
      texto: '1',
      idExterno: 'IN_w2'
    });

    // Responde com a conexao ainda existente (falha por estar desconectada)...
    const antes = await app.inject({
      method: 'POST',
      url: `/api/conversas/${r.conversationId}/mensagens`,
      headers: cabRecepcao,
      payload: { conteudo: 'antes de remover' }
    });
    assert.match(antes.json().entrega.erro, /"W2"/);

    // ...e depois de removida a conexao.
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/canais/W2', headers: cabDev })).statusCode, 200);

    const depois = await app.inject({
      method: 'POST',
      url: `/api/conversas/${r.conversationId}/mensagens`,
      headers: cabRecepcao,
      payload: { conteudo: 'depois de remover' }
    });
    assert.match(depois.json().entrega.erro, /removida/);
  });

  it('a lista de mensagens traz entregueEm e erroEnvio', async () => {
    const todas = await mensagens();
    for (const m of todas) {
      assert.ok('entregueEm' in m && 'erroEnvio' in m);
    }
  });
});

describe('a resposta sai pelo numero em que o cliente fala', () => {
  const telefone = '5511900001111';
  let usuarioReceb;

  async function novaConversa(remetente, instanciaChave = 'W1') {
    const r = await receberMensagem({
      tenantId,
      canal: 'whatsapp',
      instanciaChave,
      remetente,
      texto: '1',
      idExterno: `IN_rot_${++sequenciaMsg}`
    });
    return r.conversationId;
  }
  const responder = (id, texto) =>
    app.inject({
      method: 'POST',
      url: `/api/conversas/${id}/mensagens`,
      headers: cabRecepcao,
      payload: { conteudo: texto }
    });

  before(() => {
    usuarioReceb = null;
  });

  it('o MESMO cliente escrevendo para dois numeros gera DUAS conversas, cada uma respondida pelo seu numero', async () => {
    await criarInstanciaNoBanco('W2', { status: 'desconectado' });
    const w1 = await conectarEAbrir('W1');
    const w2 = await conectarEAbrir('W2');

    const idW1 = await novaConversa(telefone, 'W1');
    const idW2 = await novaConversa(telefone, 'W2');
    assert.notEqual(idW1, idW2, 'uma conversa por conexao');

    // Nova mensagem em cada numero: reaproveita a conversa do respectivo numero.
    assert.equal(await novaConversa(telefone, 'W1'), idW1);
    assert.equal(await novaConversa(telefone, 'W2'), idW2);

    // A lista traz as duas, cada uma dizendo de qual conexao e — e o filtro separa.
    const todas = (await app.inject({ method: 'GET', url: '/api/conversas', headers: cabDono })).json().itens;
    const doCliente = todas.filter((c) => c.leadTelefone === telefone);
    assert.deepEqual(doCliente.map((c) => c.canalChave).sort(), ['W1', 'W2']);

    const soW2 = (await app.inject({ method: 'GET', url: '/api/conversas?instancia=W2', headers: cabDono })).json().itens;
    assert.ok(soW2.length >= 1 && soW2.every((c) => c.canalChave === 'W2'));
    const semTelegram = (await app.inject({ method: 'GET', url: '/api/conversas?canal=telegram', headers: cabDono })).json().itens;
    assert.equal(semTelegram.length, 0);
    const whatsapp = (await app.inject({ method: 'GET', url: '/api/conversas?canal=whatsapp', headers: cabDono })).json().itens;
    assert.ok(whatsapp.length >= 2);
    assert.equal((await app.inject({ method: 'GET', url: '/api/conversas?canal=fax', headers: cabDono })).statusCode, 400);

    // Cada resposta sai pelo numero da conversa.
    assert.deepEqual((await responder(idW1, 'Pela W1')).json().entrega, { entregue: true });
    assert.deepEqual((await responder(idW2, 'Pela W2')).json().entrega, { entregue: true });
    assert.ok(w1.sock.enviados.some((e) => e.text === 'Pela W1') && !w1.sock.enviados.some((e) => e.text === 'Pela W2'));
    assert.ok(w2.sock.enviados.some((e) => e.text === 'Pela W2') && !w2.sock.enviados.some((e) => e.text === 'Pela W1'));
  });

  it('conversa antiga sem conexao gravada e adotada pela primeira mensagem, sem abrir uma segunda', async () => {
    const { conversations } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    await conectarEAbrir('W1');

    const id = await novaConversa('5511900007777', 'W1');
    await db.update(conversations).set({ channelInstanceId: null }).where(eq(conversations.id, id));

    assert.equal(await novaConversa('5511900007777', 'W1'), id);
    const linha = await db.query.conversations.findFirst({ where: eq(conversations.id, id) });
    assert.ok(linha.channelInstanceId, 'a conversa passou a ter a conexao');
  });

  it('conversa sem conexao gravada usa a da ultima mensagem do cliente — nunca um padrao', async () => {
    const { and, eq } = await import('drizzle-orm');
    const { conversations } = await import('../src/db/schema/index.js');
    const f = await conectarEAbrir('W1');

    const id = await novaConversa('5511900002222', 'W1');
    await db.update(conversations).set({ channelInstanceId: null }).where(eq(conversations.id, id));

    const ok = await responder(id, 'Pela conta certa');
    assert.deepEqual(ok.json().entrega, { entregue: true });
    assert.equal(f.sock.enviados.at(-1).text, 'Pela conta certa');

    // Sem NENHUMA pista de conta (nem na conversa nem nas mensagens): avisa, nao chuta.
    const { messages } = await import('../src/db/schema/index.js');
    await db.update(messages).set({ metadados: {} }).where(and(eq(messages.conversationId, id), eq(messages.direcao, 'entrada')));
    const antes = f.sock.enviados.length;
    const sem = await responder(id, 'Sem pista');
    assert.equal(sem.json().entrega.entregue, false);
    assert.match(sem.json().entrega.erro, /descobrir/);
    assert.equal(f.sock.enviados.length, antes);
  });

  it('reenviar depois que a conversa foi finalizada ou devolvida para a IA e recusado', async () => {
    const f = await conectarEAbrir('W1');
    f.sock.falharEnvio = 'Connection Closed';

    const id = await novaConversa('5511900003333', 'W1');
    await responder(id, 'Mensagem que falhou');
    f.sock.falharEnvio = null;

    const lista = await app.inject({ method: 'GET', url: `/api/conversas/${id}/mensagens`, headers: cabDono });
    const falhada = lista.json().mensagens.find((m) => m.erroEnvio && m.autorTipo === 'humano');
    const enviadosAntes = f.sock.enviados.length;
    const reenviar = () =>
      app.inject({ method: 'POST', url: `/api/conversas/${id}/mensagens/${falhada.id}/reenviar`, headers: cabRecepcao });

    await app.inject({ method: 'POST', url: `/api/conversas/${id}/devolver`, headers: cabRecepcao });
    const devolvida = await reenviar();
    assert.equal(devolvida.statusCode, 422);
    assert.match(devolvida.json().erro.mensagem, /não está mais com um atendente/);

    await app.inject({ method: 'POST', url: `/api/conversas/${id}/assumir`, headers: cabRecepcao });
    await app.inject({ method: 'POST', url: `/api/conversas/${id}/finalizar`, headers: cabRecepcao, payload: {} });
    const finalizada = await reenviar();
    assert.equal(finalizada.statusCode, 422);
    assert.match(finalizada.json().erro.mensagem, /finalizada/);

    assert.equal(f.sock.enviados.length, enviadosAntes, 'nada pode ter saido');
  });

  it('se o WhatsApp nao confirmar o envio, avisa para conferir no celular antes de reenviar', async () => {
    const f = await conectarEAbrir('W1');
    f.sock.sendMessage = async () => {
      throw new Error('O WhatsApp nao respondeu a tempo.');
    };
    const id = await novaConversa('5511900004444', 'W1');
    const r = await responder(id, 'Sem confirmacao');
    assert.match(r.json().entrega.erro, /Confira no celular/);
  });
});

describe('sincronizar nomes de novos contatos', () => {
  it('ligada (padrao) troca "Contato WhatsApp" pelo nome do perfil; desligada nao; nome digitado nunca muda', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const { sock } = await conectarEAbrir();

    await leads.encontrarOuCriarPorTelefone(tenantId, '5511900005555', 'Contato WhatsApp');
    await leads.encontrarOuCriarPorTelefone(tenantId, '5511900006666', 'Nome Digitado Pela Recepcao');

    // Desligada: o nome do perfil nao entra no cadastro.
    await definirConfig('W1', { sincronizarContatos: false });
    sock.emitir('messages.upsert', mensagemRecebida({ de: '5511900005555', id: 'IN_s1', extra: { msg: { pushName: 'Maria Souza' } } }));
    await esperarFimDaResposta(sock);
    let l = await app.inject({ method: 'GET', url: '/api/leads?busca=900005555', headers: cabDono });
    assert.equal(l.json().itens[0].nome, 'Contato WhatsApp');

    // Sem nada configurado, vale o padrao: ligada.
    await definirConfig('W1', {});
    sock.enviados.length = 0;
    sock.emitir('messages.upsert', mensagemRecebida({ de: '5511900005555', id: 'IN_s2', extra: { msg: { pushName: 'Maria Souza' } } }));
    await esperar(async () => {
      const r = await app.inject({ method: 'GET', url: '/api/leads?busca=900005555', headers: cabDono });
      return r.json().itens[0].nome === 'Maria Souza';
    });

    // Um nome que alguem digitou no cadastro nunca e sobrescrito.
    sock.emitir('messages.upsert', mensagemRecebida({ de: '5511900006666', id: 'IN_s3', extra: { msg: { pushName: 'Apelido do Zap' } } }));
    await esperar(() => sock.enviados.length >= 2);
    l = await app.inject({ method: 'GET', url: '/api/leads?busca=900006666', headers: cabDono });
    assert.equal(l.json().itens[0].nome, 'Nome Digitado Pela Recepcao');
  });
});

// ============================================================================

/**
 * Recado de voz do cliente.
 *
 * O caminho inteiro sem WhatsApp e sem API de transcricao: o gancho
 * `baixarMidia` entrega os bytes (a funcao real precisa das chaves de
 * criptografia de uma mensagem de verdade) e `transcrever` devolve o texto.
 * O que se prova aqui e o que o SISTEMA faz com o audio depois disso.
 */
describe('audio recebido do cliente', () => {
  const BYTES = Buffer.from('audio-de-mentira-para-o-teste');

  function audioRecebido({ de, id, segundos = 7 }) {
    return {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: `${de}@s.whatsapp.net`, fromMe: false, id },
          pushName: 'Cliente do Audio',
          message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: segundos, ptt: true } }
        }
      ]
    };
  }

  /**
   * A conversa daquele telefone, pelo banco.
   *
   * Pelo banco e nao pela API porque o teste precisa achar a conversa de UM
   * cliente, e a listagem de conversas nao filtra por cliente — pegar
   * `itens[0]` devolveria a conversa mais recente, que pode ser a de outro
   * teste. As MENSAGENS continuam vindo pela API: e o mesmo caminho que a tela
   * usa, com permissao e tudo.
   */
  const mensagensDe = async (telefone) => {
    const { eq, and } = await import('drizzle-orm');
    const s = await import('../src/db/schema/index.js');

    const [lead] = await db.select().from(s.leads).where(eq(s.leads.telefone, telefone));
    if (!lead) return { conversa: null, mensagens: [] };

    const [conversa] = await db
      .select()
      .from(s.conversations)
      .where(and(eq(s.conversations.tenantId, tenantId), eq(s.conversations.leadId, lead.id)));
    if (!conversa) return { conversa: null, mensagens: [] };

    const m = await app.inject({ method: 'GET', url: `/api/conversas/${conversa.id}/mensagens`, headers: cabDono });
    return { conversa, mensagens: m.json().mensagens };
  };

  it('transcreve, guarda o arquivo e a transcricao vira o texto que a IA le', async () => {
    const telefone = '5511977001001';
    ganchosDeTeste.baixarMidia = async () => BYTES;
    ganchosDeTeste.transcrever = async () => ({ texto: 'Oi, queria marcar um corte pra sexta', provedor: 'groq', modelo: 'whisper' });

    const { sock } = await conectarEAbrir();
    sock.emitir('messages.upsert', audioRecebido({ de: telefone, id: 'AUD1' }));

    await esperarFimDaResposta(sock);
    const { mensagens } = await mensagensDe(telefone);
    const audio = mensagens.find((m) => m.tipo === 'audio');

    assert.ok(audio, 'o audio precisa virar mensagem na conversa');
    assert.match(audio.midiaUrl, /^\/api\/arquivos\/audio-.+\.ogg$/, 'o arquivo fica guardado e tem endereco proprio');
    assert.equal(audio.transcricao, 'Oi, queria marcar um corte pra sexta');
    // O MESMO texto no conteudo: e por ele que a previa da lista, a busca e o
    // historico que vai para a Sofia funcionam sem nenhum remendo.
    assert.equal(audio.conteudo, 'Oi, queria marcar um corte pra sexta');
    assert.equal(audio.metadados.duracaoSegundos, 7, 'a duracao do canal alimenta a barra do player');
  });

  it('o arquivo guardado pode ser tocado, e aceita pedido por faixa (arrastar a barra)', async () => {
    const telefone = '5511977001002';
    ganchosDeTeste.baixarMidia = async () => BYTES;
    ganchosDeTeste.transcrever = async () => ({ texto: 'quero ver os precos', provedor: 'groq', modelo: 'whisper' });

    const { sock } = await conectarEAbrir();
    sock.emitir('messages.upsert', audioRecebido({ de: telefone, id: 'AUD2' }));
    await esperarFimDaResposta(sock);

    const { mensagens } = await mensagensDe(telefone);
    const url = mensagens.find((m) => m.tipo === 'audio').midiaUrl;

    const inteiro = await app.inject({ method: 'GET', url });
    assert.equal(inteiro.statusCode, 200);
    assert.equal(inteiro.headers['content-type'], 'audio/ogg');
    assert.equal(inteiro.headers['accept-ranges'], 'bytes', 'sem isto o player nao deixa arrastar a barra');
    assert.equal(inteiro.rawPayload.length, BYTES.length);

    const faixa = await app.inject({ method: 'GET', url, headers: { range: 'bytes=0-4' } });
    assert.equal(faixa.statusCode, 206);
    assert.equal(faixa.headers['content-range'], `bytes 0-4/${BYTES.length}`);
    assert.equal(faixa.rawPayload.toString(), BYTES.subarray(0, 5).toString());
  });

  /**
   * Sem transcricao a IA responderia no escuro: ela nao ouve o arquivo, so
   * leria o rotulo e inventaria um assunto. Vale a mesma regra de quando a IA
   * falha — o cliente fala com gente.
   */
  it('quando nao da para transcrever, o audio fica salvo e a conversa vai para a fila humana', async () => {
    const telefone = '5511977001003';
    ganchosDeTeste.baixarMidia = async () => BYTES;
    ganchosDeTeste.transcrever = async () => null;

    const { sock } = await conectarEAbrir();
    sock.emitir('messages.upsert', audioRecebido({ de: telefone, id: 'AUD3' }));

    await esperar(async () => (await mensagensDe(telefone)).conversa?.status === 'na_fila', {
      descricao: 'a conversa ir para a fila'
    });

    const { conversa, mensagens } = await mensagensDe(telefone);
    const audio = mensagens.find((m) => m.tipo === 'audio');

    assert.equal(conversa.status, 'na_fila');
    assert.ok(audio.midiaUrl, 'o recado nao pode ser perdido: o arquivo fica guardado para alguem ouvir');
    assert.equal(audio.transcricao, null);
    assert.equal(sock.enviados.length, 0, 'a IA nao pode responder um audio que ninguem entendeu');
  });

  it('se nem baixar o audio der certo, o console avisa e nada quebra', async () => {
    ganchosDeTeste.baixarMidia = async () => {
      throw new Error('midia fora do ar');
    };

    const { sock } = await conectarEAbrir();
    sock.emitir('messages.upsert', audioRecebido({ de: '5511977001004', id: 'AUD4' }));

    await esperar(() => listarEventos(tenantId).some((e) => /Não consegui baixar o áudio/.test(e.mensagem)), {
      descricao: 'o aviso no console de conexoes'
    });
    assert.equal(sock.enviados.length, 0);
  });
});
