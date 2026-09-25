import { Conflito, NaoEncontrado, RegraDeNegocio } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { formatarBRL } from '../../core/money.js';
import { formatarTelefone } from '../../core/phone.js';
import {
  dataNoFuso,
  FUSO_PADRAO,
  fimDoDia,
  formatarBR,
  horaNoFuso,
  inicioDoDia,
  instanteDeLocal,
  somarDias,
  somarMinutos
} from '../../core/datetime.js';
import { emTransacao } from '../../db/client.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import { calcularHorariosLivres, podeAgendar } from './disponibilidade.js';
import { planejarSequencia } from './sequencia.js';
import * as repo from './agenda.repo.js';
import * as leadsRepo from '../leads/leads.repo.js';
import { escopoDe } from '../equipe/equipe.config.js';
import { escolherAtendente } from '../equipe/distribuidor.js';
import * as conversasRepo from '../conversas/conversas.repo.js';
import { registrarDesfecho } from '../historico/historico.service.js';

const log = comContexto({ modulo: 'agenda' });

/**
 * Regras da agenda.
 *
 * O ponto mais delicado deste modulo e a criacao de agendamento: ela precisa
 * ser atomica contra a "corrida de marcacao", quando dois atendentes marcam o
 * mesmo horario ao mesmo tempo. Veja o comentario em `criar()`.
 */

/** Descobre o fuso da empresa. Nenhuma conta de data acontece sem isto. */
async function fusoDaEmpresa(tenantId) {
  const tenant = await repo.buscarTenant(tenantId);
  return tenant?.fusoHorario || FUSO_PADRAO;
}

function apresentar(linha, fuso) {
  if (!linha) return null;
  const a = linha.agendamento;
  const total = a.precoCentavos - a.descontoCentavos;

  return {
    id: a.id,
    leadId: a.leadId,
    leadNome: linha.leadNome,
    leadTelefone: linha.leadTelefone,
    leadTelefoneFormatado: linha.leadTelefone ? formatarTelefone(linha.leadTelefone) : null,
    serviceId: a.serviceId,
    servicoNome: linha.servicoNome,
    professionalId: a.professionalId,
    profissionalNome: linha.profissionalNome,
    profissionalCor: linha.profissionalCor,

    inicioEm: a.inicioEm.getTime(),
    fimEm: a.fimEm.getTime(),
    // O front recebe pronto no fuso da empresa — assim nenhuma tela precisa
    // refazer conta de fuso, que e onde esse tipo de erro costuma nascer.
    data: dataNoFuso(a.inicioEm, fuso),
    horaInicio: horaNoFuso(a.inicioEm, fuso),
    horaFim: horaNoFuso(a.fimEm, fuso),
    quandoFormatado: formatarBR(a.inicioEm, fuso),

    status: a.status,
    precoCentavos: a.precoCentavos,
    descontoCentavos: a.descontoCentavos,
    totalCentavos: total,
    totalFormatado: formatarBRL(total),

    observacoes: a.observacoes,
    checklist: a.checklist ?? [],

    // Sessao de atendimento que originou a OS. `sessaoAtiva` = a conversa
    // ainda esta aberta, ou seja, o vinculo ainda nao foi encerrado.
    conversationId: a.conversationId ?? null,
    lembreteEnviadoEm: a.lembreteEnviadoEm?.getTime() ?? null,
    sessaoAtiva: Boolean(a.conversationId && linha.conversaStatus && linha.conversaStatus !== 'finalizada'),
    resumoAtendimento: a.resumoAtendimento ?? null,
    resumoEm: a.resumoEm?.getTime() ?? null,
    anotacoesAtendimento: a.anotacoesAtendimento ?? null,
    humorAtendimento: a.humorAtendimento ?? null,
    concluidoEm: a.concluidoEm?.getTime() ?? null,
    confirmadoEm: a.confirmadoEm?.getTime() ?? null,
    duracaoMinutos: Math.round((a.fimEm.getTime() - a.inicioEm.getTime()) / 60_000),
    canceladoEm: a.canceladoEm?.getTime() ?? null,
    motivoCancelamento: a.motivoCancelamento ?? null,
    criadoPor: a.criadoPor,
    responsavelUserId: a.responsavelUserId ?? null,
    responsavelNome: linha.responsavelNome ?? null,
    arquivadoEm: a.arquivadoEm?.getTime() ?? null,
    createdAt: a.createdAt.getTime()
  };
}

/**
 * Lista os agendamentos de um dia (ou de um intervalo de dias).
 */
export async function listar(tenantId, filtros = {}, usuario) {
  const fuso = await fusoDaEmpresa(tenantId);
  const dataInicial = filtros.data || dataNoFuso(Date.now(), fuso);
  const dataFinal = filtros.dataFim || dataInicial;

  const linhas = await repo.listar(tenantId, {
    escopo: await escopoDe(tenantId, usuario),
    inicioEm: inicioDoDia(dataInicial, fuso),
    fimEm: fimDoDia(dataFinal, fuso),
    professionalId: filtros.professionalId,
    status: filtros.status,
    leadId: filtros.leadId,
    incluirArquivados: filtros.incluirArquivados
  });

  return linhas.map((l) => apresentar(l, fuso));
}

/**
 * Marca que o lembrete de vespera destas OS ja saiu (ver `enviarLembretesSeForHora`).
 * E so uma marca: nao mexe em status nem entra na auditoria.
 */
export async function marcarLembreteEnviado(tenantId, ids, quando = new Date()) {
  for (const id of ids) await repo.atualizar(tenantId, id, { lembreteEnviadoEm: quando });
}

/**
 * Um agendamento.
 *
 * Com `usuario`, respeita a privacidade da equipe. Sem ele, quem chama e o
 * sistema (a Atena, as rotinas) e enxerga tudo.
 */
export async function obter(tenantId, id, usuario) {
  const fuso = await fusoDaEmpresa(tenantId);
  const linha = await repo.buscarPorId(tenantId, id);
  if (!linha) throw new NaoEncontrado('Agendamento');
  await garantirVisivel(tenantId, linha, usuario);
  // O detalhe (painel da OS) leva junto o contexto do cliente e as vendas.
  return { ...apresentar(linha, fuso), contexto: await repo.contextoDaOS(tenantId, linha.agendamento) };
}

/**
 * Este agendamento existe PARA ESTA PESSOA?
 *
 * Fora do escopo o erro e "nao encontrado", nunca "sem permissao": dizer
 * "existe, mas nao e seu" ja conta que aquele cliente tem horario marcado.
 */
async function garantirVisivel(tenantId, linha, usuario) {
  if (!usuario) return;
  const escopo = await escopoDe(tenantId, usuario);
  if (escopo.tudo) return;

  const a = linha.agendamento;
  const meu =
    (escopo.professionalIds ?? []).includes(a.professionalId) ||
    a.responsavelUserId === escopo.userId ||
    a.criadoPorUserId === escopo.userId ||
    (a.conversationId && (await repo.buscarConversa(tenantId, a.conversationId))?.assignedUserId === escopo.userId);

  if (!meu) throw new NaoEncontrado('Agendamento');
}

/** Carrega e confere o acesso de uma vez, para as acoes de escrita. */
async function carregarParaAcao(tenantId, id, usuario) {
  const linha = await repo.buscarPorId(tenantId, id);
  if (!linha) throw new NaoEncontrado('Agendamento');
  await garantirVisivel(tenantId, linha, usuario);
  return linha;
}

/**
 * Todos os agendamentos de um cliente, de qualquer data.
 *
 * `listar` responde "o que tem na agenda nesse dia?". Esta responde "o que
 * este cliente tem com a gente?" — a pergunta que a Atena precisa para
 * remarcar, cancelar ou confirmar o horario de alguem.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.apenasFuturos] so o que ainda vai acontecer e nao foi encerrado
 */
export async function listarDoCliente(tenantId, leadId, { apenasFuturos = false, limite = 30 } = {}) {
  const fuso = await fusoDaEmpresa(tenantId);

  const linhas = await repo.listar(tenantId, { leadId, incluirArquivados: true });
  let lista = linhas.map((l) => apresentar(l, fuso));

  if (apenasFuturos) {
    const agora = Date.now();
    lista = lista.filter(
      (a) => a.fimEm >= agora && ['pendente', 'confirmado', 'em_andamento'].includes(a.status)
    );
  } else {
    // Do mais recente para o mais antigo: quem pergunta pelo historico quer
    // ver primeiro o que aconteceu por ultimo.
    lista.reverse();
  }

  return lista.slice(0, limite);
}

/**
 * Os horarios de um atendente: o que ele precisa acompanhar ate o dia do servico.
 *
 * E a lista de trabalho de quem cuida do cliente — confirmar presenca, avisar de
 * atraso, remarcar. Traz o que ainda VAI acontecer (de hoje em diante) e cada
 * item aponta para a conversa onde falar com o cliente.
 *
 * Vale a mesma regra de todo o resto: um atendente so consulta a lista dele.
 * Pedir a de outro devolve a propria — nao um erro, porque a tela do dono usa
 * o mesmo endpoint com um seletor, e o servidor e quem decide o que vale.
 */
export async function doAtendente(tenantId, usuario, { atendenteId } = {}) {
  const escopo = await escopoDe(tenantId, usuario);
  const alvo = atendenteId && (escopo.tudo || atendenteId === usuario.id) ? atendenteId : usuario.id;

  const fuso = await fusoDaEmpresa(tenantId);
  const desde = inicioDoDia(dataNoFuso(Date.now(), fuso), fuso);

  const linhas = await repo.listar(tenantId, {
    inicioEm: desde,
    responsavelUserId: alvo,
    status: ['pendente', 'confirmado', 'em_andamento'],
    incluirArquivados: false
  });

  // Onde falar com o cliente: a conversa que originou o horario ou, se ele foi
  // marcado a mao, a mais recente do cliente. So serve se for do proprio
  // atendente (ou de ninguem) — apontar para a conversa de outro levaria a um
  // "nao encontrado" no meio da tela.
  const porLead = new Map();
  const conversaDe = async (a) => {
    let conversa = a.agendamento.conversationId
      ? await repo.buscarConversa(tenantId, a.agendamento.conversationId)
      : null;
    if (!conversa) {
      const leadId = a.agendamento.leadId;
      if (!porLead.has(leadId)) porLead.set(leadId, await repo.conversaMaisRecenteDoLead(tenantId, leadId));
      conversa = porLead.get(leadId);
    }
    if (!conversa) return null;
    if (conversa.assignedUserId && conversa.assignedUserId !== alvo) return null;
    return conversa;
  };

  const itens = [];
  for (const l of linhas) {
    const conversa = await conversaDe(l);
    itens.push({
      ...apresentar(l, fuso),
      conversaId: conversa?.id ?? null,
      conversaFinalizada: conversa ? conversa.status === 'finalizada' : null
    });
  }

  return itens;
}

/** Os horarios ainda por acontecer acompanham a conversa quando ela troca de mao. */
export function transferirResponsavel(tenantId, conversationId, userId) {
  return repo.transferirResponsavel(tenantId, conversationId, userId);
}

export function temAbertaDaConversa(tenantId, conversationId) {
  return repo.temAbertaDaConversa(tenantId, conversationId);
}

/**
 * A historia do cliente com a empresa: as OS e os atendimentos.
 *
 * Um atendimento so vira item proprio quando NAO gerou horario marcado. Se
 * gerou, a OS ja carrega o resumo, as anotacoes e o humor daquela conversa, e
 * listar os dois mostraria o mesmo fato duas vezes.
 *
 * O que muda de verdade aqui e o cliente que conversou e nao fechou nada:
 * antes ele sumia do historico como se nunca tivesse existido. Agora fica
 * registrado — com o resumo do que foi conversado e por que nao avancou, que
 * e justamente o que a proxima pessoa a atende-lo precisa saber.
 */
export async function historicoDoCliente(tenantId, leadId) {
  const [agendamentos, historico] = await Promise.all([
    listarDoCliente(tenantId, leadId, { limite: 100 }),
    leadsRepo.historico(tenantId, leadId)
  ]);

  const fuso = await fusoDaEmpresa(tenantId);
  const comOS = new Set(agendamentos.map((a) => a.conversationId).filter(Boolean));

  const atendimentos = (historico.conversas ?? [])
    .filter((c) => !comOS.has(c.id))
    .map((c) => {
      const quando = c.finalizadaEm ?? c.ultimaMensagemEm ?? c.iniciadaEm;
      return {
        id: c.id,
        tipo: 'atendimento',
        canal: c.canal,
        status: c.status,
        encerrado: c.status === 'finalizada',
        quando: quando?.getTime?.() ?? null,
        quandoFormatado: quando ? formatarBR(quando, fuso) : null,
        resumo: c.resumo ?? c.humorResumo ?? null,
        // Quando ninguem escreveu resumo, a previa da ultima mensagem ao menos
        // diz sobre o que era a conversa.
        previa: c.ultimaMensagemPreview || null,
        humor: c.humor ?? null,
        anotacoes: c.anotacoesHumanas || null,
        atendenteNome: c.atendenteNome ?? null,
        totalMensagensCliente: c.totalMensagensCliente ?? 0
      };
    });

  return { agendamentos, atendimentos };
}

/**
 * Horarios livres para um servico com um profissional, num dia.
 *
 * Esta e a funcao que a tela de agendar chama. Ela junta: jornada do
 * profissional, duracao real do servico (que pode ser diferente para aquele
 * profissional), folga de limpeza, agendamentos e bloqueios.
 */
export async function horariosLivres(tenantId, { data, professionalId, serviceId, antecedenciaMinutos = 0 }) {
  const fuso = await fusoDaEmpresa(tenantId);

  const [profissional, servico] = await Promise.all([
    repo.buscarProfissional(tenantId, professionalId),
    repo.buscarServico(tenantId, serviceId)
  ]);

  if (!profissional) throw new NaoEncontrado('Profissional');
  if (!servico) throw new NaoEncontrado('Servico');

  const vinculo = await repo.vinculoProfissionalServico(tenantId, professionalId, serviceId);
  if (!vinculo) {
    throw new RegraDeNegocio(`${profissional.nome} nao executa o servico "${servico.nome}".`);
  }

  const duracaoMinutos = vinculo.duracaoMinutos ?? servico.duracaoMinutos;

  const inicioJanela = inicioDoDia(data, fuso);
  const fimJanela = fimDoDia(data, fuso);

  const [ocupados, bloqueiosDoDia] = await Promise.all([
    repo.periodosOcupados(tenantId, professionalId, inicioJanela, fimJanela),
    repo.bloqueios(tenantId, professionalId, inicioJanela, fimJanela)
  ]);

  const livres = calcularHorariosLivres({
    data,
    fuso,
    jornada: profissional.jornada,
    duracaoMinutos,
    folgaMinutos: servico.intervaloAposMinutos,
    passoMinutos: profissional.jornada?.intervaloMinutos ?? 30,
    ocupados,
    bloqueios: bloqueiosDoDia,
    antecedenciaMinutos
  });

  return {
    data,
    fuso,
    duracaoMinutos,
    precoCentavos: vinculo.precoCentavos ?? servico.precoCentavos,
    horarios: livres.map((h) => ({ hora: h.hora, inicioEm: h.inicio, fimEm: h.fim }))
  };
}

/**
 * Carrega o que o planejador de sequencia precisa: para cada etapa, o servico
 * e os profissionais candidatos com jornada, preco/duracao proprios e a
 * agenda da JANELA inteira.
 *
 * A agenda de cada profissional e lida UMA vez para a janela toda, nao uma
 * vez por dia: procurar "o proximo dia com vaga" em 14 dias custaria 14 idas
 * ao banco por profissional. Profissional sem vinculo com o servico some da
 * lista de candidatos (nao e erro: so nao faz aquele servico).
 */
async function carregarEtapas(tenantId, etapas, janela) {
  const agendas = new Map();
  const agendaDo = (id) => {
    if (!agendas.has(id)) {
      agendas.set(
        id,
        (async () => {
          const prof = await repo.buscarProfissional(tenantId, id);
          if (!prof) return null;
          const [ocupados, bloqueios] = await Promise.all([
            repo.periodosOcupados(tenantId, id, janela.inicio, janela.fim),
            repo.bloqueios(tenantId, id, janela.inicio, janela.fim)
          ]);
          return { prof, ocupados, bloqueios };
        })()
      );
    }
    return agendas.get(id);
  };

  return Promise.all(
    etapas.map(async (etapa) => {
      const servico = await repo.buscarServico(tenantId, etapa.serviceId);
      if (!servico) throw new NaoEncontrado('Servico');

      const candidatos = await Promise.all(
        etapa.professionalIds.map(async (id) => {
          const [agendaProf, vinculo] = await Promise.all([
            agendaDo(id),
            repo.vinculoProfissionalServico(tenantId, id, etapa.serviceId)
          ]);
          if (!agendaProf || !vinculo) return null;
          return {
            id,
            nome: agendaProf.prof.nome,
            jornada: agendaProf.prof.jornada,
            duracaoMinutos: vinculo.duracaoMinutos ?? servico.duracaoMinutos,
            precoCentavos: vinculo.precoCentavos ?? servico.precoCentavos,
            ocupados: agendaProf.ocupados,
            bloqueios: agendaProf.bloqueios
          };
        })
      );

      return {
        servico: { id: servico.id, nome: servico.nome, folgaMinutos: servico.intervaloAposMinutos ?? 0 },
        candidatos: candidatos.filter(Boolean),
        fixo: Boolean(etapa.fixo)
      };
    })
  );
}

/**
 * Horarios para fazer VARIOS servicos na mesma visita, um apos o outro.
 *
 * Procura a partir de `dataInicial` por ate `dias` dias e para no primeiro
 * que tiver opcao — e o que responde "qual dia da para fazer os tres?".
 *
 * @param {string} tenantId
 * @param {object} p
 * @param {{ serviceId: string, professionalIds: string[], fixo?: boolean }[]} p.etapas
 *        na ordem em que serao feitos; `professionalIds` na ordem de preferencia
 * @param {string} p.dataInicial  AAAA-MM-DD
 * @param {number} [p.dias]       quantos dias procurar (1 = so a data pedida)
 * @param {string|null} [p.horaDesejada]
 * @returns {Promise<{ data: string|null, opcoes: object[], total: number }>}
 */
export async function vagasEmSequencia(
  tenantId,
  { etapas, dataInicial, dias = 1, horaDesejada = null, antecedenciaMinutos = 0, maxOpcoes = 8 }
) {
  const fuso = await fusoDaEmpresa(tenantId);
  const janela = { inicio: inicioDoDia(dataInicial, fuso), fim: fimDoDia(somarDias(dataInicial, dias - 1), fuso) };
  const montadas = await carregarEtapas(tenantId, etapas, janela);

  for (let d = 0; d < dias; d++) {
    const data = somarDias(dataInicial, d);
    const r = planejarSequencia({ data, fuso, etapas: montadas, antecedenciaMinutos, horaDesejada, maxOpcoes });
    if (r.opcoes.length) return { data, ...r };
  }
  return { data: null, opcoes: [], total: 0 };
}

/**
 * O cliente ja tem, nesse dia, um agendamento valido de cada servico pedido,
 * com o primeiro comecando na hora pedida? Devolve-os na ordem, ou null.
 */
async function sequenciaJaMarcada(tenantId, { leadId, data, hora, etapas }) {
  const doDia = (await listarDoCliente(tenantId, leadId, { apenasFuturos: true, limite: 100 }))
    .filter((a) => a.data === data)
    .sort((a, b) => a.inicioEm - b.inicioEm);

  const usados = new Set();
  const achados = [];
  for (const etapa of etapas) {
    const ag = doDia.find((a) => a.serviceId === etapa.serviceId && !usados.has(a.id));
    if (!ag) return null;
    usados.add(ag.id);
    achados.push(ag);
  }
  achados.sort((a, b) => a.inicioEm - b.inicioEm);
  return achados[0].horaInicio === hora ? achados : null;
}

/**
 * Marca VARIOS servicos em sequencia — todos ou nenhum.
 *
 * Marcar um por um deixava o cliente com parte do pedido: o primeiro entrava
 * e os outros eram recusados. Aqui o encaixe e refeito DENTRO da transacao
 * (a mesma protecao contra corrida de `criar`) e, se qualquer item nao couber
 * mais, nada e gravado.
 *
 * @param {object} dados
 * @param {string} dados.leadId
 * @param {string} dados.data   AAAA-MM-DD
 * @param {string} dados.hora   HH:MM de inicio do primeiro servico
 * @param {{ serviceId: string, professionalIds: string[], fixo?: boolean }[]} dados.etapas
 * @param {string} [dados.conversationId]
 * @param {string} [dados.observacoes]
 * @returns {Promise<{ agendamentos: object[], jaExistia?: boolean }>}
 */
export async function criarSequencia(tenantId, dados, { usuario, origem = 'humano' } = {}) {
  const fuso = await fusoDaEmpresa(tenantId);

  const lead = await repo.buscarLead(tenantId, dados.leadId);
  if (!lead) throw new NaoEncontrado('Contato');

  if (dados.conversationId) {
    const conversa = await repo.buscarConversa(tenantId, dados.conversationId);
    if (!conversa || conversa.leadId !== dados.leadId) {
      throw new RegraDeNegocio('A sessao de atendimento informada nao pertence a este cliente.');
    }
  }

  const planejar = async () => {
    const janela = { inicio: inicioDoDia(dados.data, fuso), fim: fimDoDia(dados.data, fuso) };
    const etapas = await carregarEtapas(tenantId, dados.etapas, janela);
    return planejarSequencia({ data: dados.data, fuso, etapas, horaDesejada: dados.hora, maxOpcoes: 1 }).opcoes[0] ?? null;
  };

  const plano = await planejar();

  if (!plano) {
    // Pedido repetido (a IA chamando de novo depois de ja ter marcado): o
    // horario "sumiu" porque e do PROPRIO cliente. Devolver o que ele ja tem
    // evita a resposta "nao cabe", que levaria a Sofia a desmentir a marcacao.
    const jaMarcados = await sequenciaJaMarcada(tenantId, dados);
    if (jaMarcados) return { agendamentos: jaMarcados, jaExistia: true };
    throw new Conflito(`Não há como fazer todos os serviços em sequência começando às ${dados.hora} neste dia.`);
  }

  const responsavel = await decidirResponsavel(tenantId, { usuario, conversationId: dados.conversationId });

  // Cada item passa a ter o profissional FIXO do plano: dentro da transacao
  // conferimos exatamente o que vai ser gravado, nao um plano novo.
  const etapasFixas = plano.itens.map((it) => ({ serviceId: it.servicoId, professionalIds: [it.profissionalId], fixo: true }));

  const ids = await emTransacao(async (tx) => {
    const janela = { inicio: inicioDoDia(dados.data, fuso), fim: fimDoDia(dados.data, fuso) };
    const etapas = await carregarEtapas(tenantId, etapasFixas, janela);
    // A ordem ja foi decidida no plano (inclusive se foi trocada): aqui so conferimos.
    const confirmado = planejarSequencia({ data: dados.data, fuso, etapas, horaDesejada: dados.hora, maxOpcoes: 1, permitirOutraOrdem: false }).opcoes[0];
    if (!confirmado) throw new Conflito('Um dos horários acabou de ser ocupado. Consulte de novo.');

    const criados = [];
    for (const it of confirmado.itens) {
      const { inicioEm, fimEm } = it;
      criados.push(
        await repo.criar(
          tenantId,
          {
            leadId: dados.leadId,
            serviceId: it.servicoId,
            professionalId: it.profissionalId,
            inicioEm: new Date(inicioEm),
            fimEm: new Date(fimEm),
            status: 'confirmado',
            precoCentavos: it.precoCentavos,
            descontoCentavos: 0,
            observacoes: dados.observacoes ?? '',
            checklist: [],
            conversationId: dados.conversationId ?? null,
            criadoPor: origem,
            criadoPorUserId: usuario?.id ?? null,
            responsavelUserId: responsavel.userId,
            confirmadoEm: new Date()
          },
          tx
        )
      );
    }
    return criados;
  });

  if (responsavel.atribuirConversa && dados.conversationId) {
    await conversasRepo.atualizar(tenantId, dados.conversationId, { assignedUserId: responsavel.userId });
  }

  const agendamentos = await Promise.all(ids.map((id) => obter(tenantId, id)));

  for (const ag of agendamentos) {
    await registrarAuditoria({
      tenantId,
      usuario,
      acao: 'agendamento.criar',
      entidade: 'agendamento',
      entidadeId: ag.id,
      dados: { depois: { lead: lead.nome, servico: ag.servicoNome, quando: formatarBR(ag.inicioEm, fuso), sequencia: ids.length } }
    });
  }

  log.info({ tenantId, ids, origem }, 'Agendamentos em sequencia criados');
  return { agendamentos };
}

/**
 * Quem e o RESPONSAVEL por um horario que esta sendo marcado.
 *
 * O responsavel e quem fala com o cliente ate o dia do servico. Tres casos:
 *
 *   1. A conversa ja tem dono (um atendente a assumiu ou a IA ja a atribuiu):
 *      o horario e dele. Marcar nao troca o dono de uma conversa.
 *   2. A conversa NAO tem dono e quem marca e um atendente: fica com ele.
 *   3. A conversa nao tem dono e quem marca e a IA (ou um gerente): a empresa
 *      decide pelo criterio de distribuicao (rodizio ou menos carregado). Assim
 *      um horario fechado pela Sofia nunca fica "sem dono" e visivel a todos —
 *      o que furaria a privacidade justamente no momento em que o cliente
 *      confirmou.
 *
 * A conversa continua com a IA (`status` nao muda): so ganha um dono. A Sofia
 * segue respondendo, e o atendente ve a conversa e o horario dele.
 *
 * Nao escreve nada: devolve a decisao. Quem grava e `criar`, depois de o
 * horario ter sido aceito.
 */
async function decidirResponsavel(tenantId, { usuario, conversationId }) {
  if (!conversationId) return { userId: usuario?.id ?? null, atribuirConversa: false };

  const conversa = await repo.buscarConversa(tenantId, conversationId);
  if (conversa?.assignedUserId) return { userId: conversa.assignedUserId, atribuirConversa: false };

  const ehAtendente = usuario?.id && usuario.cargo === 'atendente';
  const userId = ehAtendente
    ? usuario.id
    : ((await escolherAtendente(tenantId, { semPlantao: true }))?.id ?? usuario?.id ?? null);

  return { userId, atribuirConversa: Boolean(userId && conversa) };
}

/**
 * Cria um agendamento.
 *
 * SOBRE A CORRIDA DE MARCACAO:
 * entre a tela mostrar "14:00 livre" e a pessoa clicar em confirmar passam
 * segundos — tempo de sobra pra outro atendente marcar o mesmo horario.
 * Por isso a checagem de conflito e refeita AQUI, dentro da transacao, logo
 * antes de gravar. Confiar na lista que a tela viu e o que gera aquele
 * agendamento fantasma que ninguem consegue explicar.
 */
export async function criar(tenantId, dados, { usuario, origem = 'humano' } = {}) {
  const fuso = await fusoDaEmpresa(tenantId);

  const [lead, profissional, servico] = await Promise.all([
    repo.buscarLead(tenantId, dados.leadId),
    repo.buscarProfissional(tenantId, dados.professionalId),
    repo.buscarServico(tenantId, dados.serviceId)
  ]);

  if (!lead) throw new NaoEncontrado('Contato');
  if (!profissional) throw new NaoEncontrado('Profissional');
  if (!servico) throw new NaoEncontrado('Servico');

  // Vinculo com a sessao de atendimento: so aceita conversa da mesma empresa
  // e do mesmo cliente — senao uma OS poderia herdar o resumo de outra pessoa.
  if (dados.conversationId) {
    const conversa = await repo.buscarConversa(tenantId, dados.conversationId);
    if (!conversa || conversa.leadId !== dados.leadId) {
      throw new RegraDeNegocio('A sessao de atendimento informada nao pertence a este cliente.');
    }
  }

  const vinculo = await repo.vinculoProfissionalServico(tenantId, dados.professionalId, dados.serviceId);
  if (!vinculo) {
    throw new RegraDeNegocio(`${profissional.nome} nao executa o servico "${servico.nome}".`);
  }

  const duracaoMinutos = vinculo.duracaoMinutos ?? servico.duracaoMinutos;
  const precoCentavos = dados.precoCentavos ?? vinculo.precoCentavos ?? servico.precoCentavos;

  // O horario chega como data + hora LOCAL da empresa e vira instante UTC aqui.
  const inicioEm = instanteDeLocal(dados.data, dados.hora, fuso);
  const fimEm = somarMinutos(inicioEm, duracaoMinutos);

  if (inicioEm < Date.now() && !dados.permitirPassado) {
    throw new RegraDeNegocio('Nao e possivel agendar em um horario que ja passou.');
  }

  /**
   * Marcar o que o cliente JA tem marcado devolve o horario existente.
   *
   * Sem isto, o segundo pedido identico (a IA repetindo a chamada, um duplo
   * clique na tela) cai na checagem de conflito e recebe "horario ocupado" —
   * ocupado pelo PROPRIO cliente, o que confunde quem le e leva a IA a dizer
   * que o horario nao existe. O horario existe, e e dele.
   */
  const igual = await repo.buscarIgual(tenantId, { leadId: dados.leadId, professionalId: dados.professionalId, inicioEm });
  if (igual) return { ...(await obter(tenantId, igual.id)), jaExistia: true };

  const responsavel = await decidirResponsavel(tenantId, { usuario, conversationId: dados.conversationId });

  const id = await emTransacao(async (tx) => {
    const [ocupados, bloqueiosDoDia] = await Promise.all([
      repo.periodosOcupados(tenantId, dados.professionalId, inicioEm, fimEm),
      repo.bloqueios(tenantId, dados.professionalId, inicioEm, fimEm)
    ]);

    const veredito = podeAgendar({
      inicio: inicioEm,
      fim: fimEm,
      data: dados.data,
      fuso,
      jornada: profissional.jornada,
      folgaMinutos: servico.intervaloAposMinutos,
      ocupados,
      bloqueios: bloqueiosDoDia,
      permitirForaDoExpediente: dados.encaixe === true
    });

    if (!veredito.ok) throw new Conflito(veredito.motivo);

    return repo.criar(
      tenantId,
      {
        leadId: dados.leadId,
        serviceId: dados.serviceId,
        professionalId: dados.professionalId,
        inicioEm: new Date(inicioEm),
        fimEm: new Date(fimEm),
        status: dados.status ?? 'confirmado',
        precoCentavos,
        descontoCentavos: dados.descontoCentavos ?? 0,
        observacoes: dados.observacoes ?? '',
        checklist: dados.checklist ?? [],
        conversationId: dados.conversationId ?? null,
        criadoPor: origem,
        criadoPorUserId: usuario?.id ?? null,
        responsavelUserId: responsavel.userId,
        confirmadoEm: (dados.status ?? 'confirmado') === 'confirmado' ? new Date() : null
      },
      tx
    );
  });

  // O horario foi gravado: agora a conversa passa a ser do responsavel. Fica
  // para DEPOIS da transacao para que uma marcacao recusada (horario ocupado)
  // nao deixe a conversa atribuida a alguem sem horario nenhum.
  if (responsavel.atribuirConversa && dados.conversationId) {
    await conversasRepo.atualizar(tenantId, dados.conversationId, { assignedUserId: responsavel.userId });
  }

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'agendamento.criar',
    entidade: 'agendamento',
    entidadeId: id,
    dados: { depois: { lead: lead.nome, servico: servico.nome, quando: formatarBR(inicioEm, fuso) } }
  });

  log.info({ tenantId, agendamentoId: id, origem }, 'Agendamento criado');
  return obter(tenantId, id);
}

/**
 * Transicoes de status permitidas.
 *
 * Sem esta tabela, qualquer status vira qualquer outro: um atendimento
 * `concluido` voltaria para `pendente`, e o faturamento do mes mudaria
 * sozinho. Estados terminais (`concluido`, `cancelado`, `faltou`) nao saem
 * mais de onde estao.
 */
const TRANSICOES = {
  pendente: ['confirmado', 'cancelado', 'faltou'],
  confirmado: ['em_andamento', 'concluido', 'cancelado', 'faltou'],
  em_andamento: ['concluido', 'cancelado'],
  concluido: [],
  cancelado: [],
  faltou: []
};

export async function mudarStatus(tenantId, id, novoStatus, { usuario, motivo } = {}) {
  // Carrega conferindo a privacidade: um atendente nao altera a OS de outro.
  const linha = await carregarParaAcao(tenantId, id, usuario);

  const atual = linha.agendamento.status;
  if (atual === novoStatus) return obter(tenantId, id);

  const permitidos = TRANSICOES[atual] ?? [];
  if (!permitidos.includes(novoStatus)) {
    throw new RegraDeNegocio(
      `Um agendamento "${atual}" nao pode virar "${novoStatus}".` +
        (permitidos.length ? ` Transicoes possiveis: ${permitidos.join(', ')}.` : ' Este status e final.')
    );
  }

  const agora = new Date();
  const mudancas = { status: novoStatus };
  if (novoStatus === 'confirmado') mudancas.confirmadoEm = agora;
  if (novoStatus === 'concluido') mudancas.concluidoEm = agora;
  if (novoStatus === 'cancelado') {
    mudancas.canceladoEm = agora;
    mudancas.motivoCancelamento = motivo ?? null;
  }

  await repo.atualizar(tenantId, id, mudancas);

  // Encerrou (concluido, cancelado ou faltou): vai para o historico de analise.
  if (TRANSICOES[novoStatus]?.length === 0) await registrarDesfecho(tenantId, id);

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'agendamento.status',
    entidade: 'agendamento',
    entidadeId: id,
    dados: { antes: { status: atual }, depois: { status: novoStatus, motivo } }
  });

  return obter(tenantId, id);
}

/** Remarca: muda dia/hora/profissional, refazendo toda a checagem de conflito. */
export async function remarcar(tenantId, id, { data, hora, professionalId }, { usuario } = {}) {
  const fuso = await fusoDaEmpresa(tenantId);
  // Carrega conferindo a privacidade: um atendente nao altera a OS de outro.
  const linha = await carregarParaAcao(tenantId, id, usuario);

  const atual = linha.agendamento;
  if (['concluido', 'cancelado', 'faltou'].includes(atual.status)) {
    throw new RegraDeNegocio(`Um agendamento "${atual.status}" nao pode ser remarcado.`);
  }

  const novoProfissionalId = professionalId ?? atual.professionalId;
  const profissional = await repo.buscarProfissional(tenantId, novoProfissionalId);
  if (!profissional) throw new NaoEncontrado('Profissional');

  const servico = await repo.buscarServico(tenantId, atual.serviceId);
  const vinculo = await repo.vinculoProfissionalServico(tenantId, novoProfissionalId, atual.serviceId);
  if (!vinculo) {
    throw new RegraDeNegocio(`${profissional.nome} nao executa este servico.`);
  }

  const duracaoMinutos = vinculo.duracaoMinutos ?? servico.duracaoMinutos;
  const novaData = data ?? dataNoFuso(atual.inicioEm, fuso);
  const novaHora = hora ?? horaNoFuso(atual.inicioEm, fuso);

  const inicioEm = instanteDeLocal(novaData, novaHora, fuso);
  const fimEm = somarMinutos(inicioEm, duracaoMinutos);

  await emTransacao(async (tx) => {
    const [ocupados, bloqueiosDoDia] = await Promise.all([
      // `ignorarId` e essencial: sem ele, o proprio agendamento apareceria
      // como conflito consigo mesmo ao mudar so o profissional.
      repo.periodosOcupados(tenantId, novoProfissionalId, inicioEm, fimEm, { ignorarId: id }),
      repo.bloqueios(tenantId, novoProfissionalId, inicioEm, fimEm)
    ]);

    const veredito = podeAgendar({
      inicio: inicioEm,
      fim: fimEm,
      data: novaData,
      fuso,
      jornada: profissional.jornada,
      folgaMinutos: servico.intervaloAposMinutos,
      ocupados,
      bloqueios: bloqueiosDoDia
    });

    if (!veredito.ok) throw new Conflito(veredito.motivo);

    await repo.atualizar(
      tenantId,
      id,
      { inicioEm: new Date(inicioEm), fimEm: new Date(fimEm), professionalId: novoProfissionalId },
      tx
    );
  });

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'agendamento.remarcar',
    entidade: 'agendamento',
    entidadeId: id,
    dados: {
      antes: { quando: formatarBR(atual.inicioEm, fuso) },
      depois: { quando: formatarBR(inicioEm, fuso) }
    }
  });

  return obter(tenantId, id);
}

export async function atualizarDetalhes(tenantId, id, dados, { usuario } = {}) {
  // Carrega conferindo a privacidade: um atendente nao altera a OS de outro.
  const linha = await carregarParaAcao(tenantId, id, usuario);

  const mudancas = {};
  for (const campo of ['observacoes', 'checklist', 'descontoCentavos', 'precoCentavos']) {
    if (dados[campo] !== undefined) mudancas[campo] = dados[campo];
  }

  if (mudancas.descontoCentavos != null) {
    const preco = mudancas.precoCentavos ?? linha.agendamento.precoCentavos;
    if (mudancas.descontoCentavos > preco) {
      throw new RegraDeNegocio('O desconto nao pode ser maior que o valor do servico.');
    }
  }

  if (Object.keys(mudancas).length === 0) return apresentar(linha, await fusoDaEmpresa(tenantId));

  await repo.atualizar(tenantId, id, mudancas);

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'agendamento.atualizar',
    entidade: 'agendamento',
    entidadeId: id,
    dados: { depois: mudancas }
  });

  return obter(tenantId, id);
}

/**
 * Encerra o vinculo das OS com uma sessao de atendimento que acabou de ser
 * finalizada.
 *
 * Para cada OS ainda aberta ligada a conversa:
 *  - anexa o resumo da IA, as anotacoes do atendente e o humor do cliente;
 *  - se o horario ja comecou, ela vira `concluido` (e so entao entra no
 *    faturamento). OS futura continua como esta: concluir antes de acontecer
 *    inflaria o faturamento do dia.
 *
 * OS cancelada, faltou ou ja concluida so recebe o registro do atendimento.
 *
 * `concluirPassados: false` — quem finaliza e uma ROTINA (fechar o dia), nao
 * uma pessoa. Ela nao sabe se o cliente veio ou faltou: concluir sozinha poria
 * a falta no faturamento e na comissao. O registro do atendimento (resumo,
 * anotacoes, humor) continua sendo gravado; o status fica para alguem decidir
 * (a lista `pendentes` do fechamento).
 */
export async function encerrarPorConversa(tenantId, conversationId, dados = {}, { usuario, concluirPassados = true } = {}) {
  const { resumo, anotacoes, humor } = dados;
  const linhas = await repo.vinculadasAConversa(tenantId, conversationId);
  const agora = new Date();
  const texto = resumo?.trim() || null;
  const anotado = anotacoes?.trim() || null;
  let concluidas = 0;

  for (const a of linhas) {
    const mudancas = {};
    if (texto) {
      mudancas.resumoAtendimento = texto;
      mudancas.resumoEm = agora;
    }
    if (anotado) mudancas.anotacoesAtendimento = anotado;
    if (humor) mudancas.humorAtendimento = humor;

    const aberta = ['pendente', 'confirmado', 'em_andamento'].includes(a.status);
    if (concluirPassados && aberta && a.inicioEm.getTime() <= agora.getTime()) {
      mudancas.status = 'concluido';
      mudancas.concluidoEm = agora;
      concluidas += 1;
    }

    if (Object.keys(mudancas).length === 0) continue;
    await repo.atualizar(tenantId, a.id, mudancas);
    if (mudancas.status === 'concluido') await registrarDesfecho(tenantId, a.id);

    await registrarAuditoria({
      tenantId,
      usuario,
      acao: 'agendamento.sessao_finalizada',
      entidade: 'agendamento',
      entidadeId: a.id,
      dados: { antes: { status: a.status }, depois: { status: mudancas.status ?? a.status, comResumo: Boolean(texto) } }
    });
  }

  return { vinculadas: linhas.length, concluidas };
}

/**
 * Tira uma OS da agenda do dia a dia, sem apagar nada.
 *
 * So aceita OS encerrada. Arquivar um horario que ainda vai acontecer o
 * esconderia da agenda e da tela do profissional — o cliente apareceria e
 * ninguem estaria esperando por ele.
 */
export async function arquivar(tenantId, id, { usuario, desfazer = false } = {}) {
  // Carrega conferindo a privacidade: um atendente nao altera a OS de outro.
  const linha = await carregarParaAcao(tenantId, id, usuario);

  const a = linha.agendamento;

  if (!desfazer && !['concluido', 'cancelado', 'faltou'].includes(a.status)) {
    throw new RegraDeNegocio(
      `So da para arquivar um atendimento encerrado. Este esta "${a.status}": conclua, cancele ou marque falta antes.`
    );
  }

  await repo.atualizar(tenantId, id, { arquivadoEm: desfazer ? null : new Date() });

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: desfazer ? 'agendamento.desarquivar' : 'agendamento.arquivar',
    entidade: 'agendamento',
    entidadeId: id,
    dados: { antes: { status: a.status } }
  });

  return obter(tenantId, id);
}

export async function excluir(tenantId, id, { usuario } = {}) {
  // Carrega conferindo a privacidade: um atendente nao altera a OS de outro.
  const linha = await carregarParaAcao(tenantId, id, usuario);

  await repo.excluir(tenantId, id);

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'agendamento.excluir',
    entidade: 'agendamento',
    entidadeId: id,
    dados: { antes: { status: linha.agendamento.status } }
  });

  return { ok: true };
}

export async function metricas(tenantId, { data, dataFim } = {}, usuario) {
  const fuso = await fusoDaEmpresa(tenantId);
  const inicial = data || dataNoFuso(Date.now(), fuso);
  const final = dataFim || inicial;

  // O faturamento do painel segue o recorte: atendente ve o proprio.
  const numeros = await repo.metricas(
    tenantId,
    inicioDoDia(inicial, fuso),
    fimDoDia(final, fuso),
    await escopoDe(tenantId, usuario)
  );

  return {
    periodo: { de: inicial, ate: final },
    ...numeros,
    faturamentoFormatado: formatarBRL(numeros.faturamentoCentavos)
  };
}

/** Tira da agenda do dia a dia o que ja passou e esta encerrado. */
export async function arquivarEncerrados(tenantId, { diasAtras = 1 } = {}) {
  const fuso = await fusoDaEmpresa(tenantId);
  const corte = inicioDoDia(somarDias(dataNoFuso(Date.now(), fuso), -Math.abs(diasAtras) + 1), fuso);
  const arquivados = await repo.arquivarEncerrados(tenantId, corte);
  return { arquivados };
}
