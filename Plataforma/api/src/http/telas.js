import { existsSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import { env } from '../config/env.js';

/**
 * As telas compiladas (web/dist), servidas pela propria API — o modo LOJA.
 *
 * Antes, na maquina do cliente, as telas vinham do servidor de
 * DESENVOLVIMENTO do Vite (codigo-fonte, recarga automatica, aberto para a
 * rede no INICIAR-NA-REDE). Agora a API serve o que o `vite build` gerou: um
 * endereco so, sem proxy, sem o Vite rodando.
 *
 * Como funciona:
 *   - arquivo que existe em web/dist → o arquivo;
 *   - qualquer outro GET que nao seja /api → index.html (quem decide a tela e
 *     o React Router: /agenda, /conversas/123...);
 *   - /api/... que nao existe → o 404 em JSON de sempre.
 *
 * Por que a rota e nossa (e nao a do @fastify/static): o plugin de
 * autenticacao exige login em TODA rota. Os arquivos das telas precisam ser
 * publicos — inclusive os da propria tela de login. O plugin fica so para
 * ENVIAR o arquivo (`serve: false`).
 *
 * Cache:
 *   - /assets/* (nome com hash, muda a cada build) → 1 ano, imutavel;
 *   - index.html, sw.js, manifest, offline.html → sem cache: uma atualizacao
 *     do sistema precisa chegar no proximo carregamento;
 *   - o resto (icones) → 1 dia.
 */

const SEM_CACHE = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'offline.html']);

/** A pasta existe e tem um build de verdade? Sem ela (desenvolvimento), nao servimos telas. */
export function haTelasCompiladas(pasta = env.PASTA_TELAS) {
  return existsSync(join(pasta, 'index.html'));
}

export async function rotasTelas(app, { pasta = env.PASTA_TELAS } = {}) {
  if (!haTelasCompiladas(pasta)) return false;
  const raiz = resolve(pasta);

  await app.register(fastifyStatic, { root: raiz, serve: false });

  app.get('/*', { config: { publico: true, bancoReal: true } }, async (req, res) => {
    // Ja vem decodificado pelo Fastify. Decodificar de novo deixaria passar
    // "%252e%252e" (= ".." em dupla codificacao) — o `dentro` abaixo barraria,
    // mas a regra e nao abrir a porta.
    const pedido = String(req.params['*'] ?? '');

    // /api/... inexistente continua sendo 404 da API (JSON), nunca a tela.
    if (pedido === 'api' || pedido.startsWith('api/')) return res.callNotFound();

    const arquivo = resolve(raiz, pedido);
    const dentro = arquivo === raiz || arquivo.startsWith(raiz + sep);
    const existe = dentro && existsSync(arquivo) && statSync(arquivo).isFile();

    if (!existe) {
      res.header('cache-control', 'no-cache');
      return res.sendFile('index.html', raiz, { cacheControl: false });
    }

    const nome = relative(raiz, arquivo).split(sep).join('/');
    if (SEM_CACHE.has(nome)) res.header('cache-control', 'no-cache');
    else if (nome.startsWith('assets/')) res.header('cache-control', 'public, max-age=31536000, immutable');
    else res.header('cache-control', 'public, max-age=86400');
    return res.sendFile(nome, raiz, { cacheControl: false });
  });

  return true;
}
