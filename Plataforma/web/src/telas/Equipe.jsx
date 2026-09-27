import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import {
  AreaTexto,
  Aviso,
  Botao,
  Campo,
  Carregando,
  Cartao,
  Entrada,
  Etiqueta,
  Modal,
  Selecao,
  Tabela,
  Vazio
} from '../componentes/ui.jsx';
import { Icone } from '../componentes/Icone.jsx';
import { useAuth } from '../lib/autenticacao.jsx';
import { EscolherFoto } from './equipe/EscolherFoto.jsx';
import { Busca, Chips, FotoPessoa, MenuAcoes, normalizar, resumoJornada } from './equipe/ListaEquipe.jsx';
import { useFuncoes } from '../lib/funcoes.jsx';
import { Interruptor } from './conexoes/Interruptor.jsx';
import './Conexoes.css';
import './Equipe.css';

/**
 * Cadastro da equipe.
 *
 * Duas coisas que o dia a dia chama de "funcionario" e o sistema precisa
 * separar:
 *
 *   PROFISSIONAL — executa o servico e ocupa a agenda. Tem jornada, cor no
 *   calendario e uma tabela propria de preco e duracao por servico.
 *
 *   ATENDENTE — usa o sistema (login e cargo). Responde no livechat e nao
 *   aparece na agenda.
 *
 * A mesma pessoa pode ser as duas: basta ligar o profissional a um login.
 */

const ABAS = [
  { id: 'profissionais', titulo: 'Profissionais', icone: 'equipe' },
  { id: 'atendentes', titulo: 'Atendentes', icone: 'conversas' }
];

const DIAS = [
  ['1', 'Segunda'],
  ['2', 'Terca'],
  ['3', 'Quarta'],
  ['4', 'Quinta'],
  ['5', 'Sexta'],
  ['6', 'Sabado'],
  ['0', 'Domingo']
];

/** 80% da tela no computador; no celular (onde 80% aperta demais) a largura toda. */
const LARGURA_FICHA = 'min(100%, max(80vw, 720px))';

const CORES = ['#1856FF', '#07CA6B', '#E89558', '#EA2143', '#38BDF8', '#A78BFA', '#F472B6', '#FBBF24'];

const reais = (centavos) => (Number(centavos ?? 0) / 100).toFixed(2).replace('.', ',');
const centavos = (texto) => {
  const limpo = String(texto ?? '').replace(/\./g, '').replace(',', '.').trim();
  if (limpo === '') return null;
  const n = Math.round(Number(limpo) * 100);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function Equipe() {
  const [params, setParams] = useSearchParams();
  const aba = params.get('aba') === 'atendentes' ? 'atendentes' : 'profissionais';
  const secao = SECOES_ATENDENTE.some((s) => s.id === params.get('secao')) ? params.get('secao') : 'pessoas';

  // As mesmas consultas das listas (cache compartilhado): so para a contagem nos chips.
  const profissionais = useQuery({
    queryKey: ['profissionais', 'todos'],
    queryFn: () => api.get('/api/profissionais', { incluirInativos: 'true' })
  });
  const atendentes = useQuery({ queryKey: ['atendentes'], queryFn: () => api.get('/api/atendentes') });

  const total = {
    profissionais: (profissionais.data?.profissionais ?? []).filter((p) => p.ativo).length,
    atendentes: (atendentes.data?.atendentes ?? []).filter((a) => a.ativo).length
  };

  // "Cadastrar" fica no cabecalho (na barra de filtros ele nunca cabia na mesma
  // linha). Cada clique vira um numero novo, que a lista aberta escuta.
  const [pedidoNovo, setPedidoNovo] = useState(0);
  const rotuloNovo = aba === 'profissionais' ? '+ Cadastrar profissional' : secao === 'pessoas' ? '+ Cadastrar atendente' : null;

  function ir(novos) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(novos)) v ? p.set(k, v) : p.delete(k);
    setParams(p, { replace: true });
  }

  return (
    <div className="coluna eq">
      <header className="linha linha--entre">
        <div>
          <h1>Equipe</h1>
          <p className="texto-suave">Quem atende na cadeira e quem atende no sistema.</p>
        </div>
        {rotuloNovo && (
          <Botao className="eq-novo" onClick={() => setPedidoNovo((n) => n + 1)}>
            {rotuloNovo}
          </Botao>
        )}
      </header>

      <div className="eq-navegacao">
        <div className="eq-abas" role="tablist" aria-label="Parte da equipe">
          {ABAS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={aba === a.id}
              className={`eq-aba${aba === a.id ? ' eq-aba--ativa' : ''}`}
              onClick={() => ir({ aba: a.id === 'profissionais' ? null : a.id, secao: null })}
            >
              <Icone nome={a.icone} className="eq-aba__icone" />
              {a.titulo}
              <small>{total[a.id]}</small>
            </button>
          ))}
        </div>

        {aba === 'atendentes' && (
          <div className="abas abas--compacta" role="tablist" aria-label="Assunto">
            {SECOES_ATENDENTE.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={secao === s.id}
                className={`abas__aba${secao === s.id ? ' abas__aba--ativa' : ''}`}
                onClick={() => ir({ secao: s.id === 'pessoas' ? null : s.id })}
              >
                {s.titulo}
              </button>
            ))}
          </div>
        )}
      </div>

      {aba === 'profissionais' ? (
        <Profissionais consulta={profissionais} pedidoNovo={pedidoNovo} />
      ) : secao === 'pessoas' ? (
        <Pessoas consulta={atendentes} pedidoNovo={pedidoNovo} />
      ) : secao === 'distribuicao' ? (
        <Distribuicao />
      ) : (
        <Privacidade />
      )}
    </div>
  );
}

const FILTROS_SITUACAO = [
  { chave: 'ativos', rotulo: 'Ativos', ponto: 'sucesso' },
  { chave: 'inativos', rotulo: 'Inativos', ponto: 'neutro' },
  { chave: 'todos', rotulo: 'Todos' }
];

/**
 * Reage ao "Cadastrar" do cabecalho — so aos cliques feitos DEPOIS de a lista
 * aparecer. O contador nao volta a zero; sem guardar o numero da montagem,
 * trocar de aba (Barbeiros <-> Atendentes) remontava a lista, ela via o
 * contador maior que zero e reabria o popup de cadastro sozinha.
 */
function usePedidoNovo(pedidoNovo, abrir) {
  const visto = useRef(pedidoNovo);
  useEffect(() => {
    if (pedidoNovo === visto.current) return;
    visto.current = pedidoNovo;
    abrir();
    // `abrir` e recriada a cada render; so o numero importa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pedidoNovo]);
}

function Profissionais({ consulta, pedidoNovo }) {
  const queryClient = useQueryClient();
  const [fichaAberta, setFichaAberta] = useState(null); // id, ou 'novo'
  const [busca, setBusca] = useState('');
  const [situacao, setSituacao] = useState('ativos');
  const [funcao, setFuncao] = useState('');

  usePedidoNovo(pedidoNovo, () => setFichaAberta('novo'));

  const excluir = useMutation({
    mutationFn: (id) => api.delete(`/api/profissionais/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profissionais'] })
  });

  const todos = consulta.data?.profissionais ?? [];
  const funcoes = [...new Set(todos.map((p) => p.funcao).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const termo = normalizar(busca.trim());

  const porSituacao = {
    ativos: todos.filter((p) => p.ativo),
    inativos: todos.filter((p) => !p.ativo),
    todos
  };
  const visiveis = porSituacao[situacao].filter(
    (p) =>
      (!funcao || p.funcao === funcao) &&
      (!termo || normalizar(`${p.nome} ${p.funcao} ${p.telefoneFormatado ?? ''} ${p.telefone ?? ''}`).includes(termo))
  );

  const logins = new Map(
    (queryClient.getQueryData(['atendentes'])?.atendentes ?? []).map((a) => [a.id, a.nome])
  );

  function remover(p) {
    if (confirm(`Remover ${p.nome} da equipe?\n\nQuem já atendeu alguém fica inativo (o histórico é preservado).`)) {
      excluir.mutate(p.id);
    }
  }

  return (
    <div className="coluna">
      <div className="eq-ferramentas">
        <Busca valor={busca} aoMudar={setBusca} rotulo="Nome, função ou telefone" />
        <Chips
          rotulo="Situação"
          valor={situacao}
          aoMudar={setSituacao}
          opcoes={FILTROS_SITUACAO.map((f) => ({ ...f, total: porSituacao[f.chave].length }))}
        />
        {funcoes.length > 1 && (
          <Selecao value={funcao} aria-label="Filtrar por função" className="eq-filtro" onChange={(e) => setFuncao(e.target.value)}>
            <option value="">Todas as funções</option>
            {funcoes.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Selecao>
        )}
      </div>

      {excluir.isError && <Aviso tom="perigo">{excluir.error.message}</Aviso>}
      {excluir.data?.desativado && <Aviso tom="alerta">{excluir.data.mensagem}</Aviso>}

      {consulta.isLoading ? (
        <Carregando />
      ) : todos.length === 0 ? (
        <Vazio
          titulo="Nenhum profissional cadastrado"
          descricao="Cadastre quem executa os servicos para que eles apareçam na agenda."
          acao={<Botao onClick={() => setFichaAberta('novo')}>Cadastrar profissional</Botao>}
        />
      ) : (
        <section className="cartao eq-lista eq-lista--prof" aria-label="Profissionais">
          <div className="eq-linha eq-linha--cabecalho" aria-hidden="true">
            <span>Profissional</span>
            <span>Jornada</span>
            <span>Serviços</span>
            <span>Login</span>
            <span>Situação</span>
            <span />
          </div>

          {visiveis.length === 0 ? (
            <p className="eq-lista__vazia">Ninguém com esse filtro.</p>
          ) : (
            visiveis.map((p) => {
              const jornada = resumoJornada(p.jornada);
              const proprios = p.servicos.filter((s) => s.precoProprio || s.duracaoPropria).length;
              const login = p.userId ? logins.get(p.userId) ?? 'Com login' : null;
              return (
                <div
                  key={p.id}
                  className={`eq-linha${p.ativo ? '' : ' eq-linha--inativa'}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setFichaAberta(p.id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setFichaAberta(p.id))}
                  aria-label={`Abrir a ficha de ${p.nome}`}
                >
                  <span className="eq-pessoa">
                    <FotoPessoa nome={p.nome} url={p.fotoUrl} cor={p.cor} />
                    <span className="eq-pessoa__texto">
                      <strong>{p.nome}</strong>
                      <small>
                        {p.funcao}
                        {p.telefoneFormatado && <span className="mono"> · {p.telefoneFormatado}</span>}
                      </small>
                    </span>
                  </span>

                  <span className="eq-celula" title={jornada.variado ? 'O horário muda conforme o dia — veja na ficha' : undefined}>
                    {jornada.dias}
                    {jornada.horas && (
                      <small className="mono">
                        {jornada.variado && '~ '}
                        {jornada.horas}
                      </small>
                    )}
                  </span>

                  <span className="eq-celula">
                    {p.servicos.length === 0 ? (
                      <span className="eq-alerta">Nenhum serviço</span>
                    ) : (
                      <>
                        {p.servicos.length} serviço{p.servicos.length > 1 ? 's' : ''}
                        {proprios > 0 && <small>{proprios} com valor próprio</small>}
                      </>
                    )}
                  </span>

                  <span className="eq-celula eq-celula--fraca">{login ?? '—'}</span>

                  <span className="eq-celula">
                    <span className={`eq-situacao${p.ativo ? '' : ' eq-situacao--inativa'}`}>
                      <span className={`eq-ponto eq-ponto--${p.ativo ? 'sucesso' : 'neutro'}`} aria-hidden="true" />
                      {p.ativo ? 'Ativo' : 'Inativo'}
                    </span>
                  </span>

                  <span className="eq-acoes">
                    <MenuAcoes
                      rotulo={`Ações de ${p.nome}`}
                      acoes={[
                        { rotulo: 'Abrir ficha', aoClicar: () => setFichaAberta(p.id) },
                        { rotulo: 'Remover da equipe', perigo: true, aoClicar: () => remover(p) }
                      ]}
                    />
                  </span>
                </div>
              );
            })
          )}

          <p className="eq-lista__rodape">
            {visiveis.length === todos.length
              ? `${todos.length} profissiona${todos.length === 1 ? 'l' : 'is'}`
              : `Mostrando ${visiveis.length} de ${todos.length}`}
          </p>
        </section>
      )}

      {fichaAberta && (
        <FichaProfissional
          id={fichaAberta === 'novo' ? null : fichaAberta}
          aoFechar={() => setFichaAberta(null)}
          aoSalvar={() => {
            setFichaAberta(null);
            queryClient.invalidateQueries({ queryKey: ['profissionais'] });
            queryClient.invalidateQueries({ queryKey: ['servicos'] });
          }}
        />
      )}
    </div>
  );
}

/**
 * Resumo do desempenho do profissional, no topo da ficha.
 *
 * Sai do historico de atendimentos encerrados (a mesma base do futuro painel
 * de analise), entao reflete o que aconteceu — nao o que esta marcado.
 */
const PERIODOS = [
  { dias: 30, rotulo: '30 dias' },
  { dias: 90, rotulo: '90 dias' },
  { dias: 365, rotulo: '12 meses' },
  { dias: 0, rotulo: 'Tudo' }
];

function MetricasProfissional({ id }) {
  const [dias, setDias] = useState(30);
  const { data, isLoading } = useQuery({
    queryKey: ['profissional', id, 'metricas', dias],
    queryFn: () => api.get(`/api/profissionais/${id}/metricas`, { dias })
  });
  const m = data?.metricas;

  const ultimo = m?.ultimoAtendimentoEm
    ? new Date(m.ultimoAtendimentoEm).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
    : '—';

  const blocos = m
    ? [
        { rotulo: 'Atendimentos', valor: m.atendimentos, detalhe: `${m.horasTrabalhadas} h de serviço` },
        { rotulo: 'Faturamento', valor: m.faturamentoFormatado, detalhe: 'só concluídos' },
        { rotulo: 'Ticket médio', valor: m.ticketMedioFormatado, detalhe: 'por atendimento' },
        { rotulo: 'Clientes', valor: m.clientes, detalhe: `${m.clientesNovos} novos · ${m.clientesRecorrentes} voltaram` },
        {
          rotulo: 'Faltas',
          valor: `${m.taxaFaltaPercentual}%`,
          detalhe: `${m.faltas} faltas · ${m.cancelados} cancelados`,
          tom: m.taxaFaltaPercentual >= 15 ? 'perigo' : undefined
        },
        {
          rotulo: 'Mais feito',
          valor: m.servicoMaisFeito?.nome ?? '—',
          detalhe: m.servicoMaisFeito ? `${m.servicoMaisFeito.vezes}x · último em ${ultimo}` : `último em ${ultimo}`,
          texto: true
        },
        { rotulo: 'Na agenda', valor: m.proximosAgendados, detalhe: 'horários futuros' }
      ]
    : [];

  return (
    <section className="ficha-metricas" aria-label="Métricas do profissional">
      <div className="ficha-metricas__periodos" role="group" aria-label="Período">
        {PERIODOS.map((p) => (
          <button
            key={p.dias}
            type="button"
            aria-pressed={dias === p.dias}
            className={`ficha-metricas__periodo${dias === p.dias ? ' ficha-metricas__periodo--ativo' : ''}`}
            onClick={() => setDias(p.dias)}
          >
            {p.rotulo}
          </button>
        ))}
      </div>
      {isLoading || !m ? (
        <div className="ficha-metricas__carregando texto-fraco">Carregando métricas...</div>
      ) : (
        <div className="ficha-metricas__blocos">
          {blocos.map((b) => (
            <div key={b.rotulo} className={`ficha-metrica${b.tom ? ` ficha-metrica--${b.tom}` : ''}`}>
              <span className="ficha-metrica__rotulo">{b.rotulo}</span>
              <strong className={`ficha-metrica__valor${b.texto ? ' ficha-metrica__valor--texto' : ''}`} title={String(b.valor)}>
                {b.valor}
              </strong>
              <span className="ficha-metrica__detalhe">{b.detalhe}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * A ficha do profissional.
 *
 * O miolo dela e a tabela de servicos: quanto ELE cobra e em quanto tempo ELE
 * faz cada um. Deixar os campos em branco mantem o padrao do servico — e por
 * isso o campo mostra o valor padrao como placeholder em vez de ja vir
 * preenchido: preencher criaria uma copia do padrao que deixaria de acompanhar
 * mudancas de tabela.
 */
function FichaProfissional({ id, aoFechar, aoSalvar }) {
  const novo = !id;
  const { ligada } = useFuncoes();

  const ficha = useQuery({
    queryKey: ['profissional', id],
    queryFn: () => api.get(`/api/profissionais/${id}`),
    enabled: !novo
  });

  const servicos = useQuery({ queryKey: ['servicos'], queryFn: () => api.get('/api/servicos') });
  const atendentes = useQuery({ queryKey: ['atendentes'], queryFn: () => api.get('/api/atendentes') });

  const p = ficha.data?.profissional;

  const [form, setForm] = useState(null);
  const [foto, setFoto] = useState(undefined); // undefined = nao mexeu; null = remover

  // Primeira carga: monta o formulario a partir da ficha (ou dos padroes).
  if (form === null && (novo || p)) {
    const porServico = new Map((p?.servicos ?? []).map((s) => [s.serviceId, s]));
    setForm({
      nome: p?.nome ?? '',
      funcao: p?.funcao ?? 'Especialista',
      cor: p?.cor ?? CORES[0],
      telefone: p?.telefoneFormatado ?? '',
      observacoes: p?.observacoes ?? '',
      userId: p?.userId ?? '',
      ativo: p?.ativo ?? true,
      jornada: p?.jornada ?? {
        dias: { 1: [{ inicio: '09:00', fim: '18:00' }], 2: [{ inicio: '09:00', fim: '18:00' }], 3: [{ inicio: '09:00', fim: '18:00' }], 4: [{ inicio: '09:00', fim: '18:00' }], 5: [{ inicio: '09:00', fim: '18:00' }] },
        intervaloMinutos: 30
      },
      servicos: porServico
    });
  }

  const salvar = useMutation({
    mutationFn: async () => {
      const lista = [...form.servicos.values()].map((s) => ({
        serviceId: s.serviceId,
        precoCentavos: s.precoTexto === '' || s.precoTexto == null ? null : centavos(s.precoTexto),
        duracaoMinutos: s.duracaoTexto === '' || s.duracaoTexto == null ? null : Number(s.duracaoTexto)
      }));

      const corpo = {
        nome: form.nome,
        funcao: form.funcao,
        cor: form.cor,
        telefone: form.telefone || null,
        observacoes: form.observacoes,
        userId: form.userId || null,
        ativo: form.ativo,
        jornada: form.jornada,
        servicos: lista,
        ...(foto ? { foto } : {}),
        ...(foto === null ? { removerFoto: true } : {})
      };

      return novo ? api.post('/api/profissionais', corpo) : api.patch(`/api/profissionais/${id}`, corpo);
    },
    onSuccess: aoSalvar
  });

  if (!form) {
    return (
      <Modal titulo="Ficha do profissional" aberto aoFechar={aoFechar} largura={LARGURA_FICHA} className="modal--ficha">
        <Carregando />
      </Modal>
    );
  }

  const listaServicos = servicos.data?.servicos ?? [];
  const erros = salvar.error?.camposComErro ?? {};

  function alternarServico(s) {
    const copia = new Map(form.servicos);
    if (copia.has(s.id)) copia.delete(s.id);
    else copia.set(s.id, { serviceId: s.id, precoTexto: '', duracaoTexto: '' });
    setForm({ ...form, servicos: copia });
  }

  function mudarServico(serviceId, campo, valor) {
    const copia = new Map(form.servicos);
    copia.set(serviceId, { ...copia.get(serviceId), [campo]: valor });
    setForm({ ...form, servicos: copia });
  }

  function mudarDia(dia, faixa) {
    const dias = { ...form.jornada.dias };
    if (faixa) dias[dia] = [faixa];
    else delete dias[dia];
    setForm({ ...form, jornada: { ...form.jornada, dias } });
  }

  return (
    <Modal
      titulo={novo ? 'Cadastrar profissional' : `Ficha de ${p?.nome ?? ''}`}
      aberto
      aoFechar={aoFechar}
      largura={LARGURA_FICHA} className="modal--ficha"
      rodape={
        <>
          <Botao variante="secundario" onClick={aoFechar}>
            Cancelar
          </Botao>
          <Botao carregando={salvar.isPending} disabled={!form.nome.trim()} onClick={() => salvar.mutate()}>
            Salvar
          </Botao>
        </>
      }
    >
      {salvar.isError && salvar.error.codigo !== 'VALIDACAO' && <Aviso tom="perigo">{salvar.error.message}</Aviso>}

      {!novo && ligada('metricas_profissional') && <MetricasProfissional id={id} />}

      {/* Tres colunas, uma por etapa: quem e, o que faz, quando trabalha. */}
      <div className="ficha-colunas">
        <section className="ficha-coluna">
          <h3 className="ficha-coluna__titulo"><span className="ficha-coluna__numero">1</span>Dados</h3>
          <EscolherFoto
            valorAtual={p?.fotoUrl}
            rotulo="Foto do profissional"
            aoEscolher={setFoto}
            aoRemover={() => setFoto(null)}
          />

          <div className="ficha-campos">
            <Campo rotulo="Nome" obrigatorio erro={erros.nome}>
              <Entrada value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
            </Campo>
            <Campo rotulo="Funcao">
              <Entrada
                value={form.funcao}
                placeholder="Barbeiro, esteticista..."
                onChange={(e) => setForm({ ...form, funcao: e.target.value })}
              />
            </Campo>
            <Campo rotulo="Telefone">
              <Entrada value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} />
            </Campo>
            <Campo rotulo="Login no sistema">
              <Selecao value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
                <option value="">Sem login</option>
                {(atendentes.data?.atendentes ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nome} ({a.cargo})
                  </option>
                ))}
              </Selecao>
            </Campo>
          </div>

          <Campo rotulo="Cor na agenda">
            <div className="linha" style={{ gap: 6 }}>
              {CORES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`cor-opcao${form.cor === c ? ' cor-opcao--ativa' : ''}`}
                  style={{ background: c }}
                  aria-label={`Cor ${c}`}
                  aria-pressed={form.cor === c}
                  onClick={() => setForm({ ...form, cor: c })}
                />
              ))}
            </div>
          </Campo>

          <Campo rotulo="Observacoes internas">
            <AreaTexto
              value={form.observacoes}
              onChange={(e) => setForm({ ...form, observacoes: e.target.value })}
              rows={2}
            />
          </Campo>

          {!novo && (
            <label className="linha" style={{ gap: 8 }}>
              <input
                type="checkbox"
                checked={form.ativo}
                onChange={(e) => setForm({ ...form, ativo: e.target.checked })}
              />
              <span>Ativo (aparece ao marcar horario)</span>
            </label>
          )}
        </section>

        <section className="ficha-coluna">
          <h3 className="ficha-coluna__titulo"><span className="ficha-coluna__numero">2</span>Servicos que realiza</h3>
          <p className="texto-fraco">
            Deixe preco e duracao em branco para usar o padrao do servico. Preencha so quando esta pessoa cobra ou
            demora diferente.
          </p>

          {listaServicos.length === 0 ? (
            <Aviso tom="alerta">Nenhum servico cadastrado ainda. Cadastre no Catalogo primeiro.</Aviso>
          ) : (
            <Tabela cabecalho={['Faz', 'Servico', 'Preco (R$)', 'Duracao (min)']}>
              {listaServicos.map((s) => {
                const marcado = form.servicos.has(s.id);
                const item = form.servicos.get(s.id) ?? {};
                return (
                  <tr key={s.id} className={marcado ? undefined : 'linha--apagada'}>
                    <td>
                      <input
                        type="checkbox"
                        checked={marcado}
                        onChange={() => alternarServico(s)}
                        aria-label={`${p?.nome ?? 'Profissional'} faz ${s.nome}`}
                      />
                    </td>
                    <td>
                      <strong>{s.nome}</strong>
                      <div className="texto-fraco">
                        padrao: {s.precoFormatado} · {s.duracaoMinutos} min
                      </div>
                    </td>
                    <td>
                      <Entrada
                        value={item.precoTexto ?? ''}
                        disabled={!marcado}
                        placeholder={reais(s.precoCentavos)}
                        onChange={(e) => mudarServico(s.id, 'precoTexto', e.target.value)}
                        style={{ width: 90 }}
                      />
                    </td>
                    <td>
                      <Entrada
                        type="number"
                        value={item.duracaoTexto ?? ''}
                        disabled={!marcado}
                        placeholder={String(s.duracaoMinutos)}
                        onChange={(e) => mudarServico(s.id, 'duracaoTexto', e.target.value)}
                        style={{ width: 72 }}
                      />
                    </td>
                  </tr>
                );
              })}
            </Tabela>
          )}
        </section>

        <section className="ficha-coluna">
          <h3 className="ficha-coluna__titulo"><span className="ficha-coluna__numero">3</span>Jornada</h3>
          <p className="texto-fraco">
            E daqui que sai a lista de horarios livres. Dia sem faixa marcada = dia de folga.
          </p>
          <div className="jornada">
            {DIAS.map(([dia, nome]) => {
              const faixa = form.jornada.dias?.[dia]?.[0];
              return (
                <div key={dia} className="jornada__dia">
                  <label className="linha" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(faixa)}
                      onChange={(e) => mudarDia(dia, e.target.checked ? { inicio: '09:00', fim: '18:00' } : null)}
                    />
                    <span>{nome}</span>
                  </label>
                  <Entrada
                    type="time"
                    value={faixa?.inicio ?? ''}
                    disabled={!faixa}
                    onChange={(e) => mudarDia(dia, { ...faixa, inicio: e.target.value })}
                  />
                  <Entrada
                    type="time"
                    value={faixa?.fim ?? ''}
                    disabled={!faixa}
                    onChange={(e) => mudarDia(dia, { ...faixa, fim: e.target.value })}
                  />
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </Modal>
  );
}

/**
 * Atendentes: quem usa o sistema.
 *
 * Tres assuntos diferentes moram aqui, e por isso a secao tem chips proprios
 * (no topo da pagina, ao lado das abas): as PESSOAS (cadastro), como o
 * trabalho CHEGA a elas (distribuicao) e quem enxerga o atendimento de quem
 * (privacidade). Misturar os tres numa tela so faria a configuracao mais
 * delicada do sistema — a privacidade — virar um campo perdido no rodape.
 */
const SECOES_ATENDENTE = [
  { id: 'pessoas', titulo: 'Pessoas' },
  { id: 'distribuicao', titulo: 'Distribuição' },
  { id: 'privacidade', titulo: 'Privacidade' }
];

/** Espelha a hierarquia do servidor: ninguem mexe em quem esta acima do proprio cargo. */
const NIVEL_CARGO = { atendente: 10, admin: 20, owner: 30, dev: 100 };

const ROTULO_CARGO = { owner: 'Dono', admin: 'Administrador', atendente: 'Atendente' };
const PRESENCA = {
  online: { rotulo: 'Online', ponto: 'sucesso' },
  ausente: { rotulo: 'Ausente', ponto: 'alerta' },
  offline: { rotulo: 'Offline', ponto: 'neutro' }
};

function Pessoas({ consulta, pedidoNovo }) {
  const queryClient = useQueryClient();
  const { usuario: eu } = useAuth();
  const { ligada } = useFuncoes();
  // null | { tipo: 'novo' } | { tipo: 'editar' | 'aviso', pessoa }
  const [modal, setModal] = useState(null);
  const [resultado, setResultado] = useState(null);
  const [busca, setBusca] = useState('');
  const [presenca, setPresenca] = useState('todos');
  const [cargo, setCargo] = useState('');

  usePedidoNovo(pedidoNovo, () => setModal({ tipo: 'novo' }));

  const todos = consulta.data?.atendentes ?? [];

  const excluir = useMutation({
    mutationFn: (id) => api.delete(`/api/usuarios/${id}`),
    onSuccess: (dados) => {
      setResultado({ tom: 'sucesso', texto: dados.mensagem });
      queryClient.invalidateQueries({ queryKey: ['atendentes'] });
      queryClient.invalidateQueries({ queryKey: ['conversas'] });
    },
    onError: (err) => setResultado({ tom: 'perigo', texto: err.message })
  });

  const fechar = () => setModal(null);
  const podeMexer = (a) => (NIVEL_CARGO[a.cargo] ?? Infinity) <= (NIVEL_CARGO[eu?.cargo] ?? 0);

  const termo = normalizar(busca.trim());
  const doCargo = todos.filter(
    (a) =>
      (!cargo || a.cargo === cargo) &&
      (!termo || normalizar(`${a.nome} ${a.username} ${a.email ?? ''}`).includes(termo))
  );
  // Os chips contam dentro do que a busca e o cargo deixaram: o numero bate
  // com o que aparece ao clicar.
  const porPresenca = (p) => doCargo.filter((a) => a.ativo && (a.statusPresenca ?? 'offline') === p);
  const visiveis = presenca === 'todos' ? doCargo : porPresenca(presenca);

  const cargos = Object.keys(ROTULO_CARGO).filter((c) => todos.some((a) => a.cargo === c));

  function excluirPessoa(a) {
    if (
      confirm(
        `Excluir ${a.nome}?\n\nO acesso dele(a) ao sistema acaba na hora e as conversas que estão com ele(a) voltam para a fila.`
      )
    ) {
      excluir.mutate(a.id);
    }
  }

  return (
    <div className="coluna">
      <div className="eq-ferramentas">
        <Busca valor={busca} aoMudar={setBusca} rotulo="Nome, usuário ou e-mail" />
        <Chips
          rotulo="Presença"
          valor={presenca}
          aoMudar={setPresenca}
          opcoes={[
            { chave: 'todos', rotulo: 'Todos', total: doCargo.length },
            ...Object.entries(PRESENCA).map(([chave, p]) => ({ chave, rotulo: p.rotulo, ponto: p.ponto, total: porPresenca(chave).length }))
          ]}
        />
        {cargos.length > 1 && (
          <Selecao value={cargo} aria-label="Filtrar por cargo" className="eq-filtro" onChange={(e) => setCargo(e.target.value)}>
            <option value="">Todos os cargos</option>
            {cargos.map((c) => (
              <option key={c} value={c}>
                {ROTULO_CARGO[c]}
              </option>
            ))}
          </Selecao>
        )}
      </div>

      {resultado && (
        <Aviso tom={resultado.tom} aoFechar={() => setResultado(null)}>
          {resultado.texto}
        </Aviso>
      )}

      {consulta.isLoading ? (
        <Carregando />
      ) : (
        <section className="cartao eq-lista eq-lista--atend" aria-label="Atendentes">
          <div className="eq-linha eq-linha--cabecalho" aria-hidden="true">
            <span>Pessoa</span>
            <span>Cargo</span>
            <span>Presença</span>
            <span>Atendendo agora</span>
            <span>Situação</span>
            <span />
          </div>

          {visiveis.length === 0 ? (
            <p className="eq-lista__vazia">Ninguém com esse filtro.</p>
          ) : (
            visiveis.map((a) => {
              const mexe = podeMexer(a);
              const souEu = a.id === eu?.id;
              const bloqueio = mexe ? undefined : 'Cargo acima do seu';
              const pres = PRESENCA[a.statusPresenca] ?? PRESENCA.offline;
              const carga = a.capacidadeSimultanea ? Math.min(1, a.emAtendimento / a.capacidadeSimultanea) : 0;
              const nivel = carga >= 1 ? 'cheio' : carga >= 0.7 ? 'alto' : 'ok';
              const editar = () => mexe && setModal({ tipo: 'editar', pessoa: a });

              return (
                <div
                  key={a.id}
                  className={`eq-linha${a.ativo ? '' : ' eq-linha--inativa'}${mexe ? '' : ' eq-linha--travada'}`}
                  role={mexe ? 'button' : undefined}
                  tabIndex={mexe ? 0 : undefined}
                  onClick={editar}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), editar())}
                  aria-label={mexe ? `Editar ${a.nome}` : undefined}
                  title={bloqueio}
                >
                  <span className="eq-pessoa">
                    <FotoPessoa nome={a.nome} url={a.avatar} presenca={a.ativo ? pres.ponto : undefined} />
                    <span className="eq-pessoa__texto">
                      <strong>
                        {a.nome}
                        {souEu && <span className="eq-voce">você</span>}
                      </strong>
                      <small className="mono">@{a.username}</small>
                    </span>
                  </span>

                  <span className="eq-celula">
                    <span className={`eq-cargo eq-cargo--${a.cargo}`}>{ROTULO_CARGO[a.cargo] ?? a.cargo}</span>
                  </span>

                  <span className="eq-celula">
                    <span className="eq-situacao">
                      <span className={`eq-ponto eq-ponto--${pres.ponto}`} aria-hidden="true" />
                      {pres.rotulo}
                    </span>
                  </span>

                  <span className="eq-celula">
                    <span className="eq-carga" title={`${a.emAtendimento} de ${a.capacidadeSimultanea} conversas ao mesmo tempo`}>
                      <span className="eq-carga__texto mono">
                        {a.emAtendimento}/{a.capacidadeSimultanea}
                        <span className="eq-carga__sufixo"> conversas</span>
                      </span>
                      <span className="eq-carga__trilho" aria-hidden="true">
                        <span className={`eq-carga__barra eq-carga__barra--${nivel}`} style={{ width: `${carga * 100}%` }} />
                      </span>
                    </span>
                  </span>

                  <span className="eq-celula">
                    <span className={`eq-situacao${a.ativo ? '' : ' eq-situacao--inativa'}`}>
                      <span className={`eq-ponto eq-ponto--${a.ativo ? 'sucesso' : 'neutro'}`} aria-hidden="true" />
                      {a.ativo ? 'Ativo' : 'Inativo'}
                    </span>
                  </span>

                  <span className="eq-acoes">
                    <MenuAcoes
                      rotulo={`Ações de ${a.nome}`}
                      acoes={[
                        { rotulo: 'Editar', aoClicar: editar, desabilitado: !mexe, dica: bloqueio },
                        ligada('avisos_gerencia') && {
                          rotulo: '⚠ Mandar aviso',
                          aoClicar: () => setModal({ tipo: 'aviso', pessoa: a }),
                          desabilitado: !mexe || !a.ativo,
                          dica: !a.ativo ? 'Conta desativada' : bloqueio
                        },
                        !souEu && {
                          rotulo: 'Excluir acesso',
                          perigo: true,
                          aoClicar: () => excluirPessoa(a),
                          desabilitado: !mexe || excluir.isPending,
                          dica: bloqueio
                        }
                      ]}
                    />
                  </span>
                </div>
              );
            })
          )}

          <p className="eq-lista__rodape">
            {visiveis.length === todos.length
              ? `${todos.length} pessoa${todos.length === 1 ? '' : 's'} com acesso`
              : `Mostrando ${visiveis.length} de ${todos.length}`}
          </p>
        </section>
      )}

      {(modal?.tipo === 'novo' || modal?.tipo === 'editar') && (
        <ModalAtendente
          pessoa={modal.pessoa}
          aoFechar={fechar}
          aoSalvar={() => {
            fechar();
            queryClient.invalidateQueries({ queryKey: ['atendentes'] });
          }}
        />
      )}

      {modal?.tipo === 'aviso' && (
        <ModalAviso
          pessoa={modal.pessoa}
          aoFechar={fechar}
          aoEnviar={() => {
            setResultado({ tom: 'sucesso', texto: `Aviso enviado para ${modal.pessoa.nome}.` });
            fechar();
          }}
        />
      )}
    </div>
  );
}

/**
 * Escrever o aviso que aparece por cima de tudo na tela do atendente.
 *
 * A previa mostra exatamente o que a pessoa vai ver — e um recado que
 * interrompe o trabalho dela, entao vale conferir antes de mandar.
 */
const LIMITE_AVISO = 500;

function ModalAviso({ pessoa, aoFechar, aoEnviar }) {
  const [mensagem, setMensagem] = useState('');

  const enviar = useMutation({
    mutationFn: () => api.post(`/api/usuarios/${pessoa.id}/avisos`, { mensagem: mensagem.trim() }),
    onSuccess: aoEnviar
  });

  const vazio = mensagem.trim() === '';

  return (
    <Modal
      titulo={`Mandar aviso para ${pessoa.nome}`}
      aberto
      aoFechar={aoFechar}
      largura={560}
      rodape={
        <>
          <Botao variante="secundario" onClick={aoFechar}>
            Cancelar
          </Botao>
          <Botao variante="perigo" carregando={enviar.isPending} disabled={vazio} onClick={() => enviar.mutate()}>
            Enviar aviso agora
          </Botao>
        </>
      }
    >
      <div className="coluna">
        <Aviso tom="alerta">
          O aviso abre <strong>por cima de tudo</strong> na tela de {pessoa.nome}, piscando, e só fecha quando
          ele(a) clicar em "Entendi". Se estiver fora do sistema, aparece assim que entrar.
        </Aviso>

        {enviar.isError && <Aviso tom="perigo">{enviar.error.message}</Aviso>}

        <Campo rotulo="Mensagem" obrigatorio dica={`${mensagem.length}/${LIMITE_AVISO} caracteres`}>
          <AreaTexto
            value={mensagem}
            maxLength={LIMITE_AVISO}
            rows={4}
            autoFocus
            placeholder="Ex.: Cliente da mesa 3 está esperando há 10 minutos, responda agora."
            onChange={(e) => setMensagem(e.target.value)}
          />
        </Campo>

        <div>
          <div className="texto-fraco" style={{ marginBottom: 'var(--e2)' }}>
            Como vai aparecer:
          </div>
          <div className="aviso-previa" aria-hidden="true">
            <div className="aviso-previa__faixa">
              <span className="aviso-previa__icone">!</span>
              <strong>AVISO DA GERÊNCIA</strong>
            </div>
            <p className={`aviso-previa__texto${vazio ? ' aviso-previa__texto--vazio' : ''}`}>
              {vazio ? 'Sua mensagem aparece aqui.' : mensagem}
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Le a configuracao da equipe e devolve o que as duas secoes precisam. */
function useConfiguracaoDaEquipe() {
  const queryClient = useQueryClient();
  const { podeAcessar } = useAuth();

  const consulta = useQuery({
    queryKey: ['equipe', 'configuracao'],
    queryFn: () => api.get('/api/equipe/configuracao')
  });

  const salvar = useMutation({
    mutationFn: (dados) => api.put('/api/equipe/configuracao', dados),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['equipe', 'configuracao'] })
  });

  return { consulta, salvar, config: consulta.data?.configuracao, podeEditar: podeAcessar('owner') };
}

function Distribuicao() {
  const { consulta, salvar, config, podeEditar } = useConfiguracaoDaEquipe();
  if (consulta.isLoading || !config) return <Carregando />;

  const criterioAtual = config.opcoes.criterios.find((c) => c.chave === config.criterioDistribuicao);

  return (
    <div className="coluna">
      {salvar.isError && <Aviso tom="perigo">{salvar.error.message}</Aviso>}
      {!podeEditar && <Aviso tom="info">Só o dono altera estas configurações. Você está vendo como elas estão hoje.</Aviso>}

      <Cartao titulo="Como a conversa chega ao atendente">
        <div className="coluna">
          <label className="opcao">
            <input
              type="checkbox"
              checked={config.distribuicaoAutomatica}
              disabled={!podeEditar || salvar.isPending}
              onChange={(e) => salvar.mutate({ distribuicaoAutomatica: e.target.checked })}
            />
            <span>
              <strong>Distribuir automaticamente</strong>
              <div className="texto-fraco">
                Quando o cliente pede atendimento humano, o sistema já entrega a conversa a alguém. Desligado, ela
                espera na fila até alguém clicar em "Assumir".
              </div>
            </span>
          </label>

          <Campo rotulo="Critério" dica="Vale quando a distribuição automática está ligada.">
            <Selecao
              value={config.criterioDistribuicao}
              disabled={!podeEditar || !config.distribuicaoAutomatica || salvar.isPending}
              onChange={(e) => salvar.mutate({ criterioDistribuicao: e.target.value })}
            >
              {config.opcoes.criterios.map((c) => (
                <option key={c.chave} value={c.chave}>
                  {c.rotulo}
                </option>
              ))}
            </Selecao>
            {criterioAtual && (
              <p className="texto-fraco" style={{ marginTop: 'var(--e1)' }}>
                {criterioAtual.descricao}
              </p>
            )}
          </Campo>

          <label className="opcao">
            <input
              type="checkbox"
              checked={config.distribuirSomenteOnline}
              disabled={!podeEditar || salvar.isPending}
              onChange={(e) => salvar.mutate({ distribuirSomenteOnline: e.target.checked })}
            />
            <span>
              <strong>Só quem está online recebe</strong>
              <div className="texto-fraco">
                Desligado, quem está "ausente" também entra na roda. Quem está offline nunca recebe automaticamente —
                mas continua podendo receber uma transferência.
              </div>
            </span>
          </label>

          <label className="opcao">
            <input
              type="checkbox"
              checked={config.distribuirParaGerencia}
              disabled={!podeEditar || salvar.isPending}
              onChange={(e) => salvar.mutate({ distribuirParaGerencia: e.target.checked })}
            />
            <span>
              <strong>Dono e administradores também recebem</strong>
              <div className="texto-fraco">
                Desligado (recomendado), só quem tem cargo de atendente recebe conversas e horários marcados pela IA.
                Ligue se a gerência também atende clientes. Se a empresa não tiver nenhum atendente ativo, a gerência
                assume de qualquer forma, para nenhum horário ficar sem responsável.
              </div>
            </span>
          </label>
        </div>
      </Cartao>

      <Cartao titulo="Capacidade de cada pessoa">
        <p className="texto-suave">
          Quantas conversas cada atendente aguenta ao mesmo tempo aparece em Pessoas. Quem está no limite é pulado
          pela distribuição automática, e a conversa espera na fila em vez de cair em cima de alguém afogado.
        </p>
      </Cartao>
    </div>
  );
}

function Privacidade() {
  const { consulta, salvar, config, podeEditar } = useConfiguracaoDaEquipe();
  if (consulta.isLoading || !config) return <Carregando />;

  return (
    <div className="coluna">
      {salvar.isError && <Aviso tom="perigo">{salvar.error.message}</Aviso>}
      {!podeEditar && (
        <Aviso tom="info">
          Só o dono altera esta configuração — nem o administrador. Quem é acompanhado não decide a regra do
          acompanhamento.
        </Aviso>
      )}

      <Cartao titulo="Quem enxerga o atendimento de quem">
        <div className="coluna">
          {config.opcoes.privacidade.map((o) => {
            const ativo = config.privacidade === o.chave;
            return (
              <label key={o.chave} className={`opcao opcao--cartao${ativo ? ' opcao--ativa' : ''}`}>
                <input
                  type="radio"
                  name="privacidade"
                  checked={ativo}
                  disabled={!podeEditar || salvar.isPending}
                  onChange={() => salvar.mutate({ privacidade: o.chave })}
                />
                <span>
                  <strong>{o.rotulo}</strong>
                  <div className="texto-fraco">{o.descricao}</div>
                </span>
              </label>
            );
          })}
        </div>
      </Cartao>

      {/* A recepcao organiza os horarios de todos: sem esta opcao, a
          privacidade acima recortava tambem a agenda e ela via 0 horarios. */}
      <Cartao titulo="Agenda">
        <label className="opcao">
          <input
            type="checkbox"
            checked={Boolean(config.agendaCompletaParaEquipe)}
            disabled={!podeEditar || salvar.isPending}
            onChange={(e) => salvar.mutate({ agendaCompletaParaEquipe: e.target.checked })}
          />
          <span>
            <strong>Toda a equipe vê a agenda completa</strong>
            <div className="texto-fraco">
              Para quem organiza a recepção. As conversas continuam com a regra acima, e o faturamento continua visível
              só para quem já via.
            </div>
          </span>
        </label>
      </Cartao>

      {/* A "assinatura": o nome de quem respondeu no topo da mensagem que o
          cliente recebe. So muda o WhatsApp dele — no livechat o autor ja
          aparece em cima de cada balao. */}
      <Cartao titulo="Assinatura nas mensagens">
        <div className="coluna">
          <p className="texto-suave">
            O nome de quem respondeu aparece em negrito no topo da mensagem que o cliente recebe no WhatsApp.
          </p>

          <label className="opcao">
            <input
              type="checkbox"
              checked={Boolean(config.assinaturaAtendente)}
              disabled={!podeEditar || salvar.isPending}
              onChange={(e) => salvar.mutate({ assinaturaAtendente: e.target.checked })}
            />
            <span>
              <strong>Assinar as mensagens dos atendentes</strong>
              <div className="texto-fraco">
                O cliente sabe com quem está falando. Vale para texto e legenda de foto; áudio sai sem.
              </div>
            </span>
          </label>

          <label className="opcao">
            <input
              type="checkbox"
              checked={Boolean(config.assinaturaSofia)}
              disabled={!podeEditar || salvar.isPending}
              onChange={(e) => salvar.mutate({ assinaturaSofia: e.target.checked })}
            />
            <span>
              <strong>Assinar as respostas da Sofia</strong>
              <div className="texto-fraco">
                Só no primeiro balão de cada resposta. As respostas prontas do menu saem sem assinatura.
              </div>
            </span>
          </label>

          {(config.assinaturaAtendente || config.assinaturaSofia) && (
            <div className="assinatura-previa" aria-label="Como o cliente vê">
              <span className="assinatura-previa__rotulo">Como o cliente vê</span>
              <div className="assinatura-previa__balao">
                <strong>{config.assinaturaAtendente ? 'Carlos' : 'Sofia'}:</strong>
                <span>Oi! Seu horário de sexta às 15h está confirmado. 😉</span>
              </div>
            </div>
          )}
        </div>
      </Cartao>

      <Cartao titulo="O que a regra alcança">
        <ul className="lista-regra">
          <li>
            <strong>Conversas</strong> — somem da mesa de quem não atende. Conversa na fila ou com a IA continua
            visível a todos: é dela que sai o trabalho.
          </li>
          <li>
            <strong>Agenda</strong> — cada um vê o que marcou, o que vai executar e o que veio das conversas dele.
          </li>
          <li>
            <strong>Quadro de atendimentos</strong> — os mesmos cartões da agenda e das conversas.
          </li>
          <li>
            <strong>Números do painel</strong> — faturamento e métricas seguem o mesmo recorte.
          </li>
          <li className="texto-fraco">
            O histórico do cliente (no perfil dele) continua completo para quem está atendendo: sem isso, um atendente
            remarcaria por cima de um horário que não consegue ver.
          </li>
        </ul>
      </Cartao>
    </div>
  );
}

/**
 * Cadastro e edicao de atendente — o mesmo formulario.
 *
 * Na edicao, a senha e opcional: em branco, fica a atual. Preenchida, troca e
 * derruba as sessoes abertas (o "esqueci a senha" resolvido pelo gerente).
 */
function ModalAtendente({ pessoa, aoFechar, aoSalvar }) {
  const { usuario: eu } = useAuth();
  const editando = Boolean(pessoa);
  const souEu = pessoa?.id === eu?.id;

  const [form, setForm] = useState({
    nome: pessoa?.nome ?? '',
    username: pessoa?.username ?? '',
    email: pessoa?.email ?? '',
    telefone: pessoa?.telefone ?? '',
    senha: '',
    cargo: pessoa?.cargo ?? 'atendente',
    capacidadeSimultanea: String(pessoa?.capacidadeSimultanea ?? 5),
    ativo: pessoa?.ativo ?? true
  });

  const salvar = useMutation({
    mutationFn: () => {
      if (!editando) {
        return api.post('/api/usuarios', {
          nome: form.nome,
          username: form.username,
          email: form.email || undefined,
          senha: form.senha,
          cargo: form.cargo
        });
      }
      return api.patch(`/api/usuarios/${pessoa.id}`, {
        nome: form.nome,
        username: form.username,
        email: form.email,
        telefone: form.telefone,
        capacidadeSimultanea: Number(form.capacidadeSimultanea),
        ...(souEu ? {} : { cargo: form.cargo, ativo: form.ativo }),
        ...(form.senha ? { novaSenha: form.senha } : {})
      });
    },
    onSuccess: aoSalvar
  });

  const erros = salvar.error?.camposComErro ?? {};
  const faltaAlgo = !form.nome || !form.username || (!editando && !form.senha);

  return (
    <Modal
      titulo={editando ? `Editar ${pessoa.nome}` : 'Cadastrar atendente'}
      aberto
      aoFechar={aoFechar}
      largura={680}
      rodape={
        <>
          <Botao variante="secundario" onClick={aoFechar}>
            Cancelar
          </Botao>
          <Botao carregando={salvar.isPending} disabled={faltaAlgo} onClick={() => salvar.mutate()}>
            {editando ? 'Salvar' : 'Cadastrar'}
          </Botao>
        </>
      }
    >
      {salvar.isError && salvar.error.codigo !== 'VALIDACAO' && <Aviso tom="perigo">{salvar.error.message}</Aviso>}

      {/* Duas colunas (uma no celular): o formulario inteiro cabe na tela, sem
          rolar. Dicas curtas; a de "trocar senha derruba a sessao" so aparece
          quando alguem de fato digita uma senha nova. */}
      <div className="eq-form">
        <Campo rotulo="Nome" obrigatorio erro={erros.nome}>
          <Entrada value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
        </Campo>
        <Campo rotulo="Usuário para entrar" obrigatorio erro={erros.username}>
          <Entrada value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </Campo>
        <Campo rotulo="E-mail" erro={erros.email}>
          <Entrada type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Campo>
        {editando ? (
          <Campo rotulo="Telefone" erro={erros.telefone}>
            <Entrada value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} />
          </Campo>
        ) : (
          <Campo rotulo="Senha provisória" obrigatorio erro={erros.senha} dica="A pessoa troca depois de entrar.">
            <Entrada type="text" value={form.senha} onChange={(e) => setForm({ ...form, senha: e.target.value })} />
          </Campo>
        )}
        {editando && (
          <Campo
            rotulo="Nova senha"
            erro={erros.senha ?? erros.novaSenha}
            dica={form.senha ? 'Ao salvar, a pessoa sai do sistema e entra com a nova.' : 'Em branco, fica a atual.'}
          >
            <Entrada type="text" value={form.senha} onChange={(e) => setForm({ ...form, senha: e.target.value })} />
          </Campo>
        )}
        <Campo rotulo="Cargo" dica={souEu ? 'Você não pode trocar o próprio cargo.' : 'Admin também configura o sistema.'}>
          <Selecao value={form.cargo} disabled={souEu} onChange={(e) => setForm({ ...form, cargo: e.target.value })}>
            <option value="atendente">Atendente</option>
            <option value="admin">Administrador</option>
            {(eu?.cargo === 'owner' || form.cargo === 'owner') && <option value="owner">Dono</option>}
          </Selecao>
        </Campo>
        {editando && (
          <Campo
            rotulo="Atende até (ao mesmo tempo)"
            erro={erros.capacidadeSimultanea}
            dica="No limite, a distribuição pula a pessoa."
          >
            <Entrada
              type="number"
              min={1}
              max={50}
              value={form.capacidadeSimultanea}
              onChange={(e) => setForm({ ...form, capacidadeSimultanea: e.target.value })}
            />
          </Campo>
        )}
        {editando && !souEu && (
          <div className="eq-form__interruptor">
            <Interruptor
              rotulo="Conta ativa"
              descricao={form.ativo ? 'Pode entrar no sistema.' : 'Ao salvar, sai na hora e não entra mais.'}
              ligado={form.ativo}
              aoAlternar={(ativo) => setForm({ ...form, ativo })}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
