import { TIPOS_NO } from '@regras-do-fluxo';

/**
 * Tradutor entre o formato SALVO (o do n8n: nos + `connections` por posicao
 * da saida) e o formato que o React Flow desenha (nos + arestas).
 *
 * Diferenca que importa: no React Flow a aresta sai de um "handle" e, num
 * menu, o handle de cada opcao usa o ID DA OPCAO — nao a posicao. Assim,
 * reordenar ou apagar uma opcao no editor nao desliga as outras. A posicao
 * (o `index` do n8n) so e calculada na hora de salvar.
 */

/** Handle de saida dos passos que tem uma saida so (Mensagem, Serviços). */
export const SAIDA_UNICA = 'saida';
export const ENTRADA = 'entrada';

/** Visual de cada tipo de passo: icone e cor do cabecalho. */
export const VISUAL = {
  menu: { icone: '☰', cor: '#1856FF' },
  mensagem: { icone: '💬', cor: '#14b8a6' },
  servicos: { icone: '🏷️', cor: '#f59e0b' },
  atendente: { icone: '🙋', cor: '#f43f5e' },
  sofia: { icone: '✨', cor: '#8b5cf6' }
};

export function novoId(prefixo) {
  return `${prefixo}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function aresta(source, sourceHandle, target) {
  return { id: `${source}.${sourceHandle}->${target}`, source, sourceHandle, target, targetHandle: ENTRADA, type: 'removivel' };
}

/** Os handles de saida de um no, na ordem das saidas do n8n. */
export function handlesDeSaida(no) {
  if (no.type === 'menu') return (no.data.options ?? []).map((o) => o.id);
  return TIPOS_NO[no.type]?.saidas === 1 ? [SAIDA_UNICA] : [];
}

/** Posicao (indice n8n) de um handle dentro do no. */
export function indiceDoHandle(no, handle) {
  return handlesDeSaida(no).indexOf(handle);
}

/** @param {import('@regras-do-fluxo').Fluxo} fluxo */
export function paraReactFlow(fluxo) {
  const nodes = fluxo.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position ?? { x: 0, y: 0 },
    data: structuredClone(n.data)
  }));

  const edges = [];
  for (const [origemId, conexao] of Object.entries(fluxo.connections ?? {})) {
    const origem = nodes.find((n) => n.id === origemId);
    if (!origem) continue;
    const handles = handlesDeSaida(origem);
    (conexao.main ?? []).forEach((lista, i) => {
      const destino = lista?.[0]?.node;
      if (destino && handles[i]) edges.push(aresta(origemId, handles[i], destino));
    });
  }
  return { nodes, edges };
}

/**
 * O que vai para o servidor. So os campos do contrato: nada de estado de
 * tela (selecao, tamanho medido) vaza para o JSON salvo.
 * @returns {import('@regras-do-fluxo').Fluxo}
 */
export function paraFluxo(nodes, edges, inicio, config) {
  const connections = {};
  for (const no of nodes) {
    const main = handlesDeSaida(no).map((handle) => {
      const e = edges.find((x) => x.source === no.id && x.sourceHandle === handle);
      return e ? [{ node: e.target, type: 'main', index: 0 }] : [];
    });
    if (main.some((l) => l.length)) connections[no.id] = { main };
  }

  return {
    versao: 2,
    inicio,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: {
        title: n.data.title ?? '',
        message: n.data.message ?? '',
        ...(n.type === 'menu' ? { options: (n.data.options ?? []).map((o) => ({ id: o.id, label: o.label })) } : {}),
        ...(n.data.disabled ? { disabled: true } : {})
      }
    })),
    connections,
    config
  };
}

/** Dados de um passo recem-criado. */
export function dadosIniciais(tipo) {
  switch (tipo) {
    case 'menu':
      return { title: 'Novo menu', message: 'Escolha uma opção:', options: [{ id: novoId('opt'), label: 'Opção 1' }] };
    case 'mensagem':
      return { title: 'Mensagem', message: '' };
    default:
      return { title: TIPOS_NO[tipo].rotulo, message: '' };
  }
}
