import { and, eq, notInArray } from 'drizzle-orm';
import { emTransacao } from '../../db/client.js';
import * as s from '../../db/schema/index.js';
import { RegraDeNegocio } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { criarBackup } from './backups.js';

const log = comContexto({ modulo: 'apagar-dados' });

/**
 * Apagar dados da empresa, por grupos.
 *
 * Nunca apaga: a empresa, os donos, o DEV, as conexoes de WhatsApp e as
 * configuracoes (IA, menu, funcoes, textos). Sem eles o sistema nao abre, ou
 * abre sem conseguir atender ninguem — "apagar tudo" aqui e "voltar a uma
 * instalacao limpa", nao "quebrar a instalacao".
 *
 * Antes de apagar, SEMPRE um backup. Nao ha opcao de pular: e o unico jeito de
 * desfazer um clique errado nesta tela.
 */
export const GRUPOS = [
  {
    chave: 'atendimento',
    titulo: 'Clientes, conversas e agenda',
    descricao: 'Clientes, conversas e mensagens, agendamentos, vendas, bloqueios de agenda, notificações e o histórico de atendimentos.'
  },
  {
    chave: 'campanhas',
    titulo: 'Campanhas',
    descricao: 'Todas as campanhas e seus envios.'
  },
  {
    chave: 'catalogo',
    titulo: 'Catálogo e profissionais',
    descricao: 'Serviços, produtos, estoque e profissionais. Exige apagar também clientes e agenda (os agendamentos apontam para eles).',
    exige: ['atendimento']
  },
  {
    chave: 'equipe',
    titulo: 'Equipe (menos os donos)',
    descricao: 'Atendentes e administradores. Os donos ficam, senão ninguém entra no sistema.'
  },
  {
    chave: 'registros',
    titulo: 'Registros internos',
    descricao: 'Auditoria, uso de IA e avisos da gerência.'
  }
];
const CHAVES = new Set(GRUPOS.map((g) => g.chave));

/**
 * @param {string} tenantId
 * @param {string[]} grupos
 * @returns {Promise<{backup: string, apagados: Record<string, number>}>}
 */
export async function apagarDados(tenantId, grupos, { usuario } = {}) {
  const pedidos = new Set(grupos);
  if (pedidos.size === 0) throw new RegraDeNegocio('Escolha pelo menos um grupo de dados.');
  for (const g of pedidos) if (!CHAVES.has(g)) throw new RegraDeNegocio(`Grupo desconhecido: ${g}.`);
  for (const g of GRUPOS) {
    for (const exigido of g.exige ?? []) {
      if (pedidos.has(g.chave) && !pedidos.has(exigido)) {
        throw new RegraDeNegocio(`Para apagar "${g.titulo}" e preciso apagar tambem "${GRUPOS.find((x) => x.chave === exigido).titulo}".`);
      }
    }
  }

  const backup = await criarBackup({ motivo: 'antes_de_apagar', incluirArquivos: true, por: usuario?.nome ?? null });

  const apagados = {};
  await emTransacao(async (tx) => {
    const apagar = async (nome, tabela, extra) => {
      const r = await tx.delete(tabela).where(and(eq(tabela.tenantId, tenantId), extra));
      apagados[nome] = (apagados[nome] ?? 0) + (r.rowsAffected ?? 0);
    };

    // A ordem importa: filho antes do pai onde a chave e "restrict".
    if (pedidos.has('campanhas') || pedidos.has('atendimento')) {
      await apagar('envios de campanha', s.campaignTargets);
    }
    if (pedidos.has('campanhas')) await apagar('campanhas', s.campaigns);

    if (pedidos.has('atendimento')) {
      await apagar('notificacoes', s.teamNotifications);
      await apagar('historico de atendimentos', s.serviceHistory);
      await apagar('vendas', s.productSales);
      await apagar('agendamentos', s.appointments);
      await apagar('mensagens', s.messages);
      await apagar('conversas', s.conversations);
      await apagar('clientes', s.leads);
      await apagar('bloqueios de agenda', s.scheduleBlocks);
    }

    if (pedidos.has('catalogo')) {
      await apagar('movimentos de estoque', s.stockMovements);
      await apagar('servicos por profissional', s.professionalServices);
      await apagar('produtos', s.products);
      await apagar('servicos', s.services);
      await apagar('profissionais', s.professionals);
    }

    if (pedidos.has('equipe')) {
      // Exclusao de verdade: sessoes, respostas rapidas e avisos vao em cascata.
      await apagar('usuarios', s.users, notInArray(s.users.cargo, ['owner', 'dev']));
    }

    if (pedidos.has('registros')) {
      await apagar('auditoria', s.auditLogs);
      await apagar('uso de IA', s.aiCalls);
      await apagar('avisos', s.teamAlerts);
    }
  });

  log.warn({ tenantId, grupos: [...pedidos], backup: backup.id, apagados, por: usuario?.id }, 'Dados apagados');
  return { backup: backup.id, apagados };
}

