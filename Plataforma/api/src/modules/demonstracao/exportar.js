import { and, eq, inArray, isNull, like } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import * as s from '../../db/schema/index.js';
import { RegraDeNegocio } from '../../core/errors.js';

/**
 * EXPORTAR a demonstracao: traz o movimento ficticio para a empresa REAL,
 * misturado com o que ela ja tem (clientes, agenda, conversas, catalogo...).
 *
 * O que NAO vem, de proposito:
 *   - a empresa ficticia, os usuarios (dono/paula/... com senha conhecida) e
 *     o que so faz sentido com eles (respostas rapidas, avisos, notificacoes);
 *   - as conexoes de WhatsApp ficticias: conversas e campanhas passam a
 *     apontar para a conexao REAL de mesma chave (W1, W2...);
 *   - configuracao (menu, agentes, provedores de IA, ajustes): a demo copiou
 *     a da empresa real, e trazer de volta so sobrescreveria;
 *   - auditoria e consumo de IA ficticios (seriam numeros falsos de custo);
 *   - bloqueios da empresa inteira (feriados ficticios travariam a agenda real).
 *
 * E o que e NEUTRALIZADO, para nada sair para gente de verdade:
 *   - todo telefone vira um numero IMPOSSIVEL (DDD 10 nao existe): os da demo
 *     sao celulares validos e poderiam ser de alguem;
 *   - clientes importados nao aceitam campanha;
 *   - conversas abertas chegam finalizadas (nao entram na fila real);
 *   - campanhas em andamento chegam pausadas;
 *   - lembretes de vespera ja constam como enviados.
 *
 * Tudo numa transacao so: ou entra inteiro, ou nada entra.
 */

/** Na ordem das chaves estrangeiras (quem e citado entra antes). */
const TABELAS = [
  'services',
  'products',
  'professionals',
  'professionalServices',
  'scheduleBlocks',
  'leads',
  'stockMovements',
  'conversations',
  'messages',
  'appointments',
  'serviceHistory',
  'productSales',
  'campaigns',
  'campaignTargets'
];

/** Colunas de cada tabela que apontam para `alvo` (lidas do schema, nao escritas a mao). */
function colunasQueApontamPara(tabela, alvo) {
  const cfg = getTableConfig(tabela);
  return cfg.foreignKeys
    .map((fk) => fk.reference())
    .filter((r) => r.foreignTable === alvo)
    .map((r) => {
      const col = r.columns[0];
      const chave = Object.keys(tabela).find((k) => tabela[k] === col);
      return { chave, obrigatoria: col.notNull };
    });
}

/**
 * @param {object} p
 * @param {import('drizzle-orm/libsql').LibSQLDatabase} p.origem   banco da demonstracao
 * @param {import('drizzle-orm/libsql').LibSQLDatabase} p.destino  banco real
 * @param {string} p.tenantDestino  a empresa real que recebe
 */
export async function exportarDemonstracao({ origem, destino, tenantDestino, progresso = () => {} }) {
  // --- Le tudo da demonstracao -------------------------------------------------
  const dados = {};
  for (const nome of TABELAS) dados[nome] = await origem.select().from(s[nome]);
  if (dados.leads.length === 0) throw new RegraDeNegocio('A demonstração está vazia: gere de novo antes de exportar.');
  progresso('Lendo a demonstração', 10);

  // Exportar duas vezes a MESMA demonstracao duplicaria tudo (os ids sao os mesmos).
  const [jaVeio] = await destino
    .select({ id: s.leads.id })
    .from(s.leads)
    .where(inArray(s.leads.id, dados.leads.slice(0, 50).map((l) => l.id)))
    .limit(1);
  if (jaVeio) throw new RegraDeNegocio('Esta demonstração já foi exportada. Gere uma nova para exportar de novo.');

  // --- Conexoes: a de mesma chave na empresa real ------------------------------
  const canaisDemo = await origem.select({ id: s.channelInstances.id, chave: s.channelInstances.chave }).from(s.channelInstances);
  const canaisReais = await destino
    .select({ id: s.channelInstances.id, chave: s.channelInstances.chave })
    .from(s.channelInstances)
    .where(and(eq(s.channelInstances.tenantId, tenantDestino), isNull(s.channelInstances.deletedAt)));
  const canalReal = new Map(
    canaisDemo.map((c) => [c.id, canaisReais.find((r) => r.chave === c.chave)?.id ?? canaisReais[0]?.id ?? null])
  );

  // --- Telefones impossiveis ---------------------------------------------------
  const usados = new Set(
    (
      await destino
        .select({ t: s.leads.telefone })
        .from(s.leads)
        .where(and(eq(s.leads.tenantId, tenantDestino), like(s.leads.telefone, '5510%')))
    ).map((l) => l.t)
  );
  const telefones = new Map();
  let seq = 0;
  const impossivel = (tel) => {
    if (!tel) return tel;
    if (!telefones.has(tel)) {
      let novo;
      do novo = `55109${String(++seq).padStart(8, '0')}`;
      while (usados.has(novo));
      telefones.set(tel, novo);
    }
    return telefones.get(tel);
  };

  // --- Transforma cada linha ---------------------------------------------------
  const agora = new Date();
  const ajustes = {
    professionals: (l) => ({ ...l, telefone: impossivel(l.telefone) }),
    leads: (l) => ({ ...l, telefone: impossivel(l.telefone), aceitaCampanha: false }),
    conversations: (l) =>
      l.status === 'finalizada' ? l : { ...l, status: 'finalizada', finalizadaEm: l.finalizadaEm ?? agora, naFilaDesde: null, naoLidas: 0 },
    appointments: (l) => (l.lembreteEnviadoEm || l.inicioEm < agora ? l : { ...l, lembreteEnviadoEm: agora }),
    campaigns: (l) => ({
      ...l,
      status: l.status === 'enviando' ? 'pausada' : l.status === 'gerando' ? 'revisao' : l.status,
      esperaMotivo: null,
      retomaEm: null,
      proximoEnvioEm: null
    }),
    campaignTargets: (l) => ({ ...l, telefone: impossivel(l.telefone), status: l.status === 'enviando' ? 'aprovada' : l.status })
  };

  const linhas = {};
  const contagem = {};
  for (const nome of TABELAS) {
    const tabela = s[nome];
    const colUsuarios = colunasQueApontamPara(tabela, s.users);
    const colCanais = colunasQueApontamPara(tabela, s.channelInstances);
    if (colUsuarios.some((c) => c.obrigatoria)) throw new Error(`A tabela ${nome} exige usuário: não pode ser exportada.`);

    let lista = dados[nome];
    // Bloqueio sem profissional = a empresa inteira fechada (feriado ficticio).
    if (nome === 'scheduleBlocks') lista = lista.filter((l) => l.professionalId);
    // Campanha precisa de uma conexao; sem nenhuma na empresa real, fica de fora.
    if (nome === 'campaigns') lista = lista.filter((l) => canalReal.get(l.channelInstanceId));
    if (nome === 'campaignTargets') {
      const campanhas = new Set(linhas.campaigns.map((c) => c.id));
      lista = lista.filter((l) => campanhas.has(l.campaignId));
    }

    linhas[nome] = lista.map((original) => {
      const l = { ...original };
      if ('tenantId' in l) l.tenantId = tenantDestino;
      for (const { chave } of colUsuarios) l[chave] = null;
      for (const { chave } of colCanais) if (l[chave]) l[chave] = canalReal.get(l[chave]) ?? null;
      return ajustes[nome] ? ajustes[nome](l) : l;
    });
    contagem[nome] = linhas[nome].length;
  }
  progresso('Preparando', 25);

  // --- Grava tudo de uma vez ---------------------------------------------------
  const total = Object.values(contagem).reduce((a, b) => a + b, 0);
  let feitas = 0;
  await destino.transaction(async (tx) => {
    for (const nome of TABELAS) {
      const lista = linhas[nome];
      const porLote = Math.max(20, Math.floor(8000 / Math.max(1, Object.keys(lista[0] ?? { a: 1 }).length)));
      for (let i = 0; i < lista.length; i += porLote) {
        await tx.insert(s[nome]).values(lista.slice(i, i + porLote));
        feitas += Math.min(porLote, lista.length - i);
        progresso(`Gravando ${nome}`, 25 + Math.round((feitas / Math.max(1, total)) * 74));
      }
    }
  });

  progresso('Pronto', 100);
  return { contagem, telefonesTrocados: telefones.size };
}
