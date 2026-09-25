import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { settings } from '../db/schema/ai.js';
import { tenants } from '../db/schema/tenants.js';
import { dataNoFuso, FUSO_PADRAO, horaNoFuso, somarDias } from '../core/datetime.js';
import { comContexto } from '../core/logger.js';
import { mascarar } from '../core/phone.js';
import { ver } from '../core/painel.js';
import { atenaPermite } from '../ai/permissoes.js';
import * as quadro from '../modules/quadro/quadro.service.js';
import * as agenda from '../modules/agenda/agenda.service.js';
import * as conversas from '../modules/conversas/conversas.service.js';
import { mensagemAoCliente } from '../modules/textos/textos.js';
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

const LEMBRETE_HORA_PADRAO = '18:00';

/**
 * LEMBRETE DE VESPERA — o que mais reduz falta numa barbearia.
 *
 * Desligado por padrao (`lembrete_ativo`): mandar mensagem ao cliente e
 * decisao do dono. A partir de `lembrete_hora` (padrao 18:00), manda UMA
 * mensagem por cliente com todos os horarios de amanha (quem marcou corte e
 * barba recebe um lembrete so), pela conexao em que ele ja conversa.
 *
 * Nao repete: cada OS ganha `lembreteEnviadoEm` logo que o envio da certo —
 * rodar de novo (ou reiniciar o servidor) nao manda outra vez. Canal fora do
 * ar: nada e marcado e tenta de novo no proximo minuto. A resposta do cliente
 * ("preciso remarcar") cai na conversa normal, com a Sofia.
 *
 * @param {string} tenantId
 * @param {object} p
 * @param {Function} p.enviar   como `gateway.enviarMensagem` (injetado: as rotinas nao dependem do canal)
 * @param {number} [p.agora]
 * @returns {Promise<{ data: string, enviados: number, falhas: number }|null>} null = nao era para rodar
 */
export async function enviarLembretesSeForHora(tenantId, { enviar, agora = Date.now() } = {}) {
  if (!enviar || !(await lerConfig(tenantId, 'lembrete_ativo', false))) return null;

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  const fuso = tenant?.fusoHorario || FUSO_PADRAO;
  if (horaNoFuso(agora, fuso) < (await lerConfig(tenantId, 'lembrete_hora', LEMBRETE_HORA_PADRAO))) return null;

  const amanha = somarDias(dataNoFuso(agora, fuso), 1);
  const aLembrar = (await agenda.listar(tenantId, { data: amanha })).filter(
    (a) => ['pendente', 'confirmado'].includes(a.status) && !a.lembreteEnviadoEm && a.leadTelefone
  );

  let enviados = 0;
  let falhas = 0;
  for (const lista of Map.groupBy(aLembrar, (a) => a.leadId).values()) {
    const [a] = lista;
    const itens = lista
      .sort((x, y) => x.horaInicio.localeCompare(y.horaInicio))
      .map((x) => `${x.servicoNome} às ${x.horaInicio} com ${x.profissionalNome.split(' ')[0]}`)
      .join('; ');
    const texto = (await mensagemAoCliente(tenantId, 'lembrete.vespera'))
      .replace('{nome}', a.leadNome.split(' ')[0])
      .replace('{itens}', itens);
    const conexao = await conversas.conexaoDoLead(tenantId, a.leadId);

    try {
      await enviar({ tenantId, instanciaChave: conexao.chave, destino: a.leadTelefone, texto, digitandoMs: 1500 });
    } catch (err) {
      // Canal fora do ar: nada marcado, tenta de novo no proximo minuto.
      falhas += 1;
      log.warn({ err, tenantId, leadId: a.leadId }, 'Lembrete nao enviado; tenta de novo no proximo minuto');
      continue;
    }

    // Marca LOGO depois do envio: se o registro na conversa falhar, o cliente
    // nao pode receber o mesmo lembrete de novo no minuto seguinte.
    await agenda.marcarLembreteEnviado(tenantId, lista.map((x) => x.id), new Date(agora));
    enviados += 1;
    ver('atena', `lembrete de véspera enviado a ${a.leadNome}`, `${mascarar(a.leadTelefone)} · ${lista.length} horário(s)`);

    // Fica no fio da conversa: quem abrir o livechat ve que o lembrete saiu.
    try {
      const conversationId = await conversas.encontrarOuAbrir(tenantId, { leadId: a.leadId, channelInstanceId: conexao.channelInstanceId });
      await conversas.registrarEnviada(tenantId, conversationId, { conteudo: texto, autorTipo: 'ia', metadados: { tipo: 'lembrete' } });
    } catch (err) {
      log.warn({ err, tenantId, leadId: a.leadId }, 'Lembrete enviado, mas nao registrado na conversa');
    }
  }

  if (enviados || falhas) log.info({ tenantId, data: amanha, enviados, falhas }, 'Lembretes de vespera');
  return { data: amanha, enviados, falhas };
}

/**
 * Roda as rotinas de todas as empresas. Uma falhar nao impede as outras.
 *
 * @param {number} [agora]
 * @param {object} [p]
 * @param {Function} [p.enviar]  como `gateway.enviarMensagem`; sem ele, os lembretes nao rodam
 */
export async function executarRotinas(agora = Date.now(), { enviar } = {}) {
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
    try {
      const l = await enviarLembretesSeForHora(id, { enviar, agora });
      if (l?.enviados) resultados.push({ tenantId: id, lembretes: l });
    } catch (err) {
      log.error({ err, tenantId: id }, 'Rotina de lembretes falhou; tenta de novo no proximo minuto');
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
export function iniciarRotinas({ enviar } = {}) {
  let rodando = false;

  const timer = setInterval(async () => {
    if (rodando) return; // fechamento lento nao empilha outro por cima
    rodando = true;
    try {
      await executarRotinas(Date.now(), { enviar });
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
