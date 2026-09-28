import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { numero, reais, reaisCurto, Tooltip, useTooltip, LinhaTip } from './Graficos.jsx';
import { useAnimarDashboard } from './animacao.js';

/**
 * Mapa de calor: dia da semana x hora (e, pela seta do titulo, mes e ano).
 *
 * Uma cor so (azul), do fundo ao claro: quanto mais claro, mais movimento.
 * Celula vazia e o proprio fundo — "nada aconteceu" nao pode parecer "pouco".
 * Nas margens, o total de cada dia (a direita) e de cada hora (embaixo), para
 * responder "qual o melhor dia?" e "qual a melhor hora?" sem somar de cabeca.
 */

export const METRICAS_CALOR = [
  { chave: 'atendimentos', rotulo: 'Atendimentos', formatar: numero, unidade: 'atendimentos' },
  { chave: 'faturamento', rotulo: 'Faturamento', formatar: reais, curto: reaisCurto, unidade: '' },
  { chave: 'mensagens', rotulo: 'Mensagens de clientes', formatar: numero, unidade: 'mensagens' },
  { chave: 'vendas', rotulo: 'Produtos vendidos', formatar: numero, unidade: 'itens' },
  { chave: 'faltas', rotulo: 'Faltas e cancelamentos', formatar: numero, unidade: 'faltas/cancelamentos' }
];

// Ordem da semana da barbearia: segunda primeiro.
const ORDEM = [1, 2, 3, 4, 5, 6, 0];
const DIA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const DIA_CURTO = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
/**
 * Rampa sequencial de 6 degraus (pouco -> muito). As cores vem do TEMA
 * (--mc-1..--mc-6 em Dashboard.css): azul no medio, calor de sol no claro,
 * brasa no full black.
 */
const RAMPA = [1, 2, 3, 4, 5, 6].map((i) => `var(--mc-${i})`);
/** Do 4o degrau para cima a celula brilha; no ultimo, o brilho "respira". */
const DEGRAU_QUENTE = 3;

function degrau(v, maximo) {
  if (!v || !maximo) return null;
  return Math.min(RAMPA.length - 1, Math.floor((v / maximo) * RAMPA.length));
}

/**
 * Faixa de horas mostrada: onde a metrica ESCOLHIDA teve movimento, nunca
 * menor que 8h–20h. (Somando todas, as mensagens da madrugada abriam 24
 * colunas no mapa de atendimentos, metade sempre vazia.)
 */
function faixaDeHoras(matriz) {
  let min = 8;
  let max = 20;
  (matriz ?? []).forEach((linha) =>
    linha.forEach((v, h) => {
      if (v > 0) {
        min = Math.min(min, h);
        max = Math.max(max, h);
      }
    })
  );
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

const hh = (h) => `${String(h).padStart(2, '0')}h`;

/**
 * As tres "regras" do mapa (seta ao lado do titulo):
 *   semana — dia da semana x hora (que horas enchem);
 *   mes    — semana do mes x dia da semana (o comeco do mes, do salario, enche mais?);
 *   ano    — mes x dia da semana (qual epoca do ano e mais forte, e em que dias).
 * Mes e ano vem prontos da API (`calor.visoes`).
 */
export const VISOES_CALOR = [
  { chave: 'semana', rotulo: 'da semana' },
  { chave: 'mes', rotulo: 'do mês' },
  { chave: 'ano', rotulo: 'do ano' }
];
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

/** Titulo do bloco com a seta que troca a regra do mapa (semana -> mes -> ano). */
export function TituloCalor({ visao, aoTrocar, prefixo = 'Mapa de calor' }) {
  const i = VISOES_CALOR.findIndex((v) => v.chave === visao);
  const proxima = VISOES_CALOR[(i + 1) % VISOES_CALOR.length];
  return (
    <span className="mc-titulo">
      {prefixo}{' '}
      {/* key: a palavra nova entra deslizando a cada troca. */}
      <span key={visao} className="mc-titulo__visao">
        {VISOES_CALOR[i].rotulo}
      </span>
      <button
        type="button"
        className="mc-seta"
        onClick={() => aoTrocar(proxima.chave)}
        aria-label={`Ver o mapa de calor ${proxima.rotulo}`}
        title={`Ver ${proxima.rotulo}`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </span>
  );
}

/**
 * Linhas, colunas e valores da regra escolhida, num formato so: a grade
 * abaixo desenha qualquer uma das tres do mesmo jeito.
 */
function montarModelo(calor, metrica, visao) {
  const v = visao !== 'semana' ? calor.visoes?.[visao] : null;
  if (!v) {
    const dados = calor[metrica];
    const p = calor.picos[metrica];
    return {
      linhas: ORDEM.map((d) => ({ i: d, curto: DIA_CURTO[d], longo: DIA[d] })),
      colunas: faixaDeHoras(dados).map((h) => ({ i: h, curto: hh(h), longo: `${hh(h)}–${hh(h + 1)}`, impar: h % 2 === 1 })),
      valor: (l, c) => dados[l][c],
      totalLinha: calor.porDiaSemana[metrica],
      totalColuna: calor.porHora[metrica],
      pico: p ? { linha: p.dia, coluna: p.hora, valor: p.valor } : null,
      descricao: 'por dia e hora'
    };
  }
  return {
    linhas: v.linhas.map((rotulo, i) => ({ i, curto: rotulo, longo: visao === 'mes' ? `Dias ${rotulo}` : MESES[i] })),
    colunas: ORDEM.map((d) => ({ i: d, curto: DIA_CURTO[d], longo: DIA[d] })),
    valor: (l, c) => v[metrica][l][c],
    totalLinha: v.porLinha[metrica],
    totalColuna: v.porColuna[metrica],
    pico: v.picos[metrica],
    descricao: visao === 'mes' ? 'por semana do mês e dia da semana' : 'por mês e dia da semana'
  };
}

/** Dias que o periodo precisa ter para a regra mostrar o ciclo inteiro. */
const CICLO_DIAS = { mes: 28, ano: 360 };

export function MapaCalor({ calor, detalhado = false, metricaInicial = 'atendimentos', visao = 'semana', diasPeriodo = null }) {
  const [metrica, setMetrica] = useState(metricaInicial);
  // Ja trocou de metrica ou de regra: a proxima montagem comeca na hora, sem
  // esperar a cascata da entrada da pagina (o --b do bloco).
  const [trocou, setTrocou] = useState(false);
  const visaoInicial = useRef(visao);
  if (!trocou && visao !== visaoInicial.current) setTrocou(true);
  const ref = useRef(null);
  const { tip, mostrar, esconder } = useTooltip();
  const corpo = useAlturaSuave();
  const fase = useFaseDeMontagem(`${visao}-${metrica}`, useAnimarDashboard());

  const m = METRICAS_CALOR.find((x) => x.chave === metrica);
  const modelo = useMemo(() => montarModelo(calor, metrica, visao), [calor, metrica, visao]);
  const { linhas, colunas, valor, totalLinha, totalColuna, pico } = modelo;
  const maximo = Math.max(0, ...linhas.flatMap((l) => colunas.map((c) => valor(l.i, c.i))));
  const maxLinha = Math.max(0, ...linhas.map((l) => totalLinha[l.i]));
  const maxColuna = Math.max(0, ...colunas.map((c) => totalColuna[c.i]));
  const total = linhas.reduce((s, l) => s + totalLinha[l.i], 0);
  const fmtCurto = m.curto ?? m.formatar;
  const cicloCurto = CICLO_DIAS[visao] && diasPeriodo && diasPeriodo < CICLO_DIAS[visao];

  /**
   * Ordem de montagem (animacoes do Dashboard): do bloco mais QUENTE para o
   * mais frio. `rank` e a posicao de cada celula nessa fila; as vazias entram
   * juntas, por ultimo. O passo entre celulas se ajusta a quantidade, para a
   * montagem durar ~0,7 s em qualquer metrica e regra.
   */
  const { rank, passoMs } = useMemo(() => {
    const comValor = [];
    linhas.forEach((l) => colunas.forEach((c) => { const v = valor(l.i, c.i); if (v > 0) comValor.push({ chave: `${l.i}-${c.i}`, v }); }));
    comValor.sort((a, b) => b.v - a.v);
    const posicao = new Map(comValor.map((c, i) => [c.chave, i]));
    return {
      rank: (l, c) => posicao.get(`${l}-${c}`) ?? comValor.length,
      passoMs: Math.min(40, Math.max(4, 700 / Math.max(1, comValor.length)))
    };
  }, [linhas, colunas, valor]);

  const dica = (l, c, v) => (
    <>
      <span className="gr-tip__titulo">
        {visao === 'semana' ? `${l.longo}, ${c.longo}` : `${l.longo} · ${c.longo}`}
      </span>
      <LinhaTip valor={m.formatar(v)} rotulo={m.unidade} />
      {total > 0 && <span className="gr-tip__nota">{Math.round((v / total) * 100)}% do período</span>}
    </>
  );

  return (
    <div className="mc">
      <div className="mc-topo">
        <div className="mc-metricas" role="group" aria-label="O que o mapa mostra">
          {METRICAS_CALOR.map((x) => (
            <button
              key={x.chave}
              type="button"
              aria-pressed={metrica === x.chave}
              className={`eq-chip${metrica === x.chave ? ' eq-chip--ativo' : ''}`}
              onClick={() => {
                setMetrica(x.chave);
                setTrocou(true);
              }}
            >
              {x.rotulo}
            </button>
          ))}
        </div>
        <div className="mc-escala" aria-hidden="true">
          <span>menos</span>
          <span className="mc-escala__vazio" />
          {RAMPA.map((c) => (
            <span key={c} style={{ background: c }} />
          ))}
          <span>mais</span>
        </div>
      </div>

      {/* Envelope que desliza entre as alturas: semana (7 linhas), mes (5) e
          ano (12) tem tamanhos diferentes, e o cartao nao pode "pular". */}
      <div className={`mc-corpo${corpo.animando ? ' mc-corpo--animando' : ''}`} style={corpo.estilo} onTransitionEnd={corpo.aoTerminar}>
      <div ref={corpo.ref}>
      {cicloCurto && (
        <p className="mc-aviso">
          O período escolhido tem {diasPeriodo} dias: só aparece o que cabe nele. Para ver {visao === 'ano' ? 'o ano inteiro, escolha "12 meses"' : 'o mês inteiro, escolha 30 dias ou mais'} no topo.
        </p>
      )}

      {total === 0 ? (
        <p className="gr-vazio">Nada de {m.rotulo.toLowerCase()} neste período.</p>
      ) : (
        <>
          <div className="mc-area" ref={ref}>
            {/* key: trocar a metrica ou a regra recria a grade, e a montagem toca de novo. */}
            <div
              key={`${visao}-${metrica}`}
              className={`mc-grade mc-grade--${visao} mc-grade--${fase}`}
              style={{ '--horas': colunas.length, '--passo': `${passoMs}ms`, ...(trocou ? { '--b': '0ms' } : {}) }}
              role="grid"
              aria-label={`Mapa de calor: ${m.rotulo} ${modelo.descricao}`}
            >
              <span />
              {colunas.map((c, ci) => (
                // Hora impar some no celular (CSS), onde o rotulo nao cabe em toda coluna.
                // --c: ordem da coluna, para o "andaime" entrar em sequencia.
                <span key={c.i} className={`mc-hora${c.impar ? ' mc-hora--impar' : ''}`} style={{ '--c': ci }}>
                  {c.curto}
                </span>
              ))}
              <span className="mc-hora mc-hora--total">Total</span>

              {linhas.map((l, li) => (
                // --l: ordem da linha (rotulo e total entram em sequencia).
                <div key={l.i} className="mc-linha" role="row" style={{ '--l': li }}>
                  <span className="mc-dia">{l.curto}</span>
                  {colunas.map((c, ci) => {
                    const v = valor(l.i, c.i);
                    const g = degrau(v, maximo);
                    const ehPico = pico && pico.linha === l.i && pico.coluna === c.i;
                    return (
                      <span
                        key={c.i}
                        role="gridcell"
                        tabIndex={0}
                        aria-label={`${l.longo} ${c.longo}: ${m.formatar(v)}`}
                        className={`mc-cel${g === null ? ' mc-cel--vazia' : ''}${g !== null && g >= DEGRAU_QUENTE ? ' mc-cel--quente' : ''}${g === RAMPA.length - 1 ? ' mc-cel--brasa' : ''}${ehPico ? ' mc-cel--pico' : ''}`}
                        // --o: posicao na fila do mais quente ao mais frio (ver `rank`).
                        style={{ ...(g === null ? {} : { '--cor': RAMPA[g], '--calor': g }), '--o': rank(l.i, c.i), '--pos': li + ci }}
                        onPointerEnter={(e) => mostrar(e, dica(l, c, v), ref.current)}
                        onFocus={(e) => mostrar(e, dica(l, c, v), ref.current)}
                        onPointerLeave={esconder}
                        onBlur={esconder}
                      />
                    );
                  })}
                  <span className="mc-total" title={`${l.longo}: ${m.formatar(totalLinha[l.i])}`}>
                    <span className="mc-total__barra" style={{ width: `${maxLinha ? (totalLinha[l.i] / maxLinha) * 100 : 0}%` }} />
                    <span className="mc-total__valor">{fmtCurto(totalLinha[l.i])}</span>
                  </span>
                </div>
              ))}

              {detalhado && (
                <div className="mc-linha mc-linha--horas" role="row">
                  <span className="mc-dia">Total</span>
                  {colunas.map((c) => (
                    <span key={c.i} className="mc-coluna" title={`${c.longo}: ${m.formatar(totalColuna[c.i])}`}>
                      <span className="mc-coluna__barra" style={{ height: `${maxColuna ? (totalColuna[c.i] / maxColuna) * 100 : 0}%` }} />
                    </span>
                  ))}
                  <span />
                </div>
              )}
            </div>
            <Tooltip tip={tip} />
          </div>

          {detalhado &&
            (visao === 'semana' ? (
              <Leituras
                metrica={m}
                porDia={totalLinha}
                porHora={totalColuna}
                horas={colunas.map((c) => c.i)}
                pico={calor.picos[metrica]}
                total={total}
              />
            ) : (
              <LeiturasDoCiclo metrica={m} modelo={modelo} visao={visao} total={total} />
            ))}
        </>
      )}
      </div>
      </div>
    </div>
  );
}

/**
 * Fases da montagem do mapa a cada troca de regra ou metrica (so com as
 * animacoes do Dashboard ligadas):
 *   'vazio'    — o "andaime": rotulos e celulas surgem SEM cor;
 *   'enchendo' — a cor e o brilho escorrem para dentro das celulas, do mais
 *                quente ao mais frio (transicao de cor com atraso por --o);
 *   'pronto'   — tudo normal (o hover volta a responder na hora).
 * Desligadas: 'pronto' direto.
 */
function useFaseDeMontagem(chave, animar) {
  const [fase, setFase] = useState(animar ? 'vazio' : 'pronto');
  useLayoutEffect(() => {
    if (!animar) {
      setFase('pronto');
      return undefined;
    }
    setFase('vazio');
    let quadro = requestAnimationFrame(() => {
      // Dois quadros: o navegador precisa PINTAR o vazio antes, senao a
      // transicao de cor nao acontece.
      quadro = requestAnimationFrame(() => setFase('enchendo'));
    });
    const fim = setTimeout(() => setFase('pronto'), 2200);
    return () => {
      cancelAnimationFrame(quadro);
      clearTimeout(fim);
    };
  }, [chave, animar]);
  return fase;
}

/**
 * Altura que acompanha o conteudo DESLIZANDO: mede o conteudo (ResizeObserver)
 * e poe essa altura no envelope, que tem transicao de altura no CSS. Enquanto
 * desliza, o envelope corta o que transborda (senao o mapa maior passaria por
 * cima do bloco de baixo); ao terminar, volta a mostrar tudo — o brilho das
 * celulas e o balao da dica precisam sair da caixa.
 */
function useAlturaSuave() {
  const ref = useRef(null);
  const [altura, setAltura] = useState(null);
  const [animando, setAnimando] = useState(false);
  const anterior = useRef(null);
  const trava = useRef(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const medir = () => {
      const h = el.offsetHeight;
      if (anterior.current !== null && Math.abs(h - anterior.current) > 1) {
        setAnimando(true);
        // Seguranca: sem transicao (ex.: "reduzir movimento") o transitionend
        // nao chega, e o envelope ficaria cortando o brilho para sempre.
        clearTimeout(trava.current);
        trava.current = setTimeout(() => setAnimando(false), 700);
      }
      anterior.current = h;
      setAltura(h);
    };
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(el);
    return () => {
      observador.disconnect();
      clearTimeout(trava.current);
    };
  }, []);

  return {
    ref,
    animando,
    estilo: altura === null ? undefined : { height: altura },
    aoTerminar: (e) => {
      if (e.target === e.currentTarget && e.propertyName === 'height') setAnimando(false);
    }
  };
}

/** Leituras do mes e do ano: o pico, a parte do ciclo mais forte e o melhor dia da semana. */
function LeiturasDoCiclo({ metrica, modelo, visao, total }) {
  const { linhas, colunas, totalLinha, totalColuna, pico } = modelo;
  const f = metrica.curto ?? metrica.formatar;
  const melhorLinha = [...linhas].sort((a, b) => totalLinha[b.i] - totalLinha[a.i])[0];
  const melhorColuna = [...colunas].sort((a, b) => totalColuna[b.i] - totalColuna[a.i])[0];
  const comMovimento = linhas.filter((l) => totalLinha[l.i] > 0);
  const piorLinha = comMovimento.length > 1 ? [...comMovimento].sort((a, b) => totalLinha[a.i] - totalLinha[b.i])[0] : null;
  const pct = (v) => `${Math.round((v / total) * 100)}%`;
  const nomeLinha = visao === 'mes' ? 'Semana do mês mais forte' : 'Mês mais forte';
  const itens = [
    pico && ['Pico', `${linhas.find((l) => l.i === pico.linha)?.longo} · ${colunas.find((c) => c.i === pico.coluna)?.longo} — ${metrica.formatar(pico.valor)}`],
    [nomeLinha, `${melhorLinha.longo} (${pct(totalLinha[melhorLinha.i])}, ${f(totalLinha[melhorLinha.i])})`],
    piorLinha && [visao === 'mes' ? 'Semana mais fraca' : 'Mês mais fraco', `${piorLinha.longo} (${f(totalLinha[piorLinha.i])})`],
    ['Dia da semana mais forte', `${melhorColuna.longo} (${pct(totalColuna[melhorColuna.i])})`]
  ].filter(Boolean);
  return (
    <dl className="mc-leituras">
      {itens.map(([t, v]) => (
        <div key={t}>
          <dt>{t}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Frases de leitura: o que o mapa diz, por escrito. O dono nao precisa
 * interpretar as cores para saber o melhor dia, o pico e onde sobra agenda.
 */
function Leituras({ metrica, porDia, porHora, horas, pico, total }) {
  const dias = ORDEM.map((d) => ({ d, v: porDia[d] }));
  const melhorDia = [...dias].sort((a, b) => b.v - a.v)[0];
  const abertos = dias.filter((x) => x.v > 0);
  const piorDia = abertos.length > 1 ? [...abertos].sort((a, b) => a.v - b.v)[0] : null;

  // As 3 horas seguidas com mais movimento.
  let janela = null;
  for (let i = 0; i + 2 < horas.length; i++) {
    const soma = porHora[horas[i]] + porHora[horas[i + 1]] + porHora[horas[i + 2]];
    if (!janela || soma > janela.soma) janela = { de: horas[i], ate: horas[i + 2] + 1, soma };
  }
  const manha = horas.filter((h) => h < 12).reduce((s, h) => s + porHora[h], 0);
  const tarde = horas.filter((h) => h >= 12 && h < 18).reduce((s, h) => s + porHora[h], 0);
  const noite = horas.filter((h) => h >= 18).reduce((s, h) => s + porHora[h], 0);
  const turnos = [
    ['manhã', manha],
    ['tarde', tarde],
    ['noite', noite]
  ].sort((a, b) => b[1] - a[1]);

  const f = metrica.curto ?? metrica.formatar;
  const itens = [
    pico && ['Pico', `${DIA[pico.dia]} às ${hh(pico.hora)} — ${metrica.formatar(pico.valor)}`],
    ['Dia mais forte', `${DIA[melhorDia.d]} (${Math.round((melhorDia.v / total) * 100)}% do período, ${f(melhorDia.v)})`],
    piorDia && ['Dia mais fraco', `${DIA[piorDia.d]} (${f(piorDia.v)}) — bom dia para promoção`],
    janela && janela.soma > 0 && ['Janela mais cheia', `${hh(janela.de)} às ${hh(janela.ate)} (${Math.round((janela.soma / total) * 100)}% do movimento)`],
    turnos[0][1] > 0 && ['Turno principal', `${turnos[0][0]} (${Math.round((turnos[0][1] / total) * 100)}%)`]
  ].filter(Boolean);

  return (
    <dl className="mc-leituras">
      {itens.map(([t, v]) => (
        <div key={t}>
          <dt>{t}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
