import { diaDaSemana, ehDataValida, somarDias } from './datetime.js';

/**
 * Datas como o cliente fala: "sexta", "dia 25", "depois de amanhã".
 *
 * POR QUE ISTO E CODIGO E NAO PROMPT.
 *
 * Nos testes reais a Sofia recebeu "quero agendar pra sexta" e a Atena ficou
 * em laço: as ferramentas so aceitavam AAAA-MM-DD, "hoje" ou "amanha", e o
 * modelo tentava adivinhar a data, errava o formato e tentava de novo ate o
 * limite de voltas. A saida facil seria colocar um calendario de 14 dias no
 * prompt — mas isso sao centenas de tokens em TODA chamada, inclusive nas
 * que nao falam de data, e ainda deixa a conta de "que dia cai sexta" com o
 * modelo, que erra.
 *
 * Aqui a conversao e deterministica e custa zero token: toda ferramenta da
 * Atena que recebe data passa por `interpretarData`, e a resposta volta com
 * o dia por extenso ("sexta-feira, 25/09") para a Atena repassar a Sofia.
 *
 * Nao importa nada alem de `datetime.js`: e pura, testavel sem banco.
 */

export const NOMES_DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

const MESES = {
  janeiro: 1, jan: 1, fevereiro: 2, fev: 2, marco: 3, mar: 3, abril: 4, abr: 4, maio: 5, mai: 5,
  junho: 6, jun: 6, julho: 7, jul: 7, agosto: 8, ago: 8, setembro: 9, set: 9, outubro: 10, out: 10,
  novembro: 11, nov: 11, dezembro: 12, dez: 12
};

/** Radical do dia da semana -> numero (0 = domingo). Casa "sexta", "sexta-feira", "sex". */
const DIAS = [
  [/\bdom(ingo)?\b/, 0],
  [/\bseg(unda)?(-?feira)?\b/, 1],
  // "ter" sozinho e o verbo ("posso ter horario?"): so vale terca ou ter-feira.
  [/\bterca(-?feira)?\b|\bter-feira\b/, 2],
  [/\bqua(rta)?(-?feira)?\b/, 3],
  [/\bqui(nta)?(-?feira)?\b/, 4],
  [/\bsex(ta)?(-?feira)?\b/, 5],
  [/\bsab(ado)?\b/, 6]
];

const NUMEROS_ESCRITOS = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10 };

function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const p2 = (n) => String(n).padStart(2, '0');
const montar = (a, m, d) => `${a}-${p2(m)}-${p2(d)}`;

/**
 * "sexta-feira, 25/09" — com "hoje"/"amanhã" na frente quando for o caso,
 * que e o jeito que a Sofia vai falar com o cliente.
 */
export function rotuloDaData(data, hoje) {
  const [, m, d] = data.split('-');
  const base = `${NOMES_DIAS[diaDaSemana(data)]}, ${d}/${m}`;
  if (data === hoje) return `hoje, ${base}`;
  if (data === somarDias(hoje, 1)) return `amanhã, ${base}`;
  return base;
}

/** Proxima ocorrencia do dia da semana a partir de hoje (hoje incluso, se `incluirHoje`). */
function proximoDiaDaSemana(hoje, alvo, { incluirHoje }) {
  const atual = diaDaSemana(hoje);
  let delta = (alvo - atual + 7) % 7;
  if (delta === 0 && !incluirHoje) delta = 7;
  return somarDias(hoje, delta);
}

/** Dia do mes sem mes informado: este mes, ou o proximo se ja passou. */
function diaDoMes(hoje, dia) {
  const [a, m, dHoje] = hoje.split('-').map(Number);
  if (dia >= dHoje) {
    const esteMes = montar(a, m, dia);
    if (ehDataValida(esteMes)) return esteMes;
  }
  const [a2, m2] = m === 12 ? [a + 1, 1] : [a, m + 1];
  const proximo = montar(a2, m2, dia);
  return ehDataValida(proximo) ? proximo : null;
}

/** Dia + mes sem ano: este ano, ou o proximo se ja passou. */
function diaEMes(hoje, dia, mes, ano) {
  const [aHoje] = hoje.split('-').map(Number);
  if (ano) {
    const cheio = ano < 100 ? 2000 + ano : ano;
    const data = montar(cheio, mes, dia);
    return ehDataValida(data) ? data : null;
  }
  const esteAno = montar(aHoje, mes, dia);
  if (ehDataValida(esteAno) && esteAno >= hoje) return esteAno;
  const proximo = montar(aHoje + 1, mes, dia);
  return ehDataValida(proximo) ? proximo : null;
}

/**
 * Converte uma expressao de data em AAAA-MM-DD.
 *
 * @param {string} expressao  o que o cliente disse ("sexta", "dia 25", "25/09")
 * @param {{ hoje: string }} opcoes  hoje (AAAA-MM-DD) no fuso da empresa
 * @returns {{ data: string, dia: string, aviso?: string } | { erro: string }}
 *   `dia` e o rotulo por extenso; `aviso` aparece quando a expressao e
 *   ambigua e a Sofia deve confirmar com o cliente.
 */
export function interpretarData(expressao, { hoje }) {
  const texto = normalizar(expressao);
  const ok = (data, aviso) => (data ? { data, dia: rotuloDaData(data, hoje), ...(aviso ? { aviso } : {}) } : null);

  if (!texto || texto === 'hoje') return ok(hoje);

  // Ja no formato certo.
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    return ehDataValida(texto) ? ok(texto) : { erro: `Data inválida: "${expressao}".` };
  }

  if (/\bdepois de amanha\b/.test(texto)) return ok(somarDias(hoje, 2));
  if (/\bamanha\b/.test(texto)) return ok(somarDias(hoje, 1));
  if (/\bhoje\b/.test(texto)) return ok(hoje);

  // 25/09, 25-09, 25/09/2026, 25/9/26. Ponto fica de fora: "15.30" e hora.
  let m = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/.exec(texto);
  if (m) {
    const data = diaEMes(hoje, Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null);
    return ok(data) ?? { erro: `Data inválida: "${expressao}".` };
  }

  // 25 de setembro, 3 de out
  m = /\b(\d{1,2}) de ([a-z]+)\b/.exec(texto);
  if (m && MESES[m[2]]) {
    const data = diaEMes(hoje, Number(m[1]), MESES[m[2]], null);
    return ok(data) ?? { erro: `Data inválida: "${expressao}".` };
  }

  // daqui a 3 dias, em dois dias, daqui a uma semana
  m = /\b(?:daqui a|daqui|em) (\d{1,2}|[a-z]+) (dias?|semanas?)\b/.exec(texto);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMEROS_ESCRITOS[m[1]];
    if (n) return ok(somarDias(hoje, m[2].startsWith('semana') ? n * 7 : n));
  }

  // Dia do mes solto: "dia 25", ou so "25". Se veio junto um dia da semana
  // ("sexta dia 25"), o numero manda — e conferimos se bate.
  const diaDaSemanaCitado = DIAS.find(([re]) => re.test(texto))?.[1];
  m = /\bdia (\d{1,2})\b/.exec(texto) ?? /^(\d{1,2})$/.exec(texto);
  if (m) {
    const data = diaDoMes(hoje, Number(m[1]));
    if (!data) return { erro: `Não existe o dia ${m[1]} nos próximos meses.` };
    const confere = diaDaSemanaCitado === undefined || diaDaSemana(data) === diaDaSemanaCitado;
    return ok(
      data,
      confere ? undefined : `O dia ${Number(m[1])} é ${NOMES_DIAS[diaDaSemana(data)]}, não ${NOMES_DIAS[diaDaSemanaCitado]}: confirme com o cliente.`
    );
  }

  if (/\b(fim|final) de semana\b/.test(texto)) {
    return ok(proximoDiaDaSemana(hoje, 6, { incluirHoje: true }), 'Fim de semana: considerei o sábado. Domingo é o dia seguinte.');
  }

  if (/\b(semana que vem|proxima semana)\b/.test(texto) && diaDaSemanaCitado === undefined) {
    return ok(
      proximoDiaDaSemana(hoje, 1, { incluirHoje: false }),
      'É uma semana, não um dia: considerei a segunda-feira. Pergunte ao cliente qual dia prefere.'
    );
  }

  if (diaDaSemanaCitado !== undefined) {
    // "sexta que vem" / "proxima sexta": a proxima, nunca hoje. E ambiguo no
    // uso brasileiro (esta semana ou a outra?), entao avisamos.
    const proxima = /\b(que vem|proxim[ao])\b/.test(texto);
    const data = proximoDiaDaSemana(hoje, diaDaSemanaCitado, { incluirHoje: !proxima });
    const aviso = proxima
      ? `"${String(expressao).trim()}" pode ser ${rotuloDaData(data, hoje)} ou a semana seguinte (${rotuloDaData(somarDias(data, 7), hoje)}): confirme com o cliente.`
      : undefined;
    return ok(data, aviso);
  }

  return {
    erro: `Não entendi a data "${String(expressao).trim()}". Use algo como "sexta", "dia 25", "25/09" ou "amanhã".`
  };
}
