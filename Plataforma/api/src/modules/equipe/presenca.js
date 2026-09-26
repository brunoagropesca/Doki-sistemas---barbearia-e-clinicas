import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users } from '../../db/schema/auth.js';
import { comContexto } from '../../core/logger.js';
import { emitir, EVENTOS } from '../../core/eventos.js';

const log = comContexto({ modulo: 'presenca' });

/**
 * Presenca = painel aberto.
 *
 * O PROBLEMA: so o botao "Sair" punha a pessoa offline. Quem fechava o
 * navegador as 18h continuava "online" — e a distribuicao entregava a ela o
 * cliente que pedia uma pessoa as 8h do dia seguinte. O cliente ficava
 * esperando alguem que nao estava la.
 *
 * O painel ja mantem aberta a conexao de tempo real (/api/eventos). Enquanto
 * ha pelo menos uma aba aberta, a pessoa esta la. Quando a ULTIMA fecha,
 * esperamos um prazo (queda de internet rapida, recarregar a pagina) e, se
 * ninguem reabriu, 'online' vira 'ausente'. Reabrindo, volta para 'online'.
 *
 * O sistema so mexe no que ELE mudou: a troca e condicional (so de 'online'
 * para 'ausente', e de volta so para quem o sistema tirou). Quem escolheu
 * "ausente" na mao nunca e mexido — e nao volta sozinho para online.
 *
 * Estado em memoria, por processo: e o que da para saber sem o banco (quem
 * esta com a tela aberta AGORA). Ao reiniciar o servidor, ver
 * `marcarAusentesSemPainel`.
 */

/** Quanto tempo sem painel aberto ate a pessoa sair da distribuicao. */
export const AUSENTE_APOS_MS = 5 * 60_000;

const conexoes = new Map(); // userId -> abas abertas
const timers = new Map(); // userId -> timer que vai tira-lo
const tiradosPeloSistema = new Set(); // quem o SISTEMA pos em 'ausente'

/** Troca a presenca so se ela ainda for `de`. Devolve true se mudou. */
async function trocar(tenantId, userId, de, para) {
  const r = await db
    .update(users)
    .set({ statusPresenca: para })
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId), eq(users.statusPresenca, de)));
  const mudou = (r.rowsAffected ?? r.changes ?? 0) > 0;
  if (mudou) {
    log.info({ tenantId, userId, de, para }, 'Presenca ajustada pelo painel aberto/fechado');
    // O painel da equipe e o da distribuicao atualizam sozinhos.
    emitir(EVENTOS.CONVERSA, { tenantId });
  }
  return mudou;
}

/** Uma aba do painel abriu a conexao de tempo real. */
export async function painelAberto(tenantId, userId) {
  conexoes.set(userId, (conexoes.get(userId) ?? 0) + 1);

  const timer = timers.get(userId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(userId);
  }

  if (tiradosPeloSistema.has(userId)) {
    tiradosPeloSistema.delete(userId);
    await trocar(tenantId, userId, 'ausente', 'online').catch((err) =>
      log.warn({ err, userId }, 'Nao consegui voltar a presenca para online')
    );
  }
}

/**
 * Uma aba fechou. Se ainda ha outras, nada muda. Na ultima, agenda a saida
 * da distribuicao para daqui a `aposMs` — cancelada se o painel reabrir.
 */
export function painelFechado(tenantId, userId, { aposMs = AUSENTE_APOS_MS } = {}) {
  const restantes = Math.max(0, (conexoes.get(userId) ?? 0) - 1);
  if (restantes > 0) {
    conexoes.set(userId, restantes);
    return;
  }
  conexoes.delete(userId);

  clearTimeout(timers.get(userId));
  const timer = setTimeout(async () => {
    timers.delete(userId);
    if (conexoes.get(userId)) return; // reabriu nesse meio tempo
    try {
      if (await trocar(tenantId, userId, 'online', 'ausente')) tiradosPeloSistema.add(userId);
    } catch (err) {
      log.warn({ err, userId }, 'Nao consegui marcar ausente quem fechou o painel');
    }
  }, aposMs);
  timer.unref?.();
  timers.set(userId, timer);
}

/**
 * Ao ligar o servidor ninguem esta conectado ainda. Passado o prazo, quem
 * continua 'online' no banco sem painel aberto vira 'ausente' (e volta
 * sozinho quando abrir o painel). Cobre quem fechou o navegador com o
 * servidor desligado, ou antes de existir esta regra.
 */
export async function marcarAusentesSemPainel() {
  const online = await db
    .select({ id: users.id, tenantId: users.tenantId })
    .from(users)
    .where(eq(users.statusPresenca, 'online'));

  for (const u of online) {
    if (conexoes.get(u.id)) continue;
    if (await trocar(u.tenantId, u.id, 'online', 'ausente')) tiradosPeloSistema.add(u.id);
  }
}

/** So para os testes: comeca do zero. */
export function _zerarPresenca() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  conexoes.clear();
  tiradosPeloSistema.clear();
}
