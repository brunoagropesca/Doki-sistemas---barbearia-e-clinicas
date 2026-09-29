import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/autenticacao.jsx';
import {
  Aviso,
  Botao,
  Carregando,
  Cartao,
  Entrada,
  Metrica,
  Status,
  Tabela,
  Vazio
} from '../componentes/ui.jsx';
import { Calendario, limitesDoMes, somarMeses } from './agenda/Calendario.jsx';
import { DetalheOS, PROXIMOS } from './agenda/DetalheOS.jsx';
import { AssistenteAgendar } from './agenda/AssistenteAgendar.jsx';
import './agenda/assistente.css';
import { PerfilLead } from './agenda/PerfilLead.jsx';
import { aplicarFiltros, FiltrosAgenda } from './agenda/FiltrosAgenda.jsx';

/** "a,b" da URL -> ['a', 'b']. */
const lerLista = (valor) => (valor ? valor.split(',').filter(Boolean) : []);

/** Data de hoje no formato AAAA-MM-DD, no fuso do navegador. */
function hojeISO() {
  return new Date().toLocaleDateString('sv-SE');
}

export function Agenda() {
  const queryClient = useQueryClient();
  const { podeAcessar } = useAuth();
  const [data, setData] = useState(hojeISO());
  const [visao, setVisao] = useState('lista');
  const [modalAberto, setModalAberto] = useState(false);
  const [osAberta, setOsAberta] = useState(null);
  const [editando, setEditando] = useState(null);
  const [verArquivados, setVerArquivados] = useState(false);
  const [perfilAberto, setPerfilAberto] = useState(null);

  // Filtros na URL: sobrevivem a troca lista/calendario, ao recarregar e a um link copiado.
  const [params, setParams] = useSearchParams();
  const filtros = { profissionais: lerLista(params.get('prof')), servicos: lerLista(params.get('serv')) };
  const filtrando = filtros.profissionais.length > 0 || filtros.servicos.length > 0;
  function mudarFiltros(novos) {
    const p = new URLSearchParams(params);
    for (const [chave, lista] of [['prof', novos.profissionais], ['serv', novos.servicos]]) {
      if (lista.length) p.set(chave, lista.join(','));
      else p.delete(chave);
    }
    setParams(p, { replace: true });
  }

  const emCalendario = visao === 'calendario';
  const mes = limitesDoMes(data);

  const agenda = useQuery({
    queryKey: ['agenda', emCalendario ? mes : data, visao, verArquivados],
    queryFn: () => {
      const periodo = emCalendario ? { data: mes.de, dataFim: mes.ate } : { data };
      return api.get('/api/agenda', { ...periodo, ...(verArquivados ? { incluirArquivados: 'true' } : {}) });
    }
  });

  const metricas = useQuery({
    queryKey: ['agenda', 'metricas', emCalendario ? mes : data, visao, filtros.profissionais.join(), filtros.servicos.join()],
    queryFn: () =>
      api.get('/api/agenda/metricas', {
        ...(emCalendario ? { data: mes.de, dataFim: mes.ate } : { data }),
        // Os numeros do topo seguem os filtros (o servidor aplica no recorte de quem pede).
        profissionais: filtros.profissionais.join(','),
        servicos: filtros.servicos.join(',')
      }),
    placeholderData: (anterior) => anterior
  });

  const mudarStatus = useMutation({
    mutationFn: ({ id, status }) => api.patch(`/api/agenda/${id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agenda'] })
  });

  const excluir = useMutation({
    mutationFn: (id) => api.delete(`/api/agenda/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agenda'] })
  });

  const arquivar = useMutation({
    mutationFn: ({ id, desfazer }) => api.post(`/api/agenda/${id}/arquivar`, { desfazer }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agenda'] })
  });

  const todosDoPeriodo = agenda.data?.agendamentos ?? [];
  const lista = aplicarFiltros(todosDoPeriodo, filtros);
  const m = metricas.data;
  /** Estados terminais: so eles podem ser arquivados, e nenhum deles se edita. */
  const ENCERRADOS = ['concluido', 'cancelado', 'faltou'];
  const podeExcluir = podeAcessar('admin');
  const periodo = emCalendario ? 'no mes' : 'no dia';

  return (
    <div className="coluna">
      <header className="linha linha--entre">
        <div>
          <h1>Agenda</h1>
          <p className="texto-suave">Ordens de servico e agendamentos.</p>
        </div>
        <div className="linha">
          <div className="abas abas--compacta" role="tablist">
            {[
              ['lista', 'Lista'],
              ['calendario', 'Calendario']
            ].map(([id, rotulo]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={visao === id}
                className={`abas__aba${visao === id ? ' abas__aba--ativa' : ''}`}
                onClick={() => setVisao(id)}
              >
                {rotulo}
              </button>
            ))}
          </div>
          {emCalendario ? (
            <div className="linha" style={{ gap: 4 }}>
              <Botao variante="secundario" tamanho="sm" onClick={() => setData(somarMeses(data, -1))}>
                ‹
              </Botao>
              <strong style={{ minWidth: 130, textAlign: 'center', textTransform: 'capitalize' }}>
                {new Date(`${data}T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}
              </strong>
              <Botao variante="secundario" tamanho="sm" onClick={() => setData(somarMeses(data, 1))}>
                ›
              </Botao>
              <Botao variante="fantasma" tamanho="sm" onClick={() => setData(hojeISO())}>
                Hoje
              </Botao>
            </div>
          ) : (
            <Entrada type="date" value={data} onChange={(e) => setData(e.target.value)} style={{ width: 'auto' }} />
          )}
          <Botao
            variante={verArquivados ? 'secundario' : 'fantasma'}
            tamanho="sm"
            onClick={() => setVerArquivados((v) => !v)}
            title="Mostra tambem os atendimentos ja arquivados"
          >
            {verArquivados ? 'Ocultar arquivados' : 'Ver arquivados'}
          </Botao>
          <Botao onClick={() => setModalAberto(true)}>Marcar horario</Botao>
        </div>
      </header>

      <div className="linha linha--entre" style={{ flexWrap: 'wrap', gap: 'var(--e2)' }}>
        <FiltrosAgenda agendamentos={todosDoPeriodo} filtros={filtros} aoMudar={mudarFiltros} />
        {filtrando && !agenda.isLoading && (
          <p className="fa-resultado texto-suave">
            Mostrando <strong>{lista.length}</strong> de {todosDoPeriodo.length} {periodo}
          </p>
        )}
      </div>

      <div className="grade">
        <Metrica rotulo={`Total ${periodo}`} valor={m?.total ?? '—'} />
        <Metrica rotulo="Confirmados" valor={m?.confirmados ?? '—'} />
        <Metrica rotulo="Concluidos" valor={m?.concluidos ?? '—'} tom="sucesso" />
        <Metrica rotulo="Faltas" valor={m?.faltas ?? '—'} tom={m?.faltas > 0 ? 'perigo' : undefined} />
        <Metrica rotulo="Faturamento" valor={m?.faturamentoFormatado ?? '—'} tom="sucesso" />
      </div>

      {(mudarStatus.isError || excluir.isError || arquivar.isError) && (
        <Aviso tom="perigo">{(mudarStatus.error ?? excluir.error ?? arquivar.error).message}</Aviso>
      )}

      {emCalendario ? (
        <Cartao>
          {agenda.isLoading ? (
            <Carregando />
          ) : (
            <Calendario
              mes={mes.de}
              agendamentos={lista}
              hoje={hojeISO()}
              aoEscolherOS={setOsAberta}
              aoEscolherDia={(dia) => {
                setData(dia);
                setVisao('lista');
              }}
            />
          )}
        </Cartao>
      ) : (
        <Cartao
          semPadding
          titulo={new Date(`${data}T12:00:00`).toLocaleDateString('pt-BR', {
            weekday: 'long',
            day: 'numeric',
            month: 'long'
          })}
        >
          {agenda.isLoading ? (
            <Carregando />
          ) : lista.length === 0 && filtrando ? (
            <Vazio
              titulo="Nenhum atendimento com esses filtros"
              descricao={`Há ${todosDoPeriodo.length} atendimento${todosDoPeriodo.length === 1 ? '' : 's'} neste dia fora do filtro.`}
              acao={
                <Botao variante="secundario" onClick={() => mudarFiltros({ profissionais: [], servicos: [] })}>
                  Limpar filtros
                </Botao>
              }
            />
          ) : lista.length === 0 ? (
            <Vazio
              titulo="Nenhum atendimento neste dia"
              descricao="Escolha outra data ou marque um horario."
              acao={<Botao onClick={() => setModalAberto(true)}>Marcar horario</Botao>}
            />
          ) : (
            <Tabela cabecalho={['Horario', 'Cliente', 'Servico', 'Profissional', 'Valor', 'Status', 'Acoes']}>
              {lista.map((a) => (
                <tr key={a.id} className={a.arquivadoEm ? 'linha--arquivada' : undefined}>
                  <td className="mono">
                    {a.horaInicio}
                    <div className="texto-fraco">ate {a.horaFim}</div>
                  </td>
                  <td>
                    <button type="button" className="link" onClick={() => setPerfilAberto(a.leadId)}>
                      <strong>{a.leadNome}</strong>
                    </button>
                    <div className="texto-fraco">{a.leadTelefoneFormatado}</div>
                  </td>
                  <td>{a.servicoNome}</td>
                  <td>
                    <span style={{ color: a.profissionalCor }}>●</span> {a.profissionalNome}
                  </td>
                  <td className="mono">{a.totalFormatado}</td>
                  <td>
                    <Status valor={a.status} />
                    {a.criadoPor === 'ia' && (
                      <div className="texto-fraco" title="Marcado pela IA no WhatsApp">
                        via IA
                      </div>
                    )}
                    {a.sessaoAtiva && <div className="texto-fraco">em atendimento</div>}
                  </td>
                  <td>
                    <div className="linha" style={{ gap: 4 }}>
                      {(PROXIMOS[a.status] ?? []).map(([status, rotulo]) => (
                        <Botao
                          key={status}
                          variante={status === 'cancelado' || status === 'faltou' ? 'fantasma' : 'secundario'}
                          tamanho="sm"
                          onClick={() => mudarStatus.mutate({ id: a.id, status })}
                        >
                          {rotulo}
                        </Botao>
                      ))}
                      <Botao variante="secundario" tamanho="sm" onClick={() => setOsAberta(a.id)}>
                        Ver
                      </Botao>
                      {!ENCERRADOS.includes(a.status) && (
                        <Botao variante="secundario" tamanho="sm" onClick={() => setEditando(a.id)}>
                          Editar
                        </Botao>
                      )}
                      {/* Arquivar so vale para o que ja terminou: sai da agenda
                          do dia a dia sem sair do historico. */}
                      {ENCERRADOS.includes(a.status) && (
                        <Botao
                          variante="fantasma"
                          tamanho="sm"
                          carregando={arquivar.isPending && arquivar.variables?.id === a.id}
                          onClick={() => arquivar.mutate({ id: a.id, desfazer: Boolean(a.arquivadoEm) })}
                        >
                          {a.arquivadoEm ? 'Desarquivar' : 'Arquivar'}
                        </Botao>
                      )}
                      {podeExcluir && (
                        <Botao
                          variante="fantasma"
                          tamanho="sm"
                          onClick={() => {
                            if (confirm(`Excluir a OS de ${a.leadNome}? Ela some da agenda e dos relatorios.`)) {
                              excluir.mutate(a.id);
                            }
                          }}
                        >
                          Excluir
                        </Botao>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </Tabela>
          )}
        </Cartao>
      )}

      {modalAberto && (
        <AssistenteAgendar
          dataInicial={data}
          aoFechar={() => setModalAberto(false)}
          aoSalvar={() => {
            setModalAberto(false);
            queryClient.invalidateQueries({ queryKey: ['agenda'] });
          }}
        />
      )}

      {(osAberta || editando) && (
        <DetalheOS
          id={osAberta ?? editando}
          abrirEditando={Boolean(editando)}
          podeExcluir={podeExcluir}
          aoFechar={() => {
            setOsAberta(null);
            setEditando(null);
          }}
          aoAbrirPerfil={(id) => {
            setOsAberta(null);
            setPerfilAberto(id);
          }}
        />
      )}

      {perfilAberto && (
        <PerfilLead leadId={perfilAberto} aoFechar={() => setPerfilAberto(null)} aoAbrirOS={(id) => {
            setPerfilAberto(null);
            setOsAberta(id);
          }}
        />
      )}
    </div>
  );
}
