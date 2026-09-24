/**
 * A ponte entre os Contatos e as Campanhas.
 *
 * Quem marca contatos na lista e clica em "Criar campanha" nao decide ali o
 * que sera enviado: vai para a pagina de Campanhas com o publico na mao. Este
 * arquivo guarda esse publico durante a travessia.
 *
 * Fica em `sessionStorage`, e nao no estado do React, por um motivo pratico:
 * assim o publico sobrevive a um F5 na pagina de Campanhas. E fica fora do
 * endereco porque uma selecao de 300 contatos nao cabe numa URL.
 *
 * Guardamos o CONTATO INTEIRO (nome e se aceita campanha), nao so o id: a
 * tela de destino precisa mostrar quem esta no publico sem ter que perguntar
 * de volta ao servidor, um por um.
 */

const CHAVE = 'publico-de-campanha';

/** @param {Array<{id: string, nome: string, aceitaCampanha: boolean}>} contatos */
export function guardarPublico(contatos) {
  try {
    sessionStorage.setItem(
      CHAVE,
      JSON.stringify(
        contatos.map((c) => ({ id: c.id, nome: c.nome, aceitaCampanha: c.aceitaCampanha !== false }))
      )
    );
  } catch {
    // Navegador sem armazenamento (aba anonima com restricao): a tela de
    // campanhas simplesmente abre vazia, e a pessoa escolhe por la.
  }
}

/** Ha publico esperando? Pergunta sem consumir (a lista usa para redirecionar). */
export function haPublicoGuardado() {
  try {
    return Boolean(sessionStorage.getItem(CHAVE));
  } catch {
    return false;
  }
}

/**
 * Le o publico guardado SEM descartar.
 *
 * Ler e descartar sao separados de proposito: o React (em desenvolvimento)
 * chama a inicializacao de estado duas vezes, e uma leitura que apagasse o
 * publico entregaria a lista na primeira chamada e nada na segunda.
 */
export function lerPublico() {
  try {
    const bruto = sessionStorage.getItem(CHAVE);
    if (!bruto) return null;
    const lista = JSON.parse(bruto);
    return Array.isArray(lista) && lista.length > 0 ? lista : null;
  } catch {
    return null;
  }
}

/** Descarta o publico: ele vale para uma travessia so. */
export function descartarPublico() {
  try {
    sessionStorage.removeItem(CHAVE);
  } catch {
    // Sem armazenamento, nao ha o que descartar.
  }
}
