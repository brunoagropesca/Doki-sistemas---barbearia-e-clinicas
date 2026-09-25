/**
 * O ultimo filtro antes de um texto da IA chegar ao WhatsApp do cliente.
 *
 * O prompt pede o formato certo, mas modelo escorrega — e escorrega igual
 * para todas as empresas ao mesmo tempo. Nos testes reais chegaram ao
 * cliente "**Descoloração**" (o WhatsApp mostra os asteriscos), um marcador
 * de balao pela metade ("amanh[AO]mas") e frases como "a Atena pediu um
 * instante" e "o sistema indicou que os dados não constam". Consertar isso em
 * codigo custa zero token e vale para todo mundo; pedir de novo ao modelo,
 * so quando nao tem outro jeito (vazamento de bastidores).
 */

/** Formatacao de Markdown que o WhatsApp nao entende -> a que ele entende. */
export function formatarParaWhatsapp(texto) {
  return (
    String(texto ?? '')
      // **negrito** e __italico__ do Markdown: no WhatsApp e um simbolo so.
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '*$1*')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '_$1_')
      // Negrito em volta de um parentese que ja tem negrito dentro (visto num
      // teste real: "*(Alexandre: *R$ 550,00*)*") quebra os dois; fica so o de dentro.
      .replace(/\*\(([^()\n]*\*[^()\n]*)\)\*/g, '($1)')
      // Titulos "## Servicos" viram uma linha em negrito.
      .replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, '*$1*')
      // [texto](link) -> "texto: link"
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1: $2')
      // Item de lista com "* " no comeco da linha viraria negrito quebrado.
      .replace(/^(\s*)\*\s+/gm, '$1• ')
      // Marcadores internos que sobraram (de balao ou de consulta).
      .replace(/\[(?:bal[aã]o|pausa|quebra)\]/gi, ' ')
      .replace(/\[Consultando:[^\]]*\]/gi, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  );
}

/**
 * Palavras que so fazem sentido nos bastidores.
 *
 * Para o cliente, quem verifica e agenda e a Sofia. "A Atena", "o sistema",
 * "ferramenta", "dados inválidos" expoem a engrenagem e soam como erro.
 */
const BASTIDORES = new RegExp(
  [
    '\\batena\\b',
    '\\b(?:o|no|do|pelo|nosso|meu) sistema\\b',
    '\\bbanco de dados\\b',
    '\\bferramentas?\\b',
    '\\b(?:consultar|criar|agendar|listar|remarcar|cancelar)_\\w+',
    '\\bdados (?:n[aã]o constam|inv[aá]lidos)\\b',
    '\\bcadastrad[oa]s? (?:certinho )?(?:aqui )?no\\b'
  ].join('|'),
  'i'
);

/** O trecho que denuncia os bastidores, ou null. */
export function vazaBastidores(texto) {
  return BASTIDORES.exec(String(texto ?? ''))?.[0] ?? null;
}

/**
 * Ultimo recurso quando nem a reescrita resolveu: tira as FRASES que citam os
 * bastidores. Se nao sobrar nada, devolve o original (melhor uma frase com
 * "sistema" do que silencio).
 */
export function tirarFrasesDeBastidores(texto) {
  const frases = String(texto ?? '').split(/(?<=[.!?…])\s+|\n+/);
  const limpas = frases.filter((f) => f.trim() && !vazaBastidores(f));
  return limpas.length ? limpas.join(' ').trim() : String(texto ?? '').trim();
}

// ============================================================================
// PRECO INVENTADO
// ============================================================================

/**
 * Os valores "R$ ..." de um texto, em centavos.
 *
 * E a base da trava contra preco inventado: num teste real, com ZERO servicos
 * cadastrados, a Sofia respondeu uma tabela inteira ("Corte Masculino: R$
 * 45,00..."). O prompt pede para nao inventar, mas modelo obedece quase
 * sempre — e "quase" com preco e cliente cobrando o valor no balcao.
 * Aceita "R$ 45", "R$45,00", "R$ 1.234,56" (espaco comum ou o do Intl).
 */
export function precosEmReais(texto) {
  const valores = [];
  for (const m of String(texto ?? '').matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/g)) {
    const inteiro = Number(m[1].replace(/\./g, ''));
    const centavos = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
    valores.push(inteiro * 100 + centavos);
  }
  return valores;
}

/**
 * Os valores que a Sofia PODE citar: os do catalogo (e dos profissionais), as
 * somas de ate 3 deles (combo, "corte + barba sai R$ 85"), e os que vieram em
 * textos verificados (resultados das consultas do turno, base de conhecimento).
 *
 * @param {number[]} precosCatalogo   centavos
 * @param {string[]} textosVerificados
 * @returns {Set<number>}
 */
export function precosPermitidos(precosCatalogo, textosVerificados = []) {
  const base = [...new Set(precosCatalogo.filter((v) => Number.isFinite(v) && v > 0))];
  const permitidos = new Set(base);
  for (let i = 0; i < base.length; i++) {
    for (let j = i; j < base.length; j++) {
      permitidos.add(base[i] + base[j]);
      for (let k = j; k < base.length; k++) permitidos.add(base[i] + base[j] + base[k]);
    }
  }
  for (const t of textosVerificados) for (const v of precosEmReais(t)) permitidos.add(v);
  return permitidos;
}

/** Os valores do texto que NAO estao entre os permitidos (vazio = tudo verificado). */
export function precosNaoVerificados(texto, permitidos) {
  return precosEmReais(texto).filter((v) => !permitidos.has(v));
}

/**
 * Cliente irritado AGORA, nesta mensagem.
 *
 * Nao e leitura de humor (essa roda de tempos em tempos e custa uma
 * chamada): e um sinal barato para a Sofia nao responder um palavrao com
 * "o que aconteceu exatamente?" — foi o que ela fez no teste real.
 * Palavrao nem sempre e raiva ("porra, que corte top"), por isso isto vira um
 * AVISO no prompt, nao uma transferencia automatica.
 */
const IRRITACAO =
  /\b(porra|caralho|merda|pqp|puta que pariu|vsf|vtnc|fdp|foda-?se|palha[cç]ada|rid[ií]cul[oa]|absurdo|incompetentes?|descaso|p[eé]ssim[oa]|lixo)\b|\?{3,}|!{3,}/i;

export function pareceIrritado(texto) {
  return IRRITACAO.test(String(texto ?? ''));
}

/**
 * Cliente RECLAMANDO de algo que ja aconteceu (servico, atendimento, cobranca).
 *
 * Decide se o roteiro detalhado de reclamacao (regras 9 e 10) entra no prompt:
 * ele custava ~250 tokens em TODA mensagem, e quase nenhuma e reclamacao. Sem
 * o sinal, a Sofia ainda recebe a versao curta (acolher e transferir) — errar
 * para o lado de "nao detectou" custa pouco.
 */
const RECLAMACAO = new RegExp(
  '\\b(' +
    [
      'reclama\\w*',
      'insatisfeit[oa]s?',
      'decepcionad[oa]s?|decep[cç][aã]o',
      'n[aã]o gostei|n[aã]o curti|n[aã]o ficou bom|n[aã]o ficou como',
      'mal atendid[oa]|me atenderam mal|fui mal',
      'estorno|reembolso|devolv\\w* (?:o|meu) dinheiro|quero (?:meu|o) dinheiro',
      'cobra(?:ram|do|n[cç]a) (?:errad[oa]|a mais|duas vezes|indevid\\w*)',
      'ficou (?:ruim|horr[ií]vel|p[eé]ssim[oa]|tort[oa]|errad[oa]|feio|feia|mal feit[oa]|diferente)',
      'cortou (?:errado|demais)|cortaram (?:errado|demais)',
      'estragou|estragaram|queimou|machucou|alergia',
      // "grosso" sozinho nao: "cabelo grosso" e o dia a dia da barbearia.
      'grosseir[oa]s?|grosseria|(?:foi|foram|muito|ele e|ela e) gross[oa]s?|mal educad[oa]|sem educa[cç][aã]o',
      'esperei (?:muito|mais de|uma hora|\\d+)|me deixaram esperando|furou (?:o|meu) hor[aá]rio',
      'nunca mais volto|n[aã]o volto mais|n[aã]o recomendo',
      'deu problema|tive um problema|teve um problema'
    ].join('|') +
    ')\\b',
  'i'
);

export function pareceReclamacao(texto) {
  return RECLAMACAO.test(String(texto ?? ''));
}

/**
 * A Sofia pediu desculpas numa resposta recente: ela mesma percebeu um
 * problema (mesmo que o cliente nao tenha usado nenhuma palavra da lista
 * acima). Sinal para manter o roteiro de reclamacao nas trocas seguintes.
 */
const DESCULPAS = /\b(sinto muito|lamento|pe[cç]o desculpas|pedimos desculpas|desculpe (?:pelo|pela|o|a)|mil desculpas|que chato isso)\b/i;

export function pediuDesculpas(texto) {
  return DESCULPAS.test(String(texto ?? ''));
}
