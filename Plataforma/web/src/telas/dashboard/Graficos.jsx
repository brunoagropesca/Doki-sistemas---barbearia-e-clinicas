import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Graficos do dashboard — SVG e HTML proprios (o projeto nao tem biblioteca de
 * graficos, e estes cobrem o que o dono precisa).
 *
 * Regras (do guia de visualizacao usado no projeto):
 *   - marcas finas: colunas de no maximo 24px, ponta arredondada de 4px e base reta;
 *   - grade e eixos em linha fina e discreta; nunca dois eixos Y;
 *   - legenda sempre que houver 2+ series; texto nunca na cor da serie;
 *   - todo grafico tem tooltip no hover E no foco do teclado;
 *   - cor por FUNCAO: series = categorica (ordem fixa), intensidade = uma cor so.
 */

// ─── Formatacao ─────────────────────────────────────────────────────────────

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const NUM = new Intl.NumberFormat('pt-BR');

export const reais = (centavos) => BRL.format((centavos ?? 0) / 100);
export const numero = (n) => NUM.format(n ?? 0);
/** 5,1% — virgula decimal, como o resto do sistema. */
export const porcento = (n) => `${(n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

/** R$ 12,9 mil / R$ 1,2 mi — para eixos e blocos, onde o centavo e ruido. */
export function reaisCurto(centavos) {
  const v = (centavos ?? 0) / 100;
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (Math.abs(v) >= 10_000) return `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return BRL.format(v);
}

export function duracao(segundos) {
  if (segundos == null) return '—';
  if (segundos < 60) return `${segundos}s`;
  if (segundos < 3600) return `${Math.round(segundos / 60)} min`;
  return `${(segundos / 3600).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`;
}

// ─── Tooltip ───────────────────────────────────────────────────────────────

/** Tooltip que segue o mark (posicao relativa ao container do grafico). */
export function useTooltip() {
  const [tip, setTip] = useState(null);
  const mostrar = (evento, conteudo, container) => {
    const alvo = evento.currentTarget.getBoundingClientRect();
    const caixa = container.getBoundingClientRect();
    setTip({ x: alvo.left + alvo.width / 2 - caixa.left, y: alvo.top - caixa.top, conteudo, largura: caixa.width });
  };
  return { tip, mostrar, esconder: () => setTip(null) };
}

export function Tooltip({ tip }) {
  if (!tip) return null;
  // Perto das bordas, o balao "encosta" para dentro em vez de sair do cartao.
  const lado = tip.x < 110 ? 'esq' : tip.x > tip.largura - 110 ? 'dir' : 'meio';
  return (
    <div className={`gr-tip gr-tip--${lado}`} style={{ left: tip.x, top: tip.y }} role="status">
      {tip.conteudo}
    </div>
  );
}

/** Linha do tooltip: valor forte na frente, rotulo depois, chave em traco curto da cor. */
export function LinhaTip({ cor, valor, rotulo }) {
  return (
    <span className="gr-tip__linha">
      {cor && <span className="gr-tip__chave" style={{ background: cor }} aria-hidden="true" />}
      <strong>{valor}</strong>
      <span>{rotulo}</span>
    </span>
  );
}

export function Legenda({ itens }) {
  return (
    <div className="gr-legenda">
      {itens.map((i) => (
        <span key={i.rotulo} className="gr-legenda__item">
          <span className="gr-legenda__cor" style={{ background: i.cor }} aria-hidden="true" />
          {i.rotulo}
        </span>
      ))}
    </div>
  );
}

function useLargura() {
  const ref = useRef(null);
  const [largura, setLargura] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setLargura(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, largura];
}

/** Tiques "redondos" para o eixo Y: 0, 500, 1.000... */
function tiques(maximo, quantos = 4) {
  if (maximo <= 0) return [0];
  const bruto = maximo / quantos;
  const mag = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((p) => p >= bruto);
  const lista = [];
  for (let v = 0; v <= maximo + passo * 0.001; v += passo) lista.push(v);
  if (lista.at(-1) < maximo) lista.push(lista.at(-1) + passo);
  return lista;
}

// ─── Colunas empilhadas no tempo ───────────────────────────────────────────

/**
 * @param {object[]} dados     um item por coluna
 * @param {{chave:string, rotulo:string, cor:string}[]} series
 * @param {(item) => string} rotuloX
 * @param {(v:number) => string} formatar   valores (tooltip)
 * @param {(v:number) => string} formatarEixo
 */
/**
 * `incompleto(d)`: a coluna cobre so parte do balde (a semana ou o mes em que
 * o periodo comeca/termina). Ela fica esmaecida, para nao parecer uma queda.
 */
export function ColunasEmpilhadas({ dados, series, rotuloX, rotuloLongo, formatar, formatarEixo, altura = 240, incompleto }) {
  const [ref, largura] = useLargura();
  const { tip, mostrar, esconder } = useTooltip();

  const totais = dados.map((d) => series.reduce((s, se) => s + (d[se.chave] ?? 0), 0));
  const escala = tiques(Math.max(1, ...totais));
  const topo = escala.at(-1);

  const esq = 64;
  const baixo = 26;
  const alto = 10;
  const areaW = Math.max(0, largura - esq - 8);
  const areaH = altura - baixo - alto;
  const passo = dados.length ? areaW / dados.length : 0;
  const barra = Math.max(2, Math.min(24, passo - 2));
  const y = (v) => alto + areaH - (v / topo) * areaH;
  // Rotulos do eixo X sem encavalar: no maximo ~1 a cada 56px.
  const cada = Math.max(1, Math.ceil(56 / Math.max(passo, 1)));

  return (
    <div className="gr" ref={ref}>
      {largura > 0 && (
        <svg width={largura} height={altura} role="img" aria-label="Grafico de colunas">
          {escala.map((v) => (
            <g key={v}>
              <line x1={esq} x2={largura - 8} y1={y(v)} y2={y(v)} className="gr-grade" />
              <text x={esq - 8} y={y(v) + 4} className="gr-eixo" textAnchor="end">
                {formatarEixo(v)}
              </text>
            </g>
          ))}
          {dados.map((d, i) => {
            const x = esq + i * passo + (passo - barra) / 2;
            let acumulado = 0;
            const partes = series
              .map((se) => ({ se, v: d[se.chave] ?? 0 }))
              .filter((p) => p.v > 0);
            return (
              <g key={i} opacity={incompleto?.(d) ? 0.45 : undefined}>
                {partes.map(({ se, v }, j) => {
                  const y0 = y(acumulado);
                  acumulado += v;
                  const y1 = y(acumulado);
                  const ultima = j === partes.length - 1;
                  // 2px de "ar" entre segmentos empilhados; ponta arredondada so no topo.
                  const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0));
                  return ultima ? (
                    <path key={se.chave} d={colunaArredondada(x, y1, barra, h, 4)} fill={se.cor} />
                  ) : (
                    <rect key={se.chave} x={x} y={y1 + (j > 0 ? 2 : 0)} width={barra} height={h} fill={se.cor} />
                  );
                })}
                {i % cada === 0 && (
                  <text x={x + barra / 2} y={altura - 8} className="gr-eixo" textAnchor="middle">
                    {rotuloX(d)}
                  </text>
                )}
                {/* Alvo do mouse/teclado: a coluna inteira, bem maior que a marca. */}
                <rect
                  x={esq + i * passo}
                  y={alto}
                  width={passo}
                  height={areaH}
                  className="gr-alvo"
                  tabIndex={0}
                  onPointerEnter={(e) =>
                    mostrar(e, conteudoTip(d, series, formatar, rotuloLongo?.(d) ?? rotuloX(d)), ref.current)
                  }
                  onFocus={(e) => mostrar(e, conteudoTip(d, series, formatar, rotuloLongo?.(d) ?? rotuloX(d)), ref.current)}
                  onPointerLeave={esconder}
                  onBlur={esconder}
                />
              </g>
            );
          })}
          <line x1={esq} x2={largura - 8} y1={y(0)} y2={y(0)} className="gr-base" />
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

function conteudoTip(d, series, formatar, titulo) {
  const total = series.reduce((s, se) => s + (d[se.chave] ?? 0), 0);
  return (
    <>
      <span className="gr-tip__titulo">{titulo}</span>
      {series.length > 1 && <LinhaTip valor={formatar(total)} rotulo="total" />}
      {series.map((se) => (
        <LinhaTip key={se.chave} cor={se.cor} valor={formatar(d[se.chave] ?? 0)} rotulo={se.rotulo} />
      ))}
    </>
  );
}

function colunaArredondada(x, y, w, h, r) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

// ─── Barras horizontais (ranking) ──────────────────────────────────────────

/**
 * Uma barra por item, maior primeiro. `cor` unica (uma serie so = uma cor);
 * `corDe(item)` quando a cor ja identifica a entidade (a cor do profissional).
 */
export function BarrasH({ itens, valor, rotulo, formatar, detalhe, cor = 'var(--gr-s1)', corDe, vazio = 'Sem dados no período.' }) {
  const maximo = Math.max(0, ...itens.map(valor));
  if (!itens.length || maximo === 0) return <p className="gr-vazio">{vazio}</p>;
  return (
    <ul className="gr-barras">
      {itens.map((item, i) => {
        const v = valor(item);
        return (
          <li key={i} className="gr-barras__item" tabIndex={0} title={`${rotulo(item)}: ${formatar(v)}${detalhe ? ` · ${detalhe(item)}` : ''}`}>
            <span className="gr-barras__rotulo">{rotulo(item)}</span>
            <span className="gr-barras__trilho">
              <span className="gr-barras__barra" style={{ width: `${Math.max(1.5, (v / maximo) * 100)}%`, background: corDe?.(item) ?? cor }} />
            </span>
            <span className="gr-barras__valor">
              {formatar(v)}
              {detalhe && <small>{detalhe(item)}</small>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ─── Parte do todo (barra 100% empilhada) ──────────────────────────────────

export function BarraParte({ partes, formatar = numero }) {
  const total = partes.reduce((s, p) => s + p.valor, 0);
  if (total === 0) return <p className="gr-vazio">Sem dados no período.</p>;
  const visiveis = partes.filter((p) => p.valor > 0);
  return (
    <div className="gr-parte">
      <div className="gr-parte__barra" role="img" aria-label={visiveis.map((p) => `${p.rotulo}: ${formatar(p.valor)}`).join(', ')}>
        {visiveis.map((p) => (
          <span
            key={p.rotulo}
            className="gr-parte__seg"
            style={{ flexGrow: p.valor, background: p.cor }}
            title={`${p.rotulo}: ${formatar(p.valor)} (${Math.round((p.valor / total) * 100)}%)`}
          />
        ))}
      </div>
      <ul className="gr-parte__legenda">
        {partes.map((p) => (
          <li key={p.rotulo}>
            <span className="gr-legenda__cor" style={{ background: p.cor }} aria-hidden="true" />
            <span className="crescer">{p.rotulo}</span>
            <strong>{formatar(p.valor)}</strong>
            <small>{total ? Math.round((p.valor / total) * 100) : 0}%</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Medidor (proporcao contra um limite) ──────────────────────────────────

export function Medidor({ valor, rotulo }) {
  const v = Math.max(0, Math.min(100, valor ?? 0));
  const tom = v >= 85 ? 'cheio' : v >= 60 ? 'bom' : 'baixo';
  return (
    <span className="gr-medidor" title={rotulo}>
      <span className={`gr-medidor__barra gr-medidor__barra--${tom}`} style={{ width: `${v}%` }} />
    </span>
  );
}
