/**
 * Cliente da API.
 *
 * Um unico lugar que sabe conversar com o servidor. Toda tela chama por aqui,
 * nunca `fetch` direto. Isso da tres coisas de graca:
 *
 *  1. O erro sempre chega no mesmo formato, com codigo e mensagem ja prontos
 *     para mostrar ao usuario.
 *  2. Sessao expirada e tratada num lugar so, em vez de cada tela reinventar.
 *  3. O dia que a API mudar de endereco, muda aqui.
 */

/** Erro vindo da API, ja no formato que a tela precisa. */
export class ErroApi extends Error {
  constructor(mensagem, { status, codigo, detalhes } = {}) {
    super(mensagem);
    this.name = 'ErroApi';
    this.status = status;
    this.codigo = codigo;
    this.detalhes = detalhes;
  }

  /** Erros de campo, prontos para destacar no formulario. */
  get camposComErro() {
    const campos = this.detalhes?.campos ?? [];
    return Object.fromEntries(campos.map((c) => [c.campo, c.mensagem]));
  }
}

/** Avisa o app que a sessao caiu, sem que este arquivo precise conhecer o React. */
const aoPerderSessao = new Set();

export function quandoPerderSessao(callback) {
  aoPerderSessao.add(callback);
  return () => aoPerderSessao.delete(callback);
}

async function requisitar(caminho, { metodo = 'GET', corpo, params } = {}) {
  const url = new URL(caminho, window.location.origin);

  if (params) {
    for (const [chave, valor] of Object.entries(params)) {
      // Nao mandar filtro vazio: `?busca=` e diferente de nao filtrar.
      if (valor !== undefined && valor !== null && valor !== '') {
        url.searchParams.set(chave, valor);
      }
    }
  }

  let resposta;
  try {
    resposta = await fetch(url, {
      method: metodo,
      headers: corpo ? { 'Content-Type': 'application/json' } : {},
      // Manda o cookie de sessao.
      credentials: 'include',
      body: corpo ? JSON.stringify(corpo) : undefined
    });
  } catch {
    // Falha de rede: o servidor pode estar desligado.
    throw new ErroApi('Nao consegui falar com o servidor. Ele esta ligado?', { status: 0, codigo: 'SEM_CONEXAO' });
  }

  if (resposta.status === 204) return null;

  let dados = null;
  try {
    dados = await resposta.json();
  } catch {
    dados = null;
  }

  if (!resposta.ok) {
    const erro = dados?.erro ?? {};

    // Sessao expirou ou foi revogada: avisa o app uma vez, em vez de cada
    // tela descobrir sozinha e mostrar um erro confuso.
    if (resposta.status === 401) {
      for (const cb of aoPerderSessao) cb();
    }
    // Licenca travou no meio do uso: a guarda de licenca troca a tela na hora.
    if (resposta.status === 402) window.dispatchEvent(new Event('licenca-bloqueada'));

    throw new ErroApi(erro.mensagem ?? 'Algo deu errado.', {
      status: resposta.status,
      codigo: erro.codigo,
      detalhes: erro.detalhes
    });
  }

  return dados;
}

export const api = {
  get: (caminho, params) => requisitar(caminho, { params }),
  post: (caminho, corpo) => requisitar(caminho, { metodo: 'POST', corpo }),
  put: (caminho, corpo) => requisitar(caminho, { metodo: 'PUT', corpo }),
  patch: (caminho, corpo) => requisitar(caminho, { metodo: 'PATCH', corpo }),
  delete: (caminho) => requisitar(caminho, { metodo: 'DELETE' })
};
