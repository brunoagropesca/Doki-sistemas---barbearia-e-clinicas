import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';
import { useAuth } from './autenticacao.jsx';

/**
 * Textos da tela trocados pelo perfil DEV.
 *
 * O sistema tem centenas de textos escritos direto nas telas. Em vez de
 * reescrever cada uma para ler de um catalogo, a troca acontece na hora de
 * MOSTRAR: um observador olha o que a tela desenha e, quando um texto tem
 * troca cadastrada, escreve a versao nova no lugar. A chave e o proprio texto
 * original, entao qualquer tela nova ja nasce editavel.
 *
 * O que NAO e trocado: o que a pessoa digita (campos), as mensagens do
 * livechat (`.msg` — conteudo de cliente nao e "texto do sistema") e o que
 * estiver dentro de `[data-sem-textos]` (o proprio editor, por exemplo).
 *
 * Limite conhecido: a troca e do texto INTEIRO de um trecho. "Ficha de Carlos"
 * e um texto diferente de "Ficha de Maria".
 */

const ATRIBUTOS = ['placeholder', 'title', 'aria-label', 'alt'];
const IGNORAR = 'script, style, noscript, textarea, input, select, [contenteditable="true"], .msg, [data-sem-textos]';

export const normalizarTexto = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** O texto original que um no (ou atributo) mostrava antes da troca. */
const originalDoNo = new WeakMap(); // Text -> original
const originalDoAtributo = new WeakMap(); // Element -> { atributo: original }

let trocas = {};

function ignorado(el) {
  return !el || Boolean(el.closest?.(IGNORAR));
}

function aplicarNoTexto(no) {
  if (ignorado(no.parentElement)) return;
  const valor = no.nodeValue;
  if (!valor || !valor.trim()) return;

  const chave = normalizarTexto(valor);
  const lembrado = originalDoNo.get(no);

  let original = null;
  let alvo = null;

  if (lembrado && chave === lembrado.trocadoPara) {
    // Mostrando uma troca nossa. Continua valendo?
    original = lembrado.original;
    alvo = Object.hasOwn(trocas, original) ? trocas[original] : original;
  } else if (Object.hasOwn(trocas, chave)) {
    original = chave;
    alvo = trocas[chave];
  } else {
    if (lembrado) originalDoNo.delete(no);
    return;
  }

  if (alvo === original) originalDoNo.delete(no);
  else originalDoNo.set(no, { original, trocadoPara: alvo });

  // Preserva os espacos de borda: "Salvar " perto de um icone continua com o espaco.
  const [, antes, , depois] = valor.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const novo = antes + alvo + depois;
  if (valor !== novo) no.nodeValue = novo;
}

function aplicarNosAtributos(el) {
  // Campos entram aqui (o placeholder e texto do sistema); o VALOR digitado
  // nunca, porque nao e atributo desta lista.
  if (el.closest?.('script, style, .msg, [data-sem-textos]')) return;

  for (const atributo of ATRIBUTOS) {
    const valor = el.getAttribute?.(atributo);
    if (!valor) continue;
    const chave = normalizarTexto(valor);
    const memoria = originalDoAtributo.get(el) ?? {};
    const lembrado = memoria[atributo];

    let original = null;
    let alvo = null;
    if (lembrado && chave === lembrado.trocadoPara) {
      original = lembrado.original;
      alvo = Object.hasOwn(trocas, original) ? trocas[original] : original;
    } else if (Object.hasOwn(trocas, chave)) {
      original = chave;
      alvo = trocas[chave];
    } else {
      if (lembrado) delete memoria[atributo];
      continue;
    }

    if (alvo === original) delete memoria[atributo];
    else memoria[atributo] = { original, trocadoPara: alvo };
    originalDoAtributo.set(el, memoria);
    if (valor !== alvo) el.setAttribute(atributo, alvo);
  }
}

function aplicarEm(raiz) {
  if (!raiz) return;
  if (raiz.nodeType === Node.TEXT_NODE) {
    aplicarNoTexto(raiz);
    return;
  }
  if (raiz.nodeType !== Node.ELEMENT_NODE && raiz.nodeType !== Node.DOCUMENT_NODE) return;

  if (raiz.nodeType === Node.ELEMENT_NODE) aplicarNosAtributos(raiz);
  const caminhante = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let no = caminhante.nextNode(); no; no = caminhante.nextNode()) {
    if (no.nodeType === Node.TEXT_NODE) aplicarNoTexto(no);
    else aplicarNosAtributos(no);
  }
}

/** Para o editor: o texto ORIGINAL por tras de um trecho da tela. */
export function originalDe(noDeTexto) {
  return originalDoNo.get(noDeTexto)?.original ?? normalizarTexto(noDeTexto.nodeValue);
}
export function originalDoAtributoDe(el, atributo) {
  return originalDoAtributo.get(el)?.[atributo]?.original ?? normalizarTexto(el.getAttribute(atributo));
}

const ContextoTextos = createContext({ trocas: {}, editando: false, setEditando: () => {} });

export function ProvedorTextos({ children }) {
  const { usuario } = useAuth();
  const [editando, setEditando] = useState(false);

  // Antes do login: as da empresa unica. Depois: as da empresa de quem entrou.
  const { data } = useQuery({
    queryKey: ['textos', usuario?.id ?? 'publico'],
    queryFn: () => api.get('/api/textos'),
    staleTime: 60_000
  });
  const mapa = useMemo(() => data?.textos ?? {}, [data]);

  // Um observador para o documento todo: telas, modais (que vivem no body)
  // e o <title> da aba.
  useEffect(() => {
    trocas = mapa;
    aplicarEm(document.documentElement);

    const observador = new MutationObserver((mudancas) => {
      for (const m of mudancas) {
        if (m.type === 'characterData') aplicarNoTexto(m.target);
        else if (m.type === 'attributes') aplicarNosAtributos(m.target);
        else for (const no of m.addedNodes) aplicarEm(no);
      }
    });
    observador.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATRIBUTOS
    });
    return () => observador.disconnect();
  }, [mapa]);

  // Quem sai do sistema sai tambem do modo de edicao.
  useEffect(() => {
    if (usuario?.cargo !== 'dev') setEditando(false);
  }, [usuario]);

  const valor = useMemo(() => ({ trocas: mapa, editando, setEditando }), [mapa, editando]);
  return <ContextoTextos.Provider value={valor}>{children}</ContextoTextos.Provider>;
}

export function useTextos() {
  return useContext(ContextoTextos);
}
