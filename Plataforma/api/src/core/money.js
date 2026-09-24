/**
 * Dinheiro.
 *
 * Regra unica e inegociavel: dinheiro no banco e SEMPRE um inteiro de centavos.
 * R$ 45,00 vira 4500. Nunca 45.0.
 *
 * Motivo: `0.1 + 0.2` em JavaScript da `0.30000000000000004`. Com numero
 * quebrado, somar 300 itens de uma comanda gera uma diferenca de centavos que
 * ninguem consegue explicar pro contador. Inteiro nao tem esse problema.
 *
 * O `number` do JavaScript representa inteiros exatos ate 9 quatrilhoes,
 * entao centavos cabem com folga — nao precisa de BigInt.
 */

import { ErroDeValidacao } from './errors.js';

/** Converte centavos em texto brasileiro: 4500 -> 'R$ 45,00' */
export function formatarBRL(centavos) {
  const n = Number(centavos) || 0;
  return (n / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Converte centavos em numero decimal, so para exibicao: 4500 -> 45.00 */
export function emReais(centavos) {
  return Math.round(Number(centavos) || 0) / 100;
}

/**
 * Interpreta o que o usuario digitou e devolve centavos.
 * Aceita: 45, '45', '45,90', 'R$ 45,90', '1.234,56', '1234.56'
 * @returns {number} centavos
 */
export function paraCentavos(valor) {
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) throw new ErroDeValidacao('Valor monetario invalido.');
    return Math.round(valor * 100);
  }

  if (typeof valor !== 'string') {
    throw new ErroDeValidacao('Valor monetario invalido.');
  }

  let texto = valor.trim().replace(/R\$\s*/i, '').replace(/\s/g, '');
  if (!texto) throw new ErroDeValidacao('Valor monetario vazio.');

  const temVirgula = texto.includes(',');
  const temPonto = texto.includes('.');

  if (temVirgula && temPonto) {
    // Formato brasileiro completo: '1.234,56' — ponto e separador de milhar.
    texto = texto.replace(/\./g, '').replace(',', '.');
  } else if (temVirgula) {
    // '45,90' — virgula e o decimal.
    texto = texto.replace(',', '.');
  }
  // Se so tem ponto, ja esta no formato que o Number entende ('1234.56').

  const n = Number(texto);
  if (!Number.isFinite(n)) {
    throw new ErroDeValidacao(`Valor monetario invalido: "${valor}".`);
  }
  return Math.round(n * 100);
}

/** Soma uma lista de valores em centavos com seguranca. */
export function somarCentavos(...valores) {
  return valores.flat().reduce((acc, v) => acc + (Math.round(Number(v)) || 0), 0);
}

/**
 * Aplica um desconto percentual sobre centavos.
 * @param {number} centavos
 * @param {number} percentual 0 a 100
 */
export function aplicarDesconto(centavos, percentual) {
  if (percentual < 0 || percentual > 100) {
    throw new ErroDeValidacao('Desconto precisa estar entre 0 e 100 por cento.');
  }
  return Math.round(centavos * (1 - percentual / 100));
}

/** Acrescenta os campos formatados a um objeto, para o front nao ter que formatar. */
export function comValorFormatado(obj, ...campos) {
  if (!obj) return obj;
  const saida = { ...obj };
  for (const campo of campos) {
    if (typeof saida[campo] === 'number') {
      saida[`${campo}_formatado`] = formatarBRL(saida[campo]);
    }
  }
  return saida;
}
