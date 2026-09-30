import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarAppDeTeste, entrar } from './helpers/ambiente.js';

/**
 * Testes de autenticacao e permissao.
 *
 * Boa parte deste arquivo existe pra travar, em codigo, as falhas encontradas
 * no sistema antigo. Um teste que reproduz o ataque e a unica garantia de que
 * a falha nao volta numa refatoracao daqui a seis meses.
 */

let app;

before(async () => {
  ({ app } = await criarAppDeTeste());
});

after(async () => {
  await app?.close();
});

describe('login', () => {
  it('entra com credenciais corretas e devolve cookie httpOnly', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'dono', senha: 'trocar@123' }
    });

    assert.equal(res.statusCode, 200);
    const corpo = res.json();
    assert.equal(corpo.usuario.username, 'dono');
    assert.equal(corpo.usuario.cargo, 'owner');
    assert.ok(corpo.token);

    const cookie = res.cookies.find((c) => c.name === 'plataforma_sessao');
    assert.ok(cookie, 'o login precisa devolver o cookie de sessao');
    assert.equal(cookie.httpOnly, true, 'o JavaScript da pagina nao pode conseguir ler a sessao');
  });

  it('NUNCA devolve o hash da senha', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'dono', senha: 'trocar@123' }
    });

    const texto = res.body;
    assert.ok(!texto.includes('passwordHash'), 'vazou o nome do campo do hash');
    assert.ok(!texto.includes('scrypt$'), 'vazou o hash da senha');
    assert.ok(!texto.includes('trocar@123'), 'vazou a senha em texto puro');
  });

  it('recusa senha errada', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'dono', senha: 'senha-errada' }
    });
    assert.equal(res.statusCode, 401);
  });

  it('nao revela quais usuarios existem', async () => {
    const inexistente = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'naoexiste', senha: 'qualquer-coisa' }
    });
    const senhaErrada = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'dono', senha: 'senha-errada' }
    });

    assert.equal(inexistente.statusCode, senhaErrada.statusCode);
    assert.equal(
      inexistente.json().erro.mensagem,
      senhaErrada.json().erro.mensagem,
      'as duas respostas precisam ser indistinguiveis'
    );
  });
});

describe('rotas sao protegidas por padrao', () => {
  it('bloqueia quem nao esta logado', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/eu' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().erro.codigo, 'NAO_AUTENTICADO');
  });

  it('aceita token valido', async () => {
    const { cabecalho } = await entrar(app);
    const res = await app.inject({ method: 'GET', url: '/api/auth/eu', headers: cabecalho });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().usuario.username, 'dono');
  });

  it('recusa token inventado', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/eu',
      headers: { authorization: 'Bearer token-que-eu-inventei-agora' }
    });
    assert.equal(res.statusCode, 401);
  });

  it('a rota de saude continua publica', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  });
});

describe('falhas do sistema antigo que nao podem voltar', () => {
  /**
   * No sistema antigo, `getAuthUser()` aceitava o cabecalho `x-user-id` sem
   * validar token nenhum. Mandar `x-user-id: usr_dev` dava acesso total de
   * desenvolvedor a qualquer pessoa que soubesse do truque.
   */
  it('o cabecalho x-user-id nao vale como identidade', async () => {
    const { usuario } = await entrar(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/eu',
      headers: { 'x-user-id': usuario.id }
    });

    assert.equal(res.statusCode, 401, 'x-user-id jamais pode autenticar alguem');
  });

  /**
   * Uma rota podia cair em `getAuthUser(req) || getUserById('usr_dev')`:
   * quem nao estivesse logado virava desenvolvedor.
   */
  it('nao existe usuario padrao para quem nao esta logado', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/usuarios', payload: {} });
    assert.equal(res.statusCode, 401);
  });

  /** O erro interno nao pode entregar SQL, nome de coluna ou pilha em producao. */
  it('rota inexistente responde de forma consistente', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/rota/que/nao/existe' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().erro.codigo, 'ROTA_NAO_ENCONTRADA');
  });
});

describe('permissao por cargo', () => {
  it('atendente NAO cria usuarios', async () => {
    const { cabecalho } = await entrar(app, 'recepcao');

    const res = await app.inject({
      method: 'POST',
      url: '/api/usuarios',
      headers: cabecalho,
      payload: { username: 'invasor', senha: 'senha-longa-123', nome: 'Invasor', cargo: 'owner' }
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.json().erro.codigo, 'SEM_PERMISSAO');
  });

  it('owner cria usuarios', async () => {
    const { cabecalho } = await entrar(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/usuarios',
      headers: cabecalho,
      payload: {
        username: 'novo.atendente',
        senha: 'senha-longa-123',
        nome: 'Novo Atendente',
        cargo: 'atendente'
      }
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.json().usuario.cargo, 'atendente');
  });

  /**
   * Escalonamento de privilegio: um admin nao pode fabricar um owner e, com
   * ele, assumir a empresa.
   */
  it('ninguem cria alguem de cargo maior que o proprio', async () => {
    const { cabecalho } = await entrar(app);

    // O owner cria um admin...
    const criado = await app.inject({
      method: 'POST',
      url: '/api/usuarios',
      headers: cabecalho,
      payload: { username: 'gerente', senha: 'senha-longa-123', nome: 'Gerente', cargo: 'admin' }
    });
    assert.equal(criado.statusCode, 201);

    // ...e esse admin tenta criar um owner.
    const { cabecalho: cabAdmin } = await entrar(app, 'gerente', 'senha-longa-123');
    const tentativa = await app.inject({
      method: 'POST',
      url: '/api/usuarios',
      headers: cabAdmin,
      payload: { username: 'dono.falso', senha: 'senha-longa-123', nome: 'Dono Falso', cargo: 'owner' }
    });

    assert.equal(tentativa.statusCode, 403);
  });
});

describe('sessao', () => {
  it('logout invalida o token de verdade', async () => {
    const { cabecalho } = await entrar(app);

    const antes = await app.inject({ method: 'GET', url: '/api/auth/eu', headers: cabecalho });
    assert.equal(antes.statusCode, 200);

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: cabecalho });

    const depois = await app.inject({ method: 'GET', url: '/api/auth/eu', headers: cabecalho });
    assert.equal(depois.statusCode, 401, 'o token precisa morrer no logout');
  });

  it('trocar a senha derruba todas as sessoes', async () => {
    const sessaoA = await entrar(app, 'recepcao');
    const sessaoB = await entrar(app, 'recepcao');

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/trocar-senha',
      headers: sessaoA.cabecalho,
      payload: { senhaAtual: 'trocar@123', novaSenha: 'nova-senha-forte-456' }
    });
    assert.equal(res.statusCode, 200);

    // A outra sessao, aberta em outro aparelho, tambem precisa cair.
    const outra = await app.inject({ method: 'GET', url: '/api/auth/eu', headers: sessaoB.cabecalho });
    assert.equal(outra.statusCode, 401);

    // E a senha nova funciona.
    const novoLogin = await entrar(app, 'recepcao', 'nova-senha-forte-456');
    assert.ok(novoLogin.token);
  });
});

describe('validacao de entrada', () => {
  it('recusa senha curta com mensagem util', async () => {
    const { cabecalho } = await entrar(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/usuarios',
      headers: cabecalho,
      payload: { username: 'curto', senha: '123', nome: 'Teste', cargo: 'atendente' }
    });

    assert.equal(res.statusCode, 400);
    const erro = res.json().erro;
    assert.equal(erro.codigo, 'VALIDACAO');
    assert.ok(erro.detalhes.campos.some((c) => c.campo === 'senha'));
  });

  it('recusa cargo inexistente', async () => {
    const { cabecalho } = await entrar(app);

    const res = await app.inject({
      method: 'POST',
      url: '/api/usuarios',
      headers: cabecalho,
      payload: { username: 'teste.cargo', senha: 'senha-longa-123', nome: 'Teste', cargo: 'imperador' }
    });

    assert.equal(res.statusCode, 400);
  });

  it('recusa usuario duplicado com 409, nao com 500', async () => {
    const { cabecalho } = await entrar(app);
    const payload = { username: 'duplicado', senha: 'senha-longa-123', nome: 'Duplicado', cargo: 'atendente' };

    const primeiro = await app.inject({ method: 'POST', url: '/api/usuarios', headers: cabecalho, payload });
    assert.equal(primeiro.statusCode, 201);

    const segundo = await app.inject({ method: 'POST', url: '/api/usuarios', headers: cabecalho, payload });
    assert.equal(segundo.statusCode, 409);
    assert.equal(segundo.json().erro.codigo, 'CONFLITO');
  });
});

/**
 * Cookie de sessao `Secure` so quando a requisicao veio por HTTPS. Antes era
 * "em producao": na loja (producao, sem HTTPS ainda) o navegador recusaria o
 * cookie e ninguem entraria pelo IP da rede.
 */
describe('cookie de sessao', () => {
  const cookieDoLogin = async (headers = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers,
      payload: { username: 'dono', senha: 'trocar@123' }
    });
    assert.equal(res.statusCode, 200, res.body);
    return String(res.headers['set-cookie']);
  };

  it('por HTTP (a loja hoje, pelo IP da rede) sai sem Secure', async () => {
    const cookie = await cookieDoLogin();
    assert.match(cookie, /HttpOnly/i);
    assert.doesNotMatch(cookie, /Secure/i);
  });

  it('por HTTPS (atras de um proxy desta maquina) sai com Secure', async () => {
    const cookie = await cookieDoLogin({ 'x-forwarded-proto': 'https' });
    assert.match(cookie, /Secure/i);
  });
});
