import { useEffect, useRef, useState } from 'react';
import { IDIOMAS, idiomaAtual, trocarIdioma } from '../lib/idioma.js';
import { Icone } from './Icone.jsx';
import './SeletorIdioma.css';

/**
 * Idioma do sistema, no canto superior direito (e na tela de entrada).
 *
 * `data-sem-textos`: o nome de cada idioma aparece sempre na propria lingua
 * ("English", "Español") — quem caiu num idioma que nao le precisa achar o seu.
 */
export function SeletorIdioma({ className = '' }) {
  const [aberto, setAberto] = useState(false);
  const caixa = useRef(null);
  const atual = IDIOMAS.find((i) => i.codigo === idiomaAtual) ?? IDIOMAS[0];

  // Clique fora ou Esc fecha.
  useEffect(() => {
    if (!aberto) return undefined;
    const fora = (e) => {
      if (!caixa.current?.contains(e.target)) setAberto(false);
    };
    const tecla = (e) => {
      if (e.key === 'Escape') setAberto(false);
    };
    document.addEventListener('pointerdown', fora);
    document.addEventListener('keydown', tecla);
    return () => {
      document.removeEventListener('pointerdown', fora);
      document.removeEventListener('keydown', tecla);
    };
  }, [aberto]);

  return (
    <div className={`idioma ${className}`} ref={caixa} data-sem-textos>
      <button
        type="button"
        className="idioma__botao"
        aria-haspopup="menu"
        aria-expanded={aberto}
        aria-label={`Idioma / Language / Idioma: ${atual.rotulo}`}
        title={atual.rotulo}
        onClick={() => setAberto((a) => !a)}
      >
        <Icone nome="idioma" className="idioma__icone" />
        <span>{atual.curto}</span>
        <span className="idioma__seta" aria-hidden="true">▾</span>
      </button>
      {aberto && (
        <div className="idioma__menu" role="menu">
          {IDIOMAS.map((i) => (
            <button
              key={i.codigo}
              type="button"
              role="menuitemradio"
              aria-checked={i.codigo === atual.codigo}
              className={`idioma__opcao${i.codigo === atual.codigo ? ' idioma__opcao--atual' : ''}`}
              onClick={() => {
                setAberto(false);
                trocarIdioma(i.codigo);
              }}
            >
              <span className="idioma__curto">{i.curto}</span>
              <span className="crescer">{i.rotulo}</span>
              {i.codigo === atual.codigo && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
