import { useEffect, useId, useRef, useState } from 'react';

/**
 * Menu proprio para escolher o modelo primario (substitui o <select> nativo).
 *
 * POR QUE NAO O <select>: o navegador decide sozinho se a lista abre para cima
 * ou para baixo, conforme o espaco que sobra na tela. Com ~40 modelos ela quase
 * sempre virava para cima e cobria o proprio campo. Aqui a lista e um bloco
 * `position: absolute` com `top: calc(100% + 4px)` dentro de um wrapper
 * `position: relative` (veja CentralIa.css): a direcao vem so do CSS, nenhum JS
 * mede espaco, e por isso ela NUNCA inverte. Se faltar espaco embaixo, a lista
 * tem altura maxima e rola por dentro (a pagina rola junto, se preciso).
 *
 * ACESSIBILIDADE (padrao "select-only combobox" do ARIA): o foco do teclado
 * fica SEMPRE no botao; a opcao destacada e informada ao leitor de tela por
 * `aria-activedescendant`. Teclas:
 *   Setas          abrem e movem o destaque
 *   Home / End     primeira / ultima opcao (PageUp/PageDown andam de 8 em 8)
 *   Enter / Espaco escolhem a opcao destacada (ou abrem, se estiver fechado)
 *   Escape         fecha e devolve o foco ao botao
 *   Tab            fecha e segue para o proximo campo (sem escolher nada)
 *   letras         saltam para a opcao que comeca com o que foi digitado
 *
 * O componente nao sabe nada de Gemini: recebe as opcoes ja prontas
 *   { valor, nome, tom: 'sucesso' | 'perigo' | 'neutro', detalhe, etiqueta, destaque }
 * e devolve o `valor` escolhido em `aoEscolher`. Quem monta o texto do teste
 * (aprovado, tempo, falhou...) e a tela que usa.
 */

// Tempo em que letras seguidas contam como UMA busca ("ge" + "m" = "gem").
const ESPERA_DIGITACAO_MS = 700;
const PASSO_PAGINA = 8;

const idDaOpcao = (base, indice) => `${base}-opcao-${indice}`;
const limitar = (n, maximo) => Math.max(0, Math.min(n, maximo));

/** O que aparece dentro do botao e de cada linha da lista: bolinha, nome, resultado do teste. */
function ConteudoOpcao({ opcao }) {
  return (
    <>
      <span className={`ci-seletor__ponto ci-seletor__ponto--${opcao.tom}`} aria-hidden="true" />
      <span className="ci-seletor__nome">
        {opcao.destaque && <span aria-hidden="true">⭐ </span>}
        {opcao.nome}
      </span>
      {/* O texto ao lado da bolinha garante que o resultado nao dependa so da cor. */}
      {opcao.detalhe && <span className={`ci-seletor__detalhe ci-seletor__detalhe--${opcao.tom}`}>{opcao.detalhe}</span>}
      {opcao.etiqueta && <span className="ci-seletor__etiqueta">{opcao.etiqueta}</span>}
    </>
  );
}

/** Texto que o leitor de tela le para uma opcao (a bolinha e a estrela sao so visuais). */
function descricaoDaOpcao(opcao) {
  return [opcao.nome, opcao.detalhe, opcao.destaque ? 'primário' : null, opcao.etiqueta?.toLowerCase()]
    .filter(Boolean)
    .join(', ');
}

export function SeletorModelo({ rotulo, valor, opcoes, aoEscolher, textoVazio = 'Escolha o modelo', className, style }) {
  const [aberto, setAberto] = useState(false);
  // Indice da opcao destacada pelo teclado ou pelo mouse (nao e a escolhida).
  const [ativo, setAtivo] = useState(0);

  const raizRef = useRef(null);
  const botaoRef = useRef(null);
  // Busca por digitacao: o texto acumulado e o relogio que o zera.
  const digitadoRef = useRef({ texto: '', timer: null });
  // Marca "acabou de abrir" para centralizar o modelo escolhido so na primeira rolagem.
  const acabouDeAbrirRef = useRef(false);
  // Ultima posicao do mouse e "este destaque veio do mouse": veja aoMoverMouse.
  const mouseRef = useRef({ x: -1, y: -1 });
  const destaqueDoMouseRef = useRef(false);

  const idBase = useId();
  const idLista = `${idBase}-lista`;

  const indiceSelecionado = opcoes.findIndex((o) => o.valor === valor);
  // Se o valor salvo nao esta na lista (modelo removido do catalogo), mostra o nome cru
  // em vez de um botao vazio que pareceria "nada escolhido".
  const atual =
    indiceSelecionado >= 0
      ? opcoes[indiceSelecionado]
      : valor
        ? { valor, nome: valor, tom: 'neutro', detalhe: '', etiqueta: null, destaque: true }
        : null;

  // A lista pode encolher com o menu aberto (durante o teste em lote a tela atualiza a cada 2s).
  const indiceAtivo = Math.min(ativo, opcoes.length - 1);

  // Clique fora fecha. O ouvinte fica no document e sai na limpeza: sem isso cada
  // abertura deixaria mais um ouvinte vivo. Escuta so enquanto o menu esta aberto.
  useEffect(() => {
    if (!aberto) return undefined;

    function aoApertarFora(e) {
      if (!raizRef.current?.contains(e.target)) setAberto(false);
    }

    document.addEventListener('pointerdown', aoApertarFora);
    return () => document.removeEventListener('pointerdown', aoApertarFora);
  }, [aberto]);

  // Mantem a opcao destacada a vista. `block: 'nearest'` rola o minimo possivel.
  useEffect(() => {
    if (!aberto) return;

    // Destaque vindo do mouse: a linha ja esta sob o cursor, rolar so faria a lista "fugir" do mouse.
    if (destaqueDoMouseRef.current) {
      destaqueDoMouseRef.current = false;
      return;
    }

    const item = document.getElementById(idDaOpcao(idBase, indiceAtivo));
    if (!item) return;

    // Ao abrir, coloca o modelo escolhido no MEIO da lista. Mexer no scrollTop da
    // propria lista rola so ela; a pagina nao pula.
    if (acabouDeAbrirRef.current) {
      acabouDeAbrirRef.current = false;
      const lista = item.parentElement;
      lista.scrollTop = item.offsetTop - (lista.clientHeight - item.offsetHeight) / 2;
    }

    item.scrollIntoView({ block: 'nearest' });
  }, [aberto, indiceAtivo, idBase]);

  // Se a tela sumir no meio de uma digitacao, o relogio da busca nao pode ficar vivo.
  useEffect(() => {
    const digitado = digitadoRef.current;
    return () => clearTimeout(digitado.timer);
  }, []);

  function abrir(indice = indiceSelecionado >= 0 ? indiceSelecionado : 0) {
    if (opcoes.length === 0) return;
    acabouDeAbrirRef.current = true;
    setAtivo(indice);
    setAberto(true);
  }

  function fechar() {
    setAberto(false);
  }

  function alternar() {
    if (aberto) {
      fechar();
      return;
    }
    abrir();
    // Safari e Firefox no Mac nao focam um botao ao clicar. Sem isto o teclado
    // nao funcionaria com a lista aberta por clique.
    botaoRef.current?.focus();
  }

  function escolher(indice) {
    const opcao = opcoes[indice];
    setAberto(false);
    botaoRef.current?.focus();
    // Escolher o que ja esta escolhido nao salva nada (igual ao onChange do <select>).
    if (opcao && opcao.valor !== valor) aoEscolher(opcao.valor);
  }

  /** Salta para a opcao cujo nome comeca com o que a pessoa digitou. */
  function digitar(letra) {
    const d = digitadoRef.current;
    clearTimeout(d.timer);
    d.texto += letra.toLowerCase();
    d.timer = setTimeout(() => {
      d.texto = '';
    }, ESPERA_DIGITACAO_MS);

    // A mesma tecla repetida ("g", "g", "g") anda de item em item entre os que
    // comecam com ela, como no <select> nativo.
    const repetindo = [...d.texto].every((c) => c === d.texto[0]);
    const prefixo = repetindo ? d.texto[0] : d.texto;
    const base = aberto ? indiceAtivo : indiceSelecionado;
    const comeco = Math.max(base + (repetindo ? 1 : 0), 0);

    for (let k = 0; k < opcoes.length; k++) {
      const i = (comeco + k) % opcoes.length;
      if (opcoes[i].nome.toLowerCase().startsWith(prefixo)) {
        if (aberto) setAtivo(i);
        else abrir(i);
        return;
      }
    }
  }

  function aoTeclar(e) {
    if (opcoes.length === 0) return;
    // Ctrl/Alt/Cmd + tecla sao atalhos do navegador (copiar, voltar...), nao sao nossos.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const ultimo = opcoes.length - 1;

    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        const passo = e.key === 'ArrowDown' ? 1 : -1;
        if (aberto) setAtivo(limitar(indiceAtivo + passo, ultimo));
        // Fechado: abre no modelo atual (ou numa ponta, se ainda nao ha escolha).
        else abrir(indiceSelecionado >= 0 ? indiceSelecionado : passo > 0 ? 0 : ultimo);
        break;
      }
      case 'Home':
      case 'End': {
        e.preventDefault();
        const alvo = e.key === 'Home' ? 0 : ultimo;
        if (aberto) setAtivo(alvo);
        else abrir(alvo);
        break;
      }
      case 'PageDown':
      case 'PageUp':
        if (aberto) {
          e.preventDefault();
          setAtivo(limitar(indiceAtivo + (e.key === 'PageDown' ? PASSO_PAGINA : -PASSO_PAGINA), ultimo));
        }
        break;
      case 'Enter':
        // preventDefault tambem impede o navegador de transformar Enter em "clique".
        e.preventDefault();
        if (aberto) escolher(indiceAtivo);
        else abrir();
        break;
      case ' ':
        e.preventDefault();
        // No meio de uma digitacao ("gemini 2") o espaco faz parte do texto.
        if (digitadoRef.current.texto) digitar(' ');
        else if (aberto) escolher(indiceAtivo);
        else abrir();
        break;
      case 'Escape':
        if (aberto) {
          e.preventDefault();
          fechar();
          botaoRef.current?.focus();
        }
        break;
      case 'Tab':
        // Sem preventDefault: o foco segue para o proximo campo normalmente.
        if (aberto) fechar();
        break;
      default:
        if (e.key.length === 1) {
          e.preventDefault();
          digitar(e.key);
        }
    }
  }

  /**
   * O mouse so destaca uma linha quando ele REALMENTE se mexeu. Sem esta
   * checagem, ao navegar pelo teclado a lista rola por baixo do mouse parado, o
   * navegador dispara um "mousemove" falso e o destaque voltava para o mouse.
   */
  function aoMoverMouse(e, indice) {
    const { clientX: x, clientY: y } = e;
    if (x === mouseRef.current.x && y === mouseRef.current.y) return;
    mouseRef.current = { x, y };

    // Mesma linha: nada muda, entao o efeito de rolagem nao roda e a marca abaixo ficaria "presa".
    if (indice === indiceAtivo) return;
    destaqueDoMouseRef.current = true;
    setAtivo(indice);
  }

  return (
    <div className={['ci-seletor', className].filter(Boolean).join(' ')} style={style} ref={raizRef}>
      <button
        ref={botaoRef}
        type="button"
        role="combobox"
        className="entrada ci-seletor__botao"
        aria-label={rotulo}
        aria-haspopup="listbox"
        aria-expanded={aberto}
        aria-controls={idLista}
        aria-activedescendant={aberto && indiceAtivo >= 0 ? idDaOpcao(idBase, indiceAtivo) : undefined}
        disabled={opcoes.length === 0}
        onClick={alternar}
        onKeyDown={aoTeclar}
        // O Firefox dispara o "clique" do Espaco ao SOLTAR a tecla; sem isto o menu abriria e fecharia de uma vez.
        onKeyUp={(e) => {
          if (e.key === ' ') e.preventDefault();
        }}
        // Foco saiu (outro campo, outra janela): fecha, para nao ficar um menu aberto sem dono.
        onBlur={fechar}
      >
        {atual ? <ConteudoOpcao opcao={atual} /> : <span className="ci-seletor__vazio">{textoVazio}</span>}
        <svg className="ci-seletor__seta" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Sempre no DOM (so escondida) para o aria-controls apontar para algo que existe. */}
      <div
        id={idLista}
        role="listbox"
        aria-label={rotulo}
        className="ci-seletor__lista"
        hidden={!aberto}
        // Clicar na lista NAO pode tirar o foco do botao: e ele que recebe o teclado.
        onMouseDown={(e) => e.preventDefault()}
      >
        {opcoes.map((opcao, i) => {
          const selecionada = i === indiceSelecionado;
          return (
            <div
              key={opcao.valor}
              id={idDaOpcao(idBase, i)}
              role="option"
              aria-selected={selecionada}
              aria-label={descricaoDaOpcao(opcao)}
              className={[
                'ci-seletor__opcao',
                i === indiceAtivo && 'ci-seletor__opcao--ativa',
                selecionada && 'ci-seletor__opcao--selecionada'
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => escolher(i)}
              onMouseMove={(e) => aoMoverMouse(e, i)}
            >
              <ConteudoOpcao opcao={opcao} />
              {/* Alem da cor de fundo, o "visto" marca a escolhida. */}
              {selecionada && <span className="ci-seletor__marca" aria-hidden="true">✓</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
