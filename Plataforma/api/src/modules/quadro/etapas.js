import { ETAPAS_ATENDIMENTO } from '../../db/schema/conversations.js';

/**
 * As colunas do quadro de atendimento.
 *
 * O quadro tem duas metades, e elas NAO funcionam do mesmo jeito — e isso e
 * de proposito.
 *
 * A primeira metade (`conversa`) e o comeco do atendimento: alguem chamou no
 * WhatsApp e ainda nao ha horario fechado. Essas colunas sao um campo na
 * conversa, movido pela Atena enquanto conduz o papo (ou por um atendente
 * arrastando o cartao).
 *
 * A segunda metade (`os`) e o estado real do agendamento. Aqui NAO existe
 * campo de etapa: a coluna e lida do `status` da OS. Se existisse um campo
 * proprio, ele discordaria da agenda no primeiro cancelamento — e o quadro
 * mostraria "Em execucao" para um cliente que desmarcou ontem.
 *
 * Por isso mover um cartao para as colunas finais nao "muda a etapa": muda o
 * status do agendamento, com as mesmas travas de sempre (`mudarStatus` recusa
 * pulos invalidos, `concluido` continua sendo o unico que vira faturamento).
 */
export const COLUNAS = [
  {
    chave: 'novo',
    titulo: 'Novo contato',
    descricao: 'Chegou agora. Ninguem entendeu o pedido ainda.',
    tipo: 'conversa',
    cor: '#38BDF8'
  },
  {
    chave: 'entendendo',
    titulo: 'Entendendo o pedido',
    descricao: 'Descobrindo servico, profissional e preferencia de horario.',
    tipo: 'conversa',
    cor: '#818CF8'
  },
  {
    chave: 'orcamento',
    titulo: 'Orcamento apresentado',
    descricao: 'Preco e horarios ja foram informados ao cliente.',
    tipo: 'conversa',
    cor: '#A78BFA'
  },
  {
    chave: 'aguardando',
    titulo: 'Aguardando confirmacao',
    descricao: 'A proposta esta de pe, faltando o cliente fechar.',
    tipo: 'conversa',
    // Uma OS 'pendente' e exatamente isto: pedido feito, nao confirmado.
    statusOS: ['pendente'],
    cor: '#E89558'
  },
  {
    chave: 'confirmado',
    titulo: 'Confirmados do dia',
    descricao: 'Horario fechado para esta data. E por aqui que o dia comeca.',
    tipo: 'os',
    statusOS: ['confirmado'],
    cor: '#1856FF'
  },
  {
    chave: 'em_andamento',
    titulo: 'Em execucao',
    descricao: 'O cliente esta sendo atendido agora.',
    tipo: 'os',
    statusOS: ['em_andamento'],
    cor: '#07CA6B'
  },
  {
    chave: 'concluido',
    titulo: 'Concluido',
    descricao: 'Servico entregue. Entra no faturamento do dia.',
    tipo: 'os',
    statusOS: ['concluido'],
    cor: '#07CA6B'
  },
  {
    chave: 'cancelado',
    titulo: 'Cancelado',
    descricao: 'Desmarcado ou o cliente nao apareceu.',
    tipo: 'os',
    statusOS: ['cancelado', 'faltou'],
    cor: '#EA2143'
  }
];

export const CHAVES_COLUNAS = COLUNAS.map((c) => c.chave);

/** Colunas que a Atena e o atendente movem mexendo na conversa. */
export const COLUNAS_DE_CONVERSA = new Set(ETAPAS_ATENDIMENTO);

/** Status de OS -> coluna onde o cartao aparece. */
export const COLUNA_POR_STATUS = Object.fromEntries(
  COLUNAS.flatMap((c) => (c.statusOS ?? []).map((s) => [s, c.chave]))
);

/** Status que uma coluna final representa (o primeiro e o destino ao arrastar). */
export function statusDaColuna(chave) {
  return COLUNAS.find((c) => c.chave === chave)?.statusOS ?? [];
}
