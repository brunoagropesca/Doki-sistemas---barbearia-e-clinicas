import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { AreaTexto, Aviso, Botao, Campo, Carregando, Entrada, Etiqueta, Modal, Status } from '../../componentes/ui.jsx';

/** Proximos status possiveis: espelha `TRANSICOES` do servidor. */
export const PROXIMOS = {
  pendente: [['confirmado', 'Confirmar'], ['cancelado', 'Cancelar']],
  confirmado: [['em_andamento', 'Iniciar'], ['faltou', 'Faltou'], ['cancelado', 'Cancelar']],
  em_andamento: [['concluido', 'Concluir'], ['cancelado', 'Cancelar']],
  concluido: [],
  cancelado: [],
  faltou: []
};

const ENCERRADOS = ['concluido', 'cancelado', 'faltou'];

const paraReais = (centavos) => (centavos / 100).toFixed(2).replace('.', ',');
const paraCentavos = (texto) => Math.round(Number(String(texto).replace(/\./g, '').replace(',', '.')) * 100) || 0;

/** Ordem de servico: ver, editar, mudar status e excluir. */
export function DetalheOS({ id, aoFechar, aoAbrirPerfil, podeExcluir, abrirEditando = false }) {
  const queryClient = useQueryClient();
  const [editando, setEditando] = useState(abrirEditando);

  const dados = useQuery({ queryKey: ['agenda', 'os', id], queryFn: () => api.get(`/api/agenda/${id}`) });
  const a = dados.data?.agendamento;

  const atualizarTudo = () => {
    queryClient.invalidateQueries({ queryKey: ['agenda'] });
    queryClient.invalidateQueries({ queryKey: ['lead'] });
  };

  const mudarStatus = useMutation({
    mutationFn: ({ status }) => api.patch(`/api/agenda/${id}/status`, { status }),
    onSuccess: atualizarTudo
  });

  const arquivar = useMutation({
    mutationFn: (desfazer) => api.post(`/api/agenda/${id}/arquivar`, { desfazer }),
    onSuccess: () => {
      dados.refetch();
      atualizarTudo();
    }
  });

  const excluir = useMutation({
    mutationFn: () => api.delete(`/api/agenda/${id}`),
    onSuccess: () => {
      atualizarTudo();
      aoFechar();
    }
  });

  return (
    <Modal
      titulo="Ordem de servico"
      aberto
      aoFechar={aoFechar}
      largura={620}
      rodape={
        a &&
        !editando && (
          <>
            {podeExcluir && (
              <Botao
                variante="perigo"
                carregando={excluir.isPending}
                onClick={() => {
                  if (confirm('Excluir esta ordem de servico? Ela some da agenda e dos relatorios.')) excluir.mutate();
                }}
              >
                Excluir
              </Botao>
            )}
            {ENCERRADOS.includes(a.status) && (
              <Botao
                variante="secundario"
                carregando={arquivar.isPending}
                onClick={() => arquivar.mutate(Boolean(a.arquivadoEm))}
              >
                {a.arquivadoEm ? 'Desarquivar' : 'Arquivar'}
              </Botao>
            )}
            {!ENCERRADOS.includes(a.status) && (
              <Botao variante="secundario" onClick={() => setEditando(true)}>
                Editar
              </Botao>
            )}
          </>
        )
      }
    >
      {dados.isLoading ? (
        <Carregando />
      ) : !a ? (
        <Aviso tom="perigo">Ordem de servico nao encontrada.</Aviso>
      ) : editando ? (
        <FormEdicao
          a={a}
          aoCancelar={() => setEditando(false)}
          aoSalvar={() => {
            setEditando(false);
            dados.refetch();
            atualizarTudo();
          }}
        />
      ) : (
        <div className="coluna">
          {(mudarStatus.isError || excluir.isError || arquivar.isError) && (
            <Aviso tom="perigo">{(mudarStatus.error ?? excluir.error ?? arquivar.error).message}</Aviso>
          )}

          <div className="linha linha--entre">
            <div>
              <h3>{a.servicoNome}</h3>
              <div className="texto-suave">
                {a.quandoFormatado} ate {a.horaFim}
              </div>
            </div>
            <div className="linha" style={{ gap: 6 }}>
              {a.arquivadoEm && <Etiqueta tom="neutro">Arquivada</Etiqueta>}
              {a.sessaoAtiva && <Etiqueta tom="primario">Em atendimento</Etiqueta>}
              {a.criadoPor === 'ia' && <Etiqueta tom="info">via IA</Etiqueta>}
              <Status valor={a.status} />
            </div>
          </div>

          <div className="grade">
            <div>
              <div className="texto-fraco">Cliente</div>
              <button type="button" className="link" onClick={() => aoAbrirPerfil(a.leadId)}>
                {a.leadNome}
              </button>
              <div className="texto-fraco">{a.leadTelefoneFormatado}</div>
            </div>
            <div>
              <div className="texto-fraco">Profissional</div>
              <span style={{ color: a.profissionalCor }}>●</span> {a.profissionalNome}
            </div>
            <div>
              <div className="texto-fraco">Valor</div>
              <strong className="mono">{a.totalFormatado}</strong>
              {a.descontoCentavos > 0 && (
                <div className="texto-fraco">desconto de R$ {paraReais(a.descontoCentavos)}</div>
              )}
            </div>
          </div>

          {a.observacoes && (
            <div>
              <div className="texto-fraco">Observacoes</div>
              <p>{a.observacoes}</p>
            </div>
          )}

          {a.motivoCancelamento && (
            <div>
              <div className="texto-fraco">Motivo do cancelamento</div>
              <p>{a.motivoCancelamento}</p>
            </div>
          )}

          <div>
            <div className="texto-fraco">Resumo do atendimento</div>
            {a.resumoAtendimento ? (
              <p>{a.resumoAtendimento}</p>
            ) : (
              <p className="texto-fraco">
                {a.sessaoAtiva
                  ? 'Sera preenchido quando a sessao de atendimento for finalizada.'
                  : 'Sem resumo registrado.'}
              </p>
            )}
          </div>

          {a.anotacoesAtendimento && (
            <div>
              <div className="texto-fraco">Anotacoes da equipe</div>
              <p>{a.anotacoesAtendimento}</p>
            </div>
          )}

          {(PROXIMOS[a.status] ?? []).length > 0 && (
            <div className="linha">
              {PROXIMOS[a.status].map(([status, rotulo]) => (
                <Botao
                  key={status}
                  variante={status === 'cancelado' || status === 'faltou' ? 'fantasma' : 'primario'}
                  tamanho="sm"
                  carregando={mudarStatus.isPending && mudarStatus.variables?.status === status}
                  onClick={() => mudarStatus.mutate({ status }, { onSuccess: () => dados.refetch() })}
                >
                  {rotulo}
                </Botao>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Edita horario (remarcar) e detalhes (observacoes, desconto) de uma vez. */
function FormEdicao({ a, aoCancelar, aoSalvar }) {
  const [form, setForm] = useState({
    data: a.data,
    hora: a.horaInicio,
    observacoes: a.observacoes ?? '',
    desconto: paraReais(a.descontoCentavos)
  });

  const salvar = useMutation({
    mutationFn: async () => {
      if (form.data !== a.data || form.hora !== a.horaInicio) {
        await api.patch(`/api/agenda/${a.id}/remarcar`, { data: form.data, hora: form.hora });
      }
      await api.patch(`/api/agenda/${a.id}`, {
        observacoes: form.observacoes,
        descontoCentavos: paraCentavos(form.desconto)
      });
    },
    onSuccess: aoSalvar
  });

  return (
    <div className="coluna">
      {salvar.isError && <Aviso tom="perigo">{salvar.error.message}</Aviso>}
      <div className="grade">
        <Campo rotulo="Data">
          <Entrada type="date" value={form.data} onChange={(e) => setForm({ ...form, data: e.target.value })} />
        </Campo>
        <Campo rotulo="Hora">
          <Entrada type="time" value={form.hora} onChange={(e) => setForm({ ...form, hora: e.target.value })} />
        </Campo>
        <Campo rotulo="Desconto (R$)">
          <Entrada value={form.desconto} onChange={(e) => setForm({ ...form, desconto: e.target.value })} />
        </Campo>
      </div>
      <Campo rotulo="Observacoes">
        <AreaTexto value={form.observacoes} onChange={(e) => setForm({ ...form, observacoes: e.target.value })} />
      </Campo>
      <div className="linha linha--fim">
        <Botao variante="secundario" onClick={aoCancelar}>
          Cancelar
        </Botao>
        <Botao carregando={salvar.isPending} onClick={() => salvar.mutate()}>
          Salvar
        </Botao>
      </div>
    </div>
  );
}
