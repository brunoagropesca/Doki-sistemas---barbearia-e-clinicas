import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import './NotificacoesAtendimento.css';

/**
 * "A IA passou um cliente para voce" — cartoes no canto da tela.
 *
 *   COMUM   — azul; some sozinho em alguns segundos, ou no "x".
 *   URGENTE — cliente frustrado; vermelho, pulsando, SEM "x" e sem sumir
 *             sozinho. So sai com "Atender" (ou quando alguem atende a
 *             conversa). Enquanto houver um, o bipe se repete de tempos em
 *             tempos: cliente irritado esperando nao pode passar batido.
 *
 * Clicar em "Atender" assume a conversa e abre ela no livechat.
 */

const SOME_EM_MS = 15_000;
const REPETIR_BIPE_URGENTE_MS = 30_000;

function bipe(urgente) {
  try {
    const Contexto = window.AudioContext || window.webkitAudioContext;
    if (!Contexto) return;
    const ctx = new Contexto();
    const tons = urgente ? [0, 0.22, 0.44] : [0];
    tons.forEach((inicio) => {
      const osc = ctx.createOscillator();
      const ganho = ctx.createGain();
      osc.type = urgente ? 'square' : 'sine';
      osc.frequency.value = urgente ? 880 : 660;
      ganho.gain.setValueAtTime(urgente ? 0.07 : 0.1, ctx.currentTime + inicio);
      ganho.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + inicio + 0.18);
      osc.connect(ganho).connect(ctx.destination);
      osc.start(ctx.currentTime + inicio);
      osc.stop(ctx.currentTime + inicio + 0.2);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1000);
  } catch {
    // Navegador sem som liberado: o visual basta.
  }
}

const hora = (instante) => new Date(instante).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function NotificacoesAtendimento() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const jaVistas = useRef(new Set());
  const [erro, setErro] = useState(null);

  const { data } = useQuery({
    queryKey: ['notificacoes'],
    queryFn: () => api.get('/api/notificacoes'),
    refetchInterval: 30_000
  });
  const notificacoes = data?.notificacoes ?? [];
  const temUrgente = notificacoes.some((n) => n.urgente);

  const recarregar = () => queryClient.invalidateQueries({ queryKey: ['notificacoes'] });

  const atender = useMutation({
    mutationFn: (id) => api.post(`/api/notificacoes/${id}/atender`),
    onSuccess: (r) => {
      setErro(null);
      queryClient.invalidateQueries({ queryKey: ['conversas'] });
      navigate(`/conversas?id=${r.conversationId}`);
    },
    onError: (err) => setErro(err.message),
    onSettled: recarregar
  });

  const fechar = useMutation({
    mutationFn: (id) => api.post(`/api/notificacoes/${id}/fechar`),
    onSettled: recarregar
  });

  // Bipe quando chega notificacao nova.
  useEffect(() => {
    const novas = notificacoes.filter((n) => !jaVistas.current.has(n.id));
    if (novas.length === 0) return;
    novas.forEach((n) => jaVistas.current.add(n.id));
    bipe(novas.some((n) => n.urgente));
  }, [notificacoes]);

  // Urgente parada na tela: o bipe volta a cada meio minuto.
  useEffect(() => {
    if (!temUrgente) return undefined;
    const timer = setInterval(() => bipe(true), REPETIR_BIPE_URGENTE_MS);
    return () => clearInterval(timer);
  }, [temUrgente]);

  if (notificacoes.length === 0 && !erro) return null;

  return createPortal(
    <div className="notificacoes" aria-live="assertive">
      {erro && (
        <div className="notificacao notificacao--erro" role="alert">
          <div className="notificacao__corpo">{erro}</div>
          <button type="button" className="notificacao__fechar" aria-label="Fechar" onClick={() => setErro(null)}>
            ×
          </button>
        </div>
      )}
      {notificacoes.map((n) => (
        <CartaoNotificacao
          key={n.id}
          n={n}
          atendendo={atender.isPending && atender.variables === n.id}
          aoAtender={() => atender.mutate(n.id)}
          aoFechar={() => fechar.mutate(n.id)}
        />
      ))}
    </div>,
    document.body
  );
}

function CartaoNotificacao({ n, atendendo, aoAtender, aoFechar }) {
  // O comum some sozinho. Passar o mouse segura: quem esta lendo nao perde o cartao.
  const [pausado, setPausado] = useState(false);
  useEffect(() => {
    if (n.urgente || pausado) return undefined;
    const timer = setTimeout(aoFechar, SOME_EM_MS);
    return () => clearTimeout(timer);
  }, [n.id, n.urgente, pausado]);

  const cliente = n.leadNome || 'Cliente';

  return (
    <div
      className={`notificacao${n.urgente ? ' notificacao--urgente' : ''}`}
      role={n.urgente ? 'alert' : 'status'}
      onMouseEnter={() => setPausado(true)}
      onMouseLeave={() => setPausado(false)}
    >
      <span className="notificacao__icone" aria-hidden="true">
        {n.urgente ? '!' : '💬'}
      </span>

      <div className="notificacao__corpo">
        <div className="notificacao__topo">
          {n.urgente ? (
            <span className="notificacao__selo">Cliente frustrado</span>
          ) : (
            <span className="notificacao__rotulo">A IA encaminhou</span>
          )}
          <span className="notificacao__hora">{hora(n.createdAt)}</span>
        </div>
        <strong className="notificacao__cliente">{cliente}</strong>
        {n.motivo && <p className="notificacao__motivo">{n.motivo}</p>}
        {n.urgente && <p className="notificacao__dica">Só sai daqui quando alguém atender.</p>}

        <div className="notificacao__acoes">
          <button type="button" className="notificacao__atender" disabled={atendendo} onClick={aoAtender}>
            {atendendo ? 'Abrindo...' : 'Atender'}
          </button>
        </div>
      </div>

      {!n.urgente && (
        <button type="button" className="notificacao__fechar" aria-label="Dispensar notificação" onClick={aoFechar}>
          ×
        </button>
      )}
      {!n.urgente && !pausado && <span className="notificacao__tempo" style={{ animationDuration: `${SOME_EM_MS}ms` }} />}
    </div>
  );
}
