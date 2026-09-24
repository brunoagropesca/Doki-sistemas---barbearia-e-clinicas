import { randomBytes } from 'node:crypto';

/**
 * Geracao de identificadores.
 *
 * Formato: `<prefixo>_<tempo><aleatorio>`  ->  `lead_0mk3x9a1_f3b8c2`
 *
 * Duas propriedades importantes:
 * 1. ORDENAVEL: o inicio e o timestamp em base36, entao ordenar os ids
 *    alfabeticamente ja ordena por data de criacao. Isso torna paginacao
 *    por cursor barata, sem precisar de um indice extra em created_at.
 * 2. LEGIVEL: o prefixo diz o que e. Batendo o olho num log voce sabe se
 *    `appt_...` e um agendamento ou se alguem passou um id de lead por engano.
 */

const ALFABETO = '0123456789abcdefghijklmnopqrstuvwxyz';

function aleatorioBase36(tamanho) {
  const bytes = randomBytes(tamanho);
  let saida = '';
  for (let i = 0; i < tamanho; i++) {
    saida += ALFABETO[bytes[i] % 36];
  }
  return saida;
}

/**
 * Cria um novo id com prefixo.
 * @param {string} prefixo Ex: 'lead', 'appt', 'msg'
 * @returns {string}
 */
export function novoId(prefixo) {
  if (!prefixo || !/^[a-z]{2,10}$/.test(prefixo)) {
    throw new Error(`Prefixo de id invalido: "${prefixo}". Use de 2 a 10 letras minusculas.`);
  }

  /**
   * Ordem dentro do MESMO milissegundo.
   *
   * O sufixo era todo sorteado, entao dois ids criados no mesmo milissegundo
   * ordenavam ao acaso. Na pratica: duas mensagens do cliente gravadas juntas
   * ("oi" e "tudo bem?") podiam aparecer trocadas na conversa e no historico
   * que vai para a IA. Agora os dois primeiros caracteres do sufixo sao um
   * contador que reinicia a cada milissegundo — o resto continua sorteado, para
   * o id seguir imprevisivel.
   */
  const agora = Date.now();
  if (agora === ultimoInstante) {
    sequencia += 1;
  } else {
    ultimoInstante = agora;
    sequencia = 0;
  }
  const ordem = (sequencia % 1296).toString(36).padStart(2, '0');

  const tempo = agora.toString(36).padStart(9, '0');
  return `${prefixo}_${tempo}${ordem}${aleatorioBase36(6)}`;
}

let ultimoInstante = 0;
let sequencia = 0;

/** Prefixos oficiais — centralizados para ninguem inventar um novo no meio do codigo. */
export const ID = {
  tenant: () => novoId('tnt'),
  usuario: () => novoId('usr'),
  sessao: () => novoId('ses'),
  profissional: () => novoId('prof'),
  servico: () => novoId('svc'),
  produto: () => novoId('prod'),
  lead: () => novoId('lead'),
  agendamento: () => novoId('appt'),
  venda: () => novoId('sale'),
  conversa: () => novoId('conv'),
  mensagem: () => novoId('msg'),
  campanha: () => novoId('camp'),
  alvo: () => novoId('tgt'),
  canal: () => novoId('chan'),
  provedorIa: () => novoId('aip'),
  agente: () => novoId('agt'),
  menu: () => novoId('menu'),
  respostaRapida: () => novoId('qr'),
  aviso: () => novoId('avs'),
  notificacao: () => novoId('ntf'),
  historico: () => novoId('hist'),
  auditoria: () => novoId('log')
};

/** Confere se uma string parece um id do prefixo esperado. */
export function ehIdDe(prefixo, valor) {
  return typeof valor === 'string' && valor.startsWith(`${prefixo}_`);
}
