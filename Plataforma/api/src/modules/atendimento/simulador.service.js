import { comContexto } from '../../core/logger.js';
import * as leads from '../leads/leads.service.js';
import * as leadsRepo from '../leads/leads.repo.js';
import { historicoLimitado, responder } from './atendimento.service.js';

const log = comContexto({ modulo: 'simulador' });

/**
 * Simulador de atendimento.
 *
 * Deixa o dono da empresa conversar com o sistema como se fosse um cliente no
 * WhatsApp — e ver os BASTIDORES: qual modo respondeu, o que a Sofia pediu a
 * Atena, quais consultas a Atena fez no banco, qual modelo respondeu e quanto
 * demorou. E a forma de testar um prompt novo, ou de entender por que a IA
 * respondeu aquilo, sem esperar um cliente de verdade.
 *
 * DUAS GARANTIAS que o distinguem de uma conversa real:
 *
 * 1. NADA VAI PARA UM CANAL. O simulador nao envia nada ao WhatsApp e nao
 *    mexe na fila humana. Ele so devolve o que ENVIARIA.
 *
 * 2. POR PADRAO, SOMENTE LEITURA. A Atena consulta mas nao cria, edita nem
 *    exclui. Testar "quero marcar amanha as 14h" nao pode encher a agenda
 *    real de agendamentos de teste. Quem quer ver a gravacao acontecendo
 *    precisa marcar isso de proposito — e a tela avisa.
 */

/**
 * Telefone reservado ao cliente de teste. Passa na validacao (DDD 11) mas
 * termina em zeros, que numero de celular real nao usa.
 */
const TELEFONE_SIMULADOR = '5511900000000';

/**
 * O cliente de teste.
 *
 * As ferramentas da Atena trabalham sobre "o cliente da conversa", entao o
 * simulador precisa de um cadastro de verdade. Ele e marcado como simulador
 * e como "nao recebe campanha" — para nunca entrar num disparo por engano.
 */
async function leadDoSimulador(tenantId) {
  const lead = await leads.encontrarOuCriarPorTelefone(tenantId, TELEFONE_SIMULADOR, 'Simulador (teste)');

  if (lead.origem !== 'simulador') {
    await leadsRepo.atualizar(tenantId, lead.id, {
      origem: 'simulador',
      aceitaCampanha: false,
      tags: ['simulador']
    });
  }
  return lead;
}

/**
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} p.mensagem
 * @param {{papel:'user'|'assistant', conteudo:string}[]} [p.historico] a conversa ate aqui (a tela guarda)
 * @param {'menu'|'hibrido'|'ia'|null} [p.modo]   forca um modo so nesta simulacao
 * @param {boolean} [p.permitirEscrita]
 * @param {object[]} [p.provedores]               injetado nos testes
 */
export async function simular({
  tenantId,
  mensagem,
  historico = [],
  modo = null,
  permitirEscrita = false,
  menuEstado = null,
  provedores = null
}) {
  const lead = await leadDoSimulador(tenantId);
  const inicio = Date.now();

  const resposta = await responder({
    tenantId,
    conversationId: null,
    leadId: lead.id,
    leadNome: 'Cliente de teste',
    texto: mensagem,
    // Respeita a mesma "janela de contexto" da conversa real: senao o
    // simulador se comportaria diferente do atendimento de verdade.
    historico: await historicoLimitado(tenantId, historico),
    simulacao: true,
    permitirEscrita,
    modoOverride: modo,
    menuEstado,
    provedores
  });

  log.info(
    { tenantId, respondidoPor: resposta.respondidoPor, escrita: permitirEscrita },
    'Simulacao executada'
  );

  return {
    baloes: resposta.baloes,
    respondidoPor: resposta.respondidoPor,
    transferido: Boolean(resposta.transferido),
    // A tela devolve isto no proximo turno: e assim que o simulador "lembra"
    // em que submenu o cliente de teste esta. `undefined` = o menu nem rodou
    // (modo IA), entao o estado anterior continua valendo.
    menuEstado: 'menuEstado' in resposta.detalhes ? resposta.detalhes.menuEstado : menuEstado,
    bastidores: {
      ...resposta.detalhes,
      duracaoMs: Date.now() - inicio,
      permitiuEscrita: permitirEscrita
    }
  };
}
