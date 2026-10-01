import { libsql } from '../../db/client.js';
import { comContexto } from '../../core/logger.js';
import { NOME_NA_URL } from './orfaos.js';

const log = comContexto({ modulo: 'arquivos' });

/**
 * Os arquivos que ja existiam ANTES da tabela `arquivos`: de que empresa e
 * cada um?
 *
 * A resposta esta em quem cita o arquivo: a foto do cliente esta em
 * `leads.foto_url`, o audio em `messages.midia_url`, o logo dentro do JSON da
 * empresa em `settings`... Varremos toda coluna de texto que menciona
 * `/api/arquivos/` (como a limpeza de orfaos faz) e anotamos o `tenant_id` da
 * linha. Na tabela `tenants`, a empresa e o proprio `id`.
 *
 * Roda no boot e so trabalha com a tabela VAZIA: depois da primeira vez, todo
 * arquivo novo ja nasce anotado (modules/equipe/arquivos.js). Arquivo que
 * ninguem cita fica sem dono — so o dono da empresa abre (e a limpeza de
 * orfaos o leva).
 *
 * Sempre o banco REAL (`libsql`), como a limpeza de orfaos.
 *
 * @returns {Promise<{ indexados: number, pulou?: boolean }>}
 */
export async function indexarArquivosAntigos() {
  const ja = Number((await libsql.execute('select count(*) as n from arquivos')).rows[0].n);
  if (ja > 0) return { indexados: 0, pulou: true };

  const dono = new Map(); // nome -> tenantId
  const tabelas = (
    await libsql.execute(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%' and name != 'arquivos'"
    )
  ).rows.map((r) => r.name);

  for (const tabela of tabelas) {
    const colunas = (await libsql.execute(`pragma table_info("${tabela}")`)).rows;
    const colunaDaEmpresa = tabela === 'tenants' ? 'id' : colunas.some((c) => c.name === 'tenant_id') ? 'tenant_id' : null;
    if (!colunaDaEmpresa) continue; // sem empresa na linha, nao ha como saber o dono

    const deTexto = colunas.filter((c) => /text|char|clob|json|^$/i.test(String(c.type ?? ''))).map((c) => c.name);
    for (const coluna of deTexto) {
      const linhas = (
        await libsql.execute(
          `select "${colunaDaEmpresa}" as t, "${coluna}" as v from "${tabela}" where "${coluna}" like '%/api/arquivos/%'`
        )
      ).rows;
      for (const { t, v } of linhas) {
        for (const m of String(v).matchAll(NOME_NA_URL)) if (!dono.has(m[1])) dono.set(m[1], t);
      }
    }
  }

  const agora = Date.now();
  let indexados = 0;
  for (const [nome, tenantId] of dono) {
    try {
      await libsql.execute({
        sql: 'insert or ignore into arquivos (nome, tenant_id, created_at) values (?, ?, ?)',
        args: [nome, tenantId, agora]
      });
      indexados++;
    } catch {
      // Empresa que ja nao existe (o "or ignore" nao cobre chave estrangeira): o arquivo fica sem dono.
    }
  }
  if (indexados > 0) log.info({ indexados }, 'Arquivos antigos associados as empresas');
  return { indexados };
}
