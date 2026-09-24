import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Botao, Modal } from '../../componentes/ui.jsx';

/**
 * Pecas que a lista, o assistente e o relatorio de campanhas compartilham.
 */

export const EM_PREPARO = ['rascunho', 'gerando', 'revisao', 'pronta'];

/** O relogio da tela: re-renderiza a cada segundo para as contagens regressivas. */
export function useAgora(ativo = true) {
  const [agora, setAgora] = useState(Date.now());
  useEffect(() => {
    if (!ativo) return undefined;
    const t = setInterval(() => setAgora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ativo]);
  return agora;
}

/** "42s", "3 min", "2 h 10 min" — quanto falta ate um instante. */
export function falta(ate, agora = Date.now()) {
  const s = Math.max(0, Math.round((ate - agora) / 1000));
  if (s < 60) return `${s}s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const resto = min % 60;
  return resto ? `${h} h ${resto} min` : `${h} h`;
}

/** Duracao em segundos por extenso: "45 min", "3 h 20 min". */
export function duracao(segundos) {
  return falta(Date.now() + segundos * 1000);
}

/** "hoje as 09:00", "amanha as 09:00", "seg., 22/09 as 09:00". */
export function quando(instante) {
  const d = new Date(instante);
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const hoje = new Date();
  const amanha = new Date(Date.now() + 86_400_000);
  if (d.toDateString() === hoje.toDateString()) return `hoje às ${hora}`;
  if (d.toDateString() === amanha.toDateString()) return `amanhã às ${hora}`;
  return `${d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })} às ${hora}`;
}

/**
 * Barra de progresso da campanha.
 *
 * O visual conta o estado sem precisar ler: listras andando = enviando agora;
 * ambar parado = esperando (fora do horario, limite do dia, numero caiu);
 * verde = terminou. Na geracao, a mesma barra mede a IA escrevendo.
 */
export function BarraProgresso({ campanha: c, grande = false }) {
  const p = c.progresso ?? {};
  const agora = useAgora(c.status === 'enviando' || c.status === 'gerando');

  let feitos = p.processadas ?? 0;
  let total = p.paraEnviar ?? 0;
  let variante = c.status;
  let legenda = null;

  if (c.status === 'gerando') {
    total = c.totalAlvos;
    feitos = total - (p.aguardando ?? 0);
    variante = 'gerando progresso--ativo';
    legenda = (
      <>
        <span className="pulso pulso--ativo" style={{ background: '#8b5cf6' }} /> A IA está escrevendo as mensagens
      </>
    );
  } else if (c.status === 'enviando' && c.esperaMotivo) {
    variante = 'esperando';
    legenda = (
      <>
        <span className="pulso pulso--alerta" /> {c.esperaMotivo}
        {c.retomaEm ? ` · volta ${quando(c.retomaEm)}` : ''}
      </>
    );
  } else if (c.status === 'enviando') {
    variante = 'ativo';
    legenda = (
      <>
        <span className="pulso pulso--ativo" /> Enviando
        {c.proximoEnvioEm && c.proximoEnvioEm > agora ? ` · próxima em ${falta(c.proximoEnvioEm, agora)}` : ' · digitando…'}
      </>
    );
  } else if (c.status === 'pausada') {
    legenda = c.esperaMotivo ? `Pausada · ${c.esperaMotivo}` : 'Pausada · retoma de onde parou';
  } else if (c.status === 'concluida') {
    legenda = `Concluída${c.concluidaEm ? ` ${quando(c.concluidaEm)}` : ''}`;
  } else if (c.status === 'cancelada') {
    legenda = p.puladas ? `Parada · ${p.puladas} não enviada(s)` : 'Parada';
  } else if (c.status === 'revisao') {
    total = c.totalAlvos;
    feitos = p.aprovadas ?? 0;
    legenda = `${p.pendentes} para revisar · ${p.aprovadas} aprovada(s)`;
  } else if (c.status === 'pronta') {
    total = p.aprovadas ?? 0;
    feitos = 0;
    legenda = `${p.aprovadas} mensagem(ns) aprovada(s), pronta para enviar`;
  } else {
    legenda = c.totalAlvos ? `${c.totalAlvos} contato(s) no público` : 'Montando a campanha';
  }

  const pct = total > 0 ? Math.min(100, Math.round((feitos / total) * 100)) : 0;
  const classes = variante
    .split(' ')
    .map((v) => (v.startsWith('progresso--') ? v : `progresso--${v}`))
    .join(' ');

  return (
    <div className={`progresso ${classes} ${grande ? 'progresso--grande' : ''}`}>
      {total > 0 && (
        <div className="progresso__topo">
          <span className="progresso__numeros">
            {feitos} de {total}
          </span>
          <span className="progresso__pct">{pct}%</span>
        </div>
      )}
      <div
        className="progresso__trilho"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={`Progresso da campanha ${c.nome}`}
      >
        {/* Em andamento, um toco minimo: com 0% a animacao ficaria invisivel e
            pareceria que nada esta acontecendo. */}
        <div className="progresso__barra" style={{ width: `${classes.includes('ativo') ? Math.max(pct, 4) : pct}%` }} />
      </div>
      {legenda && <div className="progresso__legenda">{legenda}</div>}
    </div>
  );
}

const ICONES = {
  iniciar: <path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none" />,
  pausar: (
    <>
      <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
      <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  parar: <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none" />
};

function Icone({ nome }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {ICONES[nome]}
    </svg>
  );
}

/**
 * Iniciar / Pausar / Parar.
 *
 * Os tres aparecem sempre juntos numa campanha ativa, e o que nao cabe no
 * momento fica desabilitado em vez de sumir: a pessoa ve que o botao existe
 * e entende por que nao pode usa-lo agora. "Parar" pede confirmacao porque
 * nao tem volta; "Pausar" nao, porque tem.
 */
export function Controles({ campanha: c, aoErro }) {
  const queryClient = useQueryClient();
  const [confirmarParada, setConfirmarParada] = useState(false);

  const acao = useMutation({
    mutationFn: (rota) => api.post(`/api/campanhas/${c.id}/${rota}`),
    onSuccess: () => {
      setConfirmarParada(false);
      aoErro?.(null);
      queryClient.invalidateQueries({ queryKey: ['campanhas'] });
      queryClient.invalidateQueries({ queryKey: ['campanha', c.id] });
    },
    onError: (err) => {
      setConfirmarParada(false);
      aoErro?.(err.message);
    }
  });

  const podeIniciar = ['pronta', 'pausada'].includes(c.status);
  const podePausar = c.status === 'enviando';
  const podeParar = ['pronta', 'enviando', 'pausada', 'gerando'].includes(c.status);
  const naoEnviadas = (c.progresso?.aprovadas ?? 0) + (c.progresso?.pendentes ?? 0) + (c.progresso?.aguardando ?? 0);
  const ocupado = acao.isPending;

  return (
    <>
      <div className="camp-controles">
        <button
          type="button"
          className="camp-controle camp-controle--iniciar"
          disabled={!podeIniciar || ocupado}
          onClick={() => acao.mutate('iniciar')}
          title={c.status === 'pausada' ? 'Retomar de onde parou' : 'Começar o envio'}
        >
          <Icone nome="iniciar" /> {c.status === 'pausada' ? 'Retomar' : 'Iniciar'}
        </button>
        <button
          type="button"
          className="camp-controle camp-controle--pausar"
          disabled={!podePausar || ocupado}
          onClick={() => acao.mutate('pausar')}
          title="Interromper por enquanto; retoma de onde parou"
        >
          <Icone nome="pausar" /> Pausar
        </button>
        <button
          type="button"
          className="camp-controle camp-controle--parar"
          disabled={!podeParar || ocupado}
          onClick={() => setConfirmarParada(true)}
          title="Encerrar de vez"
        >
          <Icone nome="parar" /> Parar
        </button>
      </div>

      {confirmarParada && (
        <Modal
          titulo="Parar a campanha de vez?"
          aberto
          aoFechar={() => setConfirmarParada(false)}
          rodape={
            <>
              <Botao variante="secundario" onClick={() => setConfirmarParada(false)}>
                Voltar
              </Botao>
              {podePausar && (
                <Botao variante="secundario" onClick={() => acao.mutate('pausar')} carregando={ocupado}>
                  Só pausar
                </Botao>
              )}
              <Botao variante="perigo" onClick={() => acao.mutate('cancelar')} carregando={ocupado}>
                Parar campanha
              </Botao>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            <strong>{c.nome}</strong> será encerrada.
            {naoEnviadas > 0 && ` ${naoEnviadas} mensagem(ns) que ainda não saíram não serão enviadas.`} Isso não pode ser
            desfeito.
          </p>
          {podePausar && (
            <p className="texto-fraco" style={{ marginBottom: 0 }}>
              Para interromper só por um tempo, use Pausar: a campanha continua depois de onde parou.
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
