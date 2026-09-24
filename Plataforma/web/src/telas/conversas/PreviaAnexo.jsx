import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconeAnexo, IconeEnviar, tamanhoLegivel } from './Compositor.jsx';
import './PreviaAnexo.css';

/**
 * Previa do anexo antes de mandar — cobre a conversa, como no WhatsApp.
 *
 * Foto ganha um editor simples (lapis, pincel, texto). A edicao so existe
 * aqui no navegador: o que vai para o servidor e a imagem ja "achatada",
 * pelo mesmo caminho de qualquer outra foto.
 *
 * @param {object} p
 * @param {{ arquivo: File, tipo: 'imagem'|'video'|'documento', dataUrl: string }} p.anexo
 * @param {(pronto: { dataUrl: string, nome: string, legenda: string }) => void} p.aoEnviar
 */
export function PreviaAnexo({ anexo, legendaInicial, enviando, aoCancelar, aoEnviar }) {
  const [legenda, setLegenda] = useState(legendaInicial);
  const { arquivo, tipo, dataUrl } = anexo;
  const legendaRef = useRef(null);
  const editorRef = useRef(null);
  const cancelarRef = useRef(aoCancelar);
  cancelarRef.current = aoCancelar;

  useEffect(() => {
    // Foto abre sem roubar o teclado para a legenda: quem vai desenhar nao
    // quer que o Enter de um texto na foto dispare o envio.
    if (tipo !== 'imagem') legendaRef.current?.focus();
    // Esc fecha — a menos que alguem (o texto sendo digitado na foto) ja tenha tratado.
    const esc = (e) => e.key === 'Escape' && !e.defaultPrevented && cancelarRef.current();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [tipo]);

  function enviar() {
    if (enviando) return;
    const editada = tipo === 'imagem' ? editorRef.current?.exportar() : null;
    aoEnviar({
      dataUrl: editada ?? dataUrl,
      // A imagem editada sai em JPG: o nome acompanha, senao o servidor e o
      // cliente veriam "foto.png" com conteudo de JPG.
      nome: editada ? arquivo.name.replace(/\.[^.]+$/, '') + '.jpg' : arquivo.name,
      legenda: legenda.trim()
    });
  }

  const extensao = arquivo.name.includes('.') ? arquivo.name.split('.').pop().toUpperCase() : 'ARQ';

  return (
    <div className="previa" role="dialog" aria-label={`Enviar ${arquivo.name}`}>
      <header className="previa__topo">
        <button type="button" className="previa__fechar" onClick={aoCancelar} aria-label="Cancelar envio" title="Cancelar (Esc)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
        <div className="previa__titulo">
          <span className="previa__nome" title={arquivo.name}>{arquivo.name}</span>
          <span className="previa__tamanho">
            {{ imagem: 'Foto', video: 'Vídeo', documento: 'Documento' }[tipo]} · {tamanhoLegivel(arquivo.size)}
          </span>
        </div>
      </header>

      {tipo === 'imagem' ? (
        <EditorImagem dataUrl={dataUrl} controleRef={editorRef} />
      ) : (
        <div className="previa__palco">
          <div className="previa__palco-interno">
            {tipo === 'video' && <video className="previa__midia" src={dataUrl} controls />}
            {tipo === 'documento' && (
              <div className="previa__documento">
                <span className="previa__doc-icone" aria-hidden="true">
                  <IconeAnexo tipo="documento" />
                  <span className="previa__doc-ext">{extensao}</span>
                </span>
                <strong>{arquivo.name}</strong>
                <span className="texto-suave">{tamanhoLegivel(arquivo.size)} · {extensao}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <form
        className="previa__rodape"
        onSubmit={(e) => {
          e.preventDefault();
          enviar();
        }}
      >
        <input
          ref={legendaRef}
          className="previa__legenda"
          value={legenda}
          onChange={(e) => setLegenda(e.target.value)}
          placeholder="Adicione uma legenda…"
          maxLength={1024}
          aria-label="Legenda"
        />
        <button type="submit" className="compositor__enviar previa__enviar" disabled={enviando} aria-label="Enviar" title="Enviar">
          {enviando ? <span className="compositor__girando" aria-hidden="true" /> : <IconeEnviar />}
        </button>
      </form>
    </div>
  );
}

/* ================================================================
 * Editor de foto
 * ================================================================ */

const CORES = ['#ffffff', '#111111', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2'];

/** Espessura em fracao da LARGURA da foto: o traco tem o mesmo peso numa foto pequena ou grande. */
const PINCEIS = {
  lapis: { largura: 0.006, alpha: 1 },
  pincel: { largura: 0.028, alpha: 0.72 }
};

/** Fotos enormes sao reduzidas: desenhar sobre 4000px trava o navegador e estoura os 16 MB. */
const LADO_MAXIMO = 2560;

const DICAS = {
  null: 'Escolha uma ferramenta para editar a foto — ou envie como está.',
  lapis: 'Clique e arraste para desenhar com traço fino.',
  pincel: 'Clique e arraste para marcar com pincel largo e translúcido.',
  texto: 'Clique na foto para escrever. Arraste um texto para movê-lo; clique nele para editar.'
};

function desenharTraco(ctx, op) {
  const pts = op.pontos;
  ctx.save();
  ctx.globalAlpha = op.alpha;
  ctx.strokeStyle = op.cor;
  ctx.lineWidth = op.largura;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) {
    ctx.lineTo(pts[0].x + 0.01, pts[0].y);
  } else {
    // Curva pelos pontos medios: o traco sai liso, sem os "degraus" do mouse.
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const ultimo = pts[pts.length - 1];
    ctx.lineTo(ultimo.x, ultimo.y);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * As 3 fontes do texto na foto. `pilha` e o mesmo valor usado no CSS (input
 * de edicao) e no canvas (texto final) — os dois PRECISAM ficar identicos,
 * senao o texto muda de tamanho/posicao no instante em que vira imagem.
 */
export const FONTES = [
  { chave: 'jakarta', rotulo: 'Moderna', pilha: '"Plus Jakarta Sans", system-ui, sans-serif', peso: 800 },
  { chave: 'poppins', rotulo: 'Arredondada', pilha: '"Poppins", system-ui, sans-serif', peso: 700 },
  { chave: 'bebas', rotulo: 'Cartaz', pilha: '"Bebas Neue", system-ui, sans-serif', peso: 400, maiuscula: true }
];
const fonteDeChave = (chave) => FONTES.find((f) => f.chave === chave) ?? FONTES[0];

function fonteCanvas(op) {
  const f = fonteDeChave(op.fonte);
  return `${f.peso} ${op.tamanho}px ${f.pilha}`;
}

function desenharTexto(ctx, op) {
  const f = fonteDeChave(op.fonte);
  const texto = f.maiuscula ? op.texto.toUpperCase() : op.texto;
  ctx.save();
  ctx.font = fonteCanvas(op);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  // Contorno FINO e opaco — a versao antiga (16% do tamanho, semi-transparente)
  // virava uma mancha cinza-borrada em vez de um traço nítido.
  ctx.strokeStyle = op.cor === '#111111' ? '#ffffff' : '#000000';
  ctx.lineWidth = Math.max(1.5, op.tamanho * 0.055);
  ctx.strokeText(texto, op.x, op.y);
  ctx.fillStyle = op.cor;
  ctx.fillText(texto, op.x, op.y);
  ctx.restore();
}

function caixaDoTexto(ctx, op) {
  const f = fonteDeChave(op.fonte);
  ctx.save();
  ctx.font = fonteCanvas(op);
  const largura = ctx.measureText(f.maiuscula ? op.texto.toUpperCase() : op.texto).width;
  ctx.restore();
  const folga = op.tamanho * 0.25;
  return {
    x0: op.x - largura / 2 - folga,
    x1: op.x + largura / 2 + folga,
    y0: op.y - op.tamanho / 2 - folga,
    y1: op.y + op.tamanho / 2 + folga
  };
}

function EditorImagem({ dataUrl, controleRef }) {
  const palcoRef = useRef(null);
  const telaRef = useRef(null);
  const rascunhoRef = useRef(null);
  const imagemRef = useRef(null);
  const tracoRef = useRef(null);
  const arrasteRef = useRef(null);
  const edicaoRef = useRef(null);

  const [pronta, setPronta] = useState(false);
  const [ferramenta, setFerramenta] = useState(null);
  const [cor, setCor] = useState('#ff3b30');
  const [fonte, setFonte] = useState('jakarta');
  const [ops, setOps] = useState([]);
  const [exibicao, setExibicao] = useState({ largura: 0, altura: 0 });
  const [edicao, setEdicaoEstado] = useState(null); // { x, y, texto, cor, fonte, tamanho, indice }

  const opsRef = useRef(ops);
  opsRef.current = ops;

  function setEdicao(valor) {
    edicaoRef.current = valor;
    setEdicaoEstado(valor);
  }

  // Carrega a foto e dimensiona as duas telas (a final e o rascunho do traco em andamento).
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, LADO_MAXIMO / Math.max(img.naturalWidth, img.naturalHeight));
      const largura = Math.round(img.naturalWidth * escala);
      const altura = Math.round(img.naturalHeight * escala);
      for (const c of [telaRef.current, rascunhoRef.current]) {
        c.width = largura;
        c.height = altura;
      }
      imagemRef.current = img;
      setPronta(true);
    };
    img.src = dataUrl;
  }, [dataUrl]);

  // A foto cabe INTEIRA na area, com folga em volta — nunca encosta nas bordas
  // nem obriga a rolar. Recalcula quando a janela muda de tamanho.
  useLayoutEffect(() => {
    const palco = palcoRef.current;
    if (!palco || !pronta) return undefined;
    const ajustar = () => {
      const c = telaRef.current;
      const disponivelL = palco.clientWidth;
      const disponivelA = palco.clientHeight;
      const fator = Math.min(disponivelL / c.width, disponivelA / c.height, 1.5);
      setExibicao({ largura: Math.floor(c.width * fator), altura: Math.floor(c.height * fator) });
    };
    ajustar();
    const obs = new ResizeObserver(ajustar);
    obs.observe(palco);
    return () => obs.disconnect();
  }, [pronta]);

  function redesenhar(ctx, lista, pular = null) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(imagemRef.current, 0, 0, ctx.canvas.width, ctx.canvas.height);
    lista.forEach((op, i) => {
      if (i === pular) return;
      if (op.tipo === 'traco') desenharTraco(ctx, op);
      else desenharTexto(ctx, op);
    });
  }

  useEffect(() => {
    if (!pronta) return;
    redesenhar(telaRef.current.getContext('2d'), ops, edicao?.indice ?? null);
  }, [pronta, ops, edicao?.indice]);

  // Quem envia pede a foto final. Inclui o texto que ainda esta sendo digitado:
  // clicar em Enviar sem apertar Enter no texto nao pode perde-lo.
  controleRef.current = {
    exportar() {
      const ed = edicaoRef.current;
      let lista = opsRef.current;
      if (ed) {
        const t = ed.texto.trim();
        const op = { tipo: 'texto', texto: t, x: ed.x, y: ed.y, cor: ed.cor, tamanho: ed.tamanho };
        if (ed.indice != null) lista = lista.map((o, i) => (i === ed.indice ? op : o)).filter((o) => o.tipo !== 'texto' || o.texto);
        else if (t) lista = [...lista, op];
      }
      if (lista.length === 0 || !imagemRef.current) return null;
      const final = document.createElement('canvas');
      final.width = telaRef.current.width;
      final.height = telaRef.current.height;
      const ctx = final.getContext('2d');
      // JPG nao tem transparencia: sem fundo branco, um PNG transparente sairia preto.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, final.width, final.height);
      redesenhar(ctx, lista);
      return final.toDataURL('image/jpeg', 0.9);
    }
  };

  const fator = exibicao.largura && telaRef.current ? exibicao.largura / telaRef.current.width : 1;

  function ponto(e) {
    const r = telaRef.current.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * telaRef.current.width) / r.width,
      y: ((e.clientY - r.top) * telaRef.current.height) / r.height
    };
  }

  function confirmarTexto() {
    const ed = edicaoRef.current;
    if (!ed) return;
    setEdicao(null);
    const texto = ed.texto.trim();
    const op = { tipo: 'texto', texto, x: ed.x, y: ed.y, cor: ed.cor, fonte: ed.fonte, tamanho: ed.tamanho };
    if (ed.indice != null) {
      setOps((lista) => (texto ? lista.map((o, i) => (i === ed.indice ? op : o)) : lista.filter((_, i) => i !== ed.indice)));
    } else if (texto) {
      setOps((lista) => [...lista, op]);
    }
  }

  function desenharRascunho() {
    const ctx = rascunhoRef.current.getContext('2d');
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (tracoRef.current) desenharTraco(ctx, tracoRef.current);
  }

  function aoPressionar(e) {
    if (!ferramenta || !pronta) return;
    e.preventDefault();
    // Um texto aberto e confirmado no primeiro clique fora dele, sem abrir outro.
    if (edicaoRef.current) {
      confirmarTexto();
      return;
    }
    const p = ponto(e);
    const alvo = e.currentTarget;

    if (ferramenta === 'texto') {
      const ctx = telaRef.current.getContext('2d');
      const indice = opsRef.current.findLastIndex((op) => {
        if (op.tipo !== 'texto') return false;
        const c = caixaDoTexto(ctx, op);
        return p.x >= c.x0 && p.x <= c.x1 && p.y >= c.y0 && p.y <= c.y1;
      });
      if (indice >= 0) {
        const op = opsRef.current[indice];
        arrasteRef.current = { indice, inicio: p, origem: { x: op.x, y: op.y }, moveu: false };
        alvo.setPointerCapture(e.pointerId);
        return;
      }
      const tamanho = Math.max(18, Math.round(telaRef.current.width * 0.055));
      setEdicao({ x: p.x, y: p.y, texto: '', cor, fonte, tamanho, indice: null });
      return;
    }

    const pincel = PINCEIS[ferramenta];
    tracoRef.current = {
      tipo: 'traco',
      cor,
      alpha: pincel.alpha,
      largura: Math.max(2, telaRef.current.width * pincel.largura),
      pontos: [p]
    };
    alvo.setPointerCapture(e.pointerId);
    desenharRascunho();
  }

  function aoMover(e) {
    if (tracoRef.current) {
      tracoRef.current.pontos.push(ponto(e));
      desenharRascunho();
      return;
    }
    const a = arrasteRef.current;
    if (a) {
      const p = ponto(e);
      const dx = p.x - a.inicio.x;
      const dy = p.y - a.inicio.y;
      if (!a.moveu && Math.hypot(dx, dy) * fator < 4) return;
      a.moveu = true;
      setOps((lista) => lista.map((o, i) => (i === a.indice ? { ...o, x: a.origem.x + dx, y: a.origem.y + dy } : o)));
    }
  }

  function aoSoltar() {
    if (tracoRef.current) {
      const traco = tracoRef.current;
      tracoRef.current = null;
      setOps((lista) => [...lista, traco]);
      desenharRascunho();
      return;
    }
    const a = arrasteRef.current;
    arrasteRef.current = null;
    // Clique sem arrastar num texto = editar esse texto.
    if (a && !a.moveu) {
      const op = opsRef.current[a.indice];
      setEdicao({ ...op, indice: a.indice });
    }
  }

  // Ctrl+Z desfaz (fora dos campos de texto, onde o Ctrl+Z e do proprio campo).
  useEffect(() => {
    const tecla = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
        e.preventDefault();
        setOps((lista) => lista.slice(0, -1));
      }
    };
    document.addEventListener('keydown', tecla);
    return () => document.removeEventListener('keydown', tecla);
  }, []);

  function escolherCor(c) {
    setCor(c);
    if (edicaoRef.current) setEdicao({ ...edicaoRef.current, cor: c });
  }

  function escolherFonte(f) {
    setFonte(f);
    if (edicaoRef.current) setEdicao({ ...edicaoRef.current, fonte: f });
  }

  function escolherFerramenta(f) {
    confirmarTexto();
    setFerramenta((atual) => (atual === f ? null : f));
  }

  return (
    <>
      <div className="editor__barra" role="toolbar" aria-label="Editar foto">
        <div className="editor__grupo">
          <BotaoFerramenta ativo={ferramenta === 'lapis'} rotulo="Lápis" onClick={() => escolherFerramenta('lapis')}>
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </BotaoFerramenta>
          <BotaoFerramenta ativo={ferramenta === 'pincel'} rotulo="Pincel" onClick={() => escolherFerramenta('pincel')}>
            <path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8 9.2 12z" />
            <path d="M9.2 12c-2.3 0-4 1.8-4 4 0 1.6-1 2.6-2.4 3 1.3 1.5 3.3 2 5.2 2 2.9 0 4.8-2.1 4.8-4.8z" />
          </BotaoFerramenta>
          <BotaoFerramenta ativo={ferramenta === 'texto'} rotulo="Texto" onClick={() => escolherFerramenta('texto')}>
            <path d="M5 5h14M12 5v15M9 20h6" />
          </BotaoFerramenta>
        </div>

        <span className="editor__divisor" aria-hidden="true" />

        <div className="editor__cores" role="radiogroup" aria-label="Cor">
          {CORES.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={cor === c}
              aria-label={`Cor ${c}`}
              className={`editor__cor${cor === c ? ' editor__cor--ativa' : ''}`}
              style={{ '--cor': c }}
              onClick={() => escolherCor(c)}
            />
          ))}
        </div>

        {/* So faz sentido escolher fonte com a ferramenta Texto ativa — e o
            mesmo momento em que um texto existente pode estar sendo editado. */}
        {ferramenta === 'texto' && (
          <>
            <span className="editor__divisor" aria-hidden="true" />
            <div className="editor__fontes" role="radiogroup" aria-label="Fonte do texto">
              {FONTES.map((f) => (
                <button
                  key={f.chave}
                  type="button"
                  role="radio"
                  aria-checked={fonte === f.chave}
                  aria-label={`Fonte ${f.rotulo}`}
                  title={f.rotulo}
                  className={`editor__fonte${fonte === f.chave ? ' editor__fonte--ativa' : ''}`}
                  style={{ fontFamily: f.pilha, fontWeight: f.peso }}
                  onClick={() => escolherFonte(f.chave)}
                >
                  Aa
                </button>
              ))}
            </div>
          </>
        )}

        <span className="editor__divisor" aria-hidden="true" />

        <div className="editor__grupo">
          <BotaoFerramenta rotulo="Desfazer (Ctrl+Z)" disabled={ops.length === 0} onClick={() => setOps((l) => l.slice(0, -1))}>
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
          </BotaoFerramenta>
          <BotaoFerramenta
            rotulo="Limpar edições"
            disabled={ops.length === 0}
            onClick={() => {
              setEdicao(null);
              setOps([]);
            }}
          >
            <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
          </BotaoFerramenta>
        </div>
      </div>
      <p className="editor__dica">{DICAS[ferramenta]}</p>

      <div className="previa__palco">
        <div className="previa__palco-interno" ref={palcoRef}>
          <div
            className={`editor__tela${ferramenta ? ` editor__tela--${ferramenta}` : ''}`}
            style={{ width: exibicao.largura || undefined, height: exibicao.altura || undefined, visibility: exibicao.largura ? 'visible' : 'hidden' }}
            onPointerDown={aoPressionar}
            onPointerMove={aoMover}
            onPointerUp={aoSoltar}
            onPointerCancel={aoSoltar}
          >
            <canvas ref={telaRef} className="editor__canvas" aria-label="Foto que será enviada" role="img" />
            <canvas ref={rascunhoRef} className="editor__canvas editor__canvas--rascunho" aria-hidden="true" />

            {edicao && (
              <input
                className="editor__texto"
                autoFocus
                value={edicao.texto}
                onChange={(e) => setEdicao({ ...edicaoRef.current, texto: e.target.value })}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    confirmarTexto();
                  } else if (e.key === 'Escape') {
                    // So cancela o texto; o Esc nao chega a fechar a previa.
                    e.preventDefault();
                    setEdicao(null);
                  }
                }}
                onBlur={confirmarTexto}
                size={Math.max(edicao.texto.length, 4) + 1}
                maxLength={80}
                placeholder="Texto"
                aria-label="Texto na foto"
                style={{
                  left: edicao.x * fator,
                  top: edicao.y * fator,
                  fontSize: Math.max(12, edicao.tamanho * fator),
                  fontFamily: fonteDeChave(edicao.fonte).pilha,
                  fontWeight: fonteDeChave(edicao.fonte).peso,
                  textTransform: fonteDeChave(edicao.fonte).maiuscula ? 'uppercase' : 'none',
                  color: edicao.cor,
                  '--contorno': edicao.cor === '#111111' ? '#ffffff' : '#000000'
                }}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function BotaoFerramenta({ ativo, rotulo, disabled, onClick, children }) {
  return (
    <button
      type="button"
      className={`editor__ferramenta${ativo ? ' editor__ferramenta--ativa' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={ativo}
      aria-label={rotulo}
      title={rotulo}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
      <span className="editor__rotulo">{rotulo.replace(/ \(.*\)$/, '')}</span>
    </button>
  );
}
