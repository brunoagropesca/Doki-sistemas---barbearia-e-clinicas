import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { aiCalls, aiProviders } from '../db/schema/ai.js';
import { ID } from '../core/ids.js';
import { comContexto } from '../core/logger.js';
import { decifrar } from '../core/crypto.js';
import { ServicoIndisponivel } from '../core/errors.js';
import { gemini } from './providers/gemini.js';
import { ErroDeProvedor, pareceIncompleta } from './providers/base.js';
import { colorir, fg, negrito, nomeDoAgente, resumir, ver } from '../core/painel.js';
import { groq, ollama, openai } from './providers/openai-compat.js';

const log = comContexto({ modulo: 'ia' });

/**
 * Cascata de provedores.
 *
 * Tenta os provedores habilitados na ordem de prioridade da empresa e, dentro
 * de cada um, os modelos configurados. Desce um degrau quando a falha e
 * passageira (cota, servidor fora); desiste do provedor inteiro quando a falha
 * e estrutural (chave invalida).
 *
 * Diferencas para a cascata do sistema antigo:
 *  - Provedor e um objeto com interface fixa, nao um bloco `if` inline.
 *  - Toda chamada e registrada em `ai_calls` — custo, latencia e quais
 *    tentativas falharam antes. Antes disso, ninguem sabia quanto a IA
 *    gastava nem com que frequencia o provedor principal falhava.
 *  - Erro estrutural nao e re-tentado a esmo.
 *  - Quando tudo falha, levanta erro em vez de devolver um texto fixo
 *    fingindo que deu certo (o que fazia o cliente receber "Olá! Sou a
 *    assistente virtual..." no meio de uma negociacao).
 */

/** Registro central de provedores. Adicionar um provedor novo e uma linha aqui. */
const PROVEDORES = { gemini, groq, openai, ollama };

/**
 * Quantos modelos do MESMO provedor a cascata tenta antes de passar ao proximo.
 *
 * Existe para um provedor com catalogo GRANDE e SEM curadoria: sem teto, um
 * provedor com cota esgotada faria a cascata gastar a espera de cada modelo —
 * minutos, com o cliente esperando — antes de tentar o proximo. Se 4 modelos
 * seguidos falharam, o problema e o provedor, nao o modelo.
 *
 * O GEMINI E A EXCECAO (ver `montarFilaDeModelos`): o catalogo dele chega a 41
 * modelos, mas a curadoria automatica (`selecionarMelhores`, em
 * catalogo-modelos.js) ja liga no maximo os 8 melhores para WhatsApp e desliga
 * o resto — o risco que este teto existe para evitar ja foi resolvido antes de
 * chegar aqui. Por isso o Gemini tenta TODOS os modelos ativos (os 8 da
 * curadoria, e mais os que a pessoa ligou a mao) antes de a cascata pular para
 * o Groq.
 */
export const MAX_MODELOS_POR_PROVEDOR = 4;

/**
 * Decide a ordem dos modelos de um provedor.
 *
 *  1. O modelo PRIMARIO escolhido pela empresa vem primeiro — mesmo que o
 *     ultimo teste tenha falhado (falha pode ser cota momentanea, e a decisao
 *     de trocar e da pessoa, nao nossa).
 *  2. Depois, os que passaram no teste, do mais rapido para o mais lento.
 *  3. Depois, os que nunca foram testados.
 *  4. Modelos DESATIVADOS ou que FALHARAM no teste ficam de fora.
 *  5. Os modelos sugeridos do provedor entram no fim, como rede de seguranca.
 *
 * O Gemini fica de fora do teto de `MAX_MODELOS_POR_PROVEDOR` — ver o
 * comentario dele para o porque.
 */
export function montarFilaDeModelos(linha, impl) {
  const modelos = linha.modelos ?? [];
  const desativados = new Set(modelos.filter((m) => m.ativo === false).map((m) => m.nome));

  const aprovados = modelos
    .filter((m) => m.ativo !== false && m.ok === true)
    .sort((a, b) => (a.latenciaMs ?? Infinity) - (b.latenciaMs ?? Infinity))
    .map((m) => m.nome);

  const naoTestados = modelos.filter((m) => m.ativo !== false && m.ok === undefined).map((m) => m.nome);

  const fila = [linha.modeloPadrao, ...aprovados, ...naoTestados, ...(impl.modelosPadrao ?? [])]
    .filter(Boolean)
    .filter((nome) => !desativados.has(nome));

  const unica = [...new Set(fila)];
  return impl.nome === 'gemini' ? unica : unica.slice(0, MAX_MODELOS_POR_PROVEDOR);
}

/** "models/gemini-2.5-flash-lite" -> "gemini-2.5-flash-lite": o prefixo so ocupa espaco na tela. */
function nomeCurto(modelo) {
  return String(modelo ?? '').replace(/^models\//, '');
}

/** A fila de tentativas em uma linha, para o painel: "gemini[a +2] › groq[b +3]". */
function descreverFila(lista) {
  return lista
    .map((p) => {
      const [primeiro, ...resto] = p.modelos;
      return `${p.provedor ?? p.impl?.nome}[${nomeCurto(primeiro)}${resto.length ? ` +${resto.length}` : ''}]`;
    })
    .join(' › ');
}

/**
 * Mostra no painel como esta a cascata da empresa: quem e o primario, quem e
 * reserva e qual modelo cada um tentaria primeiro. Chamado quando o servidor
 * sobe. Nunca lanca: e enfeite de terminal.
 */
export async function anunciarCascata(tenantId) {
  try {
    const lista = await provedoresAtivos(tenantId);
    if (lista.length === 0) {
      ver('aviso', 'Nenhum provedor de IA ligado', 'cadastre uma chave em Inteligencia Artificial → Cascata');
      return;
    }
    lista.forEach((p, i) => {
      ver(
        'cascata',
        `${i === 0 ? negrito('primario') : 'reserva '} ${negrito(p.provedor)}`,
        `modelos: ${p.modelos.map(nomeCurto).join(' › ')}`
      );
    });
  } catch {
    // Sem banco ou sem chave: o painel simplesmente nao mostra a cascata.
  }
}

/** Lista os provedores da empresa, prontos para uso, em ordem de prioridade. */
export async function provedoresAtivos(tenantId) {
  const linhas = await db
    .select()
    .from(aiProviders)
    .where(and(eq(aiProviders.tenantId, tenantId), eq(aiProviders.habilitado, true)))
    .orderBy(asc(aiProviders.prioridade));

  const prontos = [];

  for (const linha of linhas) {
    const impl = PROVEDORES[linha.provedor];
    if (!impl) continue;

    const apiKey = linha.apiKeyCifrada ? decifrar(linha.apiKeyCifrada) : null;

    // Provedor que exige chave e nao tem (ou cuja chave nao decifra, porque o
    // APP_SECRET mudou) e simplesmente pulado — nao adianta tentar.
    if (impl.precisaChave !== false && !apiKey) continue;

    prontos.push({
      provedor: linha.provedor,
      impl,
      apiKey,
      baseUrl: linha.baseUrl,
      modelos: montarFilaDeModelos(linha, impl)
    });
  }

  return prontos;
}

/**
 * Poe o modelo preferido de um agente na frente da cascata.
 *
 * `modeloPreferido` e "provedor:modelo" (ex.: "groq:qwen/qwen3.8-27b"; o
 * modelo pode ter ":" no nome, como no Ollama — so o primeiro separa). Ele
 * vira a primeira tentativa, e o resto da cascata continua atras como
 * reserva: escolher um modelo nao pode fazer a campanha parar quando ele
 * estiver fora do ar. Provedor desligado ou sem chave: o preferido e ignorado.
 */
export function priorizarModelo(lista, modeloPreferido) {
  if (!modeloPreferido) return lista;
  const i = modeloPreferido.indexOf(':');
  if (i <= 0) return lista;
  const nomeProvedor = modeloPreferido.slice(0, i);
  const modelo = modeloPreferido.slice(i + 1);

  const alvo = lista.find((p) => (p.provedor ?? p.impl?.nome) === nomeProvedor);
  if (!alvo || !modelo) return lista;

  return [
    { ...alvo, modelos: [modelo, ...alvo.modelos.filter((m) => m !== modelo)] },
    ...lista.filter((p) => p !== alvo)
  ];
}

/**
 * Gera uma resposta, percorrendo a cascata.
 *
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} p.origem            'atendimento' | 'campanha' | 'humor' | 'teste'
 * @param {string} [p.systemPrompt]
 * @param {import('./providers/base.js').Mensagem[]} p.mensagens
 * @param {object[]} [p.ferramentas]
 * @param {number} [p.temperatura]
 * @param {number} [p.maxTokens]
 * @param {string} [p.conversationId]
 * @param {string} [p.agentKey]
 * @param {object[]} [p.provedores]    injetado nos testes, no lugar do banco
 * @param {string} [p.modeloPreferido] "provedor:modelo" tentado antes da cascata
 * @param {boolean} [p.exigirRespostaCompleta] recusa texto cortado no meio (ver abaixo)
 */
export async function gerar({
  tenantId,
  origem = 'atendimento',
  systemPrompt,
  mensagens,
  ferramentas,
  temperatura = 0.7,
  maxTokens = 800,
  timeoutMs = 20_000,
  conversationId = null,
  agentKey = null,
  provedores = null,
  modeloPreferido = null,
  /**
   * Liga a recusa de resposta truncada. Fica DESLIGADO por padrao porque
   * varias chamadas internas pedem de proposito uma resposta de uma palavra
   * — classificar a resposta de uma campanha ("RECUSA"), testar se um modelo
   * responde ("funcionando"), relatar da Atena para a Sofia ("ok") — e para
   * elas um fragmento e a resposta certa.
   *
   * Liga quem escreve o texto que o CLIENTE le: a Sofia e o Aquiles.
   */
  exigirRespostaCompleta = false
}) {
  const lista = priorizarModelo(provedores ?? (await provedoresAtivos(tenantId)), modeloPreferido);

  if (lista.length === 0) {
    throw new ServicoIndisponivel(
      'Nenhum provedor de IA configurado. Cadastre uma chave na Central de Inteligência Artificial (aba Cascata de IA & Provedores).'
    );
  }

  const tentativas = [];
  const inicioGeral = Date.now();

  const { ator: atorDaChamada, nome: nomeDaChamada } = nomeDoAgente(agentKey, origem);
  const quem = colorir(atorDaChamada, nomeDaChamada);
  ver('cascata', `${quem} pediu uma resposta`, `fila: ${descreverFila(lista)}`);

  for (const provedor of lista) {
    let pularProvedor = false;

    for (const modelo of provedor.modelos) {
      /**
       * Uma resposta truncada e azar de sorteio, nao defeito do modelo: o
       * mesmo modelo ganha uma segunda chance antes de a cascata descer um
       * degrau. Sem isso, um tropeco de vez em quando tiraria da frente
       * justamente o modelo que a empresa escolheu como primario.
       */
      const chances = exigirRespostaCompleta ? 2 : 1;

      for (let chance = 1; chance <= chances; chance++) {
        const inicio = Date.now();

        try {
          const resposta = await provedor.impl.gerar({
            apiKey: provedor.apiKey,
            baseUrl: provedor.baseUrl,
            modelo,
            systemPrompt,
            mensagens,
            ferramentas,
            temperatura,
            maxTokens,
            timeoutMs
          });

          /**
           * Texto pela metade vale como falha — nunca como resposta.
           *
           * Chamada de ferramenta fica de fora: ali o texto costuma vir vazio
           * ou curto de proposito, e quem responde ao cliente e a volta
           * seguinte do laco, com o resultado da ferramenta em maos.
           */
          if (
            exigirRespostaCompleta &&
            !resposta.chamadasDeFerramenta?.length &&
            pareceIncompleta(resposta.texto, resposta.motivoParada)
          ) {
            throw new ErroDeProvedor(
              `Resposta interrompida no meio: ${JSON.stringify(String(resposta.texto ?? '').slice(0, 40))}`,
              { provedor: provedor.impl.nome, modelo, reTentavel: true, truncada: true }
            );
          }

          const latenciaMs = Date.now() - inicio;

          await registrarChamada({
            tenantId,
            origem,
            agentKey,
            conversationId,
            provedor: provedor.impl.nome,
            modelo,
            sucesso: true,
            latenciaMs,
            tokens: resposta.tokens,
            tentativas
          });

          log.info(
            { provedor: provedor.impl.nome, modelo, latenciaMs, tentativasAntes: tentativas.length },
            'IA respondeu'
          );

          ver(
            'cascata',
            `${quem} ${fg(46, '✓')} ${negrito(`${provedor.impl.nome}/${nomeCurto(modelo)}`)}${
              tentativas.length ? fg(214, `  (desceu na cascata: ${tentativas.length} falha(s) antes)`) : ''
            }`,
            `${latenciaMs}ms · ${resposta.tokens?.entrada ?? 0}→${resposta.tokens?.saida ?? 0} tokens${
              resposta.chamadasDeFerramenta?.length ? ' · pediu ferramenta' : ''
            }`
          );

          return { ...resposta, provedor: provedor.impl.nome, modelo, latenciaMs, tentativas };
        } catch (err) {
          const latenciaMs = Date.now() - inicio;
          tentativas.push({
            provedor: provedor.impl.nome,
            modelo,
            erro: err.message,
            latenciaMs
          });

          log.warn({ provedor: provedor.impl.nome, modelo, erro: err.message }, 'Provedor de IA falhou');

          const temChance = err.truncada && chance < chances;
          ver(
            'cascata',
            `${quem} ${fg(196, '✗')} ${negrito(`${provedor.impl.nome}/${nomeCurto(modelo)}`)}  ${resumir(err.message, 90)}`,
            `${latenciaMs}ms · ${temChance ? 'tentando de novo o mesmo modelo' : 'passando para o proximo'}`
          );

          // Ainda ha chance sobrando para este mesmo modelo: tenta de novo.
          if (temChance) continue;

          // Falha estrutural (chave invalida, conta bloqueada): os outros
          // modelos do mesmo provedor vao falhar igual. Pula o provedor inteiro.
          // Exceto quando so o MODELO e o problema (aposentado): tenta o proximo.
          if (err.reTentavel === false && !err.doModelo) pularProvedor = true;
          break;
        }
      }

      if (pularProvedor) break;
    }
  }

  ver('erro', `${quem} ficou sem resposta: nenhum provedor da cascata conseguiu responder`, `${Date.now() - inicioGeral}ms`);

  await registrarChamada({
    tenantId,
    origem,
    agentKey,
    conversationId,
    provedor: 'nenhum',
    modelo: 'nenhum',
    sucesso: false,
    latenciaMs: Date.now() - inicioGeral,
    tokens: { entrada: 0, saida: 0 },
    tentativas,
    erro: tentativas.at(-1)?.erro ?? 'Sem provedores utilizaveis'
  });

  /**
   * Aqui NAO devolvemos um texto pronto fingindo sucesso.
   *
   * O sistema antigo, quando tudo falhava, respondia ao cliente com
   * "Olá! Sou a assistente virtual da barbearia/clínica..." — uma saudacao
   * generica que podia cair no meio de uma negociacao de horario. Quem
   * chama e que sabe o que fazer: o atendimento manda a conversa pra fila
   * humana, uma campanha adia o disparo.
   */
  throw new ServicoIndisponivel('Nenhum provedor de IA conseguiu responder.', { tentativas });
}

/** Grava o registro da chamada. Falha aqui nunca derruba o atendimento. */
async function registrarChamada({ tenantId, origem, agentKey, conversationId, provedor, modelo, sucesso, latenciaMs, tokens, tentativas, erro }) {
  try {
    await db.insert(aiCalls).values({
      id: ID.provedorIa().replace('aip', 'call'),
      tenantId,
      origem,
      agentKey,
      conversationId,
      provedor,
      modelo,
      sucesso,
      latenciaMs,
      tokensEntrada: tokens?.entrada ?? 0,
      tokensSaida: tokens?.saida ?? 0,
      tentativas: tentativas ?? [],
      erro: erro ?? null
    });
  } catch (err) {
    log.error({ err }, 'Falha ao registrar chamada de IA');
  }
}

export { PROVEDORES };
