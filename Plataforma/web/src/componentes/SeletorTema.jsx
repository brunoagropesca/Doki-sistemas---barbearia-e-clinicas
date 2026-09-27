import { useRef, useState } from 'react';
import { Icone } from './Icone.jsx';
import { TEMAS, definirTema, proximoTema, useTema } from '../lib/tema.js';

/**
 * Modo de visualizacao no rodape do menu (acima do "Recolher menu").
 *
 * Aberto: uma barra com os tres icones e um botao que desliza — arrasta ate o
 * modo, ou clica direto no icone. Solto no meio do caminho, encaixa no mais
 * perto. Pelo teclado, setas.
 * Recolhido: nao cabe a barra; o icone do modo atual troca para o proximo a
 * cada clique (claro → medio → full black → claro).
 */
export function SeletorTema({ recolhido }) {
  const tema = useTema();
  const indice = TEMAS.findIndex((t) => t.chave === tema);
  const atual = TEMAS[indice];
  const trilho = useRef(null);
  // Durante o arraste o botao segue o dedo (posicao continua, 0 a 2).
  const [arraste, setArraste] = useState(null);

  function posicaoDoPonteiro(e) {
    const r = trilho.current.getBoundingClientRect();
    const fracao = (e.clientX - r.left) / r.width;
    return Math.min(TEMAS.length - 1, Math.max(0, fracao * TEMAS.length - 0.5));
  }

  function aoPressionar(e) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setArraste(posicaoDoPonteiro(e));
  }
  function aoMover(e) {
    if (arraste !== null) setArraste(posicaoDoPonteiro(e));
  }
  function aoSoltar(e) {
    if (arraste === null) return;
    definirTema(TEMAS[Math.round(posicaoDoPonteiro(e))].chave);
    setArraste(null);
  }

  function aoTeclar(e) {
    const passo = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    let alvo = null;
    if (passo) alvo = Math.min(TEMAS.length - 1, Math.max(0, indice + passo));
    if (e.key === 'Home') alvo = 0;
    if (e.key === 'End') alvo = TEMAS.length - 1;
    if (alvo === null) return;
    e.preventDefault();
    definirTema(TEMAS[alvo].chave);
  }

  if (recolhido) {
    const proximo = TEMAS.find((t) => t.chave === proximoTema(tema));
    return (
      <button
        type="button"
        className="menu__item tema-botao"
        onClick={() => definirTema(proximo.chave)}
        title={`Modo ${atual.rotulo} · clique para ${proximo.rotulo}`}
        aria-label={`Modo de visualização: ${atual.rotulo}. Trocar para ${proximo.rotulo}`}
      >
        <Icone nome={atual.icone} className="menu__icone" />
      </button>
    );
  }

  const posicao = arraste ?? indice;
  return (
    <div
      ref={trilho}
      className={`tema-barra${arraste !== null ? ' tema-barra--arrastando' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label="Modo de visualização"
      aria-valuemin={0}
      aria-valuemax={TEMAS.length - 1}
      aria-valuenow={indice}
      aria-valuetext={atual.rotulo}
      onPointerDown={aoPressionar}
      onPointerMove={aoMover}
      onPointerUp={aoSoltar}
      onPointerCancel={() => setArraste(null)}
      onKeyDown={aoTeclar}
      style={{ '--tema-pos': posicao }}
    >
      <span className="tema-barra__botao" aria-hidden="true" />
      {TEMAS.map((t, i) => (
        <span
          key={t.chave}
          className={`tema-barra__opcao${i === Math.round(posicao) ? ' tema-barra__opcao--ativa' : ''}`}
          title={t.rotulo}
        >
          <Icone nome={t.icone} />
        </span>
      ))}
    </div>
  );
}
