import { formatarBRL } from '../../core/money.js';

/**
 * A parte do menu que so o servidor sabe fazer: montar a lista de servicos
 * com os precos REAIS do catalogo. O resto (andar pelo fluxo, validar,
 * desenhar o texto do menu) mora em `fluxo.js`, que a tela tambem usa.
 *
 * O sistema antigo tinha a tabela de precos escrita no codigo; aqui ela vem
 * do mesmo servico que a tela de Catalogo usa.
 *
 * @param {() => Promise<{nome: string, precoCentavos: number, duracaoMinutos: number}[]>} listar
 */
export async function textoDosServicos(listar) {
  const lista = await listar();
  if (lista.length === 0) {
    return 'Ainda não temos serviços cadastrados. Um atendente já vai te ajudar!';
  }

  return [
    '*Nossos serviços e valores:*',
    '',
    ...lista.map((s, i) => `${i + 1}. *${s.nome}* — ${formatarBRL(s.precoCentavos)} (${s.duracaoMinutos} min)`)
  ].join('\n');
}
