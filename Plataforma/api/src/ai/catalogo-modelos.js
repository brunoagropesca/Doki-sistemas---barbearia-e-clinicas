/**
 * Catalogo de modelos: classificar e escolher os melhores para o WhatsApp.
 *
 * A API do Google lista dezenas de modelos (41 na chave de teste) misturando
 * coisas muito diferentes: modelos de texto, de voz, de imagem, de robotica.
 * Uma tela com tudo ligado seria inutil, e uma cascata que tentasse todos
 * gastaria a espera do cliente com modelos que nem geram texto.
 *
 * Aqui mora a decisao de "quais valem a pena para atender no WhatsApp". Sao
 * funcoes PURAS (sem banco, sem rede) de proposito: a regra de escolha e o
 * tipo de coisa que precisa ser testada com dezenas de cenarios.
 */

/** Quantos modelos ficam ligados automaticamente na cascata. */
export const MAXIMO_RECOMENDADOS = 8;

/**
 * De que tipo e o modelo.
 *
 *   texto  — conversa: o que o atendimento usa
 *   audio  — voz (transcricao, fala)
 *   imagem — imagem e video
 *   outro  — embeddings, robotica, uso de computador...
 *
 * E uma heuristica pelo nome, porque a API nao informa o tipo de forma
 * confiavel: o "Nano Banana" e um modelo de imagem que aceita `generateContent`
 * igual a um de texto. A classificacao serve para explicar na tela POR QUE um
 * modelo falhou no teste de texto — nao para esconde-lo.
 */
export function classificarModelo({ nome = '', nomeExibicao = '' } = {}) {
  const t = `${nome} ${nomeExibicao}`.toLowerCase();

  if (/tts|audio|transcri|speech|\blive\b/.test(t)) return 'audio';
  if (/image|imagen|nano[\s-]?banana|\bveo\b|video/.test(t)) return 'imagem';
  if (/embed|aqa|robotics|computer[\s-]?use/.test(t)) return 'outro';
  return 'texto';
}

/**
 * Modelo "instavel": previa ou experimental.
 *
 * O Google muda ou tira esses do ar sem aviso. Para atender cliente de
 * verdade, um modelo estavel um pouco mais lento vale mais que um em previa
 * que pode sumir amanha.
 */
export function ehInstavel(nome = '') {
  return /preview|[-_]exp\b|experimental/i.test(nome);
}

/** "models/gemini-2.5-flash-lite" -> "Gemini 2.5 Flash Lite" (quando a API nao deu o nome). */
export function nomeAmigavel(nome = '') {
  return nome
    .replace(/^models\//, '')
    .split('-')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ');
}

/** Ordem de qualidade para atendimento: estaveis primeiro, depois os mais rapidos. */
function porQualidade(a, b) {
  const instavel = Number(ehInstavel(a.nome)) - Number(ehInstavel(b.nome));
  if (instavel !== 0) return instavel;
  return (a.latenciaMs ?? Infinity) - (b.latenciaMs ?? Infinity);
}

/**
 * Escolhe os melhores modelos para atender no WhatsApp.
 *
 * Elegivel = passou no teste E e um modelo de texto. Dos elegiveis, ficam os
 * `maximo` melhores por (estavel antes de previa, depois mais rapido).
 *
 * REGRAS DE SEGURANCA:
 *  - O que a pessoa ligou ou desligou a mao (`manual`) NUNCA e alterado. Sem
 *    isso, cada reinicio do sistema desfaria as escolhas dela.
 *  - Se NENHUM modelo for elegivel, nao mexe em nada. Um teste feito durante
 *    uma queda do Google, ou com a cota zerada, reprovaria tudo — e desligar
 *    tudo tiraria o Gemini do ar por horas por causa de um soluco.
 *
 * @param {object[]} modelos
 * @returns {{ modelos: object[], melhor: string|null, elegiveis: number }}
 */
export function selecionarMelhores(modelos, { maximo = MAXIMO_RECOMENDADOS } = {}) {
  const elegiveis = modelos.filter((m) => m.ok === true && (m.categoria ?? 'texto') === 'texto');
  const ranking = [...elegiveis].sort(porQualidade);
  const melhor = ranking[0]?.nome ?? null;

  if (elegiveis.length === 0) {
    return { modelos: modelos.map((m) => ({ ...m, recomendado: false })), melhor: null, elegiveis: 0 };
  }

  const escolhidos = new Set(ranking.slice(0, maximo).map((m) => m.nome));

  return {
    modelos: modelos.map((m) => {
      const recomendado = escolhidos.has(m.nome);
      return m.manual ? { ...m, recomendado } : { ...m, recomendado, ativo: recomendado };
    }),
    melhor,
    elegiveis: elegiveis.length
  };
}

/** Ordem de exibicao na tela: recomendados primeiro (mais rapidos antes), depois o resto. */
export function ordenarParaExibicao(modelos) {
  const peso = (m) => {
    if (m.ok === true && m.ativo !== false) return 0; // aprovado e ligado
    if (m.ok === undefined && m.ativo !== false) return 1; // ligado, ainda sem teste
    if (m.ativo !== false) return 2; // ligado mas reprovado
    if (m.ok === true) return 3; // aprovado, mas desligado
    return 4; // desligado e reprovado/nao testado
  };
  return [...modelos].sort((a, b) => peso(a) - peso(b) || (a.latenciaMs ?? Infinity) - (b.latenciaMs ?? Infinity));
}
