/**
 * Quais itens da base de conhecimento tem a ver com uma mensagem.
 *
 * Regras da casa, perguntas frequentes e extras sairam do prompt da Sofia
 * (eram metade dele). O risco: ela responder "tem Wi-Fi?" sem consultar e
 * inventar. Aqui o CODIGO decide o que e relevante — sem depender do modelo
 * lembrar de chamar a ferramenta:
 *
 *   - antes: o que casa com a mensagem do cliente vai no prompt daquele turno;
 *   - depois: se a resposta tocou num tema cadastrado que ela nao leu, a
 *     resposta e revisada com a informacao oficial (atendimento.service).
 *
 * Casamento por palavras (raiz de 5 letras) mais TEMAS com sinonimos — o
 * cliente escreve "internet" e a base diz "Wi-Fi". Errar para mais (um item a
 * mais no prompt) custa poucos tokens; errar para menos e o risco que isto
 * existe para cobrir. Tudo puro, sem banco.
 */

/**
 * Temas fortes: cada um junta as formas como o cliente e a empresa escrevem a
 * mesma coisa. Sao tambem os temas que a revisao da resposta confere.
 * (Sem "vaga": "tem vaga hoje?" e agenda, nao estacionamento.)
 */
export const TEMAS = {
  wifi: ['wifi', 'internet', 'senha da rede'],
  estacionamento: ['estacionamento', 'estacionar', 'carro', 'moto', 'garagem'],
  crianca: ['crianca', 'criancas', 'filho', 'filha', 'filhos', 'menino', 'menina', 'infantil', 'bebe', 'kids'],
  atraso: ['atraso', 'atrasar', 'atrasado', 'atrasada', 'tolerancia'],
  cancelamento: ['cancelar', 'cancelamento', 'desmarcar', 'faltar', 'falta'],
  bebida: ['cerveja', 'cafe', 'cafezinho', 'bebida', 'bebidas', 'agua', 'refrigerante'],
  animal: ['cachorro', 'pet', 'animal', 'gato'],
  acessibilidade: ['cadeirante', 'acessibilidade', 'rampa', 'escada', 'elevador'],
  produto: ['pomada', 'oleo', 'shampoo', 'produto', 'produtos', 'vendem', 'vende'],
  saude: ['gripe', 'doenca', 'alergia', 'alergico', 'gravida', 'gestante'],
  quimica: ['teste de mecha', 'mecha', 'descoloracao', 'platinado', 'luzes']
};

/** Palavras que aparecem em quase toda mensagem e nao dizem o assunto. */
const VAZIAS = new Set(
  (
    'para pelo pela pelos pelas com sem que qual quais quando onde como porque entao isso esse essa este esta ' +
    'voce voces vcs tem temos tenho quero queria gostaria pode podem posso seria fazer faz favor obrigado obrigada ' +
    'hoje amanha agora dia dias hora horas horario horarios marcar agendar agendamento marcado vaga vagas ' +
    'oi ola bom boa tarde noite manha tudo bem aqui ai la mais muito pouco ainda tambem sim nao ' +
    'corte cortar barba servico servicos preco valor quanto custa'
  ).split(' ')
);

/** "Wi-Fi" -> "wifi", "Criança" -> "crianca": sem acento, sem pontuacao. */
export function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bwi[\s-]?fi\b/g, 'wifi')
    .replace(/\be[\s-]mail\b/g, 'email')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const raiz = (palavra) => (palavra.length > 5 ? palavra.slice(0, 5) : palavra);

/**
 * A palavra e uma variacao da forma ("atrasei" / "atrasar", "cancela" /
 * "cancelar")? Mais estrito que a raiz de 5 letras de proposito: nos TEMAS um
 * falso positivo dispara revisao de resposta, e a raiz confundiria "cachos"
 * com "cachorro" e "desconto" com "descoloracao".
 */
function variacao(palavra, forma) {
  if (palavra === forma) return true;
  return forma.length >= 6 && palavra.startsWith(forma.slice(0, -2)) && Math.abs(palavra.length - forma.length) <= 3;
}

/** Os temas fortes que o texto cita. */
export function temasDoTexto(texto) {
  const norm = normalizar(texto);
  const palavras = norm.split(' ');
  const achados = new Set();
  for (const [tema, formas] of Object.entries(TEMAS)) {
    const cita = formas.some((f) => (f.includes(' ') ? ` ${norm} `.includes(` ${f} `) : palavras.some((p) => variacao(p, f))));
    if (cita) achados.add(tema);
  }
  return achados;
}

/** As raizes das palavras que dizem o assunto (sem as vazias). */
function raizesDoTexto(texto) {
  return new Set(
    normalizar(texto)
      .split(' ')
      .filter((p) => p.length >= 3 && !VAZIAS.has(p))
      .map(raiz)
  );
}

/**
 * Os itens da base que casam com os textos (a mensagem do cliente e, para
 * perguntas de continuacao como "e pra crianca?", a anterior dele).
 * Os que casam com mais pontos vem primeiro; no maximo `max`.
 *
 * @param {{ tema: string, texto: string }[]} itens
 * @param {string[]} textos
 */
export function itensRelevantes(itens, textos, { max = 4 } = {}) {
  const temas = new Set();
  const raizes = new Set();
  for (const t of textos) {
    for (const x of temasDoTexto(t)) temas.add(x);
    for (const x of raizesDoTexto(t)) raizes.add(x);
  }
  if (!temas.size && !raizes.size) return [];

  return itens
    .map((item) => {
      let pontos = 0;
      for (const x of temasDoTexto(item.texto)) if (temas.has(x)) pontos += 2;
      for (const x of raizesDoTexto(item.texto)) if (raizes.has(x)) pontos += 1;
      return { item, pontos };
    })
    // Um tema forte (2 pontos) ou duas palavras em comum. Uma palavra so
    // ("Rafael", que aparece numa pergunta frequente) casava em quase toda
    // marcacao e punha texto a toa no prompt.
    .filter((x) => x.pontos >= 2)
    .sort((a, b) => b.pontos - a.pontos)
    .slice(0, max)
    .map((x) => x.item);
}

/**
 * Temas fortes que a RESPOSTA cita e que existem na base, mas que a Sofia nao
 * leu neste turno (nem vieram no prompt, nem ela consultou). Devolve os itens
 * da base desses temas — o que ela deveria ter lido.
 *
 * @param {string} resposta
 * @param {{ tema: string, texto: string }[]} itens   toda a base (detalhes)
 * @param {{ tema: string, texto: string }[]} lidos   o que ela viu no turno
 */
export function itensNaoLidos(resposta, itens, lidos) {
  const vistos = new Set(lidos.map((i) => i.texto));
  const temas = temasDoTexto(resposta);
  if (!temas.size) return [];
  return itens.filter((i) => !vistos.has(i.texto) && [...temasDoTexto(i.texto)].some((t) => temas.has(t)));
}
