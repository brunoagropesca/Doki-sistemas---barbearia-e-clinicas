import { Etiqueta } from '../../componentes/ui.jsx';
import { estadoDaSessao } from './formatar.js';

/**
 * Mostra em que pe esta uma sessao.
 *
 * A bolinha colorida e so enfeite (aria-hidden): quem le a tela sem enxergar
 * cores, ou nao distingue verde de vermelho, tem o estado por extenso ao lado.
 */

/** Bolinha + texto. Usada na lista de sessoes, onde falta espaco para a etiqueta. */
export function EstadoSessao({ canal }) {
  const estado = estadoDaSessao(canal);

  return (
    <span className="cx-estado">
      <span
        className={`cx-ponto cx-ponto--${estado.tom} ${estado.emAndamento ? 'cx-ponto--pulsando' : ''}`}
        aria-hidden="true"
      />
      <span>{estado.rotulo}</span>
    </span>
  );
}

/** Etiqueta em forma de pilula, para o topo do painel da sessao. */
export function EtiquetaSessao({ canal }) {
  const estado = estadoDaSessao(canal);
  return <Etiqueta tom={estado.tom}>{estado.rotulo}</Etiqueta>;
}
