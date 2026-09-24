import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Botao, Carregando, Cartao, Entrada, Etiqueta, FotoLead, Selecao } from '../../componentes/ui.jsx';
import { FILTROS_CRM } from '../Contatos.jsx';

/**
 * Etapa 2 — quem recebe.
 *
 * Os filtros sao os mesmos da pagina de Contatos ("quem sumiu", "quem nunca
 * marcou"): a pergunta que se faz antes de uma campanha e a mesma nos dois
 * lugares. O filtro "Nao recebem campanha" fica de fora — ninguem dele pode
 * entrar.
 */

const FILTROS = FILTROS_CRM.filter((f) => f.chave !== 'sem_campanha');
const DIAS_ENTRE_CAMPANHAS = 15;

/**
 * Por que este contato nao pode entrar — a mesma regra do servidor.
 * Mostrar aqui evita a surpresa de selecionar 50 e ver 38 mensagens.
 */
function motivoFora(c) {
  if (c.origem === 'simulador') return 'contato de teste';
  if (c.aceitaCampanha === false) return 'não quer campanhas';
  if (c.ultimaCampanhaEm) {
    const dias = Math.floor((Date.now() - new Date(c.ultimaCampanhaEm).getTime()) / 86_400_000);
    if (dias < DIAS_ENTRE_CAMPANHAS) return `recebeu campanha há ${dias === 0 ? 'menos de 1 dia' : `${dias} dia(s)`}`;
  }
  return null;
}

function ultimaVisita(c) {
  if (!c.ultimoAgendamentoEm) return c.totalAgendamentos ? null : 'nunca agendou';
  const dias = Math.floor((Date.now() - c.ultimoAgendamentoEm) / 86_400_000);
  if (dias < 0) return 'tem horário marcado';
  return dias === 0 ? 'veio hoje' : `última visita há ${dias} dia(s)`;
}

export function EtapaContatos({ publico, setPublico }) {
  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState('todos');
  const [etiqueta, setEtiqueta] = useState('');

  const etiquetas = useQuery({ queryKey: ['leads', 'etiquetas'], queryFn: () => api.get('/api/leads/etiquetas') });

  const params = { busca, tag: etiqueta, limite: 200, ...(FILTROS.find((f) => f.chave === filtro)?.params ?? {}) };
  const lista = useQuery({ queryKey: ['leads', 'campanha', params], queryFn: () => api.get('/api/leads', params) });
  const contatos = lista.data?.itens ?? [];

  const marcados = new Set(publico.map((p) => p.id));
  const aptosVisiveis = contatos.filter((c) => !motivoFora(c));
  const todosVisiveisMarcados = aptosVisiveis.length > 0 && aptosVisiveis.every((c) => marcados.has(c.id));

  function alternar(c) {
    setPublico((atual) =>
      atual.some((p) => p.id === c.id) ? atual.filter((p) => p.id !== c.id) : [...atual, { id: c.id, nome: c.nome, aceitaCampanha: true }]
    );
  }

  function marcarVisiveis(incluir) {
    const ids = new Set(aptosVisiveis.map((c) => c.id));
    setPublico((atual) =>
      incluir
        ? [...atual, ...aptosVisiveis.filter((c) => !marcados.has(c.id)).map((c) => ({ id: c.id, nome: c.nome, aceitaCampanha: true }))]
        : atual.filter((p) => !ids.has(p.id))
    );
  }

  return (
    <div className="assist__duas">
      <Cartao titulo="Escolha quem recebe">
        <div className="assist__secao">
          <div className="filtros-chips" role="group" aria-label="Filtros de contatos">
            {FILTROS.map((f) => (
              <button
                key={f.chave}
                type="button"
                className={`filtro-chip ${filtro === f.chave ? 'filtro-chip--ativo' : ''}`}
                aria-pressed={filtro === f.chave}
                onClick={() => setFiltro(f.chave)}
              >
                {f.rotulo}
              </button>
            ))}
          </div>

          <div className="linha">
            <Entrada
              className="crescer"
              placeholder="Buscar por nome, telefone ou anotação..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              style={{ flex: 1, minWidth: 200 }}
            />
            {(etiquetas.data?.etiquetas ?? []).length > 0 && (
              <Selecao value={etiqueta} aria-label="Filtrar por etiqueta" style={{ width: 220 }} onChange={(e) => setEtiqueta(e.target.value)}>
                <option value="">Todas as etiquetas</option>
                {etiquetas.data.etiquetas.map((et) => (
                  <option key={et.nome} value={et.nome}>
                    {et.nome} ({et.total})
                  </option>
                ))}
              </Selecao>
            )}
          </div>

          <div className="linha linha--entre">
            <span className="texto-fraco">
              {lista.isLoading ? 'Buscando…' : `${contatos.length} contato(s) na lista · ${aptosVisiveis.length} podem receber`}
            </span>
            <Botao
              tamanho="sm"
              variante="secundario"
              disabled={aptosVisiveis.length === 0}
              onClick={() => marcarVisiveis(!todosVisiveisMarcados)}
            >
              {todosVisiveisMarcados ? 'Desmarcar os da lista' : `Marcar todos da lista (${aptosVisiveis.length})`}
            </Botao>
          </div>

          <div className="lista-contatos">
            {lista.isLoading && <Carregando texto="Buscando contatos..." />}
            {!lista.isLoading && contatos.length === 0 && (
              <p className="texto-fraco" style={{ padding: 'var(--e4)', margin: 0 }}>
                Nenhum contato com esse filtro.
              </p>
            )}
            {contatos.map((c) => {
              const fora = motivoFora(c);
              const marcado = marcados.has(c.id);
              const visita = ultimaVisita(c);
              return (
                <label
                  key={c.id}
                  className={`lista-contatos__item ${marcado ? 'lista-contatos__item--marcado' : ''} ${fora ? 'lista-contatos__item--fora' : ''}`}
                >
                  <input type="checkbox" checked={marcado} disabled={Boolean(fora) && !marcado} onChange={() => alternar(c)} />
                  <FotoLead nome={c.nome} url={c.fotoUrl} tamanho={32} />
                  <span className="lista-contatos__dados">
                    <strong>{c.nome}</strong>
                    <small>
                      {c.telefoneFormatado}
                      {visita ? ` · ${visita}` : ''}
                      {c.concluidos ? ` · ${c.concluidos} atendimento(s)` : ''}
                    </small>
                  </span>
                  {fora && <Etiqueta tom="perigo">{fora}</Etiqueta>}
                </label>
              );
            })}
          </div>
        </div>
      </Cartao>

      <div className="publico-painel">
        <Cartao
          titulo="Público da campanha"
          acao={
            publico.length > 0 && (
              <Botao tamanho="sm" variante="fantasma" onClick={() => setPublico([])}>
                Limpar
              </Botao>
            )
          }
        >
          <div className="assist__secao">
            <div>
              <div className="publico-total">{publico.length}</div>
              <span className="texto-fraco">contato(s) vão receber uma mensagem pessoal</span>
            </div>
            {publico.length === 0 ? (
              <p className="assist__ajuda">Marque os contatos na lista ao lado. Dica: comece por um filtro, como “Sem retorno (30 dias)”.</p>
            ) : (
              <div className="publico-chips">
                {publico.map((p) => (
                  <button key={p.id} type="button" className="publico-chip" title="Tirar do público" onClick={() => alternar(p)}>
                    {p.nome} <span aria-hidden="true">×</span>
                  </button>
                ))}
              </div>
            )}
            {publico.length > 300 && (
              <p className="assist__ajuda">
                Públicos grandes levam dias para sair no ritmo seguro. Considere dividir em campanhas menores.
              </p>
            )}
          </div>
        </Cartao>
      </div>
    </div>
  );
}
