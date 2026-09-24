import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { AreaTexto, Aviso, Botao, Carregando, Etiqueta, Status } from '../../componentes/ui.jsx';
import { HUMOR, Humor } from './Humor.jsx';

/**
 * Perfil do cliente dentro do livechat.
 *
 * Abre pelo nome do lead no topo da conversa e ocupa a lateral esquerda, ao
 * lado do fio de mensagens: quem esta atendendo precisa ler o historico sem
 * perder de vista o que o cliente acabou de escrever. Um modal por cima da
 * conversa faria exatamente o contrario.
 *
 * As secoes sao chips — DADOS CRM, HUMOR, RESUMO, ANOTACOES. Para acrescentar
 * uma (pagamentos, arquivos, contratos), basta uma entrada em `SECOES`.
 */

function formatarData(ms) {
  if (!ms) return null;
  return new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function Linha({ rotulo, children }) {
  return (
    <div className="painel__linha">
      <span className="texto-fraco">{rotulo}</span>
      <span>{children ?? '—'}</span>
    </div>
  );
}

function SecaoCrm({ lead, conversa, agendamentos }) {
  const proximo = agendamentos.find((a) => ['pendente', 'confirmado'].includes(a.status) && a.inicioEm > Date.now());

  return (
    <div className="painel__secao">
      <Linha rotulo="Telefone">
        <span className="mono">{lead.telefoneFormatado}</span>
      </Linha>
      {lead.endereco && <Linha rotulo="Endereco">{lead.endereco}</Linha>}
      <Linha rotulo="Canal">{conversa.canalNome ?? conversa.canal}</Linha>
      <Linha rotulo="Cliente desde">{formatarData(lead.createdAt)}</Linha>

      <div className="painel__chips">
        <Etiqueta tom="neutro">{lead.concluidos ?? 0} atendimentos</Etiqueta>
        {lead.faltas > 0 && <Etiqueta tom="perigo">{lead.faltas} falta(s)</Etiqueta>}
        <Etiqueta tom="sucesso">{lead.gastoTotalFormatado ?? 'R$ 0,00'}</Etiqueta>
        {!lead.aceitaCampanha && <Etiqueta tom="alerta">Nao aceita campanha</Etiqueta>}
        {(lead.tags ?? []).map((t) => (
          <Etiqueta key={t} tom="info">
            {t}
          </Etiqueta>
        ))}
      </div>

      <div className="painel__bloco">
        <div className="texto-fraco">Proximo horario</div>
        {proximo ? (
          <p>
            {proximo.quandoFormatado} — {proximo.servicoNome} com {proximo.profissionalNome}
          </p>
        ) : (
          <p className="texto-fraco">Nenhum horario marcado.</p>
        )}
      </div>
    </div>
  );
}

function SecaoHumor({ conversa }) {
  const h = HUMOR[conversa.humor];

  return (
    <div className="painel__secao">
      {h ? (
        <>
          <div className="painel__humor" style={{ borderColor: h.cor }}>
            <span className="painel__humor-icone" aria-hidden="true">
              {h.icone}
            </span>
            <div>
              <strong>{h.rotulo}</strong>
              <div className="texto-fraco">
                {conversa.humorAtualizadoEm ? `Lido em ${formatarData(conversa.humorAtualizadoEm)}` : 'Do cadastro'}
              </div>
            </div>
          </div>

          <div className="painel__bloco">
            <div className="texto-fraco">Como esta o atendimento</div>
            <p>{conversa.humorResumo || 'A Sofia ainda nao escreveu um resumo deste momento.'}</p>
          </div>
        </>
      ) : (
        <p className="texto-fraco">
          A Sofia ainda nao leu o humor desta conversa. A leitura acontece a cada poucas mensagens do cliente.
        </p>
      )}

      <p className="texto-fraco">
        Quatro estados possiveis: satisfeito, neutro, em duvida e frustrado. A leitura e da IA e serve de apoio —
        confie no que voce le na conversa.
      </p>
    </div>
  );
}

function SecaoResumo({ conversa, agendamentos, atendimentos }) {
  const comResumo = agendamentos.filter((a) => a.resumoAtendimento).slice(0, 5);
  const semOs = atendimentos.filter((a) => a.id !== conversa.id && (a.resumo || a.previa)).slice(0, 5);

  return (
    <div className="painel__secao">
      <div className="painel__bloco">
        <div className="texto-fraco">Sessao atual</div>
        {conversa.resumo ? <p>{conversa.resumo}</p> : <p className="texto-fraco">Sera gerado ao finalizar.</p>}
      </div>

      <div className="painel__bloco">
        <div className="texto-fraco">Mensagens</div>
        <p>
          {conversa.totalMensagensCliente} do cliente · {conversa.totalMensagensIa} da IA ·{' '}
          {conversa.totalMensagensHumano} de atendentes
        </p>
      </div>

      <div className="painel__bloco">
        <div className="texto-fraco">Atendimentos anteriores</div>
        {comResumo.length === 0 && semOs.length === 0 ? (
          <p className="texto-fraco">Nenhum resumo registrado ainda.</p>
        ) : (
          <>
            {comResumo.map((a) => (
              <div key={a.id} className="painel__resumo">
                <div className="linha linha--entre">
                  <strong>{a.servicoNome}</strong>
                  <Status valor={a.status} />
                </div>
                <div className="texto-fraco">{a.quandoFormatado}</div>
                <p>{a.resumoAtendimento}</p>
              </div>
            ))}

            {/* Conversas que nao viraram horario: continuam sendo historico. */}
            {semOs.map((a) => (
              <div key={a.id} className="painel__resumo">
                <div className="linha linha--entre">
                  <strong>Atendimento</strong>
                  <Etiqueta tom="neutro">sem horario</Etiqueta>
                </div>
                <div className="texto-fraco">{a.quandoFormatado}</div>
                <p>{a.resumo ?? a.previa}</p>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Anotacoes, em duas metades que nunca se misturam.
 *
 * A de cima e da IA: o resumo que ela gera ao finalizar o atendimento, so de
 * leitura. A de baixo e de gente. Separar importa porque, meses depois, "o
 * cliente e alergico" ter sido escrito pela recepcionista ou deduzido por um
 * modelo muda o peso da informacao.
 */
function SecaoAnotacoes({ conversa, agendamentos }) {
  const queryClient = useQueryClient();
  const [texto, setTexto] = useState(conversa.anotacoesHumanas ?? '');
  const [sujo, setSujo] = useState(false);

  // Enquanto o atendente nao mexeu, o campo acompanha o que vier do servidor
  // (outro atendente pode ter escrito). Depois que ele digitou, o rascunho
  // manda: sobrescrever o que a pessoa esta escrevendo seria imperdoavel.
  useEffect(() => {
    if (!sujo) setTexto(conversa.anotacoesHumanas ?? '');
  }, [conversa.anotacoesHumanas, sujo]);

  const salvar = useMutation({
    mutationFn: () => api.patch(`/api/conversas/${conversa.id}/anotacoes`, { texto }),
    onSuccess: () => {
      setSujo(false);
      queryClient.invalidateQueries({ queryKey: ['conversa', conversa.id] });
    }
  });

  const daIa = agendamentos.filter((a) => a.resumoAtendimento || a.anotacoesAtendimento).slice(0, 5);

  return (
    <div className="painel__secao">
      <div className="painel__bloco">
        <div className="linha linha--entre">
          <strong>Anotacoes da IA</strong>
          <Etiqueta tom="info">automatico</Etiqueta>
        </div>
        {conversa.humorResumo && <p className="painel__nota">{conversa.humorResumo}</p>}
        {daIa.length === 0 && !conversa.humorResumo ? (
          <p className="texto-fraco">O resumo final e escrito quando o atendimento e finalizado.</p>
        ) : (
          daIa.map((a) => (
            <div key={a.id} className="painel__resumo">
              <div className="texto-fraco">
                {a.quandoFormatado} — {a.servicoNome}
              </div>
              {a.resumoAtendimento && <p>{a.resumoAtendimento}</p>}
            </div>
          ))
        )}
      </div>

      <div className="painel__bloco">
        <div className="linha linha--entre">
          <strong>Anotacoes da equipe</strong>
          <Etiqueta tom="neutro">so gente escreve</Etiqueta>
        </div>

        <AreaTexto
          value={texto}
          rows={5}
          placeholder="Preferencias, combinados, o que a proxima pessoa precisa saber..."
          onChange={(e) => {
            setTexto(e.target.value);
            setSujo(true);
          }}
        />

        <div className="linha linha--fim" style={{ marginTop: 'var(--e2)' }}>
          {salvar.isSuccess && !sujo && <span className="texto-fraco">Salvo.</span>}
          <Botao tamanho="sm" carregando={salvar.isPending} disabled={!sujo} onClick={() => salvar.mutate()}>
            Salvar anotacao
          </Botao>
        </div>

        {salvar.isError && <Aviso tom="perigo">{salvar.error.message}</Aviso>}

        <p className="texto-fraco">
          Ao finalizar o atendimento, esta anotacao e copiada para a ordem de servico do cliente.
        </p>
      </div>

      {daIa.some((a) => a.anotacoesAtendimento) && (
        <div className="painel__bloco">
          <div className="texto-fraco">De atendimentos anteriores</div>
          {daIa
            .filter((a) => a.anotacoesAtendimento)
            .map((a) => (
              <div key={a.id} className="painel__resumo">
                <div className="texto-fraco">{a.quandoFormatado}</div>
                <p>{a.anotacoesAtendimento}</p>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

const SECOES = [
  { id: 'crm', titulo: 'Dados CRM', Componente: SecaoCrm },
  { id: 'humor', titulo: 'Humor', Componente: SecaoHumor },
  { id: 'resumo', titulo: 'Resumo', Componente: SecaoResumo },
  { id: 'anotacoes', titulo: 'Anotacoes', Componente: SecaoAnotacoes }
];

export function PainelLead({ conversa, aoFechar }) {
  const [secao, setSecao] = useState('crm');

  const lead = useQuery({
    queryKey: ['lead', conversa.leadId],
    queryFn: () => api.get(`/api/leads/${conversa.leadId}`)
  });

  const historico = useQuery({
    queryKey: ['agenda', 'cliente', conversa.leadId],
    queryFn: () => api.get(`/api/agenda/cliente/${conversa.leadId}`)
  });

  const l = lead.data?.lead;
  const agendamentos = historico.data?.agendamentos ?? [];
  const atendimentos = historico.data?.atendimentos ?? [];
  const Atual = SECOES.find((s) => s.id === secao)?.Componente;

  return (
    <aside className="painel" aria-label={`Perfil de ${conversa.leadNome}`}>
      <header className="painel__topo">
        <div className="crescer">
          <strong>{conversa.leadNome}</strong>
          <div className="texto-fraco mono">{conversa.leadTelefoneFormatado}</div>
        </div>
        <Humor valor={conversa.humor} compacto />
        <button className="painel__fechar" onClick={aoFechar} aria-label="Fechar perfil">
          ×
        </button>
      </header>

      <div className="painel__abas" role="tablist">
        {SECOES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={secao === s.id}
            className={`painel__chip${secao === s.id ? ' painel__chip--ativo' : ''}`}
            onClick={() => setSecao(s.id)}
          >
            {s.titulo}
          </button>
        ))}
      </div>

      <div className="painel__corpo">
        {lead.isLoading || historico.isLoading ? (
          <Carregando />
        ) : !l ? (
          <Aviso tom="perigo">Nao consegui carregar o cadastro deste cliente.</Aviso>
        ) : (
          Atual && (
            <Atual lead={l} conversa={conversa} agendamentos={agendamentos} atendimentos={atendimentos} />
          )
        )}
      </div>
    </aside>
  );
}
