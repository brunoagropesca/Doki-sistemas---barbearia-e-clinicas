import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { professionals } from '../../db/schema/crm.js';
import { NaoEncontrado, RegraDeNegocio } from '../../core/errors.js';
import * as agenda from '../agenda/agenda.service.js';

/**
 * A agenda do dia vista pelo PROPRIO profissional (login de cargo `profissional`).
 *
 * O recorte aqui e mais estreito que o da agenda da equipe, de proposito: vale
 * so "eu vou executar" (o `professionalId` ligado ao login). Nao entram os
 * horarios que ele marcou nem os das conversas dele, e nem a opcao "toda a
 * equipe ve a agenda completa" abre a agenda dos colegas para ele.
 *
 * As leituras chamam a agenda SEM usuario (enxerga tudo) e so depois conferem
 * o dono; as escritas passam o usuario, para a auditoria dizer quem mexeu.
 */

/** O cadastro de profissional ligado a este login. Sem ele, nao ha agenda para mostrar. */
export async function profissionalDoUsuario(tenantId, usuario) {
  const p = await db.query.professionals.findFirst({
    where: and(
      eq(professionals.tenantId, tenantId),
      eq(professionals.userId, usuario.id),
      isNull(professionals.deletedAt)
    )
  });
  if (!p) throw new NaoEncontrado('Profissional');
  if (!p.ativo) throw new RegraDeNegocio('Seu cadastro de profissional está desativado. Fale com a gerência.');
  return p;
}

/** Os atendimentos do dia (padrao: hoje, no fuso da empresa). */
export async function doDia(tenantId, usuario, { data } = {}) {
  const p = await profissionalDoUsuario(tenantId, usuario);
  const agendamentos = await agenda.listar(tenantId, { data, professionalId: p.id });
  return {
    profissional: { id: p.id, nome: p.nome, funcao: p.funcao, cor: p.cor, fotoUrl: p.fotoUrl },
    agendamentos
  };
}

/** Um atendimento dele, com o contexto do cliente (o painel da OS). */
export async function obter(tenantId, usuario, id) {
  const p = await profissionalDoUsuario(tenantId, usuario);
  const a = await agenda.obter(tenantId, id);
  // "Nao encontrado", nunca "sem permissao": nao conta que o horario existe.
  if (a.professionalId !== p.id) throw new NaoEncontrado('Agendamento');
  return a;
}

/** Iniciar, concluir, faltou, cancelar — as mesmas regras de transicao da agenda. */
export async function mudarStatus(tenantId, usuario, id, { status, motivo }) {
  await obter(tenantId, usuario, id);
  return agenda.mudarStatus(tenantId, id, status, { usuario, motivo });
}
