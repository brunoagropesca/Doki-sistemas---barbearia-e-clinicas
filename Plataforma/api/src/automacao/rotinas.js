import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { settings } from '../db/schema/ai.js';
import { tenants } from '../db/schema/tenants.js';
import { dataNoFuso, FUSO_PADRAO, horaNoFuso } from '../core/datetime.js';
import { comContexto } from '../core/logger.js';
import { ver } from '../core/painel.js';
import { atenaPermite } from '../ai/permissoes.js';
import * as quadro from '../modules/quadro/quadro.service.js';
import { licencaBloqueada } from '../licenca/licenca.js';

const log = comContexto({ modulo: 'rotinas' });

/**
 * Rotinas da Atena: o que ela faz sozinha por relogio, sem ninguem pedir.
 *
 * Hoje e uma: o FECHAMENTO DO DIA. No horario configurado, ela encerra as
 * sessoes de atendimento das ordens ja finalizadas e arquiva o que terminou.
 * A regra de ouro do fechamento continua valendo aqui: ela NUNCA conclui um
 * atendimento por conta propria. Um horario ainda "confirmado" as 22h pode ter
 * acontecido sem ninguem marcar, ou o cliente pode ter faltado — coisas que
 * mudam o faturamento de jeitos opostos. Essas ficam para uma pessoa decidir.
 *
 * So roda com a permissao "Fechar o dia sozinha" ligada na Central de IA.
 */

/** Quem assina as acoes automaticas na auditoria. `cargo` deixa finalizar qualquer conversa. */
const USUARIO_AUTOMATICO = { nome: 'Atena (IA)', cargo: 'admin' };

const HORA_PADRAO = '22:00';
const INTERVALO_MS = 60_000;

async function lerConfig(tenantId, chave, padrao) {
  const linha = await db.query.settings.findFirst({
    where: and(eq(settings.tenantId, tenantId), eq(settings.chave, chave))
  });
  return linha?.valor ?? padrao;
}

async function gravarConfig(tenantId, chave, valor) {
  const existe = await db.query.settings.findFirst({
    where: and(eq(settings.tenantId, tenantId), eq(settings.chave, chave))
  });
  if (existe) {
    await db.update(settings).set({ valor }).where(and(eq(settings.tenantId, tenantId), eq(settings.chave, chave)));
  } else {
    await db.insert(settings).values({ tenantId, chave, valor });
  }
}

/**
 * Fecha o dia de UMA empresa, se for hora e ainda nao tiver fechado hoje.
 *
 * "Ja fechou hoje" e gravado no banco, nao em memoria: se o servidor reiniciar
 * as 22h05, ele nao fecha o mesmo dia duas vezes. E a marca so e gravada
 * DEPOIS de o fechamento dar certo — se falhar, tenta de novo no minuto seguinte.
 *
 * @param {string} tenantId
 * @param {number} [agora] instante em ms (injetavel nos testes)
 * @returns {Promise<object|null>} o resultado do fechamento, ou null se nao era hora
 */
export async function fecharDiaSeForHora(tenantId, agora = Date.now()) {
  if (!(await atenaPermite(tenantId, 'rotina'))) return null;

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  const fuso = tenant?.fusoHorario || FUSO_PADRAO;

  const hoje = dataNoFuso(agora, fuso);
  const horaAgora = horaNoFuso(agora, fuso);
  const horaFechamento = await lerConfig(tenantId, 'fechamento_hora', HORA_PADRAO);

  // "HH:MM" compara certo como texto quando os dois tem dois digitos.
  if (horaAgora < horaFechamento) return null;
  if ((await lerConfig(tenantId, 'fechamento_ultimo', null)) === hoje) return null;

  log.info({ tenantId, data: hoje, hora: horaAgora }, 'Atena fechando o dia');
  ver('atena', 'fechando o dia (rotina automatica)', `${hoje} · ${horaAgora}`);

  const resultado = await quadro.fecharDia(
    tenantId,
    { data: hoje, encerrarOciosas: true },
    USUARIO_AUTOMATICO
  );

  await gravarConfig(tenantId, 'fechamento_ultimo', hoje);
  return resultado;
}

/** Roda as rotinas de todas as empresas. Uma falhar nao impede as outras. */
export async function executarRotinas(agora = Date.now()) {
  // Licenca vencida: nada automatico roda (o backup diario, sim — fica fora daqui).
  if (licencaBloqueada()) return [];
  const empresas = await db.select({ id: tenants.id }).from(tenants);
  const resultados = [];

  for (const { id } of empresas) {
    try {
      const r = await fecharDiaSeForHora(id, agora);
      if (r) resultados.push({ tenantId: id, ...r });
    } catch (err) {
      log.error({ err, tenantId: id }, 'Rotina de fechamento falhou; tenta de novo no proximo minuto');
    }
  }
  return resultados;
}

/**
 * Liga o relogio das rotinas. Devolve a funcao que o desliga.
 *
 * Fica FORA de `criarApp` de proposito: um timer solto dentro de cada app de
 * teste deixaria o processo vivo e os testes sem terminar.
 */
export function iniciarRotinas() {
  let rodando = false;

  const timer = setInterval(async () => {
    if (rodando) return; // fechamento lento nao empilha outro por cima
    rodando = true;
    try {
      await executarRotinas();
    } catch (err) {
      // Excecao solta derrubaria o processo (ver `unhandledRejection` em main.js).
      log.error({ err }, 'Falha nas rotinas');
    } finally {
      rodando = false;
    }
  }, INTERVALO_MS);

  timer.unref?.();
  log.info({ horaPadrao: HORA_PADRAO }, 'Rotinas da Atena ligadas');
  return () => clearInterval(timer);
}

export { HORA_PADRAO, lerConfig, gravarConfig };
