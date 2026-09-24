import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/autenticacao.jsx';
import {
  AreaTexto,
  Aviso,
  Botao,
  Campo,
  Carregando,
  Entrada,
  Etiqueta,
  FotoLead,
  Selecao,
  Status,
  Vazio
} from '../../componentes/ui.jsx';
import { AssistenteAgendar } from '../agenda/AssistenteAgendar.jsx';
import './contatos.css';

/**
 * Ficha do cliente: cadastro a esquerda, vida dele a direita.
 *
 * A divisao nao e estetica. A esquerda fica o que a empresa ESCREVE (nome,
 * endereco, anotacoes) e a direita o que o sistema APURA (quanto veio, quanto
 * gastou, o que faltou). Misturar os dois numa coluna so faria o atendente
 * rolar a tela para responder "esse cliente vale a pena?".
 */

const HUMORES = {
  satisfeito: { rotulo: 'Satisfeito', icone: '😊', tom: 'sucesso' },
  neutro: { rotulo: 'Neutro', icone: '😐', tom: 'neutro' },
  duvida: { rotulo: 'Em dúvida', icone: '🤔', tom: 'info' },
  frustrado: { rotulo: 'Frustrado', icone: '😠', tom: 'perigo' }
};

function dataCurta(valor) {
  if (!valor) return '—';
  return new Date(valor).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Interruptor com explicacao do que ele muda. */
function Chave({ ligada, rotulo, dica, aoAlternar, carregando, tom = 'primaria' }) {
  return (
    <button
      type="button"
      className={`chave ${ligada ? `chave--ligada chave--${tom}` : ''}`}
      onClick={aoAlternar}
      disabled={carregando}
      aria-pressed={ligada}
    >
      <span className="chave__trilho" aria-hidden="true">
        <span className="chave__bolinha" />
      </span>
      <span className="chave__texto">
        <strong>{rotulo}</strong>
        <small>{dica}</small>
      </span>
    </button>
  );
}

export function FichaContato() {
  const { id } = useParams();
  const navegar = useNavigate();
  const queryClient = useQueryClient();
  const { podeAcessar } = useAuth();

  const [form, setForm] = useState(null);
  const [tagNova, setTagNova] = useState('');
  const [agendando, setAgendando] = useState(false);
  const [recado, setRecado] = useState(null);

  const dados = useQuery({ queryKey: ['lead', id], queryFn: () => api.get(`/api/leads/${id}`) });
  const lead = dados.data?.lead;

  // O formulario nasce do que veio do servidor, e renasce quando o id muda:
  // sem isso, abrir outro contato mostraria os dados do anterior.
  useEffect(() => {
    if (!lead) return;
    setForm({
      nome: lead.nome,
      telefone: lead.telefoneFormatado ?? lead.telefone,
      email: lead.email ?? '',
      endereco: lead.endereco ?? '',
      observacoes: lead.observacoes ?? '',
      tags: lead.tags ?? []
    });
  }, [lead?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function aoMudar() {
    queryClient.invalidateQueries({ queryKey: ['lead', id] });
    queryClient.invalidateQueries({ queryKey: ['leads'] });
  }

  const salvar = useMutation({
    mutationFn: (dadosDoForm) => api.patch(`/api/leads/${id}`, dadosDoForm),
    onSuccess: () => {
      setRecado({ tom: 'sucesso', texto: 'Cadastro salvo.' });
      aoMudar();
    }
  });

  const alternar = useMutation({
    mutationFn: (campos) => api.patch(`/api/leads/${id}`, campos),
    onSuccess: aoMudar
  });

  const buscarFoto = useMutation({
    mutationFn: () => api.post(`/api/leads/${id}/foto`, {}),
    onSuccess: () => {
      setRecado({ tom: 'sucesso', texto: 'Foto do WhatsApp atualizada.' });
      aoMudar();
    },
    onError: (err) => setRecado({ tom: 'alerta', texto: err.message })
  });

  const excluir = useMutation({
    mutationFn: () => api.delete(`/api/leads/${id}`),
    onSuccess: () => navegar('/contatos')
  });

  const abrirConversa = useMutation({
    mutationFn: () => api.post('/api/conversas/abrir', { leadId: id }),
    onSuccess: (r) => navegar(`/conversas/${r.conversa.id}`),
    onError: (err) => setRecado({ tom: 'alerta', texto: err.message })
  });

  if (dados.isLoading || !form) return <Carregando />;
  if (dados.isError) return <Aviso tom="perigo">{dados.error.message}</Aviso>;

  const erros = salvar.error?.camposComErro ?? {};
  const agendamentos = lead.historico?.agendamentos ?? [];
  const humor = HUMORES[lead.humor];

  function adicionarTag() {
    const t = tagNova.trim();
    if (!t || form.tags.includes(t)) return setTagNova('');
    setForm({ ...form, tags: [...form.tags, t] });
    setTagNova('');
  }

  return (
    <div className="coluna">
      <header className="linha linha--entre">
        <div className="linha">
          <Botao variante="secundario" tamanho="sm" onClick={() => navegar('/contatos')}>
            ← Contatos
          </Botao>
          <h1 style={{ margin: 0 }}>{lead.nome}</h1>
        </div>

        <div className="linha">
          <Botao variante="secundario" carregando={abrirConversa.isPending} onClick={() => abrirConversa.mutate()}>
            Enviar mensagem
          </Botao>
          <Botao onClick={() => setAgendando(true)}>Agendar</Botao>
        </div>
      </header>

      {recado && (
        <Aviso tom={recado.tom} aoFechar={() => setRecado(null)}>
          {recado.texto}
        </Aviso>
      )}

      <div className="ficha">
        {/* ─── ESQUERDA: o cadastro ─────────────────────────────── */}
        <section className="cartao ficha__cadastro">
          <div className="cartao__corpo coluna">
            <div className="ficha__cabeca">
              <FotoLead nome={lead.nome} url={lead.fotoUrl} tamanho={96} />
              <div>
                <strong className="ficha__nome">{lead.nome}</strong>
                <div className="mono texto-suave">{lead.telefoneFormatado}</div>
                <Botao
                  variante="fantasma"
                  tamanho="sm"
                  carregando={buscarFoto.isPending}
                  onClick={() => buscarFoto.mutate()}
                >
                  {lead.fotoUrl ? 'Atualizar foto do WhatsApp' : 'Buscar foto do WhatsApp'}
                </Botao>
              </div>
            </div>

            {salvar.isError && salvar.error.codigo !== 'VALIDACAO' && (
              <Aviso tom="perigo">{salvar.error.message}</Aviso>
            )}

            <Campo rotulo="Nome" obrigatorio erro={erros.nome}>
              <Entrada value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
            </Campo>

            <Campo rotulo="Número" erro={erros.telefone} dica="Pode digitar com DDD, parênteses ou hífen.">
              <Entrada value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} />
            </Campo>

            <Campo rotulo="E-mail" erro={erros.email}>
              <Entrada type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Campo>

            <Campo rotulo="Endereço" erro={erros.endereco}>
              <Entrada
                value={form.endereco}
                placeholder="Rua, número, bairro"
                onChange={(e) => setForm({ ...form, endereco: e.target.value })}
              />
            </Campo>

            <Campo rotulo="Etiquetas" dica="Enter para adicionar. Servem de filtro nas campanhas.">
              <div className="linha" style={{ gap: 6 }}>
                {form.tags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="ficha__tag"
                    title="Remover etiqueta"
                    onClick={() => setForm({ ...form, tags: form.tags.filter((x) => x !== t) })}
                  >
                    {t} <span aria-hidden="true">×</span>
                  </button>
                ))}
              </div>
              <Entrada
                value={tagNova}
                placeholder="vip, alergia, indicação..."
                onChange={(e) => setTagNova(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    adicionarTag();
                  }
                }}
                style={{ marginTop: 'var(--e2)' }}
              />
            </Campo>

            <Campo rotulo="Anotações" dica="Preferências, alergias, o que for útil lembrar.">
              <AreaTexto
                value={form.observacoes}
                onChange={(e) => setForm({ ...form, observacoes: e.target.value })}
              />
            </Campo>

            <div className="linha linha--entre">
              {podeAcessar('admin') ? (
                <Botao
                  variante="perigo"
                  tamanho="sm"
                  carregando={excluir.isPending}
                  onClick={() => {
                    if (confirm(`Mover ${lead.nome} para a lixeira? O histórico é preservado.`)) excluir.mutate();
                  }}
                >
                  Apagar contato
                </Botao>
              ) : (
                <span />
              )}
              <Botao
                carregando={salvar.isPending}
                onClick={() =>
                  salvar.mutate({ ...form, email: form.email || undefined })
                }
              >
                Salvar cadastro
              </Botao>
            </div>
          </div>
        </section>

        {/* ─── DIREITA: os números e a vida do cliente ──────────── */}
        <div className="coluna">
          <section className="cartao">
            <header className="cartao__topo">
              <h2 className="cartao__titulo">Resumo do cliente</h2>
              {humor && (
                <Etiqueta tom={humor.tom}>
                  {humor.icone} {humor.rotulo}
                </Etiqueta>
              )}
            </header>

            <div className="cartao__corpo coluna">
              <div className="grade">
                <div className="metrica">
                  <span className="metrica__rotulo">Atendimentos</span>
                  <strong className="metrica__valor">{lead.concluidos ?? 0}</strong>
                  <span className="metrica__detalhe">{lead.totalAgendamentos ?? agendamentos.length} marcados</span>
                </div>
                <div className="metrica">
                  <span className="metrica__rotulo">Já gastou</span>
                  <strong className="metrica__valor metrica__valor--sucesso">
                    {lead.gastoTotalFormatado ?? 'R$ 0,00'}
                  </strong>
                </div>
                <div className="metrica">
                  <span className="metrica__rotulo">Faltas</span>
                  <strong className={`metrica__valor ${lead.faltas > 0 ? 'metrica__valor--perigo' : ''}`}>
                    {lead.faltas ?? 0}
                  </strong>
                </div>
                <div className="metrica">
                  <span className="metrica__rotulo">Último contato</span>
                  <strong className="metrica__valor" style={{ fontSize: 18 }}>
                    {dataCurta(lead.ultimoContatoEm)}
                  </strong>
                  <span className="metrica__detalhe">cliente desde {dataCurta(lead.createdAt)}</span>
                </div>
              </div>

              <div className="chaves">
                <Chave
                  ligada={lead.aceitaCampanha}
                  rotulo={lead.aceitaCampanha ? 'Recebe campanhas' : 'Não quer campanhas'}
                  dica={
                    lead.aceitaCampanha
                      ? 'Entra nos disparos em massa.'
                      : 'Nenhum disparo em massa alcança este cliente.'
                  }
                  carregando={alternar.isPending}
                  aoAlternar={() => alternar.mutate({ aceitaCampanha: !lead.aceitaCampanha })}
                />
                <Chave
                  ligada={lead.iaAtiva}
                  tom="sucesso"
                  rotulo={lead.iaAtiva ? 'Sofia atende' : 'Somente atendimento humano'}
                  dica={
                    lead.iaAtiva
                      ? 'A IA responde as mensagens deste cliente.'
                      : 'As mensagens dele vão direto para a fila de um atendente.'
                  }
                  carregando={alternar.isPending}
                  aoAlternar={() => alternar.mutate({ iaAtiva: !lead.iaAtiva })}
                />
              </div>
            </div>
          </section>

          <section className="cartao">
            <header className="cartao__topo">
              <h2 className="cartao__titulo">Histórico de agendamentos</h2>
              <span className="texto-fraco">{agendamentos.length} registro(s)</span>
            </header>

            <div className="cartao__corpo">
              {agendamentos.length === 0 ? (
                <Vazio
                  titulo="Ainda não veio nenhuma vez"
                  descricao="Quando este cliente marcar um horário, ele aparece aqui."
                  acao={<Botao onClick={() => setAgendando(true)}>Marcar o primeiro horário</Botao>}
                />
              ) : (
                <ol className="historico">
                  {agendamentos.map((a) => (
                    <li key={a.id} className={`historico__item historico__item--${a.status}`}>
                      <div className="historico__quando">
                        <strong>{new Date(a.inicioEm).toLocaleDateString('pt-BR')}</strong>
                        <span className="mono texto-fraco">
                          {new Date(a.inicioEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div className="historico__corpo">
                        <strong>{a.profissionalNome ?? 'Sem profissional'}</strong>
                        {a.precoCentavos > 0 && (
                          <span className="texto-fraco mono">
                            {(a.precoCentavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                          </span>
                        )}
                      </div>
                      <Status valor={a.status} />
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        </div>
      </div>

      {agendando && (
        <AssistenteAgendar
          dataInicial={new Date().toLocaleDateString('sv-SE')}
          clienteInicial={{ id: lead.id, nome: lead.nome, telefoneFormatado: lead.telefoneFormatado }}
          aoFechar={() => setAgendando(false)}
          aoSalvar={() => {
            setAgendando(false);
            setRecado({ tom: 'sucesso', texto: 'Horário marcado.' });
            aoMudar();
          }}
        />
      )}
    </div>
  );
}
