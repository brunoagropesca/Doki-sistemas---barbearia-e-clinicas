import { z } from 'zod';
import { assinar } from '../core/eventos.js';
import { apenas } from '../http/plugins/autenticacao.js';
import { executarComando } from './comando.js';

const comandoSchema = z.object({
  conversationId: z.string().min(1, 'Informe a conversa.'),
  comando: z.string().trim().min(1, 'Diga o que a Atena deve fazer.').max(500)
});

/** Conexoes de tempo real abertas, para fecha-las junto com o servidor. */
const conexoes = new Set();

export async function rotasAutomacao(app) {
  /**
   * GET /api/eventos — canal de tempo real (Server-Sent Events).
   *
   * A tela abre UMA conexao e recebe so o recado "isto mudou" (conversa,
   * agenda). Nao trafega dado nenhum: a tela busca de novo pela API de sempre,
   * que ja aplica empresa e permissao. Assim este canal nao precisa repetir
   * nenhuma regra de seguranca — nao ha o que vazar por ele.
   *
   * SSE em vez de WebSocket porque o fluxo e de um lado so (servidor ->
   * tela), o navegador reconecta sozinho e passa por qualquer proxy HTTP.
   */
  app.get('/api/eventos', { config: apenas.atendente }, (req, res) => {
    // Assume o controle da resposta: o Fastify nao deve fechar nem serializar.
    res.hijack();
    const raw = res.raw;

    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies como o nginx seguram a resposta ate encher um buffer: sem
      // isto os avisos chegariam em bloco, minutos depois.
      'x-accel-buffering': 'no'
    });
    // Reconexao automatica em 3 s se a conexao cair.
    raw.write('retry: 3000\n: conectado\n\n');

    const desassinar = assinar(
      req.tenantId,
      ({ tipo }) => {
        raw.write(`event: ${tipo}\ndata: {}\n\n`);
      },
      { userId: req.usuario.id }
    );

    // Comentario a cada 25 s: mantem a conexao viva atras de proxies que
    // derrubam conexao muda, e revela cliente que sumiu (a escrita falha).
    const batida = setInterval(() => {
      try {
        raw.write(': ping\n\n');
      } catch {
        limpar();
      }
    }, 25_000);
    batida.unref?.();

    conexoes.add(raw);

    function limpar() {
      clearInterval(batida);
      desassinar();
      conexoes.delete(raw);
    }

    req.raw.on('close', limpar);
  });

  /**
   * POST /api/atena/comando — o atendente manda a Atena fazer algo.
   * Mesmo caminho e mesmas travas da Sofia; ver `comando.js`.
   */
  app.post('/api/atena/comando', { config: apenas.atendente }, async (req) => {
    const { conversationId, comando } = comandoSchema.parse(req.body);
    return executarComando({ tenantId: req.tenantId, conversationId, comando, usuario: req.usuario });
  });

  // Sem isto, `app.close()` esperaria para sempre por conexoes SSE abertas.
  app.addHook('onClose', async () => {
    for (const raw of conexoes) {
      try {
        raw.end();
      } catch {
        // ja fechada
      }
    }
    conexoes.clear();
  });
}
