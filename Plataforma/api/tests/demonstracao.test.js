import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { env } from '../src/config/env.js';
import { garantirUsuarioDev } from '../src/db/usuario-dev.js';

/**
 * Banco de DEMONSTRACAO: o DEV liga no navegador dele e passa a ver uma
 * empresa ficticia, enquanto o resto do sistema segue no banco de verdade.
 * O que mais importa: nada feito na demonstracao sai pelo WhatsApp real.
 */

let app;
let dev;
let dono;
const chaveOriginal = env.DEV_ARQUIVO_CHAVE;
const COOKIE = { cookie: 'plataforma_demonstracao=1' };

const pedir = (method, url, cab, payload) => app.inject({ method, url, headers: cab, payload });

async function esperarGeracao() {
  for (let i = 0; i < 600; i++) {
    const r = (await pedir('GET', '/api/dev/demonstracao', dev)).json();
    if (!r.geracao.rodando) return r;
    await new Promise((ok) => setTimeout(ok, 250));
  }
  throw new Error('A geracao nao terminou a tempo');
}

before(async () => {
  ({ app } = await criarAppDeTeste());
  const pasta = mkdtempSync(join(tmpdir(), 'dev-chave-'));
  env.DEV_ARQUIVO_CHAVE = join(pasta, 'chave');
  writeFileSync(env.DEV_ARQUIVO_CHAVE, 'ok');
  await garantirUsuarioDev({ username: 'dev.demo', nome: 'Dev Demo', senha: 'senha-do-dev-demo-1' });
  dev = (await entrar(app, 'dev.demo', 'senha-do-dev-demo-1')).cabecalho;
  dono = (await entrar(app)).cabecalho;
});

after(async () => {
  // Nao deixa o arquivo da demonstracao dos testes para tras.
  await pedir('DELETE', '/api/dev/demonstracao', dev).catch(() => {});
  env.DEV_ARQUIVO_CHAVE = chaveOriginal;
  await app?.close();
});

describe('banco de demonstracao', () => {
  it('so o DEV ve a rota (para os outros ela nao existe)', async () => {
    assert.equal((await pedir('GET', '/api/dev/demonstracao', dono)).statusCode, 404);
  });

  it('gera 3 meses de empresa ficticia: 20 profissionais, 5 atendentes, 40 servicos, 100+ produtos', { timeout: 180_000 }, async () => {
    const r = await pedir('POST', '/api/dev/demonstracao/gerar', dev);
    assert.equal(r.statusCode, 202, r.body);
    const estado = await esperarGeracao();
    assert.equal(estado.geracao.erro, null);
    assert.equal(estado.existe, true);
    const x = estado.resumo;
    assert.equal(x.profissionais, 20);
    assert.equal(x.servicos, 40);
    assert.ok(x.produtos >= 100, `produtos: ${x.produtos}`);
    assert.ok(x.equipe >= 7, 'dono, gerente e 5 atendentes');
    assert.ok(x.conversas > 1000, `conversas: ${x.conversas}`);
    assert.ok(x.agendamentos > 3000, `agendamentos: ${x.agendamentos}`);
    assert.ok(x.campanhas >= 5);
  });

  it('com a demonstracao ligada, o DEV ve a empresa ficticia; sem ela, a real', async () => {
    assert.equal((await pedir('POST', '/api/dev/demonstracao/entrar', dev)).statusCode, 200);

    const eu = (await pedir('GET', '/api/auth/eu', { ...dev, ...COOKIE })).json().usuario;
    assert.equal(eu.demonstracao, true);

    const naDemo = (await pedir('GET', '/api/profissionais', { ...dev, ...COOKIE })).json().profissionais;
    const noReal = (await pedir('GET', '/api/profissionais', dev)).json().profissionais;
    assert.equal(naDemo.length, 19, '20 cadastrados, 1 inativo');
    assert.ok(noReal.length < 19, 'o banco real continua com os seus');
  });

  it('o cookie da demonstracao nao vale para quem nao e DEV', async () => {
    const eu = (await pedir('GET', '/api/auth/eu', { ...dono, ...COOKIE })).json().usuario;
    assert.equal(eu.demonstracao, undefined);
  });

  it('a mesa ja vem cheia: conversas com a IA, na fila e com cada atendente', async () => {
    const lista = (filtro) => pedir('GET', `/api/conversas?filtro=${filtro}`, { ...dev, ...COOKIE }).then((r) => r.json().itens);
    assert.ok((await lista('fila')).length >= 5);
    assert.ok((await lista('bot')).length >= 10);
    assert.ok((await lista('ativas')).length >= 30);
  });

  /**
   * A demonstracao precisa mostrar o sistema de HOJE, nao o de antes: a
   * Sofia consultando direto, a Atena so gravando, visitas de varios servicos
   * em sequencia, horario da IA com responsavel, cartoes que piscam no quadro.
   */
  describe('segue os parametros atuais do sistema', () => {
    const q = async (sql) => {
      const { abrir } = await import('../src/modules/demonstracao/demonstracao.js');
      return (await (await abrir()).client.execute(sql)).rows;
    };

    it('a Atena so aparece para gravar, com origem propria; a Sofia consulta direto', async () => {
      const porOrigem = Object.fromEntries((await q(`select origem, agent_key, count(*) n from ai_calls group by 1, 2`)).map((r) => [`${r.origem}|${r.agent_key}`, Number(r.n)]));
      assert.ok(porOrigem['atena|atena'] > 0, JSON.stringify(porOrigem));
      assert.ok(porOrigem['atendimento|atendente'] > porOrigem['atena|atena'] * 2, 'a Sofia faz a maior parte');
      assert.equal(porOrigem['atendimento|atena'], undefined, 'o formato antigo (Atena como "atendimento") nao existe mais');
      assert.ok(porOrigem['humor|null'] > 0, 'a leitura de humor tambem aparece nas metricas');

      // Conversa so de preco (catalogo no prompt) nao acorda a Atena.
      const [precoComAtena] = await q(`select count(*) n from ai_calls a join conversations c on c.id = a.conversation_id where a.origem = 'atena' and c.resumo like 'Perguntou o preço%'`);
      assert.equal(Number(precoComAtena.n), 0);
    });

    it('visitas com varios servicos: em sequencia, mesmo cliente, marcadas pela IA, ligadas a conversa', async () => {
      const grupos = await q(`select conversation_id, count(*) n from appointments where conversation_id is not null group by 1 having n >= 2`);
      assert.ok(grupos.length >= 20, `visitas: ${grupos.length}`);

      for (const g of grupos.slice(0, 40)) {
        const aps = await q(`select lead_id, criado_por, inicio_em, fim_em, status, responsavel_user_id from appointments where conversation_id = '${g.conversation_id}' order by inicio_em`);
        assert.equal(new Set(aps.map((a) => a.lead_id)).size, 1, 'mesmo cliente');
        assert.ok(aps.every((a) => a.criado_por === 'ia'));
        assert.equal(new Set(aps.map((a) => a.responsavel_user_id)).size, 1, 'um responsavel para a visita inteira');
        for (let i = 1; i < aps.length; i++) {
          const espera = (Number(aps[i].inicio_em) - Number(aps[i - 1].fim_em)) / 60_000;
          assert.ok(espera >= 0 && espera <= 10, `espera entre servicos: ${espera} min`);
        }
        const passados = aps.filter((a) => ['concluido', 'faltou', 'cancelado'].includes(a.status));
        if (passados.length === aps.length) assert.equal(new Set(aps.map((a) => a.status)).size, 1, 'a visita inteira tem o mesmo destino');
      }
    });

    it('horario marcado pela IA sempre tem um atendente responsavel', async () => {
      const [semDono] = await q(`select count(*) n from appointments where criado_por = 'ia' and responsavel_user_id is null`);
      assert.equal(Number(semDono.n), 0);
    });

    it('a Sofia fala a data por extenso, sem **negrito** de Markdown', async () => {
      const [comMarkdown] = await q(`select count(*) n from messages where autor_tipo = 'ia' and conteudo like '%**%'`);
      assert.equal(Number(comMarkdown.n), 0);
      const [porExtenso] = await q(`select count(*) n from messages where autor_tipo = 'ia' and conteudo like '%-feira, __/__%'`);
      assert.ok(Number(porExtenso.n) > 50, `mensagens com data por extenso: ${porExtenso.n}`);
    });

    it('no quadro, piscam a fila e as conversas em que o cliente espera o atendente — nao todas', async () => {
      const quadro = (await pedir('GET', '/api/quadro', { ...dev, ...COOKIE })).json();
      const cartoes = quadro.colunas.flatMap((c) => c.cartoes);
      const piscando = cartoes.filter((c) => c.precisaDeGente);
      assert.ok(piscando.some((c) => c.precisaDeGente === 'na_fila'));
      assert.ok(piscando.some((c) => c.precisaDeGente === 'sem_resposta'));
      const comAtendente = cartoes.filter((c) => c.status === 'humana');
      assert.ok(comAtendente.some((c) => !c.precisaDeGente), 'as ja respondidas pelo atendente nao piscam');
    });
  });

  it('responder um cliente na demonstracao NAO chega ao WhatsApp de verdade', async () => {
    const { registrarAdaptador, obterAdaptador } = await import('../src/channels/gateway.js');
    const original = obterAdaptador('whatsapp');
    const enviadosDeVerdade = [];
    registrarAdaptador('whatsapp', { enviar: async (m) => enviadosDeVerdade.push(m) });

    try {
      const conversa = (await pedir('GET', '/api/conversas?filtro=fila', { ...dev, ...COOKIE })).json().itens[0];
      const r = await pedir('POST', `/api/conversas/${conversa.id}/mensagens`, { ...dev, ...COOKIE }, { conteudo: 'Oi! Já vou te ajudar.' });
      assert.equal(r.statusCode, 201, r.body);
      await new Promise((ok) => setTimeout(ok, 300));

      assert.equal(enviadosDeVerdade.length, 0, 'nada saiu pelo adaptador real');
      const msgs = (await pedir('GET', `/api/conversas/${conversa.id}/mensagens`, { ...dev, ...COOKIE })).json().mensagens;
      const minha = msgs.find((m) => m.id === r.json().id);
      assert.ok(minha.entregueEm, 'na demonstracao o envio "da certo" (simulado)');
    } finally {
      if (original) registrarAdaptador('whatsapp', original);
    }
  });

  it('conectar um numero na demonstracao e recusado', async () => {
    const r = await pedir('POST', '/api/canais/W2/conectar', { ...dev, ...COOKIE });
    assert.equal(r.statusCode, 422);
    assert.match(r.json().erro.mensagem, /demonstra/i);
  });

  /**
   * EXPORTAR: o movimento ficticio entra na empresa REAL, misturado. O que
   * importa e que nada dele consiga falar com gente de verdade.
   */
  describe('exportar para a empresa real', () => {
    const real = async (sql) => {
      const { db } = await import('../src/db/client.js');
      return (await db.all(sql));
    };
    const conta = async (sql) => Number(Object.values((await real(sql))[0])[0]);
    const antes = {};

    async function esperarExportacao() {
      for (let i = 0; i < 600; i++) {
        const r = (await pedir('GET', '/api/dev/demonstracao', dev)).json();
        if (!r.exportacao.rodando) return r.exportacao;
        await new Promise((ok) => setTimeout(ok, 250));
      }
      throw new Error('A exportacao nao terminou a tempo');
    }

    it('sem digitar EXPORTAR, recusa', async () => {
      const r = await pedir('POST', '/api/dev/demonstracao/exportar', dev, { confirmar: 'sim' });
      assert.equal(r.statusCode, 422);
    });

    it('so o DEV exporta', async () => {
      const r = await pedir('POST', '/api/dev/demonstracao/exportar', dono, { confirmar: 'EXPORTAR' });
      assert.equal(r.statusCode, 404);
    });

    it('traz clientes, agenda e conversas, com backup antes', { timeout: 180_000 }, async () => {
      antes.leads = await conta(`select count(*) from leads`);
      // O seed de exemplo tambem usa numeros impossiveis: separa os que ja existiam.
      const jaEram = (await real(`select id from leads where telefone like '55109%'`)).map((l) => `'${l.id}'`);
      antes.importado = `telefone like '55109%'${jaEram.length ? ` and id not in (${jaEram.join(',')})` : ''}`;
      antes.users = await conta(`select count(*) from users`);
      antes.canais = await conta(`select count(*) from channel_instances`);
      antes.bloqueiosGerais = await conta(`select count(*) from schedule_blocks where professional_id is null`);
      antes.ajustes = await conta(`select count(*) from settings`);

      const r = await pedir('POST', '/api/dev/demonstracao/exportar', dev, { confirmar: 'EXPORTAR' });
      assert.equal(r.statusCode, 202, r.body);
      const x = await esperarExportacao();
      assert.equal(x.erro, null);
      antes.backupId = x.resultado.backupId;
      antes.importados = x.resultado.contagem.leads;
      assert.ok(x.resultado.contagem.leads > 100);
      assert.equal(await conta(`select count(*) from leads`), antes.leads + x.resultado.contagem.leads);
      assert.ok((await pedir('GET', '/api/profissionais', dono)).json().profissionais.length >= 19, 'os profissionais da demo aparecem');
    });

    it('usuarios, conexoes, configuracao e feriados ficticios nao vem', async () => {
      assert.equal(await conta(`select count(*) from users`), antes.users);
      assert.equal(await conta(`select count(*) from channel_instances`), antes.canais);
      assert.equal(await conta(`select count(*) from settings`), antes.ajustes);
      assert.equal(await conta(`select count(*) from schedule_blocks where professional_id is null`), antes.bloqueiosGerais);
    });

    it('nada importado consegue falar com gente de verdade', async () => {
      // Todo telefone ficticio virou numero impossivel (DDD 10).
      assert.equal(await conta(`select count(*) from leads where ${antes.importado}`), antes.importados);
      assert.equal(await conta(`select count(*) from campaign_targets where telefone not like '55109%'`), 0);
      // Os profissionais da demo nascem com 5511981xxxxxx (ver o gerador).
      assert.equal(await conta(`select count(*) from professionals where telefone like '5511981%'`), 0);
      // Nao entram em campanha, nao ha conversa aberta nem campanha enviando.
      assert.equal(await conta(`select count(*) from leads where ${antes.importado} and aceita_campanha = 1`), 0);
      assert.equal(await conta(`select count(*) from conversations c join leads l on l.id = c.lead_id where l.id in (select id from leads where ${antes.importado}) and c.status != 'finalizada'`), 0);
      assert.equal(await conta(`select count(*) from campaigns where status in ('enviando', 'gerando')`), 0);
      assert.equal(
        await conta(`select count(*) from appointments where lembrete_enviado_em is null and inicio_em > ${Date.now()} and lead_id in (select id from leads where ${antes.importado})`),
        0
      );
    });

    it('a mesma demonstracao nao entra duas vezes', async () => {
      await pedir('POST', '/api/dev/demonstracao/exportar', dev, { confirmar: 'EXPORTAR' });
      const x = await esperarExportacao();
      assert.match(x.erro, /já foi exportada/);
    });

    after(async () => {
      if (!antes.backupId) return;
      const { apagarBackup } = await import('../src/modules/dados/backups.js');
      try {
        apagarBackup(antes.backupId);
      } catch {
        // backup protegido/ja apagado: nao importa para o teste
      }
    });
  });

  it('excluir apaga o arquivo e libera o espaco', async () => {
    const r = await pedir('DELETE', '/api/dev/demonstracao', dev);
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(r.json().liberados > 0);
    const { caminhoDoArquivo } = await import('../src/modules/demonstracao/demonstracao.js');
    assert.equal(existsSync(caminhoDoArquivo()), false);
    // Com o arquivo apagado, o cookie esquecido nao quebra nada: volta ao real.
    const eu = (await pedir('GET', '/api/auth/eu', { ...dev, ...COOKIE })).json().usuario;
    assert.equal(eu.demonstracao, undefined);
  });
});
