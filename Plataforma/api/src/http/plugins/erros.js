import { ZodError } from 'zod';
import {
  AppError,
  deZodError,
  ehViolacaoDeChaveEstrangeira,
  ehViolacaoDeUnicidade
} from '../../core/errors.js';
import { env } from '../../config/env.js';

/**
 * Tratamento central de erros.
 *
 * Sem isto, cada rota repete o mesmo `try/catch` — e basta uma esquecer pra
 * derrubar o processo inteiro. Era o que acontecia no sistema antigo, que
 * precisava de dois `process.on('uncaughtException')` no topo do servidor
 * so pra nao morrer.
 *
 * A regra de ouro: erro PREVISTO fala com o usuario; erro IMPREVISTO fala
 * com o log. O usuario nunca ve nome de coluna, SQL ou pilha de execucao —
 * isso e presente de bandeja pra quem esta sondando o sistema.
 */
export function registrarTratamentoDeErros(app) {
  app.setErrorHandler((erro, req, res) => {
    // 1. Erro de validacao do Zod (dados que o usuario mandou).
    if (erro instanceof ZodError) {
      const e = deZodError(erro);
      req.log.info({ campos: e.details }, 'Requisicao recusada na validacao');
      return res.status(e.status).send({
        erro: { codigo: e.code, mensagem: e.message, detalhes: e.details }
      });
    }

    // 2. Erro que nos mesmos levantamos de proposito.
    if (erro instanceof AppError) {
      // 4xx e o usuario errando; 5xx e o sistema falhando. Gravidade diferente.
      const nivel = erro.status >= 500 ? 'error' : 'info';
      req.log[nivel]({ err: erro, codigo: erro.code }, erro.message);
      return res.status(erro.status).send({
        erro: { codigo: erro.code, mensagem: erro.message, detalhes: erro.details }
      });
    }

    // 3. Corpo da requisicao que nao era JSON valido.
    if (erro.statusCode === 400 && erro.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return res.status(400).send({
        erro: { codigo: 'CORPO_INVALIDO', mensagem: 'O corpo da requisicao precisa ser JSON.' }
      });
    }
    if (erro.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || erro instanceof SyntaxError) {
      return res.status(400).send({
        erro: { codigo: 'CORPO_INVALIDO', mensagem: 'JSON mal formado no corpo da requisicao.' }
      });
    }

    // 4. Violacao de restricao do banco — traduzimos pra linguagem de gente.
    // A checagem percorre a cadeia de causas: o Drizzle embrulha o erro do
    // SQLite, entao a mensagem util nao esta em `erro.message`.
    if (ehViolacaoDeUnicidade(erro)) {
      req.log.warn({ err: erro }, 'Violacao de unicidade no banco');
      return res.status(409).send({
        erro: {
          codigo: 'CONFLITO',
          mensagem: 'Já existe um registro com esses dados.'
        }
      });
    }
    if (ehViolacaoDeChaveEstrangeira(erro)) {
      req.log.warn({ err: erro }, 'Violacao de chave estrangeira');
      return res.status(409).send({
        erro: {
          codigo: 'REFERENCIA_INVALIDA',
          mensagem: 'A operacao aponta para um registro que nao existe ou nao pode ser removido.'
        }
      });
    }

    // 5. Qualquer outra coisa e bug nosso. Log completo, resposta generica.
    req.log.error({ err: erro, url: req.url, metodo: req.method }, 'Erro nao tratado');

    return res.status(500).send({
      erro: {
        codigo: 'ERRO_INTERNO',
        mensagem: 'Algo deu errado do nosso lado. A equipe foi notificada.',
        // So em DESENVOLVIMENTO devolvemos o detalhe (facilita a vida de quem
        // programa). Na loja (producao), nunca: o stack trace mostra caminhos
        // de arquivo e trechos do codigo para quem estiver no navegador. Lido
        // na hora (e nao no import) para os testes conferirem os dois lados.
        ...(env.NODE_ENV === 'development' ? { debug: erro.message, stack: erro.stack?.split('\n').slice(0, 5) } : {})
      }
    });
  });

  /** Rota inexistente — resposta consistente com o resto da API. */
  app.setNotFoundHandler((req, res) => {
    res.status(404).send({
      erro: {
        codigo: 'ROTA_NAO_ENCONTRADA',
        mensagem: `Nao existe ${req.method} ${req.url} nesta API.`
      }
    });
  });
}
