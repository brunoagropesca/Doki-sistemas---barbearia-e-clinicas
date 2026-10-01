import { sql } from 'drizzle-orm';
import { env } from '../../src/config/env.js';

/**
 * Apoio para os testes de integracao.
 *
 * Cada arquivo de teste comeca com um banco limpo e recem-semeado. Testes que
 * dependem do estado deixado por outro sao a causa numero um de suite que
 * passa sozinha e falha junto — ou que passa hoje e falha amanha porque a
 * ordem mudou.
 *
 * SOBRE COMO LIMPAMOS:
 * a primeira versao apagava o arquivo .db. Funcionou ate um arquivo de teste
 * importar o motor de IA no topo — o que abre a conexao com o banco ANTES do
 * `before()` rodar, e o Windows nao deixa apagar arquivo aberto (EPERM).
 *
 * Agora apagamos as LINHAS, nao o arquivo: um `DELETE FROM tenants` derruba
 * todo o resto por cascata, ja que toda tabela de negocio referencia a empresa
 * com `ON DELETE CASCADE`. Isso funciona com a conexao aberta, e de quebra
 * serve como prova de que as cascatas estao mesmo configuradas.
 */

/**
 * "Agora + deslocamento", mas SEMPRE dentro do dia de hoje (fuso da empresa).
 *
 * Testes do quadro criam a OS "de hoje" com `Date.now() + 1h`. Depois das
 * 23h isso ja e amanha, e o cartao some do quadro de hoje: a suite falhava so
 * de noite (e com `- 2h`, so de madrugada). Aqui o instante e preso entre
 * 00:05 e 22:30 do dia corrente. O -03:00 fixo e o mesmo dos outros testes
 * (Sao Paulo nao tem horario de verao desde 2019).
 */
export function instanteDeHoje(deslocamentoMs = 0, fuso = 'America/Sao_Paulo') {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: fuso });
  const inicio = new Date(`${hoje}T00:05:00-03:00`).getTime();
  const fim = new Date(`${hoje}T22:30:00-03:00`).getTime();
  return Math.min(Math.max(Date.now() + deslocamentoMs, inicio), fim);
}

export function conferirBancoDeTeste() {
  if (!env.DATABASE_URL.includes('teste')) {
    throw new Error(
      `Os testes so rodam contra um banco cujo caminho contenha "teste". Atual: ${env.DATABASE_URL}`
    );
  }
}

/**
 * Sobe uma API pronta pra testar, com banco limpo e empresa de demonstracao.
 *
 * Usa `app.inject()` em vez de uma porta de rede: e mais rapido, nao conflita
 * com o servidor de desenvolvimento e funciona sem rede.
 */
export async function criarAppDeTeste(opcoesDoApp = {}) {
  conferirBancoDeTeste();

  const { rodarMigrations } = await import('../../src/db/migrate.js');
  const { db, fecharBanco, inicializarBanco } = await import('../../src/db/client.js');
  const { semear } = await import('../../src/db/seed.js');
  const { criarApp } = await import('../../src/app.js');

  await rodarMigrations();
  await inicializarBanco();

  // Zera os dados. As chaves estrangeiras em cascata fazem o resto.
  await db.run(sql`DELETE FROM tenants`);

  const tenant = await semear();

  // Entrega de mensagens com tempos de teste: ninguem espera a conexao voltar
  // por 1 minuto num teste. E a rota espera o resultado ate o fim (null), como
  // antes — os testes do caminho "pendente" ajustam isto por conta propria.
  const { tempos } = await import('../../src/modules/conversas/entrega.service.js');
  Object.assign(tempos, { aguardarConexaoMs: 300, esperasNovaTentativaMs: [20, 50], checarConexaoMs: 20, esperaNaTelaMs: null });

  // opcoesDoApp: o que o criarApp aceita (ex.: os certificados HTTPS).
  const app = await criarApp(opcoesDoApp);

  /**
   * Fecha a conexao do banco junto com o app — como o main.js faz ao desligar.
   *
   * Sem isto cada arquivo de teste terminava com a conexao NATIVA do libsql
   * aberta, e no Windows o processo as vezes morria ao sair com violacao de
   * acesso (codigo 3221225477 = 0xC0000005): todos os testes do arquivo
   * passavam e, mesmo assim, o arquivo aparecia como reprovado, cada vez um
   * diferente. A espera deixa terminar o que ainda roda em segundo plano
   * (marcar uso da sessao, automacoes da Atena disparadas por uma mudanca de
   * status) antes de fechar: fechar com uma consulta nativa em andamento tambem
   * travava. Com 50 ms o meu-dia.test.js travava ~1 vez em 10; com 300 ms, 0 em 20.
   */
  app.addHook('onClose', async () => {
    await new Promise((ok) => setTimeout(ok, 300));
    fecharBanco();
  });

  await app.ready();

  return { app, tenant };
}

/** Faz login e devolve o token e o cabecalho prontos pra usar nas chamadas. */
export async function entrar(app, username = 'dono', senha = 'trocar@123') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, senha }
  });

  if (res.statusCode !== 200) {
    throw new Error(`Login de teste falhou (${res.statusCode}): ${res.body}`);
  }

  const corpo = res.json();
  return {
    token: corpo.token,
    usuario: corpo.usuario,
    cabecalho: { authorization: `Bearer ${corpo.token}` }
  };
}

/**
 * Deixa a casa ABERTA o dia todo, todos os dias.
 *
 * O aviso de transferencia e a volta da Sofia na fila dependem do expediente
 * (ver `atendimento/expediente.js`). Testes que NAO sao sobre horario nao
 * podem mudar de resultado conforme a hora em que a suite roda (antes das 9h
 * a barbearia de exemplo estaria fechada e as mensagens mudariam).
 *
 * Nao entra no seed nem no criarAppDeTeste: os testes de agenda dependem das
 * jornadas reais.
 */
export async function abrirACasa() {
  const { db } = await import('../../src/db/client.js');
  const { professionals } = await import('../../src/db/schema/index.js');
  const diaTodo = [{ inicio: '00:00', fim: '23:59' }];
  await db.update(professionals).set({
    jornada: { dias: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, diaTodo])), intervaloMinutos: 30 }
  });
}
