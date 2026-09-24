import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/autenticacao.jsx';
import { Botao, Carregando, Cartao, Metrica, Status, Tabela, Vazio } from '../componentes/ui.jsx';

/**
 * Painel inicial.
 *
 * Responde as tres perguntas de quem abre o sistema de manha:
 * quem esta esperando, o que tem na agenda hoje, e como foi o dia.
 */
export function Painel() {
  const { usuario } = useAuth();

  const hoje = new Date().toLocaleDateString('sv-SE'); // 'sv-SE' devolve AAAA-MM-DD

  const agenda = useQuery({
    queryKey: ['agenda', hoje],
    queryFn: () => api.get('/api/agenda', { data: hoje })
  });

  const metricasAgenda = useQuery({
    queryKey: ['agenda', 'metricas', hoje],
    queryFn: () => api.get('/api/agenda/metricas', { data: hoje })
  });

  const metricasConversas = useQuery({
    queryKey: ['conversas', 'metricas', 1],
    queryFn: () => api.get('/api/conversas/metricas', { dias: 1 }),
    refetchInterval: 20_000
  });

  const m = metricasAgenda.data;
  const c = metricasConversas.data;

  const proximos = (agenda.data?.agendamentos ?? [])
    .filter((a) => ['pendente', 'confirmado', 'em_andamento'].includes(a.status))
    .slice(0, 8);

  return (
    <div className="coluna">
      <header>
        <h1>Ola, {usuario?.nome?.split(' ')[0]}</h1>
        <p className="texto-suave">
          {new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </header>

      <div className="grade">
        <Metrica
          rotulo="Esperando atendimento"
          valor={c?.naFila ?? '—'}
          detalhe={c?.naFila > 0 ? 'Alguem precisa assumir' : 'Fila vazia'}
          tom={c?.naFila > 0 ? 'alerta' : undefined}
        />
        <Metrica rotulo="Conversas com a IA" valor={c?.comBot ?? '—'} />
        <Metrica rotulo="Agendamentos hoje" valor={m?.total ?? '—'} detalhe={`${m?.confirmados ?? 0} confirmados`} />
        <Metrica
          rotulo="Faturamento de hoje"
          valor={m?.faturamentoFormatado ?? '—'}
          detalhe={`${m?.concluidos ?? 0} atendimento(s) concluido(s)`}
          tom="sucesso"
        />
      </div>

      {c?.naFila > 0 && (
        <Cartao
          titulo={`${c.naFila} cliente(s) esperando por uma pessoa`}
          acao={
            <Link to="/conversas?filtro=fila">
              <Botao tamanho="sm">Ver a fila</Botao>
            </Link>
          }
        >
          <p className="texto-suave">
            Estes clientes pediram para falar com um atendente. Quanto mais rapido alguem assumir, melhor
            a experiencia — e a metrica de primeira resposta.
          </p>
        </Cartao>
      )}

      <Cartao
        titulo="Agenda de hoje"
        semPadding
        acao={
          <Link to="/agenda">
            <Botao variante="secundario" tamanho="sm">
              Ver agenda completa
            </Botao>
          </Link>
        }
      >
        {agenda.isLoading ? (
          <Carregando />
        ) : proximos.length === 0 ? (
          <Vazio
            titulo="Nenhum atendimento marcado para hoje"
            descricao="Quando um horario for agendado — por voce ou pela IA no WhatsApp — ele aparece aqui."
            acao={
              <Link to="/agenda">
                <Botao tamanho="sm">Marcar um horario</Botao>
              </Link>
            }
          />
        ) : (
          <Tabela cabecalho={['Horario', 'Cliente', 'Servico', 'Profissional', 'Status']}>
            {proximos.map((a) => (
              <tr key={a.id}>
                <td className="mono">
                  {a.horaInicio} — {a.horaFim}
                </td>
                <td>
                  <strong>{a.leadNome}</strong>
                  <div className="texto-fraco">{a.leadTelefoneFormatado}</div>
                </td>
                <td>{a.servicoNome}</td>
                <td>{a.profissionalNome}</td>
                <td>
                  <Status valor={a.status} />
                </td>
              </tr>
            ))}
          </Tabela>
        )}
      </Cartao>

      {c?.atendentes?.length > 0 && (
        <Cartao titulo="Equipe online agora">
          <div className="grade">
            {c.atendentes.map((a) => (
              <Metrica
                key={a.id}
                rotulo={a.nome}
                valor={`${a.emAtendimento}/${a.capacidade}`}
                detalhe={a.disponivel ? 'Pode receber mais' : 'Na capacidade maxima'}
                tom={a.disponivel ? 'sucesso' : 'alerta'}
              />
            ))}
          </div>
        </Cartao>
      )}
    </div>
  );
}
