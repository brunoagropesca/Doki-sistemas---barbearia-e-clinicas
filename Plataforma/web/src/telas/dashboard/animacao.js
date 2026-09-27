import { createContext, useContext, useEffect, useRef, useState } from 'react';

/**
 * Animacoes de entrada do Dashboard: a pagina "se monta" enquanto se entra
 * nela — cartoes se encaixam, numeros contam, colunas crescem, o mapa de
 * calor acende. Tudo em CSS (Dashboard.css, bloco `.dash--animar`), menos a
 * contagem dos numeros, que e daqui.
 *
 * Um botao no topo do Dashboard desliga (so as DELE; as do resto do sistema
 * nao mudam). A escolha fica no navegador. Quem pediu ao sistema operacional
 * para reduzir movimento comeca com elas desligadas.
 */

const CHAVE = 'dashboard.animacoes';

function lerPreferencia() {
  try {
    const salvo = localStorage.getItem(CHAVE);
    if (salvo === '0') return false;
    if (salvo === '1') return true;
  } catch {
    // sem armazenamento: cai no padrao abaixo
  }
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function usePreferenciaAnimar() {
  const [animar, setAnimar] = useState(lerPreferencia);
  function alternar() {
    setAnimar((a) => {
      try {
        localStorage.setItem(CHAVE, a ? '0' : '1');
      } catch {
        // vale so nesta visita
      }
      return !a;
    });
  }
  return [animar, alternar];
}

/** Os blocos do Dashboard sabem se devem animar sem receber isso por props. */
export const AnimarDashboard = createContext(false);
export const useAnimarDashboard = () => useContext(AnimarDashboard);

const DURACAO_MS = 900;
const suavizar = (t) => 1 - (1 - t) ** 3; // rapido no comeco, assenta no fim

/**
 * Numero que "conta" ate o alvo: do zero na primeira vez, e do valor anterior
 * quando o periodo muda (os numeros andam ate os novos em vez de trocar de
 * repente). Um `requestAnimationFrame` so por numero, ~1 s, e acabou.
 * Desligado: devolve o alvo direto.
 */
export function useContagem(alvo, ligado, { atrasoMs = 0 } = {}) {
  const [valor, setValor] = useState(ligado ? 0 : alvo);
  const deOnde = useRef(ligado ? 0 : alvo);

  useEffect(() => {
    if (!ligado || typeof alvo !== 'number' || !Number.isFinite(alvo)) {
      setValor(alvo);
      deOnde.current = alvo;
      return undefined;
    }
    const inicio = deOnde.current ?? 0;
    let quadro;
    let comeco = null;
    const passo = (agora) => {
      if (comeco === null) comeco = agora + atrasoMs;
      const t = Math.min(1, Math.max(0, (agora - comeco) / DURACAO_MS));
      const atual = inicio + (alvo - inicio) * suavizar(t);
      setValor(atual);
      deOnde.current = atual;
      if (t < 1) quadro = requestAnimationFrame(passo);
    };
    quadro = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(quadro);
  }, [alvo, ligado, atrasoMs]);

  return valor;
}
