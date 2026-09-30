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
    // A senha virou provisoria com a tela aberta (redefinida pela gerencia, ou a
    // atualizacao marcou a senha de fabrica): o auth recarrega e mostra "Crie sua senha".
    if (resposta.status === 403 && erro.codigo === 'SENHA_PROVISORIA') window.dispatchEvent(new Event('senha-provisoria'));

    throw new ErroApi(erro.mensagem ?? 'Algo deu errado.', {
      status: resposta.status,
      codigo: erro.codigo,
      detalhes: erro.detalhes
    });
  }

  return dados;
}

/**
 * Baixa um arquivo (planilha, backup...) com a sessao do navegador e entrega
 * ao usuario com o nome que o servidor mandou. Erro vem como ErroApi, igual
 * ao resto — sem abrir uma aba com JSON de erro.
 */
async function baixar(caminho, params, nomePadrao = 'arquivo') {
  const url = new URL(caminho, window.location.origin);
  for (const [chave, valor] of Object.entries(params ?? {})) {
    if (valor !== undefined && valor !== null && valor !== '') url.searchParams.set(chave, valor);
  }
  let resposta;
  try {
    resposta = await fetch(url, { credentials: 'include' });
  } catch {
    throw new ErroApi('Nao consegui falar com o servidor. Ele esta ligado?', { status: 0, codigo: 'SEM_CONEXAO' });
  }
  if (!resposta.ok) {
    const dados = await resposta.json().catch(() => null);
    if (resposta.status === 401) for (const cb of aoPerderSessao) cb();
    throw new ErroApi(dados?.erro?.mensagem ?? 'Nao consegui gerar o arquivo.', { status: resposta.status, codigo: dados?.erro?.codigo });
  }
  const nome = /filename="([^"]+)"/.exec(resposta.headers.get('content-disposition') ?? '')?.[1] ?? nomePadrao;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await resposta.blob());
  link.download = nome;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Da tempo do navegador comecar o download antes de soltar a memoria.
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  return nome;
}

export const api = {
  baixar,
  get: (caminho, params) => requisitar(caminho, { params }),
  post: (caminho, corpo) => requisitar(caminho, { metodo: 'POST', corpo }),
  put: (caminho, corpo) => requisitar(caminho, { metodo: 'PUT', corpo }),
  patch: (caminho, corpo) => requisitar(caminho, { metodo: 'PATCH', corpo }),
  delete: (caminho) => requisitar(caminho, { metodo: 'DELETE' })
};
