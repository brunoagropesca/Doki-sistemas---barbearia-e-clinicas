/**
 * Fluxo do menu de atendimento — as REGRAS, num lugar so.
 *
 * Este arquivo e importado pelo servidor (que executa o fluxo no WhatsApp e
 * valida o que chega para ser salvo) e pela tela (o editor visual e a previa
 * "Testar"). Por isso nao importa NADA: qualquer dependencia de Node ou de
 * React quebraria um dos dois lados. O que o editor aceita e exatamente o que
 * o servidor aceita, e a previa responde exatamente como o WhatsApp.
 *
 * O formato segue o do n8n: nos de um lado, conexoes do outro, e cada saida de
 * um no e identificada pela POSICAO (a opcao 1 de um menu e a saida 0).
 */

// ============================================================================
// TIPOS (JSDoc — o VS Code autocompleta como se fosse TypeScript)
// ============================================================================

/**
 * @typedef {'menu'|'mensagem'|'servicos'|'atendente'|'sofia'} TipoNo
 *
 * @typedef {object} OpcaoMenu
 * @property {string} id      estavel: a tela liga a conexao por ele, nao pela posicao
 * @property {string} label   o que o cliente le ("Comprar", "Suporte")
 *
 * @typedef {object} DadosNo
 * @property {string} title          nome interno do passo (so o editor mostra)
 * @property {string} [message]      o texto que o cliente recebe
 * @property {OpcaoMenu[]} [options] so no tipo `menu`: de 1 a 5
 * @property {boolean} [disabled]    desativado = as opcoes que levam a ele somem do menu
 *
 * @typedef {object} NoFluxo
 * @property {string} id
 * @property {TipoNo} type
 * @property {{x: number, y: number}} position
 * @property {DadosNo} data
 *
 * @typedef {object} DestinoConexao
 * @property {string} node   id do no de destino
 * @property {'main'} type
 * @property {0} index       todo no tem uma entrada so
 *
 * `connections[origem].main[i]` = para onde vai a saida `i` do no de origem.
 * Uma saida leva a UM destino: uma escolha do cliente nao abre dois caminhos.
 * @typedef {Record<string, { main: DestinoConexao[][] }>} Conexoes
 *
 * @typedef {object} ConfigFluxo
 * @property {string} [mensagemErro]   quando o cliente digita um numero que nao existe
 * @property {number} [expiraMinutos]  parado no meio do menu por mais que isso, volta ao inicio
 *
 * @typedef {object} Fluxo
 * @property {2} versao
 * @property {string} inicio      id do menu que abre a conversa
 * @property {NoFluxo[]} nodes
 * @property {Conexoes} connections
 * @property {ConfigFluxo} [config]
 *
 * Onde o cliente esta. Fica gravado na conversa.
 * @typedef {object} EstadoMenu
 * @property {string} no        menu em que ele esta
 * @property {string[]} pilha   menus por onde passou (o "0 = voltar" desempilha)
 * @property {number} em        quando chegou ali (ms): depois de `expiraMinutos` vale o inicio
 *
 * @typedef {object} Problema
 * @property {string|null} noId   null = problema do fluxo inteiro
 * @property {string} mensagem
 */

// ============================================================================
// LIMITES E CATALOGO DE NOS
// ============================================================================

export const LIMITES = Object.freeze({
  /** Opcoes por menu. O menu vira lista numerada no WhatsApp: mais que isso ninguem le. */
  opcoes: 5,
  /** Passos a partir do inicio (o inicio e o passo 0). */
  profundidade: 10,
  /** Teto de nos no fluxo inteiro, para o JSON nunca virar um monstro. */
  nos: 80,
  titulo: 60,
  rotulo: 40,
  mensagem: 1500
});

/**
 * O que cada tipo de no faz.
 *   saidas: 'opcoes' = uma saida por opcao; numero = saidas fixas.
 */
export const TIPOS_NO = Object.freeze({
  menu: {
    rotulo: 'Menu',
    descricao: 'Mensagem com até 5 opções numeradas. Cada opção leva a outro passo.',
    saidas: 'opcoes',
    pedeMensagem: true
  },
  mensagem: {
    rotulo: 'Mensagem',
    descricao: 'Envia um texto. Pode seguir para outro passo em seguida.',
    saidas: 1,
    pedeMensagem: true
  },
  servicos: {
    rotulo: 'Serviços e preços',
    descricao: 'Lista os serviços e preços do catálogo, sempre atualizados.',
    saidas: 1,
    pedeMensagem: false
  },
  atendente: {
    rotulo: 'Chamar atendente',
    descricao: 'Avisa o cliente e coloca a conversa na fila de uma pessoa.',
    saidas: 0,
    pedeMensagem: false
  },
  sofia: {
    rotulo: 'Passar para a Sofia',
    descricao: 'Sai do menu: a partir daqui a IA conversa livremente (modo híbrido).',
    saidas: 0,
    pedeMensagem: false
  }
});

export const MENSAGEM_ERRO_PADRAO = 'Não encontrei essa opção.';
export const EXPIRA_MINUTOS_PADRAO = 60;
const TEXTO_ATENDENTE_PADRAO = 'Certo! Já estou chamando um de nossos atendentes. Um instante. 🙏';
const TEXTO_SOFIA_PADRAO = 'Claro! Me conta o que você precisa que eu já te ajudo. 😊';

const EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/** Palavras que sempre levam de volta ao menu inicial. */
const PALAVRAS_INICIO = ['menu', 'inicio', 'comecar', 'oi', 'ola', 'bom dia', 'boa tarde', 'boa noite'];

/** Atalhos que a recepcao ouve o dia inteiro, apontando para o TIPO do destino. */
const ATALHOS = {
  servicos: 'servicos',
  precos: 'servicos',
  preco: 'servicos',
  tabela: 'servicos',
  atendente: 'atendente',
  humano: 'atendente',
  suporte: 'atendente'
};

// ============================================================================
// LEITURA DO GRAFO
// ============================================================================

export function noPorId(fluxo, id) {
  return fluxo?.nodes?.find((n) => n.id === id) ?? null;
}

/** Quantas saidas um no tem. */
export function numeroDeSaidas(no) {
  const s = TIPOS_NO[no?.type]?.saidas;
  if (s === 'opcoes') return no.data?.options?.length ?? 0;
  return s ?? 0;
}

/** Id do no ligado a saida `indice` de `noId`, ou null. */
export function destinoDe(fluxo, noId, indice) {
  return fluxo?.connections?.[noId]?.main?.[indice]?.[0]?.node ?? null;
}

/**
 * Distancia (em passos) de cada no ate o inicio, pelo caminho mais curto.
 * Nos que o inicio nao alcanca ficam de fora do mapa.
 * @returns {Map<string, number>}
 */
export function profundidades(fluxo) {
  const dist = new Map();
  if (!noPorId(fluxo, fluxo?.inicio)) return dist;

  dist.set(fluxo.inicio, 0);
  const fila = [fluxo.inicio];
  while (fila.length) {
    const atual = fila.shift();
    const saidas = fluxo.connections?.[atual]?.main ?? [];
    for (const lista of saidas) {
      for (const c of lista ?? []) {
        if (!dist.has(c.node) && noPorId(fluxo, c.node)) {
          dist.set(c.node, dist.get(atual) + 1);
          fila.push(c.node);
        }
      }
    }
  }
  return dist;
}

// ============================================================================
// VALIDACAO
// ============================================================================

/**
 * Confere o fluxo inteiro.
 *
 * `erros` impedem salvar (o WhatsApp nao teria como executar). `avisos` nao
 * impedem, mas o editor mostra: uma opcao sem destino, por exemplo, apenas
 * some da lista que o cliente ve.
 *
 * @param {Fluxo} fluxo
 * @returns {{ erros: Problema[], avisos: Problema[] }}
 */
export function validarFluxo(fluxo) {
  const erros = [];
  const avisos = [];
  const erro = (noId, mensagem) => erros.push({ noId, mensagem });
  const aviso = (noId, mensagem) => avisos.push({ noId, mensagem });

  const nodes = Array.isArray(fluxo?.nodes) ? fluxo.nodes : [];
  if (nodes.length === 0) {
    erro(null, 'O fluxo está vazio: crie pelo menos um menu.');
    return { erros, avisos };
  }
  if (nodes.length > LIMITES.nos) erro(null, `O fluxo passou de ${LIMITES.nos} passos.`);

  const ids = new Set();
  for (const no of nodes) {
    if (ids.has(no.id)) erro(no.id, 'Dois passos com o mesmo identificador.');
    ids.add(no.id);
  }

  const inicio = noPorId(fluxo, fluxo.inicio);
  if (!inicio) erro(null, 'Escolha qual menu abre a conversa (Definir como início).');
  else if (inicio.type !== 'menu') erro(inicio.id, 'O início precisa ser um menu.');
  else if (inicio.data?.disabled) erro(inicio.id, 'O menu de início não pode estar desativado.');

  for (const no of nodes) {
    const tipo = TIPOS_NO[no.type];
    const nome = no.data?.title?.trim() || tipo?.rotulo || 'Passo';
    if (!tipo) {
      erro(no.id, `Tipo de passo desconhecido: ${no.type}.`);
      continue;
    }
    if ((no.data?.title ?? '').length > LIMITES.titulo) erro(no.id, `“${nome}”: nome longo demais.`);

    const mensagem = no.data?.message ?? '';
    if (mensagem.length > LIMITES.mensagem) erro(no.id, `“${nome}”: mensagem passa de ${LIMITES.mensagem} caracteres.`);
    if (tipo.pedeMensagem && !mensagem.trim()) erro(no.id, `“${nome}”: escreva a mensagem.`);

    if (no.type === 'menu') {
      const opcoes = no.data?.options ?? [];
      if (opcoes.length === 0) erro(no.id, `“${nome}”: o menu precisa de pelo menos uma opção.`);
      if (opcoes.length > LIMITES.opcoes) erro(no.id, `“${nome}”: no máximo ${LIMITES.opcoes} opções.`);

      const vistos = new Set();
      opcoes.forEach((op, i) => {
        const rotulo = (op.label ?? '').trim();
        if (!rotulo) erro(no.id, `“${nome}”: a opção ${i + 1} está sem texto.`);
        else if (rotulo.length > LIMITES.rotulo) erro(no.id, `“${nome}”: a opção ${i + 1} passa de ${LIMITES.rotulo} caracteres.`);
        const chave = normalizar(rotulo);
        if (chave && vistos.has(chave)) aviso(no.id, `“${nome}”: duas opções com o texto “${rotulo}”.`);
        vistos.add(chave);
        if (!destinoDe(fluxo, no.id, i)) aviso(no.id, `“${nome}”: a opção ${i + 1} não leva a lugar nenhum e fica escondida do cliente.`);
      });
    }
  }

  // Conexoes: de onde, para onde, quantas.
  for (const [origemId, conexao] of Object.entries(fluxo.connections ?? {})) {
    const origem = noPorId(fluxo, origemId);
    if (!origem) {
      erro(null, 'Uma ligação sai de um passo que não existe mais.');
      continue;
    }
    const saidas = numeroDeSaidas(origem);
    (conexao?.main ?? []).forEach((lista, i) => {
      if (!lista?.length) return;
      if (i >= saidas) erro(origemId, 'Uma ligação sai de uma opção que não existe mais.');
      if (lista.length > 1) erro(origemId, 'Uma mesma saída não pode levar a dois passos.');
      for (const c of lista) {
        if (!noPorId(fluxo, c.node)) erro(origemId, 'Uma ligação aponta para um passo que não existe mais.');
        else if (c.node === origemId) erro(origemId, 'Um passo não pode ligar a si mesmo.');
      }
    });
  }

  // Profundidade e alcance.
  const dist = profundidades(fluxo);
  for (const no of nodes) {
    const nome = no.data?.title?.trim() || TIPOS_NO[no.type]?.rotulo || 'Passo';
    if (!dist.has(no.id)) {
      if (inicio) aviso(no.id, `“${nome}” não está ligado ao início: o cliente nunca chega nele.`);
    } else if (dist.get(no.id) > LIMITES.profundidade) {
      erro(no.id, `“${nome}” está a ${dist.get(no.id)} passos do início; o limite é ${LIMITES.profundidade}.`);
    }
  }

  // Um "Mensagem → Mensagem → ..." em roda nunca terminaria de enviar.
  for (const no of nodes) {
    if (no.type !== 'mensagem' && no.type !== 'servicos') continue;
    const vistos = new Set([no.id]);
    let atual = destinoDe(fluxo, no.id, 0);
    while (atual) {
      const prox = noPorId(fluxo, atual);
      if (!prox || (prox.type !== 'mensagem' && prox.type !== 'servicos')) break;
      if (vistos.has(atual)) {
        erro(no.id, 'Há mensagens ligadas em roda: o cliente receberia textos sem fim. Ligue uma delas a um menu.');
        break;
      }
      vistos.add(atual);
      atual = destinoDe(fluxo, atual, 0);
    }
  }

  return { erros: unicos(erros), avisos: unicos(avisos) };
}

function unicos(lista) {
  const vistos = new Set();
  return lista.filter((p) => {
    const chave = `${p.noId}|${p.mensagem}`;
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

/**
 * A conexao `origem:saida → destino` pode ser feita? Usada pelo editor
 * enquanto o usuario arrasta a linha.
 *
 * @returns {string|null} o motivo da recusa, ou null se pode
 */
export function motivoParaRecusarLigacao(fluxo, origemId, indiceSaida, destinoId) {
  if (origemId === destinoId) return 'Um passo não pode ligar a si mesmo.';
  const origem = noPorId(fluxo, origemId);
  const destino = noPorId(fluxo, destinoId);
  if (!origem || !destino) return 'Passo não encontrado.';
  if (indiceSaida >= numeroDeSaidas(origem)) return 'Essa saída não existe.';

  const tentativa = comLigacao(fluxo, origemId, indiceSaida, destinoId);
  const dist = profundidades(tentativa);
  for (const [, d] of dist) {
    if (d > LIMITES.profundidade) return `Passaria de ${LIMITES.profundidade} passos a partir do início.`;
  }
  return null;
}

/** Copia do fluxo com a saida `indice` de `origemId` apontando para `destinoId`. */
export function comLigacao(fluxo, origemId, indice, destinoId) {
  const main = [...(fluxo.connections?.[origemId]?.main ?? [])];
  while (main.length <= indice) main.push([]);
  main[indice] = destinoId ? [{ node: destinoId, type: 'main', index: 0 }] : [];
  return { ...fluxo, connections: { ...fluxo.connections, [origemId]: { main } } };
}

// ============================================================================
// MOTOR: um passo do cliente dentro do fluxo
// ============================================================================

/** Tira acentos e pontuacao para comparar o que o cliente digitou. */
export function normalizar(texto) {
  return String(texto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[!?.,;:]+$/g, '')
    .trim();
}

function noAtivo(fluxo, id) {
  const no = noPorId(fluxo, id);
  return no && !no.data?.disabled ? no : null;
}

/**
 * As opcoes que o cliente VE num menu, na ordem em que aparecem numeradas.
 * Opcao sem destino, ou que leva a um passo desativado, some — senao o
 * cliente escolheria algo que nao faz nada.
 */
export function opcoesVisiveis(fluxo, menu) {
  return (menu?.data?.options ?? [])
    .map((opcao, indice) => ({ opcao, indice, destino: noAtivo(fluxo, destinoDe(fluxo, menu.id, indice)) }))
    .filter((o) => o.destino);
}

/** O texto de um menu como chega no WhatsApp. */
export function textoDoMenu(fluxo, menu, { cabecalho, podeVoltar = false } = {}) {
  const linhas = [cabecalho ?? menu.data?.message ?? '', ''];
  opcoesVisiveis(fluxo, menu).forEach(({ opcao }, i) => {
    linhas.push(`${EMOJIS[i] ?? `[${i + 1}]`} *${opcao.label}*`);
  });
  if (podeVoltar) linhas.push('0️⃣ *Voltar*');
  linhas.push('', '_Digite o número da opção desejada._');
  return linhas.join('\n').trim();
}

function expirado(fluxo, estado, agora) {
  const minutos = Number(fluxo.config?.expiraMinutos ?? EXPIRA_MINUTOS_PADRAO);
  return !estado?.em || agora - estado.em > minutos * 60_000;
}

/**
 * Processa uma mensagem do cliente contra o fluxo.
 *
 * Devolve `null` quando a mensagem NAO e um comando do menu (linguagem livre)
 * — e esse null que, no modo hibrido, passa a conversa para a Sofia.
 *
 * @param {Fluxo} fluxo
 * @param {EstadoMenu|null} estado   onde o cliente estava
 * @param {string} texto
 * @param {object} opcoes
 * @param {() => Promise<string>} opcoes.listarServicos   texto da lista de servicos (o servidor consulta o catalogo)
 * @param {number} [opcoes.agora]
 * @returns {Promise<null | {
 *   baloes: string[],
 *   estado: EstadoMenu|null,
 *   transferir?: boolean,
 *   entregarParaIa?: boolean,
 *   caminho: string[]
 * }>}
 */
export async function passoDoFluxo(fluxo, estado, texto, { listarServicos, agora = Date.now() }) {
  const limpo = normalizar(texto);
  const inicio = noAtivo(fluxo, fluxo?.inicio);
  if (!limpo || !inicio) return null;

  const salvo = estado && !expirado(fluxo, estado, agora) ? noAtivo(fluxo, estado.no) : null;
  const atual = salvo?.type === 'menu' ? salvo : null;
  const pilha = atual ? (estado.pilha ?? []) : [];
  const menu = atual ?? inicio;

  const mostrar = (no, novaPilha, cabecalho) => ({
    baloes: [textoDoMenu(fluxo, no, { cabecalho, podeVoltar: no.id !== inicio.id })],
    estado: { no: no.id, pilha: no.id === inicio.id ? [] : novaPilha, em: agora },
    caminho: [no.data?.title || 'Menu']
  });

  if (PALAVRAS_INICIO.includes(limpo)) return mostrar(inicio, []);

  if (limpo === '0' || limpo === 'voltar') {
    if (menu.id === inicio.id) return mostrar(inicio, []);
    const anterior = [...pilha].reverse().find((id) => noAtivo(fluxo, id)?.type === 'menu');
    const destino = noAtivo(fluxo, anterior) ?? inicio;
    const corte = pilha.lastIndexOf(destino.id);
    return mostrar(destino, corte >= 0 ? pilha.slice(0, corte) : []);
  }

  const visiveis = opcoesVisiveis(fluxo, menu);

  const numero = limpo.match(/^(?:#|opcao\s*)?(\d{1,2})$/);
  if (numero) {
    const escolhida = visiveis[Number(numero[1]) - 1];
    if (!escolhida) {
      // Numero que nao existe e erro de digitacao, nao linguagem livre.
      const erro = fluxo.config?.mensagemErro?.trim() || MENSAGEM_ERRO_PADRAO;
      return mostrar(menu, pilha, `${erro}\n\n${menu.data?.message ?? ''}`.trim());
    }
    return seguir(fluxo, escolhida.destino, { menu, pilha, inicio, agora, listarServicos });
  }

  const porTexto =
    visiveis.find((v) => normalizar(v.opcao.label) === limpo) ??
    (ATALHOS[limpo] ? visiveis.find((v) => v.destino.type === ATALHOS[limpo]) : null);
  if (porTexto) return seguir(fluxo, porTexto.destino, { menu, pilha, inicio, agora, listarServicos });

  return null;
}

/**
 * Executa o passo escolhido e os que vierem encadeados depois dele
 * ("Mensagem" → "Menu", por exemplo), ate parar num menu ou num fim.
 */
async function seguir(fluxo, primeiro, { menu, pilha, inicio, agora, listarServicos }) {
  const baloes = [];
  const caminho = [];
  let no = primeiro;

  // Sem trocar de menu, o cliente continua onde fez a escolha: depois de ler
  // "Horario de funcionamento", ele ainda pode digitar outra opcao dali.
  let estadoFinal = { no: menu.id, pilha, em: agora };

  // O validador ja impede mensagens em roda; o teto e so a ultima garantia.
  for (let passos = 0; no && passos < 20; passos++) {
    caminho.push(no.data?.title || TIPOS_NO[no.type]?.rotulo || no.type);

    if (no.type === 'menu') {
      let novaPilha = [...pilha, menu.id];
      // Voltar a um menu por onde ja passou (um "Voltar ao inicio" ligado ao
      // inicio) nao pode empilhar sem fim: corta a pilha ate ele.
      const ja = novaPilha.indexOf(no.id);
      if (ja >= 0) novaPilha = novaPilha.slice(0, ja);
      if (no.id === inicio.id) novaPilha = [];
      baloes.push(textoDoMenu(fluxo, no, { podeVoltar: no.id !== inicio.id }));
      estadoFinal = { no: no.id, pilha: novaPilha.slice(-LIMITES.profundidade), em: agora };
      return { baloes, estado: estadoFinal, caminho };
    }

    if (no.type === 'mensagem') {
      const texto = no.data?.message?.trim();
      if (texto) baloes.push(texto);
    } else if (no.type === 'servicos') {
      const cabecalho = no.data?.message?.trim();
      const lista = await listarServicos();
      baloes.push(cabecalho ? `${cabecalho}\n\n${lista}` : lista);
    } else if (no.type === 'atendente') {
      baloes.push(no.data?.message?.trim() || TEXTO_ATENDENTE_PADRAO);
      return { baloes, estado: null, transferir: true, caminho };
    } else if (no.type === 'sofia') {
      baloes.push(no.data?.message?.trim() || TEXTO_SOFIA_PADRAO);
      return { baloes, estado: null, entregarParaIa: true, caminho };
    }

    no = noAtivo(fluxo, destinoDe(fluxo, no.id, 0));
  }

  return { baloes, estado: estadoFinal, caminho };
}

/**
 * Linguagem livre no modo so-menu: reapresenta o menu em que o cliente esta,
 * com a mensagem de erro no topo.
 */
export function reapresentar(fluxo, estado, { agora = Date.now() } = {}) {
  const inicio = noAtivo(fluxo, fluxo?.inicio);
  if (!inicio) return null;
  const salvo = estado && !expirado(fluxo, estado, agora) ? noAtivo(fluxo, estado.no) : null;
  const menu = salvo?.type === 'menu' ? salvo : inicio;
  const erro = fluxo.config?.mensagemErro?.trim() || 'Não entendi.';
  return {
    baloes: [textoDoMenu(fluxo, menu, { cabecalho: `${erro}\n\n${menu.data?.message ?? ''}`.trim(), podeVoltar: menu.id !== inicio.id })],
    estado: { no: menu.id, pilha: menu.id === inicio.id ? [] : (estado?.pilha ?? []), em: agora },
    caminho: [menu.data?.title || 'Menu']
  };
}

// ============================================================================
// ORGANIZACAO AUTOMATICA E CONVERSAO DO MENU ANTIGO
// ============================================================================

const LARGURA_COLUNA = 380;
const ESPACO_VERTICAL = 40;
const ALTURA_OPCAO = 34;

function alturaEstimada(no) {
  if (no.type === 'menu') return 150 + ALTURA_OPCAO * (no.data?.options?.length ?? 0);
  return 120;
}

/**
 * Posiciona os nos em colunas por distancia do inicio (esquerda → direita),
 * como uma arvore:
 *
 *   - dentro de cada coluna, os passos seguem a ordem de quem aponta para
 *     eles (o destino da opcao 1 do primeiro menu vem antes do da opcao 2, e
 *     assim por diante) — os filhos ficam na altura dos pais e as linhas
 *     quase nao se cruzam;
 *   - cada coluna e centralizada na mesma linha horizontal, entao o menu de
 *     inicio fica no meio dos seus ramos em vez de preso no topo.
 *
 * Nos soltos vao para uma coluna a mais no fim.
 * @returns {Fluxo}
 */
export function organizarFluxo(fluxo) {
  const dist = profundidades(fluxo);
  const soltos = Math.max(0, ...dist.values()) + 1;
  const colunas = new Map();
  for (const no of fluxo.nodes) {
    const c = dist.get(no.id) ?? soltos;
    if (!colunas.has(c)) colunas.set(c, []);
    colunas.get(c).push(no);
  }

  // Quem aponta para quem, e por qual saida.
  const pais = new Map();
  for (const [origem, conexao] of Object.entries(fluxo.connections ?? {})) {
    (conexao?.main ?? []).forEach((lista, saida) => {
      for (const c of lista ?? []) {
        if (!pais.has(c.node)) pais.set(c.node, []);
        pais.get(c.node).push({ origem, saida });
      }
    });
  }

  const posicoes = new Map();
  for (const c of [...colunas.keys()].sort((a, b) => a - b)) {
    const nos = colunas.get(c);
    if (c > 0) {
      // A chave de um no e a altura do pai mais acima, ja posicionado numa
      // coluna anterior, somada a altura da opcao por onde ele sai.
      const chave = (no) => {
        const candidatas = (pais.get(no.id) ?? [])
          .filter((p) => posicoes.has(p.origem) && (dist.get(p.origem) ?? soltos) < c)
          .map((p) => posicoes.get(p.origem).y + ALTURA_OPCAO * p.saida);
        return candidatas.length ? Math.min(...candidatas) : Infinity;
      };
      const chaves = new Map(nos.map((n, i) => [n.id, [chave(n), i]]));
      nos.sort((a, b) => chaves.get(a.id)[0] - chaves.get(b.id)[0] || chaves.get(a.id)[1] - chaves.get(b.id)[1]);
    }

    const alturas = nos.map((n) => alturaEstimada(n));
    const total = alturas.reduce((s, h) => s + h, 0) + ESPACO_VERTICAL * Math.max(0, nos.length - 1);
    let y = -total / 2;
    nos.forEach((no, i) => {
      posicoes.set(no.id, { x: c * LARGURA_COLUNA, y: Math.round(y) });
      y += alturas[i] + ESPACO_VERTICAL;
    });
  }
  return { ...fluxo, nodes: fluxo.nodes.map((n) => ({ ...n, position: posicoes.get(n.id) })) };
}

/**
 * Menu antigo (arvore de `opcoes` com `acao` e `subOpcoes`) → fluxo novo.
 * Roda uma vez, na primeira vez que o editor abre um menu salvo no formato velho.
 *
 * O formato antigo aceitava ate 10 opcoes por menu; o novo, 5. Nada se perde:
 * a partir da 5a, as opcoes vao para um submenu "Mais opções".
 */
export function converterMenuAntigo(menu) {
  let seq = 0;
  const id = (p) => `${p}_${(++seq).toString(36)}`;
  const nodes = [];
  const connections = {};
  const ligar = (origem, indice, destino) => {
    connections[origem] ??= { main: [] };
    while (connections[origem].main.length <= indice) connections[origem].main.push([]);
    connections[origem].main[indice] = [{ node: destino, type: 'main', index: 0 }];
  };

  function noDaAcao(op) {
    const titulo = op.titulo || 'Opção';
    switch (op.acao) {
      case 'submenu':
        return criarMenu(titulo, `*${titulo}*`, op.subOpcoes ?? []);
      case 'listar_servicos':
        return criar('servicos', titulo, '');
      case 'consultar_horarios':
        return criar('sofia', titulo, 'Claro! Me diz qual serviço você quer e pra qual dia, que eu vejo os horários livres.');
      case 'falar_humano':
        return criar('atendente', titulo, op.respostaCustomizada || '');
      default:
        return criar('mensagem', titulo, op.respostaCustomizada || `*${titulo}*`);
    }
  }

  function criar(type, title, message) {
    const no = { id: id(type), type, position: { x: 0, y: 0 }, data: { title, message } };
    nodes.push(no);
    return no.id;
  }

  function criarMenu(title, message, opcoes) {
    const menuId = id('menu');
    const no = { id: menuId, type: 'menu', position: { x: 0, y: 0 }, data: { title, message, options: [] } };
    nodes.push(no);

    const cabem = opcoes.length > LIMITES.opcoes ? opcoes.slice(0, LIMITES.opcoes - 1) : opcoes;
    cabem.forEach((op, i) => {
      no.data.options.push({ id: id('opt'), label: (op.titulo || `Opção ${i + 1}`).slice(0, LIMITES.rotulo) });
      ligar(menuId, i, noDaAcao(op));
    });
    if (opcoes.length > LIMITES.opcoes) {
      const i = no.data.options.length;
      no.data.options.push({ id: id('opt'), label: 'Mais opções' });
      ligar(menuId, i, criarMenu('Mais opções', '*Mais opções*', opcoes.slice(LIMITES.opcoes - 1)));
    }
    return menuId;
  }

  const inicio = criarMenu('Menu principal', menu?.mensagemBoasVindas || 'Olá! Como posso te ajudar?', menu?.opcoes ?? []);

  return organizarFluxo({
    versao: 2,
    inicio,
    nodes,
    connections,
    config: {
      mensagemErro: menu?.mensagemErro || MENSAGEM_ERRO_PADRAO,
      expiraMinutos: EXPIRA_MINUTOS_PADRAO
    }
  });
}

/** Menu usado quando a empresa ainda nao montou o dela (formato antigo, convertido). */
export const MENU_PADRAO_ANTIGO = Object.freeze({
  mensagemBoasVindas: 'Olá! Seja bem-vindo(a)! 👋\n\nComo posso te ajudar hoje?',
  mensagemErro: 'Não entendi essa opção.',
  opcoes: [
    { titulo: 'Ver serviços e preços', acao: 'listar_servicos' },
    { titulo: 'Agendar um horário', acao: 'consultar_horarios' },
    { titulo: 'Meus agendamentos', acao: 'consultar_horarios' },
    { titulo: 'Falar com atendente', acao: 'falar_humano' }
  ]
});

export function fluxoPadrao() {
  return converterMenuAntigo(MENU_PADRAO_ANTIGO);
}

/** O fluxo que vale para a empresa: o salvo, o convertido do menu antigo, ou o padrao. */
export function fluxoDaEmpresa(linhaDoMenu) {
  if (linhaDoMenu?.fluxo?.nodes?.length) return linhaDoMenu.fluxo;
  if (linhaDoMenu?.opcoes?.length) return converterMenuAntigo(linhaDoMenu);
  return fluxoPadrao();
}
