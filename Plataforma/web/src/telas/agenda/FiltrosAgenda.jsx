import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { normalizar } from '../equipe/ListaEquipe.jsx';
import './filtros.css';

/**
 * Filtros da agenda por PROFISSIONAL e SERVICO, montados a partir do cadastro.
 *
 * "Inteligentes" quer dizer tres coisas:
 *   - cada opcao mostra quantos atendimentos tem NO PERIODO que esta na tela,
 *     ja contando o outro filtro (escolheu o Carlos: os servicos mostram
 *     quantos sao DELE);
 *   - escolhido um profissional, a lista de servicos se estreita ao que ele
 *     faz (o resto fica a um clique, em "mostrar todos");
 *   - quem nao tem horario no periodo vai para o fim, apagado — continua
 *     escolhivel, porque "ninguem marcou com a Rita esta semana" tambem e
 *     uma resposta.
 *
 * O filtro e aplicado na tela (a lista do periodo ja veio inteira), entao
 * trocar de filtro e instantaneo. As metricas do topo pedem ao servidor com
 * os mesmos filtros, para o faturamento continuar no recorte de cada um.
 */

/** Filtra a lista do periodo. Filtro vazio = nao filtra. */
export function aplicarFiltros(lista, { profissionais, servicos }) {
  return lista.filter(
    (a) =>
      (profissionais.length === 0 || profissionais.includes(a.professionalId)) &&
      (servicos.length === 0 || servicos.includes(a.serviceId))
  );
}

export function FiltrosAgenda({ agendamentos, filtros, aoMudar }) {
  const profs = useQuery({
    queryKey: ['profissionais', 'todos'],
    queryFn: () => api.get('/api/profissionais', { incluirInativos: 'true' }),
    staleTime: 5 * 60_000
  });
  const servs = useQuery({
    queryKey: ['servicos', 'todos'],
    queryFn: () => api.get('/api/servicos', { incluirInativos: 'true' }),
    staleTime: 5 * 60_000
  });

  const { profissionais: selProf, servicos: selServ } = filtros;

  const opcoesProf = useMemo(() => {
    // Contagem com o filtro de SERVICO aplicado (e vice-versa abaixo).
    const cont = new Map();
    for (const a of agendamentos) {
      if (selServ.length && !selServ.includes(a.serviceId)) continue;
      cont.set(a.professionalId, (cont.get(a.professionalId) ?? 0) + 1);
    }
    return (profs.data?.profissionais ?? [])
      // Inativo so aparece se tiver horario no periodo (ou ja estiver escolhido).
      .filter((p) => p.ativo || cont.has(p.id) || selProf.includes(p.id))
      .map((p) => ({ id: p.id, nome: p.nome, detalhe: p.funcao, cor: p.cor, total: cont.get(p.id) ?? 0, inativo: !p.ativo }));
  }, [agendamentos, profs.data, selProf, selServ]);

  const { opcoesServ, ocultosServ } = useMemo(() => {
    const cont = new Map();
    for (const a of agendamentos) {
      if (selProf.length && !selProf.includes(a.professionalId)) continue;
      cont.set(a.serviceId, (cont.get(a.serviceId) ?? 0) + 1);
    }
    const todos = (servs.data?.servicos ?? [])
      .filter((s) => s.ativo || cont.has(s.id) || selServ.includes(s.id))
      .map((s) => ({
        id: s.id,
        nome: s.nome,
        grupo: s.categoria || 'Outros',
        total: cont.get(s.id) ?? 0,
        inativo: !s.ativo,
        // Feito por algum dos profissionais escolhidos?
        doEscolhido: selProf.length === 0 || (s.profissionais ?? []).some((p) => selProf.includes(p.id))
      }));
    const relevantes = todos.filter((s) => s.doEscolhido || s.total > 0 || selServ.includes(s.id));
    return { opcoesServ: todos, ocultosServ: todos.length - relevantes.length };
  }, [agendamentos, servs.data, selProf, selServ]);

  const nomes = useMemo(
    () => new Map([...opcoesProf, ...opcoesServ].map((o) => [o.id, o])),
    [opcoesProf, opcoesServ]
  );
  const ativos = [...selProf.map((id) => ['profissionais', id]), ...selServ.map((id) => ['servicos', id])];
  const tirar = (campo, id) => aoMudar({ ...filtros, [campo]: filtros[campo].filter((x) => x !== id) });

  return (
    <div className="fa">
      <div className="fa__linha">
        <Faceta
          rotulo="Profissionais"
          plural="profissionais"
          opcoes={opcoesProf}
          selecionados={selProf}
          carregando={profs.isLoading}
          aoMudar={(ids) => aoMudar({ ...filtros, profissionais: ids })}
        />
        <Faceta
          rotulo="Serviços"
          plural="serviços"
          opcoes={opcoesServ}
          ocultaveis={ocultosServ}
          dicaOcultos={selProf.length === 1 ? 'que este profissional não faz' : 'que os escolhidos não fazem'}
          selecionados={selServ}
          carregando={servs.isLoading}
          aoMudar={(ids) => aoMudar({ ...filtros, servicos: ids })}
        />

        {ativos.length > 0 && (
          <>
            <ul className="fa__ativos" aria-label="Filtros ativos">
              {ativos.map(([campo, id]) => {
                const o = nomes.get(id);
                return (
                  <li key={`${campo}-${id}`}>
                    <button type="button" className="fa__ativo" onClick={() => tirar(campo, id)} title="Tirar este filtro">
                      {o?.cor && <span className="fa__cor" style={{ background: o.cor }} aria-hidden="true" />}
                      {o?.nome ?? '…'}
                      <span aria-hidden="true">×</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <button type="button" className="link fa__limpar" onClick={() => aoMudar({ profissionais: [], servicos: [] })}>
              Limpar filtros
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Um botao que abre a lista de opcoes com busca, contagem e marcacao multipla.
 * Opcoes com `grupo` aparecem agrupadas, e o titulo do grupo marca o grupo todo.
 */
function Faceta({ rotulo, plural, opcoes, selecionados, aoMudar, carregando, ocultaveis = 0, dicaOcultos }) {
  const [aberta, setAberta] = useState(false);
  const [busca, setBusca] = useState('');
  const [verTodos, setVerTodos] = useState(false);
  const raiz = useRef(null);
  const campoBusca = useRef(null);

  // Fecha ao clicar fora ou com Esc.
  useEffect(() => {
    if (!aberta) return undefined;
    const fora = (e) => raiz.current && !raiz.current.contains(e.target) && setAberta(false);
    const esc = (e) => e.key === 'Escape' && setAberta(false);
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc);
    campoBusca.current?.focus();
    return () => {
      document.removeEventListener('mousedown', fora);
      document.removeEventListener('keydown', esc);
    };
  }, [aberta]);

  const termo = normalizar(busca.trim());
  const visiveis = opcoes
    .filter((o) => verTodos || termo || o.doEscolhido !== false || o.total > 0 || selecionados.includes(o.id))
    .filter((o) => !termo || normalizar(`${o.nome} ${o.detalhe ?? ''} ${o.grupo ?? ''}`).includes(termo))
    // Com horario primeiro (mais movimentados no topo); sem horario, apagados no fim.
    .sort((a, b) => (b.total > 0) - (a.total > 0) || b.total - a.total || a.nome.localeCompare(b.nome, 'pt-BR'));

  const temGrupos = visiveis.some((o) => o.grupo);
  const grupos = temGrupos
    ? [...new Set(visiveis.map((o) => o.grupo))]
        .map((g) => ({ nome: g, itens: visiveis.filter((o) => o.grupo === g) }))
        .sort((a, b) => sum(b.itens) - sum(a.itens) || a.nome.localeCompare(b.nome, 'pt-BR'))
    : [{ nome: null, itens: visiveis }];

  const marcado = (id) => selecionados.includes(id);
  const alternar = (id) => aoMudar(marcado(id) ? selecionados.filter((x) => x !== id) : [...selecionados, id]);
  const alternarGrupo = (itens) => {
    const ids = itens.map((o) => o.id);
    const todos = ids.every(marcado);
    aoMudar(todos ? selecionados.filter((x) => !ids.includes(x)) : [...new Set([...selecionados, ...ids])]);
  };
  const comHorario = opcoes.filter((o) => o.total > 0);

  const resumo =
    selecionados.length === 0
      ? null
      : selecionados.length === 1
        ? (opcoes.find((o) => o.id === selecionados[0])?.nome ?? '1')
        : `${selecionados.length}`;

  return (
    <div className="fa-faceta" ref={raiz}>
      <button
        type="button"
        className={`fa-faceta__botao${selecionados.length ? ' fa-faceta__botao--ativo' : ''}`}
        aria-expanded={aberta}
        aria-haspopup="dialog"
        onClick={() => setAberta((v) => !v)}
      >
        {rotulo}
        {resumo && <strong className="fa-faceta__resumo">{resumo}</strong>}
        <span className="fa-faceta__seta" aria-hidden="true">▾</span>
      </button>

      {aberta && (
        <div className="fa-painel" role="dialog" aria-label={`Filtrar por ${plural}`}>
          <input
            ref={campoBusca}
            type="search"
            className="entrada fa-painel__busca"
            placeholder={`Buscar ${plural}…`}
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
          <div className="fa-painel__atalhos">
            <button
              type="button"
              className="link"
              disabled={comHorario.length === 0}
              onClick={() => aoMudar(comHorario.map((o) => o.id))}
              title="Marca só quem tem atendimento no período"
            >
              Só com horário ({comHorario.length})
            </button>
            {selecionados.length > 0 && (
              <button type="button" className="link" onClick={() => aoMudar([])}>
                Limpar
              </button>
            )}
          </div>

          <div className="fa-painel__lista">
            {carregando ? (
              <p className="texto-fraco fa-painel__vazio">Carregando…</p>
            ) : visiveis.length === 0 ? (
              <p className="texto-fraco fa-painel__vazio">Nada encontrado.</p>
            ) : (
              grupos.map((g) => (
                <div key={g.nome ?? 'todos'} className="fa-grupo">
                  {g.nome && (
                    <button type="button" className="fa-grupo__titulo" onClick={() => alternarGrupo(g.itens)} title="Marcar ou desmarcar o grupo todo">
                      <input type="checkbox" readOnly tabIndex={-1} checked={g.itens.every((o) => marcado(o.id))} aria-hidden="true" />
                      {g.nome}
                      <small>{sum(g.itens)}</small>
                    </button>
                  )}
                  {g.itens.map((o) => (
                    <label key={o.id} className={`fa-opcao${o.total === 0 ? ' fa-opcao--sem' : ''}`}>
                      <input type="checkbox" checked={marcado(o.id)} onChange={() => alternar(o.id)} />
                      {o.cor && <span className="fa__cor" style={{ background: o.cor }} aria-hidden="true" />}
                      <span className="fa-opcao__nome">
                        {o.nome}
                        {(o.detalhe || o.inativo) && (
                          <small className="texto-fraco">
                            {[o.detalhe, o.inativo && 'inativo'].filter(Boolean).join(' · ')}
                          </small>
                        )}
                      </span>
                      <span className="fa-opcao__total" title="Atendimentos no período">
                        {o.total}
                      </span>
                    </label>
                  ))}
                </div>
              ))
            )}
          </div>

          {ocultaveis > 0 && !termo && (
            <button type="button" className="link fa-painel__rodape" onClick={() => setVerTodos((v) => !v)}>
              {verTodos ? 'Mostrar só os relevantes' : `Mostrar todos (+${ocultaveis} ${dicaOcultos})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const sum = (itens) => itens.reduce((t, o) => t + o.total, 0);
