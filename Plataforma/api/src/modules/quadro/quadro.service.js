import { NaoEncontrado, RegraDeNegocio } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { dataNoFuso, formatarBR, FUSO_PADRAO } from '../../core/datetime.js';
import * as agenda from '../agenda/agenda.service.js';
import * as agendaRepo from '../agenda/agenda.repo.js';
import * as conversas from '../conversas/conversas.service.js';
import * as conversasRepo from '../conversas/conversas.repo.js';
import { COLUNAS, COLUNA_POR_STATUS, COLUNAS_DE_CONVERSA, statusDaColuna } from './etapas.js';

const log = comContexto({ modulo: 'quadro' });

/**
 * O quadro de atendimento.
 *
 * Um cartao e um ATENDIMENTO, nao uma conversa nem uma OS — e a mesma coisa
 * vista em dois momentos. Comeca como conversa ("oi, tem horario hoje?"),
 * ganha uma OS quando o horario fecha, e termina quando o servico acontece.
 *
 * A regra que evita o cartao duplicado: quando a conversa JA tem uma OS no
 * dia que o quadro mostra, o cartao e o da OS — ela sabe o horario, o preco e
 * o profissional, que e o que importa dali em diante. A conversa so vira
 * cartao proprio enquanto nao ha horario marcado para aquele dia.
 */

async function fusoDaEmpresa(tenantId) {
  const tenant = await agendaRepo.buscarTenant(tenantId);
  return tenant?.fusoHorario || FUSO_PADRAO;
}

/** Cartao a partir de uma OS ja apresentada pelo servico da agenda. */
function cartaoDaOS(a) {
  return {
    id: `os:${a.id}`,
    tipo: 'os',
    coluna: COLUNA_POR_STATUS[a.status] ?? 'confirmado',

    agendamentoId: a.id,
    conversationId: a.conversationId,
    leadId: a.leadId,
    leadNome: a.leadNome,
    leadTelefoneFormatado: a.leadTelefoneFormatado,

    titulo: a.servicoNome,
    quando: a.quandoFormatado,
    horaInicio: a.horaInicio,
    profissionalNome: a.profissionalNome,
    profissionalCor: a.profissionalCor,
    valor: a.totalFormatado,

    status: a.status,
    criadoPor: a.criadoPor,
    sessaoAtiva: a.sessaoAtiva,
    humor: a.humorAtendimento ?? null,
    resumo: a.resumoAtendimento ?? null,
    observacoes: a.observacoes || null,
    arquivadoEm: a.arquivadoEm
  };
}

/** Cartao a partir de uma conversa aberta, com o horario marcado (se houver). */
function cartaoDaConversa(c, os, fuso) {
  return {
    id: `conversa:${c.id}`,
    tipo: 'conversa',
    coluna: c.etapaAtendimento,

    agendamentoId: os?.id ?? null,
    conversationId: c.id,
    leadId: c.leadId,
    leadNome: c.leadNome,
    leadTelefoneFormatado: c.leadTelefoneFormatado,

    titulo: os?.servicoNome ?? c.ultimaMensagemPreview ?? 'Sem mensagens',
    // Um horario ja marcado para outro dia continua visivel no cartao: e o
    // dado que evita o atendente reoferecer um horario que o cliente ja tem.
    quando: os ? formatarBR(os.inicioEm, fuso) : null,
    horaInicio: null,
    profissionalNome: null,
    profissionalCor: null,
    valor: null,

    status: c.status,
    criadoPor: null,
    sessaoAtiva: true,
    humor: c.humor ?? null,
    resumo: c.humorResumo ?? null,
    observacoes: c.anotacoesHumanas || null,

    canal: c.canal,
    canalChave: c.canalChave,
    atendenteNome: c.atendenteNome,
    naoLidas: c.naoLidas,
    ultimaMensagemEm: c.ultimaMensagemEm
  };
}

/**
 * Monta o quadro de um dia.
 *
 * @param {object} [filtros]
 * @param {string} [filtros.data] AAAA-MM-DD; padrao hoje, no fuso da empresa.
 */
export async function quadro(tenantId, { data } = {}, usuario) {
  const fuso = await fusoDaEmpresa(tenantId);
  const dia = data || dataNoFuso(Date.now(), fuso);

  const [doDia, abertas] = await Promise.all([
    // Ambas as listas respeitam a privacidade da equipe: o quadro de um
    // atendente mostra os atendimentos dele, nao os do colega ao lado.
    agenda.listar(tenantId, { data: dia }, usuario),
    // O quadro so tem sentido com conversa viva; finalizada ja virou
    // historico e, se rendeu OS, ela e quem aparece.
    conversas.listar(tenantId, { filtro: 'ativas', limite: 100 }, usuario)
  ]);

  const cartoes = doDia.map(cartaoDaOS);

  // Conversa que ja tem OS HOJE nao vira cartao proprio: seria o mesmo
  // atendimento em duas colunas ao mesmo tempo.
  const comOsHoje = new Set(doDia.map((a) => a.conversationId).filter(Boolean));
  const semOsHoje = abertas.itens.filter((c) => !comOsHoje.has(c.id));

  const marcados = await agendaRepo.porConversas(
    tenantId,
    semOsHoje.map((c) => c.id)
  );
  const proximaPorConversa = new Map();
  for (const os of marcados) {
    if (!proximaPorConversa.has(os.conversationId)) proximaPorConversa.set(os.conversationId, os);
  }

  for (const c of semOsHoje) {
    cartoes.push(cartaoDaConversa(c, proximaPorConversa.get(c.id), fuso));
  }

  await marcarQuemPrecisaDeGente(tenantId, cartoes, abertas.itens);

  const porColuna = new Map(COLUNAS.map((c) => [c.chave, []]));
  for (const cartao of cartoes) {
    // Coluna desconhecida (dado antigo) nao some do quadro: cai na primeira.
    const alvo = porColuna.has(cartao.coluna) ? cartao.coluna : COLUNAS[0].chave;
    porColuna.get(alvo).push(cartao);
  }

  return {
    data: dia,
    fuso,
    colunas: COLUNAS.map((c) => ({
      ...c,
      cartoes: porColuna.get(c.chave),
      total: porColuna.get(c.chave).length
    })),
    total: cartoes.length
  };
}

/**
 * Marca os cartoes cujo cliente esta esperando uma PESSOA responder.
 *
 *   'na_fila'      — a conversa foi para a fila humana e ninguem assumiu.
 *   'sem_resposta' — um atendente assumiu, mas a ultima mensagem e do cliente.
 *
 * Conversa com a Sofia nunca entra: ela responde sozinha, e piscar ali seria
 * alarme falso — o tipo de alerta que a equipe aprende a ignorar. Vale tambem
 * para o cartao da OS, quando o atendimento dela e dessa conversa.
 */
async function marcarQuemPrecisaDeGente(tenantId, cartoes, conversasAbertas) {
  const porId = new Map(conversasAbertas.map((c) => [c.id, c]));
  const comAtendente = conversasAbertas.filter((c) => c.status === 'humana').map((c) => c.id);
  const ultima = await conversasRepo.ultimaDirecaoPorConversa(tenantId, comAtendente);

  for (const cartao of cartoes) {
    const c = cartao.conversationId ? porId.get(cartao.conversationId) : null;
    if (!c) continue;
    if (c.status === 'na_fila') cartao.precisaDeGente = 'na_fila';
    else if (c.status === 'humana' && ultima.get(c.id) === 'entrada') cartao.precisaDeGente = 'sem_resposta';
  }
}

/**
 * Move um cartao de coluna.
 *
 * Nas colunas iniciais isso e mudar a etapa da conversa. Nas finais e mudar o
 * status da OS — e ai valem as travas da agenda: um `concluido` nao volta
 * para `confirmado`, e um cartao de conversa nao pode ser jogado em
 * "Em execucao" porque nao existe horario para executar.
 */
export async function mover(tenantId, cartaoId, coluna, { usuario } = {}) {
  const [tipo, id] = String(cartaoId).split(':');
  if (!id) throw new RegraDeNegocio('Cartao invalido.');

  const destinoDeConversa = COLUNAS_DE_CONVERSA.has(coluna);
  const statusAlvo = statusDaColuna(coluna);

  if (tipo === 'conversa') {
    if (destinoDeConversa) {
      await conversas.moverEtapa(tenantId, id, coluna, { usuario });
      return quadroDoCartao(tenantId, usuario);
    }

    // "Confirmados" e as colunas seguintes exigem um horario marcado. Marcar
    // um horario precisa de servico, profissional e hora — coisas que so a
    // tela de agendar tem.
    throw new RegraDeNegocio(
      'Este atendimento ainda nao tem horario marcado. Marque o horario pela agenda para ele entrar nas colunas seguintes.'
    );
  }

  if (tipo !== 'os') throw new RegraDeNegocio('Cartao invalido.');

  if (destinoDeConversa && !statusAlvo.length) {
    throw new RegraDeNegocio(
      'Um atendimento com horario marcado nao volta para as etapas de conversa. Cancele o horario, se for o caso.'
    );
  }

  // Com o usuario, um cartao fora do escopo dele responde "nao encontrado".
  const ag = await agenda.obter(tenantId, id, usuario);
  if (!ag) throw new NaoEncontrado('Agendamento');

  // A coluna "Cancelado" cobre dois estados; ficar no atual evita transformar
  // uma falta em cancelamento so porque alguem arrastou o cartao de volta.
  const novo = statusAlvo.includes(ag.status) ? ag.status : statusAlvo[0];
  if (novo !== ag.status) {
    await agenda.mudarStatus(tenantId, id, novo, { usuario });
  }

  return quadroDoCartao(tenantId, usuario);
}

/** Recarrega o quadro do dia da OS movida (o front espera o quadro inteiro). */
function quadroDoCartao(tenantId, usuario) {
  return quadro(tenantId, {}, usuario);
}

/**
 * Fechamento do dia.
 *
 * Roda no fim do expediente e faz duas coisas, nesta ordem:
 *
 *   1. finaliza as sessoes de atendimento que ficaram abertas em OS ja
 *      encerradas — e a finalizacao que anexa resumo, anotacoes e humor a OS;
 *   2. arquiva as OS encerradas (concluidas, canceladas e faltas), tirando-as
 *      da agenda do dia a dia sem apagar nada.
 *
 * Rodando pela Atena (`encerrarOciosas`), ha um terceiro passo: conversas que a
 * IA conduzia e ficaram paradas ha horas sao finalizadas — o cliente que sumiu
 * no meio do orcamento nao pode ficar no quadro para sempre. So as conduzidas
 * pela IA (`bot`): conversa com atendente humano e decisao do atendente.
 *
 * O que ela NAO faz: concluir atendimento por conta propria. Uma OS que
 * continua "confirmado" as 22h pode ter acontecido sem ninguem marcar, ou o
 * cliente pode ter sumido — sao coisas diferentes, com efeitos diferentes no
 * faturamento. Essas voltam na lista `pendentes`, para uma pessoa decidir.
 */
export async function fecharDia(tenantId, { data, encerrarOciosas = false, horasOciosa = 6 } = {}, usuario) {
  const fuso = await fusoDaEmpresa(tenantId);
  const dia = data || dataNoFuso(Date.now(), fuso);

  const doDia = await agenda.listar(tenantId, { data: dia });

  const encerradas = doDia.filter((a) => ['concluido', 'cancelado', 'faltou'].includes(a.status));
  const pendentes = doDia.filter((a) => ['pendente', 'confirmado', 'em_andamento'].includes(a.status));

  let conversasFinalizadas = 0;
  let arquivadas = 0;

  for (const a of encerradas) {
    if (a.sessaoAtiva && a.conversationId) {
      try {
        await conversas.finalizar(tenantId, a.conversationId, {}, usuario);
        conversasFinalizadas += 1;
      } catch (err) {
        // Conversa com outro atendente, ja finalizada por ele, etc. Nao pode
        // impedir o arquivamento do resto do dia.
        log.warn({ err, tenantId, conversationId: a.conversationId }, 'Sessao nao finalizada no fechamento');
      }
    }

    if (a.arquivadoEm) continue;

    try {
      await agenda.arquivar(tenantId, a.id, { usuario });
      arquivadas += 1;
    } catch (err) {
      log.warn({ err, tenantId, agendamentoId: a.id }, 'OS nao arquivada no fechamento');
    }
  }

  let ociosasFinalizadas = 0;

  if (encerrarOciosas) {
    const corte = Date.now() - horasOciosa * 3_600_000;
    const { itens } = await conversas.listar(tenantId, { filtro: 'bot', limite: 100 }, usuario);

    for (const c of itens) {
      if (!c.ultimaMensagemEm || c.ultimaMensagemEm > corte) continue;
      try {
        await conversas.finalizar(tenantId, c.id, {}, usuario);
        ociosasFinalizadas += 1;
      } catch (err) {
        log.warn({ err, tenantId, conversationId: c.id }, 'Conversa ociosa nao finalizada');
      }
    }
  }

  log.info({ tenantId, data: dia, arquivadas, conversasFinalizadas, ociosasFinalizadas }, 'Dia fechado');

  return {
    data: dia,
    arquivadas,
    conversasFinalizadas,
    ociosasFinalizadas,
    pendentes: pendentes.map((a) => ({
      id: a.id,
      leadNome: a.leadNome,
      servicoNome: a.servicoNome,
      hora: a.horaInicio,
      status: a.status
    }))
  };
}
