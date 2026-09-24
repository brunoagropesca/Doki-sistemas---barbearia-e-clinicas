import { diaDaSemana, fimDoDia, horaNoFuso, inicioDoDia, instanteDeLocal } from '../../core/datetime.js';

/**
 * Calculo de horarios livres.
 *
 * ESTE ARQUIVO SUBSTITUI UMA DAS PIORES PARTES DO SISTEMA ANTIGO.
 *
 * La, os horarios disponiveis eram uma lista escrita na mao dentro do codigo:
 *
 *     const standardHours = ['09:00','10:00','11:00','14:00','15:00','16:00','17:00'];
 *
 * E havia uma SEGUNDA lista, diferente, em outro arquivo. Nenhuma das duas
 * olhava a jornada do profissional, a duracao do servico ou o tempo de limpeza
 * entre atendimentos. O resultado pratico: o sistema oferecia 17:00 pra um
 * servico de 70 minutos num profissional que sai as 18:00 — e oferecia horario
 * de domingo pra quem nao trabalha domingo.
 *
 * Aqui tudo isso vira conta, a partir de dado configurado:
 *   jornada do profissional + duracao do servico + folga + agendamentos
 *   existentes + bloqueios = horarios que realmente cabem.
 *
 * A funcao e PURA: recebe tudo o que precisa e nao toca no banco. Isso permite
 * testar dezenas de cenarios (feriado, agenda cheia, virada de horario de
 * verao) em milissegundos.
 */

/**
 * @typedef {{ inicio: number, fim: number }} Intervalo  instantes em ms UTC
 */

/** Dois intervalos se sobrepoem? Encostar não conta (fim de um = inicio do outro). */
export function sobrepoe(a, b) {
  return a.inicio < b.fim && b.inicio < a.fim;
}

/**
 * Converte a jornada do profissional nos intervalos de trabalho de um dia.
 *
 * @param {object} jornada  `{ dias: { "1": [{inicio,fim}] }, intervaloMinutos }`
 * @param {string} data     'YYYY-MM-DD'
 * @param {string} fuso
 * @returns {Intervalo[]}
 */
export function expedienteDoDia(jornada, data, fuso) {
  const dia = String(diaDaSemana(data));
  const faixas = jornada?.dias?.[dia];

  // Dia sem faixa configurada = nao trabalha. Silencio significa fechado,
  // nunca "aberto o dia inteiro".
  if (!Array.isArray(faixas) || faixas.length === 0) return [];

  return faixas
    .map((f) => ({
      inicio: instanteDeLocal(data, f.inicio, fuso),
      fim: instanteDeLocal(data, f.fim, fuso)
    }))
    .filter((f) => f.fim > f.inicio)
    .sort((a, b) => a.inicio - b.inicio);
}

/**
 * Calcula os horarios em que um servico cabe na agenda de um profissional.
 *
 * @param {object} p
 * @param {string} p.data                'YYYY-MM-DD'
 * @param {string} p.fuso
 * @param {object} p.jornada             jornada do profissional
 * @param {number} p.duracaoMinutos      duracao do servico
 * @param {number} [p.folgaMinutos]      limpeza/preparo apos o servico
 * @param {number} [p.passoMinutos]      de quantos em quantos minutos ofertar
 * @param {Intervalo[]} [p.ocupados]     agendamentos ja marcados
 * @param {Intervalo[]} [p.bloqueios]    ferias, almoco, feriado
 * @param {number} [p.agora]             instante atual (para nao ofertar passado)
 * @param {number} [p.antecedenciaMinutos] minimo entre agora e o horario ofertado
 * @returns {{ inicio: number, fim: number, hora: string }[]}
 */
export function calcularHorariosLivres({
  data,
  fuso,
  jornada,
  duracaoMinutos,
  folgaMinutos = 0,
  passoMinutos = 30,
  ocupados = [],
  bloqueios = [],
  agora = Date.now(),
  antecedenciaMinutos = 0
}) {
  if (!duracaoMinutos || duracaoMinutos <= 0) return [];

  const expediente = expedienteDoDia(jornada, data, fuso);
  if (expediente.length === 0) return [];

  const duracaoMs = duracaoMinutos * 60_000;
  const folgaMs = folgaMinutos * 60_000;
  const passoMs = Math.max(passoMinutos, 5) * 60_000;
  const cedoDemais = agora + antecedenciaMinutos * 60_000;

  // Um unico conjunto de "nao pode": agendamento e bloqueio pesam igual.
  const impedimentos = [...ocupados, ...bloqueios];

  const livres = [];

  for (const faixa of expediente) {
    // Alinha o primeiro horario ao passo, contando a partir do inicio do
    // expediente. Assim um expediente que comeca 09:00 com passo de 30 min
    // oferta 09:00, 09:30, 10:00 — e nao horarios quebrados como 09:07.
    for (let inicio = faixa.inicio; inicio + duracaoMs <= faixa.fim; inicio += passoMs) {
      const fim = inicio + duracaoMs;

      // Nao oferecer horario que ja passou, nem com antecedencia insuficiente.
      if (inicio < cedoDemais) continue;

      // O periodo que precisa estar livre inclui a folga pos-atendimento:
      // o proximo cliente so pode entrar depois da limpeza.
      const periodoNecessario = { inicio, fim: fim + folgaMs };

      const conflita = impedimentos.some((oc) => sobrepoe(periodoNecessario, oc));
      if (conflita) continue;

      livres.push({ inicio, fim, hora: horaNoFuso(inicio, fuso) });
    }
  }

  return livres;
}

/**
 * Verifica se um horario especifico pode ser marcado.
 *
 * Existe separada de `calcularHorariosLivres` de proposito. Na hora de GRAVAR
 * um agendamento nao basta o horario ter aparecido na lista: entre o momento
 * em que a tela carregou e o momento em que a pessoa clicou, outro atendente
 * pode ter marcado o mesmo horario. Esta funcao e a checagem final, feita
 * dentro da transacao de gravacao.
 *
 * @returns {{ ok: true } | { ok: false, motivo: string }}
 */
export function podeAgendar({
  inicio,
  fim,
  data,
  fuso,
  jornada,
  folgaMinutos = 0,
  ocupados = [],
  bloqueios = [],
  permitirForaDoExpediente = false
}) {
  if (!(fim > inicio)) {
    return { ok: false, motivo: 'O horario final precisa ser depois do inicial.' };
  }

  // Encaixe manual: o gerente pode forcar um atendimento fora do expediente,
  // mas nunca por cima de outro cliente.
  if (!permitirForaDoExpediente) {
    const expediente = expedienteDoDia(jornada, data, fuso);
    if (expediente.length === 0) {
      return { ok: false, motivo: 'Este profissional nao atende neste dia.' };
    }
    const cabeNoExpediente = expediente.some((f) => inicio >= f.inicio && fim <= f.fim);
    if (!cabeNoExpediente) {
      return { ok: false, motivo: 'O horario esta fora do expediente deste profissional.' };
    }
  }

  const periodo = { inicio, fim: fim + folgaMinutos * 60_000 };

  if (bloqueios.some((b) => sobrepoe(periodo, b))) {
    return { ok: false, motivo: 'Existe um bloqueio na agenda neste horario.' };
  }
  if (ocupados.some((o) => sobrepoe(periodo, o))) {
    return { ok: false, motivo: 'Ja existe um agendamento neste horario.' };
  }

  return { ok: true };
}

/** Limites do dia, para a consulta de agendamentos do banco. */
export function limitesDoDia(data, fuso) {
  return { inicio: inicioDoDia(data, fuso), fim: fimDoDia(data, fuso) };
}
