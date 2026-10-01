import { and, eq, inArray, isNull, like } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { teamAlerts, users } from '../../db/schema/auth.js';
import { channelInstances } from '../../db/schema/conversations.js';
import { emitir, EVENTOS } from '../../core/eventos.js';
import { comContexto } from '../../core/logger.js';
import { ID } from '../../core/ids.js';

const log = comContexto({ modulo: 'vigia-whatsapp' });

/**
 * Vigia dos numeros de WhatsApp: avisa o DONO e os ADMINISTRADORES quando um
 * numero cai e nao volta.
 *
 * O WhatsApp aqui e o Baileys, uma biblioteca NAO oficial: o numero pode cair
 * (rede, celular sem bateria, o WhatsApp encerrando a sessao, banimento). Enquanto
 * esta fora, cliente que escreve nao e atendido — e ninguem percebe olhando a
 * tela de conversas. Por isso o aviso URGENTE (o popup por cima de tudo dos
 * avisos da gerencia), UMA vez por queda:
 *
 *   - queda comum (rede): o adaptador tenta voltar sozinho. So avisa se nao
 *     voltar em 5 minutos — oscilacao de segundos nao merece alarme;
 *   - queda que NAO volta sozinha (sessao encerrada pelo celular, conta
 *     recusada, sessao invalida, conta aberta em outro lugar): avisa na hora;
 *   - o numero voltou: o aviso some da tela de quem ainda nao confirmou.
 *
 * So vigia numero que ESTAVA conectado (ou que a subida do sistema tenta
 * reconectar): QR Code expirado durante o pareamento nao e queda.
 * Desconectar de proposito (botao Desconectar) tambem nao.
 *
 * Os avisos sao achados pelo banco (remetente + chave na mensagem), entao
 * fechar funciona mesmo depois de reiniciar o servidor.
 */

/** Remetente dos avisos do sistema. Eles aparecem mesmo com "Avisos da gerencia" desligado. */
export const REMETENTE_SISTEMA = 'Sistema (WhatsApp)';
export const ESPERA_ANTES_DE_AVISAR_MS = 5 * 60_000;

/** id da instancia -> { conectada, esperada, alertou, timer } */
const estados = new Map();

let agendar = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancelar: () => clearTimeout(t) };
};

const idDe = (tenantId, chave) => `${tenantId}:${chave}`;
const estadoDe = (tenantId, chave) => {
  const id = idDe(tenantId, chave);
  if (!estados.has(id)) estados.set(id, { conectada: false, esperada: false, alertou: false, timer: null });
  return estados.get(id);
};
const pararRelogio = (e) => {
  e.timer?.cancelar();
  e.timer = null;
};

/** O texto que identifica a queda deste numero na mensagem (e o que acha o aviso depois). */
const marcaDoNumero = (chave) => `[${chave}]`;

/** O numero conectou (ou voltou): fecha o aviso, se houve. */
export async function aoConectar(tenantId, chave) {
  const e = estadoDe(tenantId, chave);
  e.conectada = true;
  e.esperada = false;
  e.alertou = false;
  pararRelogio(e);
  await fecharAvisos(tenantId, chave);
}

/**
 * O numero caiu.
 * @param {{ definitiva?: boolean, motivo?: string }} [p]
 *   definitiva: nao volta sozinho (avisa na hora); motivo: o que o dono le no aviso
 */
export async function aoCair(tenantId, chave, { definitiva = false, motivo = null } = {}) {
  const e = estadoDe(tenantId, chave);
  if (!e.conectada && !e.esperada) return; // nunca esteve no ar (pareamento): nao e queda
  e.conectada = false;
  if (e.alertou) return; // uma vez por queda

  if (definitiva) {
    pararRelogio(e);
    return avisar(tenantId, chave, { motivo, definitiva: true });
  }
  if (!e.timer) {
    e.timer = agendar(() => {
      e.timer = null;
      // Devolve a promessa: os testes esperam o aviso terminar de ser gravado.
      if (!e.conectada && !e.alertou) return avisar(tenantId, chave, { motivo }).catch(() => {});
    }, ESPERA_ANTES_DE_AVISAR_MS);
  }
}

/**
 * A subida do sistema esta reconectando um numero que estava no ar: se nao
 * conectar em 5 minutos (ex.: a sessao foi encerrada com o servidor desligado),
 * avisa como uma queda.
 */
export function esperarConexao(tenantId, chave) {
  const e = estadoDe(tenantId, chave);
  e.esperada = true;
  if (!e.timer && !e.conectada) {
    e.timer = agendar(() => {
      e.timer = null;
      if (!e.conectada && !e.alertou) return avisar(tenantId, chave, {}).catch(() => {});
    }, ESPERA_ANTES_DE_AVISAR_MS);
  }
}

/** Desconectado de proposito (botao Desconectar / Sair): nada a vigiar, e o aviso que houver some. */
export async function aoDesconectarDeProposito(tenantId, chave) {
  const e = estadoDe(tenantId, chave);
  e.conectada = false;
  e.esperada = false;
  e.alertou = false;
  pararRelogio(e);
  await fecharAvisos(tenantId, chave);
}

async function avisar(tenantId, chave, { motivo, definitiva = false }) {
  const e = estadoDe(tenantId, chave);
  e.alertou = true;

  const instancia = await db.query.channelInstances.findFirst({
    where: and(eq(channelInstances.tenantId, tenantId), eq(channelInstances.chave, chave))
  });
  const nome = instancia?.nome ?? chave;
  const oQue = definitiva
    ? `desconectou${motivo ? `: ${motivo}` : '.'}`
    : `caiu e não voltou sozinho em ${Math.round(ESPERA_ANTES_DE_AVISAR_MS / 60_000)} minutos.`;
  const mensagem =
    `O WhatsApp "${nome}" ${marcaDoNumero(chave)} ${oQue} ` +
    'Enquanto ele estiver fora, quem escrever para esse número não é atendido. ' +
    'Abra Conexões e clique em Conectar (se pedir, leia o QR Code de novo pelo celular).';

  const destinatarios = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        inArray(users.cargo, ['owner', 'admin']),
        eq(users.ativo, true),
        isNull(users.deletedAt)
      )
    );

  for (const { id } of destinatarios) {
    await db.insert(teamAlerts).values({ id: ID.aviso(), tenantId, userId: id, deUserId: null, deNome: REMETENTE_SISTEMA, mensagem });
    emitir(EVENTOS.AVISO, { tenantId, userId: id });
  }
  log.warn({ tenantId, chave, definitiva, avisados: destinatarios.length }, 'Numero de WhatsApp fora do ar: dono e administradores avisados');
}

/** Tira da tela os avisos deste numero que ainda nao foram confirmados. */
async function fecharAvisos(tenantId, chave) {
  const abertos = await db
    .select({ id: teamAlerts.id, userId: teamAlerts.userId })
    .from(teamAlerts)
    .where(
      and(
        eq(teamAlerts.tenantId, tenantId),
        eq(teamAlerts.deNome, REMETENTE_SISTEMA),
        like(teamAlerts.mensagem, `%${marcaDoNumero(chave)}%`),
        isNull(teamAlerts.lidoEm),
        isNull(teamAlerts.canceladoEm)
      )
    );
  if (abertos.length === 0) return;
  await db
    .update(teamAlerts)
    .set({ canceladoEm: new Date() })
    .where(inArray(teamAlerts.id, abertos.map((a) => a.id)));
  for (const userId of new Set(abertos.map((a) => a.userId))) emitir(EVENTOS.AVISO, { tenantId, userId });
}

/** So para os testes: troca o agendador (para nao esperar 5 minutos) e zera a memoria. */
export function _paraTestes({ agendador } = {}) {
  for (const e of estados.values()) pararRelogio(e);
  estados.clear();
  agendar =
    agendador ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return { cancelar: () => clearTimeout(t) };
    });
}
