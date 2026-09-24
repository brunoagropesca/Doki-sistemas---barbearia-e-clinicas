import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TIPOS_NO } from '@regras-do-fluxo';
import { VISUAL } from './conversao.js';

/**
 * Lista de tipos de passo para criar. Abre no botao "+ Adicionar passo" ou
 * quando a linha de uma opcao e solta no vazio (como no n8n) — nesse caso o
 * passo novo ja nasce ligado a ela.
 */
export function SeletorDeNo({ x, y, titulo, aoEscolher, aoFechar }) {
  const raiz = useRef(null);
  const [posicao, setPosicao] = useState({ left: x, top: y });

  /**
   * Encaixa a lista inteira dentro do canvas.
   *
   * Ela se MEDE em vez de o editor chutar o tamanho: foi um chute errado (o
   * conteudo cresceu) que deixava a lista meio escondida atras da borda.
   * `useLayoutEffect` ajusta antes de pintar, entao ninguem ve o pulo.
   */
  useLayoutEffect(() => {
    const el = raiz.current;
    const pai = el?.offsetParent;
    if (!el || !pai) return;
    const caixa = el.getBoundingClientRect();
    const limite = pai.getBoundingClientRect();
    const dentro = (valor, tamanho, disponivel) => Math.max(8, Math.min(valor, disponivel - tamanho - 8));
    setPosicao({
      left: dentro(x, caixa.width, limite.width),
      top: dentro(y, caixa.height, limite.height)
    });
  }, [x, y]);

  useEffect(() => {
    raiz.current?.querySelector('button')?.focus();
    const fora = (e) => !raiz.current?.contains(e.target) && aoFechar();
    const esc = (e) => e.key === 'Escape' && aoFechar();
    // No proximo quadro: o proprio clique que abriu o seletor nao pode fecha-lo.
    const t = setTimeout(() => document.addEventListener('pointerdown', fora));
    document.addEventListener('keydown', esc);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', fora);
      document.removeEventListener('keydown', esc);
    };
  }, [aoFechar]);

  return (
    <div className="seletor" ref={raiz} style={posicao} role="menu" aria-label={titulo}>
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
    </div>
  );
}
