import * as conversasRepo from '../conversas/conversas.repo.js';
import { lerEstadoRodizio, obterConfiguracao, salvarEstadoRodizio } from './equipe.config.js';

/**
 * Escolhe QUEM da equipe recebe algo, seguindo o que a empresa configurou em
 * Equipe > Atendentes > Distribuicao.
 *
 * Existe separado da conversa porque dois momentos diferentes precisam da mesma
 * escolha:
 *
 *   - o cliente pediu um humano (a conversa vai para alguem);
 *   - a IA fechou um horario (o cliente precisa de um responsavel ate o dia do
 *     servico, mesmo que a Sofia continue conversando).
 */

/**
 * A vez de quem, no rodizio.
 *
 * Guardamos apenas QUEM RECEBEU POR ULTIMO e seguimos a partir dele, numa lista
 * ordenada por id (estavel, nao muda quando alguem troca de nome). Quem entrou
 * na equipe ontem entra na roda sem zerar a vez de ninguem, e quem saiu
 * simplesmente deixa de aparecer.
 *
 * Guardar so o ultimo, em vez de um contador, e o que torna isso correto quando
 * a equipe muda de tamanho entre uma escolha e outra.
 */
async function proximoDoRodizio(tenantId, comVaga) {
  if (comVaga.length === 0) return undefined;

  const ordenados = [...comVaga].sort((a, b) => a.id.localeCompare(b.id));
  const ultimo = await lerEstadoRodizio(tenantId);

  const posicao = ordenados.findIndex((a) => a.id === ultimo);
  // Sem historico (ou quem recebeu por ultimo nao esta disponivel agora):
  // comeca do inicio da lista.
  return ordenados[(posicao + 1) % ordenados.length];
}

/**
 * QUEM entra na roda de distribuicao.
 *
 * Por padrao, so quem tem cargo de ATENDENTE. Dono e administradores nao
 * recebem cliente automaticamente: eles estao no sistema para acompanhar, e um
 * dono que deixa a tela aberta ("online") virava o unico elegivel quando os
 * atendentes estavam offline — o cliente da IA caia no colo de quem nao
 * atende. A empresa pode incluir a gerencia na roda (uma barbearia de dois
 * donos que tambem atendem), mas e uma escolha, nao o padrao.
 */
function cargosDaRoda(config) {
  return config.distribuirParaGerencia ? ['atendente', 'admin', 'owner'] : ['atendente'];
}

/**
 * Quem atende a fila: os mesmos cargos da roda de distribuicao, em qualquer
 * presenca. E para quem vai a notificacao de um cliente que ficou sem dono —
 * quem esta offline ve quando entrar, se ninguem tiver atendido antes.
 */
export async function quemAtendeAFila(tenantId) {
  const config = await obterConfiguracao(tenantId);
  return conversasRepo.atendentesDisponiveis(tenantId, { cargos: cargosDaRoda(config) });
}

/**
 * @param {string} tenantId
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.semPlantao]
 *   Quando ninguem esta de plantao com vaga, escolhe mesmo assim quem tem menos
 *   conversas — SEMPRE entre os atendentes. Serve a horarios ja marcados: o
 *   cliente PRECISA de um responsavel, e "ninguem" seria pior do que um
 *   atendente momentaneamente offline (ele ve o horario quando voltar). So se
 *   a empresa nao tem NENHUM atendente ativo a gerencia assume: melhor um
 *   responsavel do que nenhum. Para entregar uma conversa da fila NAO se usa —
 *   ali, esperar na fila e melhor do que empurrar para quem nao esta.
 * @returns {Promise<{id: string, nome: string}|null>}
 */
export async function escolherAtendente(tenantId, { semPlantao = false } = {}) {
  const config = await obterConfiguracao(tenantId);
  const cargos = cargosDaRoda(config);

  const noPlantao = await conversasRepo.atendentesDisponiveis(tenantId, {
    presencas: config.distribuirSomenteOnline ? ['online'] : ['online', 'ausente'],
    cargos
  });
  const comVaga = noPlantao.filter((a) => Number(a.emAtendimento) < a.capacidade);

  const escolhido =
    config.criterioDistribuicao === 'rodizio' ? await proximoDoRodizio(tenantId, comVaga) : comVaga[0];

  if (escolhido) {
    if (config.criterioDistribuicao === 'rodizio') await salvarEstadoRodizio(tenantId, escolhido.id);
    return escolhido;
  }

  if (!semPlantao) return null;

  // Atendentes em qualquer estado de presenca; ja vem do menos ao mais carregado.
  const atendentes = await conversasRepo.atendentesDisponiveis(tenantId, { cargos });
  if (atendentes.length > 0) return atendentes[0];

  // Empresa sem nenhum atendente: a gerencia assume, preferindo administradores.
  const gerencia = await conversasRepo.atendentesDisponiveis(tenantId, { cargos: ['admin', 'owner'] });
  return gerencia.find((a) => a.cargo === 'admin') ?? gerencia[0] ?? null;
}
