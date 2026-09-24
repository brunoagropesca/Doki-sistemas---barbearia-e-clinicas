import { horaNoFuso } from '../../core/datetime.js';
import { calcularHorariosLivres, podeAgendar } from './disponibilidade.js';

/**
 * Varios servicos na mesma visita, encaixados na agenda.
 *
 * POR QUE EXISTE.
 *
 * No teste real a cliente pediu "quero os 3" e a Atena marcou um por um, no
 * mesmo horario: o primeiro entrou, os outros dois bateram no proprio
 * agendamento dela e foram recusados. Um modelo encaixando tres servicos na
 * mao, com duracoes e profissionais diferentes, vai errar — e cada tentativa
 * e uma volta inteira de modelo. Por isso o encaixe e CONTA, nao IA.
 *
 * O ENCAIXE E DINAMICO (segundo teste real, com o Lyu):
 * a primeira versao exigia que o servico 2 comecasse no minuto exato em que o
 * 1 terminava. Com a agenda VAZIA ela respondia "nada em 14 dias": a
 * Descoloracao do Alexandre tem 5 min de limpeza depois, o Gin (tambem com
 * ele) nao podia comecar colado, e nao havia outro profissional. Agora:
 *
 *   1. ESPERA CURTA entre servicos: o proximo pode comecar ate
 *      `esperaMaxMinutos` (padrao 30) depois do anterior, em passos de 5 min.
 *      Sempre o mais cedo possivel — a espera so aparece quando precisa.
 *   2. OUTRA ORDEM: se na ordem que o cliente pediu nada cabe no dia, tenta
 *      as outras (ex.: a limpeza primeiro, enquanto o outro profissional
 *      termina um atendimento). A opcao sai marcada com `ordemTrocada` para a
 *      Sofia avisar o cliente.
 *   3. O PRIMEIRO servico comeca num horario "redondo" da grade do
 *      profissional (09:00, 09:30...), que e o que o cliente escolhe; os
 *      seguintes, no minuto em que couberem.
 *
 * Quem grava e `agenda.criarSequencia`, que refaz esta mesma conta dentro da
 * transacao e marca tudo ou nada.
 *
 * A funcao e PURA, como `disponibilidade.js`: recebe a agenda ja carregada.
 */

/**
 * @typedef {object} Candidato
 * @property {string} id
 * @property {string} nome
 * @property {object} jornada
 * @property {number} duracaoMinutos   duracao do servico COM este profissional
 * @property {number} precoCentavos    preco do servico COM este profissional
 * @property {{inicio:number,fim:number}[]} ocupados
 * @property {{inicio:number,fim:number}[]} bloqueios
 *
 * @typedef {object} Etapa
 * @property {{ id: string, nome: string, folgaMinutos: number }} servico
 * @property {Candidato[]} candidatos  na ordem de preferencia
 * @property {boolean} [fixo]          o cliente escolheu o profissional: nao trocar a ordem
 */

const MINUTO = 60_000;

/** De quantos em quantos minutos a espera entre dois servicos cresce. */
const PASSO_ESPERA = 5;

/** Espera maxima padrao entre um servico e o proximo. Mais que isso nao e "mesma visita". */
export const ESPERA_MAX_PADRAO = 30;

/** Trocar a ordem so ate 4 servicos (24 ordens). Com 5, so a ordem pedida. */
const MAX_PARA_PERMUTAR = 4;

/**
 * Teto de verificacoes por planejamento. A busca e pequena na pratica, mas
 * num dia que nao fecha de jeito nenhum ela pode explorar muita combinacao;
 * o teto garante resposta rapida (o que ja achou continua valendo).
 */
const ORCAMENTO = 40_000;

/**
 * Tenta encaixar as etapas a partir de `inicioMin` (o mais cedo que a etapa
 * pode comecar). Devolve os itens ou null.
 *
 * Backtracking: se um encaixe da etapa 2 nao deixa a 3 caber, tenta o proximo
 * (outro profissional, ou esperar mais 5 minutos).
 */
function encadear(etapas, i, inicioMin, reservas, ctx, anterior, esperaMax) {
  if (i === etapas.length) return [];

  const { servico, candidatos, fixo } = etapas[i];
  // Sem preferencia do cliente, quem acabou de atender segue atendendo:
  // o cliente nao troca de cadeira sem necessidade.
  const ordem = !fixo && anterior
    ? [...candidatos.filter((c) => c.id === anterior), ...candidatos.filter((c) => c.id !== anterior)]
    : candidatos;

  for (let espera = 0; espera <= esperaMax; espera += PASSO_ESPERA) {
    const inicio = inicioMin + espera * MINUTO;

    for (const c of ordem) {
      if (ctx.verificacoes++ > ORCAMENTO) return null;

      const fim = inicio + c.duracaoMinutos * MINUTO;
      const jaReservado = reservas.get(c.id) ?? [];

      const veredito = podeAgendar({
        inicio,
        fim,
        data: ctx.data,
        fuso: ctx.fuso,
        jornada: c.jornada,
        folgaMinutos: servico.folgaMinutos,
        ocupados: jaReservado.length ? [...c.ocupados, ...jaReservado] : c.ocupados,
        bloqueios: c.bloqueios
      });
      if (!veredito.ok) continue;

      const novas = new Map(reservas);
      novas.set(c.id, [...jaReservado, { inicio, fim: fim + servico.folgaMinutos * MINUTO }]);

      // Da segunda etapa em diante a espera vale; a primeira comeca na hora da grade.
      const resto = encadear(etapas, i + 1, fim, novas, ctx, c.id, ctx.esperaMax);
      if (resto) return [{ servico, profissional: c, inicio, fim }, ...resto];
    }
  }
  return null;
}

/** Todas as ordens possiveis, a original primeiro. */
function permutacoes(lista) {
  if (lista.length <= 1) return [lista];
  const todas = [];
  lista.forEach((item, i) => {
    const resto = [...lista.slice(0, i), ...lista.slice(i + 1)];
    for (const p of permutacoes(resto)) todas.push([item, ...p]);
  });
  return todas;
}

/** Ate `n` opcoes espalhadas pelo dia: 8 horarios seguidos das 9h nao ajudam quem quer a tarde. */
function espalhar(lista, n) {
  if (lista.length <= n) return lista;
  if (n <= 1) return lista.slice(0, 1);
  const escolhidos = new Set();
  for (let k = 0; k < n; k++) escolhidos.add(Math.round((k * (lista.length - 1)) / (n - 1)));
  return [...escolhidos].map((i) => lista[i]);
}

/** Horarios de inicio possiveis para a primeira etapa: a grade de cada candidato. */
function iniciosDaPrimeira(etapa, { data, fuso, agora, antecedenciaMinutos }) {
  const inicios = new Map();
  for (const c of etapa.candidatos) {
    const livres = calcularHorariosLivres({
      data,
      fuso,
      jornada: c.jornada,
      duracaoMinutos: c.duracaoMinutos,
      folgaMinutos: etapa.servico.folgaMinutos,
      passoMinutos: c.jornada?.intervaloMinutos ?? 30,
      ocupados: c.ocupados,
      bloqueios: c.bloqueios,
      agora,
      antecedenciaMinutos
    });
    for (const h of livres) inicios.set(h.inicio, h.hora);
  }
  return [...inicios.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Opcoes de horario para fazer todas as etapas na mesma visita, num dia.
 *
 * @param {object} p
 * @param {string} p.data
 * @param {string} p.fuso
 * @param {Etapa[]} p.etapas              na ordem que o cliente pediu
 * @param {number} [p.agora]
 * @param {number} [p.antecedenciaMinutos]
 * @param {string|null} [p.horaDesejada]  'HH:MM': so esta hora de inicio interessa
 * @param {number} [p.maxOpcoes]
 * @param {number} [p.esperaMaxMinutos]   espera maxima entre um servico e o proximo
 * @param {boolean} [p.permitirOutraOrdem]
 * @returns {{ opcoes: object[], total: number }}
 */
export function planejarSequencia({
  data,
  fuso,
  etapas,
  agora = Date.now(),
  antecedenciaMinutos = 0,
  horaDesejada = null,
  maxOpcoes = 8,
  esperaMaxMinutos = ESPERA_MAX_PADRAO,
  permitirOutraOrdem = true
}) {
  if (!etapas.length || etapas.some((e) => e.candidatos.length === 0)) return { opcoes: [], total: 0 };

  const ctx = { data, fuso, esperaMax: esperaMaxMinutos, verificacoes: 0 };
  const indices = etapas.map((_, i) => i);

  // A ordem pedida primeiro. As outras so entram se ela nao couber no dia
  // inteiro: trocar a ordem e concessao, nao preferencia.
  const ordens = permitirOutraOrdem && etapas.length <= MAX_PARA_PERMUTAR ? permutacoes(indices) : [indices];

  for (const [n, ordem] of ordens.entries()) {
    const sequencia = ordem.map((i) => etapas[i]);

    let inicios = iniciosDaPrimeira(sequencia[0], { data, fuso, agora, antecedenciaMinutos });
    if (horaDesejada) inicios = inicios.filter(([, hora]) => hora === horaDesejada);

    const opcoes = [];
    for (const [inicio] of inicios) {
      // A primeira etapa comeca exatamente na hora da grade (espera 0).
      const itens = encadear(sequencia, 0, inicio, new Map(), ctx, null, 0);
      if (!itens) continue;
      opcoes.push(montarOpcao(itens, fuso, n > 0));
    }

    if (opcoes.length) return { opcoes: espalhar(opcoes, maxOpcoes), total: opcoes.length };
    if (ctx.verificacoes > ORCAMENTO) break;
  }

  return { opcoes: [], total: 0 };
}

function montarOpcao(itens, fuso, ordemTrocada) {
  const esperaTotal = itens.slice(1).reduce((soma, it, k) => soma + (it.inicio - itens[k].fim), 0) / MINUTO;
  return {
    inicio: itens[0].inicio,
    hora: horaNoFuso(itens[0].inicio, fuso),
    termina: horaNoFuso(itens.at(-1).fim, fuso),
    totalCentavos: itens.reduce((soma, it) => soma + it.profissional.precoCentavos, 0),
    ...(ordemTrocada ? { ordemTrocada: true } : {}),
    ...(esperaTotal > 0 ? { esperaMinutos: esperaTotal } : {}),
    itens: itens.map((it) => ({
      servicoId: it.servico.id,
      servico: it.servico.nome,
      profissionalId: it.profissional.id,
      profissional: it.profissional.nome,
      hora: horaNoFuso(it.inicio, fuso),
      termina: horaNoFuso(it.fim, fuso),
      inicioEm: it.inicio,
      fimEm: it.fim,
      precoCentavos: it.profissional.precoCentavos
    }))
  };
}
