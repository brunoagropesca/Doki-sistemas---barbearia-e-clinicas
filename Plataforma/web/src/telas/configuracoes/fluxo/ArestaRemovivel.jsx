import { useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow } from '@xyflow/react';

/**
 * Ligacao entre dois passos: curva suave que acende ao passar o mouse e
 * mostra um "×" no meio para desligar — como no n8n.
 */
export function ArestaRemovivel({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }) {
  const { deleteElements } = useReactFlow();
  const [sobre, setSobre] = useState(false);
  const [caminho, meioX, meioY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const ativa = sobre || selected;

  return (
    <>
      <BaseEdge path={caminho} className={`aresta${ativa ? ' aresta--ativa' : ''}`} />
      {/* Faixa larga e invisivel: acertar uma linha de 2px com o mouse e dificil. */}
      <path
        d={caminho}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        onMouseEnter={() => setSobre(true)}
        onMouseLeave={() => setSobre(false)}
      />
      {ativa && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="aresta__remover nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${meioX}px, ${meioY}px)` }}
            onMouseEnter={() => setSobre(true)}
            onMouseLeave={() => setSobre(false)}
            onClick={() => deleteElements({ edges: [{ id }] })}
            aria-label="Desligar"
            title="Desligar"
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
