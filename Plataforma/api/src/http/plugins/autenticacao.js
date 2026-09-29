import fp from 'fastify-plugin';
import { AppError, NaoAutenticado, SemPermissao } from '../../core/errors.js';
import { NIVEL_CARGO } from '../../db/schema/auth.js';
import { validarToken } from '../../modules/auth/auth.service.js';
import { rodarNoBanco } from '../../db/client.js';
import { abrir as abrirDemonstracao, COOKIE_DEMONSTRACAO, espelharUsuario, existe as existeDemonstracao } from '../../modules/demonstracao/demonstracao.js';

/**
 * Autenticacao e permissao.
 *
 * ESTE ARQUIVO CORRIGE A FALHA MAIS GRAVE DO SISTEMA ANTIGO.
 *
 * La, cada rota decidia sozinha se ia checar login. Das ~80 rotas, 10 checavam.
 * As outras 70 — incluindo listar clientes, apagar clientes em lote e ler a
 * chave da API do Gemini — respondiam pra qualquer um que perguntasse.
 * Proteger por rota falha porque depende de lembrar, toda vez, pra sempre.
 *
 * Aqui a logica e invertida: o `onRequest` abaixo roda em TODA requisicao e
 * exige autenticacao. Uma rota publica precisa dizer isso explicitamente:
 *
 *     app.post('/api/auth/login', { config: { publico: true } }, handler)
 *
 * Esquecer de marcar agora resulta numa rota protegida demais — que aparece no
 * primeiro teste. O erro passou a ser barulhento em vez de silencioso.
 *
 * Outra coisa que sumiu: o sistema antigo aceitava o cabecalho `x-user-id` como
 * prova de identidade, sem validar token nenhum. Mandar `x-user-id: usr_dev`
 * dava acesso total de desenvolvedor. Aqui a unica prova aceita e um token de
 * sessao que existe, nao expirou e nao foi revogado.
 */

export const NOME_COOKIE = 'plataforma_sessao';

function extrairToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  // O cookie e o caminho normal do navegador (httpOnly, o JS da pagina nao le).
  return req.cookies?.[NOME_COOKIE] || null;
}

async function plugin(app) {
  // Declarar antes deixa a forma do objeto `request` estavel — o motor do V8
  // otimiza melhor do que quando propriedades aparecem no meio do caminho.
  app.decorateRequest('usuario', null);
  app.decorateRequest('tenantId', null);
  app.decorateRequest('bancoDemonstracao', null);

  app.addHook('onRequest', async (req) => {
    // Requisicao que nao casou com rota nenhuma: deixa o tratador de 404
    // responder. Sem isto, URL inexistente devolveria 401 pra quem nao esta
    // logado — confuso pra depurar, e nao esconde nada de util, ja que a
    // lista de rotas esta no codigo do front de qualquer forma.
    if (!req.routeOptions?.url) return;

    const rota = req.routeOptions.config || {};

    // Um token invalido nunca deve derrubar uma rota publica (o login, por
    // exemplo). Por isso resolvemos o usuario num try, e so exigimos depois.
    const token = extrairToken(req);
    if (token) {
      try {
        const usuario = await validarToken(token);
        if (usuario) {
          req.usuario = usuario;
          req.tenantId = usuario.tenantId;
        }
      } catch (err) {
        req.log.debug({ err }, 'Token apresentado nao pode ser validado');
      }
    }

    // MODO DEMONSTRACAO (so o DEV, so neste navegador): a requisicao passa a
    // ser da empresa ficticia e roda no banco paralelo (hook seguinte). Rotas
    // `bancoReal` (login, backups, a propria demonstracao) ficam no real.
    if (req.usuario?.cargo === 'dev' && req.cookies?.[COOKIE_DEMONSTRACAO] === '1' && !rota.bancoReal && existeDemonstracao()) {
      try {
        const tenantDemo = await espelharUsuario(req.usuario);
        if (tenantDemo) {
          req.usuario = { ...req.usuario, tenantId: tenantDemo, demonstracao: true };
          req.tenantId = tenantDemo;
          req.bancoDemonstracao = (await abrirDemonstracao()).db;
        }
      } catch (err) {
        req.log.warn({ err }, 'Nao foi possivel abrir a demonstracao; seguindo no banco real');
      }
    }

    if (rota.publico === true) return;

    // Rota do perfil invisivel: nem sem login ela pode "existir" (um 401 aqui
    // diria que a rota existe e so falta entrar).
    if (!req.usuario && rota.ocultar) {
      throw new AppError(`Nao existe ${req.method} ${req.url} nesta API.`, { status: 404, code: 'ROTA_NAO_ENCONTRADA' });
    }

    if (!req.usuario) {
      throw new NaoAutenticado();
    }

    // Login de PROFISSIONAL: lista de permitidos, nao de proibidos. Ele so
    // passa nas rotas marcadas para ele (`apenas.profissional` ou
    // `profissional: true`). Rota nova nasce fechada para ele — esquecer de
    // marcar nunca abre a agenda da casa inteira para o barbeiro.
    if (req.usuario.cargo === 'profissional' && rota.profissional !== true) {
      throw new SemPermissao('Seu acesso é só à sua agenda do dia.');
    }

    // Cargo minimo exigido pela rota, quando declarado.
    if (rota.cargoMinimo) {
      const nivelUsuario = NIVEL_CARGO[req.usuario.cargo] ?? 0;
      const nivelExigido = NIVEL_CARGO[rota.cargoMinimo] ?? Infinity;
      if (nivelUsuario < nivelExigido) {
        // Rota do perfil invisivel: responde EXATAMENTE como uma rota que nao
        // existe (mesmo status, codigo e texto do tratador de 404). Qualquer
        // diferenca — um 403, uma mensagem falando em "perfil dev" — revelaria
        // que a rota e o cargo existem.
        if (rota.ocultar) {
          throw new AppError(`Nao existe ${req.method} ${req.url} nesta API.`, {
            status: 404,
            code: 'ROTA_NAO_ENCONTRADA'
          });
        }

        throw new SemPermissao(
          `Esta acao exige o perfil "${rota.cargoMinimo}" ou superior. O seu e "${req.usuario.cargo}".`
        );
      }
    }
  });

  // O resto da requisicao (hooks, rota, tudo que ela disparar) roda no banco
  // da demonstracao. Tem de ser no estilo "done": o contexto so segue a
  // requisicao se o proximo passo for chamado DENTRO do `rodarNoBanco`.
  app.addHook('onRequest', (req, reply, done) => {
    if (!req.bancoDemonstracao) return done();
    rodarNoBanco({ db: req.bancoDemonstracao, demonstracao: true }, done);
  });

  /**
   * Garante que o recurso pertence a empresa de quem esta pedindo.
   *
   * Toda consulta ja filtra por `tenantId`, mas esta funcao e a segunda
   * tranca: se um id de outra empresa for passado na URL, o registro
   * simplesmente "nao existe" pra quem perguntou — a resposta e 404, nao 403.
   * Responder 403 confirmaria que aquele id existe em algum lugar, o que ja
   * e informacao demais.
   */
  app.decorate('mesmoTenant', (recurso, req) => {
    if (!recurso) return false;
    if (req.usuario?.cargo === 'dev') return true; // quem configura a plataforma
    return recurso.tenantId === req.tenantId;
  });
}

export const pluginAutenticacao = fp(plugin, { name: 'autenticacao' });

/**
 * Atalhos para declarar permissao numa rota.
 *
 * Uso: `app.get('/api/leads', { config: apenas.atendente }, handler)`
 */
export const apenas = {
  publico: { publico: true },
  /**
   * Qualquer pessoa logada, INCLUSIVE o login de profissional. So para o
   * minimo que a tela dele usa (quem sou eu, a agenda dele, trocar senha).
   */
  profissional: { cargoMinimo: 'profissional', profissional: true },
  atendente: { cargoMinimo: 'atendente' },
  admin: { cargoMinimo: 'admin' },
  owner: { cargoMinimo: 'owner' },
  /**
   * So o perfil DEV. Para o que o cliente nao pode fazer sozinho (adicionar e
   * remover sessoes de WhatsApp, por exemplo).
   *
   * Quem nao e DEV recebe 404, nao 403: um 403 confirmaria que a rota existe
   * e que ha um cargo acima do dele, e a ideia e o perfil ser invisivel.
   */
  dev: { cargoMinimo: 'dev', ocultar: true }
};
