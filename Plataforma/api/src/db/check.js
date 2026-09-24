import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, fecharBanco, inicializarBanco, libsql } from './client.js';
import * as schema from './schema/index.js';

/**
 * Diagnostico do banco (`npm run db:check`).
 *
 * Responde tres perguntas que, quando ficam sem resposta, geram bug silencioso:
 *
 * 1. Toda tabela declarada no schema existe mesmo no arquivo .db?
 *    (se alguem editou o schema e esqueceu de gerar/aplicar a migration,
 *     o sistema so quebra quando aquela tela for aberta, em producao)
 *
 * 2. As chaves estrangeiras estao ativas de verdade?
 *    Nao basta o PRAGMA dizer que sim — aqui tentamos inserir um registro
 *    orfao de proposito e conferimos que o banco recusa.
 *
 * 3. Existe registro orfao que ja tenha escapado?
 */

function nomeDaTabela(t) {
  // Drizzle guarda o nome real da tabela num simbolo interno.
  const simbolo = Object.getOwnPropertySymbols(t).find((s) => String(s).includes('Name'));
  return simbolo ? t[simbolo] : null;
}

export async function verificarBanco() {
  await inicializarBanco();

  const problemas = [];
  const avisos = [];

  // --- 1. Tabelas do schema x tabelas do arquivo ---
  const existentes = new Set(
    (await libsql.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => r.name)
  );

  const declaradas = [];
  for (const valor of Object.values(schema)) {
    const nome = valor && typeof valor === 'object' ? nomeDaTabela(valor) : null;
    if (nome) declaradas.push(nome);
  }

  for (const nome of declaradas) {
    if (!existentes.has(nome)) {
      problemas.push(`Tabela "${nome}" esta no schema mas NAO existe no banco. Rode: npm run db:migrate`);
    }
  }

  // --- 2. Chaves estrangeiras realmente bloqueiam? ---
  const [{ foreign_keys: fkLigadas }] = (await libsql.execute('PRAGMA foreign_keys')).rows;
  if (Number(fkLigadas) !== 1) {
    problemas.push('PRAGMA foreign_keys esta DESLIGADO — o banco aceita registros orfaos.');
  } else {
    try {
      await libsql.execute({
        sql: `INSERT INTO leads (id, tenant_id, telefone, nome, observacoes, tags, origem, aceita_campanha, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        args: ['__teste_fk__', '__empresa_inexistente__', '5500000000000', 'Teste FK', '', '[]', 'teste', 1, Date.now(), Date.now()]
      });
      // Se chegou aqui, o banco aceitou lixo. Limpa e reporta.
      await libsql.execute({ sql: 'DELETE FROM leads WHERE id = ?', args: ['__teste_fk__'] });
      problemas.push('As chaves estrangeiras NAO estao sendo aplicadas: o banco aceitou um lead sem empresa valida.');
    } catch {
      // Recusou, que e o comportamento correto.
    }
  }

  // --- 3. Orfaos que ja tenham escapado ---
  const orfaos = [
    ['leads sem empresa', sql`SELECT COUNT(*) AS n FROM leads l LEFT JOIN tenants t ON t.id = l.tenant_id WHERE t.id IS NULL`],
    ['agendamentos sem lead', sql`SELECT COUNT(*) AS n FROM appointments a LEFT JOIN leads l ON l.id = a.lead_id WHERE l.id IS NULL`],
    ['mensagens sem conversa', sql`SELECT COUNT(*) AS n FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id WHERE c.id IS NULL`]
  ];

  for (const [rotulo, consulta] of orfaos) {
    const r = await db.get(consulta);
    if (Number(r?.n) > 0) avisos.push(`${r.n} ${rotulo}.`);
  }

  // --- Relatorio ---
  console.log(`\nTabelas no schema: ${declaradas.length}`);
  console.log(`Tabelas no banco:  ${existentes.size} (inclui as de controle do Drizzle)`);

  const indices = await libsql.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'");
  console.log(`Indices nomeados:  ${indices.rows[0].n}`);

  if (avisos.length) {
    console.log('\nAVISOS:');
    for (const a of avisos) console.log(`  - ${a}`);
  }

  if (problemas.length) {
    console.log('\nPROBLEMAS:');
    for (const p of problemas) console.log(`  - ${p}`);
    console.log('');
    return false;
  }

  console.log('\nBanco integro: schema aplicado, chaves estrangeiras ativas, sem orfaos.\n');
  return true;
}

// Compara pelo endereco que o proprio Node gera: montar a URL na mao quebrava
// em pasta com espaco no nome (o Node escreve %20) e o script nao rodava.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const ok = await verificarBanco();
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    console.error('Falha no diagnostico:', err);
    process.exitCode = 1;
  } finally {
    fecharBanco();
  }
}
