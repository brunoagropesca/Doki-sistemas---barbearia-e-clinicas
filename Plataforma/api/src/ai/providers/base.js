import { ServicoIndisponivel } from '../../core/errors.js';

/**
 * Contrato dos provedores de IA.
 *
 * No sistema antigo, a "cascata" era uma funcao de 200 linhas com um bloco
 * `if` por provedor, cada um montando o corpo da requisicao inline. Adicionar
 * a Anthropic significaria copiar um bloco e mexer no meio de codigo que ja
 * funcionava.
 *
 * Aqui todo provedor implementa a MESMA funcao:
 *
 *   gerar({ systemPrompt, mensagens, ferramentas, temperatura, maxTokens, timeoutMs })
 *     -> { texto, chamadasDeFerramenta, tokens, modelo }
 *
 * Adicionar um provedor novo e criar um arquivo e registrar. A cascata nao
 * muda uma linha.
 */

/**
 * @typedef {object} Mensagem
 * @property {'user'|'assistant'|'tool'} papel
 * @property {string} conteudo
 * @property {string} [ferramentaNome]  quando papel === 'tool'
 *
 * @typedef {object} ChamadaDeFerramenta
 * @property {string} nome
 * @property {object} argumentos
 *
 * @typedef {object} RespostaIa
 * @property {string} texto
 * @property {ChamadaDeFerramenta[]} chamadasDeFerramenta
 * @property {{ entrada: number, saida: number }} tokens
 * @property {string} modelo
 */

/**
 * Erro de provedor, com a informacao que a cascata precisa para decidir.
 *
 * `reTentavel` e a distincao que importa: cota estourada ou servidor fora do ar
 * significam "tente o proximo provedor". Chave invalida ou prompt malformado
 * significam "tentar de novo nao vai ajudar" — e a cascata para de perder tempo.
 */
export class ErroDeProvedor extends Error {
  constructor(mensagem, { provedor, modelo, status, reTentavel = true, doModelo = false, truncada = false, cause } = {}) {
    super(mensagem, { cause });
    this.name = 'ErroDeProvedor';
    this.provedor = provedor;
    this.modelo = modelo;
    this.status = status;
    this.reTentavel = reTentavel;
    // O problema e SO deste modelo (aposentado, sem acesso): os outros modelos
    // do mesmo provedor podem funcionar, entao a cascata tenta o proximo.
    this.doModelo = doModelo;
    // A chamada deu certo, mas o texto veio pela metade. Nao e defeito do
    // modelo nem do provedor: e um sorteio infeliz, e tentar de novo resolve.
    this.truncada = truncada;
  }
}

/** 404 ou corpo dizendo que o modelo nao existe/foi aposentado/nao tem acesso. */
export function erroEDoModelo(status, texto = '') {
  if (status === 404) return true;
  return status >= 400 && status < 500 && /model_not_found|does not exist|decommissioned|no access|not supported/i.test(texto);
}

/** Decide se vale a pena tentar outro modelo do MESMO provedor. */
export function statusEhReTentavel(status) {
  // 429 = cota/limite; 5xx = problema do lado deles. Ambos passam com outro
  // modelo ou outro provedor.
  if (status === 429) return true;
  if (status >= 500) return true;
  // 400/401/403 = nossa culpa (chave errada, payload invalido). Insistir so
  // gasta tempo e, no caso de 401, pode travar a conta.
  return false;
}

/**
 * Faz a chamada HTTP com timeout obrigatorio.
 *
 * Sem timeout, uma unica chamada travada segura o atendimento do cliente
 * para sempre — o `fetch` do Node nao desiste sozinho. O sistema antigo
 * tinha timeout so em algumas chamadas.
 */
export async function requisitar(url, { corpo, cabecalhos = {}, timeoutMs = 20_000, provedor, modelo }) {
  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cabecalhos },
      body: JSON.stringify(corpo),
      signal: controle.signal
    });

    if (!res.ok) {
      const texto = await res.text().catch(() => '');
      throw new ErroDeProvedor(`HTTP ${res.status}: ${texto.slice(0, 200)}`, {
        provedor,
        modelo,
        status: res.status,
        reTentavel: statusEhReTentavel(res.status),
        doModelo: erroEDoModelo(res.status, texto)
      });
    }

    return await res.json();
  } catch (err) {
    if (err instanceof ErroDeProvedor) throw err;

    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new ErroDeProvedor(`Sem resposta em ${timeoutMs}ms`, {
        provedor,
        modelo,
        reTentavel: true,
        cause: err
      });
    }

    // Falha de rede, DNS, certificado.
    throw new ErroDeProvedor(`Falha de conexao: ${err.message}`, {
      provedor,
      modelo,
      reTentavel: true,
      cause: err
    });
  } finally {
    clearTimeout(prazo);
  }
}

/** Garante que o provedor devolveu algo utilizavel. */
export function exigirConteudo(resposta, { provedor, modelo }) {
  const temTexto = Boolean(resposta?.texto?.trim());
  const temFerramenta = resposta?.chamadasDeFerramenta?.length > 0;

  if (!temTexto && !temFerramenta) {
    throw new ErroDeProvedor('Resposta vazia', { provedor, modelo, reTentavel: true });
  }
  return resposta;
}

/**
 * Tamanho ate o qual um texto sem fim de frase e suspeito.
 *
 * Acima disso a resposta ja diz alguma coisa, e modelo que esquece o ponto
 * final no fim de uma frase inteira e comum demais para tratarmos como defeito.
 */
const FRAGMENTO_MAX = 25;

/**
 * O que conta como "a frase terminou": pontuacao final, fechamento de aspas ou
 * parenteses, ou um emoji — que no WhatsApp faz as vezes de ponto final.
 *
 * Virgula e dois-pontos NAO entram: "Claro," e "Segue:" sao exatamente o tipo
 * de pedaco que queremos pegar.
 */
const FIM_DE_FRASE = /[.!?…)\]}"'’”»\p{Extended_Pictographic}]$/u;

/** Acentos de emoji que ficam SOBRANDO no fim: seletor de estilo, ZWJ, tom de pele. */
const ENFEITE_DE_EMOJI = /[︎️‍\u{1F3FB}-\u{1F3FF}]+$/u;

/**
 * A resposta parou no meio?
 *
 * Dois sintomas diferentes, com a mesma consequencia para quem le:
 *
 *  - `motivoParada === 'limite'`: o modelo bateu no teto de tokens. E o corte
 *    classico, e vale para texto de qualquer tamanho. Em modelo que "pensa"
 *    antes de responder, o pensamento consome esse teto.
 *  - Um fragmento curto que nao fecha frase. Alguns modelos emitem um
 *    fim-de-texto espurio depois de dois ou tres tokens e o provedor relata
 *    parada NORMAL — nao ha bandeira nenhuma para conferir. Foi assim que a
 *    Sofia respondeu "C" e "Claro, Déb" a uma cliente.
 *
 * Resposta curta de verdade ("Oi, Débora! 😊", "Combinado! ✂️") fecha com
 * pontuacao ou emoji, e por isso passa.
 */
export function pareceIncompleta(texto, motivoParada) {
  if (motivoParada === 'limite') return true;

  const limpo = String(texto ?? '').trim().replace(ENFEITE_DE_EMOJI, '');
  if (!limpo || limpo.length > FRAGMENTO_MAX) return false;

  return !FIM_DE_FRASE.test(limpo);
}

export { ServicoIndisponivel };
