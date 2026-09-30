import pino from 'pino';
import { env, isTest } from '../config/env.js';
import { painelAtivo } from './painel.js';

/**
 * Log da aplicacao.
 *
 * O sistema antigo usava `console.log` com codigos de cor escritos na mao
 * (`\x1b[36m`) espalhados por doze arquivos. Aquilo e bonito no terminal e
 * inutil em qualquer outro lugar: nao da pra filtrar por gravidade, nao da
 * pra buscar por cliente, e se um dia rodar num servidor os codigos de cor
 * viram lixo no meio do arquivo de log.
 *
 * Aqui o log e estruturado (JSON). Com LOG_PRETTY (o padrao) o `pino-pretty`
 * deixa ele colorido e legivel — inclusive na loja, onde quem le a janela e
 * uma pessoa. Num servidor com ferramenta de monitoramento, LOG_PRETTY=false
 * devolve JSON puro.
 *
 * REGRA DE PRIVACIDADE: `redact` abaixo apaga automaticamente senhas, tokens e
 * chaves de API antes de escrever. Isso e uma rede de seguranca — nao uma
 * autorizacao pra logar dado sensivel de proposito.
 */

const transport =
  env.LOG_PRETTY && !isTest
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
          messageFormat: '{msg}'
        }
      }
    : undefined;

/**
 * Com o painel ligado, o log so mostra o que exige atencao (avisos e erros).
 * O que era "info" ja aparece la, colorido e em uma linha; deixar os dois
 * falando faria cada acao sair duas vezes. Quem quiser tudo de volta usa
 * LOG_LEVEL=debug, ou PAINEL_ATIVO=false.
 */
const nivel = painelAtivo && env.LOG_LEVEL === 'info' ? 'warn' : env.LOG_LEVEL;

export const logger = pino({
  level: isTest ? 'silent' : nivel,
  transport,
  redact: {
    paths: [
      'password',
      'senha',
      'passwordHash',
      'password_hash',
      'token',
      'apiKey',
      'api_key',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.senha',
      '*.apiKey',
      '*.api_key',
      '*.token'
    ],
    censor: '[oculto]'
  },
  base: undefined // sem pid/hostname poluindo cada linha
});

/**
 * Cria um log "filho" que carrega contexto fixo em toda linha.
 *
 * Exemplo: `const log = comContexto({ modulo: 'campanhas', tenantId })`
 * A partir dai, todo `log.info(...)` ja sai marcado com o modulo e a empresa,
 * e voce consegue filtrar o log de UM cliente especifico.
 */
export function comContexto(contexto) {
  return logger.child(contexto);
}
