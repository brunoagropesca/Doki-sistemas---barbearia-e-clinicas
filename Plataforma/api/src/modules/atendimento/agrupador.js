import { comContexto } from '../../core/logger.js';

const log = comContexto({ modulo: 'agrupador' });

/**
 * Agrupador de mensagens picotadas.
 *
 * O cliente no WhatsApp escreve assim:
 *     "oi"
 *     "tudo bem?"
 *     "queria marcar um horario"
 *     "pra amanha de tarde"
 *
 * Sao quatro mensagens em seis segundos. Sem agrupar, a IA e acionada quatro
 * vezes: custa quatro chamadas, e as tres primeiras respondem sem saber o que
 * o cliente realmente queria — ele recebe "Oi! Tudo bem?" enquanto ainda esta
 * digitando o pedido.
 *
 * Aqui esperamos um tempinho apos a ultima mensagem. Se outra chegar, o
 * relogio reinicia. So quando o cliente para de digitar e que processamos
 * tudo junto, como um pedido unico.
 *
 * DIFERENCA PARA O SISTEMA ANTIGO: la, o agrupador devolvia a mesma resposta
 * para TODAS as chamadas em espera, e quem chamou precisava conferir uma flag
 * `isBatchLeader` para saber se devia enviar ou descartar. Quem esquecesse a
 * conferencia mandava a mesma resposta quatro vezes. Aqui, quem nao e o ultimo
 * simplesmente nao recebe nada para enviar — o erro deixou de ser possivel.
 */
export class Agrupador {
  constructor({ janelaMs = 8000, tempoMaximoMs = 30_000 } = {}) {
    this.janelaMs = janelaMs;
    /**
     * Teto absoluto de espera. Sem ele, um cliente que digita sem parar
     * nunca seria atendido: cada mensagem reiniciaria o relogio pra sempre.
     */
    this.tempoMaximoMs = tempoMaximoMs;
    this.buffers = new Map();
  }

  /**
   * Enfileira uma mensagem.
   *
   * @returns {Promise<{ processar: false } | { processar: true, texto: string, quantidade: number }>}
   *   `processar: false` significa "outra mensagem chegou depois desta; ela
   *   cuida do lote". Quem recebe isso nao faz nada — e nao ha flag pra
   *   esquecer de checar.
   */
  enfileirar(chave, texto) {
    // Janela zero desliga o agrupamento (util em teste e em quem prefere
    // resposta imediata).
    if (this.janelaMs <= 0) {
      return Promise.resolve({ processar: true, texto, quantidade: 1 });
    }

    return new Promise((resolver) => {
      let buffer = this.buffers.get(chave);

      if (!buffer) {
        buffer = { mensagens: [], aguardando: [], primeiraEm: Date.now(), timer: null };
        this.buffers.set(chave, buffer);
      }

      buffer.mensagens.push(texto);
      buffer.aguardando.push(resolver);

      clearTimeout(buffer.timer);

      const jaEsperou = Date.now() - buffer.primeiraEm;
      const restante = Math.max(0, Math.min(this.janelaMs, this.tempoMaximoMs - jaEsperou));

      buffer.timer = setTimeout(() => this.#liberar(chave), restante);
    });
  }

  #liberar(chave) {
    const buffer = this.buffers.get(chave);
    if (!buffer) return;

    this.buffers.delete(chave);
    clearTimeout(buffer.timer);

    const texto = buffer.mensagens.join('\n');
    const quantidade = buffer.mensagens.length;

    if (quantidade > 1) {
      log.debug({ chave, quantidade }, 'Mensagens picotadas agrupadas em um unico turno');
    }

    // Só o ULTIMO da fila recebe o lote para processar. Os demais recebem
    // "nao faca nada" — impossivel responder em duplicidade por engano.
    buffer.aguardando.forEach((resolver, i) => {
      const ehOUltimo = i === buffer.aguardando.length - 1;
      resolver(ehOUltimo ? { processar: true, texto, quantidade } : { processar: false });
    });
  }

  /** Libera tudo que estiver esperando. Usado no desligamento e nos testes. */
  liberarTudo() {
    for (const chave of [...this.buffers.keys()]) this.#liberar(chave);
  }

  get pendentes() {
    return this.buffers.size;
  }
}
