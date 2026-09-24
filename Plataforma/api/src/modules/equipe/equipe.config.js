import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { settings } from '../../db/schema/ai.js';
import { professionals } from '../../db/schema/crm.js';
import { NIVEL_CARGO } from '../../db/schema/auth.js';

/**
 * Como a empresa divide o atendimento entre as pessoas da equipe.
 *
 * Duas decisoes moram aqui, e as duas aparecem em Equipe > Atendentes:
 *
 *   PRIVACIDADE — quem enxerga o atendimento de quem. O padrao e o mais
 *   fechado: cada atendente ve o que e dele, e so o dono ve tudo. Numa equipe
 *   onde cada um tem a propria carteira de clientes, ver a conversa do colega
 *   nao e conveniencia, e exposicao — do cliente e do colega.
 *
 *   DISTRIBUICAO — como a conversa que pede atendimento humano chega a alguem.
 *
 * Vale reparar que privacidade e CONFIGURACAO, nao codigo: uma barbearia de
 * dois irmaos quer ver tudo, uma clinica com dez profissionais nao. Por isso
 * `aberto` existe e e uma escolha legitima.
 */

/** Quem enxerga o atendimento dos outros. */
export const PRIVACIDADE = {
  /** So o dono. Gerentes e atendentes veem apenas o proprio. (Padrao.) */
  dono: {
    rotulo: 'Somente o dono',
    descricao: 'Cada pessoa vê apenas os atendimentos dela. Só o dono enxerga os de toda a equipe.',
    nivelQueVeTudo: NIVEL_CARGO.owner
  },
  /** Dono e administradores. */
  gerencia: {
    rotulo: 'Dono e administradores',
    descricao: 'Quem tem perfil de administrador também acompanha os atendimentos de toda a equipe.',
    nivelQueVeTudo: NIVEL_CARGO.admin
  },
  /** Todo mundo ve tudo — como era antes de existir esta configuracao. */
  aberto: {
    rotulo: 'Equipe inteira',
    descricao: 'Todos veem todos os atendimentos. Indicado para equipes pequenas que se revezam.',
    nivelQueVeTudo: NIVEL_CARGO.atendente
  }
};

export const CRITERIOS_DISTRIBUICAO = {
  menos_carregado: {
    rotulo: 'Quem tem menos conversas',
    descricao: 'A próxima conversa vai para quem está com menos atendimentos abertos no momento.'
  },
  rodizio: {
    rotulo: 'Rodízio (fila)',
    descricao: 'As conversas circulam pela equipe em ordem, para todos receberem a mesma quantidade.'
  }
};

const PADRAO = {
  privacidade: 'dono',
  distribuicaoAutomatica: true,
  criterioDistribuicao: 'menos_carregado',
  distribuirSomenteOnline: true,
  distribuirParaGerencia: false
};

/** Chave em `settings` de cada campo. */
const CHAVES = {
  privacidade: 'atendimento_privacidade',
  distribuicaoAutomatica: 'distribuicao_automatica',
  criterioDistribuicao: 'distribuicao_criterio',
  distribuirSomenteOnline: 'distribuicao_somente_online',
  distribuirParaGerencia: 'distribuicao_inclui_gerencia'
};

async function ler(tenantId, chave, padrao) {
  const linha = await db.query.settings.findFirst({
    where: and(eq(settings.tenantId, tenantId), eq(settings.chave, chave))
  });
  return linha?.valor ?? padrao;
}

async function gravar(tenantId, chave, valor) {
  const existe = await db.query.settings.findFirst({
    where: and(eq(settings.tenantId, tenantId), eq(settings.chave, chave))
  });
  if (existe) {
    await db.update(settings).set({ valor }).where(and(eq(settings.tenantId, tenantId), eq(settings.chave, chave)));
  } else {
    await db.insert(settings).values({ tenantId, chave, valor });
  }
}

export async function obterConfiguracao(tenantId) {
  const valores = await Promise.all(
    Object.entries(CHAVES).map(async ([campo, chave]) => [campo, await ler(tenantId, chave, PADRAO[campo])])
  );

  return {
    ...PADRAO,
    ...Object.fromEntries(valores),
    opcoes: {
      privacidade: Object.entries(PRIVACIDADE).map(([chave, v]) => ({ chave, ...v })),
      criterios: Object.entries(CRITERIOS_DISTRIBUICAO).map(([chave, v]) => ({ chave, ...v }))
    }
  };
}

export async function salvarConfiguracao(tenantId, dados) {
  for (const [campo, chave] of Object.entries(CHAVES)) {
    if (dados[campo] !== undefined) await gravar(tenantId, chave, dados[campo]);
  }
  return obterConfiguracao(tenantId);
}

/**
 * O que ESTA pessoa pode enxergar.
 *
 * Devolve `{ tudo: true }` para quem acompanha a equipe inteira, ou a lista do
 * que e dela. As consultas usam isso para filtrar; quem chama sem usuario
 * (a Atena, as rotinas automaticas, o gateway) recebe `tudo` — elas agem em
 * nome do sistema, nao de um atendente.
 *
 * `professionalIds` existe porque na AGENDA "meu atendimento" tem outro
 * sentido: e o horario que EU vou executar. Um barbeiro com login ve a propria
 * agenda; a recepcionista ve o que ela marcou e o que veio das conversas dela.
 */
export async function escopoDe(tenantId, usuario) {
  // Sem usuario, ou usuario sem id, quem age e o SISTEMA: a Atena, as rotinas
  // automaticas, o gateway do WhatsApp. Elas nao tem carteira de clientes e
  // precisam enxergar tudo para funcionar. Gente de verdade sempre tem id,
  // porque ele vem do token da sessao.
  if (!usuario?.id) return { tudo: true };

  const { privacidade } = await obterConfiguracao(tenantId);
  const nivelQueVeTudo = PRIVACIDADE[privacidade]?.nivelQueVeTudo ?? PRIVACIDADE.dono.nivelQueVeTudo;

  // O perfil `dev` configura a plataforma: enxerga tudo em qualquer modo.
  if ((NIVEL_CARGO[usuario.cargo] ?? 0) >= nivelQueVeTudo) return { tudo: true };

  const vinculos = await db
    .select({ id: professionals.id })
    .from(professionals)
    .where(
      and(
        eq(professionals.tenantId, tenantId),
        eq(professionals.userId, usuario.id),
        isNull(professionals.deletedAt)
      )
    );

  return {
    tudo: false,
    userId: usuario.id,
    professionalIds: vinculos.map((v) => v.id)
  };
}

/** Atalho de leitura: esta pessoa acompanha a equipe inteira? */
export async function veTudo(tenantId, usuario) {
  return (await escopoDe(tenantId, usuario)).tudo;
}

/** Quem recebeu a ultima conversa pelo rodizio. Veja `proximoDoRodizio`. */
export async function lerEstadoRodizio(tenantId) {
  return ler(tenantId, 'distribuicao_rodizio_ultimo', null);
}

export async function salvarEstadoRodizio(tenantId, userId) {
  await gravar(tenantId, 'distribuicao_rodizio_ultimo', userId);
}
