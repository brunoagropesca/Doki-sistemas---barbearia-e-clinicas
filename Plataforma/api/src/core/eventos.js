import { comContexto } from './logger.js';

const log = comContexto({ modulo: 'eventos' });

/**
 * Barramento de eventos do sistema.
 *
 * Existe para desacoplar QUEM FAZ de QUEM REAGE. Quando uma conversa e
 * finalizada, o servico de conversas nao precisa saber que a tela deve
 * atualizar, que o quadro tem de tirar o cartao ou que a Atena vai escrever um
 * resumo: ele anuncia `conversa.mudou` e cada interessado se inscreve.
 *
 * Dois tipos de interessado:
 *
 *   - AUTOMACOES (`ouvir`): codigo do servidor, como o piloto da Atena. Rodam
 *     em segundo plano, depois da resposta ja ter saido — uma automacao lenta
 *     ou quebrada nunca atrasa nem derruba a acao que a disparou.
 *
 *   - TELAS (`assinar`): conexoes SSE abertas no navegador. Recebem so o
 *     recado "isto mudou", nunca os dados: a tela busca de novo pela API de
 *     sempre, que ja aplica permissao e empresa. Assim nenhum dado sensivel
 *     trafega pelo canal de eventos.
 *
 * Tudo e em memoria, num processo so. Se um dia houver varios servidores, este
 * e o unico arquivo a trocar (por Redis ou similar): quem emite e quem ouve
 * continuam iguais.
 */

/** Tipos conhecidos — ninguem inventa um evento sem registrar aqui. */
export const EVENTOS = {
  /** Algo na conversa mudou: mensagem, etapa, humor, status, finalizacao. */
  CONVERSA: 'conversa.mudou',
  /** Algo na agenda mudou: OS criada, remarcada, com novo status... */
  AGENDA: 'agenda.mudou',
  /** Uma ferramenta da Atena executou com sucesso (alimenta o funil). */
  ATENA_FERRAMENTA: 'atena.ferramenta',
  /** A gerencia mandou um aviso. Emitido com `userId`: so a tela do destinatario recebe. */
  AVISO: 'aviso.novo',
  /** Notificacao de encaminhamento criada (com `userId`) ou fechada (para a empresa toda). */
  NOTIFICACAO: 'notificacao.mudou'
};

/**
 * Espera antes de avisar as telas.
 *
 * Duas razoes. (1) Coalescer: cinco mensagens em rajada viram UMA atualizacao
 * de tela, nao cinco. (2) Ordem: quem emite pode estar no meio de uma
 * transacao; avisar a tela no mesmo instante a faria ler antes do commit e
 * mostrar o estado antigo — o exato defeito que o aviso existe para curar.
 */
const ESPERA_TELAS_MS = 80;
const pendentes = new Map(); // "tenant:pessoa:tipo" -> timer

const ouvintes = new Map(); // tipo -> Set<fn>
const assinantes = new Set(); // { tenantId, userId, enviar }

/**
 * Inscreve uma automacao. Devolve a funcao que cancela a inscricao.
 *
 * @param {string} tipo
 * @param {(dados: object) => Promise<void>|void} fn
 */
export function ouvir(tipo, fn) {
  if (!ouvintes.has(tipo)) ouvintes.set(tipo, new Set());
  ouvintes.get(tipo).add(fn);
  return () => ouvintes.get(tipo)?.delete(fn);
}

/**
 * Anuncia um evento.
 *
 * Nao espera ninguem e nunca lanca: quem emite esta no meio de uma operacao
 * de negocio e nao pode falhar porque um ouvinte falhou.
 *
 * Com `dados.userId`, o aviso as telas vai so para as conexoes dessa pessoa.
 *
 * @param {string} tipo
 * @param {{tenantId: string, userId?: string} & Record<string, unknown>} dados
 */
export function emitir(tipo, dados) {
  avisarTelas(tipo, dados);

  // Automacoes: em segundo plano, cada uma isolada das outras.
  const fila = ouvintes.get(tipo);
  if (!fila?.size) return;

  setImmediate(() => {
    for (const fn of fila) {
      Promise.resolve()
        .then(() => fn(dados))
        .catch((err) => log.warn({ err, tipo }, 'Automacao falhou; o atendimento segue normal'));
    }
  });
}

function avisarTelas(tipo, dados) {
  if (assinantes.size === 0) return;

  const destinatario = dados.userId ?? null;
  const chave = `${dados.tenantId}:${destinatario ?? '*'}:${tipo}`;
  if (pendentes.has(chave)) return; // ja ha um aviso a caminho: ele cobre este

  const timer = setTimeout(() => {
    pendentes.delete(chave);
    for (const a of assinantes) {
      if (a.tenantId !== dados.tenantId) continue;
      if (destinatario && a.userId !== destinatario) continue;
      try {
        a.enviar({ tipo });
      } catch (err) {
        log.debug({ err }, 'Assinante SSE indisponivel; removendo');
        assinantes.delete(a);
      }
    }
  }, ESPERA_TELAS_MS);
  timer.unref?.();
  pendentes.set(chave, timer);
}

/**
 * Registra uma tela conectada. Devolve a funcao que a desconecta.
 * Chamado pela rota SSE. `userId` e de quem abriu a tela: sem ele, a conexao
 * nao recebe os eventos enderecados a uma pessoa.
 */
export function assinar(tenantId, enviar, { userId = null } = {}) {
  const assinante = { tenantId, userId, enviar };
  assinantes.add(assinante);
  return () => assinantes.delete(assinante);
}

/** So para testes: quantas telas estao conectadas. */
export function totalAssinantes() {
  return assinantes.size;
}

/**
 * So para testes: espera as automacoes ja disparadas terminarem.
 * `setImmediate` + um tick basta porque `emitir` agenda tudo no mesmo ciclo.
 */
export function aguardarAutomacoes() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}
