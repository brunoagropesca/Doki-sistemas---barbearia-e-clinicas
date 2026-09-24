import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { AreaTexto, Aviso, Botao, Campo, Carregando, Entrada, Etiqueta, Status } from '../../componentes/ui.jsx';
import { IconeWhatsapp } from '../../componentes/IconesContato.jsx';
import { Humor } from '../conversas/Humor.jsx';
import './DetalheOS.css';

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
/** O caminho normal de uma OS, na ordem — a barra de etapas segue ele. */
const ETAPAS = [
  ['pendente', 'Marcado'],
  ['confirmado', 'Confirmado'],
  ['em_andamento', 'Em atendimento'],
  ['concluido', 'Concluído']
];
const ORIGEM = { ia: 'pela Sofia (IA)', humano: 'pela equipe', cliente: 'pelo próprio cliente', sistema: 'pelo sistema' };
/** Tempo da animacao de saida (igual ao CSS). */
const SAIDA_MS = 220;

const paraReais = (centavos) => (centavos / 100).toFixed(2).replace('.', ',');
const paraCentavos = (texto) => Math.round(Number(String(texto).replace(/\./g, '').replace(',', '.')) * 100) || 0;
const reais = (centavos) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataHora = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
/** '2026-09-16' -> '16/09/26' (curto: cabe no quadrinho). */
const dataCurta = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : '—');
/** 'ago/26' */
const mesAno = (ms) => {
  const d = new Date(ms);
  return `${d.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}/${String(d.getFullYear()).slice(2)}`;
};

/** "daqui a 2 h", "há 3 dias" — quando a OS acontece em relacao a agora. */
function relativo(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  let texto;
  if (min < 1) return 'agora';
  if (min < 60) texto = `${min} min`;
  else if (min < 60 * 24) texto = `${Math.round(min / 60)} h`;
  else texto = `${Math.round(min / (60 * 24))} dia${Math.round(min / (60 * 24)) === 1 ? '' : 's'}`;
  return diff > 0 ? `daqui a ${texto}` : `há ${texto}`;
}

/**
 * Ordem de servico num painel que entra pela direita: a agenda continua
 * visivel ao lado e o painel tem altura para mostrar tudo que importa no
 * balcao — cliente (historico, etiquetas, alergias), valores, vendas, a
 * linha do tempo e as acoes.
 */
export function DetalheOS({ id, aoFechar, aoAbrirPerfil, podeExcluir, abrirEditando = false }) {
  const queryClient = useQueryClient();
  const [editando, setEditando] = useState(abrirEditando);
  const [saindo, setSaindo] = useState(false);

  // Fecha com animacao: o painel desliza de volta antes de sumir.
  const fechar = () => {
    setSaindo(true);
    setTimeout(aoFechar, SAIDA_MS);
  };

  useEffect(() => {
    const aoTeclar = (e) => e.key === 'Escape' && fechar();
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      fechar();
    }
  });

  const erro = mudarStatus.error ?? excluir.error ?? arquivar.error;

  return createPortal(
    <div className={`os-fundo${saindo ? ' os-fundo--saindo' : ''}`} onClick={fechar} role="presentation">
      <aside
        className={`os${saindo ? ' os--saindo' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Ordem de serviço"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="os__topo">
          <div className="os__rotulo">
            <span>Ordem de serviço</span>
            {a && <span className="os__numero">#{a.id.slice(-6).toUpperCase()}</span>}
          </div>
          <button type="button" className="os__fechar" onClick={fechar} aria-label="Fechar">
            ×
          </button>
        </header>

        <div className="os__corpo">
          {dados.isLoading ? (
            <Carregando />
          ) : !a ? (
            <Aviso tom="perigo">Ordem de serviço não encontrada.</Aviso>
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
            <>
              {erro && <Aviso tom="perigo">{erro.message}</Aviso>}
              <Cabecalho a={a} />
              <Etapas status={a.status} />

              {(PROXIMOS[a.status] ?? []).length > 0 && (
                <div className="os__acoes">
                  {PROXIMOS[a.status].map(([status, rotulo]) => (
                    <Botao
                      key={status}
                      variante={status === 'cancelado' || status === 'faltou' ? 'secundario' : 'primario'}
                      tamanho="sm"
                      carregando={mudarStatus.isPending && mudarStatus.variables?.status === status}
                      onClick={() => mudarStatus.mutate({ status }, { onSuccess: () => dados.refetch() })}
                    >
                      {rotulo}
                    </Botao>
                  ))}
                </div>
              )}

              <Cliente a={a} aoAbrirPerfil={aoAbrirPerfil} />
              <Valores a={a} />
              <Notas a={a} />
              <LinhaDoTempo a={a} />
            </>
          )}
        </div>

        {a && !editando && (
          <footer className="os__rodape">
            {podeExcluir && (
              <Botao
                variante="fantasma"
                className="os__excluir"
                carregando={excluir.isPending}
                onClick={() => {
                  if (confirm('Excluir esta ordem de serviço? Ela some da agenda e dos relatórios.')) excluir.mutate();
                }}
              >
                Excluir
              </Botao>
            )}
            <span className="crescer" />
            {ENCERRADOS.includes(a.status) ? (
              <Botao variante="secundario" carregando={arquivar.isPending} onClick={() => arquivar.mutate(Boolean(a.arquivadoEm))}>
                {a.arquivadoEm ? 'Desarquivar' : 'Arquivar'}
              </Botao>
            ) : (
              <Botao variante="secundario" onClick={() => setEditando(true)}>
                Editar / remarcar
              </Botao>
            )}
          </footer>
        )}
      </aside>
    </div>,
    document.body
  );
}

// ─── Blocos do painel ──────────────────────────────────────────────────────

function Cabecalho({ a }) {
  const diaLongo = new Date(a.inicioEm).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  const dia = diaLongo.charAt(0).toUpperCase() + diaLongo.slice(1);
  return (
    <section className="os-cab">
      <div className="os-cab__etiquetas">
        <Status valor={a.status} />
        {a.sessaoAtiva && <Etiqueta tom="primario">Em atendimento no WhatsApp</Etiqueta>}
        {a.criadoPor === 'ia' && <Etiqueta tom="info">via IA</Etiqueta>}
        {a.arquivadoEm && <Etiqueta tom="neutro">Arquivada</Etiqueta>}
      </div>
      <h2 className="os-cab__servico">{a.servicoNome}</h2>
      <div className="os-cab__quando">
        <span className="os-cab__dia">{dia}</span>
        <span className="os-cab__hora">
          {a.horaInicio} – {a.horaFim}
        </span>
        <span className="texto-fraco">
          {a.duracaoMinutos} min · {relativo(a.inicioEm)}
        </span>
      </div>
      <div className="os-cab__prof">
        <span className="os-cab__cor" style={{ background: a.profissionalCor }} aria-hidden="true" />
        com <strong>{a.profissionalNome}</strong>
      </div>
    </section>
  );
}

/** Barra de etapas: onde a OS esta no caminho marcado → concluido. */
function Etapas({ status }) {
  const fora = status === 'cancelado' || status === 'faltou';
  const atual = ETAPAS.findIndex(([s]) => s === status);
  return (
    <ol className={`os-etapas${fora ? ' os-etapas--fora' : ''}`} aria-label="Andamento">
      {ETAPAS.map(([s, rotulo], i) => {
        const feito = !fora && i <= atual;
        return (
          <li key={s} className={`os-etapas__item${feito ? ' os-etapas__item--feito' : ''}${!fora && i === atual ? ' os-etapas__item--atual' : ''}`}>
            <span className="os-etapas__ponto" aria-hidden="true">{feito && (i < atual || status === 'concluido') ? '✓' : i + 1}</span>
            <span className="os-etapas__rotulo">{rotulo}</span>
          </li>
        );
      })}
      {fora && <li className="os-etapas__fora">{status === 'faltou' ? '✕ Cliente faltou' : '✕ Cancelado'}</li>}
    </ol>
  );
}

function Cliente({ a, aoAbrirPerfil }) {
  const c = a.contexto?.cliente;
  const inicial = (a.leadNome ?? '?').trim().charAt(0).toUpperCase();
  const whatsapp = a.leadTelefone ? `https://wa.me/${String(a.leadTelefone).replace(/\D/g, '')}` : null;
  return (
    <section className="os-bloco">
      <h3 className="os-bloco__titulo">Cliente</h3>
      <div className="os-cliente">
        <span className="os-cliente__foto" aria-hidden="true">{inicial}</span>
        <div className="os-cliente__nome">
          <button type="button" className="link" onClick={() => aoAbrirPerfil?.(a.leadId)}>
            {a.leadNome}
          </button>
          <span className="texto-fraco">{a.leadTelefoneFormatado}</span>
        </div>
        <div className="os-cliente__atalhos">
          {a.conversationId && (
            <Link className="os-atalho" to={`/conversas?id=${a.conversationId}`} title="Abrir a conversa deste agendamento">
              💬
            </Link>
          )}
          {whatsapp && (
            <a className="os-atalho" href={whatsapp} target="_blank" rel="noreferrer" title="Abrir no WhatsApp">
              <IconeWhatsapp tamanho={20} />
            </a>
          )}
        </div>
      </div>

      {c && (
        <>
          <dl className="os-numeros">
            <div>
              <dt>Visitas</dt>
              <dd>{c.visitas === 0 ? '1ª vez' : c.visitas}</dd>
            </div>
            <div>
              <dt>Última visita</dt>
              <dd>{dataCurta(c.ultimaVisita)}</dd>
            </div>
            <div>
              <dt>Já gastou</dt>
              <dd>{reais(c.gastoCentavos)}</dd>
            </div>
            <div>
              <dt>Cliente desde</dt>
              <dd>{c.desde ? mesAno(c.desde) : '—'}</dd>
            </div>
          </dl>
          {c.visitas === 0 && <p className="os-destaque os-destaque--novo">✨ Primeira visita — capriche na recepção.</p>}
          {c.faltas > 0 && (
            <p className="os-destaque os-destaque--alerta">
              ⚠ Já faltou {c.faltas} vez{c.faltas === 1 ? '' : 'es'} — vale confirmar antes.
            </p>
          )}
          {c.tags?.length > 0 && (
            <div className="os-tags">
              {c.tags.map((t) => (
                <span key={t} className="os-tag">
                  {t}
                </span>
              ))}
            </div>
          )}
          {c.observacoes && <p className="os-nota">📝 {c.observacoes}</p>}
        </>
      )}
    </section>
  );
}

function Valores({ a }) {
  const vendas = a.contexto?.vendas ?? [];
  const totalVendas = vendas.reduce((s, v) => s + v.totalCentavos, 0);
  return (
    <section className="os-bloco">
      <h3 className="os-bloco__titulo">Valores</h3>
      <div className="os-conta">
        <div className="os-conta__linha">
          <span>{a.servicoNome}</span>
          <span>{reais(a.precoCentavos)}</span>
        </div>
        {a.descontoCentavos > 0 && (
          <div className="os-conta__linha os-conta__linha--desconto">
            <span>Desconto</span>
            <span>− {reais(a.descontoCentavos)}</span>
          </div>
        )}
        {vendas.map((v, i) => (
          <div key={i} className="os-conta__linha">
            <span>
              {v.produto} <small className="texto-fraco">×{v.quantidade}</small>
            </span>
            <span>{reais(v.totalCentavos)}</span>
          </div>
        ))}
        <div className="os-conta__total">
          <span>Total</span>
          <strong>{reais(a.totalCentavos + totalVendas)}</strong>
        </div>
      </div>
    </section>
  );
}

function Notas({ a }) {
  const itens = [
    a.observacoes && ['Observações do agendamento', a.observacoes],
    a.motivoCancelamento && ['Motivo do cancelamento', a.motivoCancelamento],
    a.anotacoesAtendimento && ['Anotações da equipe', a.anotacoesAtendimento]
  ].filter(Boolean);
  return (
    <section className="os-bloco">
      <h3 className="os-bloco__titulo">
        Atendimento
        {a.humorAtendimento && <Humor valor={a.humorAtendimento} />}
      </h3>
      <div className="os-resumo">
        {a.resumoAtendimento ? (
          <p>{a.resumoAtendimento}</p>
        ) : (
          <p className="texto-fraco">
            {a.sessaoAtiva ? 'O resumo aparece quando a conversa de atendimento for finalizada.' : 'Sem resumo registrado.'}
          </p>
        )}
      </div>
      {itens.map(([t, v]) => (
        <div key={t} className="os-item">
          <span className="texto-fraco">{t}</span>
          <p>{v}</p>
        </div>
      ))}
      {a.checklist?.length > 0 && (
        <ul className="os-checklist">
          {a.checklist.map((item, i) => (
            <li key={i} className={item.feito ? 'os-checklist__feito' : ''}>
              {item.feito ? '☑' : '☐'} {item.texto ?? item.titulo ?? String(item)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LinhaDoTempo({ a }) {
  const quem = a.contexto?.criadoPorNome ?? a.responsavelNome;
  const eventos = [
    [a.createdAt, `Marcado ${ORIGEM[a.criadoPor] ?? ''}${quem && a.criadoPor === 'humano' ? ` (${quem})` : ''}`],
    a.confirmadoEm && [a.confirmadoEm, 'Confirmado'],
    a.status === 'em_andamento' && [a.inicioEm, 'Atendimento começou'],
    a.concluidoEm && [a.concluidoEm, 'Concluído'],
    a.canceladoEm && [a.canceladoEm, a.status === 'faltou' ? 'Cliente faltou' : 'Cancelado'],
    a.resumoEm && [a.resumoEm, 'Resumo do atendimento registrado'],
    a.arquivadoEm && [a.arquivadoEm, 'Arquivado']
  ]
    .filter(Boolean)
    .sort((x, y) => x[0] - y[0]);
  return (
    <section className="os-bloco">
      <h3 className="os-bloco__titulo">Histórico</h3>
      <ol className="os-tempo">
        {eventos.map(([ms, texto], i) => (
          <li key={i}>
            <span className="os-tempo__texto">{texto}</span>
            <time className="texto-fraco">{dataHora(ms)}</time>
          </li>
        ))}
      </ol>
      {a.responsavelNome && <p className="texto-fraco os-responsavel">Responsável: {a.responsavelNome}</p>}
    </section>
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
      <h2 className="os-cab__servico">Editar — {a.servicoNome}</h2>
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
      <Campo rotulo="Observações">
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
