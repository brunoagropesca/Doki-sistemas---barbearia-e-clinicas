import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';
import { instalar, senhaInicial, slugDe } from '../src/db/instalar.js';
import { AGENTES_PADRAO } from '../src/ai/agentes-padrao.js';

/**
 * Instalacao de verdade (db/instalar.js): a empresa do cliente, o dono e a
 * configuracao de fabrica — nenhum cliente, profissional, servico, produto ou
 * canal de exemplo. O seed de exemplo continua para desenvolvimento e testes.
 */

const PASTA_API = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let app;
let db;

const conta = async (tabela) => Number((await db.all(sql.raw(`select count(*) as n from ${tabela}`)))[0].n);

describe('instalacao e seed de exemplo', () => {
  before(async () => {
    ({ app } = await criarAppDeTeste());
    ({ db } = await import('../src/db/client.js'));
  });

  after(async () => {
    await app?.close();
  });

  describe('seed de exemplo (desenvolvimento e testes)', () => {
    it('os clientes de exemplo tem numeros impossiveis (DDD 10), nunca celulares de verdade', async () => {
      const telefones = (await db.all(sql`select telefone from leads`)).map((l) => l.telefone);
      assert.ok(telefones.length >= 3);
      for (const t of telefones) assert.match(t, /^55109\d{8}$/);
    });

    it('instalacao antiga: os 3 clientes do seed velho, sem conversa, viram aviso para o DEV (nada e apagado)', async () => {
      const { clientesDeExemploAntigos } = await import('../src/modules/dados/exemplo-antigo.js');
      const leads = await import('../src/modules/leads/leads.service.js');
      const [{ id: tenantId }] = await db.all(sql`select id from tenants limit 1`);

      await leads.encontrarOuCriarPorTelefone(tenantId, '5511988776655', 'Marcos Antunes');
      const comConversa = await leads.encontrarOuCriarPorTelefone(tenantId, '5511977665544', 'Rafael Souza');
      const s = await import('../src/db/schema/index.js');
      await db.insert(s.conversations).values({ id: 'conv_ex_antigo', tenantId, leadId: comConversa.id });

      const achados = await clientesDeExemploAntigos();
      assert.deepEqual(
        achados.map((a) => a.nome),
        ['Marcos Antunes'],
        'so quem nunca conversou (o outro pode ser um cliente de verdade com o mesmo numero)'
      );
      assert.equal(await contaOnde('leads where telefone = \'5511988776655\''), 1, 'nada e apagado sozinho');
    });

    const contaOnde = async (resto) => Number((await db.all(sql.raw(`select count(*) as n from ${resto}`)))[0].n);
  });

  it('o nome vira um endereco curto, sem acento', () => {
    assert.equal(slugDe('Barbearia São João & Cia'), 'barbearia-sao-joao-cia');
    assert.equal(slugDe('  ***  '), 'empresa');
  });

  it('a senha inicial tem 12 caracteres e nenhum que se confunda ao ler (0/O, 1/l/I)', () => {
    for (let i = 0; i < 50; i++) {
      const senha = senhaInicial();
      assert.equal(senha.length, 12);
      assert.doesNotMatch(senha, /[0O1lI]/);
    }
    assert.notEqual(senhaInicial(), senhaInicial());
  });

  it('num banco vazio: 1 empresa, 1 dono com senha provisoria, agentes e ajustes de fabrica — e nada de exemplo', async () => {
    // Banco vazio: a cascata a partir da empresa leva tudo junto.
    await db.run(sql`DELETE FROM tenants`);

    const r = await instalar({ empresa: 'Barbearia do Zé', dono: 'zeca', nomeDono: 'José', senha: 'senha-sorteada-1' });
    assert.equal(r.criado, true);
    assert.equal(r.tenant.slug, 'barbearia-do-ze');

    assert.equal(await conta('tenants'), 1);
    assert.equal(await conta('users'), 1);
    const [dono] = await db.all(sql`select username, nome, cargo, senha_provisoria from users`);
    assert.deepEqual({ ...dono }, { username: 'zeca', nome: 'José', cargo: 'owner', senha_provisoria: 1 });

    assert.equal(await conta('agent_profiles'), Object.keys(AGENTES_PADRAO).length);
    assert.equal(await conta('settings'), 3);

    for (const tabela of ['leads', 'professionals', 'services', 'products', 'channel_instances', 'appointments', 'conversations']) {
      assert.equal(await conta(tabela), 0, `${tabela} devia estar vazia`);
    }
  });

  it('o dono entra com a senha sorteada e o menu do WhatsApp e o de fabrica', async () => {
    const { cabecalho, usuario } = await entrar(app, 'zeca', 'senha-sorteada-1');
    assert.equal(usuario.senhaProvisoria, true);
    const cfg = (await app.inject({ method: 'GET', url: '/api/atendimento/configuracao', headers: cabecalho })).json();
    assert.equal(cfg.modo, 'hibrido');
    assert.equal(cfg.menu.padrao, true, 'sem menu gravado: vale o de fabrica');
    assert.ok(cfg.menu.fluxo?.nodes?.length > 0);
  });

  it('rodar de novo nao duplica nada', async () => {
    const r = await instalar({ empresa: 'Outra Empresa', dono: 'outro' });
    assert.equal(r.criado, false);
    assert.equal(await conta('tenants'), 1);
    assert.equal(await conta('users'), 1);
    assert.equal(await conta('agent_profiles'), Object.keys(AGENTES_PADRAO).length);
  });
});

describe('npm run db:instalar (linha de comando, banco temporario)', () => {
  const barra = (p) => p.split('\\').join('/');

  /** Roda o que o INICIAR.bat roda, num banco temporario e sem as variaveis dos testes. */
  function preparar() {
    const pasta = mkdtempSync(join(tmpdir(), 'instalar-'));
    const banco = join(pasta, 'plataforma.db');
    const doTeste = Object.keys(parseEnv(readFileSync(join(PASTA_API, '.env.test'), 'utf8')));
    const ambiente = { ...process.env };
    for (const k of [...doTeste, 'NODE_ENV']) delete ambiente[k];
    Object.assign(ambiente, {
      NODE_ENV: 'development',
      APP_SECRET: randomBytes(32).toString('hex'),
      DATABASE_URL: `file:${barra(banco)}`,
      PAINEL_ATIVO: 'false'
    });
    const rodar = (argumentos = [], entrada = '') =>
      spawnSync(process.execPath, ['src/db/instalar-cli.js', ...argumentos], {
        cwd: PASTA_API,
        env: ambiente,
        encoding: 'utf8',
        input: entrada,
        timeout: 30_000
      });
    const limpar = () => {
      try {
        rmSync(pasta, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // pasta temporaria
      }
    };
    return { rodar, limpar };
  }

  it('sem argumentos e sem respostas: sai com erro claro (nao fica esperando); a proxima vez pergunta de novo e instala', { timeout: 60_000 }, () => {
    const { rodar, limpar } = preparar();
    try {
      const semResposta = rodar();
      assert.equal(semResposta.status, 1, semResposta.stdout + semResposta.stderr);
      assert.match(semResposta.stderr, /--empresa/);

      // O banco ficou sem empresa: decidir por "tem empresa?" faz a proxima vez perguntar de novo.
      const deNovo = rodar([], 'Barbearia Retomada\n\nFulano\n\n');
      assert.equal(deNovo.status, 0, deNovo.stderr);
      assert.match(deNovo.stdout, /INSTALACAO PRONTA: Barbearia Retomada/);
    } finally {
      limpar();
    }
  });

  it('aceita --empresa/--dono/--nome, mostra a senha uma vez e nao reinstala', { timeout: 60_000 }, () => {
    const { rodar, limpar } = preparar();
    try {
      const r = rodar(['--empresa', 'Estúdio Beleza Pura', '--dono', 'maria', '--nome', 'Maria']);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /INSTALACAO PRONTA: Estúdio Beleza Pura/);
      assert.match(r.stdout, /Usuario do dono:\s+maria/);
      assert.ok(r.stdout.match(/Senha inicial:\s+(\S{12})/), 'a senha aparece na tela');
      assert.doesNotMatch(r.stdout, /Aplicando migrations/, 'o INICIAR fica limpo: sem log de migrations');

      const de2 = rodar(['--empresa', 'Outra']);
      assert.equal(de2.status, 0);
      assert.match(de2.stdout, /Banco ja existe e esta atualizado/);
      assert.doesNotMatch(de2.stdout, /Senha inicial/, 'a senha so aparece na primeira vez');
    } finally {
      limpar();
    }
  });
});
