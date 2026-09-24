import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import './ui.css';

/**
 * Componentes basicos da interface — Glassmorphism Edition
 */

export function Botao({ variante = 'primario', tamanho = 'md', carregando, filhos, children, ...resto }) {
  const conteudo = children ?? filhos;
  return (
    <button
      className={`botao botao--${variante} botao--${tamanho}`}
      disabled={carregando || resto.disabled}
      {...resto}
    >
      {carregando && <span className="botao__girando" aria-hidden="true" />}
      {conteudo}
    </button>
  );
}

export function Campo({ rotulo, erro, dica, children, obrigatorio }) {
  return (
    <label className="campo">
      <span className="campo__rotulo">
        {rotulo}
        {obrigatorio && <span aria-hidden="true" className="campo__obrigatorio"> *</span>}
      </span>
      {children}
      {erro && <span className="campo__erro" role="alert">{erro}</span>}
      {!erro && dica && <span className="campo__dica">{dica}</span>}
    </label>
  );
}

const juntar = (...classes) => classes.filter(Boolean).join(' ');

export function Entrada({ erro, className, ...resto }) {
  return <input className={juntar('entrada', erro && 'entrada--erro', className)} aria-invalid={Boolean(erro)} {...resto} />;
}

export function AreaTexto({ erro, className, ...resto }) {
  return <textarea className={juntar('entrada', 'entrada--area', erro && 'entrada--erro', className)} aria-invalid={Boolean(erro)} {...resto} />;
}

/**
 * Selecao — Select customizado com glassmorphism completo.
 *
 * Usa createPortal para renderizar o painel no <body>, evitando
 * qualquer corte por overflow:hidden em containers pais.
 * API identica ao <select> nativo: value, onChange(e), <option> children.
 */
export function Selecao({ erro, className, children, value, onChange, disabled, id, name, ...resto }) {
  const [aberto, setAberto] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0, abrirCima: false });
  const gatilhoRef = useRef(null);
  const listRef = useRef(null);

  /**
   * Extrai as opcoes dos <option>/<optgroup> filhos.
   *
   * Precisa ser RECURSIVO. O JSX quase nunca entrega uma lista plana: escrever
   *
   *   <Selecao>
   *     <option value="">Escolha</option>
   *     {lista.map((c) => <option key={c.id}>{c.nome}</option>)}
   *   </Selecao>
   *
   * produz `[<option>, [<option>, <option>, ...]]` — o `.map` vira UM filho que
   * e um array. Uma varredura de um nivel so ve esse array, nao reconhece nele
   * um `option`, e descarta a lista inteira: o campo abre mostrando apenas o
   * placeholder, como se a busca nao tivesse trazido nada. Era isso que
   * impedia escolher cliente e profissional na tela de marcar horario.
   *
   * Fragmentos (<>...</>) e condicionais entram pelo mesmo caminho.
   */
  const opcoes = [];

  /**
   * Texto de um <option>.
   *
   * `{c.nome} — {c.preco}` chega como ARRAY de pedacos. `String(array)` junta
   * com virgulas e produz "Ana, — ,R$ 45,00"; por isso concatenamos na mao.
   */
  const textoDe = (filhos) => {
    if (filhos === null || filhos === undefined || typeof filhos === 'boolean') return '';
    if (Array.isArray(filhos)) return filhos.map(textoDe).join('');
    if (typeof filhos === 'object') return textoDe(filhos.props?.children);
    return String(filhos);
  };

  const extrairOpcoes = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return;

    if (Array.isArray(node)) {
      node.forEach(extrairOpcoes);
      return;
    }
    if (typeof node !== 'object') return;

    if (node.type === 'option') {
      opcoes.push({
        value: String(node.props?.value ?? ''),
        label: textoDe(node.props?.children),
        group: null,
        disabled: !!node.props?.disabled
      });
      return;
    }

    if (node.type === 'optgroup') {
      const label = node.props?.label ?? '';
      const antes = opcoes.length;
      extrairOpcoes(node.props?.children);
      // Marca como do grupo so o que acabou de entrar.
      for (let i = antes; i < opcoes.length; i++) opcoes[i].group = label;
      return;
    }

    // Fragmento ou qualquer outro embrulho: desce nos filhos.
    if (node.props?.children) extrairOpcoes(node.props.children);
  };
  extrairOpcoes(children);

  const selecionada = opcoes.find((o) => String(o.value) === String(value ?? ''));
  const rotulo = selecionada?.label ?? (opcoes[0]?.label ?? 'Selecione...');

  // Calcula posicao do painel relativa ao viewport (portal no body)
  const calcularPos = useCallback(() => {
    if (!gatilhoRef.current) return;
    const rect = gatilhoRef.current.getBoundingClientRect();
    const alturaEstimadaPainel = Math.min(opcoes.length * 38 + 20, 260);
    // Sempre para BAIXO: menu que abre para cima confunde e some atras da barra
    // do navegador. Se faltar espaco embaixo, a lista rola por dentro e a pagina
    // pode rolar junto (o painel e absoluto no documento).
    const abrirCima = false;

    setPos({
      top: abrirCima ? rect.top + window.scrollY - alturaEstimadaPainel - 4 : rect.bottom + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
      abrirCima,
    });
  }, [opcoes.length]);

  const abrirDropdown = useCallback(() => {
    if (disabled) return;
    calcularPos();
    setAberto(true);
  }, [disabled, calcularPos]);

  // Fecha ao clicar fora
  useEffect(() => {
    if (!aberto) return;
    const handler = (e) => {
      const clickNoGatilho = gatilhoRef.current?.contains(e.target);
      const clickNoPainel = listRef.current?.contains(e.target);
      if (!clickNoGatilho && !clickNoPainel) setAberto(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [aberto]);

  // Recalcula posicao ao rolar ou redimensionar
  useEffect(() => {
    if (!aberto) return;
    const handler = () => calcularPos();
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  }, [aberto, calcularPos]);

  // Foco no item ativo (ou primeiro) ao abrir
  useEffect(() => {
    if (!aberto || !listRef.current) return;
    const ativo = listRef.current.querySelector('.sg__item--ativo');
    const primeiro = listRef.current.querySelector('.sg__item:not(.sg__item--disabled)');
    (ativo ?? primeiro)?.focus();
  }, [aberto]);

  const selecionar = useCallback((val) => {
    if (onChange) onChange({ target: { value: val, name: name ?? '' } });
    setAberto(false);
    gatilhoRef.current?.focus();
  }, [onChange, name]);

  // Teclado no gatilho
  const onKeyDown = (e) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); aberto ? setAberto(false) : abrirDropdown(); }
    if (e.key === 'Escape') setAberto(false);
    if (e.key === 'ArrowDown') { e.preventDefault(); aberto ? listRef.current?.querySelector('.sg__item:not(.sg__item--disabled)')?.focus() : abrirDropdown(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); abrirDropdown(); }
  };

  // Teclado nos itens
  const onItemKeyDown = (e, val) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selecionar(val); }
    if (e.key === 'Escape') { setAberto(false); gatilhoRef.current?.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); const next = e.currentTarget.nextElementSibling; if (next) { next.focus(); } }
    if (e.key === 'ArrowUp') { e.preventDefault(); const prev = e.currentTarget.previousElementSibling; if (prev) { prev.focus(); } else { gatilhoRef.current?.focus(); } }
  };

  // Agrupar
  const grupos = [];
  const vistos = new Set();
  opcoes.forEach((o) => { if (o.group && !vistos.has(o.group)) { vistos.add(o.group); grupos.push(o.group); } });
  const temGrupos = grupos.length > 0;

  const renderOpcao = (o, i) => {
    const ativo = String(o.value) === String(value ?? '');
    return (
      <div
        key={`${o.value}-${i}`}
        role="option"
        aria-selected={ativo}
        aria-disabled={o.disabled}
        tabIndex={o.disabled ? -1 : 0}
        className={juntar('sg__item', ativo && 'sg__item--ativo', o.disabled && 'sg__item--disabled')}
        onClick={() => !o.disabled && selecionar(o.value)}
        onKeyDown={(e) => !o.disabled && onItemKeyDown(e, o.value)}
      >
        {ativo && (
          <svg className="sg__check" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 8l4 4 7-7" />
          </svg>
        )}
        <span>{o.label}</span>
      </div>
    );
  };

  const painel = aberto ? createPortal(
    <div
      ref={listRef}
      role="listbox"
      aria-label="Selecione uma opcao"
      className={juntar('sg__painel', pos.abrirCima && 'sg__painel--cima')}
      style={{
        position: 'absolute',
        top: pos.top,
        left: pos.left,
        width: pos.width,
        zIndex: 9999,
      }}
    >
      <div className="sg__lista">
        {temGrupos ? (
          <>
            {opcoes.filter(o => !o.group).map((o, i) => renderOpcao(o, i))}
            {grupos.map((grupo) => (
              <div key={grupo} className="sg__grupo">
                <div className="sg__grupo-label">{grupo}</div>
                {opcoes.filter((o) => o.group === grupo).map((o, i) => renderOpcao(o, i))}
              </div>
            ))}
          </>
        ) : (
          opcoes.map((o, i) => renderOpcao(o, i))
        )}
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <div
      className={juntar('sg', erro && 'sg--erro', disabled && 'sg--disabled', aberto && 'sg--aberto', className)}
      {...resto}
    >
      <button
        ref={gatilhoRef}
        type="button"
        role="combobox"
        id={id}
        aria-expanded={aberto}
        aria-haspopup="listbox"
        aria-disabled={disabled}
        disabled={disabled}
        className="sg__gatilho"
        onClick={() => aberto ? setAberto(false) : abrirDropdown()}
        onKeyDown={onKeyDown}
      >
        <span className="sg__valor">{rotulo}</span>
        <svg
          className={juntar('sg__seta', aberto && 'sg__seta--aberta')}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {painel}
    </div>
  );
}

export function Cartao({ titulo, acao, children, semPadding }) {
  return (
    <section className="cartao">
      {(titulo || acao) && (
        <header className="cartao__topo">
          {titulo && <h2 className="cartao__titulo">{titulo}</h2>}
          {acao}
        </header>
      )}
      <div className={semPadding ? '' : 'cartao__corpo'}>{children}</div>
    </section>
  );
}

/**
 * Foto do cliente — a mesma em toda tela onde ele aparece.
 *
 * Sem foto, mostra a inicial do nome: um circulo vazio faria a lista parecer
 * quebrada. A foto vem do perfil do WhatsApp (ver `leads.sincronizarFoto` na
 * API), entao boa parte dos clientes tem uma sem ninguem ter feito nada.
 */
export function FotoLead({ nome, url, tamanho = 36 }) {
  const inicial = (nome ?? '?').trim().slice(0, 1).toUpperCase();
  return (
    <span className="avatar" style={{ width: tamanho, height: tamanho, fontSize: Math.round(tamanho * 0.4) }}>
      {url ? <img src={url} alt="" /> : <span aria-hidden="true">{inicial}</span>}
    </span>
  );
}

export function Etiqueta({ tom = 'neutro', children }) {
  return <span className={`etiqueta etiqueta--${tom}`}>{children}</span>;
}

export const TOM_STATUS = {
  pendente: 'alerta', confirmado: 'info', em_andamento: 'primario', concluido: 'sucesso',
  cancelado: 'neutro', faltou: 'perigo', bot: 'info', na_fila: 'alerta', humana: 'primario',
  finalizada: 'neutro', rascunho: 'neutro', gerando: 'info', revisao: 'alerta', pronta: 'info', enviando: 'primario', pausada: 'alerta',
  concluida: 'sucesso', cancelada: 'neutro', conectado: 'sucesso', conectando: 'alerta',
  aguardando_qr: 'alerta', desconectado: 'neutro', erro: 'perigo'
};

export const ROTULO_STATUS = {
  pendente: 'Pendente', confirmado: 'Confirmado', em_andamento: 'Em andamento', concluido: 'Concluido',
  cancelado: 'Cancelado', faltou: 'Faltou', bot: 'Com a IA', na_fila: 'Na fila', humana: 'Com atendente',
  finalizada: 'Finalizada', rascunho: 'Rascunho', gerando: 'Gerando mensagens', revisao: 'Em revisão', pronta: 'Pronta',
  enviando: 'Enviando', pausada: 'Pausada', concluida: 'Concluída', cancelada: 'Parada', conectado: 'Conectado', conectando: 'Conectando',
  aguardando_qr: 'Aguardando QR', desconectado: 'Desconectado', erro: 'Com erro'
};

export function Status({ valor }) {
  return <Etiqueta tom={TOM_STATUS[valor] ?? 'neutro'}>{ROTULO_STATUS[valor] ?? valor}</Etiqueta>;
}

export function Vazio({ titulo, descricao, acao }) {
  return (
    <div className="vazio">
      <p className="vazio__titulo">{titulo}</p>
      {descricao && <p className="vazio__descricao">{descricao}</p>}
      {acao && <div className="vazio__acao">{acao}</div>}
    </div>
  );
}

export function Carregando({ texto = 'Carregando...' }) {
  return (
    <div className="carregando" role="status">
      <span className="carregando__girando" aria-hidden="true" />
      <span>{texto}</span>
    </div>
  );
}

const AVISO_ICONES = {
  info:    '●',
  sucesso: '✓',
  alerta:  '▲',
  perigo:  '⊗',
};

export function Aviso({ tom = 'info', titulo, children, aoFechar }) {
  return (
    <div className={`aviso aviso--${tom}`} role={tom === 'perigo' ? 'alert' : 'status'}>
      <span className="aviso__icone" aria-hidden="true">{AVISO_ICONES[tom] ?? '●'}</span>
      <div className="aviso__corpo">
        {titulo && <strong className="aviso__titulo">{titulo}</strong>}
        <div className="aviso__texto">{children}</div>
      </div>
      {aoFechar && (
        <button className="aviso__fechar" onClick={aoFechar} aria-label="Fechar aviso">×</button>
      )}
    </div>
  );
}

export function Modal({ titulo, aberto, aoFechar, children, rodape, largura = 520, className }) {
  if (!aberto) return null;
  // No <body>, fora de qualquer cartao: um ancestral com backdrop-filter ou
  // transform vira o "bloco de contencao" do position:fixed, e o modal abria
  // espremido dentro do cartao que o chamou (a caixa da campanha).
  return createPortal(
    <div className="modal__fundo" onClick={aoFechar} role="presentation">
      <div
        className={juntar('modal', className)}
        style={{ maxWidth: largura }}
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__topo">
          <h2>{titulo}</h2>
          <button className="modal__fechar" onClick={aoFechar} aria-label="Fechar">×</button>
        </header>
        <div className="modal__corpo">{children}</div>
        {rodape && <footer className="modal__rodape">{rodape}</footer>}
      </div>
    </div>,
    document.body
  );
}

export function Tabela({ cabecalho, children }) {
  return (
    <div className="tabela__rolagem">
      <table className="tabela">
        <thead>
          <tr>
            {cabecalho.map((c) => (<th key={c} scope="col">{c}</th>))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Metrica({ rotulo, valor, detalhe, tom }) {
  return (
    <div className="metrica">
      <span className="metrica__rotulo">{rotulo}</span>
      <strong className={`metrica__valor ${tom ? `metrica__valor--${tom}` : ''}`}>{valor}</strong>
      {detalhe && <span className="metrica__detalhe">{detalhe}</span>}
    </div>
  );
}
