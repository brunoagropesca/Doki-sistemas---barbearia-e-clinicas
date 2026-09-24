import { existsSync } from 'node:fs';
import { env } from '../../config/env.js';
import { conferirSenha, gerarHashSenha, gerarTokenSessao, hashToken, precisaRehash } from '../../core/crypto.js';
import { Conflito, NaoAutenticado, NaoEncontrado, RegraDeNegocio, SemPermissao } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { EVENTOS, emitir } from '../../core/eventos.js';
import { NIVEL_CARGO } from '../../db/schema/auth.js';
import * as repo from './auth.repo.js';
import { apagarImagem, salvarImagem } from '../equipe/arquivos.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';

const log = comContexto({ modulo: 'auth' });

/**
 * Regras de autenticacao.
 *
 * O servico e a camada que DECIDE. Ele nao sabe o que e uma requisicao HTTP
 * (nao existe `req` nem `res` aqui) e nao escreve SQL. Isso permite testar
 * "senha errada tres vezes bloqueia" sem subir servidor nem banco de verdade.
 */

/**
 * Remove tudo que nao pode sair do servidor.
 *
 * Isto e uma lista de PERMITIDOS, nao de proibidos. A diferenca importa: com
 * lista de proibidos, adicionar uma coluna sensivel ao schema a vaza
 * automaticamente ate alguem lembrar de bloquea-la. Aqui, campo novo so
 * aparece na API se for escrito aqui de proposito.
 */
export function usuarioPublico(u) {
  if (!u) return null;
  return {
    id: u.id,
    tenantId: u.tenantId,
    username: u.username,
    nome: u.nome,
    email: u.email,
    telefone: u.telefone,
    cargo: u.cargo,
    statusPresenca: u.statusPresenca,
    capacidadeSimultanea: u.capacidadeSimultanea,
    avatar: u.avatar,
    ativo: u.ativo,
    ultimoLoginEm: u.ultimoLoginEm
  };
}

/**
 * Atraso artificial para igualar o tempo de resposta.
 *
 * Se "usuario inexistente" respondesse na hora e "senha errada" demorasse os
 * ~100ms do scrypt, daria pra descobrir quais logins existem so medindo o
 * tempo. Igualando o tempo, as duas respostas ficam indistinguiveis.
 */
/**
 * O perfil DEV so funciona com o arquivo-chave (o CRIAR-DEV.bat) na pasta.
 * Lido a cada chamada, de proposito: apagar o arquivo vale na hora.
 */
export function devLiberado() {
  return existsSync(env.DEV_ARQUIVO_CHAVE);
}

/**
 * Remove o DEV que ficou para tras sem sair pelo botao (fechou o navegador e
 * a sessao expirou). Chamado no boot. So pega quem nao tem sessao valida e
 * nasceu ha mais de um dia — o DEV recem-criado pelo .bat, que ainda nao
 * entrou, nao some antes de ter a chance.
 */
export async function removerDevsAbandonados() {
  const removidos = await repo.apagarDevsSemSessao(new Date(Date.now() - 86_400_000));
  if (removidos > 0) log.info({ removidos }, 'Usuarios DEV abandonados removidos');
  return removidos;
}

async function atrasoConstante() {
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 60));
}

/**
 * Faz login.
 *
 * Repare que a mensagem de erro e a MESMA para usuario inexistente, senha
 * errada e conta desativada. Dizer "usuario nao encontrado" entrega de graca
 * quais logins existem — informacao valiosa pra quem esta tentando invadir.
 */
export async function login({ username, senha, tenantSlug, userAgent, ip }) {
  const generico = () => new NaoAutenticado('Usuario ou senha incorretos.');

  let usuario = null;

  if (tenantSlug) {
    // A tela mandou de qual empresa e o login. Resolvemos o slug no id dela.
    const tenant = await repo.buscarTenantPorSlug(tenantSlug);
    if (tenant) {
      usuario = await repo.buscarPorUsername(tenant.id, username);
    }
  } else {
    // Sem empresa informada: so funciona se o login for unico no sistema todo.
    usuario = await repo.buscarPorUsernameGlobal(username);
  }

  if (!usuario) {
    await atrasoConstante();
    throw generico();
  }

  const senhaConfere = await conferirSenha(senha, usuario.passwordHash);
  if (!senhaConfere) {
    log.warn({ username, tenantId: usuario.tenantId }, 'Tentativa de login com senha incorreta');
    throw generico();
  }

  if (!usuario.ativo) {
    log.warn({ userId: usuario.id }, 'Login recusado: conta desativada');
    throw generico();
  }

  // Mesma mensagem generica: dizer "falta o arquivo" confirmaria que o
  // perfil DEV existe.
  if (usuario.cargo === 'dev' && !devLiberado()) {
    log.warn({ userId: usuario.id }, 'Login DEV recusado: arquivo-chave ausente');
    throw generico();
  }

  // Se o hash foi feito com parametros antigos, aproveitamos que temos a senha
  // em maos agora pra atualizar. O usuario nao percebe nada.
  if (precisaRehash(usuario.passwordHash)) {
    const novoHash = await gerarHashSenha(senha);
    await repo.atualizarUsuario(usuario.id, { passwordHash: novoHash });
    log.info({ userId: usuario.id }, 'Hash de senha atualizado para os parametros atuais');
  }

  const { token, tokenHash } = gerarTokenSessao();
  const expiraEm = new Date(Date.now() + env.SESSION_TTL_DAYS * 86_400_000);

  await repo.criarSessao({
    tenantId: usuario.tenantId,
    userId: usuario.id,
    tokenHash,
    expiraEm,
    userAgent,
    ip
  });
  await repo.registrarLogin(usuario.id);

  log.info({ userId: usuario.id, tenantId: usuario.tenantId }, 'Login efetuado');

  return { token, expiraEm, usuario: usuarioPublico(usuario) };
}

/**
 * Valida um token de sessao. Chamado a cada requisicao pelo plugin de auth.
 * Devolve null (e nao erro) quando o token nao serve — quem decide se isso
 * e problema e a rota, que sabe se ela e publica ou nao.
 */
export async function validarToken(token) {
  if (!token || typeof token !== 'string') return null;

  const linha = await repo.buscarSessaoValida(hashToken(token));
  if (!linha) return null;

  // Tirar o .bat da pasta derruba o DEV que ja estava dentro.
  if (linha.usuario.cargo === 'dev' && !devLiberado()) return null;

  // Marca o uso sem segurar a resposta. Se falhar, nao e motivo pra recusar
  // um login que e valido.
  repo.marcarUso(linha.sessao.id).catch((err) => log.debug({ err }, 'Falha ao marcar uso da sessao'));

  return usuarioPublico(linha.usuario);
}

/**
 * Sair do sistema.
 *
 * Quem sai fica OFFLINE — a menos que ainda tenha outra sessao aberta (o
 * celular, outro computador). Sem isto, quem fechou o sistema as 18h continuaria
 * "online" para a distribuicao ate o dia seguinte, e receberia clientes que
 * ninguem esta olhando.
 */
export async function logout(token) {
  if (!token) return;

  const hash = hashToken(token);
  const linha = await repo.buscarSessaoValida(hash);
  await repo.revogarSessao(hash);

  // O DEV e descartavel: sair apaga o usuario (e, em cascata, as sessoes
  // dele). Para entrar de novo, roda-se o CRIAR-DEV.bat.
  if (linha?.usuario.cargo === 'dev') {
    await repo.apagarUsuarioDefinitivo(linha.usuario.id);
    log.info('Usuario DEV saiu e foi removido');
    return;
  }

  if (linha && !(await repo.temSessaoValida(linha.usuario.id))) {
    await repo.atualizarUsuario(linha.usuario.id, { statusPresenca: 'offline' });
  }
}

/**
 * Foto do proprio perfil. `foto` e uma data URL; `remover` apaga a atual.
 * Cada pessoa mexe so na propria: nao ha id na rota.
 */
export async function definirFoto(usuario, { foto, remover }) {
  const atual = await repo.buscarUsuarioPorId(usuario.id);
  let avatar = atual.avatar;

  if (foto) {
    avatar = await salvarImagem(foto, 'perfil');
    // A antiga so sai depois que a nova esta em disco.
    if (atual.avatar?.startsWith('/api/arquivos/')) await apagarImagem(atual.avatar);
  } else if (remover) {
    if (atual.avatar?.startsWith('/api/arquivos/')) await apagarImagem(atual.avatar);
    avatar = null;
  }

  const atualizado = await repo.atualizarUsuario(usuario.id, { avatar });
  return usuarioPublico(atualizado);
}

/**
 * Troca a senha do proprio usuario.
 *
 * Exige a senha atual mesmo estando logado: se alguem deixar a sessao aberta
 * num computador, alcancar o teclado nao pode ser suficiente pra tomar a conta.
 *
 * Todas as outras sessoes caem. Trocar senha geralmente significa "acho que
 * alguem entrou na minha conta" — manter as outras sessoes vivas derrotaria
 * o proposito.
 */
export async function trocarSenha({ userId, senhaAtual, novaSenha }) {
  const usuario = await repo.buscarUsuarioPorId(userId);
  if (!usuario) throw new NaoEncontrado('Usuario');

  if (!(await conferirSenha(senhaAtual, usuario.passwordHash))) {
    throw new NaoAutenticado('A senha atual esta incorreta.');
  }
  if (senhaAtual === novaSenha) {
    throw new RegraDeNegocio('A nova senha precisa ser diferente da atual.');
  }

  await repo.atualizarUsuario(userId, { passwordHash: await gerarHashSenha(novaSenha) });
  await repo.revogarTodasDoUsuario(userId);

  log.info({ userId }, 'Senha alterada; todas as sessoes foram encerradas');
}

/**
 * Cria um usuario.
 *
 * Duas regras de escalonamento de privilegio moram aqui:
 *  1. Ninguem cria alguem de cargo maior que o proprio. Sem isto, um atendente
 *     criaria um `owner` e assumiria a empresa.
 *  2. Ninguem cria em outra empresa (exceto o perfil dev).
 */
export async function criarUsuario({ solicitante, tenantId, username, senha, nome, cargo, email, telefone }) {
  const alvoTenant = tenantId ?? solicitante.tenantId;

  if (alvoTenant !== solicitante.tenantId && solicitante.cargo !== 'dev') {
    throw new SemPermissao('Voce nao pode criar usuarios em outra empresa.');
  }

  const nivelSolicitante = NIVEL_CARGO[solicitante.cargo] ?? 0;
  const nivelAlvo = NIVEL_CARGO[cargo] ?? Infinity;
  if (nivelAlvo > nivelSolicitante) {
    // O texto nao cita o cargo quando e o `dev`: o perfil e invisivel, e uma
    // mensagem falando em "cargo dev, superior ao seu" confirmaria que existe.
    throw new SemPermissao(
      cargo === 'dev'
        ? 'Cargo invalido.'
        : `Voce nao pode criar um usuario com o cargo "${cargo}", superior ao seu.`
    );
  }

  const jaExiste = await repo.buscarPorUsername(alvoTenant, username);
  if (jaExiste) {
    throw new Conflito(`O usuario "${username}" ja existe nesta empresa.`);
  }

  const criado = await repo.criarUsuario({
    tenantId: alvoTenant,
    username,
    nome,
    email: email ?? null,
    telefone: telefone ?? null,
    cargo,
    passwordHash: await gerarHashSenha(senha)
  });

  log.info({ userId: criado.id, cargo, porUserId: solicitante.id }, 'Usuario criado');
  return usuarioPublico(criado);
}

/**
 * Busca o funcionario que a gerencia quer mexer, ja checando se ela pode.
 *
 * Mesma regra da criacao: ninguem mexe em quem esta acima do proprio cargo —
 * sem isto, um admin rebaixaria o dono. O `dev` responde "nao encontrado",
 * como em todo lugar: o perfil e invisivel.
 */
async function alvoDaGerencia(solicitante, tenantId, id) {
  const alvo = await repo.buscarUsuarioPorId(id);
  if (!alvo || alvo.tenantId !== tenantId || alvo.cargo === 'dev') throw new NaoEncontrado('Usuario');

  if ((NIVEL_CARGO[alvo.cargo] ?? Infinity) > (NIVEL_CARGO[solicitante.cargo] ?? 0)) {
    throw new SemPermissao('Voce nao pode alterar alguem com cargo acima do seu.');
  }
  return alvo;
}

/** A empresa nunca pode ficar sem um dono ativo: ninguem mais consegue devolver o acesso. */
async function garantirOutroDono(tenantId, alvo) {
  if (alvo.cargo !== 'owner') return;
  const donos = await repo.contarDonosAtivos(tenantId);
  if (donos <= 1) throw new RegraDeNegocio('A empresa precisa de pelo menos um dono ativo.');
}

/**
 * Edita um funcionario.
 *
 * Quem se edita nao troca o proprio cargo nem se desativa: um clique errado
 * trancaria a pessoa (e, se for o unico dono, a empresa inteira) do lado de
 * fora. Desativar ou trocar a senha derruba as sessoes abertas — e o que a
 * gerencia espera quando faz isso com alguem que saiu.
 */
export async function editarUsuario({ solicitante, tenantId, id, dados }) {
  const alvo = await alvoDaGerencia(solicitante, tenantId, id);
  const proprio = alvo.id === solicitante.id;

  if (dados.cargo !== undefined && dados.cargo !== alvo.cargo) {
    if (proprio) throw new RegraDeNegocio('Voce nao pode trocar o proprio cargo.');
    if ((NIVEL_CARGO[dados.cargo] ?? Infinity) > (NIVEL_CARGO[solicitante.cargo] ?? 0)) {
      throw new SemPermissao(`Voce nao pode dar o cargo "${dados.cargo}", superior ao seu.`);
    }
    await garantirOutroDono(tenantId, alvo);
  }

  if (dados.ativo === false && alvo.ativo) {
    if (proprio) throw new RegraDeNegocio('Voce nao pode desativar a propria conta.');
    await garantirOutroDono(tenantId, alvo);
  }

  if (dados.username && dados.username !== alvo.username) {
    const jaExiste = await repo.buscarPorUsername(tenantId, dados.username);
    if (jaExiste && jaExiste.id !== alvo.id) throw new Conflito(`O usuario "${dados.username}" ja existe nesta empresa.`);
  }

  const mudancas = {};
  for (const campo of ['username', 'nome', 'cargo', 'capacidadeSimultanea', 'ativo']) {
    if (dados[campo] !== undefined) mudancas[campo] = dados[campo];
  }
  if (dados.email !== undefined) mudancas.email = dados.email || null;
  if (dados.telefone !== undefined) mudancas.telefone = dados.telefone || null;
  if (dados.novaSenha) mudancas.passwordHash = await gerarHashSenha(dados.novaSenha);
  if (dados.ativo === false) mudancas.statusPresenca = 'offline';

  const atualizado = await repo.atualizarUsuario(id, mudancas);

  const derrubarSessoes = Boolean(dados.novaSenha) || (dados.ativo === false && alvo.ativo);
  if (derrubarSessoes) await repo.revogarTodasDoUsuario(id);

  // A senha nunca vai para a auditoria, nem o hash: so o fato de ter mudado.
  const { passwordHash, ...semSenha } = mudancas;
  const antes = Object.fromEntries(Object.keys(semSenha).map((c) => [c, alvo[c]]));
  await registrarAuditoria({
    tenantId,
    usuario: solicitante,
    acao: 'usuario.editar',
    entidade: 'usuario',
    entidadeId: id,
    dados: { antes, depois: { ...semSenha, ...(passwordHash ? { senha: 'redefinida' } : {}) } }
  });

  log.info({ userId: id, porUserId: solicitante.id, campos: Object.keys(mudancas) }, 'Usuario editado');
  return usuarioPublico(atualizado);
}

/**
 * Exclui um funcionario.
 *
 * Exclusao logica: as mensagens que ele mandou, os horarios que marcou e a
 * auditoria continuam apontando para alguem. O login e renomeado com um
 * sufixo que a validacao de login recusa (`#`), o que libera o nome de
 * usuario para ser reaproveitado e garante que ninguem entra mais por ele.
 *
 * As conversas que estavam com ele voltam para a fila: sem isso, clientes
 * ficariam esperando resposta de quem nao existe mais.
 */
export async function excluirUsuario({ solicitante, tenantId, id }) {
  const alvo = await alvoDaGerencia(solicitante, tenantId, id);
  if (alvo.id === solicitante.id) throw new RegraDeNegocio('Voce nao pode excluir a propria conta.');
  await garantirOutroDono(tenantId, alvo);

  await repo.atualizarUsuario(id, {
    deletedAt: new Date(),
    ativo: false,
    statusPresenca: 'offline',
    username: `${alvo.username}#excluido-${Date.now()}`
  });
  await repo.revogarTodasDoUsuario(id);
  const devolvidas = await repo.devolverConversasParaFila(tenantId, id);

  await registrarAuditoria({
    tenantId,
    usuario: solicitante,
    acao: 'usuario.excluir',
    entidade: 'usuario',
    entidadeId: id,
    dados: { antes: { nome: alvo.nome, username: alvo.username, cargo: alvo.cargo }, conversasDevolvidas: devolvidas }
  });

  log.info({ userId: id, porUserId: solicitante.id, devolvidas }, 'Usuario excluido');
  return {
    ok: true,
    conversasDevolvidas: devolvidas,
    mensagem:
      devolvidas > 0
        ? `${alvo.nome} foi excluido. ${devolvidas} conversa(s) dele voltaram para a fila.`
        : `${alvo.nome} foi excluido.`
  };
}

/**
 * Manda um aviso que abre por cima de tudo na tela da pessoa.
 *
 * O canal de tempo real so leva o recado "chegou aviso" e so para as abas
 * dela; o texto vem pela API, como todo o resto. Quem esta deslogado ve o
 * aviso assim que entrar.
 */
export async function enviarAviso({ solicitante, tenantId, id, mensagem }) {
  const alvo = await alvoDaGerencia(solicitante, tenantId, id);
  if (!alvo.ativo) throw new RegraDeNegocio(`${alvo.nome} esta com a conta desativada e nao veria o aviso.`);

  const aviso = await repo.criarAviso({
    tenantId,
    userId: alvo.id,
    deUserId: solicitante.id,
    deNome: solicitante.nome,
    mensagem
  });
  emitir(EVENTOS.AVISO, { tenantId, userId: alvo.id });

  log.info({ avisoId: aviso.id, userId: alvo.id, porUserId: solicitante.id }, 'Aviso enviado');
  return aviso;
}

export function avisosPendentes(usuario) {
  return repo.avisosPendentes(usuario.tenantId, usuario.id);
}

export async function confirmarAviso(usuario, id) {
  if (!(await repo.marcarAvisoLido(usuario.tenantId, usuario.id, id))) throw new NaoEncontrado('Aviso');
  return { ok: true };
}

/** Muda a disponibilidade do atendente para receber conversas. */
export async function definirPresenca(userId, statusPresenca) {
  const atualizado = await repo.atualizarUsuario(userId, { statusPresenca });
  return usuarioPublico(atualizado);
}

export { repo };
