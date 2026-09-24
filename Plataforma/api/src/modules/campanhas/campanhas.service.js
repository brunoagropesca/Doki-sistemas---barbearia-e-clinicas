import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { channelInstances } from '../../db/schema/conversations.js';
import { leads } from '../../db/schema/crm.js';
import { tenants } from '../../db/schema/tenants.js';
import { Conflito, NaoEncontrado, RegraDeNegocio } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { formatarBRL } from '../../core/money.js';
import { formatarTelefone, mascarar } from '../../core/phone.js';
import { colorir, negrito, resumir, ver } from '../../core/painel.js';
import {
  dataNoFuso,
  diasEntre,
  formatarBR,
  FUSO_PADRAO,
  horaNoFuso,
  inicioDoDia,
  instanteDeLocal,
  somarDias
} from '../../core/datetime.js';
import { gerar } from '../../ai/cascade.js';
import { TONS as TONS_SOFIA } from '../../ai/agentes-padrao.js';
import { obterAgente } from '../ia/ia.service.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import { historicoDoCliente } from '../agenda/agenda.service.js';
import * as conversas from '../conversas/conversas.service.js';
import * as repo from './campanhas.repo.js';
import { funcaoLigada } from '../funcoes/funcoes.js';
import { licencaBloqueada } from '../../licenca/licenca.js';

const log = comContexto({ modulo: 'campanhas' });

/**
 * Campanhas de disparo em massa — mensagem pessoal para cada cliente.
 *
 * O fluxo segue as cinco etapas do assistente da tela:
 *
 *   1. Criar            nome e numero de envio            -> 'rascunho'
 *   2. Contatos         quem recebe (alvos 'aguardando')
 *   3. Configurar IA    objetivo e jeito de escrever (com previa de teste)
 *   4. Gerar e aprovar  IA escreve em segundo plano      -> 'gerando' -> 'revisao'
 *                       humano le, ajusta e aprova        -> 'pronta'
 *   5. Enviar           ritmo anti-bloqueio e disparo     -> 'enviando'
 *
 * Tres garantias atravessam o modulo inteiro (herdadas da correcao do sistema
 * antigo, que marcava "enviada" sem nunca ter mandado nada):
 *  - nada sai sem aprovacao humana;
 *  - `enviadoEm` so recebe valor DEPOIS que o canal confirma;
 *  - quem pediu para nao receber campanha nunca entra no publico.
 */

/** Os status em que a campanha ainda esta sendo montada. */
const EM_PREPARO = ['rascunho', 'revisao', 'pronta'];
const FINALIZADAS = ['concluida', 'cancelada'];

/** Quantos dias entre duas campanhas para o mesmo cliente. */
const DIAS_ENTRE_CAMPANHAS = 15;

/** Resposta que chega ate este prazo depois do envio conta como resposta a campanha. */
const PRAZO_RESPOSTA_MS = 7 * 86_400_000;

export const IA_PADRAO = {
  tom: 'amigavel',
  tamanho: 'curta',
  ousadia: 'equilibrada',
  emojis: true,
  usarHistorico: true,
  assinatura: '',
  evitar: ''
};

async function contexto(tenantId) {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  return { fuso: tenant?.fusoHorario || FUSO_PADRAO, nomeEmpresa: tenant?.nome ?? 'nossa empresa' };
}

async function exigir(tenantId, id) {
  const campanha = await repo.buscarPorId(tenantId, id);
  if (!campanha) throw new NaoEncontrado('Campanha');
  return campanha;
}

async function exigirCanal(tenantId, channelInstanceId) {
  const canal = await db.query.channelInstances.findFirst({
    where: and(eq(channelInstances.tenantId, tenantId), eq(channelInstances.id, channelInstanceId))
  });
  if (!canal) throw new NaoEncontrado('Canal de envio');
  return canal;
}

/**
 * Numeros que a tela precisa para a barra de progresso.
 *
 * "Para enviar" conta so o que foi aprovado: o que ficou de fora de proposito
 * (pulada) nao entra no 100%, senao uma campanha concluida pararia em 90%.
 */
function progressoDe(contagens) {
  const n = (s) => contagens[s] ?? 0;
  const processadas = n('enviada') + n('respondeu') + n('falha');
  const paraEnviar = processadas + n('aprovada') + n('enviando');
  return {
    aguardando: n('aguardando'),
    pendentes: n('pendente'),
    aprovadas: n('aprovada'),
    enviadas: n('enviada') + n('respondeu'),
    falhas: n('falha'),
    respostas: n('respondeu'),
    puladas: n('pulada'),
    processadas,
    paraEnviar,
    percentual: paraEnviar > 0 ? Math.round((processadas / paraEnviar) * 100) : 0
  };
}

function apresentar(c, contagens = {}) {
  return {
    id: c.id,
    nome: c.nome,
    objetivo: c.objetivo,
    modo: c.modo,
    status: c.status,
    channelInstanceId: c.channelInstanceId,
    iaConfig: { ...IA_PADRAO, ...(c.iaConfig ?? {}) },
    simularDigitacao: c.simularDigitacao,
    intervaloMinSegundos: c.intervaloMinSegundos,
    intervaloMaxSegundos: c.intervaloMaxSegundos,
    limiteDiario: c.limiteDiario,
    janelaInicio: c.janelaInicio,
    janelaFim: c.janelaFim,
    totalAlvos: Object.values(contagens).reduce((s, n) => s + n, 0) || c.totalAlvos,
    totalEnviadas: c.totalEnviadas,
    totalFalhas: c.totalFalhas,
    totalRespostas: c.totalRespostas,
    contagens,
    progresso: progressoDe(contagens),
    rodando: execucoes.has(c.id),
    gerandoAgora: geracoes.has(c.id),
    esperaMotivo: c.esperaMotivo ?? null,
    retomaEm: c.retomaEm?.getTime() ?? null,
    proximoEnvioEm: c.proximoEnvioEm?.getTime() ?? null,
    iniciadaEm: c.iniciadaEm?.getTime() ?? null,
    concluidaEm: c.concluidaEm?.getTime() ?? null,
    createdAt: c.createdAt.getTime()
  };
}

export async function listar(tenantId) {
  const lista = await repo.listar(tenantId);
  const contagens = await repo.contarPorStatusDeVarias(
    tenantId,
    lista.map((c) => c.id)
  );

  // Cura campanhas que ja ficaram travadas em "pausada"/"enviando" com tudo
  // enviado (o defeito acima, antes da correcao): passam a constar concluidas.
  for (const c of lista) {
    if (['pausada', 'enviando'].includes(c.status) && !execucoes.has(c.id)) {
      if (await concluirSeTerminou(tenantId, c.id, contagens[c.id] ?? {})) {
        c.status = 'concluida';
        c.concluidaEm = new Date();
        c.esperaMotivo = null;
        c.retomaEm = null;
        c.proximoEnvioEm = null;
      }
    }
  }
  return lista.map((c) => apresentar(c, contagens[c.id] ?? {}));
}

export async function obter(tenantId, id) {
  let campanha = await exigir(tenantId, id);

  const [contagens, alvos] = await Promise.all([
    repo.contarPorStatus(tenantId, id),
    repo.listarAlvos(tenantId, id, { limite: 1000 })
  ]);

  // Mesma cura da listagem: campanha travada com tudo enviado consta concluida.
  if (['pausada', 'enviando'].includes(campanha.status) && !execucoes.has(id)) {
    if (await concluirSeTerminou(tenantId, id, contagens)) campanha = await exigir(tenantId, id);
  }

  return {
    ...apresentar(campanha, contagens),
    alvos: alvos.map((a) => ({
      id: a.id,
      leadId: a.leadId,
      nomeCliente: a.nomeCliente,
      telefone: a.telefone,
      telefoneFormatado: formatarTelefone(a.telefone),
      mensagem: a.mensagem,
      mensagemReserva: a.mensagemReserva,
      status: a.status,
      erro: a.erro,
      enviadoEm: a.enviadoEm?.getTime() ?? null,
      respostaTexto: a.respostaTexto,
      respondidoEm: a.respondidoEm?.getTime() ?? null,
      classificacao: a.classificacao,
      contextoGeracao: a.contextoGeracao
    }))
  };
}

// ============================================================================
// ETAPA 1 — CRIAR
// ============================================================================

export async function criar(tenantId, dados, { usuario } = {}) {
  const canal = await exigirCanal(tenantId, dados.channelInstanceId);

  const campanha = await repo.criar(tenantId, {
    nome: dados.nome,
    objetivo: dados.objetivo ?? '',
    modo: 'ia_personalizada',
    channelInstanceId: canal.id,
    iaConfig: { ...IA_PADRAO },
    criadoPorUserId: usuario?.id ?? null,
    status: 'rascunho'
  });

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'campanha.criar',
    entidade: 'campanha',
    entidadeId: campanha.id,
    dados: { depois: { nome: campanha.nome } }
  });

  return obter(tenantId, campanha.id);
}

/**
 * Atualiza nome, canal, objetivo, configuracao da IA e ritmo de envio.
 *
 * O ritmo (intervalo, limite, janela, digitacao) pode mudar ate com o disparo
 * rodando: o laco de envio le a campanha a cada mensagem, entao o ajuste vale
 * a partir da proxima. Ja o numero de envio nao muda com o disparo andando —
 * metade dos clientes receberia de um numero e metade de outro.
 */
export async function atualizar(tenantId, id, dados, { usuario } = {}) {
  const campanha = await exigir(tenantId, id);

  if (FINALIZADAS.includes(campanha.status)) {
    throw new RegraDeNegocio('Campanha encerrada nao pode mais ser alterada.');
  }

  const mudancas = {};
  for (const campo of [
    'nome',
    'objetivo',
    'intervaloMinSegundos',
    'intervaloMaxSegundos',
    'limiteDiario',
    'janelaInicio',
    'janelaFim',
    'simularDigitacao'
  ]) {
    if (dados[campo] !== undefined) mudancas[campo] = dados[campo];
  }

  if (dados.iaConfig) {
    mudancas.iaConfig = { ...IA_PADRAO, ...(campanha.iaConfig ?? {}), ...dados.iaConfig };
  }

  if (dados.channelInstanceId && dados.channelInstanceId !== campanha.channelInstanceId) {
    if (['enviando', 'pausada'].includes(campanha.status)) {
      throw new RegraDeNegocio('O numero de envio nao pode mudar depois que o disparo comecou.');
    }
    mudancas.channelInstanceId = (await exigirCanal(tenantId, dados.channelInstanceId)).id;
  }

  // A validacao cruzada olha o resultado final: mudar so o minimo precisa
  // respeitar o maximo que ja estava salvo.
  const final = { ...campanha, ...mudancas };
  if (final.intervaloMaxSegundos < final.intervaloMinSegundos) {
    throw new RegraDeNegocio('O intervalo maximo precisa ser maior ou igual ao minimo.');
  }
  if (final.janelaFim <= final.janelaInicio) {
    throw new RegraDeNegocio('O fim da janela de envio precisa ser depois do inicio.');
  }

  if (Object.keys(mudancas).length) {
    await repo.atualizar(tenantId, id, mudancas);
    await registrarAuditoria({
      tenantId,
      usuario,
      acao: 'campanha.atualizar',
      entidade: 'campanha',
      entidadeId: id,
      dados: { depois: Object.keys(mudancas) }
    });
  }

  return obter(tenantId, id);
}

// ============================================================================
// ETAPA 2 — CONTATOS
// ============================================================================

/**
 * Por que um contato NAO pode entrar no publico — ou null se pode.
 *
 * Quem pediu para nao receber e pulado sempre. Isso nao e detalhe: e a
 * diferenca entre marketing e perseguicao, e ignorar esse pedido e o caminho
 * mais rapido para o numero ser denunciado e bloqueado pelo WhatsApp.
 */
function motivoParaPular(lead) {
  if (lead.origem === 'simulador') return 'Contato de teste do simulador';
  if (!lead.aceitaCampanha) return 'Pediu para nao receber campanhas';
  // Duas mensagens promocionais na mesma quinzena cansam o cliente e chamam
  // atencao do WhatsApp.
  if (lead.ultimaCampanhaEm && diasEntre(lead.ultimaCampanhaEm, Date.now()) < DIAS_ENTRE_CAMPANHAS) {
    return `Recebeu campanha ha menos de ${DIAS_ENTRE_CAMPANHAS} dias`;
  }
  return null;
}

/**
 * Define quem recebe a campanha.
 *
 * Substitui o publico inteiro: quem saiu da lista sai da campanha, quem
 * continua mantem a mensagem que ja tinha (nao se gasta IA de novo com ele),
 * e quem entrou fica 'aguardando' a geracao.
 */
export async function definirPublico(tenantId, id, leadIds, { usuario } = {}) {
  const campanha = await exigir(tenantId, id);
  if (!EM_PREPARO.includes(campanha.status)) {
    throw new RegraDeNegocio('O publico so pode mudar antes do disparo e fora da geracao das mensagens.');
  }

  const contextos = await repo.contextoDosLeads(tenantId, [...new Set(leadIds)]);
  const pulados = [];
  const aptos = [];
  for (const lead of contextos) {
    const motivo = motivoParaPular(lead);
    if (motivo) pulados.push({ leadId: lead.id, nome: lead.nome, motivo });
    else aptos.push(lead);
  }

  const aptosIds = aptos.map((l) => l.id);
  await repo.removerAlvosForaDe(tenantId, id, aptosIds);

  const jaEstao = new Set(await repo.leadIdsDaCampanha(tenantId, id));
  const novos = aptos
    .filter((l) => !jaEstao.has(l.id))
    .map((l) => ({ leadId: l.id, telefone: l.telefone, nomeCliente: l.nome, mensagem: '', status: 'aguardando' }));
  await repo.criarAlvos(tenantId, id, novos);

  await recalcularPreparo(tenantId, id);

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'campanha.publico',
    entidade: 'campanha',
    entidadeId: id,
    dados: { depois: { incluidos: aptos.length, novos: novos.length, pulados: pulados.length } }
  });

  return { campanha: await obter(tenantId, id), incluidos: aptos.length, pulados };
}

/**
 * Acerta o status de uma campanha em preparo a partir dos alvos.
 *
 * Quem ainda nao tem mensagem -> 'rascunho'; mensagem esperando leitura ->
 * 'revisao'; tudo aprovado -> 'pronta'. Assim o status nunca mente sobre o
 * que falta fazer, qualquer que seja a ordem em que a pessoa mexeu.
 */
async function recalcularPreparo(tenantId, id) {
  const campanha = await repo.buscarPorId(tenantId, id);
  if (!campanha || !EM_PREPARO.includes(campanha.status)) return;

  const c = await repo.contarPorStatus(tenantId, id);
  const total = Object.values(c).reduce((s, n) => s + n, 0);

  let status = 'rascunho';
  if (total > 0 && !c.aguardando) {
    status = c.pendente ? 'revisao' : c.aprovada ? 'pronta' : 'rascunho';
  }

  await repo.atualizar(tenantId, id, { status, totalAlvos: total });
}

// ============================================================================
// ETAPA 3 — IA: o contexto de cada cliente e a mensagem
// ============================================================================

const TONS = {
  amigavel: 'amigavel e proximo, como alguem da equipe que conhece o cliente',
  profissional: 'cordial e profissional, sem ser frio',
  descontraido: 'descontraido e leve, como um amigo falando'
};

const TAMANHOS = {
  curta: '1 a 2 frases curtas',
  media: '2 a 4 frases',
  longa: '4 a 6 frases, contando algo com calma — ainda uma mensagem de WhatsApp, nao um e-mail'
};

/**
 * Ousadia: quanto o Aquiles pode se arriscar. Mexe no texto do pedido E na
 * temperatura — "seja ousado" com temperatura baixa sai tudo igual.
 */
const OUSADIAS = {
  contida: { texto: 'contida — discreta e educada, sem brincadeira', temperatura: -0.2, emojis: 1 },
  equilibrada: { texto: 'equilibrada — natural, com um toque de personalidade', temperatura: 0, emojis: 1 },
  ousada: {
    texto:
      'alta — pode brincar, usar giria leve, abrir com algo inesperado e mostrar personalidade forte, ' +
      'sem ser inconveniente nem forcar intimidade',
    temperatura: 0.2,
    emojis: 2
  }
};

/**
 * Quem escreve as mensagens: o Aquiles (e, se ele pedir, a voz da Sofia).
 *
 * Carregado UMA vez por lote, nao por cliente: numa geracao de 300
 * mensagens, seriam 300 leituras do mesmo perfil.
 */
async function carregarRedator(tenantId) {
  const aquiles = await obterAgente(tenantId, 'aquiles');
  if (!aquiles?.ativo) {
    throw new RegraDeNegocio(
      'O Aquiles (agente de campanhas) esta desligado. Ligue-o em Inteligencia Artificial > Personas para gerar as mensagens.'
    );
  }
  const sofia = aquiles.config?.herdarSofia ? await obterAgente(tenantId, 'atendente') : null;
  return { aquiles, sofia };
}

/**
 * Monta o que a IA sabe sobre o cliente: numeros, historico de atendimentos
 * e as ultimas mensagens trocadas.
 *
 * Devolve tambem uma versao em topicos (`linhas`) que fica guardada no alvo:
 * na revisao, quem aprova ve exatamente o que a IA leu antes de escrever.
 */
async function contextoDoCliente(tenantId, lead, { usarHistorico, fuso }) {
  const primeiroNome = String(lead.nome).split(' ')[0];
  const linhas = [`Nome: ${lead.nome} (trate por ${primeiroNome})`];

  if (!usarHistorico) {
    return { primeiroNome, linhas, texto: linhas.join('\n') };
  }

  const visitas = Number(lead.totalConcluidos) || 0;
  const diasSemVir = lead.ultimoAgendamentoEm ? diasEntre(Number(lead.ultimoAgendamentoEm), Date.now()) : null;

  if (visitas > 0) {
    linhas.push(
      `Ja veio ${visitas} vez(es); ultima visita ha ${diasSemVir} dia(s)` +
        (lead.ultimoServico ? ` (${lead.ultimoServico})` : '')
    );
  } else {
    linhas.push('Ainda nao teve nenhum atendimento concluido');
  }
  if (lead.profissionalPreferido) linhas.push(`Costuma ser atendido por: ${lead.profissionalPreferido}`);
  if (lead.proximoAgendamentoEm) {
    linhas.push(`JA TEM HORARIO MARCADO para ${formatarBR(Number(lead.proximoAgendamentoEm), fuso)}`);
  }
  if (Number(lead.totalFaltas) > 0) linhas.push(`Faltou ${lead.totalFaltas} vez(es) a horarios marcados`);
  if (lead.humor) linhas.push(`Humor no ultimo atendimento: ${lead.humor}`);
  if (lead.tags?.length) linhas.push(`Etiquetas: ${lead.tags.join(', ')}`);
  if (lead.observacoes) linhas.push(`Observacoes do cadastro: ${lead.observacoes}`);

  const [historico, mensagens] = await Promise.all([
    historicoDoCliente(tenantId, lead.id).catch(() => ({ agendamentos: [], atendimentos: [] })),
    repo.ultimasMensagensDoLead(tenantId, lead.id, 10).catch(() => [])
  ]);

  // Agendamentos e atendimentos numa linha do tempo so, do mais recente.
  const eventos = [
    ...historico.agendamentos.map((a) => ({
      quando: a.inicioEm,
      texto:
        `${a.quandoFormatado} · ${a.servicoNome ?? 'Atendimento'}` +
        (a.profissionalNome ? ` com ${a.profissionalNome}` : '') +
        ` · ${a.status}` +
        (a.resumoAtendimento ? ` · ${a.resumoAtendimento}` : '') +
        (a.anotacoesAtendimento ? ` · Anotacao da equipe: ${a.anotacoesAtendimento}` : '')
    })),
    ...historico.atendimentos.map((c) => ({
      quando: c.quando ?? 0,
      texto:
        `${c.quandoFormatado ?? ''} · Conversa sem agendamento` +
        (c.humor ? ` · humor: ${c.humor}` : '') +
        (c.resumo ? ` · ${c.resumo}` : c.previa ? ` · ultima mensagem: "${c.previa}"` : '') +
        (c.anotacoes ? ` · Anotacao da equipe: ${c.anotacoes}` : '')
    }))
  ]
    .sort((a, b) => b.quando - a.quando)
    .slice(0, 5);

  const partes = [...linhas];
  // Sem isto os modelos menores tratam todo mundo como cliente antigo que
  // sumiu ("faz anos que a gente nao se ve!") — mentira que o cliente percebe.
  if (visitas === 0) {
    partes.push('ATENCAO: este cliente ainda nao foi atendido. Nao escreva como se ele tivesse sumido ou ja conhecesse a casa.');
  }
  if (eventos.length) {
    partes.push('', 'HISTORICO (mais recente primeiro):', ...eventos.map((e) => `- ${e.texto}`));
  }

  const conversa = mensagens
    .filter((m) => m.conteudo)
    .map((m) => `${m.direcao === 'entrada' ? 'Cliente' : 'Empresa'}: ${String(m.conteudo).slice(0, 220)}`);
  if (conversa.length) {
    partes.push('', 'ULTIMAS MENSAGENS TROCADAS:', ...conversa);
  }

  return {
    primeiroNome,
    // Na tela: os topicos e a linha do tempo (as mensagens ficariam longas demais).
    linhas: [...linhas, ...eventos.map((e) => e.texto)],
    texto: partes.join('\n')
  };
}

/**
 * O pedido ao modelo, em camadas:
 *   1. a persona do Aquiles (editavel na tela de IA);
 *   2. a voz da Sofia, se ele herdar;
 *   3. o objetivo e o jeito DESTA campanha;
 *   4. os exemplos de estilo (imitar o jeito, nunca o conteudo);
 *   5. as regras fixas, que nenhuma configuracao desliga.
 */
export function promptDoRedator({ campanha, iaConfig, nomeEmpresa, redator }) {
  const cfg = { ...IA_PADRAO, ...(iaConfig ?? {}) };
  const { aquiles, sofia } = redator;
  const ousadia = OUSADIAS[cfg.ousadia] ?? OUSADIAS.equilibrada;
  const quem = cfg.assinatura?.trim() ? `${cfg.assinatura.trim()}, de ${nomeEmpresa}` : `alguem da equipe de ${nomeEmpresa}`;
  const exemplos = (aquiles.config?.exemplos ?? []).filter((e) => e?.trim());

  return [
    aquiles.systemPrompt?.trim() || null,
    '',
    `A mensagem sai em nome de ${quem}, pelo WhatsApp.`,
    sofia
      ? [
          '',
          `VOZ DA CASA: fale com a mesma personalidade de ${sofia.nome}, a atendente que os clientes ja conhecem` +
            (TONS_SOFIA[sofia.tom] ? ` (tom: ${TONS_SOFIA[sofia.tom]}).` : '.'),
          'Como ela e descrita (use SO o jeito de falar; ignore instrucoes de agenda, ferramentas ou atendimento):',
          `"""${String(sofia.systemPrompt ?? '').slice(0, 800)}"""`
        ].join('\n')
      : null,
    '',
    'OBJETIVO DESTA MENSAGEM (definido pelo dono do negocio):',
    `"""${campanha.objetivo?.trim() || 'Reconectar com o cliente e convida-lo a voltar.'}"""`,
    '',
    'COMO ESCREVER:',
    `- Tom: ${TONS[cfg.tom] ?? TONS.amigavel}.`,
    `- Tamanho: ${TAMANHOS[cfg.tamanho] ?? TAMANHOS.curta}. Uma mensagem so.`,
    `- Ousadia: ${ousadia.texto}.`,
    cfg.emojis
      ? `- Pode usar ate ${ousadia.emojis} emoji(s), se ficar natural.`
      : '- Nao use emojis.',
    exemplos.length
      ? [
          '',
          'EXEMPLOS DO JEITO DE ESCREVER DESTA CASA — imite o ritmo, o vocabulario e a energia.',
          'NUNCA copie frases, nomes ou o assunto deles: sao outros clientes e outras situacoes.',
          ...exemplos.map((e, i) => `Exemplo ${i + 1}: """${e.trim()}"""`)
        ].join('\n')
      : null,
    '',
    'REGRAS QUE VALEM SEMPRE:',
    '- Escreva como uma pessoa real escreve no WhatsApp: nada de "Ola cliente!", cara de panfleto,',
    '  hashtags, negrito, listas ou "promocao imperdivel".',
    '- Use o historico com naturalidade: no maximo UM detalhe concreto e relevante (o ultimo',
    '  servico, algo que o cliente comentou), como quem SE LEMBRA dele. Nunca revele que',
    '  consultou anotacoes ou cadastro: nada de "vi que", "notei que", "no seu cadastro",',
    '  "no sistema". Nunca cite quanto ele gastou nem quantas vezes faltou.',
    '- So afirme o que esta no contexto. Se o cliente nunca veio, nao diga "faz tempo que nao',
    '  vem" nem "sentimos sua falta"; se nao ha historico, escreva sem inventar um.',
    '- Se o cliente JA TEM HORARIO MARCADO, nao convide para agendar: adapte ao objetivo sem',
    '  empurrar venda.',
    '- Se o ultimo atendimento foi ruim (humor frustrado), seja cuidadoso e humano.',
    '- Nao invente promocoes, precos, datas ou condicoes que nao estejam no objetivo.',
    '- Termine com uma pergunta leve ou um convite simples, facil de responder.',
    cfg.evitar?.trim() ? `- Evite tambem: ${cfg.evitar.trim()}` : null,
    '',
    'Devolva APENAS o texto da mensagem, sem aspas e sem explicacao.'
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/**
 * Escreve a mensagem de UM cliente.
 *
 * Se a IA falhar, devolve um texto de reserva honesto — generico, sem
 * prometer nada — marcado como reserva para a revisao humana perceber.
 */
/**
 * Frases que denunciam que a mensagem foi montada a partir de uma ficha.
 *
 * O prompt ja proibe, mas os modelos menores escorregam com frequencia
 * ("Vi que voce prefere o corte na tesoura..."). Uma pessoa que se lembra do
 * cliente nao diz "vi que" — quem diz e quem acabou de ler o cadastro.
 */
const DENUNCIA_FICHA = /\b(vi|vimos|notei|notamos|percebi|percebemos|consta)\s+(aqui\s+)?que\b|\b(seu|no)\s+cadastro\b|\bno\s+(nosso\s+)?sistema\b|\bhist[oó]rico\b/i;

function limparTexto(bruto) {
  let texto = String(bruto ?? '').trim();
  // Modelos costumam devolver a mensagem entre aspas mesmo proibindo.
  if (/^["'“].*["'”]$/s.test(texto)) texto = texto.slice(1, -1).trim();
  // Tom de pele solto, sem o emoji que ele modifica, aparece como um
  // quadradinho de cor no celular do cliente.
  texto = texto.replace(/(^|[^\p{Extended_Pictographic}‍])[\u{1F3FB}-\u{1F3FF}]/gu, '$1').replace(/\s{2,}/g, ' ').trim();
  return texto;
}

async function escreverMensagem({ tenantId, campanha, iaConfig, lead, nomeEmpresa, fuso, redator }) {
  const cfg = { ...IA_PADRAO, ...(iaConfig ?? {}) };
  const ctx = await contextoDoCliente(tenantId, lead, { usarHistorico: cfg.usarHistorico, fuso });
  const { aquiles } = redator;
  const ousadia = OUSADIAS[cfg.ousadia] ?? OUSADIAS.equilibrada;

  const pedido = {
    tenantId,
    origem: 'campanha',
    agentKey: 'aquiles',
    systemPrompt: promptDoRedator({ campanha, iaConfig: cfg, nomeEmpresa, redator }),
    mensagens: [{ papel: 'user', conteudo: `Escreva a mensagem para este cliente:\n\n${ctx.texto}` }],
    // Temperatura alta de proposito (a do Aquiles vem em 0.9): 200 mensagens
    // parecidas demais entre si sao exatamente o padrao que o WhatsApp
    // reconhece como disparo. A ousadia da campanha sobe ou desce em cima dela.
    temperatura: Math.min(1.5, Math.max(0, (aquiles.temperatura ?? 0.9) + ousadia.temperatura)),
    maxTokens: aquiles.maxTokens ?? 500,
    modeloPreferido: aquiles.modeloPreferido ?? null,
    // O texto vai para o WhatsApp de um cliente: meia frase nao serve nem
    // para a revisao. Melhor tentar de novo do que mandar o revisor consertar.
    exigirRespostaCompleta: true
  };

  try {
    const primeira = await gerar(pedido);
    let texto = limparTexto(primeira.texto);
    if (!texto) throw new Error('A IA devolveu texto vazio');
    // Quem escreveu, para a revisao mostrar (e a pessoa saber qual modelo culpar).
    let autor = [primeira.provedor, primeira.modelo].filter(Boolean).join(' · ') || null;

    // Uma segunda chance quando o texto "entrega a ficha". Se a reescrita
    // falhar ou repetir o vicio, fica a primeira: quem revisa ainda le tudo.
    if (DENUNCIA_FICHA.test(texto)) {
      try {
        const r2 = await gerar({
          ...pedido,
          mensagens: [
            ...pedido.mensagens,
            { papel: 'assistant', conteudo: texto },
            {
              papel: 'user',
              conteudo:
                'Reescreva. Esta versao soa como quem leu uma ficha ("vi que", "notei que", "cadastro", "sistema", "historico"). ' +
                'Fale como alguem que simplesmente se lembra do cliente. Devolva so a mensagem.'
            }
          ]
        });
        const segunda = limparTexto(r2.texto);
        if (segunda && !DENUNCIA_FICHA.test(segunda)) {
          texto = segunda;
          autor = [r2.provedor, r2.modelo].filter(Boolean).join(' · ') || autor;
        }
      } catch {
        // Fica a primeira versao.
      }
    }

    return { mensagem: texto, reserva: false, contexto: ctx, autor };
  } catch (err) {
    log.warn({ err, leadId: lead.id }, 'IA falhou ao escrever; usando texto de reserva');
    return {
      mensagem: `Oi ${ctx.primeiroNome}! Tudo bem? Passando pra saber se voce gostaria de agendar um horario com a gente essa semana.`,
      reserva: true,
      contexto: ctx,
      autor: null
    };
  }
}

/**
 * Previa: escreve para alguns clientes do publico SEM gravar nada.
 *
 * Serve para calibrar o objetivo e o tom antes de gastar IA com o publico
 * inteiro. Recebe a configuracao ainda nao salva, direto da tela.
 */
export async function previa(tenantId, id, { quantidade = 3, objetivo, iaConfig } = {}) {
  const campanha = await exigir(tenantId, id);
  const alvos = await repo.listarAlvos(tenantId, id, { limite: 1000 });
  if (!alvos.length) throw new RegraDeNegocio('Escolha os contatos antes de testar a mensagem.');

  // Sorteio: testar sempre com os mesmos 3 esconderia como a IA lida com
  // clientes diferentes (quem nunca veio, quem sumiu, quem tem horario marcado).
  const sorteados = [...alvos].sort(() => Math.random() - 0.5).slice(0, Math.min(quantidade, 5));
  const contextos = await repo.contextoDosLeads(tenantId, sorteados.map((a) => a.leadId));
  const { nomeEmpresa, fuso } = await contexto(tenantId);

  const cfg = { ...IA_PADRAO, ...(campanha.iaConfig ?? {}), ...(iaConfig ?? {}) };
  const alvoDeTeste = { ...campanha, objetivo: objetivo ?? campanha.objetivo };
  const redator = await carregarRedator(tenantId);

  const amostras = [];
  for (const lead of contextos) {
    const r = await escreverMensagem({ tenantId, campanha: alvoDeTeste, iaConfig: cfg, lead, nomeEmpresa, fuso, redator });
    amostras.push({
      leadId: lead.id,
      nome: lead.nome,
      mensagem: r.mensagem,
      reserva: r.reserva,
      autor: r.autor,
      contexto: r.contexto.linhas
    });
  }
  return { amostras };
}

// ============================================================================
// ETAPA 4 — GERAR E APROVAR
// ============================================================================

/** Geracoes em andamento, por campanha. */
const geracoes = new Map();

export function estaGerando(campaignId) {
  return geracoes.has(campaignId);
}

/**
 * Manda a IA escrever as mensagens de quem esta 'aguardando'.
 *
 * Roda em segundo plano: 300 mensagens levam minutos, e a requisicao nao
 * pode ficar pendurada. A tela acompanha pelo contador de alvos.
 *
 * `refazer: true` reescreve tambem as ja geradas (e as ja aprovadas) — util
 * quando o objetivo mudou depois da primeira geracao.
 */
export async function gerarMensagens(tenantId, id, { refazer = false } = {}, { usuario } = {}) {
  const campanha = await exigir(tenantId, id);
  if (geracoes.has(id)) throw new Conflito('As mensagens desta campanha ja estao sendo geradas.');
  if (!EM_PREPARO.includes(campanha.status)) {
    throw new RegraDeNegocio('As mensagens so podem ser geradas antes do disparo.');
  }
  if (!campanha.objetivo?.trim()) {
    throw new RegraDeNegocio('Escreva o objetivo da campanha: e dele que a IA parte para escrever.');
  }
  // Aquiles desligado: avisa ja, em vez de "gerar" 300 textos de reserva.
  await carregarRedator(tenantId);

  if (refazer) {
    await repo.mudarStatusDosAlvos(tenantId, id, ['pendente', 'aprovada'], { status: 'aguardando' });
  }

  const c = await repo.contarPorStatus(tenantId, id);
  if (!c.aguardando) {
    await recalcularPreparo(tenantId, id);
    return obter(tenantId, id);
  }

  await repo.atualizar(tenantId, id, { status: 'gerando' });
  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'campanha.gerar',
    entidade: 'campanha',
    entidadeId: id,
    dados: { depois: { mensagens: c.aguardando, refazer } }
  });

  iniciarGeracao(tenantId, id);
  return obter(tenantId, id);
}

function iniciarGeracao(tenantId, id) {
  const estado = { parar: false };
  geracoes.set(id, estado);

  executarGeracao(tenantId, id, estado)
    .catch((err) => log.error({ err, campaignId: id }, 'Geracao de mensagens morreu inesperadamente'))
    .finally(async () => {
      geracoes.delete(id);
      // Mesmo se algo quebrou no meio: a campanha sai de 'gerando'. O que ja
      // foi escrito fica; o que faltou continua 'aguardando' e pode ser gerado
      // de novo com um clique.
      const atual = await repo.buscarPorId(tenantId, id).catch(() => null);
      if (atual?.status === 'gerando') {
        await repo.atualizar(tenantId, id, { status: 'revisao' }).catch(() => {});
        await recalcularPreparo(tenantId, id).catch(() => {});
      }
    });
}

async function executarGeracao(tenantId, id, estado) {
  const { nomeEmpresa, fuso } = await contexto(tenantId);
  const redator = await carregarRedator(tenantId);

  while (!estado.parar) {
    const campanha = await repo.buscarPorId(tenantId, id);
    if (!campanha || campanha.status !== 'gerando') break;

    // Lotes pequenos: a lista de alvos e relida a cada volta, entao alguem
    // tirando um contato do publico no meio da geracao nao gasta IA a toa.
    const lote = await repo.listarAlvos(tenantId, id, { status: ['aguardando'], limite: 5 });
    if (!lote.length) break;

    const contextos = await repo.contextoDosLeads(tenantId, lote.map((a) => a.leadId));
    const porLead = new Map(contextos.map((l) => [l.id, l]));

    for (const alvo of lote) {
      if (estado.parar) break;
      const lead = porLead.get(alvo.leadId);

      // O contato foi apagado depois de entrar no publico.
      if (!lead) {
        await repo.excluirAlvo(tenantId, alvo.id);
        continue;
      }

      const r = await escreverMensagem({ tenantId, campanha, iaConfig: campanha.iaConfig, lead, nomeEmpresa, fuso, redator });
      await repo.atualizarAlvo(tenantId, alvo.id, {
        mensagem: r.mensagem,
        mensagemReserva: r.reserva,
        status: 'pendente',
        contextoGeracao: { linhas: r.contexto.linhas, autor: r.autor }
      });
    }
  }

  log.info({ tenantId, campaignId: id }, 'Geracao de mensagens terminada');
  ver('aquiles', 'terminou de escrever as mensagens da campanha', 'agora e revisar e aprovar');
}

/** Reescreve a mensagem de UM cliente (botao "Gerar outra" da revisao). */
export async function regerarAlvo(tenantId, alvoId) {
  const alvo = await repo.buscarAlvo(tenantId, alvoId);
  if (!alvo) throw new NaoEncontrado('Mensagem da campanha');
  if (!['aguardando', 'pendente', 'aprovada'].includes(alvo.status)) {
    throw new RegraDeNegocio('Esta mensagem ja foi enviada e nao pode ser reescrita.');
  }

  const campanha = await exigir(tenantId, alvo.campaignId);
  // Com o disparo andando, texto novo voltaria para revisao no meio da fila.
  if (!EM_PREPARO.includes(campanha.status)) {
    throw new RegraDeNegocio('Com o disparo em andamento, so da para editar o texto da mensagem.');
  }
  const [lead] = await repo.contextoDosLeads(tenantId, [alvo.leadId]);
  if (!lead) throw new NaoEncontrado('Contato');

  const { nomeEmpresa, fuso } = await contexto(tenantId);
  const redator = await carregarRedator(tenantId);
  const r = await escreverMensagem({ tenantId, campanha, iaConfig: campanha.iaConfig, lead, nomeEmpresa, fuso, redator });

  await repo.atualizarAlvo(tenantId, alvoId, {
    mensagem: r.mensagem,
    mensagemReserva: r.reserva,
    // Texto novo precisa de leitura nova: volta para a revisao mesmo se ja
    // tinha sido aprovado.
    status: 'pendente',
    contextoGeracao: { linhas: r.contexto.linhas, autor: r.autor }
  });
  await recalcularPreparo(tenantId, campanha.id);

  return { mensagem: r.mensagem, reserva: r.reserva };
}

/** Tira UM cliente da campanha durante a revisao. */
export async function removerAlvo(tenantId, alvoId) {
  const alvo = await repo.buscarAlvo(tenantId, alvoId);
  if (!alvo) throw new NaoEncontrado('Mensagem da campanha');
  if (!['aguardando', 'pendente', 'aprovada'].includes(alvo.status)) {
    throw new RegraDeNegocio('Esta mensagem ja foi enviada.');
  }
  const campanha = await exigir(tenantId, alvo.campaignId);
  if (!EM_PREPARO.includes(campanha.status)) {
    throw new RegraDeNegocio('Com o disparo em andamento, use Parar para encerrar a campanha.');
  }

  await repo.excluirAlvo(tenantId, alvoId);
  await recalcularPreparo(tenantId, alvo.campaignId);
  return { ok: true };
}

/** Edita a mensagem de um alvo antes do envio. */
export async function editarMensagem(tenantId, alvoId, mensagem) {
  const alvo = await repo.buscarAlvo(tenantId, alvoId);
  if (!alvo) throw new NaoEncontrado('Mensagem da campanha');

  if (['enviada', 'enviando', 'respondeu', 'falha', 'pulada'].includes(alvo.status)) {
    throw new RegraDeNegocio('Esta mensagem ja foi enviada e nao pode ser alterada.');
  }

  // Quem editou leu: o texto deixa de ser "o de reserva".
  await repo.atualizarAlvo(tenantId, alvoId, { mensagem, mensagemReserva: false });
  return { ok: true };
}

/**
 * Aprova mensagens — a revisao humana antes do disparo.
 *
 * `aprovar: false` devolve para a revisao (desfazer um clique errado).
 */
export async function aprovar(tenantId, campaignId, { alvoIds, todos = false, aprovar: aprova = true }, { usuario } = {}) {
  const campanha = await exigir(tenantId, campaignId);
  if (!EM_PREPARO.includes(campanha.status)) {
    throw new RegraDeNegocio('Esta campanha nao esta em revisao.');
  }

  const de = aprova ? ['pendente'] : ['aprovada'];
  const alvos = todos
    ? await repo.listarAlvos(tenantId, campaignId, { status: de, limite: 1000 })
    : (await repo.listarAlvos(tenantId, campaignId, { status: de, limite: 1000 })).filter((a) => alvoIds?.includes(a.id));

  for (const alvo of alvos) {
    await repo.atualizarAlvo(tenantId, alvo.id, { status: aprova ? 'aprovada' : 'pendente' });
  }

  await recalcularPreparo(tenantId, campaignId);

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: aprova ? 'campanha.aprovar' : 'campanha.desaprovar',
    entidade: 'campanha',
    entidadeId: campaignId,
    dados: { depois: { quantidade: alvos.length } }
  });

  return { aprovados: aprova ? alvos.length : 0, devolvidos: aprova ? 0 : alvos.length };
}

// ============================================================================
// ETAPA 5 — O DISPARO
// ============================================================================

/** Execucoes em andamento, por campanha. */
const execucoes = new Map();

export function estaRodando(campaignId) {
  return execucoes.has(campaignId);
}

/**
 * Espera que pode ser interrompida.
 *
 * Um "pausar" clicado no meio de um intervalo de 70 segundos precisa valer
 * na hora, nao depois que o intervalo acabar.
 */
function esperar(estado, ms) {
  return new Promise((resolve) => {
    const fim = () => {
      clearTimeout(timer);
      estado.acordar = null;
      resolve();
    };
    const timer = setTimeout(fim, Math.max(0, ms));
    timer.unref?.();
    estado.acordar = fim;
  });
}

/**
 * Quando a janela de envio abre de novo, se agora estiver fora dela.
 * Devolve null se agora esta dentro.
 */
function proximaAbertura(campanha, fuso, agora = Date.now()) {
  const hora = horaNoFuso(agora, fuso);
  if (hora >= campanha.janelaInicio && hora < campanha.janelaFim) return null;

  const hoje = dataNoFuso(agora, fuso);
  const dia = hora < campanha.janelaInicio ? hoje : somarDias(hoje, 1);
  return instanteDeLocal(dia, campanha.janelaInicio, fuso);
}

/** Numero desconectado: tenta de novo a cada 30s, por ate 5 minutos. */
const ESPERA_CANAL_MS = 30_000;
const ESPERAS_PELO_CANAL = 10;

/** Tempo de "digitando..." para um texto: o de alguem digitando no celular. */
function tempoDigitando(texto) {
  return Math.min(8000, Math.max(2500, String(texto).length * 45));
}

/**
 * Inicia (ou retoma) o disparo.
 *
 * Retorna na hora; o envio roda em segundo plano, respeitando intervalo
 * aleatorio, janela de horario e limite diario.
 */
export async function iniciar(tenantId, campaignId, { enviar }, { usuario } = {}) {
  const campanha = await exigir(tenantId, campaignId);

  const emCurso = execucoes.get(campaignId);
  if (emCurso) {
    // Pausou e clicou em retomar logo em seguida: o laco antigo ainda esta
    // terminando a mensagem que estava saindo.
    throw new Conflito(
      emCurso.pausar ? 'Aguarde alguns segundos: a ultima mensagem ainda esta saindo.' : 'Esta campanha ja esta enviando.'
    );
  }
  if (!['pronta', 'pausada'].includes(campanha.status)) {
    throw new RegraDeNegocio(
      campanha.status === 'revisao' || campanha.status === 'rascunho'
        ? 'Aprove as mensagens antes de iniciar o envio.'
        : `Campanha "${campanha.status}" nao pode iniciar.`
    );
  }

  // O que estava esperando revisao nao sai: so vai quem foi aprovado.
  const aprovadas = (await repo.contarPorStatus(tenantId, campaignId)).aprovada ?? 0;
  const destravados = await repo.destravarPendentes(tenantId, campaignId);
  if (aprovadas + destravados === 0) {
    // Campanha que ja enviou tudo (e ficou pausada no limite): nao ha o que
    // retomar, ela so precisa constar como concluida.
    if (await concluirSeTerminou(tenantId, campaignId)) return { status: 'concluida' };
    throw new RegraDeNegocio('Nao ha mensagens aprovadas para enviar.');
  }

  ver(
    'campanha',
    `${negrito(campanha.nome)}: ${campanha.status === 'pausada' ? 'retomando' : 'iniciando'} o disparo`,
    `${aprovadas + destravados} mensagem(ns) aprovada(s)`
  );

  await repo.atualizar(tenantId, campaignId, {
    status: 'enviando',
    iniciadaEm: campanha.iniciadaEm ?? new Date(),
    esperaMotivo: null,
    retomaEm: null
  });

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: campanha.status === 'pausada' ? 'campanha.retomar' : 'campanha.iniciar',
    entidade: 'campanha',
    entidadeId: campaignId
  });

  rodarFila(tenantId, campaignId, enviar);
  return { status: 'enviando' };
}

function rodarFila(tenantId, campaignId, enviar) {
  const estado = { parar: false, pausar: false, acordar: null };
  execucoes.set(campaignId, estado);

  executarFila(tenantId, campaignId, estado, enviar)
    .catch(async (err) => {
      log.error({ err, campaignId }, 'Fila de campanha morreu inesperadamente');
      await repo
        .atualizar(tenantId, campaignId, { status: 'pausada', esperaMotivo: 'Erro inesperado no disparo', proximoEnvioEm: null })
        .catch(() => {});
    })
    .finally(() => {
      if (execucoes.get(campaignId) === estado) execucoes.delete(campaignId);
    });
}

/** O canal caiu: nao adianta seguir tentando e marcar todo mundo como falha. */
function ehCanalDesconectado(err) {
  return /n[aã]o est[aá] conectad/i.test(String(err?.message ?? ''));
}

async function executarFila(tenantId, campaignId, estado, enviar) {
  const { fuso } = await contexto(tenantId);

  const campanhaInicial = await repo.buscarPorId(tenantId, campaignId);
  // A campanha guarda o ID da instancia de canal, mas o gateway enderecca
  // pela CHAVE curta ('W1'). Resolvemos uma vez aqui, fora do laco.
  const instancia = await db.query.channelInstances.findFirst({
    where: eq(channelInstances.id, campanhaInicial.channelInstanceId)
  });

  if (!instancia) {
    log.error({ campaignId }, 'Canal da campanha nao existe mais; pausando');
    await repo.atualizar(tenantId, campaignId, { status: 'pausada', esperaMotivo: 'O numero de envio foi removido' });
    return;
  }

  while (!estado.parar && !estado.pausar) {
    const campanha = await repo.buscarPorId(tenantId, campaignId);
    if (!campanha || campanha.status !== 'enviando') break;

    // Campanhas desligadas pelo DEV: a que estava enviando para aqui.
    if (!(await funcaoLigada(tenantId, 'campanhas'))) {
      await repo.atualizar(tenantId, campaignId, { status: 'pausada', esperaMotivo: 'Campanhas desativadas no sistema' });
      break;
    }
    if (licencaBloqueada()) {
      await repo.atualizar(tenantId, campaignId, { status: 'pausada', esperaMotivo: 'Licenca do sistema vencida' });
      break;
    }

    // Janela de horario: ninguem quer receber mensagem as 3 da manha, e
    // disparar de madrugada e sinal classico de robo. Fora dela, a campanha
    // ESPERA — nao pausa: ninguem precisa lembrar de retomar amanha.
    const abre = proximaAbertura(campanha, fuso);
    if (abre) {
      await repo.atualizar(tenantId, campaignId, {
        esperaMotivo: 'Fora do horario de envio',
        retomaEm: new Date(abre),
        proximoEnvioEm: new Date(abre)
      });
      // Acorda de minuto em minuto para enxergar mudanca de janela feita na tela.
      await esperar(estado, Math.min(abre - Date.now(), 60_000));
      continue;
    }

    const hoje = dataNoFuso(Date.now(), fuso);
    const enviadosHoje = await repo.enviadosDesde(tenantId, campaignId, inicioDoDia(hoje, fuso));
    if (enviadosHoje >= campanha.limiteDiario) {
      const amanha = instanteDeLocal(somarDias(hoje, 1), campanha.janelaInicio, fuso);
      await repo.atualizar(tenantId, campaignId, {
        esperaMotivo: `Limite de ${campanha.limiteDiario} envios por dia atingido`,
        retomaEm: new Date(amanha),
        proximoEnvioEm: new Date(amanha)
      });
      await esperar(estado, Math.min(amanha - Date.now(), 60_000));
      continue;
    }

    if (campanha.esperaMotivo) {
      await repo.atualizar(tenantId, campaignId, { esperaMotivo: null, retomaEm: null });
    }

    const alvo = await repo.reservarProximoAlvo(tenantId, campaignId);
    if (!alvo) {
      await repo.atualizar(tenantId, campaignId, {
        status: 'concluida',
        concluidaEm: new Date(),
        proximoEnvioEm: null,
        esperaMotivo: null,
        retomaEm: null
      });
      log.info({ campaignId }, 'Campanha concluida');
      break;
    }

    const resultado = await despacharAlvo({ tenantId, campanha, alvo, enviar, instanciaChave: instancia.chave });

    /**
     * Numero desconectado. Logo depois de a API reiniciar, o WhatsApp ainda
     * esta reconectando — entao esperamos alguns minutos antes de desistir.
     * Se nao voltar, pausa com o motivo, e alguem retoma depois de reconectar.
     */
    if (resultado === 'canal_caiu') {
      estado.tentativasCanal = (estado.tentativasCanal ?? 0) + 1;
      if (estado.tentativasCanal > ESPERAS_PELO_CANAL) {
        await repo.atualizar(tenantId, campaignId, {
          status: 'pausada',
          esperaMotivo: 'O WhatsApp deste numero esta desconectado',
          proximoEnvioEm: null,
          retomaEm: null
        });
        break;
      }
      const volta = Date.now() + ESPERA_CANAL_MS;
      await repo.atualizar(tenantId, campaignId, {
        esperaMotivo: 'Aguardando o WhatsApp deste numero reconectar',
        retomaEm: new Date(volta),
        proximoEnvioEm: new Date(volta)
      });
      await esperar(estado, ESPERA_CANAL_MS);
      continue;
    }
    estado.tentativasCanal = 0;

    // Foi a ultima? Conclui na hora, sem esperar o intervalo de descanso.
    if (await concluirSeTerminou(tenantId, campaignId)) break;

    // Intervalo aleatorio entre um envio e o proximo: o ritmo de uma pessoa.
    const { intervaloMinSegundos: min, intervaloMaxSegundos: max } = campanha;
    const esperaMs = (min + Math.random() * Math.max(0, max - min)) * 1000;
    await repo.atualizar(tenantId, campaignId, { proximoEnvioEm: new Date(Date.now() + esperaMs) });
    await esperar(estado, esperaMs);
  }
}

/**
 * Envia para UM alvo.
 *
 * Primeiro tenta ENVIAR de verdade; so marca 'enviada' e carimba `enviadoEm`
 * depois que o canal confirma. Se o envio falhar, o alvo vira 'falha' com o
 * motivo — em vez de o painel mostrar sucesso para uma mensagem que nunca saiu.
 *
 * @returns {Promise<'enviada'|'falha'|'canal_caiu'>}
 */
async function despacharAlvo({ tenantId, campanha, alvo, enviar, instanciaChave }) {
  let resultado;
  try {
    resultado = await enviar({
      tenantId,
      canal: 'whatsapp',
      instanciaChave,
      destino: alvo.telefone,
      texto: alvo.mensagem,
      digitandoMs: campanha.simularDigitacao ? tempoDigitando(alvo.mensagem) : 0
    });
  } catch (err) {
    if (ehCanalDesconectado(err)) {
      // Devolve para a fila: a mensagem nao saiu, e sai quando o numero voltar.
      await repo.atualizarAlvo(tenantId, alvo.id, { status: 'aprovada' });
      log.warn({ campaignId: campanha.id }, 'Canal desconectado; campanha pausada');
      return 'canal_caiu';
    }

    await repo.atualizarAlvo(tenantId, alvo.id, {
      status: 'falha',
      erro: err.message?.slice(0, 300) ?? 'Falha desconhecida',
      tentativas: (alvo.tentativas ?? 0) + 1
    });
    const contagens = await repo.contarPorStatus(tenantId, campanha.id);
    await repo.atualizar(tenantId, campanha.id, { totalFalhas: contagens.falha ?? 0 });
    log.error({ err, campaignId: campanha.id, alvoId: alvo.id }, 'Falha ao enviar mensagem de campanha');
    ver('erro', `${negrito(campanha.nome)}: nao consegui enviar a ${mascarar(alvo.telefone)}`, resumir(err.message, 90));
    return 'falha';
  }

  // Só depois da confirmacao do canal.
  await repo.atualizarAlvo(tenantId, alvo.id, { status: 'enviada', enviadoEm: new Date(), erro: null });
  const contagens = await repo.contarPorStatus(tenantId, campanha.id);
  await repo.atualizar(tenantId, campanha.id, {
    totalEnviadas: (contagens.enviada ?? 0) + (contagens.respondeu ?? 0)
  });

  // Registra na conversa do cliente: o atendente (e a Sofia) precisam ver que
  // a empresa falou com ele, senao respondem sem saber do que se trata.
  try {
    // Amarra a conversa ao numero da campanha: e por ele que o cliente vai
    // responder, e por ele que o atendente precisa devolver.
    const conversationId = await conversas.encontrarOuAbrir(tenantId, {
      leadId: alvo.leadId,
      channelInstanceId: campanha.channelInstanceId
    });
    await conversas.registrarEnviada(tenantId, conversationId, {
      conteudo: alvo.mensagem,
      autorTipo: 'ia',
      externalId: resultado?.idExterno ?? null,
      metadados: { origem: 'campanha', campaignId: campanha.id, campanhaNome: campanha.nome, alvoId: alvo.id }
    });
  } catch (err) {
    // A mensagem JA foi entregue ao cliente. Nao registrar na conversa e
    // ruim, mas nao justifica marcar como falha e reenviar.
    log.warn({ err, alvoId: alvo.id }, 'Enviado, mas falhou ao registrar na conversa');
  }

  // Carimba no lead para o bloqueio de 15 dias valer na proxima campanha.
  await db.update(leads).set({ ultimaCampanhaEm: new Date() }).where(eq(leads.id, alvo.leadId));

  log.info({ campaignId: campanha.id, alvoId: alvo.id }, 'Mensagem de campanha entregue');
  ver(
    'campanha',
    `${negrito(campanha.nome)}: entregue a ${mascarar(alvo.telefone)}`,
    `${instanciaChave}${campanha.simularDigitacao ? ' · digitando antes de enviar' : ''}`
  );
  return 'enviada';
}

/**
 * Ja saiu tudo o que era para sair? Entao a campanha esta concluida.
 *
 * Nao da para deixar isso so para o laco de envio: depois da ultima mensagem
 * ele ainda espera o intervalo aleatorio (ate 70s) antes de olhar a fila de
 * novo, e nessa janela um "Pausar" deixava a campanha pausada com 100% para
 * sempre — sem nada para retomar e sem nunca marcar como concluida. Por isso
 * a pergunta e feita logo apos cada envio, ao pausar, ao retomar e ao listar.
 */
async function concluirSeTerminou(tenantId, campaignId, contagens) {
  const c = contagens ?? (await repo.contarPorStatus(tenantId, campaignId));
  const restam = (c.aprovada ?? 0) + (c.enviando ?? 0);
  const feitas = (c.enviada ?? 0) + (c.respondeu ?? 0) + (c.falha ?? 0);
  if (restam > 0 || feitas === 0) return false;

  await repo.atualizar(tenantId, campaignId, {
    status: 'concluida',
    concluidaEm: new Date(),
    proximoEnvioEm: null,
    esperaMotivo: null,
    retomaEm: null
  });
  log.info({ campaignId }, 'Campanha concluida');
  ver('campanha', `campanha ${colorir('campanha', 'concluida')}`, 'todas as mensagens foram entregues');
  return true;
}

/** Pausa: para depois da mensagem em curso e retoma de onde estava. */
export async function pausar(tenantId, campaignId, { usuario } = {}) {
  const campanha = await exigir(tenantId, campaignId);
  if (campanha.status !== 'enviando') {
    throw new RegraDeNegocio('So da para pausar uma campanha que esta enviando.');
  }

  const estado = execucoes.get(campaignId);
  if (estado) {
    estado.pausar = true;
    estado.acordar?.();
  }

  // Pausar quando ja nao ha mais nada a enviar e apenas terminar.
  if (await concluirSeTerminou(tenantId, campaignId)) return { status: 'concluida' };

  ver('campanha', `${negrito(campanha.nome)}: pausada`, 'para depois da mensagem em curso');
  await repo.atualizar(tenantId, campaignId, { status: 'pausada', proximoEnvioEm: null, esperaMotivo: null, retomaEm: null });
  await registrarAuditoria({ tenantId, usuario, acao: 'campanha.pausar', entidade: 'campanha', entidadeId: campaignId });
  return { status: 'pausada' };
}

/**
 * Para de vez ("Parar" na tela).
 *
 * O que ja saiu fica registrado; o que nao saiu vira 'pulada' — assim o
 * relatorio mostra com clareza quem recebeu e quem ficou sem receber.
 */
export async function cancelar(tenantId, campaignId, { usuario } = {}) {
  const campanha = await exigir(tenantId, campaignId);
  if (FINALIZADAS.includes(campanha.status)) return { status: campanha.status };

  const estado = execucoes.get(campaignId);
  if (estado) {
    estado.parar = true;
    estado.acordar?.();
  }
  const geracao = geracoes.get(campaignId);
  if (geracao) geracao.parar = true;

  ver('campanha', `${negrito(campanha.nome)}: parada definitivamente`, 'o que nao saiu vira "nao enviada"');
  await repo.atualizar(tenantId, campaignId, {
    status: 'cancelada',
    concluidaEm: new Date(),
    proximoEnvioEm: null,
    esperaMotivo: null,
    retomaEm: null
  });
  await repo.mudarStatusDosAlvos(tenantId, campaignId, ['aguardando', 'pendente', 'aprovada', 'enviando'], {
    status: 'pulada',
    erro: 'Campanha parada antes do envio'
  });

  await registrarAuditoria({ tenantId, usuario, acao: 'campanha.cancelar', entidade: 'campanha', entidadeId: campaignId });
  return { status: 'cancelada' };
}

export async function excluir(tenantId, campaignId, { usuario } = {}) {
  await cancelar(tenantId, campaignId, { usuario });
  return repo.excluir(tenantId, campaignId);
}

/**
 * Retoma o que o reinicio da API interrompeu.
 *
 * O laco de envio e a geracao moram em memoria; se o processo cai, eles
 * morrem. Sem isto, uma campanha ficaria "enviando" para sempre sem enviar
 * nada — o mesmo tipo de mentira do painel que o sistema antigo contava.
 */
export async function retomarInterrompidas({ enviar }) {
  const pendentes = await repo.listarEmStatus(['enviando', 'gerando']);

  for (const c of pendentes) {
    if (c.status === 'gerando' && !geracoes.has(c.id)) {
      log.info({ campaignId: c.id }, 'Retomando geracao de mensagens interrompida');
      iniciarGeracao(c.tenantId, c.id);
    }
    if (c.status === 'enviando' && !execucoes.has(c.id)) {
      await repo.destravarPendentes(c.tenantId, c.id);
      log.info({ campaignId: c.id }, 'Retomando disparo interrompido');
      rodarFila(c.tenantId, c.id, enviar);
    }
  }
  return pendentes.length;
}

// ============================================================================
// RESPOSTAS
// ============================================================================

/**
 * Chamado para cada mensagem recebida: e resposta a uma campanha?
 *
 * Barato quando nao e (uma consulta indexada); so chama a IA para classificar
 * quando o cliente de fato recebeu campanha nos ultimos dias.
 */
export async function registrarResposta(tenantId, leadId, texto) {
  const alvo = await repo.alvoAguardandoResposta(tenantId, leadId, Date.now() - PRAZO_RESPOSTA_MS);
  if (!alvo) return { classificado: false };
  return classificarResposta(tenantId, leadId, texto);
}

/**
 * Classifica a resposta do cliente a uma campanha.
 *
 * Uma recusa marca o lead como "nao quer campanha" automaticamente. Isso
 * respeita o pedido dele sem depender de alguem lembrar de marcar na mao —
 * e e o que evita que a proxima campanha o incomode de novo.
 */
export async function classificarResposta(tenantId, leadId, texto) {
  const alvo = await repo.ultimoAlvoDoLead(tenantId, leadId);
  if (!alvo) return { classificado: false, motivo: 'Este cliente nao recebeu campanha recente.' };

  let classificacao = 'neutro';

  try {
    const r = await gerar({
      tenantId,
      origem: 'campanha',
      systemPrompt: [
        'Classifique a resposta de um cliente que recebeu uma mensagem comercial.',
        'Responda APENAS uma destas palavras:',
        'INTERESSADO - quer saber mais, quer agendar, perguntou algo, foi receptivo',
        'RECUSA - nao quer, pediu para parar de receber, foi negativo',
        'NEUTRO - so cumprimentou, ainda nao da pra saber'
      ].join('\n'),
      mensagens: [{ papel: 'user', conteudo: `Resposta do cliente: "${texto}"` }],
      temperatura: 0,
      maxTokens: 10
    });

    const decisao = r.texto.toUpperCase();
    if (decisao.includes('INTERESSADO')) classificacao = 'interessado';
    else if (decisao.includes('RECUSA')) classificacao = 'recusa';
  } catch (err) {
    log.warn({ err, leadId }, 'IA indisponivel para classificar; deixando como neutro para revisao humana');
  }

  await repo.atualizarAlvo(tenantId, alvo.id, {
    status: 'respondeu',
    respostaTexto: String(texto).slice(0, 2000),
    respondidoEm: new Date(),
    classificacao
  });

  const contagens = await repo.contarPorStatus(tenantId, alvo.campaignId);
  await repo.atualizar(tenantId, alvo.campaignId, { totalRespostas: contagens.respondeu ?? 0 });

  if (classificacao === 'recusa') {
    await db.update(leads).set({ aceitaCampanha: false }).where(eq(leads.id, leadId));
    log.info({ leadId }, 'Cliente recusou; marcado para nao receber mais campanhas');
  }

  return { classificado: true, classificacao };
}
