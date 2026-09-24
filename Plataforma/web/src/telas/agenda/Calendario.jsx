import { useMemo } from 'react';

const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

/** Primeiro e ultimo dia do mes de uma data AAAA-MM-DD. */
export function limitesDoMes(dataISO) {
  const [a, m] = dataISO.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const ultimo = new Date(a, m, 0).getDate();
  return { de: `${a}-${pad(m)}-01`, ate: `${a}-${pad(m)}-${pad(ultimo)}` };
}

/** Soma meses a uma data, caindo no dia 1 (evita "31 de fevereiro"). */
export function somarMeses(dataISO, n) {
  const [a, m] = dataISO.split('-').map(Number);
  const d = new Date(a, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/**
 * Grade do mes. Os agendamentos ja chegam com `data` no fuso da empresa,
 * entao aqui so agrupamos — nenhuma conta de fuso.
 */
export function Calendario({ mes, agendamentos, hoje, aoEscolherOS, aoEscolherDia }) {
  const porDia = useMemo(() => {
    const mapa = new Map();
    for (const a of agendamentos) {
      if (!mapa.has(a.data)) mapa.set(a.data, []);
      mapa.get(a.data).push(a);
    }
    return mapa;
  }, [agendamentos]);

  const celulas = useMemo(() => {
    const [ano, m] = mes.split('-').map(Number);
    const primeiroDiaSemana = new Date(ano, m - 1, 1).getDay();
    const total = new Date(ano, m, 0).getDate();
    const lista = Array.from({ length: primeiroDiaSemana }, () => null);
    for (let d = 1; d <= total; d++) {
      lista.push(`${ano}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    while (lista.length % 7 !== 0) lista.push(null);
    return lista;
  }, [mes]);

  return (
    <div className="calendario">
      {DIAS_SEMANA.map((d) => (
        <div key={d} className="calendario__semana">
          {d}
        </div>
      ))}
      {celulas.map((dia, i) => {
        if (!dia) return <div key={`v${i}`} className="calendario__dia calendario__dia--vazio" />;
        const doDia = porDia.get(dia) ?? [];
        return (
          <div key={dia} className={`calendario__dia${dia === hoje ? ' calendario__dia--hoje' : ''}`}>
            <button type="button" className="calendario__numero" onClick={() => aoEscolherDia(dia)}>
              {Number(dia.slice(8))}
            </button>
            {doDia.slice(0, 3).map((a) => (
              <button
                key={a.id}
                type="button"
                className={`calendario__os calendario__os--${a.status}`}
                style={{ borderLeftColor: a.profissionalCor }}
                onClick={() => aoEscolherOS(a.id)}
                title={`${a.horaInicio} · ${a.leadNome} · ${a.servicoNome}`}
              >
                <span className="mono">{a.horaInicio}</span> {a.leadNome}
              </button>
            ))}
            {doDia.length > 3 && (
              <button type="button" className="calendario__mais" onClick={() => aoEscolherDia(dia)}>
                +{doDia.length - 3} mais
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
