/**
 * Lista os textos que as telas mostram e aponta os que ainda nao tem traducao.
 *
 *   node scripts/textos-da-tela.mjs            -> resumo: quantos faltam em cada idioma
 *   node scripts/textos-da-tela.mjs --faltando -> imprime os que faltam (JSON)
 *   node scripts/textos-da-tela.mjs --todos    -> imprime todos os textos achados (JSON)
 *
 * A traducao acontece na hora de MOSTRAR (ver src/lib/idioma.js): a chave e o
 * proprio texto em portugues. Por isso, quando uma tela nova ou um texto novo
 * entra, basta rodar este script e acrescentar o que faltar nos dicionarios
 * (src/lib/traducoes/*.js). Texto sem traducao continua aparecendo em
 * portugues — nada quebra.
 *
 * Usa o parser do rolldown (ja vem com o Vite): le JSX de verdade, sem regex.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';

const RAIZ = fileURLToPath(new URL('../src/', import.meta.url));

/** Atributos/propriedades que carregam codigo, nao texto para gente ler. */
const NAO_E_TEXTO = new Set([
  'className', 'key', 'to', 'href', 'src', 'type', 'name', 'id', 'htmlFor', 'role', 'variante', 'tamanho',
  'tom', 'icone', 'nome', 'chave', 'para', 'prefixo', 'volta', 'rel', 'target', 'method', 'accept', 'autoComplete',
  'inputMode', 'pattern', 'queryKey', 'funcao', 'cargoMinimo', 'modo', 'lang', 'd', 'viewBox', 'fill', 'stroke',
  'transform', 'style', 'width', 'height', 'download', 'capture', 'value', 'defaultValue', 'aba', 'estado', 'status',
  'cor', 'formato', 'campo', 'ordem', 'filtro', 'origem', 'motivo', 'grupo', 'tipo', 'direcao', 'autorTipo',
  'enterKeyHint', 'data-tema', 'x', 'y', 'cx', 'cy', 'r', 'points', 'strokeWidth', 'strokeLinecap',
  'strokeLinejoin', 'fillRule', 'clipRule', 'textAnchor', 'dominantBaseline', 'mask', 'clipPath', 'opacity'
]);

/**
 * Em componente (<Titulo d="...">), o nome da prop e escolha de quem escreveu:
 * `d` ali e descricao, nao caminho de SVG. So as props estruturais ficam de fora.
 */
const NAO_E_TEXTO_EM_COMPONENTE = new Set([
  'className', 'key', 'to', 'href', 'src', 'type', 'name', 'id', 'htmlFor', 'role', 'variante', 'tamanho', 'tom',
  'icone', 'chave', 'queryKey', 'funcao', 'cargoMinimo', 'style', 'value', 'defaultValue', 'cor', 'autoComplete'
]);

/** A prop e codigo? Depende de ser elemento HTML/SVG (minusculo) ou componente. */
function propDeCodigo(atributo, elemento) {
  const nome = atributo.name?.name ?? '';
  if (/^(on[A-Z]|data-|aria-(?!label|description|valuetext))/.test(nome)) return true;
  const tag = elemento?.name?.name ?? '';
  const componente = /^[A-Z]/.test(tag) || elemento?.name?.type === 'JSXMemberExpression';
  return componente ? NAO_E_TEXTO_EM_COMPONENTE.has(nome) : NAO_E_TEXTO.has(nome);
}

/** Chamadas cujo argumento nao e texto de tela. */
const CHAMADAS_DE_CODIGO = /^(console\.|api\.|localStorage\.|sessionStorage\.|document\.|window\.|new URL|fetch|import|require|navegar|navigate|setSearchParams|busca\.|params\.|url\.|querySelector|matches|closest|addEventListener|removeEventListener|getAttribute|setAttribute|classList|startsWith|endsWith|includes|split|replace|match|test|padStart|toLocale|Intl\.|RegExp|JSON|String\.raw|Object\.|Array\.|Symbol|new Date|Date)/;

export const normalizarTexto = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** O JSX escreve "&quot;" no codigo, mas a tela mostra aspas: a chave e o que a tela mostra. */
const ENTIDADES = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ', apos: "'", '#39': "'" };
const decodificar = (t) => t.replace(/&(quot|amp|lt|gt|nbsp|apos|#39);/g, (_, e) => ENTIDADES[e]);

/**
 * Achados que parecem texto mas sao codigo (chave interna, formato de audio,
 * caminho de SVG...). Ficam fora da conta do que falta traduzir.
 */
const NAO_TRADUZIR = new Set([
  'M{0},{1} V{2} Q{3},{4} {5},{6} H{7} Q{8},{9} {10},{11} V{12} Z', 'NFD', '[title], [aria-label]',
  'audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'brilhoA', 'gerando progresso--ativo', 'iaHabilitada', 'in /',
  'mensagemChamada', 'min(100%, max(80vw, 720px))', 'pt-BR', 'sv-SE', 'rejeitarChamadas', 'simularDigitacao',
  'sombraG1', 'sombraG2', 'textoFracoA', 'textoSuaveA', 'usarHistorico', '×',
  'useAuth precisa estar dentro de <ProvedorAuth>.', '{0}-contador', '{0}-descricao', '{0}-erro', '{0}-lista',
  // Modelo de mensagem que a EMPRESA edita (as {chaves} o servidor troca).
  '{saudacao}, {nome}! Aqui é {atendente}, da barbearia. Como posso ajudar?'
]);

/** Tem cara de texto para gente: letras, e nao e identificador/classe/rota. */
function pareceTexto(t) {
  if (!/[A-Za-zÀ-ÿ]/.test(t) || NAO_TRADUZIR.has(t)) return false;
  if (/^(script, |input:not\(|\{0\}, select$)/.test(t)) return false; // seletores CSS em JS
  if (/^[a-z0-9_\-.:/#?=&%@+*[\]()]+$/.test(t)) return false; // pendente, menu__item, /api/x, a-b
  if (/^[A-Z0-9_]+$/.test(t) && t.length > 1 && !/^[A-Z]{2,5}$/.test(t)) return false; // CONSTANTE (mas OK/PDF passam)
  if (/^(https?:|mailto:|data:|#[0-9a-f]{3,8}$|var\(|rgba?\(|\d+(px|%|ms|s|em|rem|vh|vw)\b)/i.test(t)) return false;
  if (/^[\w.-]+\.(png|jpe?g|svg|webp|gif|ogg|mp3|mp4|webm|pdf|js|css|json|xlsx|csv|db|gz)$/i.test(t)) return false;
  if (/(sans-serif|serif|monospace|system-ui)$/.test(t)) return false; // pilha de fontes
  if (/rgba?\(|cubic-bezier|translate\(|#[0-9a-f]{6}\b/i.test(t)) return false; // CSS
  if (/[{};]\s*$/.test(t) && /[:;{]/.test(t) && !/\s[a-zà-ÿ]{3,}\s/.test(t)) return false; // pedaco de CSS
  return true;
}

function nomeDaChamada(no) {
  const c = no.callee;
  if (!c) return '';
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression') {
    const obj = c.object.type === 'Identifier' ? c.object.name : c.object.type === 'ThisExpression' ? 'this' : '';
    const prop = c.property?.name ?? '';
    return obj ? `${obj}.${prop}` : prop;
  }
  return '';
}

function arquivos(dir) {
  const saida = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) saida.push(...arquivos(caminho));
    // Fora: o proprio dicionario, e lib/idioma.js (os nomes das linguas aparecem
    // sempre na propria lingua: "English", "Español").
    else if (
      /\.(jsx?|mjs)$/.test(nome) &&
      !/\.test\./.test(nome) &&
      !caminho.includes(join('lib', 'traducoes')) &&
      !caminho.endsWith(join('lib', 'idioma.js'))
    )
      saida.push(caminho);
  }
  return saida;
}

/** Percorre a arvore guardando o "caminho" (pais) para decidir o contexto. */
function andar(no, pais, visitar) {
  if (!no || typeof no.type !== 'string') return;
  visitar(no, pais);
  pais.push(no);
  for (const chave of Object.keys(no)) {
    if (chave === 'parent') continue;
    const valor = no[chave];
    if (Array.isArray(valor)) for (const v of valor) andar(v, pais, visitar);
    else if (valor && typeof valor.type === 'string') andar(valor, pais, visitar);
  }
  pais.pop();
}

/** O literal esta num lugar onde e codigo (import, comparacao, chave de objeto...)? */
function contextoDeCodigo(no, pais) {
  const pai = pais.at(-1);
  if (!pai) return false;
  if (pai.type === 'ImportDeclaration' || pai.type === 'ExportNamedDeclaration' || pai.type === 'ExportAllDeclaration' || pai.type === 'ImportExpression') return true;
  if (pai.type === 'BinaryExpression' && ['===', '!==', '==', '!=', 'in', 'instanceof'].includes(pai.operator)) return true;
  if ((pai.type === 'Property' || pai.type === 'PropertyDefinition') && pai.key === no && !pai.computed) return true;
  if (pai.type === 'Property' && pai.value === no && NAO_E_TEXTO.has(pai.key?.name ?? pai.key?.value)) return true;
  if (pai.type === 'MemberExpression' && pai.property === no) return true;
  if (pai.type === 'SwitchCase') return true;
  if (pai.type === 'JSXAttribute') return propDeCodigo(pai, pais.at(-2));
  if (pai.type === 'JSXExpressionContainer') {
    const avo = pais.at(-2);
    if (avo?.type === 'JSXAttribute') return propDeCodigo(avo, pais.at(-3));
  }
  for (let i = pais.length - 1; i >= 0; i--) {
    const p = pais[i];
    if (p.type === 'CallExpression' || p.type === 'NewExpression') {
      if (CHAMADAS_DE_CODIGO.test(nomeDaChamada(p))) return true;
      break;
    }
    if (p.type === 'JSXElement' || p.type === 'VariableDeclarator' || p.type === 'ReturnStatement') break;
  }
  // Atribuicao/propriedade dentro de um JSXAttribute de codigo (className={x ? 'a' : 'b'}).
  for (let i = pais.length - 1; i >= 0; i--) {
    const p = pais[i];
    if (p.type === 'JSXAttribute') return propDeCodigo(p, pais[i - 1]);
    if (p.type === 'JSXElement') break;
  }
  return false;
}

/** Texto de um template: `${n} marcados` -> "{0} marcados". */
function textoDoTemplate(no) {
  let t = '';
  no.quasis.forEach((q, i) => {
    t += q.value.cooked ?? q.value.raw;
    if (i < no.expressions.length) t += `{${i}}`;
  });
  return normalizarTexto(t);
}

export function extrairTextos() {
  const textos = new Map(); // texto -> Set(arquivos)
  // Texto solto no JSX e sempre de tela: "marcados", "vezes" (uma palavra em
  // minusculas) so parece identificador quando vem numa string de codigo.
  const guardar = (t, arquivo, doJsx = false) => {
    const n = normalizarTexto(t);
    if (!n || n.length > 600) return;
    if (doJsx ? !/[A-Za-zÀ-ÿ]/.test(n) || NAO_TRADUZIR.has(n) : !pareceTexto(n)) return;
    // Padrao sem texto fixo suficiente ("{0} {1}") nao tem o que traduzir.
    if (n.includes('{0}') && n.replace(/\{\d+\}/g, '').replace(/[^A-Za-zÀ-ÿ]/g, '').length < 3) return;
    if (!textos.has(n)) textos.set(n, new Set());
    textos.get(n).add(relative(RAIZ, arquivo).replaceAll('\\', '/'));
  };

  for (const arquivo of arquivos(RAIZ)) {
    const codigo = readFileSync(arquivo, 'utf8');
    let ast;
    try {
      ast = parseAst(codigo, { lang: 'jsx' });
    } catch (err) {
      console.error(`Nao consegui ler ${arquivo}: ${err.message}`);
      continue;
    }
    andar(ast, [], (no, pais) => {
      if (no.type === 'JSXText') guardar(decodificar(no.value), arquivo, true);
      else if (no.type === 'Literal' && typeof no.value === 'string') {
        if (!contextoDeCodigo(no, pais)) guardar(no.value, arquivo);
      } else if (no.type === 'TemplateLiteral') {
        const pai = pais.at(-1);
        if (pai?.type === 'TaggedTemplateExpression') return;
        if (!contextoDeCodigo(no, pais)) guardar(textoDoTemplate(no), arquivo);
      }
    });
  }
  return textos;
}

async function principal() {
  const textos = extrairTextos();
  const args = process.argv.slice(2);
  if (args.includes('--todos')) {
    console.log(JSON.stringify([...textos.keys()].sort(), null, 1));
    return;
  }
  const { TRADUCOES } = await import('../src/lib/traducoes/index.js');
  const faltando = {};
  for (const [idioma, dic] of Object.entries(TRADUCOES)) {
    faltando[idioma] = [...textos.keys()].filter((t) => !Object.hasOwn(dic, t)).sort();
  }
  if (args.includes('--faltando')) {
    console.log(JSON.stringify(faltando, null, 1));
    return;
  }
  console.log(`${textos.size} textos nas telas.`);
  for (const [idioma, lista] of Object.entries(faltando)) console.log(`${idioma}: ${lista.length} sem traducao`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) principal();
