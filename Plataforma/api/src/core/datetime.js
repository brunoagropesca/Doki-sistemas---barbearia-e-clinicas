/**
 * Datas e fuso horario.
 *
 * ESTE ARQUIVO CONSERTA UM BUG REAL DO SISTEMA ANTIGO.
 *
 * La, a agente "Atena" descobria que dia e hoje assim:
 *     new Date().toISOString().slice(0, 10)
 *
 * `toISOString()` devolve sempre em UTC. O Brasil esta 3 horas atras do UTC.
 * Entao as 21:00 de segunda em Sao Paulo, ja e 00:00 de terca em UTC —
 * e o sistema agendava o cliente para o dia seguinte, sozinho, sem avisar.
 *
 * A regra aqui e:
 *   - No banco, tempo e sempre um numero: milissegundos desde 1970 (UTC).
 *     Numero nao tem fuso, nao tem ambiguidade, ordena e compara sem susto.
 *   - Na hora de perguntar "que dia e hoje?" ou "que horas sao pro cliente?",
 *     voce E OBRIGADO a passar o fuso da empresa. Nao existe funcao aqui que
 *     adivinhe o fuso sozinha.
 */

/** Fuso padrao quando a empresa ainda nao configurou o dela. */
export const FUSO_PADRAO = 'America/Sao_Paulo';

/**
 * Quebra um instante nas partes de calendario de um fuso especifico.
 * @param {Date|number} instante
 * @param {string} fuso Ex: 'America/Sao_Paulo'
 * @returns {{ano:number, mes:number, dia:number, hora:number, minuto:number, segundo:number}}
 */
export function partesNoFuso(instante, fuso = FUSO_PADRAO) {
  const data = instante instanceof Date ? instante : new Date(instante);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const p = {};
  for (const { type, value } of fmt.formatToParts(data)) {
    if (type !== 'literal') p[type] = value;
  }

  return {
    ano: Number(p.year),
    mes: Number(p.month),
    dia: Number(p.day),
    // Intl pode devolver "24" para meia-noite em alguns ambientes; normalizamos.
    hora: Number(p.hour) % 24,
    minuto: Number(p.minute),
    segundo: Number(p.second)
  };
}

/**
 * A data do calendario (YYYY-MM-DD) de um instante, no fuso da empresa.
 * E isto que responde "que dia e hoje pro cliente?" sem errar.
 */
export function dataNoFuso(instante = Date.now(), fuso = FUSO_PADRAO) {
  const { ano, mes, dia } = partesNoFuso(instante, fuso);
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** A hora local (HH:MM) de um instante, no fuso da empresa. */
export function horaNoFuso(instante = Date.now(), fuso = FUSO_PADRAO) {
  const { hora, minuto } = partesNoFuso(instante, fuso);
  return `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`;
}

/**
 * Quantos milissegundos o fuso esta deslocado do UTC NAQUELE instante.
 * Calculado por medicao, entao horario de verao ja entra na conta sozinho.
 */
function deslocamentoMs(instante, fuso) {
  const data = instante instanceof Date ? instante : new Date(instante);
  const p = partesNoFuso(data, fuso);
  const comoSeFosseUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  // Zeramos os milissegundos do original porque partesNoFuso nao os devolve.
  return comoSeFosseUtc - Math.floor(data.getTime() / 1000) * 1000;
}

/**
 * Converte "dia + hora local da empresa" no instante UTC correspondente.
 * Use sempre isto pra montar o horario de um agendamento.
 *
 * @param {string} data  'YYYY-MM-DD' no calendario local
 * @param {string} hora  'HH:MM' ou 'HH:MM:SS' no relogio local
 * @param {string} fuso
 * @returns {number} milissegundos desde 1970 (UTC)
 */
export function instanteDeLocal(data, hora = '00:00', fuso = FUSO_PADRAO) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  if (!m) throw new Error(`Data invalida: "${data}". Use o formato YYYY-MM-DD.`);

  const h = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(hora);
  if (!h) throw new Error(`Hora invalida: "${hora}". Use o formato HH:MM.`);

  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [hh, mm, ss] = [Number(h[1]), Number(h[2]), Number(h[3] ?? 0)];

  if (hh > 23 || mm > 59 || ss > 59) throw new Error(`Hora fora do intervalo valido: "${hora}".`);

  // Primeiro chutamos tratando o horario local como se fosse UTC,
  // depois corrigimos pelo deslocamento real daquele momento.
  const chute = Date.UTC(ano, mes - 1, dia, hh, mm, ss);
  const desloc1 = deslocamentoMs(chute, fuso);
  const ajustado = chute - desloc1;
  // Segunda passada: cobre a virada do horario de verao, quando o
  // deslocamento no instante ajustado difere do deslocamento no chute.
  const desloc2 = deslocamentoMs(ajustado, fuso);
  return chute - desloc2;
}

/** O instante em que comeca o dia (00:00:00) no fuso da empresa. */
export function inicioDoDia(data, fuso = FUSO_PADRAO) {
  return instanteDeLocal(data, '00:00:00', fuso);
}

/** O instante em que comeca o dia SEGUINTE — use como limite superior exclusivo. */
export function fimDoDia(data, fuso = FUSO_PADRAO) {
  return inicioDoDia(somarDias(data, 1), fuso);
}

/** Soma (ou subtrai, com numero negativo) dias a uma data 'YYYY-MM-DD'. */
export function somarDias(data, dias) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  if (!m) throw new Error(`Data invalida: "${data}". Use o formato YYYY-MM-DD.`);
  // Usamos UTC aqui de proposito: esta conta e puramente de calendario,
  // sem hora envolvida, entao fuso nao interfere.
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Dia da semana de uma data: 0 = domingo ... 6 = sabado. */
export function diaDaSemana(data) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  if (!m) throw new Error(`Data invalida: "${data}".`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/** Diferenca em dias inteiros entre dois instantes. */
export function diasEntre(instanteA, instanteB) {
  const ms = Math.abs(new Date(instanteA).getTime() - new Date(instanteB).getTime());
  return Math.floor(ms / 86_400_000);
}

const MINUTO = 60_000;

/** Soma minutos a um instante. */
export function somarMinutos(instante, minutos) {
  return new Date(instante).getTime() + minutos * MINUTO;
}

/**
 * Formata um instante para leitura humana no fuso da empresa.
 * Ex: '19/09/2026 14:30'
 */
export function formatarBR(instante, fuso = FUSO_PADRAO) {
  const { ano, mes, dia, hora, minuto } = partesNoFuso(instante, fuso);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(dia)}/${p2(mes)}/${ano} ${p2(hora)}:${p2(minuto)}`;
}

/** Confere se uma string e uma data valida no formato YYYY-MM-DD. */
export function ehDataValida(data) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return false;
  const [a, m, d] = data.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
