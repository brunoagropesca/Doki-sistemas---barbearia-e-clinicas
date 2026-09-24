import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/autenticacao.jsx';
import { Botao, Carregando, Entrada, Etiqueta, Selecao, Status, Vazio } from '../../componentes/ui.jsx';
import { DetalheOS } from '../agenda/DetalheOS.jsx';
import { PerfilLead } from '../agenda/PerfilLead.jsx';
import { Humor } from './Humor.jsx';

/**
 * As duas listas pessoais que ocupam o lugar da conversa quando o atendente as
 * escolhe no menu do perfil:
 *
 *   FINALIZADOS   — o que eu atendi e encerrei, dia a dia (hoje por padrao).
 *   AGENDAMENTOS  — os horarios que eu acompanho ate o servico acontecer.
 *
 * Quem enxerga a equipe inteira (o dono, por padrao) ganha um seletor para
 * olhar a lista de outro atendente. Para os demais o seletor nem aparece: o
 * servidor devolveria a propria lista de qualquer jeito, e um botao que nao
 * faz o que diz e pior do que botao nenhum.
 */

function hojeISO() {
  return new Date().toLocaleDateString('sv-SE');
}

function somarDias(dataISO, n) {
  const d = new Date(`${dataISO}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE');
}

function rotuloDoDia(dataISO) {
  const hoje = hojeISO();
  if (dataISO === hoje) return 'Hoje';
  if (dataISO === somarDias(hoje, 1)) return 'Amanhã';
  if (dataISO === somarDias(hoje, -1)) return 'Ontem';
  return new Date(`${dataISO}T12:00:00`).toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit'
  });
}

/** Seletor "de quem e esta lista", so para quem pode ver outros. */
function useAtendenteEscolhido() {
  const { usuario } = useAuth();
  const [escolhido, setEscolhido] = useState(null);

  const destinos = useQuery({
    queryKey: ['conversas', 'destinos'],
    queryFn: () => api.get('/api/conversas/destinos'),
    staleTime: 60_000
  });

  const veTudo = Boolean(destinos.data?.veTudo);
  const opcoes = [{ id: usuario.id, nome: `${usuario.nome} (eu)` }, ...(destinos.data?.atendentes ?? [])];

  return {
    atendenteId: veTudo && escolhido ? escolhido : usuario.id,
    veTudo,
    opcoes,
    seletor: veTudo ? (
      <Selecao value={escolhido ?? usuario.id} onChange={(e) => setEscolhido(e.target.value)} style={{ width: 'auto' }}>
        {opcoes.map((o) => (
          <option key={o.id} value={o.id}>
            {o.nome}
          </option>
        ))}
      </Selecao>
    ) : null
  };
}

export function VistaFinalizados({ aoAbrir }) {
  const [dia, setDia] = useState(hojeISO());
  const { atendenteId, seletor } = useAtendenteEscolhido();

  const lista = useQuery({
    queryKey: ['conversas', 'finalizadas', dia, atendenteId],
    queryFn: () => api.get('/api/conversas', { filtro: 'finalizadas', dia, atendenteId, limite: 100 })
  });

  const itens = lista.data?.itens ?? [];

  return (
    <div className="vista">
      <header className="vista__topo">
        <div>
          <h2>Atendimentos finalizados</h2>
          <p className="texto-fraco">
            {lista.isSuccess ? `${itens.length} em ${rotuloDoDia(dia).toLowerCase()}` : 'Carregando...'}
          </p>
        </div>

        <div className="linha">
          {seletor}
          <Botao variante="secundario" tamanho="sm" onClick={() => setDia(somarDias(dia, -1))} aria-label="Dia anterior">
            ‹
          </Botao>
          <Entrada type="date" value={dia} max={hojeISO()} onChange={(e) => e.target.value && setDia(e.target.value)} style={{ width: 'auto' }} />
          <Botao
            variante="secundario"
            tamanho="sm"
            disabled={dia >= hojeISO()}
            onClick={() => setDia(somarDias(dia, 1))}
            aria-label="Próximo dia"
          >
            ›
          </Botao>
          {dia !== hojeISO() && (
            <Botao variante="fantasma" tamanho="sm" onClick={() => setDia(hojeISO())}>
              Hoje
            </Botao>
          )}
        </div>
      </header>

      <div className="vista__corpo">
        {lista.isLoading ? (
          <Carregando />
        ) : itens.length === 0 ? (
          <Vazio
            titulo="Nenhum atendimento finalizado"
            descricao={dia === hojeISO() ? 'Ainda não finalizou nenhum hoje.' : 'Nada foi finalizado neste dia.'}
          />
        ) : (
          <div className="vista__lista">
            {itens.map((c) => (
              <button key={c.id} type="button" className="vista__linha" onClick={() => aoAbrir(c.id)}>
                <span className="vista__hora mono">
                  {c.finalizadaEm
                    ? new Date(c.finalizadaEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                    : '—'}
                </span>
                <span className="crescer">
                  <span className="linha linha--entre">
                    <strong>{c.leadNome}</strong>
                    <span className="linha" style={{ gap: 6 }}>
                      <Humor valor={c.humor} compacto />
                      {c.canalChave && <Etiqueta tom="neutro">{c.canalChave}</Etiqueta>}
                    </span>
                  </span>
                  <span className="vista__resumo">{c.resumo || c.ultimaMensagemPreview || 'Sem resumo.'}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function VistaAgendamentos({ aoAbrir }) {
  const { podeAcessar } = useAuth();
  const { atendenteId, seletor } = useAtendenteEscolhido();
  const [osAberta, setOsAberta] = useState(null);
  const [perfilAberto, setPerfilAberto] = useState(null);

  const lista = useQuery({
    queryKey: ['agenda', 'atendente', atendenteId],
    queryFn: () => api.get('/api/agenda/atendente', { atendenteId })
  });

  const itens = lista.data?.agendamentos ?? [];

  // Agrupa por dia, mantendo a ordem em que o servidor mandou (do mais proximo).
  const porDia = [];
  for (const a of itens) {
    const ultimo = porDia.at(-1);
    if (ultimo?.data === a.data) ultimo.itens.push(a);
    else porDia.push({ data: a.data, itens: [a] });
  }

  return (
    <div className="vista">
      <header className="vista__topo">
        <div>
          <h2>Agendamentos</h2>
          <p className="texto-fraco">
            Horários por acontecer, para você falar com o cliente até o dia do serviço.
            {lista.isSuccess && ` ${itens.length} no total.`}
          </p>
        </div>
        {seletor}
      </header>

      <div className="vista__corpo">
        {lista.isLoading ? (
          <Carregando />
        ) : itens.length === 0 ? (
          <Vazio
            titulo="Nenhum horário por acontecer"
            descricao="Quando você (ou a IA, em conversa sua) marcar um horário, ele aparece aqui."
          />
        ) : (
          porDia.map((grupo) => (
            <section key={grupo.data} className="vista__dia">
              <h3 className="vista__dia-titulo">{rotuloDoDia(grupo.data)}</h3>

              {grupo.itens.map((a) => (
                <article key={a.id} className="vista__cartao" style={{ borderLeftColor: a.profissionalCor }}>
                  <div className="vista__hora mono">{a.horaInicio}</div>

                  <div className="crescer">
                    <div className="linha linha--entre">
                      <button type="button" className="link" onClick={() => setPerfilAberto(a.leadId)}>
                        <strong>{a.leadNome}</strong>
                      </button>
                      <span className="linha" style={{ gap: 6 }}>
                        {a.criadoPor === 'ia' && <Etiqueta tom="info">marcado pela IA</Etiqueta>}
                        <Status valor={a.status} />
                      </span>
                    </div>

                    <div className="texto-suave">
                      {a.servicoNome} · {a.profissionalNome} · {a.totalFormatado}
                    </div>
                    {a.leadTelefoneFormatado && <div className="texto-fraco mono">{a.leadTelefoneFormatado}</div>}

                    <div className="linha" style={{ marginTop: 'var(--e2)' }}>
                      <Botao
                        tamanho="sm"
                        disabled={!a.conversaId}
                        title={a.conversaId ? undefined : 'Este cliente não tem uma conversa sua para abrir.'}
                        onClick={() => aoAbrir(a.conversaId)}
                      >
                        {a.conversaFinalizada ? 'Abrir conversa (finalizada)' : 'Falar com o cliente'}
                      </Botao>
                      <Botao variante="secundario" tamanho="sm" onClick={() => setOsAberta(a.id)}>
                        Ver ordem
                      </Botao>
                    </div>
                  </div>
                </article>
              ))}
            </section>
          ))
        )}
      </div>

      {osAberta && (
        <DetalheOS
          id={osAberta}
          podeExcluir={podeAcessar('admin')}
          aoFechar={() => setOsAberta(null)}
          aoAbrirPerfil={(id) => {
            setOsAberta(null);
            setPerfilAberto(id);
          }}
        />
      )}

      {perfilAberto && (
        <PerfilLead
          leadId={perfilAberto}
          aoFechar={() => setPerfilAberto(null)}
          aoAbrirOS={(id) => {
            setPerfilAberto(null);
            setOsAberta(id);
          }}
        />
      )}
    </div>
  );
}
