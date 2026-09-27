import { useRef, useState } from 'react';
import { Icone } from './Icone.jsx';
import {
  TEMAS,
  cancelarPrevia,
  definirTema,
  fixarValor,
  indiceMaisPerto,
  previsualizarValor,
  proximoTema,
  useTema
} from '../lib/tema.js';

/**
 * Modo de visualizacao no rodape do menu (acima do "Recolher menu").
 *
 * Aberto: uma barra com os tres icones e um botao que desliza.
 *   - CLIQUE num icone: o botao desliza ate ele e a pagina funde para o modo.
 *   - SEGURAR E ARRASTAR: a pagina muda de cor acompanhando a mao; soltou no
 *     meio do caminho, aquele tom intermediario fica (ver lib/tema.js).
 *   - Teclado: setas vao de modo em modo.
 * Recolhido: nao cabe a barra; o icone do modo atual troca para o proximo a
 * cada clique (claro → medio → full black → claro).
 */

/** Andou mais que isso com o botao apertado: e arraste, nao clique. */
const LIMIAR_ARRASTE_PX = 4;

export function SeletorTema({ recolhido }) {
  const valor = useTema();
  const indice = indiceMaisPerto(valor);
  const atual = TEMAS[indice];
  const trilho = useRef(null);
  const inicio = useRef(null); // { x } de onde o dedo desceu
  // Arrastando: a posicao continua (0 a 2) que o botao e a pagina seguem.
  const [arraste, setArraste] = useState(null);

  function posicaoDoPonteiro(e) {
    const r = trilho.current.getBoundingClientRect();
    const fracao = (e.clientX - r.left) / r.width;
    return Math.min(TEMAS.length - 1, Math.max(0, fracao * TEMAS.length - 0.5));
  }

  function aoPressionar(e) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    inicio.current = { x: e.clientX };
  }

  function aoMover(e) {
    if (!inicio.current) return;
    // So vira arraste depois de andar um pouco: um clique com a mao tremendo
    // continua sendo clique (com a animacao de encaixe).
    if (arraste === null && Math.abs(e.clientX - inicio.current.x) < LIMIAR_ARRASTE_PX) return;
    const pos = posicaoDoPonteiro(e);
    setArraste(pos);
    previsualizarValor(pos);
  }

  function aoSoltar(e) {
    if (!inicio.current) return;
    inicio.current = null;
    if (arraste !== null) {
      // Soltou no meio: o tom daquele ponto fica.
      fixarValor(posicaoDoPonteiro(e));
      setArraste(null);
      return;
    }
    // Clique: vai para o modo do icone clicado, com a animacao.
    definirTema(TEMAS[Math.round(posicaoDoPonteiro(e))].chave);
  }

  function aoCancelar() {
    inicio.current = null;
    if (arraste !== null) cancelarPrevia();
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
    const proximo = TEMAS.find((t) => t.chave === proximoTema(valor));
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

  const posicao = arraste ?? valor;
  const entre = Math.abs(posicao - Math.round(posicao)) > 0.001;
  const vizinho = TEMAS[Math.round(posicao) === Math.floor(posicao) ? Math.ceil(posicao) : Math.floor(posicao)];
  return (
    <div
      ref={trilho}
      className={`tema-barra${arraste !== null ? ' tema-barra--arrastando' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label="Modo de visualização"
      aria-valuemin={0}
      aria-valuemax={TEMAS.length - 1}
      aria-valuenow={+posicao.toFixed(2)}
      aria-valuetext={entre ? `Entre ${TEMAS[Math.floor(posicao)].rotulo} e ${TEMAS[Math.ceil(posicao)].rotulo}` : atual.rotulo}
      title={entre ? `Tom entre ${TEMAS[Math.round(posicao)].rotulo} e ${vizinho.rotulo}` : undefined}
      onPointerDown={aoPressionar}
      onPointerMove={aoMover}
      onPointerUp={aoSoltar}
      onPointerCancel={aoCancelar}
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
