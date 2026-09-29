import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { professionals } from '../../db/schema/crm.js';
import { professionalServices, services } from '../../db/schema/catalog.js';
import { appointments } from '../../db/schema/scheduling.js';
import { users } from '../../db/schema/auth.js';
import { conversations } from '../../db/schema/conversations.js';
import { ID } from '../../core/ids.js';
import { NaoEncontrado, RegraDeNegocio } from '../../core/errors.js';
import { formatarBRL } from '../../core/money.js';
import { formatarTelefone, normalizarTelefone } from '../../core/phone.js';
import { comContexto } from '../../core/logger.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import { apagarImagem, salvarImagem } from './arquivos.js';
import * as authService from '../auth/auth.service.js';

const log = comContexto({ modulo: 'equipe' });

/**
 * Cadastro da equipe.
 *
 * Duas coisas diferentes com o mesmo nome no dia a dia:
 *
 *   PROFISSIONAL — quem executa o servico e ocupa a agenda (o barbeiro, a
 *   esteticista). Tem jornada, cor no calendario e uma tabela propria de
 *   quanto cobra e quanto demora em cada servico.
 *
 *   ATENDENTE — quem usa o sistema (login, cargo, permissoes). Atende no
 *   livechat, mas nao aparece na agenda.
 *
 * Sao tabelas separadas de proposito: o barbeiro pode nao ter login nenhum, e
 * a recepcionista tem login mas nunca atende na cadeira. Quando a mesma pessoa
 * e as duas coisas, `userId` liga os dois cadastros.
 */

const base = (tenantId) => and(eq(professionals.tenantId, tenantId), isNull(professionals.deletedAt));

/**
 * O login PROPRIO do profissional (cargo `profissional`), se tiver.
 *
 * So esse tipo aparece como "acesso": um profissional ligado ao login de uma
 * recepcionista usa o sistema inteiro pelo login dela, e a ficha continua
 * mostrando esse vinculo no seletor de sempre.
 */
async function acessosDe(tenantId, userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const linhas = await db
    .select({ id: users.id, username: users.username, ativo: users.ativo, ultimoLoginEm: users.ultimoLoginEm })
    .from(users)
    .where(
      and(eq(users.tenantId, tenantId), eq(users.cargo, 'profissional'), isNull(users.deletedAt), inArray(users.id, ids))
    );
  return new Map(
    linhas.map((u) => [u.id, { userId: u.id, username: u.username, ativo: u.ativo, ultimoLoginEm: u.ultimoLoginEm?.getTime() ?? null }])
  );
}

function apresentar(p, servicos = [], acesso = null) {
  return {
    acesso,
    id: p.id,
    nome: p.nome,
    funcao: p.funcao,
    cor: p.cor,
    telefone: p.telefone,
    telefoneFormatado: p.telefone ? formatarTelefone(p.telefone) : null,
    fotoUrl: p.fotoUrl,
    observacoes: p.observacoes ?? '',
    userId: p.userId,
    jornada: p.jornada,
    ativo: p.ativo,
    servicos,
    totalServicos: servicos.length
  };
}

/**
 * Os servicos de um profissional, com o preco e a duracao QUE VALEM para ele.
 *
 * `precoProprio`/`duracaoPropria` dizem se o valor foi definido para este
 * profissional ou se e o padrao do servico — e o que a ficha precisa para
 * mostrar "R$ 70 (proprio)" em vez de fingir que todo mundo cobra igual.
 */
async function servicosDoProfissional(tenantId, professionalId) {
  const linhas = await db
    .select({
      serviceId: services.id,
      nome: services.nome,
      categoria: services.categoria,
      precoPadrao: services.precoCentavos,
      duracaoPadrao: services.duracaoMinutos,
      precoProprio: professionalServices.precoCentavos,
      duracaoPropria: professionalServices.duracaoMinutos
    })
    .from(professionalServices)
    .innerJoin(services, eq(services.id, professionalServices.serviceId))
    .where(
      and(
        eq(professionalServices.tenantId, tenantId),
        eq(professionalServices.professionalId, professionalId),
        isNull(services.deletedAt)
      )
    )
    .orderBy(asc(services.nome));

  return linhas.map((l) => {
    const precoCentavos = l.precoProprio ?? l.precoPadrao;
    const duracaoMinutos = l.duracaoPropria ?? l.duracaoPadrao;
    return {
      serviceId: l.serviceId,
      nome: l.nome,
      categoria: l.categoria,
      precoCentavos,
      precoFormatado: formatarBRL(precoCentavos),
      duracaoMinutos,
      precoProprio: l.precoProprio != null,
      duracaoPropria: l.duracaoPropria != null,
      precoPadraoCentavos: l.precoPadrao,
      duracaoPadraoMinutos: l.duracaoPadrao
    };
  });
}

export async function listarProfissionais(tenantId, { incluirInativos = false } = {}) {
  const condicoes = [base(tenantId)];
  if (!incluirInativos) condicoes.push(eq(professionals.ativo, true));

  const linhas = await db
    .select()
    .from(professionals)
    .where(and(...condicoes))
    .orderBy(asc(professionals.nome));

  // Uma consulta por profissional seria 1+N; a lista e curta (a equipe de uma
  // barbearia cabe numa mao), mas pedir tudo de uma vez e igualmente simples.
  const acessos = await acessosDe(tenantId, linhas.map((p) => p.userId));
  const todos = await Promise.all(
    linhas.map(async (p) => apresentar(p, await servicosDoProfissional(tenantId, p.id), acessos.get(p.userId) ?? null))
  );
  return todos;
}

export async function obterProfissional(tenantId, id) {
  const p = await db.query.professionals.findFirst({ where: and(base(tenantId), eq(professionals.id, id)) });
  if (!p) throw new NaoEncontrado('Profissional');
  const acessos = await acessosDe(tenantId, [p.userId]);
  return apresentar(p, await servicosDoProfissional(tenantId, id), acessos.get(p.userId) ?? null);
}

/**
 * Cria (ou atualiza) o login do profissional para ele ver a propria agenda.
 *
 * O login nasce com cargo `profissional` e JA ligado a ficha: e o vinculo que
 * diz de quem e a agenda. Se a ficha estava ligada ao login de alguem da
 * equipe, o vinculo passa para o login novo — a pessoa continua existindo,
 * so deixa de ser "este profissional".
 *
 * Com acesso ja criado: troca o usuario e/ou a senha (trocar a senha derruba
 * as sessoes abertas, como em qualquer funcionario).
 */
export async function definirAcesso(tenantId, id, { username, senha }, { usuario }) {
  const p = await db.query.professionals.findFirst({ where: and(base(tenantId), eq(professionals.id, id)) });
  if (!p) throw new NaoEncontrado('Profissional');
  const atual = (await acessosDe(tenantId, [p.userId])).get(p.userId);

  if (atual) {
    await authService.editarUsuario({
      solicitante: usuario,
      tenantId,
      id: atual.userId,
      dados: { username, nome: p.nome, ativo: true, ...(senha ? { novaSenha: senha } : {}) }
    });
  } else {
    if (!senha) throw new RegraDeNegocio('Defina uma senha para o primeiro acesso.');
    const criado = await authService.criarUsuario({
      solicitante: usuario,
      tenantId,
      username,
      senha,
      nome: p.nome,
      cargo: 'profissional',
      telefone: p.telefone ?? undefined
    });
    await db.update(professionals).set({ userId: criado.id }).where(and(base(tenantId), eq(professionals.id, id)));
  }

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: atual ? 'profissional.acesso_editar' : 'profissional.acesso_criar',
    entidade: 'profissional',
    entidadeId: id,
    dados: { depois: { username, senha: senha ? 'definida' : undefined } }
  });

  return obterProfissional(tenantId, id);
}

/**
 * Tira o acesso: o login `profissional` e excluido (sessoes caem na hora) e
 * a ficha fica sem login. Ligada ao login de alguem da equipe, so desfaz o
 * vinculo — ninguem perde o proprio acesso por aqui.
 */
export async function removerAcesso(tenantId, id, { usuario }) {
  const p = await db.query.professionals.findFirst({ where: and(base(tenantId), eq(professionals.id, id)) });
  if (!p) throw new NaoEncontrado('Profissional');
  if (!p.userId) return obterProfissional(tenantId, id);

  const atual = (await acessosDe(tenantId, [p.userId])).get(p.userId);
  await db.update(professionals).set({ userId: null }).where(and(base(tenantId), eq(professionals.id, id)));
  if (atual) await authService.excluirUsuario({ solicitante: usuario, tenantId, id: atual.userId });

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'profissional.acesso_remover',
    entidade: 'profissional',
    entidadeId: id,
    dados: { antes: { userId: p.userId, username: atual?.username } }
  });

  return obterProfissional(tenantId, id);
}

export async function criarProfissional(tenantId, dados, { usuario } = {}) {
  const registro = {
    id: ID.profissional(),
    tenantId,
    nome: dados.nome,
    funcao: dados.funcao ?? 'Especialista',
    cor: dados.cor ?? '#3b82f6',
    telefone: dados.telefone ? normalizarTelefone(dados.telefone) : null,
    observacoes: dados.observacoes ?? '',
    userId: dados.userId ?? null,
    ativo: dados.ativo ?? true
  };

  if (dados.jornada) registro.jornada = dados.jornada;
  if (dados.foto) registro.fotoUrl = await salvarImagem(dados.foto, 'profissional');

  await db.insert(professionals).values(registro);

  if (dados.servicos) await definirServicos(tenantId, registro.id, dados.servicos);

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'profissional.criar',
    entidade: 'profissional',
    entidadeId: registro.id,
    dados: { depois: { nome: registro.nome, funcao: registro.funcao } }
  });

  log.info({ tenantId, professionalId: registro.id }, 'Profissional cadastrado');
  return obterProfissional(tenantId, registro.id);
}

export async function atualizarProfissional(tenantId, id, dados, { usuario } = {}) {
  const atual = await db.query.professionals.findFirst({ where: and(base(tenantId), eq(professionals.id, id)) });
  if (!atual) throw new NaoEncontrado('Profissional');

  // O login proprio do profissional so se liga e desliga pelo "acesso"
  // (definirAcesso/removerAcesso): ligar aqui deixaria o login de um
  // profissional apontando para a agenda de outro, e desligar deixaria um
  // login orfao que entra e nao ve nada.
  if (dados.userId !== undefined && (dados.userId ?? null) !== (atual.userId ?? null)) {
    const envolvidos = await acessosDe(tenantId, [atual.userId, dados.userId]);
    if (envolvidos.size > 0) {
      throw new RegraDeNegocio('O acesso do profissional se muda em "Acesso à agenda", na ficha dele.');
    }
  }

  const mudancas = {};
  for (const campo of ['nome', 'funcao', 'cor', 'observacoes', 'jornada', 'ativo', 'userId']) {
    if (dados[campo] !== undefined) mudancas[campo] = dados[campo];
  }
  if (dados.telefone !== undefined) {
    mudancas.telefone = dados.telefone ? normalizarTelefone(dados.telefone) : null;
  }

  if (dados.foto) {
    mudancas.fotoUrl = await salvarImagem(dados.foto, 'profissional');
    // So apaga a antiga depois que a nova esta gravada: se a gravacao falhar,
    // o cadastro continua com a foto que tinha.
    if (atual.fotoUrl) await apagarImagem(atual.fotoUrl);
  } else if (dados.removerFoto) {
    mudancas.fotoUrl = null;
    if (atual.fotoUrl) await apagarImagem(atual.fotoUrl);
  }

  if (Object.keys(mudancas).length > 0) {
    await db.update(professionals).set(mudancas).where(and(base(tenantId), eq(professionals.id, id)));
  }

  if (dados.servicos) await definirServicos(tenantId, id, dados.servicos);

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'profissional.atualizar',
    entidade: 'profissional',
    entidadeId: id,
    dados: { depois: mudancas }
  });

  return obterProfissional(tenantId, id);
}

/**
 * Define quais servicos o profissional faz, e por quanto.
 *
 * Substitui a lista inteira: e como a ficha funciona na tela (marca e desmarca
 * servicos, ajusta valores, salva). `precoCentavos`/`duracaoMinutos` nulos
 * significam "usa o padrao do servico" — nao zero.
 *
 * @param {{serviceId: string, precoCentavos?: number|null, duracaoMinutos?: number|null}[]} lista
 */
export async function definirServicos(tenantId, professionalId, lista) {
  const existe = await db.query.professionals.findFirst({
    where: and(base(tenantId), eq(professionals.id, professionalId))
  });
  if (!existe) throw new NaoEncontrado('Profissional');

  const validos = await db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.tenantId, tenantId), isNull(services.deletedAt)));
  const conhecidos = new Set(validos.map((s) => s.id));

  for (const item of lista) {
    if (!conhecidos.has(item.serviceId)) {
      throw new RegraDeNegocio('Um dos servicos escolhidos nao existe mais.');
    }
  }

  await db
    .delete(professionalServices)
    .where(
      and(
        eq(professionalServices.tenantId, tenantId),
        eq(professionalServices.professionalId, professionalId)
      )
    );

  if (lista.length > 0) {
    await db.insert(professionalServices).values(
      lista.map((item) => ({
        tenantId,
        professionalId,
        serviceId: item.serviceId,
        precoCentavos: item.precoCentavos ?? null,
        duracaoMinutos: item.duracaoMinutos ?? null
      }))
    );
  }

  return servicosDoProfissional(tenantId, professionalId);
}

/**
 * Tira o profissional de circulação.
 *
 * Nao apaga de verdade quando ele ja tem agendamento: o historico e o
 * faturamento apontam para ele, e sumir com a linha deixaria a agenda antiga
 * cheia de atendimentos sem dono. Nesse caso, desativa — some das telas de
 * marcar horario e continua no historico.
 */
export async function excluirProfissional(tenantId, id, { usuario } = {}) {
  const p = await db.query.professionals.findFirst({ where: and(base(tenantId), eq(professionals.id, id)) });
  if (!p) throw new NaoEncontrado('Profissional');

  // Basta UMA linha para decidir: nao interessa quantos agendamentos ele tem,
  // so se tem algum. `limit(1)` evita varrer a agenda inteira de quem trabalha
  // na casa ha anos.
  const [comAgendamento] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(and(eq(appointments.tenantId, tenantId), eq(appointments.professionalId, id)))
    .limit(1);

  const temHistorico = Boolean(comAgendamento);

  // Saiu da equipe: o login da agenda dele morre junto (sessoes caem na hora).
  if ((await acessosDe(tenantId, [p.userId])).size > 0) await removerAcesso(tenantId, id, { usuario });

  if (temHistorico) {
    await db.update(professionals).set({ ativo: false }).where(and(base(tenantId), eq(professionals.id, id)));
  } else {
    await db
      .update(professionals)
      .set({ deletedAt: new Date(), ativo: false })
      .where(and(base(tenantId), eq(professionals.id, id)));
  }

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: temHistorico ? 'profissional.desativar' : 'profissional.excluir',
    entidade: 'profissional',
    entidadeId: id,
    dados: { antes: { nome: p.nome } }
  });

  return {
    ok: true,
    desativado: temHistorico,
    mensagem: temHistorico
      ? `${p.nome} foi desativado: ele tem atendimentos no historico e nao pode ser apagado.`
      : `${p.nome} foi removido.`
  };
}

// ============================================================================
// ATENDENTES (quem usa o sistema)
// ============================================================================

export async function listarAtendentes(tenantId) {
  // Quantas conversas abertas estao com cada um AGORA — a mesma conta que a
  // distribuicao usa para saber quem esta na capacidade maxima. Com a equipe
  // grande, e o que mostra de relance quem esta sobrecarregado.
  // `"users"."id"` por extenso: ver `atendentesDisponiveis` (conversas.repo).
  const emAtendimento = sql`(
    SELECT COUNT(*) FROM ${conversations}
    WHERE ${conversations.assignedUserId} = ${sql.identifier('users')}.${sql.identifier('id')}
      AND ${conversations.status} != 'finalizada'
      AND ${conversations.deletedAt} IS NULL
  )`;

  const linhas = await db
    .select({
      id: users.id,
      nome: users.nome,
      username: users.username,
      email: users.email,
      telefone: users.telefone,
      cargo: users.cargo,
      ativo: users.ativo,
      statusPresenca: users.statusPresenca,
      capacidadeSimultanea: users.capacidadeSimultanea,
      ultimoLoginEm: users.ultimoLoginEm,
      avatar: users.avatar,
      emAtendimento: emAtendimento.as('em_atendimento')
    })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt)))
    .orderBy(asc(users.nome));

  // O perfil de desenvolvimento nao e gente da empresa: nao aparece na equipe.
  // O login `profissional` aparece na ficha do profissional, nao aqui.
  return linhas.filter((u) => u.cargo !== 'dev' && u.cargo !== 'profissional').map((u) => ({ ...u, emAtendimento: Number(u.emAtendimento) || 0 }));
}
