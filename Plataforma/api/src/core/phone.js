/**
 * Telefones brasileiros.
 *
 * Este arquivo existe por causa de um problema silencioso e caro:
 * o mesmo cliente entrando duas vezes no CRM.
 *
 * O WhatsApp manda o numero como `5511999887766@s.whatsapp.net`.
 * A secretaria digita `(11) 99988-7766`. Um import de planilha traz `11999887766`.
 * Sao tres textos diferentes para a mesma pessoa. Sem normalizar, viram
 * tres leads, tres historicos, tres conversas.
 *
 * A regra: existe UMA forma canonica guardada no banco (so digitos, com o 55
 * na frente) e toda entrada passa por aqui antes de tocar o banco.
 *
 * Complicacao extra do Brasil: celulares ganharam um nono digito em 2012, mas
 * o WhatsApp ainda entrega numeros antigos sem ele em algumas regioes. Por isso
 * `variantesDeBusca()` devolve as duas formas — pra achar o cliente que foi
 * cadastrado de um jeito e voltou pelo outro.
 */

import { ErroDeValidacao } from './errors.js';

/** DDDs validos no Brasil. Serve para rejeitar digitacao errada cedo. */
const DDDS_VALIDOS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99
]);

/** Tira tudo que nao e digito. Tambem lida com o formato JID do WhatsApp. */
export function somenteDigitos(valor) {
  if (valor == null) return '';
  // '5511999887766@s.whatsapp.net' -> '5511999887766'
  const semJid = String(valor).split('@')[0];
  return semJid.replace(/\D/g, '');
}

/**
 * Coloca o telefone na forma canonica do banco: `55` + DDD + numero.
 *
 * @param {string} valor Qualquer formato de entrada.
 * @param {object} [opts]
 * @param {boolean} [opts.estrito=true] Se true, lanca erro quando o numero e invalido.
 * @returns {string|null} Ex: '5511999887766'
 */
export function normalizarTelefone(valor, { estrito = true } = {}) {
  let d = somenteDigitos(valor);

  const falhar = (motivo) => {
    if (estrito) throw new ErroDeValidacao(`Telefone invalido: ${motivo}`);
    return null;
  };

  if (!d) return falhar('esta vazio.');

  // Remove o zero do DDD interurbano: 011... -> 11...
  if (d.length > 11 && d.startsWith('0')) d = d.replace(/^0+/, '');

  // Ja veio com o codigo do Brasil.
  if (d.length === 13 && d.startsWith('55')) {
    // 55 + DDD(2) + celular(9)
  } else if (d.length === 12 && d.startsWith('55')) {
    // 55 + DDD(2) + fixo(8)
  } else if (d.length === 11) {
    d = `55${d}`; // DDD + celular de 9 digitos
  } else if (d.length === 10) {
    d = `55${d}`; // DDD + fixo de 8 digitos
  } else {
    return falhar(`tem ${d.length} digitos, o que nao corresponde a um numero brasileiro.`);
  }

  const ddd = Number(d.slice(2, 4));
  if (!DDDS_VALIDOS.has(ddd)) {
    return falhar(`o DDD ${ddd} nao existe.`);
  }

  return d;
}

/** True se o numero (ja canonico) e um celular — 9 digitos comecando com 9. */
export function ehCelular(telefoneCanonico) {
  const d = somenteDigitos(telefoneCanonico);
  return d.length === 13 && d[4] === '9';
}

/**
 * Devolve as formas equivalentes do numero (com e sem o nono digito).
 *
 * Use ao PROCURAR um lead, nunca ao gravar. Assim o cliente cadastrado como
 * `551199887766` e encontrado quando o WhatsApp manda `5511999887766`.
 *
 * @returns {string[]} lista sem repeticoes, comecando pela forma canonica.
 */
export function variantesDeBusca(valor) {
  const canonico = normalizarTelefone(valor, { estrito: false });
  if (!canonico) return [];

  const variantes = new Set([canonico]);
  const pais = canonico.slice(0, 2);
  const ddd = canonico.slice(2, 4);
  const numero = canonico.slice(4);

  if (numero.length === 9 && numero.startsWith('9')) {
    // Com nono digito -> gera a versao antiga, sem ele.
    variantes.add(`${pais}${ddd}${numero.slice(1)}`);
  } else if (numero.length === 8) {
    // Sem nono digito -> gera a versao nova, com ele.
    variantes.add(`${pais}${ddd}9${numero}`);
  }

  return [...variantes];
}

/** Formata para leitura humana: '5511999887766' -> '+55 (11) 99988-7766' */
export function formatarTelefone(valor) {
  const d = somenteDigitos(valor);

  if (d.length === 13 && d.startsWith('55')) {
    return `+55 (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  }
  if (d.length === 12 && d.startsWith('55')) {
    return `+55 (${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}`;
  }
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;

  return String(valor ?? '');
}

/** Monta o endereco que o WhatsApp usa para receber mensagens. */
export function paraJidWhatsapp(telefone) {
  const canonico = normalizarTelefone(telefone);
  return `${canonico}@s.whatsapp.net`;
}

/** Esconde o miolo do numero, para logs: '+55 (11) *****-7766' */
export function mascarar(valor) {
  const d = somenteDigitos(valor);
  if (d.length < 8) return '***';
  return `${formatarTelefone(d).slice(0, 9)}*****-${d.slice(-4)}`;
}
