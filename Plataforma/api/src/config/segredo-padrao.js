/**
 * O APP_SECRET que vem no `.env.example` (e que o `env.js` usa quando falta).
 *
 * Fica num arquivo proprio, sem importar nada, porque dois lados precisam dele:
 * o `env.js` (que recusa subir com ele) e o `db/preparar-env.js` (que troca
 * ele) — e o preparar-env NAO pode importar o `env.js` antes de trocar,
 * senao o proprio `env.js` derrubaria o processo.
 */
export const SEGREDO_PADRAO = 'dev-secret-trocar-em-producao-1234567890';

/**
 * Este segredo e o de fabrica (publico, esta no git)? Vale para qualquer
 * valor comecando com "dev-secret": era a regra antiga de producao, e pega
 * variacoes feitas a mao do mesmo texto.
 */
export function ehSegredoPadrao(segredo) {
  return !segredo || String(segredo).startsWith('dev-secret');
}
