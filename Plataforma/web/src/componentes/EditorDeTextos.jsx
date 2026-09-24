import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { normalizarTexto, originalDe, originalDoAtributoDe, useTextos } from '../lib/textos.jsx';
import './EditorDeTextos.css';

/**
 * Modo de edicao de textos do perfil DEV.
 *
 * Ligado, a tela vira um "mapa" de textos: passar o mouse destaca o trecho e
 * clicar abre o editor em vez de acionar o botao ou link. Esc (ou o botao da
 * barra) sai do modo. Como o clique fica "preso" na edicao, navegar entre
 * telas e com o modo desligado: o botao flutuante liga e desliga em qualquer
 * tela. Campos com placeholder tambem sao editaveis: clicar no
 * campo edita a dica que aparece dentro dele.
 *
 * Tudo o que e deste editor fica em `[data-sem-textos]`: ele mesmo nao e
 * traduzido nem capturado pelo modo de edicao.
 */

/** O trecho de texto sob o ponteiro (Chrome/Edge usam caretRangeFromPoint; Firefox, caretPositionFromPoint). */
function textoSobOPonteiro(x, y) {
  let no = null;
  if (document.caretPositionFromPoint) no = document.caretPositionFromPoint(x, y)?.offsetNode ?? null;
  else if (document.caretRangeFromPoint) no = document.caretRangeFromPoint(x, y)?.startContainer ?? null;
  if (!no || no.nodeType !== Node.TEXT_NODE || !no.nodeValue.trim()) return null;

  // O caret "gruda" no texto mais proximo mesmo com o ponteiro longe dele:
  // so vale se o ponteiro esta de fato sobre o retangulo do texto.
  const faixa = document.createRange();
  faixa.selectNodeContents(no);
  const dentro = [...faixa.getClientRects()].some((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2);
  return dentro ? no : null;
}

/**
 * Clique no "vazio" de um titulo largo ou de um botao: se o elemento tem UM
 * texto so, e esse. Com varios (um cartao inteiro), nao da para adivinhar —
 * o DEV clica em cima do texto que quer.
 */
function unicoTextoDe(el) {
  const caminhante = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let achado = null;
  for (let no = caminhante.nextNode(); no; no = caminhante.nextNode()) {
    if (!no.nodeValue.trim()) continue;
    if (achado) return null;
    achado = no;
  }
  return achado;
}

function alvoEditavel(evento) {
  const el = evento.target;
  if (!(el instanceof Element) || el.closest('[data-sem-textos]')) return null;

  // Campo: edita o placeholder.
  if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.getAttribute('placeholder')) {
    return { tipo: 'atributo', el, atributo: 'placeholder', original: originalDoAtributoDe(el, 'placeholder'), atual: el.getAttribute('placeholder') };
  }

  const no = textoSobOPonteiro(evento.clientX, evento.clientY) ?? unicoTextoDe(el);
  if (no && !no.parentElement?.closest('.msg, [data-sem-textos]')) {
    return { tipo: 'texto', no, original: originalDe(no), atual: normalizarTexto(no.nodeValue) };
  }

  // Botao so de icone, com dica (title / aria-label).
  const comDica = el.closest('[title], [aria-label]');
  if (comDica && !comDica.closest('[data-sem-textos]')) {
    const atributo = comDica.hasAttribute('title') ? 'title' : 'aria-label';
    return { tipo: 'atributo', el: comDica, atributo, original: originalDoAtributoDe(comDica, atributo), atual: comDica.getAttribute(atributo) };
  }
  return null;
}

function retanguloDe(alvo) {
  if (!alvo) return null;
  if (alvo.tipo === 'texto') {
    const faixa = document.createRange();
    faixa.selectNodeContents(alvo.no);
    return faixa.getBoundingClientRect();
  }
  return alvo.el.getBoundingClientRect();
}

export function EditorDeTextos() {
  const { editando, setEditando, trocas } = useTextos();
  const queryClient = useQueryClient();
  const [destaque, setDestaque] = useState(null);
  const [aberto, setAberto] = useState(null); // { original, atual, onde, retangulo }
  const [texto, setTexto] = useState('');
  const campoRef = useRef(null);

  const salvar = useMutation({
    mutationFn: ({ original, novo }) => api.put('/api/dev/textos/interface', { original, novo }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['textos'] });
      queryClient.invalidateQueries({ queryKey: ['dev', 'textos'] });
      setAberto(null);
    }
  });

  // Captura o mouse na fase de CAPTURA: o clique vira "editar" antes de chegar
  // ao botao/link da tela, que assim nao dispara.
  useEffect(() => {
    if (!editando) {
      setDestaque(null);
      setAberto(null);
      return undefined;
    }

    const aoMover = (e) => {
      if (aberto) return;
      setDestaque(retanguloDe(alvoEditavel(e)));
    };
    const bloquear = (e) => {
      if (e.target instanceof Element && e.target.closest('[data-sem-textos]')) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const aoClicar = (e) => {
      if (e.target instanceof Element && e.target.closest('[data-sem-textos]')) return;
      e.preventDefault();
      e.stopPropagation();
      const alvo = alvoEditavel(e);
      if (!alvo) return;
      setAberto({ ...alvo, retangulo: retanguloDe(alvo) });
      setTexto(alvo.atual);
      setDestaque(null);
    };
    const aoTeclar = (e) => {
      if (e.key !== 'Escape') return;
      if (aberto) setAberto(null);
      else setEditando(false);
    };

    document.addEventListener('pointermove', aoMover, true);
    document.addEventListener('pointerdown', bloquear, true);
    document.addEventListener('mousedown', bloquear, true);
    document.addEventListener('click', aoClicar, true);
    document.addEventListener('keydown', aoTeclar, true);
    document.body.classList.add('editando-textos');
    return () => {
      document.removeEventListener('pointermove', aoMover, true);
      document.removeEventListener('pointerdown', bloquear, true);
      document.removeEventListener('mousedown', bloquear, true);
      document.removeEventListener('click', aoClicar, true);
      document.removeEventListener('keydown', aoTeclar, true);
      document.body.classList.remove('editando-textos');
    };
  }, [editando, aberto, setEditando]);

  useEffect(() => {
    if (aberto) campoRef.current?.focus();
  }, [aberto]);

  const total = Object.keys(trocas).length;

  // Posicao do balao: abaixo do texto; se nao couber, acima.
  let estiloBalao = {};
  if (aberto?.retangulo) {
    const r = aberto.retangulo;
    const embaixo = r.bottom + 260 < window.innerHeight;
    estiloBalao = {
      left: Math.max(12, Math.min(r.left, window.innerWidth - 392)),
      top: embaixo ? r.bottom + 8 : Math.max(12, r.top - 260)
    };
  }

  const foiTrocado = aberto && Object.hasOwn(trocas, aberto.original);

  return createPortal(
    <div data-sem-textos>
      {!editando && (
        <button type="button" className="editor-textos__ligar" onClick={() => setEditando(true)} title="Editar os textos desta tela (so o DEV ve este botao)">
          ✏️ Editar textos
        </button>
      )}

      {editando && (
        <div className="editor-textos__barra" role="status">
          <span className="editor-textos__pulso" aria-hidden="true" />
          <span>
            <strong>Modo de edição</strong> — clique em qualquer texto. Para navegar, saia do modo. {total} alterado{total === 1 ? '' : 's'}.
          </span>
          <button type="button" className="editor-textos__sair" onClick={() => setEditando(false)}>
            Sair (Esc)
          </button>
        </div>
      )}

      {editando && destaque && !aberto && (
        <div
          className="editor-textos__destaque"
          style={{ left: destaque.left - 3, top: destaque.top - 3, width: destaque.width + 6, height: destaque.height + 6 }}
        />
      )}

      {aberto && (
        <div className="editor-textos__balao" style={estiloBalao} role="dialog" aria-label="Editar texto">
          <div className="editor-textos__rotulo">
            {aberto.tipo === 'atributo' ? `Texto de ${aberto.atributo === 'placeholder' ? 'dica do campo' : 'dica ao passar o mouse'}` : 'Texto da tela'}
          </div>
          <div className="editor-textos__original">
            <span>Original:</span> {aberto.original}
          </div>
          <textarea
            ref={campoRef}
            className="editor-textos__campo"
            value={texto}
            rows={Math.min(6, Math.max(2, Math.ceil(texto.length / 40)))}
            maxLength={1000}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                salvar.mutate({ original: aberto.original, novo: texto });
              }
            }}
          />
          {salvar.isError && <div className="editor-textos__erro">{salvar.error.message}</div>}
          <div className="editor-textos__dica">
            Vale para todo lugar onde este texto aparece. Enter salva; Shift+Enter quebra linha.
          </div>
          <div className="editor-textos__acoes">
            {foiTrocado && (
              <button
                type="button"
                className="editor-textos__botao editor-textos__botao--fantasma"
                disabled={salvar.isPending}
                onClick={() => salvar.mutate({ original: aberto.original, novo: '' })}
              >
                Voltar ao original
              </button>
            )}
            <span className="crescer" />
            <button type="button" className="editor-textos__botao editor-textos__botao--fantasma" onClick={() => setAberto(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="editor-textos__botao"
              disabled={salvar.isPending || !texto.trim()}
              onClick={() => salvar.mutate({ original: aberto.original, novo: texto })}
            >
              {salvar.isPending ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
