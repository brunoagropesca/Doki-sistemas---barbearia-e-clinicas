import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { leads } from '../../db/schema/crm.js';
import { serviceHistory } from '../../db/schema/scheduling.js';
import { conversations } from '../../db/schema/conversations.js';
import { gerar } from '../../ai/cascade.js';
import { atenaPermite } from '../../ai/permissoes.js';
import { comContexto } from '../../core/logger.js';
import { escopoDe } from '../equipe/equipe.config.js';

const log = comContexto({ modulo: 'memoria-cliente' });

/**
 * O que a Sofia LEMBRA de um cliente entre uma conversa e outra.
 *
 * A Sofia le so as ultimas mensagens da conversa ATUAL. Cliente que volta
 * semanas depois cai numa conversa nova, e ela nao sabia o servico de sempre
 * nem com quem ele corta. Mandar o historico cru resolveria e faria o prompt
 * voltar a crescer a cada visita — por isso a memoria e DESTILADA: meia duzia
 * de linhas, com teto (`LIMITE_TEXTO`), mesmo para o cliente de 10 anos.
 *
 * Duas fontes, com confiancas diferentes:
 *   - AGENDA (servico mais feito, profissional preferido, ultima visita): sai
 *     do `service_history`, sem IA. E fato do banco.
 *   - O que o CLIENTE DISSE ("prefere de manha", "alergico a X"): uma chamada
 *     curta de IA sobre o resumo final, que so ACRESCENTA fato novo.
 *
 * Formato gravado em `leads.memoria`:
 *   { agenda, preferencias: string[], observacoes: string[], ocultos, atualizadaEm }
 * `ocultos` guarda o fato de agenda que o atendente mandou esquecer, com o
 * VALOR esquecido: "esquecer o Carlos" nao pode esconder a Ana quando o
 * cliente trocar de profissional.
 */

/** Teto do texto que vai para o prompt: ~100 tokens (4 caracteres por token). */
export const LIMITE_TEXTO = 400;
const MAX_PREFERENCIAS = 5;
const MAX_OBSERVACOES = 3;
const MAX_ITEM = 80;
/** Quantas visitas contam para "de sempre". Cliente antigo nao vira consulta pesada. */
const VISITAS_LIDAS = 30;
/** Frequencia minima para chamar de "de sempre"/"preferido": uma vez so e acaso. */
const MINIMO_PARA_HABITO = 2;

export const FATOS_DA_AGENDA = ['servicoFrequente', 'profissionalPreferido', 'ultimaVisita'];

// ---------------------------------------------------------------------------
// Leitura e normalizacao
// ---------------------------------------------------------------------------

/** Item curto, numa linha so. Preco fica de fora: a trava de preco so aceita o catalogo. */
function limparItem(texto) {
  const t = String(texto ?? '').replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '');
  if (!t || /R\$\s*\d/.test(t)) return '';
  return t.slice(0, MAX_ITEM);
}

/** Tira repetidos (sem diferenciar maiuscula) e respeita o teto, ficando com os MAIS NOVOS. */
function lista(itens, maximo) {
  const vistos = new Set();
  const saida = [];
  for (const bruto of itens ?? []) {
    const item = limparItem(bruto);
    const chave = item.toLocaleLowerCase('pt-BR');
    if (!item || vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(item);
  }
  return saida.slice(-maximo);
}

export function normalizar(memoria) {
  const m = memoria && typeof memoria === 'object' ? memoria : {};
  return {
    agenda: m.agenda ?? null,
    preferencias: lista(m.preferencias, MAX_PREFERENCIAS),
    observacoes: lista(m.observacoes, MAX_OBSERVACOES),
    ocultos: m.ocultos && typeof m.ocultos === 'object' ? m.ocultos : {},
    atualizadaEm: m.atualizadaEm ?? null
  };
}

/** Valor que identifica um fato de agenda (o que `ocultos` compara). */
function valorDoFato(chave, fato) {
  if (!fato) return null;
  return chave === 'ultimaVisita' ? fato.data : fato.nome;
}

/** Os fatos de agenda que ainda valem (tira o que o atendente mandou esquecer). */
export function fatosVisiveis(memoria) {
  const m = normalizar(memoria);
  const fatos = {};
  for (const chave of FATOS_DA_AGENDA) {
    const fato = m.agenda?.[chave];
    if (!fato) continue;
    if (m.ocultos[chave] != null && m.ocultos[chave] === valorDoFato(chave, fato)) continue;
    fatos[chave] = fato;
  }
  return fatos;
}

const dataBR = (iso) => String(iso ?? '').split('-').reverse().join('/');

/**
 * A ficha em texto, para o prompt. Vazia quando nao ha nada a dizer.
 *
 * Linha a linha, na ordem do que mais ajuda; a que estourar o teto fica de
 * fora inteira (meia linha confunde mais do que ajuda). Nunca passa de
 * `LIMITE_TEXTO`.
 */
export function textoDaMemoria(memoria) {
  const m = normalizar(memoria);
  const f = fatosVisiveis(m);
  const linhas = [];
  if (f.servicoFrequente) linhas.push(`- Serviço de sempre: ${f.servicoFrequente.nome} (${f.servicoFrequente.vezes} vezes).`);
  if (f.profissionalPreferido) linhas.push(`- Costuma ser atendido por: ${f.profissionalPreferido.nome}.`);
  if (f.ultimaVisita) {
    const com = f.ultimaVisita.profissional ? ` com ${f.ultimaVisita.profissional}` : '';
    linhas.push(`- Última visita: ${dataBR(f.ultimaVisita.data)}, ${f.ultimaVisita.servico}${com}.`);
  }
  for (const p of m.preferencias) linhas.push(`- ${p}.`);
  for (const o of m.observacoes) linhas.push(`- ${o}.`);

  let texto = '';
  for (const linha of linhas) {
    const proximo = texto ? `${texto}\n${linha}` : linha;
    if (proximo.length > LIMITE_TEXTO) break;
    texto = proximo;
  }
  return texto;
}

/** A ficha para a tela: cada item com a chave que o botao usa para corrigir ou apagar. */
export function apresentarMemoria(memoria) {
  const m = normalizar(memoria);
  const f = fatosVisiveis(m);
  return {
    agenda: FATOS_DA_AGENDA.filter((c) => f[c]).map((chave) => ({ chave, ...f[chave] })),
    preferencias: m.preferencias,
    observacoes: m.observacoes,
    atualizadaEm: m.atualizadaEm,
    texto: textoDaMemoria(m)
  };
}

// ---------------------------------------------------------------------------
// Banco
// ---------------------------------------------------------------------------

async function lerLead(tenantId, leadId) {
  const [linha] = await db
    .select({ memoria: leads.memoria, responsavelId: leads.responsavelId })
    .from(leads)
    .where(and(eq(leads.tenantId, tenantId), eq(leads.id, leadId), isNull(leads.deletedAt)))
    .limit(1);
  return linha ?? null;
}

async function gravar(tenantId, leadId, memoria) {
  await db
    .update(leads)
    .set({ memoria })
    .where(and(eq(leads.tenantId, tenantId), eq(leads.id, leadId), isNull(leads.deletedAt)));
}

/** O texto da ficha para o prompt da Sofia ('' sem ficha). Nunca lanca. */
export async function memoriaParaPrompt(tenantId, leadId) {
  if (!leadId) return '';
  try {
    const lead = await lerLead(tenantId, leadId);
    return lead?.memoria ? textoDaMemoria(lead.memoria) : '';
  } catch (err) {
    // Sem a ficha a Sofia atende como antes; nao vale derrubar a resposta.
    log.warn({ err, tenantId, leadId }, 'Nao foi possivel ler a memoria do cliente');
    return '';
  }
}

/**
 * Fatos de agenda do cliente, direto do historico de atendimentos concluidos.
 * Empate de frequencia fica com o mais recente (a leitura vem do mais novo).
 */
export async function fatosDaAgenda(tenantId, leadId) {
  const visitas = await db
    .select({
      servico: serviceHistory.serviceNome,
      servicoId: serviceHistory.serviceId,
      profissional: serviceHistory.professionalNome,
      profissionalId: serviceHistory.professionalId,
      data: serviceHistory.dataLocal
    })
    .from(serviceHistory)
    .where(
      and(
        eq(serviceHistory.tenantId, tenantId),
        eq(serviceHistory.leadId, leadId),
        eq(serviceHistory.resultado, 'concluido')
      )
    )
    .orderBy(desc(serviceHistory.inicioEm))
    .limit(VISITAS_LIDAS);

  if (!visitas.length) return null;

  // Servico/profissional apagado do cadastro nao vira "de sempre": a Sofia
  // sugeriria algo que nao existe mais.
  const maisFrequente = (campo, idCampo) => {
    const contagem = new Map();
    for (const v of visitas) {
      if (!v[idCampo]) continue;
      contagem.set(v[campo], (contagem.get(v[campo]) ?? 0) + 1);
    }
    let melhor = null;
    for (const [nome, vezes] of contagem) if (!melhor || vezes > melhor.vezes) melhor = { nome, vezes };
    return melhor && melhor.vezes >= MINIMO_PARA_HABITO ? melhor : null;
  };

  const ultima = visitas[0];
  return {
    visitas: visitas.length,
    servicoFrequente: maisFrequente('servico', 'servicoId'),
    profissionalPreferido: maisFrequente('profissional', 'profissionalId'),
    ultimaVisita: {
      data: ultima.data,
      servico: ultima.servico,
      profissional: ultima.profissionalId ? ultima.profissional : null
    }
  };
}

/**
 * Recalcula so a parte de AGENDA (sem IA). Chamada quando um atendimento e
 * concluido — o horario costuma acontecer dias depois de a conversa fechar.
 * Nunca lanca.
 */
export async function atualizarFatosDaAgenda(tenantId, leadId) {
  if (!leadId) return;
  try {
    const lead = await lerLead(tenantId, leadId);
    if (!lead) return;
    const agenda = await fatosDaAgenda(tenantId, leadId);
    const atual = normalizar(lead.memoria);
    if (JSON.stringify(agenda) === JSON.stringify(atual.agenda)) return;
    await gravar(tenantId, leadId, { ...atual, agenda, atualizadaEm: Date.now() });
  } catch (err) {
    log.warn({ err, tenantId, leadId }, 'Nao foi possivel atualizar a agenda na memoria do cliente');
  }
}

// ---------------------------------------------------------------------------
// O que o cliente disse (IA)
// ---------------------------------------------------------------------------

const INSTRUCOES = [
  'Voce mantem a ficha CURTA de um cliente de uma barbearia/clinica.',
  'Recebe o que ja esta anotado e o resumo do ultimo atendimento.',
  'Anote SO fatos NOVOS e DURADOUROS ditos pelo cliente: preferencias (horario, estilo,',
  'como gosta de ser atendido) e cuidados (alergias, restricoes). Cada item: uma frase curta.',
  'NAO anote: servico marcado, data, horario, preco, profissional (isso vem da agenda), nem o',
  'que ja esta anotado, nem suposicoes. Na duvida, nao anote.',
  'Devolva SOMENTE JSON: {"preferencias":["..."],"observacoes":["..."]}.',
  'Nada novo: {"preferencias":[],"observacoes":[]}.'
].join('\n');

/** Le o JSON da resposta, tolerando texto em volta. Resposta estranha = nada novo. */
function lerNovidades(texto) {
  const bruto = String(texto ?? '');
  const inicio = bruto.indexOf('{');
  const fim = bruto.lastIndexOf('}');
  if (inicio < 0 || fim <= inicio) return { preferencias: [], observacoes: [] };
  try {
    const j = JSON.parse(bruto.slice(inicio, fim + 1));
    const soTexto = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    return { preferencias: soTexto(j.preferencias), observacoes: soTexto(j.observacoes) };
  } catch {
    return { preferencias: [], observacoes: [] };
  }
}

async function novidadesDoResumo({ tenantId, conversationId, resumo, atual, provedores }) {
  const anotado = [...atual.preferencias, ...atual.observacoes];
  const r = await gerar({
    tenantId,
    origem: 'memoria',
    conversationId,
    systemPrompt: INSTRUCOES,
    mensagens: [
      {
        papel: 'user',
        conteudo: `Ja anotado: ${anotado.length ? anotado.join('; ') : '(nada)'}\n\nResumo do atendimento:\n${resumo}`
      }
    ],
    temperatura: 0,
    maxTokens: 120,
    timeoutMs: 10_000,
    provedores
  });
  return lerNovidades(r?.texto);
}

/**
 * Atualiza a ficha ao FINALIZAR a conversa: agenda do banco + (com resumo e
 * Atena autorizada a resumir) o que o cliente disse de novo. So acrescenta:
 * nada novo, nada muda. Nunca lanca — a ficha e apoio.
 */
export async function atualizarMemoria(tenantId, leadId, { resumo = null, conversationId = null, provedores = null } = {}) {
  if (!leadId) return;
  try {
    const lead = await lerLead(tenantId, leadId);
    if (!lead) return;
    const atual = normalizar(lead.memoria);
    const agenda = await fatosDaAgenda(tenantId, leadId);

    let { preferencias, observacoes } = atual;
    if (resumo?.trim() && (await atenaPermite(tenantId, 'resumo'))) {
      try {
        const novo = await novidadesDoResumo({ tenantId, conversationId, resumo: resumo.trim(), atual, provedores });
        preferencias = lista([...preferencias, ...novo.preferencias], MAX_PREFERENCIAS);
        observacoes = lista([...observacoes, ...novo.observacoes], MAX_OBSERVACOES);
      } catch (err) {
        log.warn({ err, tenantId, leadId }, 'A IA nao conseguiu ler preferencias do resumo');
      }
    }

    const mudou =
      JSON.stringify(agenda) !== JSON.stringify(atual.agenda) ||
      JSON.stringify(preferencias) !== JSON.stringify(atual.preferencias) ||
      JSON.stringify(observacoes) !== JSON.stringify(atual.observacoes);
    // Cliente sem nada a lembrar continua sem ficha (e sem bloco no prompt).
    if (!mudou) return;

    await gravar(tenantId, leadId, { ...atual, agenda, preferencias, observacoes, atualizadaEm: Date.now() });
    log.info({ tenantId, leadId, conversationId }, 'Memoria do cliente atualizada');
  } catch (err) {
    log.warn({ err, tenantId, leadId }, 'Nao foi possivel atualizar a memoria do cliente');
  }
}

// ---------------------------------------------------------------------------
// Tela (atendente corrige ou apaga)
// ---------------------------------------------------------------------------

/**
 * Quem pode ver/corrigir a ficha deste cliente: a mesma regra das conversas.
 * Quem acompanha a equipe inteira; o responsavel pela carteira; ou quem
 * enxerga ALGUMA conversa dele (sem dono, ou dele). A ficha sai das conversas
 * e da agenda — mostrar a quem nao ve nenhuma das duas furaria a privacidade.
 */
export async function podeVerMemoria(tenantId, leadId, usuario) {
  const escopo = await escopoDe(tenantId, usuario);
  if (escopo.tudo) return true;
  const lead = await lerLead(tenantId, leadId);
  if (lead?.responsavelId === escopo.userId) return true;
  const [conversa] = await db
    .select({ x: sql`1` })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.leadId, leadId),
        isNull(conversations.deletedAt),
        or(isNull(conversations.assignedUserId), eq(conversations.assignedUserId, escopo.userId))
      )
    )
    .limit(1);
  return Boolean(conversa);
}

export async function obterMemoria(tenantId, leadId) {
  const lead = await lerLead(tenantId, leadId);
  return lead ? apresentarMemoria(lead.memoria) : null;
}

/**
 * Grava a correcao do atendente: listas editadas por inteiro e os fatos de
 * agenda que ele mandou esquecer. Devolve { antes, depois } para a auditoria.
 */
export async function corrigirMemoria(tenantId, leadId, { preferencias, observacoes, esquecer = [] }) {
  const lead = await lerLead(tenantId, leadId);
  if (!lead) return null;
  const atual = normalizar(lead.memoria);
  const ocultos = { ...atual.ocultos };
  for (const chave of esquecer) {
    const valor = valorDoFato(chave, atual.agenda?.[chave]);
    if (valor != null) ocultos[chave] = valor;
  }
  const nova = {
    ...atual,
    preferencias: preferencias !== undefined ? lista(preferencias, MAX_PREFERENCIAS) : atual.preferencias,
    observacoes: observacoes !== undefined ? lista(observacoes, MAX_OBSERVACOES) : atual.observacoes,
    ocultos,
    atualizadaEm: Date.now()
  };
  await gravar(tenantId, leadId, nova);
  return { antes: apresentarMemoria(atual), depois: apresentarMemoria(nova) };
}
