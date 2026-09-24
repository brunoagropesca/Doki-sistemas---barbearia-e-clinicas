import { z } from 'zod';
import { definirFerramenta } from './registry.js';
import { dataNoFuso, somarDias } from '../../core/datetime.js';
import { interpretarData, rotuloDaData } from '../../core/datas-naturais.js';
import { formatarBRL } from '../../core/money.js';
import { RegraDeNegocio } from '../../core/errors.js';
import { GRUPOS_ATENA } from '../agentes-padrao.js';
import * as catalogo from '../../modules/catalogo/catalogo.service.js';
import * as agenda from '../../modules/agenda/agenda.service.js';
import * as leads from '../../modules/leads/leads.service.js';
import * as conversas from '../../modules/conversas/conversas.service.js';
import { emitir, EVENTOS } from '../../core/eventos.js';
import { catalogoDaEmpresa, resolverProfissional, resolverServico } from './catalogo-cache.js';
import { ETAPAS_ATENDIMENTO } from '../../db/schema/conversations.js';

/**
 * Ferramentas da Atena.
 *
 * A Atena e uma agente de IA: quem decide QUAL ferramenta usar e COM QUAIS
 * parametros e o modelo. Mas a execucao continua deterministica — e feita
 * pelos mesmos servicos que a tela usa. A regra "nao marcar por cima de outro
 * cliente" vive em `agenda.criar`; a Atena nao tem um caminho paralelo para o
 * banco, entao nao tem como contorna-la.
 *
 * TRES TRAVAS ESPECIFICAS, porque uma IA que escreve no banco precisa delas:
 *
 * 1. ESCOPO. Toda operacao de escrita so alcanca agendamentos do CLIENTE DA
 *    CONVERSA. Mesmo que o modelo alucine (ou seja induzido por um cliente
 *    malicioso a tentar) o id de outro cliente, a ferramenta recusa.
 *
 * 2. O QUE NAO SE APAGA. Agendamento concluido, em andamento ou com falta
 *    nao pode ser excluido pela IA: ele ja e faturamento ou historico, e
 *    sumir com ele muda o relatorio do mes. Isso fica para uma pessoa.
 *
 * 3. TETO DE ESCRITAS por pedido. Um modelo em laco poderia cancelar a agenda
 *    inteira do cliente. Depois do teto, as escritas sao recusadas.
 *
 * Toda acao entra na auditoria como "Atena (IA)".
 */

export const USUARIO_ATENA = { nome: 'Atena (IA)' };

/** Quantas alteracoes a Atena pode fazer num unico pedido. */
export const LIMITE_ESCRITAS = 5;

/** Estados que a IA pode excluir. O resto exige um humano. */
const EXCLUIVEIS = ['pendente', 'confirmado', 'cancelado'];

const horaSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM, por exemplo 14:30.');

/** Busca sem acento nem caixa: "degrade" acha "Degradê". */
function normalizarBusca(texto) {
  return String(texto ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/** Quantos dias a frente procurar quando a data pedida nao tem vaga (ou nao foi dita). */
const DIAS_DE_BUSCA = 14;

/** Quantos servicos cabem numa visita. Mais que isso e pedido para uma pessoa montar. */
const MAX_SERVICOS_VISITA = 5;

export function ferramentasDaAtena({ tenantId, fuso, leadId, conversationId = null, permitirEscrita = true, grupos }) {
  const hoje = () => dataNoFuso(Date.now(), fuso);

  /**
   * Data como o cliente falou ("sexta", "dia 25", "amanha") -> AAAA-MM-DD.
   * Devolve `{ data, dia, aviso? }` ou `{ erro }`. Ver `core/datas-naturais.js`.
   */
  const interpretar = (valor) => interpretarData(valor, { hoje: hoje() });

  /** Campos de data que toda resposta leva: a data e o dia por extenso para a Sofia repassar. */
  const sobreAData = (quando) => ({ data: quando.data, dia: quando.dia, ...(quando.aviso ? { aviso: quando.aviso } : {}) });

  /** Carrega um agendamento e garante que e do cliente desta conversa. */
  async function agendamentoDoCliente(agendamentoId) {
    if (!leadId) throw new RegraDeNegocio('Cliente ainda nao identificado nesta conversa.');

    const ag = await agenda.obter(tenantId, agendamentoId);

    // Trava de escopo. A mensagem e generica de proposito: nao confirma que
    // o id existe e pertence a outra pessoa.
    if (ag.leadId !== leadId) {
      throw new RegraDeNegocio('Nao encontrei esse agendamento entre os deste cliente.');
    }
    return ag;
  }

  /** Conta e limita as escritas do pedido atual. */
  function registrarEscrita(contexto) {
    contexto.escritas = (contexto.escritas ?? 0) + 1;
    if (contexto.escritas > LIMITE_ESCRITAS) {
      throw new RegraDeNegocio(
        `Limite de ${LIMITE_ESCRITAS} alteracoes por pedido atingido. Peca a um atendente para continuar.`
      );
    }
  }

  const resumoAgendamento = (a) => ({
    id: a.id,
    quando: a.quandoFormatado,
    data: a.data,
    hora: a.horaInicio,
    servico: a.servicoNome,
    profissional: a.profissionalNome,
    status: a.status,
    valor: a.totalFormatado,
    observacoes: a.observacoes || undefined
  });

  // ==========================================================================
  // CATALOGO
  // ==========================================================================

  const listarServicos = definirFerramenta({
    nome: 'listar_servicos',
    descricao:
      'Serviços com preço, duração e quem faz cada um. Não precisa chamar antes de consultar ' +
      'horários ou agendar: as outras ferramentas aceitam nomes.',
    argumentos: z.object({
      busca: z.string().optional().describe('Filtra pelo nome do serviço, quando o pedido citar um específico.')
    }),
    async executar({ busca }) {
      const todos = await catalogoDaEmpresa(tenantId);
      const alvo = busca ? normalizarBusca(busca) : null;
      const lista = alvo ? todos.filter((s) => normalizarBusca(s.nome).includes(alvo)) : todos;
      if (lista.length === 0) return { servicos: [], aviso: 'Nenhum serviço encontrado com esse nome.' };

      // Sem ids e sem chaves repetidas: o modelo trabalha com nomes, e cada
      // caractere daqui e reenviado a CADA volta da conversa com ele.
      return {
        servicos: lista.map((s) => ({
          nome: s.nome,
          preco: s.precoFormatado,
          min: s.duracaoMinutos,
          // Valor proprio de um profissional aparece so quando difere do padrao.
          quem: s.profissionais.map((p) =>
            p.precoProprio || p.duracaoPropria
              ? `${p.nome} (${p.precoFormatado}, ${p.duracaoMinutos} min)`
              : p.nome
          )
        }))
      };
    }
  });

  const listarProfissionais = definirFerramenta({
    nome: 'listar_profissionais',
    descricao:
      'Lista os profissionais e quais serviços cada um executa. Use quando o pedido citar um ' +
      'profissional pelo nome ou perguntar quem atende.',
    argumentos: z.object({}),
    async executar() {
      const servicos = await catalogoDaEmpresa(tenantId);
      const porProfissional = new Map();

      for (const s of servicos) {
        for (const p of s.profissionais) {
          if (!porProfissional.has(p.id)) porProfissional.set(p.id, { nome: p.nome, faz: [] });
          porProfissional.get(p.id).faz.push(s.nome);
        }
      }
      return { profissionais: [...porProfissional.values()] };
    }
  });

  // ==========================================================================
  // HORARIOS
  // ==========================================================================

  const consultarHorarios = definirFerramenta({
    nome: 'consultar_horarios',
    descricao:
      'Horários REALMENTE livres de um serviço numa data. Use antes de afirmar que um horário ' +
      'está livre. Aceita nomes ("Corte Social", "Carlos"). Sem profissional: todos que fazem o serviço.',
    argumentos: z.object({
      servicoId: z.string().describe('Nome (ou id) do serviço.'),
      profissionalId: z.string().optional().describe('Nome (ou id) do profissional. Omitir = todos.'),
      data: z.string().optional().describe('Como o cliente disse: "sexta", "dia 25", "amanhã", "25/09". Padrão: hoje.')
    }),
    async executar({ servicoId, profissionalId, data }) {
      const quando = interpretar(data);
      if (quando.erro) return { erro: quando.erro };
      const dataAlvo = quando.data;

      const servico = await resolverServico(tenantId, servicoId);
      const profissionais = profissionalId
        ? [resolverProfissional(servico, profissionalId)]
        : servico.profissionais.slice(0, 6);

      if (profissionais.length === 0) {
        return { erro: `Ninguém faz ${servico.nome} no momento.` };
      }

      const porProfissional = await Promise.all(
        profissionais.map(async (p) => {
          const r = await agenda.horariosLivres(tenantId, {
            data: dataAlvo,
            professionalId: p.id,
            serviceId: servico.id,
            antecedenciaMinutos: 30
          });
          return {
            profissional: p.nome,
            preco: formatarBRL(r.precoCentavos),
            min: r.duracaoMinutos,
            // Limitado para nao inundar o contexto do modelo com 40 horarios.
            horariosLivres: r.horarios.slice(0, 14).map((h) => h.hora)
          };
        })
      );

      const comVaga = porProfissional.filter((p) => p.horariosLivres.length > 0);
      if (comVaga.length === 0) {
        /**
         * Dia sem vaga: ja procuramos o proximo dia que tem, na mesma chamada.
         *
         * Sem isto a resposta era "tente outra data" — e a Atena (ou a Sofia,
         * perguntando de novo ao cliente) tentava dia por dia, uma volta de
         * modelo inteira para cada um.
         */
        const proxima = await agenda.vagasEmSequencia(tenantId, {
          etapas: [{ serviceId: servico.id, professionalIds: profissionais.map((p) => p.id) }],
          dataInicial: somarDias(dataAlvo, 1),
          dias: DIAS_DE_BUSCA,
          antecedenciaMinutos: 30
        });
        return {
          ...sobreAData(quando),
          servico: servico.nome,
          horariosLivres: [],
          aviso: [quando.aviso, 'Sem horário livre nesta data.'].filter(Boolean).join(' '),
          proximaDataComVaga: proxima.data
            ? {
                data: proxima.data,
                dia: rotuloDaData(proxima.data, hoje()),
                horarios: proxima.opcoes.map((o) => `${o.hora} ${o.itens[0].profissional}`)
              }
            : `Nenhuma vaga nos próximos ${DIAS_DE_BUSCA} dias.`
        };
      }

      // Um profissional so: formato simples, o mesmo de sempre.
      if (comVaga.length === 1 && profissionais.length === 1) {
        const [p] = comVaga;
        return {
          ...sobreAData(quando),
          servico: servico.nome,
          profissional: p.profissional,
          preco: p.preco,
          min: p.min,
          horariosLivres: p.horariosLivres
        };
      }

      return { ...sobreAData(quando), servico: servico.nome, porProfissional: comVaga };
    }
  });

  /*
   * Sem ferramenta "interpretar_data" separada, de proposito: toda ferramenta
   * que recebe data ja passa pelo script (`interpretar`) e devolve o dia por
   * extenso. Uma ferramenta a mais custaria ~100 tokens em TODA chamada da
   * Atena para repetir o que as outras ja fazem.
   */

  // ==========================================================================
  // VARIOS SERVICOS NA MESMA VISITA
  // ==========================================================================

  /**
   * Monta as etapas (servico + profissionais possiveis) de uma visita.
   *
   * Com profissional pedido: nos servicos que ele faz, SO ele (o cliente
   * escolheu); nos que ele nao faz, qualquer um que faca.
   */
  async function etapasDaVisita(servicos, profissional) {
    if (servicos.length < 2) return { erro: 'Para um serviço só, use consultar_horarios / criar_agendamento.' };
    if (servicos.length > MAX_SERVICOS_VISITA) {
      return { erro: `No máximo ${MAX_SERVICOS_VISITA} serviços por visita. Ofereça um atendente para montar o restante.` };
    }

    const resolvidos = await Promise.all(servicos.map((s) => resolverServico(tenantId, s)));
    const alvo = profissional ? normalizarBusca(profissional) : null;
    let profissionalAtende = false;

    const etapas = resolvidos.map((servico) => {
      const todos = servico.profissionais ?? [];
      const escolhido = alvo ? todos.filter((p) => normalizarBusca(p.nome).includes(alvo)) : [];
      if (escolhido.length === 1) profissionalAtende = true;
      return {
        serviceId: servico.id,
        professionalIds: (escolhido.length === 1 ? escolhido : todos).map((p) => p.id),
        fixo: escolhido.length === 1
      };
    });

    if (alvo && !profissionalAtende) {
      return { erro: `Ninguém chamado "${profissional}" faz estes serviços. Ofereça outro profissional.` };
    }
    const semNinguem = resolvidos.find((s) => !(s.profissionais ?? []).length);
    if (semNinguem) return { erro: `Ninguém faz ${semNinguem.nome} no momento.` };

    return { etapas, nomes: resolvidos.map((s) => s.nome) };
  }

  /** Uma opcao de visita em uma linha: barato para o modelo ler, facil de repassar. */
  const linhaDaOpcao = (o) => ({
    inicio: o.hora,
    termina: o.termina,
    total: formatarBRL(o.totalCentavos),
    ordem: o.itens.map((it) => `${it.hora} ${it.servico} com ${it.profissional} (${formatarBRL(it.precoCentavos)})`).join('; '),
    // A Sofia precisa contar ao cliente: "comecando pela limpeza" / "com 10 min de intervalo".
    ...(o.ordemTrocada ? { obs: 'ordem diferente da pedida: avise o cliente' } : {}),
    ...(o.esperaMinutos ? { esperaEntreServicos: `${o.esperaMinutos} min` } : {})
  });

  const minutosDe = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

  const consultarVariosServicos = definirFerramenta({
    nome: 'consultar_varios_servicos',
    descricao: 'Horários para 2+ serviços na mesma visita, em sequência. Sem vaga na data (ou sem data), acha o próximo dia.',
    argumentos: z.object({
      servicos: z.array(z.string()).describe('Na ordem em que serão feitos.'),
      profissional: z.string().optional().describe('Se o cliente pediu.'),
      data: z.string().optional().describe('Como o cliente disse.'),
      hora: horaSchema.optional().describe('HH:MM, se o cliente pediu.')
    }),
    async executar({ servicos, profissional, data, hora }) {
      const quando = data ? interpretar(data) : null;
      if (quando?.erro) return { erro: quando.erro };

      const visita = await etapasDaVisita(servicos, profissional);
      if (visita.erro) return visita;

      const inicio = quando?.data ?? hoje();
      const naData = await agenda.vagasEmSequencia(tenantId, {
        etapas: visita.etapas,
        dataInicial: inicio,
        // Data pedida: primeiro so ela; sem data, ja varre os proximos dias.
        dias: quando ? 1 : DIAS_DE_BUSCA,
        horaDesejada: hora ?? null,
        antecedenciaMinutos: 30
      });

      if (naData.data) {
        return {
          ...sobreAData(quando && naData.data === quando.data ? quando : interpretar(naData.data)),
          servicos: visita.nomes,
          opcoes: naData.opcoes.map(linhaDaOpcao)
        };
      }

      /**
       * A HORA pedida nao deu, mas o dia pode ter outras: devolvemos as mais
       * PERTO dela. No teste real ("marca meio-dia e os outros em seguida") a
       * resposta era so "nao da" — e a Sofia inventou um "11:00" que tambem
       * nao existia. Com as vizinhas reais na mao, ela nao precisa inventar.
       */
      if (hora && quando) {
        const doDia = await agenda.vagasEmSequencia(tenantId, {
          etapas: visita.etapas,
          dataInicial: quando.data,
          dias: 1,
          antecedenciaMinutos: 30,
          maxOpcoes: 200
        });
        if (doDia.opcoes.length) {
          const alvo = minutosDe(hora);
          const vizinhas = [...doDia.opcoes]
            .sort((a, b) => Math.abs(minutosDe(a.hora) - alvo) - Math.abs(minutosDe(b.hora) - alvo))
            .slice(0, 3)
            .sort((a, b) => a.inicio - b.inicio);
          return {
            ...sobreAData(quando),
            servicos: visita.nomes,
            aviso: `Não dá para começar todos às ${hora}. Ofereça SÓ estas, as mais próximas dessa hora.`,
            opcoes: vizinhas.map(linhaDaOpcao)
          };
        }
      }

      // A data pedida nao deu: procura o proximo dia, sem restringir a hora.
      const proxima = await agenda.vagasEmSequencia(tenantId, {
        etapas: visita.etapas,
        dataInicial: quando ? somarDias(inicio, 1) : inicio,
        dias: DIAS_DE_BUSCA,
        antecedenciaMinutos: 30
      });

      return {
        ...(quando ? sobreAData(quando) : {}),
        servicos: visita.nomes,
        opcoes: [],
        aviso: [
          hora
            ? `Não dá para começar todos às ${hora}${quando ? ' nesta data' : ''}.`
            : quando
              ? 'Sem vaga para todos nesta data.'
              : `Sem vaga para todos nos próximos ${DIAS_DE_BUSCA} dias.`,
          'Não ofereça horário para todos juntos que não esteja nas opções.'
        ].join(' '),
        ...(proxima.data
          ? {
              proximaDataComVaga: {
                data: proxima.data,
                dia: rotuloDaData(proxima.data, hoje()),
                opcoes: proxima.opcoes.map(linhaDaOpcao)
              }
            }
          : {})
      };
    }
  });

  const agendarVariosServicos = definirFerramenta({
    nome: 'agendar_varios_servicos',
    descricao: 'Marca 2+ serviços em sequência a partir do início consultado. Todos ou nenhum.',
    escrita: true,
    argumentos: z.object({
      servicos: z.array(z.string()).describe('Os mesmos da consulta, mesma ordem.'),
      data: z.string(),
      hora: horaSchema.describe('HH:MM de início da consulta.'),
      profissional: z.string().optional(),
      observacoes: z.string().optional()
    }),
    async executar({ servicos, data, hora, profissional, observacoes }, contexto) {
      if (!leadId) throw new RegraDeNegocio('Cliente ainda não identificado; não é possível agendar.');
      const quando = interpretar(data);
      if (quando.erro) return { erro: quando.erro };

      const visita = await etapasDaVisita(servicos, profissional);
      if (visita.erro) return visita;

      // Uma escrita so: e uma operacao atomica, tudo ou nada.
      registrarEscrita(contexto);

      const r = await agenda.criarSequencia(
        tenantId,
        {
          leadId,
          data: quando.data,
          hora,
          etapas: visita.etapas,
          observacoes: observacoes ?? '',
          conversationId: conversationId ?? undefined
        },
        { origem: 'ia', usuario: USUARIO_ATENA }
      );

      return {
        sucesso: true,
        ...(r.jaExistia ? { jaExistia: true, aviso: 'Estes horários já estavam marcados para o cliente.' } : {}),
        dia: quando.dia,
        agendamentos: r.agendamentos.map(resumoAgendamento),
        total: formatarBRL(r.agendamentos.reduce((soma, a) => soma + a.totalCentavos, 0))
      };
    }
  });

  // ==========================================================================
  // HISTORICO DO CLIENTE
  // ==========================================================================

  const dadosDoCliente = definirFerramenta({
    nome: 'consultar_dados_do_cliente',
    descricao:
      'Mostra os dados do cliente desta conversa: nome, telefone, anotações, etiquetas, quantas ' +
      'vezes já veio e quanto já gastou.',
    argumentos: z.object({}),
    async executar() {
      if (!leadId) return { erro: 'Cliente ainda não identificado.' };

      const c = await leads.obter(tenantId, leadId);
      return {
        nome: c.nome,
        telefone: c.telefoneFormatado,
        anotacoes: c.observacoes || 'Nenhuma',
        etiquetas: c.tags,
        visitasConcluidas: c.historico.agendamentos.filter((a) => a.status === 'concluido').length,
        faltas: c.historico.agendamentos.filter((a) => a.status === 'faltou').length
      };
    }
  });

  const agendamentosDoCliente = definirFerramenta({
    nome: 'consultar_agendamentos_do_cliente',
    descricao:
      'Agendamentos (OS) deste cliente, com o id de cada um. Necessário antes de remarcar, ' +
      'cancelar ou excluir.',
    argumentos: z.object({
      apenasFuturos: z
        .boolean()
        .optional()
        .describe('true = só o que ainda vai acontecer. false/omitido = histórico completo.')
    }),
    async executar({ apenasFuturos }) {
      if (!leadId) return { agendamentos: [], aviso: 'Cliente ainda não identificado.' };

      const lista = await agenda.listarDoCliente(tenantId, leadId, { apenasFuturos: apenasFuturos === true });
      if (lista.length === 0) {
        return { agendamentos: [], aviso: apenasFuturos ? 'Nenhum agendamento futuro.' : 'Nenhum agendamento.' };
      }
      return { agendamentos: lista.map(resumoAgendamento) };
    }
  });

  // ==========================================================================
  // ESCRITA
  // ==========================================================================

  const criarAgendamento = definirFerramenta({
    nome: 'criar_agendamento',
    descricao:
      'Marca UM serviço para o cliente, com serviço, profissional, data e hora que consultar_horarios ' +
      'mostrou livres. Faltou dado: NÃO adivinhe, peça.',
    escrita: true,
    argumentos: z.object({
      servicoId: z.string().describe('Nome (ou id) do serviço.'),
      profissionalId: z.string().describe('Nome (ou id) do profissional.'),
      data: z.string().describe('Como o cliente disse ("sexta", "dia 25") ou AAAA-MM-DD.'),
      hora: horaSchema.describe('HH:MM, exatamente como veio de consultar_horarios.'),
      observacoes: z.string().optional().describe('Pedido especial do cliente.')
    }),
    async executar({ servicoId, profissionalId, data, hora, observacoes }, contexto) {
      if (!leadId) throw new RegraDeNegocio('Cliente ainda não identificado; não é possível agendar.');
      const quando = interpretar(data);
      if (quando.erro) return { erro: quando.erro };
      const dataAlvo = quando.data;

      // Nome ou id: ambiguo ou inexistente vira uma pergunta para o cliente,
      // nunca um agendamento no servico errado.
      const servico = await resolverServico(tenantId, servicoId);
      const profissional = resolverProfissional(servico, profissionalId);

      registrarEscrita(contexto);

      // `criar` refaz a checagem de conflito dentro da transacao: mesmo que a
      // Atena insista num horario ocupado, o banco recusa.
      const ag = await agenda.criar(
        tenantId,
        {
          leadId,
          serviceId: servico.id,
          professionalId: profissional.id,
          data: dataAlvo,
          hora,
          observacoes: observacoes ?? '',
          status: 'confirmado',
          // A OS fica presa a esta sessao ate ela ser finalizada.
          conversationId: conversationId ?? undefined
        },
        { origem: 'ia', usuario: USUARIO_ATENA }
      );

      return {
        sucesso: true,
        ...(ag.jaExistia ? { jaExistia: true, aviso: 'Este horario ja estava marcado para o cliente.' } : {}),
        dia: quando.dia,
        agendamento: resumoAgendamento(ag)
      };
    }
  });

  const remarcarAgendamento = definirFerramenta({
    nome: 'remarcar_agendamento',
    descricao:
      'Remarca um agendamento do cliente para outro dia, hora ou profissional. Refaz toda a ' +
      'verificação de conflito. Informe apenas o que muda. Obtenha o id em consultar_agendamentos_do_cliente.',
    escrita: true,
    argumentos: z.object({
      agendamentoId: z.string().describe('Id do agendamento.'),
      data: z.string().optional().describe('Nova data, como o cliente disse ("sexta", "dia 25").'),
      hora: horaSchema.optional().describe('Nova hora HH:MM.'),
      profissionalId: z.string().optional().describe('Novo profissional, se mudar.')
    }),
    async executar({ agendamentoId, data, hora, profissionalId }, contexto) {
      await agendamentoDoCliente(agendamentoId);

      if (!data && !hora && !profissionalId) {
        return { erro: 'Informe o que mudar: data, hora ou profissional.' };
      }

      let novaData;
      if (data) {
        const quando = interpretar(data);
        if (quando.erro) return { erro: quando.erro };
        novaData = quando.data;
      }

      registrarEscrita(contexto);

      const ag = await agenda.remarcar(
        tenantId,
        agendamentoId,
        // O servico chama de `professionalId`; o modelo ve `profissionalId`.
        { data: novaData, hora, professionalId: profissionalId },
        { usuario: USUARIO_ATENA }
      );
      return { sucesso: true, agendamento: resumoAgendamento(ag) };
    }
  });

  const atualizarAgendamento = definirFerramenta({
    nome: 'atualizar_agendamento',
    descricao:
      'Atualiza a observação da OS de um agendamento do cliente (pedido especial, alergia, ' +
      'preferência). NÃO altera preço nem desconto: isso é decisão de uma pessoa.',
    escrita: true,
    argumentos: z.object({
      agendamentoId: z.string().describe('Id do agendamento.'),
      observacoes: z.string().describe('Texto completo da observação (substitui a anterior).')
    }),
    async executar({ agendamentoId, observacoes }, contexto) {
      await agendamentoDoCliente(agendamentoId);
      registrarEscrita(contexto);

      // De proposito so repassamos `observacoes`. Preco e desconto existem no
      // servico, mas a IA nao tem como toca-los: conceder desconto por
      // conversa de WhatsApp e o tipo de coisa que um cliente insistente
      // arrancaria de um modelo prestativo.
      const ag = await agenda.atualizarDetalhes(tenantId, agendamentoId, { observacoes }, { usuario: USUARIO_ATENA });
      return { sucesso: true, agendamento: resumoAgendamento(ag) };
    }
  });

  const cancelarAgendamento = definirFerramenta({
    nome: 'cancelar_agendamento',
    descricao:
      'Cancela um agendamento do cliente, mantendo o registro no histórico. É a forma normal de ' +
      'desmarcar. Use apenas quando o pedido for claro e o agendamento estiver identificado.',
    escrita: true,
    argumentos: z.object({
      agendamentoId: z.string().describe('Id obtido em consultar_agendamentos_do_cliente.'),
      motivo: z.string().optional().describe('Motivo informado pelo cliente.')
    }),
    async executar({ agendamentoId, motivo }, contexto) {
      await agendamentoDoCliente(agendamentoId);
      registrarEscrita(contexto);

      const ag = await agenda.mudarStatus(tenantId, agendamentoId, 'cancelado', {
        usuario: USUARIO_ATENA,
        motivo: motivo ?? 'Cancelado a pedido do cliente via atendimento'
      });
      return { sucesso: true, agendamento: resumoAgendamento(ag) };
    }
  });

  const excluirAgendamento = definirFerramenta({
    nome: 'excluir_agendamento',
    descricao:
      'Remove um agendamento da agenda (vai para a lixeira, não some do banco). Prefira ' +
      'cancelar_agendamento; use excluir só quando o agendamento foi criado por engano ou o ' +
      'pedido for explicitamente para removê-lo. Não funciona em agendamentos concluídos, em ' +
      'andamento ou com falta: esses ficam com uma pessoa.',
    escrita: true,
    argumentos: z.object({
      agendamentoId: z.string().describe('Id obtido em consultar_agendamentos_do_cliente.')
    }),
    async executar({ agendamentoId }, contexto) {
      const ag = await agendamentoDoCliente(agendamentoId);

      if (!EXCLUIVEIS.includes(ag.status)) {
        throw new RegraDeNegocio(
          `Um agendamento "${ag.status}" não pode ser excluído por aqui, pois já faz parte do histórico ` +
            'e do faturamento. Peça a um atendente.'
        );
      }

      registrarEscrita(contexto);
      await agenda.excluir(tenantId, agendamentoId, { usuario: USUARIO_ATENA });
      return { sucesso: true, mensagem: 'Agendamento excluído da agenda.', id: agendamentoId };
    }
  });

  /**
   * O funil de atendimento, na mao da Atena.
   *
   * Ela e quem sabe em que pe a negociacao esta: acabou de consultar preco,
   * ofereceu horarios, o cliente ficou de responder. Essas etapas so existem
   * ate a OS ser confirmada — dai em diante o cartao anda sozinho, pelo
   * status do agendamento, e nao ha o que mover.
   *
   * Vale reparar no que esta ferramenta NAO faz: ela nao confirma, nao conclui
   * e nao cancela. Isso seria mexer em agenda e faturamento por um caminho
   * paralelo, sem passar pelas travas de `mudarStatus`. Para esses estados
   * existem `criar_agendamento` e `cancelar_agendamento`.
   */
  const moverEtapa = definirFerramenta({
    nome: 'mover_etapa_atendimento',
    descricao:
      'Quadro interno da equipe (não marca nem cancela nada): "entendendo" = já sabe o que o cliente ' +
      'quer; "orcamento" = informou preços ou horários; "aguardando" = falta só o cliente confirmar.',
    escrita: true,
    argumentos: z.object({
      etapa: z
        .enum(ETAPAS_ATENDIMENTO)
        .describe('novo | entendendo | orcamento | aguardando'),
      motivo: z.string().optional().describe('Em uma frase, o que mudou na conversa.')
    }),
    async executar({ etapa, motivo }, contexto) {
      if (!conversationId) {
        return { erro: 'Este atendimento não tem uma conversa associada; não há quadro para mover.' };
      }

      registrarEscrita(contexto);

      await conversas.moverEtapa(tenantId, conversationId, etapa, {
        usuario: USUARIO_ATENA,
        origem: 'ia'
      });

      return { sucesso: true, etapa, motivo: motivo ?? null };
    }
  });

  // ==========================================================================
  // MONTAGEM CONFORME AS PERMISSOES DA EMPRESA
  // ==========================================================================

  const porNome = {
    mover_etapa_atendimento: moverEtapa,
    listar_servicos: listarServicos,
    listar_profissionais: listarProfissionais,
    consultar_horarios: consultarHorarios,
    consultar_varios_servicos: consultarVariosServicos,
    consultar_dados_do_cliente: dadosDoCliente,
    consultar_agendamentos_do_cliente: agendamentosDoCliente,
    criar_agendamento: criarAgendamento,
    agendar_varios_servicos: agendarVariosServicos,
    remarcar_agendamento: remarcarAgendamento,
    atualizar_agendamento: atualizarAgendamento,
    cancelar_agendamento: cancelarAgendamento,
    excluir_agendamento: excluirAgendamento
  };

  const habilitadas = new Set();
  for (const chave of grupos) {
    for (const nome of GRUPOS_ATENA[chave]?.ferramentas ?? []) habilitadas.add(nome);
  }

  return Object.entries(porNome)
    .filter(([nome, f]) => habilitadas.has(nome) && (permitirEscrita || !f.escrita))
    .map(([, f]) => comAviso(f));

  /**
   * Faz cada ferramenta ANUNCIAR o que fez.
   *
   * E assim que o funil anda sozinho: quem escuta `atena.ferramenta` (o piloto
   * da Atena) decide, por regra, se aquele fato move o cartao de coluna. A
   * ferramenta nao sabe nada de funil — so conta o que aconteceu.
   * So sucesso e anunciado: uma consulta que falhou nao e fato nenhum.
   */
  function comAviso(ferramenta) {
    return {
      ...ferramenta,
      async executar(args, contexto) {
        const resultado = await ferramenta.executar(args, contexto);
        if (conversationId && !resultado?.erro) {
          emitir(EVENTOS.ATENA_FERRAMENTA, {
            tenantId,
            conversationId,
            nome: ferramenta.nome,
            resultado
          });
        }
        return resultado;
      }
    };
  }
}
