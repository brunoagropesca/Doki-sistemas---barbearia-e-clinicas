import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Aviso, AreaTexto, Botao, Campo, Carregando, Entrada, Selecao } from '../../componentes/ui.jsx';
import { CartaoAquiles } from './CartaoAquiles.jsx';
import { AvaliacaoGoogle } from './AvaliacaoGoogle.jsx';

/**
 * Aba "Personas dos Agentes".
 *
 * Tres blocos: como o WhatsApp e atendido (modo), o ritmo (contexto e
 * agrupamento) e os agentes. A Sofia conversa; a Atena mexe nos dados; o
 * Aquiles escreve as mensagens das campanhas.
 */

const MODOS = [
  {
    chave: 'menu',
    icone: '📋',
    titulo: 'Menu Tradicional',
    sub: '100% Estático • Zero Tokens',
    selo: '0 TOKENS',
    seloTom: 'sucesso',
    texto:
      'Árvore rígida de opções numeradas (até 10 opções e 5 ramificações). Respostas geradas diretamente do banco, sem consumo de IA.'
  },
  {
    chave: 'hibrido',
    icone: '⚡',
    titulo: 'Modo Híbrido',
    sub: 'Menu Estático + IA no Desvio de Fluxo',
    selo: 'RECOMENDADO',
    seloTom: 'primario',
    texto:
      'O cliente navega no menu com 0 tokens. Ao enviar dúvidas ou linguagem livre fora do menu, a Sofia (IA) assume na hora.'
  },
  {
    chave: 'ia',
    icone: '🧠',
    titulo: 'IA no Comando',
    sub: '100% IA • Sofia e Atena',
    selo: 'IA AUTÔNOMA',
    seloTom: 'perigo',
    texto:
      'A inteligência artificial atende todas as mensagens do cliente em linguagem natural contínua, consultando o banco conforme necessário.'
  }
];

const OPCOES_CONTEXTO = [
  [2, '2 mensagens (Mínimo • ~200 tokens)'],
  [4, '4 mensagens (Econômico • ~400 tokens)'],
  [8, '8 mensagens (Equilibrado • ~800 tokens)'],
  [12, '12 mensagens (Amplo • ~1.200 tokens)'],
  [20, '20 mensagens (Máximo • ~2.000 tokens)']
];

const OPCOES_FECHAMENTO = ['18:00', '19:00', '20:00', '21:00', '22:00', '23:00', '23:30'].map((h) => [h, `${h}`]);

/** Horario do lembrete de vespera: fim de tarde, quando o cliente ainda pode remarcar. */
const OPCOES_LEMBRETE = ['12:00', '14:00', '16:00', '17:00', '18:00', '19:00', '20:00'].map((h) => [h, `${h}`]);

const OPCOES_AGRUPAMENTO = [
  [0, 'Desligado (responde na hora)'],
  [3, '3 segundos (Rápido)'],
  [5, '5 segundos (Equilibrado)'],
  [8, '8 segundos (Longo • Máxima economia de tokens)'],
  [12, '12 segundos (Muito longo)']
];

const NOMES_PROVEDOR = { gemini: 'Gemini Primário', groq: 'Groq', openai: 'ChatGPT', ollama: 'Ollama', anthropic: 'Claude' };

/** Garante que o valor atual aparece no select mesmo que nao esteja na lista padrao. */
function comValorAtual(opcoes, atual, formatar) {
  return opcoes.some(([v]) => v === atual) ? opcoes : [...opcoes, [atual, formatar(atual)]].sort((a, b) => a[0] - b[0]);
}

export function Personas() {
  const queryClient = useQueryClient();

  const cfg = useQuery({ queryKey: ['atendimento'], queryFn: () => api.get('/api/atendimento/configuracao') });
  const agentes = useQuery({ queryKey: ['ia', 'agentes'], queryFn: () => api.get('/api/ia/agentes') });
  const provedores = useQuery({ queryKey: ['ia', 'provedores'], queryFn: () => api.get('/api/ia/provedores') });

  const salvarCfg = useMutation({
    mutationFn: (dados) => api.put('/api/atendimento/configuracao', dados),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['atendimento'] })
  });

  // O agente aberto mora no endereco (?agente=aquiles): F5 e link direto
  // voltam para o mesmo agente. Os outros parametros (a aba) sao preservados.
  const [params, setParams] = useSearchParams();
  const pedido = params.get('agente');
  const escolhido = ELENCO.some((e) => e.chave === pedido) ? pedido : 'atendente';
  const escolher = (chave) => {
    const novos = new URLSearchParams(params);
    novos.set('agente', chave);
    setParams(novos, { replace: true });
  };

  if (cfg.isLoading || agentes.isLoading) return <Carregando />;
  if (cfg.isError) return <Aviso tom="perigo">{cfg.error.message}</Aviso>;
  if (agentes.isError) return <Aviso tom="perigo">{agentes.error.message}</Aviso>;

  const c = cfg.data;
  const modoAtivo = MODOS.find((m) => m.chave === c.modo) ?? MODOS[1];

  // A ordem real da cascata, para a descricao do "Modelo de IA" ser verdadeira.
  const cadeia = (provedores.data?.provedores ?? [])
    .filter((p) => p.habilitado)
    .sort((a, b) => a.prioridade - b.prioridade)
    .map((p) => NOMES_PROVEDOR[p.provedor] ?? p.provedor);

  const sofia = agentes.data.agentes.find((a) => a.chave === 'atendente');
  const atena = agentes.data.agentes.find((a) => a.chave === 'atena');
  const aquiles = agentes.data.agentes.find((a) => a.chave === 'aquiles');

  return (
    <div className="coluna">
      {salvarCfg.isError && <Aviso tom="perigo">{salvarCfg.error.message}</Aviso>}

      <section className="ci-secao-agentes" aria-labelledby="ci-titulo-agentes">
        <header className="ci-secao-agentes__topo">
          <h2 id="ci-titulo-agentes" className="ci-titulo-secao">
            <span aria-hidden="true">🤖</span> Agentes de IA
          </h2>
          <p className="texto-fraco">
            Cada agente tem uma função, uma personalidade e, se quiser, um modelo próprio. Escolha um para ajustar.
          </p>
        </header>

        <div className="ci-agentes-layout">
          <Elenco agentes={agentes.data.agentes} escolhido={escolhido} aoEscolher={escolher} />

          {/* Os tres ficam montados e so mudam de visibilidade: o que foi digitado
              num agente nao se perde ao olhar outro (o formulario mora em cada cartao). */}
          <div className="ci-agentes-painel">
            {sofia && (
              <div role="tabpanel" id="ci-painel-atendente" aria-labelledby="ci-elenco-atendente" hidden={escolhido !== 'atendente'}>
                <CartaoSofia
                  agente={sofia}
                  tons={agentes.data.tons}
                  cadeia={cadeia}
                  permissoes={agentes.data.permissoesSofia}
                  atenaLigada={atena?.ativo !== false}
                />
              </div>
            )}
            {atena && (
              <div role="tabpanel" id="ci-painel-atena" aria-labelledby="ci-elenco-atena" hidden={escolhido !== 'atena'}>
                <CartaoAtena agente={atena} permissoes={agentes.data.permissoesAtena} cadeia={cadeia} />
              </div>
            )}
            {aquiles && (
              <div role="tabpanel" id="ci-painel-aquiles" aria-labelledby="ci-elenco-aquiles" hidden={escolhido !== 'aquiles'}>
                <CartaoAquiles agente={aquiles} provedores={provedores.data?.provedores ?? []} />
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="ci-bloco">
        <header className="ci-bloco__topo">
          <div>
            <h2 className="ci-titulo-secao">
              <span aria-hidden="true">⚙️</span> Como o WhatsApp é atendido
            </h2>
            <p className="texto-fraco">
              Escolha a estratégia operacional. O <strong>Modo Híbrido</strong> é o padrão inteligente recomendado
              para economizar tokens.
            </p>
          </div>
          <span className="ci-pilula">
            Modo Ativo: {modoAtivo.titulo} {c.modo === 'menu' ? '(0 Tokens)' : ''}
          </span>
        </header>

        <div className="ci-modos">
          {MODOS.map((m) => {
            const ativo = c.modo === m.chave;
            return (
              <div
                key={m.chave}
                role="radio"
                aria-checked={ativo}
                tabIndex={0}
                className={`ci-modo ${ativo ? 'ci-modo--ativo' : ''}`}
                onClick={() => !ativo && salvarCfg.mutate({ modo: m.chave })}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !ativo) {
                    e.preventDefault();
                    salvarCfg.mutate({ modo: m.chave });
                  }
                }}
              >
                <div className="ci-modo__topo">
                  <span className="ci-modo__icone" aria-hidden="true">{m.icone}</span>
                  <div className="linha" style={{ gap: 6 }}>
                    <span className={`ci-selo ci-selo--${m.seloTom}`}>{m.selo}</span>
                    {m.chave === 'menu' && (
                      <Link to="/configuracoes?aba=menu" onClick={(e) => e.stopPropagation()}>
                        <Botao tamanho="sm" variante="secundario" type="button">⚙ Configurar</Botao>
                      </Link>
                    )}
                  </div>
                </div>
                <h3>{m.titulo}</h3>
                <p className="ci-modo__sub">{m.sub}</p>
                <p className="texto-fraco">{m.texto}</p>
                <span className="ci-modo__marca">
                  <span className={`ci-radio ${ativo ? 'ci-radio--ligado' : ''}`} aria-hidden="true" />
                  {ativo ? 'Selecionado' : 'Selecionar'}
                </span>
              </div>
            );
          })}
        </div>

        <hr className="ci-divisor" />

        <div className="ci-duas">
          <div className="ci-caixa">
            <div className="ci-caixa__titulo">🧠 Janela de Contexto por Cliente</div>
            <p className="texto-fraco">Quantidade de mensagens anteriores mantidas no prompt para preservar a memória da conversa.</p>
            <Selecao
              value={c.janelaContextoMensagens}
              onChange={(e) => salvarCfg.mutate({ janelaContextoMensagens: Number(e.target.value) })}
            >
              {comValorAtual(OPCOES_CONTEXTO, c.janelaContextoMensagens, (v) => `${v} mensagens`).map(([v, r]) => (
                <option key={v} value={v}>{r}</option>
              ))}
            </Selecao>
          </div>

          <div className="ci-caixa">
            <div className="ci-caixa__titulo">🌙 Fechamento do Dia (Atena)</div>
            <p className="texto-fraco">
              Horário em que a Atena encerra sozinha as sessões finalizadas, arquiva o que terminou e fecha conversas paradas.
              Só roda com a permissão "Fechar o dia sozinha" ligada abaixo.
            </p>
            <Selecao
              value={c.fechamentoHora ?? '22:00'}
              onChange={(e) => salvarCfg.mutate({ fechamentoHora: e.target.value })}
            >
              {comValorAtual(OPCOES_FECHAMENTO, c.fechamentoHora ?? '22:00', (v) => v).map(([v, r]) => (
                <option key={v} value={v}>{r}</option>
              ))}
            </Selecao>
          </div>

          <div className="ci-caixa">
            <div className="ci-caixa__titulo">⏱️ Agrupamento de Mensagens Picotadas</div>
            <p className="texto-fraco">Janela de espera para juntar frases curtas consecutivas antes de acionar a IA.</p>
            <Selecao
              value={c.agrupamentoSegundos}
              onChange={(e) => salvarCfg.mutate({ agrupamentoSegundos: Number(e.target.value) })}
            >
              {comValorAtual(OPCOES_AGRUPAMENTO, c.agrupamentoSegundos, (v) => `${v} segundos`).map(([v, r]) => (
                <option key={v} value={v}>{r}</option>
              ))}
            </Selecao>
          </div>

          <div className="ci-caixa">
            <div className="linha linha--entre">
              <div className="ci-caixa__titulo">🔔 Lembrete na Véspera</div>
              <Interruptor ativo={Boolean(c.lembreteAtivo)} aoMudar={(v) => salvarCfg.mutate({ lembreteAtivo: v })} />
            </div>
            <p className="texto-fraco">
              Na véspera, a partir deste horário, cada cliente com horário marcado para amanhã recebe uma mensagem só
              com todos os seus serviços. Reduz as faltas; se ele responder pedindo para remarcar, a Sofia atende.
            </p>
            <Selecao
              value={c.lembreteHora ?? '18:00'}
              disabled={!c.lembreteAtivo}
              onChange={(e) => salvarCfg.mutate({ lembreteHora: e.target.value })}
            >
              {comValorAtual(OPCOES_LEMBRETE, c.lembreteHora ?? '18:00', (v) => v).map(([v, r]) => (
                <option key={v} value={v}>{r}</option>
              ))}
            </Selecao>
          </div>
        </div>
      </section>

    </div>
  );
}

/**
 * O elenco: quem sao os agentes, o que cada um faz e se esta ligado.
 *
 * A lista mostra so o que se decide de relance (nome, funcao, liga/desliga,
 * modelo). O formulario completo aparece ao lado, so do agente escolhido —
 * tres formularios longos empilhados obrigavam a rolar a pagina inteira para
 * achar o campo de um deles.
 */
const ELENCO = [
  { chave: 'atendente', icone: '👩‍💼', apelido: 'Sofia', funcao: 'Atende o cliente no WhatsApp', cor: 'sofia' },
  { chave: 'atena', icone: '📚', apelido: 'Atena', funcao: 'Consulta e altera agenda e dados', cor: 'atena' },
  { chave: 'aquiles', icone: '🏹', apelido: 'Aquiles', funcao: 'Escreve as mensagens das campanhas', cor: 'aquiles' }
];

/** "groq:qwen/qwen3.8-27b" -> "Groq · qwen/qwen3.8-27b" */
function resumoDoModelo(preferido) {
  if (!preferido) return 'Cascata automática';
  const i = preferido.indexOf(':');
  return `${NOMES_PROVEDOR[preferido.slice(0, i)] ?? preferido.slice(0, i)} · ${preferido.slice(i + 1)}`;
}

function Elenco({ agentes, escolhido, aoEscolher }) {
  const teclar = (e, i) => {
    // Setas andam entre os agentes, como numa lista de abas.
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const passo = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    const proximo = ELENCO[(i + passo + ELENCO.length) % ELENCO.length];
    aoEscolher(proximo.chave);
    document.getElementById(`ci-elenco-${proximo.chave}`)?.focus();
  };

  return (
    <div className="ci-elenco" role="tablist" aria-label="Agentes de IA" aria-orientation="vertical">
      {ELENCO.map((item, i) => {
        const agente = agentes.find((a) => a.chave === item.chave);
        if (!agente) return null;
        const ativo = escolhido === item.chave;
        return (
          <button
            key={item.chave}
            id={`ci-elenco-${item.chave}`}
            type="button"
            role="tab"
            aria-selected={ativo}
            aria-controls={`ci-painel-${item.chave}`}
            tabIndex={ativo ? 0 : -1}
            className={`ci-elenco__item ci-elenco__item--${item.cor} ${ativo ? 'ci-elenco__item--ativo' : ''}`}
            onClick={() => aoEscolher(item.chave)}
            onKeyDown={(e) => teclar(e, i)}
          >
            <span className="ci-elenco__avatar" aria-hidden="true">{item.icone}</span>
            <span className="ci-elenco__texto">
              <strong>{item.apelido}</strong>
              <span>{item.funcao}</span>
              <small>{resumoDoModelo(agente.modeloPreferido)}</small>
            </span>
            <span className={`ci-elenco__estado ${agente.ativo ? 'ci-elenco__estado--ligado' : ''}`}>
              <span aria-hidden="true" className="ci-elenco__ponto" />
              {agente.ativo ? 'Ativo' : 'Desligado'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Liga/desliga um agente e salva o formulario dele. */
function useSalvarAgente(chave) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dados) => api.put(`/api/ia/agentes/${chave}`, dados),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ia', 'agentes'] })
  });
}

function Interruptor({ ativo, aoMudar, desabilitado }) {
  return (
    <label className="ci-interruptor">
      <input type="checkbox" checked={ativo} disabled={desabilitado} onChange={(e) => aoMudar(e.target.checked)} />
      <span className="ci-interruptor__trilho" aria-hidden="true" />
      <span className="ci-interruptor__texto">{ativo ? 'Ativo' : 'Desligado'}</span>
    </label>
  );
}

function CartaoSofia({ agente, tons, cadeia, permissoes, atenaLigada }) {
  const salvar = useSalvarAgente('atendente');

  // O formulario nasce do que o servidor devolveu e NAO e sobrescrito por
  // atualizacoes em segundo plano — senao trocar de aba do navegador e voltar
  // apagaria o que a pessoa estava digitando.
  const [form, setForm] = useState({
    nome: agente.nome,
    tom: agente.tom,
    temperatura: agente.temperatura,
    systemPrompt: agente.systemPrompt,
    ferramentas: agente.ferramentas
  });

  function alternar(chave) {
    setForm((f) => ({
      ...f,
      ferramentas: f.ferramentas.includes(chave) ? f.ferramentas.filter((x) => x !== chave) : [...f.ferramentas, chave]
    }));
  }

  /** Por que um interruptor ligado nao tem efeito agora (ou null). */
  function semEfeito(chave) {
    if (chave === 'reservar' && !form.ferramentas.includes('horarios')) {
      return 'Precisa de “Consultar horários”: ela só marca um horário que a consulta mostrou.';
    }
    if (chave === 'atena' && !atenaLigada) return 'A Atena está desligada: sem efeito até ela ser ligada.';
    return null;
  }

  return (
    <section className="ci-agente ci-agente--sofia">
      <header className="ci-agente__topo">
        <span className="ci-agente__avatar" aria-hidden="true">👩‍💼</span>
        <div className="crescer">
          <h3>{agente.nome}</h3>
          <span className="ci-selo ci-selo--sofia">FRONTLINE • EXPERIÊNCIA DO CLIENTE</span>
        </div>
        <Interruptor ativo={agente.ativo} aoMudar={(ativo) => salvar.mutate({ ativo })} desabilitado={salvar.isPending} />
      </header>

      <div className="ci-modelo ci-modelo--sofia">
        <span aria-hidden="true">⚡</span>
        <div>
          <div>Modelo de IA: <strong>Automático (Cascata de IA)</strong></div>
          <div className="texto-fraco">
            Orquestrado dinamicamente pela cascata {cadeia.length ? `(${cadeia.join(' ➔ ')})` : '(nenhum provedor ativo)'}
          </div>
        </div>
      </div>

      {salvar.isError && <Aviso tom="perigo">{salvar.error.message}</Aviso>}
      {salvar.isSuccess && <Aviso tom="sucesso">Sofia salva.</Aviso>}

      <div className="ci-duas">
        <Campo rotulo="NOME DE EXIBIÇÃO NO WHATSAPP">
          <Entrada value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
        </Campo>
        <Campo rotulo="TOM DE VOZ">
          <Selecao value={form.tom} onChange={(e) => setForm({ ...form, tom: e.target.value })}>
            {tons.map((t) => (
              <option key={t.chave} value={t.chave}>{t.rotulo}</option>
            ))}
          </Selecao>
        </Campo>
      </div>

      {/* As ferramentas DA SOFIA. Antes elas obedeciam aos interruptores da
          Atena, sem a tela dizer; agora cada agente controla as suas. */}
      <fieldset className="ci-permissoes">
        <legend>FERRAMENTAS &amp; PERMISSÕES DA SOFIA (TOOLS)</legend>
        <div className="ci-permissoes__grade">
          {permissoes.grupos.map((p) => {
            const aviso = form.ferramentas.includes(p.chave) ? semEfeito(p.chave) : null;
            return (
              <label key={p.chave} className="ci-permissao" title={aviso ?? p.descricao}>
                <input type="checkbox" checked={form.ferramentas.includes(p.chave)} onChange={() => alternar(p.chave)} />
                <span>
                  {p.rotulo.toUpperCase()}
                  {aviso && <small className="ci-permissao__aviso">{aviso}</small>}
                </span>
              </label>
            );
          })}
          {permissoes.fixas.map((p) => (
            <label key={p.chave} className="ci-permissao ci-permissao--fixa" title={p.descricao}>
              <input type="checkbox" checked disabled readOnly />
              <span>
                {p.rotulo.toUpperCase()} <small className="ci-permissao__sempre">SEMPRE</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <AvaliacaoGoogle agente={agente} />

      <Campo rotulo={`TEMPERATURA / CRIATIVIDADE: ${Number(form.temperatura).toFixed(1)}`}>
        <input
          type="range"
          className="ci-slider ci-slider--sofia"
          min="0"
          max="1"
          step="0.1"
          value={form.temperatura}
          onChange={(e) => setForm({ ...form, temperatura: Number(e.target.value) })}
        />
      </Campo>

      <Campo
        rotulo="PROMPT DE SISTEMA (PERSONA & DIRETRIZES)"
        dica="O que ela pode fazer é decidido nos interruptores acima; as regras de uso de cada ferramenta (só marcar o que a consulta mostrou, remarcar e cancelar pela Atena…) entram automaticamente."
      >
        <AreaTexto
          value={form.systemPrompt}
          style={{ minHeight: 150 }}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
        />
      </Campo>

      <div className="linha linha--fim">
        <Botao carregando={salvar.isPending} onClick={() => salvar.mutate(form)} className="ci-botao-sofia">
          Salvar Atendente
        </Botao>
      </div>
    </section>
  );
}

function CartaoAtena({ agente, permissoes, cadeia }) {
  const salvar = useSalvarAgente('atena');

  const [form, setForm] = useState({
    nome: agente.nome,
    temperatura: agente.temperatura,
    systemPrompt: agente.systemPrompt,
    ferramentas: agente.ferramentas
  });

  function alternar(chave) {
    setForm((f) => ({
      ...f,
      ferramentas: f.ferramentas.includes(chave) ? f.ferramentas.filter((x) => x !== chave) : [...f.ferramentas, chave]
    }));
  }

  const podeApagar = form.ferramentas.includes('cancelar');

  return (
    <section className="ci-agente ci-agente--atena">
      <header className="ci-agente__topo">
        <span className="ci-agente__avatar" aria-hidden="true">📚</span>
        <div className="crescer">
          <h3>{agente.nome}</h3>
          <span className="ci-selo ci-selo--atena">BACKLINE • CONSULTAS &amp; BANCO DE DADOS</span>
        </div>
        <Interruptor ativo={agente.ativo} aoMudar={(ativo) => salvar.mutate({ ativo })} desabilitado={salvar.isPending} />
      </header>

      <div className="ci-modelo ci-modelo--atena">
        <span aria-hidden="true">🗄️</span>
        <div>
          <div>Modelo de IA: <strong>Automático (Cascata de IA)</strong></div>
          <div className="texto-fraco">
            Agente de IA que consulta e altera o banco (OS e agendamentos) a pedido da Sofia
            {cadeia.length ? ` • ${cadeia[0]}` : ''}
          </div>
        </div>
      </div>

      {salvar.isError && <Aviso tom="perigo">{salvar.error.message}</Aviso>}
      {salvar.isSuccess && <Aviso tom="sucesso">Atena salva.</Aviso>}

      <Campo rotulo="NOME DO AGENTE INTERNO">
        <Entrada value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
      </Campo>

      <fieldset className="ci-permissoes">
        <legend>FERRAMENTAS &amp; PERMISSÕES DA ATENA (TOOLS)</legend>
        <p className="texto-fraco ci-permissoes__nota">
          Valem para o que a Atena faz: quando a Sofia pede (remarcar, cancelar) e nas rotinas dela (quadro, resumo,
          fechar o dia). As ferramentas da Sofia têm interruptores próprios, no cartão dela.
        </p>
        <div className="ci-permissoes__grade">
          {permissoes.map((p) => (
            <label key={p.chave} className="ci-permissao" title={p.descricao}>
              <input type="checkbox" checked={form.ferramentas.includes(p.chave)} onChange={() => alternar(p.chave)} />
              <span>{p.rotulo.toUpperCase()}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {podeApagar && (
        <Aviso tom="alerta">
          Com “Cancelar / excluir” ligado, a Atena pode cancelar e excluir agendamentos <strong>do cliente da
          conversa</strong>. Agendamentos concluídos, em andamento ou com falta nunca são excluídos por ela, e ela não
          consegue alterar preço nem dar desconto. Toda ação fica na auditoria como “Atena (IA)”.
        </Aviso>
      )}

      <Campo rotulo={`TEMPERATURA: ${Number(form.temperatura).toFixed(1)}`} dica="Baixa de propósito: quem mexe em agenda precisa ser previsível.">
        <input
          type="range"
          className="ci-slider ci-slider--atena"
          min="0"
          max="1"
          step="0.1"
          value={form.temperatura}
          onChange={(e) => setForm({ ...form, temperatura: Number(e.target.value) })}
        />
      </Campo>

      <Campo rotulo="INSTRUÇÕES DE RACIOCÍNIO ESTRITO (ZERO ALUCINAÇÃO)">
        <AreaTexto
          value={form.systemPrompt}
          style={{ minHeight: 150 }}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
        />
      </Campo>

      <div className="linha linha--fim">
        <Botao carregando={salvar.isPending} onClick={() => salvar.mutate(form)} className="ci-botao-atena">
          Salvar Atena
        </Botao>
      </div>
    </section>
  );
}
