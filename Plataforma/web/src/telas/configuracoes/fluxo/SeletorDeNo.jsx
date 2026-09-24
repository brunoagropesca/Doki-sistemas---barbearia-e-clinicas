import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TIPOS_NO } from '@regras-do-fluxo';
import { VISUAL } from './conversao.js';

/**
 * Lista de tipos de passo para criar. Abre em dois lugares:
 *
 *   - como MENU SUSPENSO do botao "+ Adicionar passo" (`ancora` = o botao):
 *     embaixo dele, alinhado pela direita;
 *   - no PONTO em que a linha de uma opcao foi solta no vazio (como no n8n) —
 *     o passo novo ja nasce ligado a ela.
 *
 * Mora no <body> e se posiciona pela TELA. Antes ficava dentro do canvas e
 * se encaixava nele — mas o canvas pode ser mais alto que a janela, e a
 * metade de baixo da lista ficava fora da vista.
 */
export function SeletorDeNo({ x, y, ancora, titulo, aoEscolher, aoFechar }) {
  const raiz = useRef(null);
  const [posicao, setPosicao] = useState(null);

  // Mede a lista e encaixa dentro da janela antes de pintar (sem "pulo").
  useLayoutEffect(() => {
    const el = raiz.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const margem = 8;
    let left;
    let top;
    if (ancora) {
      left = ancora.right - w;
      top = ancora.bottom + 6;
      if (top + h > window.innerHeight - margem) top = Math.max(margem, ancora.top - h - 6);
    } else {
      left = x;
      top = y;
    }
    left = Math.max(margem, Math.min(left, window.innerWidth - w - margem));
    top = Math.max(margem, Math.min(top, window.innerHeight - h - margem));
    setPosicao({ left, top });
  }, [x, y, ancora]);

  useEffect(() => {
    raiz.current?.querySelector('button')?.focus();
    // O botao que abre a lista cuida de fechar (alterna): senao o mesmo
    // clique fecharia aqui e reabriria la.
    const fora = (e) => !raiz.current?.contains(e.target) && !e.target.closest?.('[data-abre-seletor]') && aoFechar();
    const esc = (e) => e.key === 'Escape' && aoFechar();
    // No proximo quadro: o proprio clique que abriu o seletor nao pode fecha-lo.
    const t = setTimeout(() => document.addEventListener('pointerdown', fora));
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', aoFechar);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', fora);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('resize', aoFechar);
    };
  }, [aoFechar]);

  return createPortal(
    <div
      className="seletor"
      ref={raiz}
      style={posicao ?? { left: -9999, top: 0, visibility: 'hidden' }}
      role="menu"
      aria-label={titulo}
    >
      <div className="seletor__titulo">{titulo}</div>
      {Object.entries(TIPOS_NO).map(([tipo, t]) => (
        <button key={tipo} type="button" role="menuitem" className="seletor__item" onClick={() => aoEscolher(tipo)}>
          <span className="no__icone" style={{ '--cor-no': VISUAL[tipo].cor }} aria-hidden="true">
            {VISUAL[tipo].icone}
          </span>
          <span>
            <strong>{t.rotulo}</strong>
            <small>{t.descricao}</small>
          </span>
        </button>
      ))}
    </div>,
    document.body
  );
}
