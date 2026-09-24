import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Pecas da lista da Equipe (profissionais e atendentes).
 *
 * A tela foi pensada para uma empresa com dezenas de pessoas: uma linha
 * densa por pessoa, busca e filtros em chips com a contagem (que tambem
 * servem de resumo), e as acoes num menu "⋯" — com 50 linhas, tres botoes
 * por linha viram uma parede de botoes, e "Remover" colado em "Abrir" e
 * convite para o clique errado.
 */

/** Tira acento e caixa: "José" acha "jose", "Joao" acha "João". */
export function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function Busca({ valor, aoMudar, rotulo }) {
  return (
    <label className="eq-busca">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="m20 20-4.2-4.2" />
      </svg>
      <input
        type="search"
        value={valor}
        placeholder={rotulo}
        aria-label={rotulo}
        onChange={(e) => aoMudar(e.target.value)}
      />
      {valor && (
        <button type="button" className="eq-busca__limpar" onClick={() => aoMudar('')} aria-label="Limpar busca">
          ×
        </button>
      )}
    </label>
  );
}

/** Chips de filtro com a contagem de cada um. */
export function Chips({ opcoes, valor, aoMudar, rotulo }) {
  return (
    <div className="eq-chips" role="group" aria-label={rotulo}>
      {opcoes.map((o) => (
        <button
          key={o.chave}
          type="button"
          aria-pressed={valor === o.chave}
          className={`eq-chip${valor === o.chave ? ' eq-chip--ativo' : ''}`}
          onClick={() => aoMudar(o.chave)}
        >
          {o.ponto && <span className={`eq-ponto eq-ponto--${o.ponto}`} aria-hidden="true" />}
          {o.rotulo}
          <small>{o.total}</small>
        </button>
      ))}
    </div>
  );
}

/**
 * Menu "⋯" de acoes da linha.
 *
 * Abre no <body> (portal) e se posiciona pela tela: dentro da lista ele seria
 * cortado pelo cartao nas ultimas linhas. Fecha com Esc, clique fora ou
 * rolagem. O clique no botao nao "vaza" para a linha (que abre a ficha).
 */
export function MenuAcoes({ acoes, rotulo }) {
  const [aberto, setAberto] = useState(false);
  const [pos, setPos] = useState(null);
  const botao = useRef(null);
  const menu = useRef(null);

  useLayoutEffect(() => {
    if (!aberto) return;
    const r = botao.current.getBoundingClientRect();
    const alturaMenu = menu.current?.offsetHeight ?? 160;
    const cabeEmbaixo = r.bottom + alturaMenu + 8 < window.innerHeight;
    setPos({
      top: cabeEmbaixo ? r.bottom + 4 : r.top - alturaMenu - 4,
      right: Math.max(8, window.innerWidth - r.right)
    });
  }, [aberto]);

  useEffect(() => {
    if (!aberto) return;
    const fechar = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type === 'mousedown' && (menu.current?.contains(e.target) || botao.current?.contains(e.target))) return;
      setAberto(false);
      if (e.type === 'keydown') botao.current?.focus();
    };
    document.addEventListener('mousedown', fechar);
    document.addEventListener('keydown', fechar);
    window.addEventListener('scroll', fechar, true);
    window.addEventListener('resize', fechar);
    return () => {
      document.removeEventListener('mousedown', fechar);
      document.removeEventListener('keydown', fechar);
      window.removeEventListener('scroll', fechar, true);
      window.removeEventListener('resize', fechar);
    };
  }, [aberto]);

  const visiveis = acoes.filter(Boolean);

  return (
    <>
      <button
        ref={botao}
        type="button"
        className="eq-menu__botao"
        aria-label={rotulo}
        aria-haspopup="menu"
        aria-expanded={aberto}
        onClick={(e) => {
          e.stopPropagation();
          setAberto((a) => !a);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {aberto &&
        createPortal(
          <div
            ref={menu}
            className="eq-menu"
            role="menu"
            style={pos ? { top: pos.top, right: pos.right } : { visibility: 'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            {visiveis.map((a) => (
              <button
                key={a.rotulo}
                type="button"
                role="menuitem"
                className={`eq-menu__item${a.perigo ? ' eq-menu__item--perigo' : ''}`}
                disabled={a.desabilitado}
                title={a.dica}
                onClick={() => {
                  setAberto(false);
                  a.aoClicar();
                }}
              >
                {a.rotulo}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}

/** Foto (ou inicial) da pessoa, com o anel da cor dela e o ponto de presenca opcionais. */
export function FotoPessoa({ nome, url, cor, presenca }) {
  return (
    <span className="eq-foto" style={cor ? { boxShadow: `0 0 0 2px ${cor}` } : undefined}>
      {url ? <img src={url} alt="" /> : <span aria-hidden="true">{(nome ?? '?').trim().slice(0, 1).toUpperCase()}</span>}
      {presenca && <span className={`eq-foto__presenca eq-ponto--${presenca}`} aria-hidden="true" />}
    </span>
  );
}

const DIA_CURTO = { 0: 'Dom', 1: 'Seg', 2: 'Ter', 3: 'Qua', 4: 'Qui', 5: 'Sex', 6: 'Sáb' };
// A semana da barbearia comeca na segunda.
const ORDEM = [1, 2, 3, 4, 5, 6, 0];

/**
 * A jornada em uma linha: "Seg–Sáb · 09:00–20:00".
 *
 * Dias seguidos viram faixa; dias soltos, lista ("Seg, Qua, Sex"). Quando o
 * horario muda de um dia para outro, mostra do mais cedo ao mais tarde — o
 * detalhe dia a dia continua na ficha.
 */
export function resumoJornada(jornada) {
  const dias = ORDEM.filter((d) => jornada?.dias?.[d]?.length);
  if (dias.length === 0) return { dias: 'Sem jornada', horas: '' };

  const posicoes = dias.map((d) => ORDEM.indexOf(d));
  const seguidos = posicoes.every((p, i) => i === 0 || p === posicoes[i - 1] + 1);
  const textoDias =
    dias.length === 7
      ? 'Todos os dias'
      : seguidos && dias.length > 2
        ? `${DIA_CURTO[dias[0]]}–${DIA_CURTO[dias.at(-1)]}`
        : dias.map((d) => DIA_CURTO[d]).join(', ');

  const faixas = dias.flatMap((d) => jornada.dias[d]);
  const inicio = faixas.map((f) => f.inicio).sort()[0];
  const fim = faixas.map((f) => f.fim).sort().at(-1);
  const variado = faixas.some((f) => f.inicio !== faixas[0].inicio || f.fim !== faixas[0].fim);

  return { dias: textoDias, horas: `${inicio}–${fim}`, variado };
}
