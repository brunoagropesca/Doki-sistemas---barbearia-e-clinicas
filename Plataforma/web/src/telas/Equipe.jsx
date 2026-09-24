import { useState } from 'react';
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
import { useAuth } from '../lib/autenticacao.jsx';
import { EscolherFoto } from './equipe/EscolherFoto.jsx';
import { useFuncoes } from '../lib/funcoes.jsx';
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
  { id: 'profissionais', titulo: 'Profissionais' },
  { id: 'atendentes', titulo: 'Atendentes' }
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
  const [aba, setAba] = useState('profissionais');

  return (
    <div className="coluna">
      <header>
        <h1>Equipe</h1>
        <p className="texto-suave">Quem atende na cadeira e quem atende no sistema.</p>
      </header>

      <div className="abas" role="tablist">
        {ABAS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="tab"
            aria-selected={aba === a.id}
            className={`abas__aba${aba === a.id ? ' abas__aba--ativa' : ''}`}
            onClick={() => setAba(a.id)}
          >
            {a.titulo}
          </button>
        ))}
      </div>

      {aba === 'profissionais' ? <Profissionais /> : <Atendentes />}
    </div>
  );
}

function Profissionais() {
  const queryClient = useQueryClient();
  const [fichaAberta, setFichaAberta] = useState(null); // id, ou 'novo'
  const [verInativos, setVerInativos] = useState(false);

  const lista = useQuery({
    queryKey: ['profissionais', verInativos],
    queryFn: () => api.get('/api/profissionais', verInativos ? { incluirInativos: 'true' } : {})
  });

  const excluir = useMutation({
    mutationFn: (id) => api.delete(`/api/profissionais/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profissionais'] })
  });

  const profissionais = lista.data?.profissionais ?? [];

  return (
    <div className="coluna">
      <div className="linha linha--entre">
        <Botao variante={verInativos ? 'secundario' : 'fantasma'} tamanho="sm" onClick={() => setVerInativos((v) => !v)}>
          {verInativos ? 'Ocultar inativos' : 'Ver inativos'}
        </Botao>
        <Botao onClick={() => setFichaAberta('novo')}>Cadastrar profissional</Botao>
      </div>

      {excluir.isError && <Aviso tom="perigo">{excluir.error.message}</Aviso>}
      {excluir.data?.desativado && <Aviso tom="alerta">{excluir.data.mensagem}</Aviso>}

      {lista.isLoading ? (
        <Carregando />
      ) : profissionais.length === 0 ? (
        <Vazio
          titulo="Nenhum profissional cadastrado"
          descricao="Cadastre quem executa os servicos para que eles apareçam na agenda."
          acao={<Botao onClick={() => setFichaAberta('novo')}>Cadastrar profissional</Botao>}
        />
      ) : (
        <div className="equipe-grade">
          {profissionais.map((p) => (
            <article key={p.id} className={`pessoa${p.ativo ? '' : ' pessoa--inativa'}`}>
              <div className="pessoa__topo">
                <span className="pessoa__foto" style={{ borderColor: p.cor }}>
                  {p.fotoUrl ? <img src={p.fotoUrl} alt="" /> : <span aria-hidden="true">{p.nome.slice(0, 1)}</span>}
                </span>
                <div className="crescer">
                  <strong>{p.nome}</strong>
                  <div className="texto-fraco">{p.funcao}</div>
                  {p.telefoneFormatado && <div className="texto-fraco mono">{p.telefoneFormatado}</div>}
                </div>
                {!p.ativo && <Etiqueta tom="neutro">Inativo</Etiqueta>}
              </div>

              <div className="pessoa__servicos">
                {p.servicos.length === 0 ? (
                  <span className="texto-fraco">Nenhum servico atribuido — nao aparece ao marcar horario.</span>
                ) : (
                  p.servicos.slice(0, 4).map((s) => (
                    <Etiqueta key={s.serviceId} tom={s.precoProprio || s.duracaoPropria ? 'info' : 'neutro'}>
                      {s.nome} · {s.precoFormatado} · {s.duracaoMinutos} min
                    </Etiqueta>
                  ))
                )}
                {p.servicos.length > 4 && <Etiqueta tom="neutro">+{p.servicos.length - 4}</Etiqueta>}
              </div>

              <div className="linha linha--fim">
                <Botao variante="secundario" tamanho="sm" onClick={() => setFichaAberta(p.id)}>
                  Abrir ficha
                </Botao>
                <Botao
                  variante="fantasma"
                  tamanho="sm"
                  onClick={() => {
                    if (confirm(`Remover ${p.nome} da equipe?`)) excluir.mutate(p.id);
                  }}
                >
                  Remover
                </Botao>
              </div>
            </article>
          ))}
        </div>
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
 * Tres assuntos diferentes moram aqui, e por isso a secao tem chips proprios:
 * as PESSOAS (cadastro), como o trabalho CHEGA a elas (distribuicao) e quem
 * enxerga o atendimento de quem (privacidade). Misturar os tres numa tela so
 * faria a configuracao mais delicada do sistema — a privacidade — virar um
 * campo perdido no rodape de uma tabela.
 */
const SECOES_ATENDENTE = [
  { id: 'pessoas', titulo: 'Pessoas' },
  { id: 'distribuicao', titulo: 'Distribuição' },
  { id: 'privacidade', titulo: 'Privacidade' }
];

function Atendentes() {
  const [secao, setSecao] = useState('pessoas');

  return (
    <div className="coluna">
      <div className="abas" role="tablist">
        {SECOES_ATENDENTE.map((s) => (
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

      {secao === 'pessoas' && <Pessoas />}
      {secao === 'distribuicao' && <Distribuicao />}
      {secao === 'privacidade' && <Privacidade />}
    </div>
  );
}

/** Espelha a hierarquia do servidor: ninguem mexe em quem esta acima do proprio cargo. */
const NIVEL_CARGO = { atendente: 10, admin: 20, owner: 30, dev: 100 };

function Pessoas() {
  const queryClient = useQueryClient();
  const { usuario: eu } = useAuth();
  const { ligada } = useFuncoes();
  // null | { tipo: 'novo' } | { tipo: 'editar' | 'aviso', pessoa }
  const [modal, setModal] = useState(null);
  const [resultado, setResultado] = useState(null);

  const lista = useQuery({ queryKey: ['atendentes'], queryFn: () => api.get('/api/atendentes') });
  const atendentes = lista.data?.atendentes ?? [];

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

  return (
    <div className="coluna">
      <div className="linha linha--fim">
        <Botao onClick={() => setModal({ tipo: 'novo' })}>Cadastrar atendente</Botao>
      </div>

      {resultado && (
        <Aviso tom={resultado.tom} aoFechar={() => setResultado(null)}>
          {resultado.texto}
        </Aviso>
      )}

      {lista.isLoading ? (
        <Carregando />
      ) : (
        <Cartao semPadding>
          <Tabela cabecalho={['Nome', 'Usuario', 'Cargo', 'Presenca', 'Atende ate', 'Situacao', 'Ações']}>
            {atendentes.map((a) => {
              const mexe = podeMexer(a);
              const souEu = a.id === eu?.id;
              const bloqueio = mexe ? undefined : 'Cargo acima do seu';
              return (
                <tr key={a.id}>
                  <td>
                    <strong>{a.nome}</strong>
                    {souEu && <span className="texto-fraco"> (você)</span>}
                    {a.email && <div className="texto-fraco">{a.email}</div>}
                  </td>
                  <td className="mono">{a.username}</td>
                  <td>
                    <Etiqueta tom={a.cargo === 'owner' || a.cargo === 'admin' ? 'primario' : 'neutro'}>{a.cargo}</Etiqueta>
                  </td>
                  <td>
                    <Etiqueta tom={a.statusPresenca === 'online' ? 'sucesso' : 'neutro'}>{a.statusPresenca}</Etiqueta>
                  </td>
                  <td className="mono">{a.capacidadeSimultanea} conversas</td>
                  <td>{a.ativo ? <Etiqueta tom="sucesso">Ativo</Etiqueta> : <Etiqueta tom="neutro">Inativo</Etiqueta>}</td>
                  <td>
                    <div className="pessoa-acoes">
                      <Botao
                        variante="secundario"
                        tamanho="sm"
                        disabled={!mexe}
                        title={bloqueio}
                        onClick={() => setModal({ tipo: 'editar', pessoa: a })}
                      >
                        Editar
                      </Botao>
                      {ligada('avisos_gerencia') && (
                        <Botao
                          variante="secundario"
                          tamanho="sm"
                          disabled={!mexe || !a.ativo}
                          title={!a.ativo ? 'Conta desativada' : bloqueio}
                          onClick={() => setModal({ tipo: 'aviso', pessoa: a })}
                        >
                          <span aria-hidden="true">⚠</span> Mandar aviso
                        </Botao>
                      )}
                      {!souEu && (
                        <Botao
                          variante="perigo"
                          tamanho="sm"
                          disabled={!mexe}
                          title={bloqueio}
                          carregando={excluir.isPending && excluir.variables === a.id}
                          onClick={() => {
                            if (
                              confirm(
                                `Excluir ${a.nome}?\n\nO acesso dele(a) ao sistema acaba na hora e as conversas que estão com ele(a) voltam para a fila.`
                              )
                            ) {
                              excluir.mutate(a.id);
                            }
                          }}
                        >
                          Excluir
                        </Botao>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </Tabela>
        </Cartao>
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
      largura={520}
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

      <Campo rotulo="Nome" obrigatorio erro={erros.nome}>
        <Entrada value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
      </Campo>
      <Campo rotulo="Usuario para entrar" obrigatorio erro={erros.username}>
        <Entrada value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
      </Campo>
      <Campo rotulo="E-mail" erro={erros.email}>
        <Entrada type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </Campo>
      {editando && (
        <Campo rotulo="Telefone" erro={erros.telefone}>
          <Entrada value={form.telefone} onChange={(e) => setForm({ ...form, telefone: e.target.value })} />
        </Campo>
      )}
      <Campo
        rotulo={editando ? 'Nova senha' : 'Senha provisoria'}
        obrigatorio={!editando}
        erro={erros.senha ?? erros.novaSenha}
        dica={
          editando
            ? 'Deixe em branco para manter a atual. Se trocar, a pessoa sai do sistema e entra com a nova.'
            : 'A pessoa troca depois de entrar.'
        }
      >
        <Entrada type="text" value={form.senha} onChange={(e) => setForm({ ...form, senha: e.target.value })} />
      </Campo>
      <Campo
        rotulo="Cargo"
        dica={souEu ? 'Voce nao pode trocar o proprio cargo.' : 'Atendente ve conversas e agenda; admin configura o sistema.'}
      >
        <Selecao value={form.cargo} disabled={souEu} onChange={(e) => setForm({ ...form, cargo: e.target.value })}>
          <option value="atendente">Atendente</option>
          <option value="admin">Administrador</option>
          {(eu?.cargo === 'owner' || form.cargo === 'owner') && <option value="owner">Dono</option>}
        </Selecao>
      </Campo>
      {editando && (
        <>
          <Campo
            rotulo="Atende ate (conversas ao mesmo tempo)"
            erro={erros.capacidadeSimultanea}
            dica="Quem esta no limite e pulado pela distribuicao automatica."
          >
            <Entrada
              type="number"
              min={1}
              max={50}
              value={form.capacidadeSimultanea}
              onChange={(e) => setForm({ ...form, capacidadeSimultanea: e.target.value })}
            />
          </Campo>
          {!souEu && (
            <label className="opcao">
              <input
                type="checkbox"
                checked={form.ativo}
                onChange={(e) => setForm({ ...form, ativo: e.target.checked })}
              />
              <span>
                <strong>Conta ativa</strong>
                <div className="texto-fraco">Desmarcado, a pessoa sai do sistema na hora e nao consegue entrar.</div>
              </span>
            </label>
          )}
        </>
      )}
    </Modal>
  );
}
