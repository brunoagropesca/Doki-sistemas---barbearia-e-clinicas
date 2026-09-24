import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/autenticacao.jsx';
import { Aviso, Botao, Campo, Carregando, Entrada, Etiqueta } from '../../componentes/ui.jsx';
import { CampoChave, SEM_AUTOFILL } from './CampoChave.jsx';
import { SeletorModelo } from './SeletorModelo.jsx';

/**
 * Aba "Cascata de IA & Provedores".
 *
 * O Gemini e o provedor principal. Ao iniciar o sistema (e ao salvar uma chave
 * nova) todos os modelos dele sao testados; os melhores para atender no
 * WhatsApp ficam ligados e aparecem em verde no menu do modelo primario. Os
 * que nao passaram ficam no catalogo, desligados, para a pessoa decidir.
 * Se o Gemini inteiro falhar, a cascata passa para Groq, ChatGPT e Ollama.
 */

const NOMES = { gemini: 'Google Gemini', groq: 'Groq', openai: 'ChatGPT', ollama: 'Ollama', anthropic: 'Claude' };
const ORDEM = ['gemini', 'groq', 'openai', 'ollama'];
const CATEGORIAS = { texto: 'Texto', audio: 'Áudio', imagem: 'Imagem', outro: 'Outro' };

const nomeDoModelo = (m) => m.nomeExibicao || m.nome.replace(/^models\//, '');

/** 1049576 -> "1049k" */
const kilo = (n) => (n ? `${Math.round(n / 1000)}k` : '—');

/** Bolinha + resultado do ultimo teste: "🟢 663ms" / "🔴 Falhou" / "⚪ Não testado". */
function statusDoModelo(m) {
  if (m.ok === true) return { emoji: '🟢', texto: `${m.latenciaMs}ms`, rotulo: `Aprovado (${m.latenciaMs}ms)`, tom: 'sucesso' };
  if (m.ok === false) return { emoji: '🔴', texto: 'Falhou', rotulo: 'Falhou', tom: 'perigo' };
  return { emoji: '⚪', texto: 'Não testado', rotulo: 'Não testado', tom: 'neutro' };
}

function haQuanto(ms) {
  if (!ms) return null;
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 1) return 'agora há pouco';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `há ${h} h` : `há ${Math.round(h / 24)} dia(s)`;
}

const FILTROS = [
  ['todos', 'Todos', () => true],
  ['ativos', 'Ativos', (m) => m.ativo !== false],
  ['desativados', 'Desativados', (m) => m.ativo === false],
  ['aprovados', 'Aprovados', (m) => m.ok === true],
  ['reprovados', 'Reprovados', (m) => m.ok === false]
];

export function Cascata() {
  const queryClient = useQueryClient();
  const { podeAcessar } = useAuth();
  const podeVerChave = podeAcessar('owner');

  const [chaves, setChaves] = useState({ gemini: '', groq: '', openai: '', ollama: '' });
  // O que o olho revelou: serve para so salvar quando a pessoa realmente mudou a chave.
  const [originais, setOriginais] = useState({});
  const [avisoChaves, setAvisoChaves] = useState(null);
  const [filtro, setFiltro] = useState('todos');
  const [busca, setBusca] = useState('');

  const dados = useQuery({
    queryKey: ['ia', 'provedores'],
    queryFn: () => api.get('/api/ia/provedores'),
    // Enquanto o teste em lote roda (ao iniciar, ou pelo botao), acompanha de perto.
    refetchInterval: (q) => (q.state.data?.provedores?.some((p) => p.testeModelos?.rodando) ? 2000 : false)
  });

  const recarregar = () => queryClient.invalidateQueries({ queryKey: ['ia'] });

  const salvar = useMutation({
    mutationFn: ({ provedor, dados: corpo }) => api.put(`/api/ia/provedores/${provedor}`, corpo),
    onSuccess: recarregar
  });
  const testar = useMutation({ mutationFn: (p) => api.post(`/api/ia/provedores/${p}/testar-modelos`), onSuccess: recarregar });
  const descobrir = useMutation({ mutationFn: (p) => api.post(`/api/ia/provedores/${p}/modelos`), onSuccess: recarregar });
  const alternarModelo = useMutation({
    mutationFn: ({ provedor, modelo, ativo }) => api.patch(`/api/ia/provedores/${provedor}/modelos`, { modelo, ativo }),
    onSuccess: recarregar
  });
  const lote = useMutation({
    mutationFn: ({ provedor, acao }) => api.post(`/api/ia/provedores/${provedor}/modelos/lote`, { acao }),
    onSuccess: recarregar
  });

  /**
   * Salva so os campos que MUDARAM, um provedor por vez.
   *
   * Vazio = manter como esta. Igual ao que o olho revelou = nada a salvar.
   * Chave nova ja LIGA o provedor: uma chave salva e desligada nao serviria
   * para nada, e a pessoa so descobriria quando o Gemini caisse.
   */
  const salvarChaves = useMutation({
    mutationFn: async () => {
      const salvos = [];
      for (const [i, provedor] of ORDEM.entries()) {
        const valor = chaves[provedor].trim();
        if (!valor || valor === originais[provedor]) continue;

        const corpo = { habilitado: true, prioridade: i + 1 };
        if (provedor === 'ollama') corpo.baseUrl = valor;
        else corpo.apiKey = valor;

        await api.put(`/api/ia/provedores/${provedor}`, corpo);
        salvos.push(NOMES[provedor]);
      }
      if (salvos.length === 0) throw new Error('Nenhuma chave foi alterada.');
      return salvos;
    },
    onSuccess: (salvos) => {
      setChaves({ gemini: '', groq: '', openai: '', ollama: '' });
      setOriginais({});
      setAvisoChaves(
        `Salvo: ${salvos.join(', ')}.${salvos.includes('Google Gemini') ? ' Os modelos do Gemini estão sendo testados.' : ''}`
      );
      recarregar();
    }
  });

  const gemini = dados.data?.provedores?.find((p) => p.provedor === 'gemini');
  const modelos = gemini?.modelos ?? [];

  const contagens = useMemo(
    () => Object.fromEntries(FILTROS.map(([chave, , fn]) => [chave, modelos.filter(fn).length])),
    [modelos]
  );

  const visiveis = useMemo(() => {
    const fn = FILTROS.find(([chave]) => chave === filtro)[2];
    const termo = busca.trim().toLowerCase();
    return modelos.filter(
      (m) => fn(m) && (!termo || `${nomeDoModelo(m)} ${m.nome}`.toLowerCase().includes(termo))
    );
  }, [modelos, filtro, busca]);

  if (dados.isLoading) return <Carregando />;
  if (dados.isError) return <Aviso tom="perigo">{dados.error.message}</Aviso>;

  const { provedores, disponiveis } = dados.data;
  const porNome = Object.fromEntries(provedores.map((p) => [p.provedor, p]));

  const ativos = contagens.ativos;
  const teste = gemini?.testeModelos;
  const testando = Boolean(teste?.rodando);
  const ultimoTeste = haQuanto(gemini?.testadoEm);

  const erro = salvar.error ?? testar.error ?? descobrir.error ?? alternarModelo.error ?? lote.error ?? salvarChaves.error;

  const definirPrimario = (nome) => salvar.mutate({ provedor: 'gemini', dados: { modeloPadrao: nome } });

  // O que o menu do modelo primario mostra por linha: a MESMA informacao e a MESMA
  // ordem do <select> antigo (nome, bolinha + resultado do teste, [DESATIVADO], estrela
  // no primario). A ordem e a que o servidor manda; nada e reordenado aqui.
  const opcoesPrimario = modelos.map((m) => {
    const st = statusDoModelo(m);
    return {
      valor: m.nome,
      nome: nomeDoModelo(m),
      tom: st.tom,
      detalhe: st.texto,
      etiqueta: m.ativo === false ? 'DESATIVADO' : null,
      destaque: m.nome === gemini?.modeloPadrao
    };
  });

  return (
    <div className="coluna">
      {erro && <Aviso tom="perigo">{erro.message}</Aviso>}

      {/* `--elevado`: o menu do modelo primario abre por cima do bloco de baixo (veja CentralIa.css). */}
      <section className="ci-bloco ci-bloco--elevado">
        <header className="ci-bloco__topo">
          <div className="linha" style={{ alignItems: 'flex-start' }}>
            <span className="ci-icone-grande" aria-hidden="true">🌐</span>
            <div>
              <h2 className="ci-titulo-secao">Motor de IA em Cascata &amp; Modelos Google Gemini</h2>
              <span className="ci-selo ci-selo--primario">PROVEDOR PRINCIPAL COM FALLBACK AUTOMÁTICO</span>
            </div>
          </div>
          <Botao
            variante="secundario"
            tamanho="sm"
            disabled={!gemini?.temChave || testando}
            carregando={testar.isPending}
            onClick={() => testar.mutate('gemini')}
            title={!gemini?.temChave ? 'Cadastre a chave do Gemini primeiro' : undefined}
          >
            {testando ? `Testando ${teste.feitos}/${teste.total}...` : '🧪 Testar Modelos (Timeout 1min)'}
          </Botao>
        </header>

        <p className="texto-suave">
          O sistema opera com o <strong>Google Gemini</strong> como provedor principal. Sempre que o sistema inicia, ele
          busca na API da Google todos os modelos disponíveis e executa um teste de validação (com{' '}
          <strong>timeout de 1 minuto por modelo</strong>). Os melhores para atendimento no WhatsApp (texto, rápidos e
          estáveis) ficam ligados automaticamente.
          {ultimoTeste && <span className="texto-fraco"> Último teste: {ultimoTeste}.</span>}
        </p>

        {testando && (
          <div className="ci-progresso" role="progressbar" aria-valuenow={teste.feitos} aria-valuemax={teste.total}>
            <div className="ci-progresso__barra" style={{ width: `${(teste.feitos / Math.max(teste.total, 1)) * 100}%` }} />
          </div>
        )}

        <div className="ci-caixa" style={{ marginTop: 'var(--e4)' }}>
          <div className="linha linha--entre">
            <div className="ci-caixa__titulo">⭐ Modelo Primário do Google Gemini (Menu Dropdown Dinâmico)</div>
            {gemini && (
              <label className="ci-interruptor">
                <input
                  type="checkbox"
                  checked={gemini.habilitado}
                  onChange={(e) => salvar.mutate({ provedor: 'gemini', dados: { habilitado: e.target.checked } })}
                />
                <span className="ci-interruptor__trilho" aria-hidden="true" />
                <span className="ci-interruptor__texto">{gemini.habilitado ? 'ATIVO' : 'DESLIGADO'}</span>
              </label>
            )}
          </div>

          {modelos.length === 0 ? (
            <p className="texto-fraco" style={{ marginTop: 'var(--e2)' }}>
              {gemini?.temChave
                ? testando
                  ? 'Buscando e testando os modelos da sua chave...'
                  : 'Nenhum modelo no catálogo ainda. Clique em “Testar Modelos” para buscar e testar.'
                : 'Cadastre a chave de API do Gemini na seção de chaves, mais abaixo.'}
            </p>
          ) : (
            <SeletorModelo
              rotulo="Modelo primário do Gemini"
              valor={gemini.modeloPadrao ?? ''}
              opcoes={opcoesPrimario}
              aoEscolher={definirPrimario}
              textoVazio="Escolha o modelo primário"
              style={{ marginTop: 'var(--e2)' }}
            />
          )}

          <p className="texto-fraco" style={{ marginTop: 'var(--e2)' }}>
            💡 <strong>Funcionamento da cascata:</strong> o modelo selecionado acima é a primeira escolha do sistema para
            a Sofia e para a Atena. Se ele falhar (instabilidade, erro 503 ou limite de cota 429), o sistema{' '}
            <strong>transborda automaticamente para a próxima versão Gemini ativa</strong> (até 4 por provedor). Se o
            Gemini inteiro não responder, segue para o Groq, depois ChatGPT e Ollama.
            {gemini && !gemini.modeloManual && modelos.some((m) => m.ok !== undefined) && (
              <> O primário foi escolhido automaticamente; escolha outro acima para fixá-lo.</>
            )}
          </p>
        </div>
      </section>

      <details className="ci-bloco ci-catalogo" open>
        <summary className="ci-catalogo__resumo">
          <span aria-hidden="true">📦</span>
          <div className="crescer">
            <strong>Catálogo de Modelos Google Gemini</strong>
            <div className="texto-fraco">Gerencie a disponibilidade de cada versão para a cascata de atendimento</div>
          </div>
          <span className="ci-pilula">{modelos.length} modelos</span>
          <span className="ci-pilula ci-pilula--sucesso">{ativos} ativos</span>
        </summary>

        <div className="ci-catalogo__barra">
          <input
            {...SEM_AUTOFILL}
            name="busca-modelo"
            className="entrada ci-catalogo__busca"
            type="search"
            placeholder="🔍 Buscar modelo (ex: 2.5, flash, pro)..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            aria-label="Buscar modelo"
          />

          <div className="ci-filtros" role="group" aria-label="Filtrar modelos">
            {FILTROS.map(([chave, rotulo]) => (
              <button
                key={chave}
                type="button"
                className={`ci-filtro ${filtro === chave ? 'ci-filtro--ativo' : ''}`}
                aria-pressed={filtro === chave}
                onClick={() => setFiltro(chave)}
              >
                {rotulo} ({contagens[chave]})
              </button>
            ))}
          </div>

          <div className="linha" style={{ gap: 6 }}>
            <Botao
              tamanho="sm"
              variante="secundario"
              disabled={contagens.aprovados === 0}
              carregando={lote.isPending && lote.variables?.acao === 'ativar_aprovados'}
              onClick={() => lote.mutate({ provedor: 'gemini', acao: 'ativar_aprovados' })}
            >
              ✅ Ativar Aprovados
            </Botao>
            <Botao
              tamanho="sm"
              variante="secundario"
              disabled={contagens.reprovados === 0}
              carregando={lote.isPending && lote.variables?.acao === 'desativar_reprovados'}
              onClick={() => lote.mutate({ provedor: 'gemini', acao: 'desativar_reprovados' })}
            >
              ⏹ Desativar Reprovados
            </Botao>
            <Botao
              tamanho="sm"
              variante="fantasma"
              disabled={!gemini?.temChave}
              carregando={descobrir.isPending}
              onClick={() => descobrir.mutate('gemini')}
              title="Consulta a API do Google e atualiza a lista"
            >
              🔄 Buscar modelos
            </Botao>
          </div>
        </div>

        {descobrir.data?.aviso && <Aviso tom="alerta">{descobrir.data.aviso}</Aviso>}

        <div className="ci-modelos-lista" role="list">
          {visiveis.map((m) => {
            const st = statusDoModelo(m);
            const ehPrimario = m.nome === gemini.modeloPadrao;
            const ligado = m.ativo !== false;

            return (
              <div
                key={m.nome}
                role="listitem"
                className={`ci-item-modelo ${ehPrimario ? 'ci-item-modelo--primario' : ''} ${ligado ? '' : 'ci-item-modelo--desligado'}`}
              >
                <div className="crescer">
                  <div className="linha" style={{ gap: 6 }}>
                    <strong>{nomeDoModelo(m)}</strong>
                    {ehPrimario && <Etiqueta tom="primario">⭐ primário</Etiqueta>}
                    {m.recomendado && <Etiqueta tom="sucesso">recomendado</Etiqueta>}
                    {m.categoria && m.categoria !== 'texto' && <Etiqueta tom="alerta">{CATEGORIAS[m.categoria]}</Etiqueta>}
                  </div>
                  <div className="mono texto-fraco">
                    {m.nome} • {kilo(m.limiteEntrada)} in / {kilo(m.limiteSaida)} out
                  </div>
                </div>

                <span title={m.erro ?? undefined}>
                  <Etiqueta tom={st.tom}>{st.emoji} {st.rotulo}</Etiqueta>
                </span>

                <label className="ci-interruptor">
                  <input
                    type="checkbox"
                    checked={ligado}
                    onChange={(e) => alternarModelo.mutate({ provedor: 'gemini', modelo: m.nome, ativo: e.target.checked })}
                  />
                  <span className="ci-interruptor__trilho" aria-hidden="true" />
                  <span className="ci-interruptor__texto">{ligado ? 'ATIVO' : 'DESATIVADO'}</span>
                </label>

                <Botao tamanho="sm" variante="secundario" disabled={ehPrimario} onClick={() => definirPrimario(m.nome)}>
                  Definir Primário
                </Botao>
              </div>
            );
          })}

          {visiveis.length === 0 && (
            <p className="texto-fraco" style={{ padding: 'var(--e5)', textAlign: 'center' }}>
              {modelos.length === 0
                ? 'Catálogo vazio. O sistema testa os modelos sozinho ao iniciar; ou clique em “Testar Modelos”.'
                : 'Nenhum modelo neste filtro.'}
            </p>
          )}
        </div>
      </details>

      <section className="ci-bloco">
        <h3 className="ci-rotulo-secao">CADEIA DE FALLBACK (CASO TODOS OS MODELOS GEMINI FALHEM)</h3>
        <div className="ci-cadeia">
          {ORDEM.map((chave, i) => {
            const p = porNome[chave];
            const pronto = p?.habilitado && (p.temChave || !p.precisaChave);
            const modelo = p?.modeloPadrao ? p.modeloPadrao.replace(/^models\//, '') : chave === 'ollama' ? 'Local' : '—';
            return (
              <div key={chave} className="linha" style={{ gap: 6, flexWrap: 'nowrap' }}>
                {i > 0 && <span className="ci-seta" aria-hidden="true">➔</span>}
                <div className={`ci-elo ${pronto ? 'ci-elo--pronto' : ''}`}>
                  <span className="ci-elo__num">{i + 1}</span>
                  <div>
                    <div className="ci-elo__nome">{NOMES[chave]}</div>
                    <div className="ci-elo__sub">{pronto ? modelo : chave === 'ollama' ? 'Local Offline' : 'Sem chave'}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <details className="ci-bloco" open>
        <summary className="ci-rotulo-secao" style={{ cursor: 'pointer' }}>
          🔑 Configurar Chaves de API (Gemini, Groq, OpenAI, Ollama)
        </summary>

        <Aviso tom="info">
          As chaves ficam <strong>cifradas</strong> no servidor. Use o <strong>olho</strong> para ver a chave salva
          {podeVerChave ? '' : ' (só o dono da empresa pode)'}; cada visualização fica registrada na auditoria. Deixe o
          campo em branco para manter a chave atual. Ao salvar uma chave nova, o provedor é ligado automaticamente.
        </Aviso>
        {avisoChaves && <Aviso tom="sucesso" aoFechar={() => setAvisoChaves(null)}>{avisoChaves}</Aviso>}

        {[
          ['gemini', 'GOOGLE GEMINI API KEY', 'AIza...'],
          ['groq', 'GROQ API KEY (BACKUP 1)', 'gsk_...'],
          ['openai', 'OPENAI API KEY (BACKUP 2)', 'sk-proj-...']
        ].map(([chave, rotulo, exemplo]) => (
          <CampoChave
            key={chave}
            provedor={chave}
            rotulo={rotulo}
            exemplo={exemplo}
            temChave={Boolean(porNome[chave]?.temChave)}
            sufixo={porNome[chave]?.chaveSufixo?.replace(/^•+/, '')}
            podeVer={podeVerChave}
            valor={chaves[chave]}
            aoMudar={(v) => setChaves((c) => ({ ...c, [chave]: v }))}
            aoRevelar={(v) => {
              setChaves((c) => ({ ...c, [chave]: v }));
              setOriginais((o) => ({ ...o, [chave]: v }));
            }}
          />
        ))}

        <Campo
          rotulo="URL DO OLLAMA LOCAL (BACKUP 3 OFFLINE)"
          dica={porNome.ollama?.baseUrl ? `Configurada: ${porNome.ollama.baseUrl}` : 'Padrão: http://localhost:11434'}
        >
          {/* Fica logo depois dos campos de chave: sem estes atributos o navegador poderia tratar como "usuario". */}
          <Entrada
            {...SEM_AUTOFILL}
            name="url-ollama"
            placeholder="http://localhost:11434"
            value={chaves.ollama}
            onChange={(e) => setChaves((c) => ({ ...c, ollama: e.target.value }))}
          />
        </Campo>

        <div className="linha linha--fim">
          <Botao carregando={salvarChaves.isPending} onClick={() => salvarChaves.mutate()}>
            Salvar Chaves
          </Botao>
        </div>

        {disponiveis.length > 0 && (
          <p className="texto-fraco">
            Outros provedores suportados: {disponiveis.map((d) => NOMES[d.provedor] ?? d.provedor).join(', ')}.
          </p>
        )}
      </details>
    </div>
  );
}
