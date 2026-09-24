import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import './AvisoUrgente.css';

/**
 * Aviso da gerencia: abre por cima de TUDO e pisca ate a pessoa confirmar.
 *
 * Diferente do modal comum, nao fecha clicando fora, nem no Esc, nem num "x":
 * o unico caminho e o botao "Entendi", que grava no servidor a hora em que a
 * pessoa confirmou. Se chegarem varios, aparecem um de cada vez, do mais
 * antigo para o mais novo, com a contagem do que ainda falta.
 *
 * O tempo real so avisa "chegou aviso" (a lista e buscada pela API); o
 * polling e a rede de seguranca para a conexao que caiu.
 */

const hora = (instante) =>
  new Date(instante).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Tres bipes curtos. O navegador pode recusar som antes do primeiro clique na pagina: tudo bem, o visual basta. */
function tocarAlerta() {
  try {
    const Contexto = window.AudioContext || window.webkitAudioContext;
    if (!Contexto) return;
    const ctx = new Contexto();
    [0, 0.25, 0.5].forEach((inicio) => {
      const osc = ctx.createOscillator();
      const ganho = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      ganho.gain.setValueAtTime(0.08, ctx.currentTime + inicio);
      ganho.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + inicio + 0.18);
      osc.connect(ganho).connect(ctx.destination);
      osc.start(ctx.currentTime + inicio);
      osc.stop(ctx.currentTime + inicio + 0.2);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1200);
  } catch {
    // Sem som: segue so com o visual.
  }
}

export function AvisoUrgente() {
  const queryClient = useQueryClient();
  const botaoRef = useRef(null);
  const ultimoTocado = useRef(null);

  const { data } = useQuery({
    queryKey: ['avisos', 'pendentes'],
    queryFn: () => api.get('/api/avisos/pendentes'),
    refetchInterval: 30_000
  });

  const confirmar = useMutation({
    mutationFn: (id) => api.post(`/api/avisos/${id}/lido`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['avisos', 'pendentes'] })
  });

  const avisos = data?.avisos ?? [];
  const aviso = avisos[0];
  const restantes = avisos.length - 1;

  // Som e foco a cada aviso novo que assume a tela.
  useEffect(() => {
    if (!aviso || ultimoTocado.current === aviso.id) return;
    ultimoTocado.current = aviso.id;
    tocarAlerta();
    botaoRef.current?.focus();
  }, [aviso]);

  // Enquanto houver aviso: a aba pisca o titulo (quem esta em outra aba ve)
  // e o resto do sistema fica `inert` — o Tab nao escapa para tras do aviso.
  const temAviso = Boolean(aviso);
  useEffect(() => {
    if (!temAviso) return undefined;
    const tituloOriginal = document.title;
    const raiz = document.getElementById('raiz');
    raiz?.setAttribute('inert', '');

    let alterna = false;
    const timer = setInterval(() => {
      alterna = !alterna;
      document.title = alterna ? '⚠ AVISO DA GERÊNCIA' : tituloOriginal;
    }, 1000);
    return () => {
      clearInterval(timer);
      document.title = tituloOriginal;
      raiz?.removeAttribute('inert');
    };
  }, [temAviso]);

  if (!aviso) return null;

  return createPortal(
    <div className="aviso-urgente" role="presentation">
      <div
        className="aviso-urgente__caixa"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="aviso-urgente-titulo"
        aria-describedby="aviso-urgente-mensagem"
      >
        <div className="aviso-urgente__faixa">
          <span className="aviso-urgente__icone" aria-hidden="true">!</span>
          <div>
            <div id="aviso-urgente-titulo" className="aviso-urgente__titulo">Aviso da gerência</div>
            <div className="aviso-urgente__origem">
              De <strong>{aviso.deNome}</strong> · {hora(aviso.createdAt)}
            </div>
          </div>
        </div>

        <p id="aviso-urgente-mensagem" className="aviso-urgente__mensagem">
          {aviso.mensagem}
        </p>

        <div className="aviso-urgente__rodape">
          <span className="aviso-urgente__restantes">
            {restantes > 0 ? `Mais ${restantes} aviso${restantes > 1 ? 's' : ''} depois deste` : ''}
          </span>
          <button
            ref={botaoRef}
            type="button"
            className="aviso-urgente__entendi"
            disabled={confirmar.isPending}
            onClick={() => confirmar.mutate(aviso.id)}
          >
            {confirmar.isPending ? 'Confirmando...' : 'Entendi'}
          </button>
        </div>
        {confirmar.isError && (
          <p className="aviso-urgente__erro" role="alert">
            Não foi possível confirmar agora. Tente de novo.
          </p>
        )}
      </div>
    </div>,
    document.body
  );
}
