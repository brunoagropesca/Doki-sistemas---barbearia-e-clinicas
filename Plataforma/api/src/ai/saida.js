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
