import { obterAgente } from '../modules/ia/ia.service.js';
import { funcaoLigada } from '../modules/funcoes/funcoes.js';

/**
 * A Atena pode fazer isto sozinha?
 *
 * Toda automacao passa por aqui antes de agir. A empresa decide na Central de
 * IA o que a Atena pode fazer; uma rotina que ignorasse essa tela seria uma
 * IA agindo contra uma configuracao explicita — o tipo de coisa que faz o dono
 * desligar o sistema inteiro na primeira surpresa.
 *
 * Atena DESATIVADA nao faz nada, nem automatico: desativar significa "nao quero
 * ela mexendo em nada", e vale para regras tanto quanto para o modelo. Vale
 * igual para a Atena desligada pelo DEV (Funcoes do sistema), que vem antes
 * da configuracao da empresa.
 *
 * @param {string} tenantId
 * @param {string} grupo  chave de `GRUPOS_ATENA` ('funil', 'resumo', 'rotina'...)
 */
export async function atenaPermite(tenantId, grupo) {
  try {
    if (!(await funcaoLigada(tenantId, 'agente_atena'))) return false;
    const atena = await obterAgente(tenantId, 'atena');
    if (atena.ativo === false) return false;
    return (atena.ferramentas ?? []).includes(grupo);
  } catch {
    // Sem conseguir ler a configuracao, o seguro e nao agir.
    return false;
  }
}
