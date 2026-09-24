import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { LIMITES, motivoParaRecusarLigacao, organizarFluxo, validarFluxo } from '@regras-do-fluxo';
import { api } from '../../../lib/api.js';
import { Aviso, Botao, Carregando } from '../../../componentes/ui.jsx';
import { Icone } from '../../../componentes/Icone.jsx';
import { ArestaRemovivel } from './ArestaRemovivel.jsx';
import { ContextoEditor, TIPOS_DE_NO_REACT_FLOW } from './Nos.jsx';
import { PainelFluxo } from './PainelFluxo.jsx';
import { PainelNo } from './PainelNo.jsx';
import { SeletorDeNo } from './SeletorDeNo.jsx';
import { aresta, dadosIniciais, indiceDoHandle, novoId, paraFluxo, paraReactFlow, VISUAL } from './conversao.js';
import './EditorFluxo.css';

/**
 * Construtor visual do menu de atendimento, no molde do n8n.
 *
 * O desenho vive no estado do React Flow (nos + arestas). O formato salvo
 * (`{ nodes, connections }`, o do n8n) e derivado dele a cada mudanca, e a
 * MESMA validacao do servidor roda em cima: os problemas aparecem no proprio
 * no enquanto a pessoa desenha, e o botao Salvar so libera sem erros.
 */

const TIPOS_DE_ARESTA = { removivel: ArestaRemovivel };

export function EditorFluxo() {
  const cfg = useQuery({ queryKey: ['atendimento'], queryFn: () => api.get('/api/atendimento/configuracao') });

  if (cfg.isLoading) return <Carregando />;
  if (cfg.isError) return <Aviso tom="perigo">{cfg.error.message}</Aviso>;

  return (
    <ReactFlowProvider>
      <Editor inicial={cfg.data.menu} />
    </ReactFlowProvider>
  );
}

function Editor({ inicial }) {
  const queryClient = useQueryClient();
  const { screenToFlowPosition, setCenter, fitView, getViewport } = useReactFlow();
  const canvasRef = useRef(null);

  const primeiro = useMemo(() => paraReactFlow(inicial.fluxo), [inicial]);
  const [nodes, setNodes, aoMudarNos] = useNodesState(primeiro.nodes);
  const [edges, setEdges, aoMudarArestas] = useEdgesState(primeiro.edges);
  const [inicio, setInicio] = useState(inicial.fluxo.inicio);
  const [config, setConfig] = useState(inicial.fluxo.config ?? {});
  const [modificado, setModificado] = useState(false);
  const [editando, setEditando] = useState(null);
  const [seletor, setSeletor] = useState(null); // { x, y, ancora?, fluxo: {x,y}, origem?: {no, handle} }
  const botaoAdicionar = useRef(null);
  const [aviso, setAviso] = useState(null);

  const mexeu = () => setModificado(true);

  // --- Formato salvo e validacao, derivados do desenho ---------------------
  const fluxo = useMemo(() => paraFluxo(nodes, edges, inicio, config), [nodes, edges, inicio, config]);
  const validacao = useMemo(() => validarFluxo(fluxo), [fluxo]);

  const problemasPorNo = useMemo(() => {
    const mapa = new Map();
    const pegar = (id) => {
      if (!mapa.has(id)) mapa.set(id, { erros: [], avisos: [] });
      return mapa.get(id);
    };
    validacao.erros.forEach((p) => p.noId && pegar(p.noId).erros.push(p));
    validacao.avisos.forEach((p) => p.noId && pegar(p.noId).avisos.push(p));
    return mapa;
  }, [validacao]);

  const handlesLigados = useMemo(() => new Set(edges.map((e) => `${e.source}|${e.sourceHandle}`)), [edges]);

  // Aviso curto no rodape do canvas (ligacao recusada, exclusao bloqueada...).
  useEffect(() => {
    if (!aviso) return undefined;
    const t = setTimeout(() => setAviso(null), 4000);
    return () => clearTimeout(t);
  }, [aviso]);

  // Sair com alteracoes nao salvas: o navegador pergunta antes de fechar a aba.
  useEffect(() => {
    if (!modificado) return undefined;
    const antes = (e) => e.preventDefault();
    window.addEventListener('beforeunload', antes);
    return () => window.removeEventListener('beforeunload', antes);
  }, [modificado]);

  // --- Mudancas vindas do canvas -------------------------------------------
  const onNodesChange = useCallback(
    (mudancas) => {
      // Selecionar e medir nao sao alteracoes do menu; arrastar e apagar sao.
      if (mudancas.some((m) => m.type === 'remove' || (m.type === 'position' && m.dragging === false))) mexeu();
      aoMudarNos(mudancas);
    },
    [aoMudarNos]
  );

  const onEdgesChange = useCallback(
    (mudancas) => {
      if (mudancas.some((m) => m.type === 'remove')) mexeu();
      aoMudarArestas(mudancas);
    },
    [aoMudarArestas]
  );

  /** Por que ligar `origem:handle → destino` nao pode? (null = pode) */
  const motivoDaRecusa = useCallback(
    (origemId, handle, destinoId) => {
      const origem = nodes.find((n) => n.id === origemId);
      if (!origem) return 'Passo não encontrado.';
      // A saida ja ligada sera trocada: a conta de profundidade e feita sem ela.
      const semEssa = edges.filter((e) => !(e.source === origemId && e.sourceHandle === handle));
      return motivoParaRecusarLigacao(paraFluxo(nodes, semEssa, inicio, config), origemId, indiceDoHandle(origem, handle), destinoId);
    },
    [nodes, edges, inicio, config]
  );

  const isValidConnection = useCallback(
    (c) => !motivoDaRecusa(c.source, c.sourceHandle, c.target),
    [motivoDaRecusa]
  );

  /** Liga (ou desliga, com destino nulo) uma saida. Uma saida leva a UM passo: a ligacao antiga sai. */
  const ligar = useCallback(
    (origemId, handle, destinoId) => {
      if (destinoId) {
        const motivo = motivoDaRecusa(origemId, handle, destinoId);
        if (motivo) return motivo;
      }
      setEdges((eds) => [
        ...eds.filter((e) => !(e.source === origemId && e.sourceHandle === handle)),
        ...(destinoId ? [aresta(origemId, handle, destinoId)] : [])
      ]);
      mexeu();
      return null;
    },
    [motivoDaRecusa, setEdges]
  );

  const onConnect = useCallback((c) => ligar(c.source, c.sourceHandle, c.target), [ligar]);

  /**
   * Fim do arraste de uma linha que NAO caiu numa entrada valida:
   *   - soltou em cima de um passo (no corpo, nao na bolinha) → liga a ele,
   *     como no n8n; se a regra nao deixar, avisa o porque;
   *   - soltou no vazio → abre a lista de passos, e o novo ja nasce ligado.
   */
  const onConnectEnd = useCallback(
    (evento, estado) => {
      if (estado.isValid || !estado.fromNode || !estado.fromHandle) return;
      const { clientX, clientY } = 'changedTouches' in evento ? evento.changedTouches[0] : evento;
      const alvo =
        estado.toNode?.id ?? document.elementFromPoint(clientX, clientY)?.closest('.react-flow__node')?.getAttribute('data-id');

      if (alvo) {
        const motivo = ligar(estado.fromNode.id, estado.fromHandle.id, alvo);
        if (motivo) setAviso(`Não dá para ligar: ${motivo}`);
        return;
      }
      abrirSeletor(clientX, clientY, { no: estado.fromNode.id, handle: estado.fromHandle.id });
    },
    [ligar]
  );

  // Enquadra o desenho quando os passos ja tem tamanho medido (o `fitView`
  // do primeiro quadro ainda nao sabe a altura dos cartoes).
  const nosMedidos = useNodesInitialized();
  const enquadrado = useRef(false);
  useEffect(() => {
    if (!nosMedidos || enquadrado.current) return;
    enquadrado.current = true;
    fitView({ padding: 0.15, maxZoom: 1 });
  }, [nosMedidos, fitView]);

  // O inicio nao sai por Delete/Backspace: o fluxo ficaria sem porta de entrada.
  const onBeforeDelete = useCallback(
    async ({ nodes: apagar, edges: arestas }) => {
      if (apagar.some((n) => n.id === inicio)) {
        setAviso('O menu de início não pode ser excluído. Defina outro menu como início antes.');
        return { nodes: apagar.filter((n) => n.id !== inicio), edges: arestas };
      }
      return true;
    },
    [inicio]
  );

  // --- Criar e mexer em passos ---------------------------------------------

  /**
   * Abre a lista de tipos no ponto (da TELA) em que a pessoa soltou a linha.
   * Quem cuida de caber na janela e a propria lista (ela se mede); aqui so
   * guardamos o ponto do canvas em que o passo novo vai nascer.
   */
  function abrirSeletor(clientX, clientY, origem = null) {
    setSeletor({ x: clientX, y: clientY, fluxo: screenToFlowPosition({ x: clientX, y: clientY }), origem });
  }

  /**
   * "+ Adicionar passo": a lista abre como menu do botao (alterna), e o passo
   * novo nasce no CENTRO da parte do canvas que esta a vista — um pouco
   * deslocado a cada criacao, para dois passos novos nao nascerem empilhados.
   */
  function alternarAdicionar() {
    if (seletor && !seletor.origem) return setSeletor(null);
    const c = canvasRef.current.getBoundingClientRect();
    const centro = screenToFlowPosition({ x: c.left + c.width / 2, y: c.top + c.height / 2 });
    const passo = (nodes.length % 5) * 28;
    setSeletor({
      ancora: botaoAdicionar.current.getBoundingClientRect(),
      fluxo: { x: centro.x - 140 + passo, y: centro.y - 70 + passo },
      origem: null
    });
  }

  const fecharSeletor = useCallback(() => setSeletor(null), []);

  function criar(tipo) {
    if (nodes.length >= LIMITES.nos) {
      setAviso(`O fluxo chegou ao limite de ${LIMITES.nos} passos.`);
      setSeletor(null);
      return;
    }
    const id = novoId(tipo);
    const novo = { id, type: tipo, position: seletor.fluxo, data: dadosIniciais(tipo) };
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { ...novo, selected: true }]);

    if (seletor.origem) {
      const { no, handle } = seletor.origem;
      // O no novo ainda nao esta no estado: a checagem de profundidade usa
      // o fluxo COM ele, montado aqui mesmo.
      const origem = nodes.find((n) => n.id === no);
      const com = [...nodes, novo];
      const semEssa = edges.filter((e) => !(e.source === no && e.sourceHandle === handle));
      const motivo = motivoParaRecusarLigacao(paraFluxo(com, semEssa, inicio, config), no, indiceDoHandle(origem, handle), id);
      if (motivo) setAviso(`Passo criado, mas não ligado: ${motivo}`);
      else setEdges([...semEssa, aresta(no, handle, id)]);
    }
    setSeletor(null);
    setEditando(id);
    mexeu();
  }

  const atualizar = useCallback(
    (id, patch) => {
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
      mexeu();
    },
    [setNodes]
  );

  const acoes = useMemo(() => {
    const opcoesDe = (id) => nodes.find((n) => n.id === id)?.data.options ?? [];
    return {
      atualizar,
      ligar,
      adicionarOpcao(id) {
        const atuais = opcoesDe(id);
        if (atuais.length >= LIMITES.opcoes) return;
        atualizar(id, { options: [...atuais, { id: novoId('opt'), label: `Opção ${atuais.length + 1}` }] });
      },
      removerOpcao(id, opcaoId) {
        atualizar(id, { options: opcoesDe(id).filter((o) => o.id !== opcaoId) });
        setEdges((eds) => eds.filter((e) => !(e.source === id && e.sourceHandle === opcaoId)));
      },
      moverOpcao(id, opcaoId, direcao) {
        const lista = [...opcoesDe(id)];
        const i = lista.findIndex((o) => o.id === opcaoId);
        const j = i + direcao;
        if (i < 0 || j < 0 || j >= lista.length) return;
        [lista[i], lista[j]] = [lista[j], lista[i]];
        atualizar(id, { options: lista });
      }
    };
  }, [nodes, atualizar, ligar, setEdges]);

  // Acoes do menu "⋯" de cada no (via contexto, para os dados do no ficarem limpos).
  const contexto = useMemo(
    () => ({
      inicio,
      problemasPorNo,
      handlesLigados,
      editar: (id) => setEditando(id),
      adicionarOpcao: acoes.adicionarOpcao,
      duplicar(id) {
        const original = nodes.find((n) => n.id === id);
        if (!original || nodes.length >= LIMITES.nos) return;
        const copia = {
          id: novoId(original.type),
          type: original.type,
          position: { x: original.position.x + 40, y: original.position.y + 60 },
          data: {
            ...structuredClone(original.data),
            title: `${original.data.title} (cópia)`.slice(0, LIMITES.titulo),
            ...(original.data.options ? { options: original.data.options.map((o) => ({ ...o, id: novoId('opt') })) } : {})
          },
          selected: true
        };
        setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), copia]);
        mexeu();
      },
      alternarDesativado(id) {
        if (id === inicio) {
          setAviso('O menu de início não pode ser desativado.');
          return;
        }
        const no = nodes.find((n) => n.id === id);
        atualizar(id, { disabled: no?.data.disabled ? undefined : true });
      },
      definirInicio(id) {
        setInicio(id);
        atualizar(id, { disabled: undefined });
      },
      excluir(id) {
        if (id === inicio) {
          setAviso('O menu de início não pode ser excluído. Defina outro menu como início antes.');
          return;
        }
        setNodes((ns) => ns.filter((n) => n.id !== id));
        setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
        if (editando === id) setEditando(null);
        mexeu();
      }
    }),
    [inicio, problemasPorNo, handlesLigados, acoes, nodes, atualizar, setNodes, setEdges, editando]
  );

  function organizar() {
    const organizado = organizarFluxo(fluxo);
    const pos = new Map(organizado.nodes.map((n) => [n.id, n.position]));
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
    mexeu();
    requestAnimationFrame(() => fitView({ padding: 0.2, duration: 400 }));
  }

  function irPara(id) {
    const no = nodes.find((n) => n.id === id);
    if (!no) return;
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    setEditando(id);
    setCenter(no.position.x + 140, no.position.y + 80, { zoom: Math.max(getViewport().zoom, 0.9), duration: 400 });
  }

  // --- Salvar ----------------------------------------------------------------
  const salvar = useMutation({
    mutationFn: () => api.put('/api/atendimento/menu', { fluxo }),
    onSuccess: (dados) => {
      queryClient.setQueryData(['atendimento'], dados);
      setModificado(false);
    }
  });

  const noEditado = nodes.find((n) => n.id === editando);
  const erros = validacao.erros.length;
  const avisos = validacao.avisos.length;

  return (
    <ContextoEditor.Provider value={contexto}>
      <div className="fluxo">
        <header className="fluxo__topo">
          <div className="fluxo__titulo">
            <h1>Menu do WhatsApp</h1>
            <div className="fluxo__estado">
              <span className={`fluxo__selo ${modificado ? 'fluxo__selo--pendente' : 'fluxo__selo--salvo'}`}>
                {modificado ? '● Alterações não salvas' : '✓ Salvo'}
              </span>
              {erros > 0 ? (
                <span className="fluxo__selo fluxo__selo--erro">{erros} {erros === 1 ? 'erro' : 'erros'}</span>
              ) : avisos > 0 ? (
                <span className="fluxo__selo fluxo__selo--aviso">{avisos} {avisos === 1 ? 'aviso' : 'avisos'}</span>
              ) : null}
              <span className="fluxo__contagem">
                {nodes.length} de {LIMITES.nos} passos
              </span>
            </div>
          </div>

          <div className="fluxo__acoes">
            <Botao
              ref={botaoAdicionar}
              variante="secundario"
              tamanho="sm"
              data-abre-seletor
              aria-haspopup="menu"
              aria-expanded={Boolean(seletor && !seletor.origem)}
              onClick={alternarAdicionar}
            >
              <Icone nome="adicionar" className="fluxo__icone" />
              Adicionar passo
              <span className="fluxo__seta" aria-hidden="true">▾</span>
            </Botao>
            <Botao variante="fantasma" tamanho="sm" onClick={organizar} title="Arruma os passos como uma árvore, do início para a direita">
              <Icone nome="organizar" className="fluxo__icone" />
              Organizar
            </Botao>
            <Link to="/ia?aba=simulador" className="botao botao--fantasma botao--sm" title="Testar com a IA e o menu juntos">
              <Icone nome="testar" className="fluxo__icone" />
              Simulador
            </Link>
            <span className="fluxo__divisor" aria-hidden="true" />
            <Botao
              tamanho="sm"
              onClick={() => salvar.mutate()}
              carregando={salvar.isPending}
              disabled={!modificado || erros > 0 || salvar.isPending}
              title={erros > 0 ? 'Corrija os erros antes de salvar (aba Problemas)' : undefined}
            >
              Salvar menu
            </Botao>
          </div>
        </header>

        {inicial.padrao && !modificado && (
          <Aviso tom="info">
            Este é o seu menu atual convertido para o editor novo. Ele só passa a valer quando você clicar em <strong>Salvar menu</strong>.
          </Aviso>
        )}
        {salvar.isError && (
          <Aviso tom="perigo" aoFechar={() => salvar.reset()}>
            {salvar.error.message}
          </Aviso>
        )}

        <div className="fluxo__corpo">
          <div className="fluxo__canvas" ref={canvasRef}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={TIPOS_DE_NO_REACT_FLOW}
              edgeTypes={TIPOS_DE_ARESTA}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              isValidConnection={isValidConnection}
              onBeforeDelete={onBeforeDelete}
              onPaneClick={() => setEditando(null)}
              colorMode="dark"
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
              minZoom={0.2}
              maxZoom={1.75}
              deleteKeyCode={['Delete', 'Backspace']}
              connectionRadius={28}
              defaultEdgeOptions={{ type: 'removivel' }}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="rgba(240,244,255,0.16)" />
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap
                position="bottom-right"
                pannable
                zoomable
                style={{ width: 170, height: 110 }}
                nodeColor={(n) => VISUAL[n.type]?.cor ?? '#888'}
                nodeStrokeWidth={0}
                maskColor="rgba(5,8,20,0.65)"
              />
            </ReactFlow>

            {/* O jeito de usar, dentro do proprio canvas (e nao numa linha a mais no topo). */}
            <div className="fluxo__dica" aria-hidden="true">
              Arraste a bolinha de uma opção até um passo para ligar · solte no vazio para criar · duplo clique edita
            </div>

            {seletor && (
              <SeletorDeNo
                x={seletor.x}
                y={seletor.y}
                ancora={seletor.ancora}
                titulo={seletor.origem ? 'Ligar a um passo novo' : 'Adicionar passo'}
                aoEscolher={criar}
                aoFechar={fecharSeletor}
              />
            )}
            {aviso && (
              <div className="fluxo__toast" role="status">
                {aviso}
              </div>
            )}
          </div>

          <aside className="fluxo__painel">
            {noEditado ? (
              <PainelNo
                key={noEditado.id}
                no={noEditado}
                fluxo={fluxo}
                nodes={nodes}
                edges={edges}
                ehInicio={noEditado.id === inicio}
                acoes={acoes}
                problemas={problemasPorNo.get(noEditado.id)}
                aoFechar={() => setEditando(null)}
              />
            ) : (
              <PainelFluxo
                fluxo={fluxo}
                validacao={validacao}
                config={config}
                aoMudarConfig={(c) => {
                  setConfig(c);
                  mexeu();
                }}
                aoIrPara={irPara}
              />
            )}
          </aside>
        </div>
      </div>
    </ContextoEditor.Provider>
  );
}
