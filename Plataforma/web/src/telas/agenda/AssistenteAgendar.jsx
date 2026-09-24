import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Aviso, Botao, Campo, Carregando, Entrada, Modal } from '../../componentes/ui.jsx';

/**
 * Marcacao em etapas: uma decisao por tela.
 *
 *   1 Cliente -> 2 Servico e profissional -> 3 Dia e horario -> 4 Confirmar
 *
 * A ordem importa: so depois de saber servico, profissional e dia da para
 * calcular os horarios que realmente cabem. Trocar o servico invalida o
 * profissional e a hora ja escolhidos.
 */

const ETAPAS = ['Cliente', 'Servico', 'Horario', 'Confirmar'];

function dataPorExtenso(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  const t = new Date(a, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function Passos({ atual, aoIr }) {
  return (
    <ol className="passos" aria-label="Etapas do agendamento">
      {ETAPAS.map((nome, i) => {
        const estado = i < atual ? 'feito' : i === atual ? 'atual' : 'futuro';
        return (
          <li
            key={nome}
            className={`passos__item passos__item--${estado}`}
            aria-current={estado === 'atual' ? 'step' : undefined}
          >
            <button type="button" className="passos__botao" disabled={i >= atual} onClick={() => aoIr(i)}>
              <span className="passos__bolinha">{estado === 'feito' ? '✓' : i + 1}</span>
              <span className="passos__nome">{nome}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * @param {object} p
 * @param {string} p.dataInicial
 * @param {object} [p.clienteInicial]  quando ja se sabe de quem e o horario
 *                                     (veio da ficha do contato): comeca na
 *                                     escolha do servico, sem repetir a busca
 *                                     que a pessoa acabou de fazer.
 */
export function AssistenteAgendar({ dataInicial, clienteInicial = null, aoFechar, aoSalvar }) {
  const [etapa, setEtapa] = useState(clienteInicial ? 1 : 0);
  const [cliente, setCliente] = useState(clienteInicial);
  const [servico, setServico] = useState(null);
  const [profissional, setProfissional] = useState(null);
  const [data, setData] = useState(dataInicial);
  const [hora, setHora] = useState('');
  const [observacoes, setObservacoes] = useState('');
  const [busca, setBusca] = useState('');

  const contatos = useQuery({
    queryKey: ['leads', 'busca-agendar', busca],
    queryFn: () => api.get('/api/leads', { busca, limite: 8 })
  });
  const servicos = useQuery({ queryKey: ['servicos'], queryFn: () => api.get('/api/servicos') });

  const horarios = useQuery({
    queryKey: ['horarios', servico?.id, profissional?.id, data],
    queryFn: () =>
      api.get('/api/agenda/horarios-livres', { data, serviceId: servico.id, professionalId: profissional.id }),
    enabled: etapa === 2 && Boolean(servico && profissional && data)
  });

  const criar = useMutation({ mutationFn: (dados) => api.post('/api/agenda', dados), onSuccess: aoSalvar });

  const podeAvancar = [Boolean(cliente), Boolean(servico && profissional), Boolean(hora), true][etapa];
  const ultima = etapa === ETAPAS.length - 1;

  function confirmar() {
    criar.mutate({
      leadId: cliente.id,
      serviceId: servico.id,
      professionalId: profissional.id,
      data,
      hora,
      observacoes: observacoes || undefined
    });
  }

  return (
    <Modal
      titulo="Marcar horario"
      aberto
      aoFechar={aoFechar}
      largura={600}
      rodape={
        <>
          <Botao variante="secundario" onClick={etapa === 0 ? aoFechar : () => setEtapa(etapa - 1)}>
            {etapa === 0 ? 'Cancelar' : 'Voltar'}
          </Botao>
          {ultima ? (
            <Botao carregando={criar.isPending} onClick={confirmar}>
              Confirmar agendamento
            </Botao>
          ) : (
            <Botao disabled={!podeAvancar} onClick={() => setEtapa(etapa + 1)}>
              Continuar
            </Botao>
          )}
        </>
      }
    >
      <Passos atual={etapa} aoIr={setEtapa} />

      {criar.isError && <Aviso tom="perigo">{criar.error.message}</Aviso>}

      {etapa === 0 && (
        <section className="etapa">
          <h3 className="etapa__titulo">Para quem e o horario?</h3>
          <Entrada
            autoFocus
            placeholder="Digite o nome ou telefone para buscar..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
          <div className="opcoes">
            {contatos.isLoading && <Carregando texto="Buscando..." />}
            {(contatos.data?.itens ?? []).map((c) => (
              <button
                key={c.id}
                type="button"
                className={`opcao ${cliente?.id === c.id ? 'opcao--marcada' : ''}`}
                onClick={() => {
                  setCliente(c);
                  setEtapa(1);
                }}
              >
                <strong>{c.nome}</strong>
                <span>{c.telefoneFormatado}</span>
              </button>
            ))}
          </div>
          {contatos.data && contatos.data.itens.length === 0 && (
            <p className="texto-fraco">Nenhum cliente encontrado com esse nome.</p>
          )}
        </section>
      )}

      {etapa === 1 && (
        <section className="etapa">
          <h3 className="etapa__titulo">Qual servico?</h3>
          <div className="opcoes">
            {servicos.isLoading && <Carregando texto="Carregando servicos..." />}
            {(servicos.data?.servicos ?? []).map((s) => (
              <button
                key={s.id}
                type="button"
                className={`opcao ${servico?.id === s.id ? 'opcao--marcada' : ''}`}
                onClick={() => {
                  if (servico?.id !== s.id) {
                    setServico(s);
                    setProfissional(null);
                    setHora('');
                  }
                }}
              >
                <strong>{s.nome}</strong>
                <span>
                  {s.precoFormatado} · {s.duracaoMinutos} min
                </span>
              </button>
            ))}
          </div>

          {servico && (
            <>
              <h3 className="etapa__titulo">Com quem?</h3>
              {(servico.profissionais ?? []).length === 0 && (
                <Aviso tom="alerta">Nenhum profissional realiza este servico. Vincule um em Equipe.</Aviso>
              )}
              <div className="opcoes">
                {(servico.profissionais ?? []).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`opcao ${profissional?.id === p.id ? 'opcao--marcada' : ''}`}
                    onClick={() => {
                      setProfissional(p);
                      setHora('');
                      setEtapa(2);
                    }}
                  >
                    <strong>{p.nome}</strong>
                    <span>
                      {p.precoFormatado} · {p.duracaoMinutos} min
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {etapa === 2 && (
        <section className="etapa">
          <h3 className="etapa__titulo">Que dia e horario?</h3>
          <Campo rotulo="Dia">
            <Entrada
              type="date"
              value={data}
              onChange={(e) => {
                setData(e.target.value);
                setHora('');
              }}
            />
          </Campo>
          {data && <p className="etapa__dica">{dataPorExtenso(data)}</p>}

          {horarios.isLoading ? (
            <Carregando texto="Consultando a agenda..." />
          ) : horarios.isError ? (
            <Aviso tom="alerta">{horarios.error.message}</Aviso>
          ) : (horarios.data?.horarios ?? []).length === 0 ? (
            <Aviso tom="alerta">Nenhum horario livre neste dia para {profissional.nome}. Tente outro dia.</Aviso>
          ) : (
            <div className="horas">
              {horarios.data.horarios.map((h) => (
                <button
                  key={h.hora}
                  type="button"
                  className={`hora ${hora === h.hora ? 'hora--marcada' : ''}`}
                  onClick={() => {
                    setHora(h.hora);
                    setEtapa(3);
                  }}
                >
                  {h.hora}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {etapa === 3 && (
        <section className="etapa">
          <h3 className="etapa__titulo">Confere antes de confirmar</h3>
          <dl className="resumo">
            <div>
              <dt>Cliente</dt>
              <dd>
                {cliente.nome}
                <small>{cliente.telefoneFormatado}</small>
              </dd>
            </div>
            <div>
              <dt>Servico</dt>
              <dd>
                {servico.nome}
                <small>
                  {profissional.precoFormatado} · {profissional.duracaoMinutos} min
                </small>
              </dd>
            </div>
            <div>
              <dt>Profissional</dt>
              <dd>{profissional.nome}</dd>
            </div>
            <div>
              <dt>Quando</dt>
              <dd>
                {dataPorExtenso(data)}
                <small>as {hora}</small>
              </dd>
            </div>
          </dl>
          <Campo rotulo="Observacoes (opcional)">
            <Entrada value={observacoes} onChange={(e) => setObservacoes(e.target.value)} />
          </Campo>
        </section>
      )}
    </Modal>
  );
}
