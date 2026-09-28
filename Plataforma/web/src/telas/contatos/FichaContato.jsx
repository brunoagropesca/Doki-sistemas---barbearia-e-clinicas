import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
import { useEnviarMensagem } from './IniciarConversa.jsx';
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

  // Com atendimento aberto vai direto a ele; sem, pergunta antes (popup).
  const envio = useEnviarMensagem({ aoErro: (texto) => setRecado({ tom: 'alerta', texto }) });
  const enviarMensagem = () => envio.enviar({ id, nome: lead?.nome });

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
          <Botao variante="secundario" carregando={envio.carregando(id)} onClick={enviarMensagem}>
            Enviar mensagem
          </Botao>
          <Botao onClick={() => setAgendando(true)}>Agendar</Botao>
        </div>
      </header>
      {envio.popup}

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

          <MemoriaDaSofia leadId={lead.id} />

          <HistoricoCliente
            agendamentos={agendamentos}
            conversas={lead.historico?.conversas ?? []}
            aoAgendar={() => setAgendando(true)}
            aoEnviarMensagem={enviarMensagem}
            enviando={envio.carregando(id)}
          />
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

/* ─── O QUE A SOFIA LEMBRA ───────────────────────────────────────────── */

const ROTULOS_DA_AGENDA = {
  servicoFrequente: 'Serviço de sempre',
  profissionalPreferido: 'Costuma ser atendido por',
  ultimaVisita: 'Última visita'
};

function textoDoFato(f) {
  if (f.chave === 'ultimaVisita') {
    const data = f.data.split('-').reverse().join('/');
    // Em pedacos (nao numa string so): o "com" precisa ser um trecho proprio
    // para a traducao da tela (lib/idioma.js) alcancar.
    return (
      <>
        {data}, {f.servico}
        {f.profissional && <> com {f.profissional}</>}
      </>
    );
  }
  return `${f.nome} (${f.vezes} vezes)`;
}

/**
 * A ficha que a Sofia usa quando o cliente volta. Fica visivel e corrigivel
 * aqui porque o que ela "lembra" ela USA com o cliente: uma preferencia errada
 * precisa sair antes de virar uma sugestao estranha no WhatsApp. Fatos da
 * agenda nao se editam (vem do historico): o atendente manda ela esquecer.
 */
function MemoriaDaSofia({ leadId }) {
  const queryClient = useQueryClient();
  const chave = ['lead-memoria', leadId];
  const consulta = useQuery({ queryKey: chave, queryFn: () => api.get(`/api/leads/${leadId}/memoria`) });
  const [editando, setEditando] = useState(null); // { lista, indice, texto }

  const salvar = useMutation({
    mutationFn: (corpo) => api.put(`/api/leads/${leadId}/memoria`, corpo),
    onSuccess: (r) => {
      queryClient.setQueryData(chave, r);
      setEditando(null);
    }
  });

  const memoria = consulta.data?.memoria;
  const trocarItem = (lista, indice, novoTexto) => {
    const itens = [...memoria[lista]];
    if (novoTexto == null) itens.splice(indice, 1);
    else itens[indice] = novoTexto;
    salvar.mutate({ [lista]: itens });
  };

  const itensDaLista = (lista) =>
    (memoria?.[lista] ?? []).map((texto, indice) => {
      const emEdicao = editando?.lista === lista && editando.indice === indice;
      return (
        <li key={`${lista}-${indice}`} className="memoria__item">
          {emEdicao ? (
            <form
              className="memoria__edicao"
              onSubmit={(e) => {
                e.preventDefault();
                if (editando.texto.trim()) trocarItem(lista, indice, editando.texto.trim());
              }}
            >
              <Entrada
                autoFocus
                maxLength={80}
                value={editando.texto}
                aria-label="Corrigir item"
                onChange={(e) => setEditando({ ...editando, texto: e.target.value })}
              />
              <Botao tamanho="sm" type="submit" carregando={salvar.isPending}>Salvar</Botao>
              <Botao tamanho="sm" variante="fantasma" type="button" onClick={() => setEditando(null)}>Cancelar</Botao>
            </form>
          ) : (
            <>
              <span className="memoria__texto">
                <span className="memoria__rotulo">{lista === 'preferencias' ? 'Preferência' : 'Observação'}</span>
                {texto}
              </span>
              <span className="memoria__acoes">
                <Botao tamanho="sm" variante="fantasma" onClick={() => setEditando({ lista, indice, texto })}>Corrigir</Botao>
                <Botao tamanho="sm" variante="fantasma" disabled={salvar.isPending} onClick={() => trocarItem(lista, indice, null)}>Apagar</Botao>
              </span>
            </>
          )}
        </li>
      );
    });

  let corpo;
  if (consulta.isLoading) corpo = <Carregando />;
  else if (consulta.isError) corpo = <Aviso tom="perigo">{consulta.error.message}</Aviso>;
  else if (consulta.data?.restrita) corpo = <p className="texto-fraco memoria__vazio">Visível só para quem atende este cliente.</p>;
  else if (!memoria.agenda.length && !memoria.preferencias.length && !memoria.observacoes.length) {
    corpo = (
      <p className="texto-fraco memoria__vazio">
        Ainda nada. A ficha se forma sozinha: pela agenda, a cada atendimento concluído, e pelo que o cliente contar nas conversas.
      </p>
    );
  } else {
    corpo = (
      <ul className="memoria">
        {memoria.agenda.map((f) => (
          <li key={f.chave} className="memoria__item">
            <span className="memoria__texto">
              <span className="memoria__rotulo">{ROTULOS_DA_AGENDA[f.chave]}</span>
              {textoDoFato(f)}
            </span>
            <span className="memoria__acoes">
              <Botao
                tamanho="sm"
                variante="fantasma"
                disabled={salvar.isPending}
                title="Vem da agenda. A Sofia deixa de usar até o dado mudar."
                onClick={() => salvar.mutate({ esquecer: [f.chave] })}
              >
                Esquecer
              </Botao>
            </span>
          </li>
        ))}
        {itensDaLista('preferencias')}
        {itensDaLista('observacoes')}
      </ul>
    );
  }

  return (
    <section className="cartao">
      <header className="cartao__topo">
        <h2 className="cartao__titulo">O que a Sofia lembra</h2>
      </header>
      <div className="cartao__corpo coluna">
        <p className="texto-fraco memoria__explica">
          Usado quando o cliente volta, para ela sugerir o de sempre sem perguntar tudo de novo.
        </p>
        {salvar.isError && <Aviso tom="perigo">{salvar.error.message}</Aviso>}
        {corpo}
      </div>
    </section>
  );
}

/* ─── HISTORICO: agendamentos e atendimentos, por chips ────────────────── */

const ABAS_HISTORICO = [
  { chave: 'agendamentos', rotulo: 'Agendamentos' },
  { chave: 'atendimentos', rotulo: 'Atendimentos' }
];

const hora = (valor) => new Date(valor).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dia = (valor) => new Date(valor).toLocaleDateString('pt-BR');
const reais = (centavos) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** "12 min", "3 h", "2 dias": quanto tempo o atendimento ficou aberto. */
function duracao(inicio, fim) {
  const min = Math.round((new Date(fim) - new Date(inicio)) / 60_000);
  if (!Number.isFinite(min) || min < 1) return null;
  if (min < 60) return `${min} min`;
  const horas = Math.round(min / 60);
  if (horas < 24) return `${horas} h`;
  const dias = Math.round(horas / 24);
  return `${dias} dia${dias > 1 ? 's' : ''}`;
}

/** Quem cuidou do atendimento, em palavras. */
function quemAtendeu(c) {
  if (c.atendenteNome) return c.atendenteNome;
  if (c.status === 'na_fila') return 'Esperando um atendente';
  return 'Sofia (IA)';
}

/**
 * Historico do cliente, com dois lados navegaveis por chips:
 *
 *  - Agendamentos: os horarios marcados (o que ele fez, com quem, quanto).
 *  - Atendimentos: as conversas (quem atendeu, o resumo que a IA escreveu ao
 *    fechar, as anotacoes da equipe). E o lado que responde "o que ele queria
 *    da ultima vez?" — inclusive quando a conversa nao virou horario nenhum.
 *
 * O chip escolhido fica no endereco (`?historico=`): voltar de uma conversa
 * aberta daqui cai de novo no lado certo.
 */
function HistoricoCliente({ agendamentos, conversas, aoAgendar, aoEnviarMensagem, enviando }) {
  const [params, setParams] = useSearchParams();
  const aba = params.get('historico') === 'atendimentos' ? 'atendimentos' : 'agendamentos';
  const total = { agendamentos: agendamentos.length, atendimentos: conversas.length };

  function trocar(chave) {
    const novos = new URLSearchParams(params);
    if (chave === 'agendamentos') novos.delete('historico');
    else novos.set('historico', chave);
    setParams(novos, { replace: true });
  }

  return (
    <section className="cartao">
      <header className="cartao__topo">
        <h2 className="cartao__titulo">Histórico</h2>
        <div className="historico-chips" role="tablist" aria-label="Tipo de histórico">
          {ABAS_HISTORICO.map((a) => (
            <button
              key={a.chave}
              type="button"
              role="tab"
              aria-selected={aba === a.chave}
              className={`filtro-crm${aba === a.chave ? ' filtro-crm--ativo' : ''}`}
              onClick={() => trocar(a.chave)}
            >
              {a.rotulo} <small>{total[a.chave]}</small>
            </button>
          ))}
        </div>
      </header>

      <div className="cartao__corpo" role="tabpanel">
        {aba === 'agendamentos' ? (
          <ListaAgendamentos agendamentos={agendamentos} aoAgendar={aoAgendar} />
        ) : (
          <ListaAtendimentos conversas={conversas} aoEnviarMensagem={aoEnviarMensagem} enviando={enviando} />
        )}
      </div>
    </section>
  );
}

function ListaAgendamentos({ agendamentos, aoAgendar }) {
  if (agendamentos.length === 0) {
    return (
      <Vazio
        titulo="Ainda não veio nenhuma vez"
        descricao="Quando este cliente marcar um horário, ele aparece aqui."
        acao={<Botao onClick={aoAgendar}>Marcar o primeiro horário</Botao>}
      />
    );
  }

  return (
    <ol className="historico">
      {agendamentos.map((a) => {
        const valor = (a.precoCentavos ?? 0) - (a.descontoCentavos ?? 0);
        return (
          <li key={a.id} className={`historico__item historico__item--${a.status}`}>
            <div className="historico__quando">
              <strong>{dia(a.inicioEm)}</strong>
              <span className="mono texto-fraco">
                {hora(a.inicioEm)}
                {a.fimEm ? ` – ${hora(a.fimEm)}` : ''}
              </span>
            </div>
            <div className="historico__corpo">
              <strong>{a.servicoNome ?? 'Serviço removido'}</strong>
              <span className="texto-fraco">
                com {a.profissionalNome ?? 'profissional removido'}
                {valor > 0 && <span className="mono"> · {reais(valor)}</span>}
              </span>
            </div>
            <div className="historico__lado">
              <Status valor={a.status} />
              {a.conversationId && (
                <Link className="historico__link" to={`/conversas?id=${a.conversationId}`}>
                  Ver conversa
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ListaAtendimentos({ conversas, aoEnviarMensagem, enviando }) {
  if (conversas.length === 0) {
    return (
      <Vazio
        titulo="Nenhum atendimento ainda"
        descricao="Cada conversa com este cliente — com a Sofia ou com a equipe — aparece aqui, com o resumo do que foi tratado."
        acao={
          <Botao variante="secundario" carregando={enviando} onClick={aoEnviarMensagem}>
            Enviar mensagem
          </Botao>
        }
      />
    );
  }

  return (
    <ol className="historico">
      {conversas.map((c) => (
        <ItemAtendimento key={c.id} c={c} />
      ))}
    </ol>
  );
}

function ItemAtendimento({ c }) {
  const [aberto, setAberto] = useState(false);
  const inicio = c.iniciadaEm ?? c.ultimaMensagemEm;
  const tempo = c.finalizadaEm && inicio ? duracao(inicio, c.finalizadaEm) : null;
  const humor = HUMORES[c.humor];
  // Sem resumo (conversa ainda aberta, ou fechada antes do resumo existir):
  // a ultima mensagem ao menos diz do que se tratava.
  const texto = c.resumo || (c.ultimaMensagemPreview ? `Última mensagem: “${c.ultimaMensagemPreview}”` : '');
  const longo = texto.length > 160 || Boolean(c.anotacoesHumanas);

  return (
    <li className={`historico__item historico__item--atendimento historico__item--${c.status}`}>
      <div className="historico__quando">
        <strong>{inicio ? dia(inicio) : '—'}</strong>
        {inicio && <span className="mono texto-fraco">{hora(inicio)}</span>}
      </div>

      <div className="historico__corpo">
        <strong>{quemAtendeu(c)}</strong>
        <span className="texto-fraco">
          {c.totalMensagensCliente ?? 0} {c.totalMensagensCliente === 1 ? 'mensagem' : 'mensagens'} do cliente
          {tempo && ` · durou ${tempo}`}
          {humor && ` · ${humor.icone} ${humor.rotulo}`}
        </span>
        {texto && <p className={`historico__resumo${aberto ? ' historico__resumo--aberto' : ''}`}>{texto}</p>}
        {aberto && c.anotacoesHumanas && (
          <p className="historico__anotacao">
            <strong>Anotação da equipe:</strong> {c.anotacoesHumanas}
          </p>
        )}
        {longo && (
          <button type="button" className="historico__mais" onClick={() => setAberto((a) => !a)} aria-expanded={aberto}>
            {aberto ? 'Mostrar menos' : c.anotacoesHumanas ? 'Ver resumo e anotações' : 'Ver resumo inteiro'}
          </button>
        )}
      </div>

      <div className="historico__lado">
        <Status valor={c.status} />
        <Link className="historico__link" to={`/conversas?id=${c.id}`}>
          Abrir conversa
        </Link>
      </div>
    </li>
  );
}
