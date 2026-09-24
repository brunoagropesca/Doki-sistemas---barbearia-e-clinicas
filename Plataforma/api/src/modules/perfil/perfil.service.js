import { Conflito, NaoEncontrado, RegraDeNegocio } from '../../core/errors.js';
import { repo as authRepo, usuarioPublico } from '../auth/auth.service.js';
import * as repo from './perfil.repo.js';

/**
 * "Meu perfil": o que cada pessoa mexe em si mesma.
 *
 * Nenhuma funcao daqui recebe o id de outro usuario — sempre o de quem esta
 * logado. Assim nao existe caminho para editar o perfil ou as respostas de um
 * colega, nem por engano.
 */

/** Teto de respostas por pessoa: a lista aparece inteira no livechat ao digitar "/". */
const LIMITE_RESPOSTAS = 100;

const publica = (r) => ({ id: r.id, atalho: r.atalho, texto: r.texto, updatedAt: r.updatedAt });

export async function atualizarPerfil(usuario, { nome, email, telefone }) {
  const dados = {};
  if (nome !== undefined) dados.nome = nome;
  // Campo apagado na tela chega como '' — no banco vira nulo, nao texto vazio.
  if (email !== undefined) dados.email = email || null;
  if (telefone !== undefined) dados.telefone = telefone || null;

  return usuarioPublico(await authRepo.atualizarUsuario(usuario.id, dados));
}

export async function listarRespostas(tenantId, usuario) {
  return (await repo.listarRespostas(tenantId, usuario.id)).map(publica);
}

export async function criarResposta(tenantId, usuario, { atalho, texto }) {
  const existentes = await repo.listarRespostas(tenantId, usuario.id);
  if (existentes.length >= LIMITE_RESPOSTAS) {
    throw new RegraDeNegocio(`Limite de ${LIMITE_RESPOSTAS} respostas rápidas atingido. Apague alguma antes.`);
  }
  if (existentes.some((r) => r.atalho === atalho)) {
    throw new Conflito(`Você já tem uma resposta com o atalho /${atalho}.`);
  }
  return publica(await repo.criarResposta(tenantId, usuario.id, { atalho, texto }));
}

export async function atualizarResposta(tenantId, usuario, id, { atalho, texto }) {
  const atual = await repo.buscarResposta(tenantId, usuario.id, id);
  if (!atual) throw new NaoEncontrado('Resposta rápida');

  const outra = await repo.buscarPorAtalho(tenantId, usuario.id, atalho);
  if (outra && outra.id !== id) throw new Conflito(`Você já tem uma resposta com o atalho /${atalho}.`);

  return publica(await repo.atualizarResposta(tenantId, usuario.id, id, { atalho, texto }));
}

export async function apagarResposta(tenantId, usuario, id) {
  const atual = await repo.buscarResposta(tenantId, usuario.id, id);
  if (!atual) throw new NaoEncontrado('Resposta rápida');
  await repo.apagarResposta(tenantId, usuario.id, id);
}
