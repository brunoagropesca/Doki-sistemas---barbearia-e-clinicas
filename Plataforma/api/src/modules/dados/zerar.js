import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { and, eq, notInArray } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { dbReal, emTransacao, libsql } from '../../db/client.js';
import { ID } from '../../core/ids.js';
import { AGENTES_PADRAO } from '../../ai/agentes-padrao.js';
import { invalidarCatalogo } from '../../ai/tools/catalogo-cache.js';
import { limparEventos } from '../../channels/eventos.js';
import * as s from '../../db/schema/index.js';
import { comContexto } from '../../core/logger.js';
import { PASTA_ARQUIVOS } from '../equipe/arquivos.js';
import { pastaDeBackups } from '../../db/restauracao.js';
import { obterAdaptador } from '../../channels/gateway.js';
import { apagarArquivo as apagarDemonstracao, existe as existeDemonstracao } from '../demonstracao/demonstracao.js';

const log = comContexto({ modulo: 'zerar-sistema' });

/**
 * ZERAR O SISTEMA: volta a instalacao ao estado de recem-instalada, de forma
 * PERMANENTE — sem backup antes e apagando os backups que existiam.
 *
 * Fica:  a empresa (nome), as contas de DONO e do DEV (senao ninguem entra).
 * Sai:   clientes, conversas, agenda, vendas, catalogo, profissionais, equipe,
 *        campanhas, configuracoes (IA e chaves, menu, base de conhecimento,
 *        funcoes), conexoes de WhatsApp (desconectadas e esquecidas),
 *        registros, fotos e anexos, backups e o banco de demonstracao.
 * Volta: o "padrao de fabrica" que uma instalacao nova tem (Sofia e Atena,
 *        configuracoes iniciais e o WhatsApp W1 desconectado) — sem isso as
 *        telas de IA e de Conexoes abririam vazias.
 * Depois o banco e compactado (VACUUM): o espaco volta para o disco.
 *
 * Sempre no banco de VERDADE (usa `dbReal`), mesmo chamado de dentro da
 * demonstracao.
 */

/** Tamanho de uma pasta (ou arquivo), somando tudo dentro. */
function tamanho(caminho) {
  if (!existsSync(caminho)) return 0;
  const st = statSync(caminho);
  if (!st.isDirectory()) return st.size;
  return readdirSync(caminho).reduce((t, n) => t + tamanho(join(caminho, n)), 0);
}

function esvaziarPasta(caminho) {
  if (!existsSync(caminho)) return;
  for (const nome of readdirSync(caminho)) rmSync(join(caminho, nome), { recursive: true, force: true });
}

function arquivoDoBanco() {
  return env.DATABASE_URL.startsWith('file:') ? resolve(env.DATABASE_URL.slice('file:'.length)) : null;
}

export async function zerarSistema(tenantId, { usuario } = {}) {
  const banco = arquivoDoBanco();
  const pastas = {
    arquivos: resolve(PASTA_ARQUIVOS),
    backups: pastaDeBackups(),
    whatsapp: resolve(env.WHATSAPP_AUTH_DIR, tenantId)
  };
  const antes = tamanho(banco) + tamanho(`${banco}-wal`) + Object.values(pastas).reduce((t, p) => t + tamanho(p), 0);

  // 1) WhatsApp: sai das contas (a sessao salva e esquecida pelo proprio WhatsApp).
  const conexoes = await dbReal.select().from(s.channelInstances).where(eq(s.channelInstances.tenantId, tenantId));
  for (const c of conexoes) {
    try {
      await obterAdaptador(c.canal)?.desconectar?.(tenantId, c.chave, { sair: true });
    } catch (err) {
      log.warn({ err, chave: c.chave }, 'Nao consegui sair da conta; a sessao sera apagada do disco');
    }
  }

  // 2) Banco: tudo da empresa, menos a propria empresa e as contas de dono/DEV.
  const apagados = {};
  await emTransacao(async (tx) => {
    const apagar = async (nome, tabela, extra) => {
      const r = await tx.delete(tabela).where(extra ? and(eq(tabela.tenantId, tenantId), extra) : eq(tabela.tenantId, tenantId));
      apagados[nome] = r.rowsAffected ?? 0;
    };
    // Filhos antes dos pais.
    await apagar('envios de campanha', s.campaignTargets);
    await apagar('campanhas', s.campaigns);
    await apagar('notificacoes', s.teamNotifications);
    await apagar('historico de atendimentos', s.serviceHistory);
    await apagar('vendas', s.productSales);
    await apagar('agendamentos', s.appointments);
    await apagar('mensagens', s.messages);
    await apagar('conversas', s.conversations);
    await apagar('clientes', s.leads);
    await apagar('bloqueios de agenda', s.scheduleBlocks);
    await apagar('movimentos de estoque', s.stockMovements);
    await apagar('servicos por profissional', s.professionalServices);
    await apagar('produtos', s.products);
    await apagar('servicos', s.services);
    await apagar('profissionais', s.professionals);
    await apagar('respostas rapidas', s.quickReplies);
    await apagar('avisos', s.teamAlerts);
    await apagar('auditoria', s.auditLogs);
    await apagar('uso de IA', s.aiCalls);
    await apagar('configuracoes', s.settings);
    await apagar('menu', s.menuFlows);
    await apagar('agentes de IA', s.agentProfiles);
    await apagar('provedores de IA', s.aiProviders);
    await apagar('conexoes', s.channelInstances);
    // Os logins abertos de quem sai vao junto (sessions apaga em cascata).
    await apagar('equipe', s.users, notInArray(s.users.cargo, ['owner', 'dev']));

    // Padrao de fabrica — o mesmo que o seed cria numa instalacao nova.
    await tx.insert(s.agentProfiles).values(
      Object.entries(AGENTES_PADRAO).map(([chave, a]) => ({
        id: ID.agente(),
        tenantId,
        chave,
        nome: a.nome,
        avatar: a.avatar,
        tom: a.tom,
        temperaturaMilesimos: a.temperaturaMilesimos,
        maxTokens: a.maxTokens,
        systemPrompt: a.systemPrompt,
        ferramentas: a.ferramentas
      }))
    );
    await tx.insert(s.settings).values(
      [
        { chave: 'modo_atendimento', valor: 'hibrido', descricao: 'hibrido | menu | ia' },
        { chave: 'janela_contexto_mensagens', valor: 8, descricao: 'Quantas mensagens a IA lembra' },
        { chave: 'agrupamento_segundos', valor: 8, descricao: 'Espera antes de responder mensagens picotadas' }
      ].map((c) => ({ tenantId, ...c }))
    );
    await tx.insert(s.channelInstances).values({
      id: ID.canal(),
      tenantId,
      canal: 'whatsapp',
      chave: 'W1',
      nome: 'WhatsApp',
      status: 'desconectado'
    });
  });
  invalidarCatalogo(tenantId);
  limparEventos(tenantId);

  // 3) Arquivos: fotos/anexos, sessoes de WhatsApp, backups e a demonstracao.
  esvaziarPasta(pastas.arquivos);
  rmSync(pastas.whatsapp, { recursive: true, force: true });
  esvaziarPasta(pastas.backups);
  if (existeDemonstracao()) await apagarDemonstracao();

  // 4) Devolve o espaco ao disco: sem isto o arquivo do SQLite continua do
  //    mesmo tamanho (as paginas apagadas ficam reservadas para reuso).
  //    Se o banco estiver ocupado agora, o que foi apagado continua apagado;
  //    so o espaco fica para a proxima compactacao.
  try {
    await libsql.execute('VACUUM');
    await libsql.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (err) {
    log.warn({ err }, 'Nao consegui compactar o banco agora');
  }

  const depois = tamanho(banco) + tamanho(`${banco}-wal`) + Object.values(pastas).reduce((t, p) => t + tamanho(p), 0);
  const liberados = Math.max(0, antes - depois);
  log.warn({ tenantId, por: usuario?.id, apagados, liberados }, 'SISTEMA ZERADO');
  return { apagados, liberados };
}
