import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Aviso, Carregando, Etiqueta, Modal, Status, Vazio } from '../../componentes/ui.jsx';
import { Humor } from '../conversas/Humor.jsx';

/**
 * Popup de perfil do cliente.
 *
 * Feito para crescer: cada aba e uma entrada em `SECOES`. Uma feature nova do
 * livechat (notas internas, arquivos, etiquetas, pagamentos...) entra como
 * mais uma secao, sem mexer no popup nem nas demais abas. Cada secao recebe
 * `{ lead, agendamentos, aoAbrirOS }` e cuida so do seu conteudo.
 */

/** Cartao de uma ordem de servico no historico. */
function CartaoOS({ a, aoAbrirOS }) {
  return (
    <div className="cartao-os" style={{ borderLeftColor: a.profissionalCor }}>
      <div className="linha linha--entre">
        <strong>{a.servicoNome}</strong>
        <Status valor={a.status} />
      </div>
      <div className="texto-suave">
        {a.quandoFormatado} · {a.profissionalNome}
      </div>
      <div className="linha linha--entre">
        <span className="mono">{a.totalFormatado}</span>
        <span className="linha" style={{ gap: 6 }}>
          {a.criadoPor === 'ia' && <Etiqueta tom="info">via IA</Etiqueta>}
          {a.sessaoAtiva && <Etiqueta tom="primario">Em atendimento</Etiqueta>}
        </span>
      </div>
      {a.resumoAtendimento && (
        <div className="cartao-os__resumo">
          <div className="texto-fraco">Resumo do atendimento</div>
          <p>{a.resumoAtendimento}</p>
        </div>
      )}
      {aoAbrirOS && (
        <button type="button" className="link" onClick={() => aoAbrirOS(a.id)}>
          Abrir OS
        </button>
      )}
    </div>
  );
}

/**
 * Cartao de um atendimento que NAO virou horario marcado.
 *
 * E o registro que faltava: o cliente que conversou, tirou duvida e nao
 * fechou nada tambem tem historico — e e ele que explica por que nao fechou.
 */
function CartaoAtendimento({ a }) {
  return (
    <div className="cartao-os cartao-os--atendimento">
      <div className="linha linha--entre">
        <strong>Atendimento</strong>
        <span className="linha" style={{ gap: 6 }}>
          <Humor valor={a.humor} compacto />
          <Etiqueta tom={a.encerrado ? 'neutro' : 'primario'}>{a.encerrado ? 'Encerrado' : 'Em aberto'}</Etiqueta>
        </span>
      </div>
      <div className="texto-suave">
        {a.quandoFormatado} · {a.canal}
        {a.atendenteNome ? ` · ${a.atendenteNome}` : ''}
      </div>

      {a.resumo ? (
        <p>{a.resumo}</p>
      ) : (
        <p className="texto-fraco">{a.previa ? `Ultima mensagem: ${a.previa}` : 'Sem resumo.'}</p>
      )}

      {a.anotacoes && (
        <div className="cartao-os__resumo">
          <div className="texto-fraco">Anotacoes da equipe</div>
          <p>{a.anotacoes}</p>
        </div>
      )}

      <span className="texto-fraco">Nao gerou horario marcado.</span>
    </div>
  );
}

function SecaoHistorico({ agendamentos, atendimentos, aoAbrirOS }) {
  if (agendamentos.length === 0 && atendimentos.length === 0) {
    return <Vazio titulo="Sem historico" descricao="Este cliente ainda nao foi atendido nenhuma vez." />;
  }
  return (
    <div className="cartoes-os">
      {agendamentos.map((a) => (
        <CartaoOS key={a.id} a={a} aoAbrirOS={aoAbrirOS} />
      ))}
      {atendimentos.map((a) => (
        <CartaoAtendimento key={a.id} a={a} />
      ))}
    </div>
  );
}

function SecaoResumos({ agendamentos, atendimentos }) {
  const comResumo = agendamentos.filter((a) => a.resumoAtendimento);
  const semOs = atendimentos.filter((a) => a.resumo);

  if (comResumo.length === 0 && semOs.length === 0) {
    return (
      <Vazio
        titulo="Nenhum resumo ainda"
        descricao="Os resumos aparecem quando uma sessao de atendimento e finalizada."
      />
    );
  }
  return (
    <div className="cartoes-os">
      {comResumo.map((a) => (
        <CartaoOS key={a.id} a={a} />
      ))}
      {semOs.map((a) => (
        <CartaoAtendimento key={a.id} a={a} />
      ))}
    </div>
  );
}

/** Aponte novas abas do perfil aqui. */
const SECOES = [
  { id: 'historico', titulo: 'Historico', Componente: SecaoHistorico },
  { id: 'resumos', titulo: 'Resumos de atendimento', Componente: SecaoResumos }
];

export function PerfilLead({ leadId, aoFechar, aoAbrirOS }) {
  const [secao, setSecao] = useState(SECOES[0].id);

  const lead = useQuery({ queryKey: ['lead', leadId], queryFn: () => api.get(`/api/leads/${leadId}`) });
  const historico = useQuery({
    queryKey: ['agenda', 'cliente', leadId],
    queryFn: () => api.get(`/api/agenda/cliente/${leadId}`)
  });

  const l = lead.data?.lead;
  const agendamentos = historico.data?.agendamentos ?? [];
  const atendimentos = historico.data?.atendimentos ?? [];
  const Atual = SECOES.find((s) => s.id === secao)?.Componente;

  return (
    <Modal titulo={l?.nome ?? 'Cliente'} aberto aoFechar={aoFechar} largura={720}>
      {lead.isLoading ? (
        <Carregando />
      ) : !l ? (
        <Aviso tom="perigo">Cliente nao encontrado.</Aviso>
      ) : (
        <div className="coluna">
          <div className="grade">
            <div>
              <div className="texto-fraco">Telefone</div>
              <div className="mono">{l.telefoneFormatado}</div>
            </div>
            <div>
              <div className="texto-fraco">Atendimentos concluidos</div>
              <strong>{l.concluidos ?? 0}</strong>
            </div>
            <div>
              <div className="texto-fraco">Faltas</div>
              <strong>{l.faltas ?? 0}</strong>
            </div>
            <div>
              <div className="texto-fraco">Ja gastou</div>
              <strong>{l.gastoTotalFormatado ?? '—'}</strong>
            </div>
          </div>

          {l.observacoes && (
            <div>
              <div className="texto-fraco">Anotacoes</div>
              <p>{l.observacoes}</p>
            </div>
          )}

          <div className="abas" role="tablist">
            {SECOES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={secao === s.id}
                className={`abas__aba${secao === s.id ? ' abas__aba--ativa' : ''}`}
                onClick={() => setSecao(s.id)}
              >
                {s.titulo}
              </button>
            ))}
          </div>

          {historico.isLoading ? (
            <Carregando />
          ) : (
            Atual && (
              <Atual lead={l} agendamentos={agendamentos} atendimentos={atendimentos} aoAbrirOS={aoAbrirOS} />
            )
          )}
        </div>
      )}
    </Modal>
  );
}
