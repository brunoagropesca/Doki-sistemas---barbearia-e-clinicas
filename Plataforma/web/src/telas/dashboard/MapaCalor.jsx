import { useRef, useState } from 'react';
import { numero, reais, reaisCurto, Tooltip, useTooltip, LinhaTip } from './Graficos.jsx';

/**
 * Mapa de calor: dia da semana x hora.
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
/** Rampa sequencial azul, do fundo (pouco) ao claro (muito). 6 degraus. */
const RAMPA = ['#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb'];

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

export function MapaCalor({ calor, detalhado = false, metricaInicial = 'atendimentos' }) {
  const [metrica, setMetrica] = useState(metricaInicial);
  const ref = useRef(null);
  const { tip, mostrar, esconder } = useTooltip();

  const m = METRICAS_CALOR.find((x) => x.chave === metrica);
  const dados = calor[metrica];
  const horas = faixaDeHoras(dados);
  const maximo = Math.max(0, ...dados.flat());
  const porDia = calor.porDiaSemana[metrica];
  const porHora = calor.porHora[metrica];
  const maxDia = Math.max(0, ...porDia);
  const maxHora = Math.max(0, ...horas.map((h) => porHora[h]));
  const total = porDia.reduce((s, v) => s + v, 0);
  const pico = calor.picos[metrica];
  const fmtCurto = m.curto ?? m.formatar;

  const dica = (d, h, v) => (
    <>
      <span className="gr-tip__titulo">
        {DIA[d]}, {hh(h)}–{hh(h + 1)}
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
              onClick={() => setMetrica(x.chave)}
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

      {total === 0 ? (
        <p className="gr-vazio">Nada de {m.rotulo.toLowerCase()} neste período.</p>
      ) : (
        <>
          <div className="mc-area" ref={ref}>
            <div className="mc-grade" style={{ '--horas': horas.length }} role="grid" aria-label={`Mapa de calor: ${m.rotulo} por dia e hora`}>
              <span />
              {horas.map((h) => (
                // Hora impar some no celular (CSS), onde o rotulo nao cabe em toda coluna.
                <span key={h} className={`mc-hora${h % 2 ? ' mc-hora--impar' : ''}`}>
                  {hh(h)}
                </span>
              ))}
              <span className="mc-hora mc-hora--total">Total</span>

              {ORDEM.map((d) => (
                <div key={d} className="mc-linha" role="row">
                  <span className="mc-dia">{DIA_CURTO[d]}</span>
                  {horas.map((h) => {
                    const v = dados[d][h];
                    const g = degrau(v, maximo);
                    const ehPico = pico && pico.dia === d && pico.hora === h;
                    return (
                      <span
                        key={h}
                        role="gridcell"
                        tabIndex={0}
                        aria-label={`${DIA[d]} ${hh(h)}: ${m.formatar(v)}`}
                        className={`mc-cel${g === null ? ' mc-cel--vazia' : ''}${ehPico ? ' mc-cel--pico' : ''}`}
                        style={g === null ? undefined : { background: RAMPA[g] }}
                        onPointerEnter={(e) => mostrar(e, dica(d, h, v), ref.current)}
                        onFocus={(e) => mostrar(e, dica(d, h, v), ref.current)}
                        onPointerLeave={esconder}
                        onBlur={esconder}
                      />
                    );
                  })}
                  <span className="mc-total" title={`${DIA[d]}: ${m.formatar(porDia[d])}`}>
                    <span className="mc-total__barra" style={{ width: `${maxDia ? (porDia[d] / maxDia) * 100 : 0}%` }} />
                    <span className="mc-total__valor">{fmtCurto(porDia[d])}</span>
                  </span>
                </div>
              ))}

              {detalhado && (
                <div className="mc-linha mc-linha--horas" role="row">
                  <span className="mc-dia">Total</span>
                  {horas.map((h) => (
                    <span key={h} className="mc-coluna" title={`${hh(h)}: ${m.formatar(porHora[h])}`}>
                      <span className="mc-coluna__barra" style={{ height: `${maxHora ? (porHora[h] / maxHora) * 100 : 0}%` }} />
                    </span>
                  ))}
                  <span />
                </div>
              )}
            </div>
            <Tooltip tip={tip} />
          </div>

          {detalhado && <Leituras metrica={m} porDia={porDia} porHora={porHora} horas={horas} pico={pico} total={total} />}
        </>
      )}
    </div>
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
