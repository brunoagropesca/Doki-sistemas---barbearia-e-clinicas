import { env, isProd } from '../../config/env.js';
import { apenas, NOME_COOKIE } from '../../http/plugins/autenticacao.js';
import * as service from './auth.service.js';
import { exigirFuncao, funcaoLigada } from '../funcoes/funcoes.js';
import {
  avisoSchema,
  criarUsuarioSchema,
  editarUsuarioSchema,
  fotoSchema,
  loginSchema,
  presencaSchema,
  trocarSenhaSchema
} from './auth.schemas.js';

/**
 * Rotas de autenticacao.
 *
 * A rota so faz tres coisas: validar a entrada, chamar o servico e formatar a
 * saida. Nenhuma regra de negocio mora aqui — se aparecer um `if` decidindo
 * algo do negocio nesta camada, e sinal de que ele esta no lugar errado.
 */

/** Opcoes do cookie de sessao. Cada uma bloqueia um ataque especifico. */
function opcoesCookie(expiraEm) {
  return {
    path: '/',
    // O JavaScript da pagina nao consegue ler este cookie. Se alguem conseguir
    // injetar script no front, ainda assim nao rouba a sessao.
    httpOnly: true,
    // Em producao, so trafega por HTTPS.
    secure: isProd,
    // O navegador nao manda este cookie em requisicao vinda de outro site,
    // o que bloqueia CSRF (outro site agindo em nome do usuario logado).
    sameSite: 'lax',
    expires: expiraEm
  };
}

export async function rotasAuth(app) {
  /**
   * POST /api/auth/login
   * Publica por necessidade — e a porta de entrada.
   */
  app.post('/api/auth/login', { config: { ...apenas.publico, bancoReal: true } }, async (req, res) => {
    const { username, senha, empresa } = loginSchema.parse(req.body);

    const { token, expiraEm, usuario } = await service.login({
      username,
      senha,
      tenantSlug: empresa,
      userAgent: req.headers['user-agent'],
      ip: req.ip
    });

    res.setCookie(NOME_COOKIE, token, opcoesCookie(expiraEm));

    // O token tambem vai no corpo para clientes que nao usam cookie
    // (aplicativo de celular, integracao de terceiros).
    return { usuario, token, expiraEm };
  });

  /**
   * POST /api/auth/logout
   * Publica de proposito: deslogar precisa funcionar mesmo com token ja
   * expirado ou invalido. Exigir login pra sair seria um beco sem saida.
   */
  app.post('/api/auth/logout', { config: { ...apenas.publico, bancoReal: true } }, async (req, res) => {
    const token =
      req.cookies?.[NOME_COOKIE] ||
      (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);

    await service.logout(token);
    res.clearCookie(NOME_COOKIE, { path: '/' });
    // Saiu do sistema: a proxima entrada comeca no banco de verdade.
    res.clearCookie('plataforma_demonstracao', { path: '/' });

    return { ok: true };
  });

  /** GET /api/auth/eu — quem sou eu? Usada pelo front no carregamento. */
  app.get('/api/auth/eu', { config: apenas.atendente }, async (req) => {
    return { usuario: req.usuario };
  });

  /** POST /api/auth/trocar-senha */
  app.post('/api/auth/trocar-senha', { config: { ...apenas.atendente, bancoReal: true } }, async (req, res) => {
    const { senhaAtual, novaSenha } = trocarSenhaSchema.parse(req.body);

    await service.trocarSenha({ userId: req.usuario.id, senhaAtual, novaSenha });

    // As sessoes cairam, inclusive a atual. Limpa o cookie pra tela pedir
    // login de novo, em vez de mostrar erro estranho na proxima chamada.
    res.clearCookie(NOME_COOKIE, { path: '/' });

    return { ok: true, mensagem: 'Senha alterada. Entre novamente com a nova senha.' };
  });

  /** PATCH /api/auth/presenca — online/ausente/offline. */
  app.patch('/api/auth/presenca', { config: apenas.atendente }, async (req) => {
    const { statusPresenca } = presencaSchema.parse(req.body);
    const usuario = await service.definirPresenca(req.usuario.id, statusPresenca);
    return { usuario };
  });

  /**
   * PUT /api/auth/foto — a pessoa troca a propria foto.
   *
   * Sem id na rota, de proposito: a foto e sempre a de quem esta logado. Uma
   * rota com id abriria a porta para trocar a foto de outra pessoa.
   */
  app.put('/api/auth/foto', { config: apenas.atendente }, async (req) => {
    const dados = fotoSchema.parse(req.body);
    return { usuario: await service.definirFoto(req.usuario, dados) };
  });

  /**
   * POST /api/usuarios — criar funcionario.
   * Exige admin. O servico ainda impede criar alguem acima do proprio cargo.
   */
  app.post('/api/usuarios', { config: apenas.admin }, async (req, res) => {
    const dados = criarUsuarioSchema.parse(req.body);

    const usuario = await service.criarUsuario({
      solicitante: req.usuario,
      tenantId: req.tenantId,
      ...dados
    });

    res.status(201);
    return { usuario };
  });

  /** PATCH /api/usuarios/:id — editar funcionario (dados, cargo, senha, ativo). */
  app.patch('/api/usuarios/:id', { config: apenas.admin }, async (req) => {
    const dados = editarUsuarioSchema.parse(req.body);
    const usuario = await service.editarUsuario({
      solicitante: req.usuario,
      tenantId: req.tenantId,
      id: req.params.id,
      dados
    });
    return { usuario };
  });

  /** DELETE /api/usuarios/:id — excluir funcionario. As conversas dele voltam para a fila. */
  app.delete('/api/usuarios/:id', { config: apenas.admin }, async (req) => {
    return service.excluirUsuario({ solicitante: req.usuario, tenantId: req.tenantId, id: req.params.id });
  });

  /** POST /api/usuarios/:id/avisos — aviso que abre por cima de tudo na tela da pessoa. */
  app.post(
    '/api/usuarios/:id/avisos',
    { config: apenas.admin, onRequest: exigirFuncao('avisos_gerencia') },
    async (req, res) => {
      const { mensagem } = avisoSchema.parse(req.body);
      const aviso = await service.enviarAviso({
        solicitante: req.usuario,
        tenantId: req.tenantId,
        id: req.params.id,
        mensagem
      });
      res.status(201);
      return { aviso };
    }
  );

  /** GET /api/avisos/pendentes — os avisos que EU ainda nao confirmei. */
  app.get('/api/avisos/pendentes', { config: apenas.atendente }, async (req) => {
    // Avisos desligados pelo DEV: os pendentes deixam de aparecer.
    if (!(await funcaoLigada(req.tenantId, 'avisos_gerencia'))) return { avisos: [] };
    return { avisos: await service.avisosPendentes(req.usuario) };
  });

  /** POST /api/avisos/:id/lido — "Entendi". So o destinatario confirma. */
  app.post('/api/avisos/:id/lido', { config: apenas.atendente }, async (req) => {
    return service.confirmarAviso(req.usuario, req.params.id);
  });
}
