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
export async function criarAppDeTeste() {
  conferirBancoDeTeste();

  const { rodarMigrations } = await import('../../src/db/migrate.js');
  const { db, inicializarBanco } = await import('../../src/db/client.js');
  const { semear } = await import('../../src/db/seed.js');
  const { criarApp } = await import('../../src/app.js');

  await rodarMigrations();
  await inicializarBanco();

  // Zera os dados. As chaves estrangeiras em cascata fazem o resto.
  await db.run(sql`DELETE FROM tenants`);

  const tenant = await semear();

  const app = await criarApp();
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
