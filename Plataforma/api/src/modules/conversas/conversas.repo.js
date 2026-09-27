import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db, emTransacao } from '../../db/client.js';
import { channelInstances, conversations, messages } from '../../db/schema/conversations.js';
import { leads } from '../../db/schema/crm.js';
import { users } from '../../db/schema/auth.js';
import { ID } from '../../core/ids.js';
import { emitir, EVENTOS } from '../../core/eventos.js';

const base = (tenantId) => and(eq(conversations.tenantId, tenantId), isNull(conversations.deletedAt));

/**
 * Recorte de privacidade: o que este atendente pode enxergar.
 *
 * Conversa SEM dono (com a IA ou na fila) aparece para todo mundo — e de la
 * que sai o trabalho, e esconder a fila deixaria o cliente esperando com a
 * equipe inteira de bracos cruzados. Assim que alguem assume, ela sai da vista
 * dos outros.
 *
 * `undefined` quando nao ha recorte: o `and()` do drizzle simplesmente ignora.
 */
function somenteDoEscopo(escopo) {
  if (!escopo || escopo.tudo) return undefined;
  return or(isNull(conversations.assignedUserId), eq(conversations.assignedUserId, escopo.userId));
}

const selecao = {
  conversa: conversations,
  leadNome: leads.nome,
  leadTelefone: leads.telefone,
  leadHumor: leads.humor,
  leadFotoUrl: leads.fotoUrl,
  atendenteNome: users.nome,
  canalNome: channelInstances.nome,
  canalChave: channelInstances.chave
};

function comRelacionados(consulta) {
  return consulta
    .from(conversations)
    .leftJoin(leads, eq(leads.id, conversations.leadId))
    .leftJoin(users, eq(users.id, conversations.assignedUserId))
    .leftJoin(channelInstances, eq(channelInstances.id, conversations.channelInstanceId));
}

export async function buscarPorId(tenantId, id) {
  const [linha] = await comRelacionados(db.select(selecao))
    .where(and(base(tenantId), eq(conversations.id, id)))
    .limit(1);
  return linha ?? null;
}

/**
 * Lista as conversas da mesa de atendimento.
 *
 * `filtro` traduz o que o atendente ve na tela:
 *  - 'minhas'     : as que ele assumiu
 *  - 'fila'       : pediram humano e ninguem pegou ainda
 *  - 'bot'        : a IA esta conduzindo
 *  - 'ativas'     : tudo que nao esta finalizado
 *  - 'finalizadas': encerradas
 */
export async function listar(
  tenantId,
  { filtro = 'ativas', usuarioId, busca, canal, instancia, limite = 50, cursor, escopo, atendenteId, finalizadaDe, finalizadaAte } = {}
) {
  const condicoes = [base(tenantId), somenteDoEscopo(escopo)].filter(Boolean);

  // Filtro por canal (whatsapp, telegram...) e por conexao (W1, W2...).
  if (canal) condicoes.push(eq(conversations.canal, canal));
  if (instancia) condicoes.push(eq(channelInstances.chave, instancia));
  if (atendenteId) condicoes.push(eq(conversations.assignedUserId, atendenteId));
  if (finalizadaDe) condicoes.push(gte(conversations.finalizadaEm, new Date(finalizadaDe)));
  if (finalizadaAte) condicoes.push(lt(conversations.finalizadaEm, new Date(finalizadaAte)));

  switch (filtro) {
    /**
     * TODOS — o que e MEU, com a IA ou com gente. So quem enxerga a equipe
     * inteira (o dono, por padrao) ve tudo aqui; para os demais e o recorte do
     * proprio login. A fila comum e a vitrine da Sofia ficam nos seus filtros.
     */
    case 'todos':
      condicoes.push(ne(conversations.status, 'finalizada'));
      if (escopo && !escopo.tudo) condicoes.push(eq(conversations.assignedUserId, escopo.userId));
      break;
    /** HUMANO — o cliente esta sendo atendido por uma pessoa (ela ja escreveu). */
    case 'humano':
      condicoes.push(eq(conversations.status, 'humana'));
      break;
    /**
     * SOFIA — atendimento so da IA, ainda sem dono. Todos veem: e a vitrine de
     * onde um atendente pode "pescar" um cliente. Assim que alguem assume (ou o
     * sistema atribui, como quando a IA marca um horario), sai daqui.
     */
    case 'sofia':
      condicoes.push(eq(conversations.status, 'bot'), isNull(conversations.assignedUserId));
      break;
    case 'minhas':
      condicoes.push(eq(conversations.assignedUserId, usuarioId), eq(conversations.status, 'humana'));
      break;
    case 'fila':
      condicoes.push(eq(conversations.status, 'na_fila'));
      break;
    case 'bot':
      condicoes.push(eq(conversations.status, 'bot'));
      break;
    case 'finalizadas':
      condicoes.push(eq(conversations.status, 'finalizada'));
      break;
    case 'ativas':
    default:
      condicoes.push(ne(conversations.status, 'finalizada'));
      break;
  }

  if (busca) {
    const termo = `%${busca.trim()}%`;
    condicoes.push(or(sql`${leads.nome} LIKE ${termo}`, sql`${leads.telefone} LIKE ${termo}`));
  }

  if (cursor) condicoes.push(lt(conversations.id, cursor));

  const linhas = await comRelacionados(db.select(selecao))
    .where(and(...condicoes))
    // Conversa com mensagem mais recente primeiro: e a ordem de urgencia real
    // de quem esta atendendo.
    // Finalizadas: as encerradas por ultimo primeiro. As demais, por mensagem.
    .orderBy(
      filtro === 'finalizadas' ? desc(conversations.finalizadaEm) : desc(conversations.ultimaMensagemEm),
      desc(conversations.id)
    )
    .limit(Math.min(limite, 100) + 1);

  const temMais = linhas.length > Math.min(limite, 100);
  const pagina = temMais ? linhas.slice(0, -1) : linhas;

  return { itens: pagina, proximoCursor: temMais ? pagina.at(-1).conversa.id : null };
}

/**
 * Quem falou por ultimo em cada conversa: 'entrada' (o cliente) ou 'saida'.
 *
 * Avisos de sistema ("transferido para Fulano") nao contam: nao sao uma
 * resposta ao cliente. Usa o indice (conversa, data); o `max()` com coluna
 * solta e um recurso do SQLite que devolve a linha do maximo.
 *
 * @returns {Promise<Map<string, 'entrada'|'saida'>>}
 */
export async function ultimaDirecaoPorConversa(tenantId, ids) {
  if (!ids.length) return new Map();
  const linhas = await db
    .select({ conversationId: messages.conversationId, direcao: messages.direcao, em: sql`max(${messages.createdAt})` })
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), inArray(messages.conversationId, ids), ne(messages.autorTipo, 'sistema')))
    .groupBy(messages.conversationId);
  return new Map(linhas.map((l) => [l.conversationId, l.direcao]));
}

/**
 * Quando um ATENDENTE escreveu pela ultima vez nesta conversa (ou null).
 *
 * Uma linha so, direto no banco: e consultada a cada mensagem que chega numa
 * conversa com atendente, para saber se ele sumiu (ver o gateway).
 */
export async function ultimaMensagemHumanaEm(tenantId, conversationId) {
  const [linha] = await db
    .select({ em: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, conversationId), eq(messages.autorTipo, 'humano')))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return linha?.em ?? null;
}

/**
 * Conversa aberta de um lead NUMA CONEXAO (W1, W2...), se houver.
 * `channelInstanceId` nulo procura as conversas sem conexao gravada.
 */
/**
 * A conversa aberta do cliente por QUALQUER conexao — para quem chega pela
 * ficha do cliente, que nao sabe por qual numero ele escreveu. (A busca de
 * baixo, por conexao, e a do WhatsApp: ali a conexao importa.)
 */
export function buscarQualquerAbertaDoLead(tenantId, leadId) {
  return db.query.conversations.findFirst({
    where: and(
      eq(conversations.tenantId, tenantId),
      eq(conversations.leadId, leadId),
      ne(conversations.status, 'finalizada'),
      isNull(conversations.deletedAt)
    ),
    orderBy: desc(conversations.ultimaMensagemEm)
  });
}

export function buscarAbertaDoLead(tenantId, leadId, channelInstanceId = null) {
  return db.query.conversations.findFirst({
    where: and(
      eq(conversations.tenantId, tenantId),
      eq(conversations.leadId, leadId),
      channelInstanceId
        ? eq(conversations.channelInstanceId, channelInstanceId)
        : isNull(conversations.channelInstanceId),
      ne(conversations.status, 'finalizada'),
      isNull(conversations.deletedAt)
    ),
    orderBy: desc(conversations.ultimaMensagemEm)
  });
}

export async function criar(tenantId, dados, tx = db) {
  const registro = { id: ID.conversa(), tenantId, ...dados };
  await tx.insert(conversations).values(registro);
  emitir(EVENTOS.CONVERSA, { tenantId, id: registro.id });
  return registro.id;
}

export async function atualizar(tenantId, id, dados, tx = db) {
  await tx.update(conversations).set(dados).where(and(base(tenantId), eq(conversations.id, id)));
  // Todo caminho que muda uma conversa passa por aqui: e o ponto unico onde
  // "algo mudou" pode ser anunciado sem esquecer nenhum.
  emitir(EVENTOS.CONVERSA, { tenantId, id });
}

/**
 * Espelha o humor no cadastro do lead.
 *
 * A conversa guarda o humor DAQUELE atendimento; o lead guarda o mais recente,
 * que e o que o CRM e as campanhas leem ("nao dispare promocao para quem
 * saiu frustrado da ultima conversa").
 */
export async function atualizarHumorDoLead(tenantId, leadId, humor) {
  await db
    .update(leads)
    .set({ humor, humorAtualizadoEm: new Date() })
    .where(and(eq(leads.tenantId, tenantId), eq(leads.id, leadId)));
}

// ============================================================================
// MENSAGENS
// ============================================================================

export function listarMensagens(tenantId, conversationId, { limite = 100, antesDe } = {}) {
  const condicoes = [eq(messages.tenantId, tenantId), eq(messages.conversationId, conversationId)];
  if (antesDe) condicoes.push(lt(messages.id, antesDe));

  return db
    .select({ mensagem: messages, autorNome: users.nome })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.autorUserId))
    .where(and(...condicoes))
    .orderBy(desc(messages.id))
    .limit(Math.min(limite, 200));
}

/**
 * Grava a mensagem E atualiza o resumo da conversa, na mesma transacao.
 *
 * O resumo (previa da ultima mensagem, horario, contadores) fica duplicado na
 * conversa de proposito: sem isso, montar a lista da mesa com 200 conversas
 * exigiria uma consulta por conversa so pra descobrir a ultima mensagem.
 *
 * A duplicacao so e segura porque as duas escritas acontecem juntas — se
 * fossem separadas, uma falha deixaria a lista mostrando uma previa que nao
 * corresponde a nenhuma mensagem real.
 */
export async function registrarMensagem(tenantId, conversationId, dados, tx = db) {
  const executar = async (t) => {
    const id = ID.mensagem();

    await t.insert(messages).values({
      id,
      tenantId,
      conversationId,
      ...dados
    });

    const preview = String(dados.conteudo ?? '').slice(0, 140);
    const agora = new Date();

    const contador =
      dados.autorTipo === 'lead' ? { totalMensagensCliente: sql`${conversations.totalMensagensCliente} + 1` }
      : dados.autorTipo === 'humano' ? { totalMensagensHumano: sql`${conversations.totalMensagensHumano} + 1` }
      : dados.autorTipo === 'ia' || dados.autorTipo === 'menu'
        ? { totalMensagensIa: sql`${conversations.totalMensagensIa} + 1` }
        : {};

    await t
      .update(conversations)
      .set({
        ultimaMensagemPreview: preview,
        ultimaMensagemEm: agora,
        updatedAt: agora,
        // Mensagem do cliente incrementa nao-lidas; resposta nossa zera.
        naoLidas:
          dados.autorTipo === 'lead'
            ? sql`${conversations.naoLidas} + 1`
            : 0,
        ...contador
      })
      .where(eq(conversations.id, conversationId));

    return id;
  };

  const id = await (tx === db ? emTransacao(executar) : executar(tx));
  emitir(EVENTOS.CONVERSA, { tenantId, id: conversationId });
  return id;
}

/** Uma mensagem externa ja foi registrada? Evita duplicata em reenvio. */
export async function mensagemExternaExiste(tenantId, externalId) {
  if (!externalId) return false;
  const achada = await db.query.messages.findFirst({
    where: and(eq(messages.tenantId, tenantId), eq(messages.externalId, externalId))
  });
  return Boolean(achada);
}

/** Instante da primeira mensagem do cliente ainda sem resposta nossa. */
export async function primeiraMensagemNaoRespondida(tenantId, conversationId) {
  const [linha] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.conversationId, conversationId),
        eq(messages.autorTipo, 'lead')
      )
    )
    .orderBy(asc(messages.createdAt))
    .limit(1);

  return linha?.createdAt ?? null;
}

// ============================================================================
// DISTRIBUICAO PARA ATENDENTES
// ============================================================================

/**
 * Atendentes disponiveis, com quantas conversas cada um ja tem.
 *
 * A ordem (menos carregado primeiro) e o que faz a distribuicao ser justa.
 * Sem isso, a fila cai sempre no primeiro da lista.
 */
/**
 * A equipe com a carga de cada um, do menos carregado ao mais carregado.
 *
 * `presencas` filtra por disponibilidade e muda conforme a pergunta:
 *
 *   - DISTRIBUIR automaticamente pergunta "quem esta de plantao agora?" e
 *     passa `['online']` (ou tambem `ausente`, se a empresa permitir). Entregar
 *     cliente a quem fechou o sistema e o mesmo que deixar na fila, com a
 *     desvantagem de parecer atendido.
 *   - TRANSFERIR pergunta "para quem posso passar isto?" e nao filtra nada:
 *     passar o cliente ao colega que volta do almoco em dez minutos e uma
 *     decisao legitima de quem esta atendendo. A tela mostra a presenca e a
 *     carga para a escolha ser informada.
 */
export async function atendentesDisponiveis(tenantId, { presencas, cargos } = {}) {
  // `"users"."id"` escrito por extenso, e nao `${users.id}`: numa consulta de
  // tabela so, o Drizzle escreve a coluna SEM o nome da tabela ("id") — e
  // dentro da subconsulta o banco lia como o id da CONVERSA. A carga saia
  // sempre 0: ninguem batia no limite e a distribuicao nao sabia quem estava
  // mais ocupado.
  const carga = sql`(
    SELECT COUNT(*) FROM ${conversations}
    WHERE ${conversations.assignedUserId} = ${sql.identifier('users')}.${sql.identifier('id')}
      AND ${conversations.status} != 'finalizada'
      AND ${conversations.deletedAt} IS NULL
  )`;

  return db
    .select({
      id: users.id,
      nome: users.nome,
      cargo: users.cargo,
      capacidade: users.capacidadeSimultanea,
      statusPresenca: users.statusPresenca,
      emAtendimento: carga.as('em_atendimento')
    })
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(users.ativo, true),
        presencas?.length ? inArray(users.statusPresenca, presencas) : undefined,
        inArray(users.cargo, cargos?.length ? cargos : ['atendente', 'admin', 'owner']),
        isNull(users.deletedAt)
      )
    )
    .orderBy(asc(carga), asc(users.id));
}

export async function metricas(tenantId, desdeEm, escopo) {
  const conta = (campo, valor) =>
    sql`COALESCE(SUM(CASE WHEN ${campo} = ${valor} THEN 1 ELSE 0 END), 0)`;

  const [linha] = await db
    .select({
      total: sql`COUNT(*)`.as('total'),
      comBot: conta(conversations.status, 'bot').as('com_bot'),
      naFila: conta(conversations.status, 'na_fila').as('na_fila'),
      comHumano: conta(conversations.status, 'humana').as('com_humano'),
      finalizadas: conta(conversations.status, 'finalizada').as('finalizadas'),
      tempoMedioPrimeiraRespostaSegundos: sql`COALESCE(CAST(AVG(${conversations.primeiraRespostaSegundos}) AS INTEGER), 0)`.as('tmpr')
    })
    .from(conversations)
    .where(
      and(
        base(tenantId),
        somenteDoEscopo(escopo),
        desdeEm ? gte(conversations.createdAt, new Date(desdeEm)) : undefined
      )
    );

  return Object.fromEntries(Object.entries(linha ?? {}).map(([k, v]) => [k, Number(v) || 0]));
}

/**
 * Destino valido de uma transferencia. O perfil `dev` e invisivel: nao pode ser
 * escolhido, e responder "nao existe" e o mesmo que responderia para um id
 * qualquer (nao confirma que aquele id e de um usuario dev).
 */
export function buscarUsuario(tenantId, userId) {
  return db.query.users.findFirst({
    where: and(
      eq(users.tenantId, tenantId),
      eq(users.id, userId),
      eq(users.ativo, true),
      ne(users.cargo, 'dev'),
      isNull(users.deletedAt)
    )
  });
}

/**
 * A conexao (W1, W2...) da conversa MAIS RECENTE do cliente — por onde ele
 * fala com a empresa. Null se ele nunca conversou (ou a conexao foi removida).
 */
export async function ultimaConexaoDoLead(tenantId, leadId) {
  const [linha] = await db
    .select({ channelInstanceId: channelInstances.id, chave: channelInstances.chave })
    .from(conversations)
    .innerJoin(channelInstances, eq(channelInstances.id, conversations.channelInstanceId))
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.leadId, leadId),
        isNull(conversations.deletedAt),
        isNull(channelInstances.deletedAt)
      )
    )
    .orderBy(desc(conversations.ultimaMensagemEm))
    .limit(1);
  return linha ?? null;
}

/** A conexao de uma chave ('W1'...), se existir. */
export async function conexaoPorChave(tenantId, chave) {
  const [linha] = await db
    .select({ channelInstanceId: channelInstances.id, chave: channelInstances.chave })
    .from(channelInstances)
    .where(and(eq(channelInstances.tenantId, tenantId), eq(channelInstances.chave, chave), isNull(channelInstances.deletedAt)))
    .limit(1);
  return linha ?? null;
}

/** Uma mensagem e o que precisa para tentar entrega-la ao canal de origem. */
export async function buscarMensagemParaEntrega(tenantId, conversationId, mensagemId) {
  const [linha] = await db
    .select({
      mensagem: messages,
      conversa: conversations,
      leadTelefone: leads.telefone,
      instanciaChave: channelInstances.chave,
      instanciaRemovida: channelInstances.deletedAt,
      // Para a assinatura ("*Carlos:*") quando a empresa a liga.
      autorNome: users.nome
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .leftJoin(users, eq(users.id, messages.autorUserId))
    .leftJoin(leads, eq(leads.id, conversations.leadId))
    .leftJoin(channelInstances, eq(channelInstances.id, conversations.channelInstanceId))
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.id, mensagemId),
        eq(messages.conversationId, conversationId),
        eq(conversations.tenantId, tenantId),
        isNull(conversations.deletedAt)
      )
    )
    .limit(1);
  return linha ?? null;
}

/**
 * Por qual conexao o cliente escreveu por ultimo. Serve de segunda fonte para
 * conversas antigas sem conexao gravada: a resposta tem de sair pelo numero em
 * que o cliente esta falando, nunca por um "padrao".
 */
export async function chaveDaUltimaEntrada(tenantId, conversationId) {
  const [linha] = await db
    .select({ metadados: messages.metadados })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.conversationId, conversationId),
        eq(messages.direcao, 'entrada')
      )
    )
    .orderBy(desc(messages.id))
    .limit(1);
  return linha?.metadados?.instanciaChave ?? null;
}

/**
 * Grava o resultado de uma tentativa de entrega.
 *
 * `esperandoErro` faz a atualizacao valer so se a mensagem ainda nao foi
 * entregue — assim duas tentativas simultaneas nao sobrescrevem uma a outra
 * (a que chegar depois de uma entrega ja gravada simplesmente nao muda nada).
 */
/** Em que ponto do menu o cliente esta (ou null). */
export async function lerEstadoMenu(tenantId, conversationId) {
  const [linha] = await db
    .select({ menuEstado: conversations.menuEstado })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
  return linha?.menuEstado ?? null;
}

/** Horarios que a Sofia ofereceu nesta conversa (ver `reservar_horario`). */
/** O humor que a leitura periodica deu a esta conversa (ou null). */
export async function humorDaConversa(tenantId, conversationId) {
  const [linha] = await db
    .select({ humor: conversations.humor })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
  return linha?.humor ?? null;
}

export async function lerOfertasHorario(tenantId, conversationId) {
  const [linha] = await db
    .select({ ofertas: conversations.ofertasHorario })
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
  return Array.isArray(linha?.ofertas) ? linha.ofertas : [];
}

export async function gravarOfertasHorario(tenantId, conversationId, ofertas) {
  await db
    .update(conversations)
    .set({ ofertasHorario: ofertas })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
}

export async function gravarEstadoMenu(tenantId, conversationId, estado) {
  await db
    .update(conversations)
    .set({ menuEstado: estado ?? null })
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)));
}

export async function buscarMensagem(tenantId, conversationId, mensagemId) {
  const [m] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.conversationId, conversationId), eq(messages.id, mensagemId)));
  return m ?? null;
}

/**
 * Fecha a transcricao de um audio que foi gravado ANTES de ser transcrito (o
 * balao mostrava "Transcrevendo..."). Com texto: ele vira a transcricao e o
 * conteudo (previa e busca). Sem texto: fica o motivo (`sem_fala`, `falhou`)
 * para o balao dizer o que houve. Avisa as telas para o balao atualizar.
 */
export async function concluirTranscricao(tenantId, conversationId, mensagemId, { texto, status }) {
  const [m] = await db
    .select({ metadados: messages.metadados })
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.id, mensagemId)));
  if (!m) return;

  const { statusTranscricao: _anterior, ...resto } = m.metadados ?? {};
  await db
    .update(messages)
    .set({
      ...(texto ? { transcricao: texto, conteudo: texto } : {}),
      metadados: texto ? resto : { ...resto, statusTranscricao: status }
    })
    .where(and(eq(messages.tenantId, tenantId), eq(messages.id, mensagemId)));
  emitir(EVENTOS.CONVERSA, { tenantId, id: conversationId });
}

/**
 * Respostas de atendente sem resultado de entrega (nem entregue, nem falhou),
 * criadas entre `desde` e `ate`. Todas as empresas: roda no boot, antes de
 * qualquer envio. Devolve quantas marcou.
 */
export async function marcarEntregasSemResultado({ desde, ate, erroEnvio }) {
  const r = await db
    .update(messages)
    .set({ erroEnvio })
    .where(
      and(
        eq(messages.direcao, 'saida'),
        eq(messages.autorTipo, 'humano'),
        isNull(messages.entregueEm),
        isNull(messages.erroEnvio),
        gte(messages.createdAt, desde),
        lt(messages.createdAt, ate)
      )
    );
  return r.rowsAffected ?? 0;
}

/**
 * Grava o resultado da entrega. Com `conversationId`, avisa as telas: a
 * entrega pode terminar em segundo plano, depois de o atendente ter recebido
 * a resposta do envio (ver entrega.service.js).
 */
export async function gravarEntrega(tenantId, mensagemId, { entregueEm, erroEnvio, externalId }, conversationId = null) {
  await db
    .update(messages)
    .set({ entregueEm: entregueEm ?? null, erroEnvio: erroEnvio ?? null, ...(externalId ? { externalId } : {}) })
    .where(and(eq(messages.tenantId, tenantId), eq(messages.id, mensagemId), isNull(messages.entregueEm)));
  if (conversationId) emitir(EVENTOS.CONVERSA, { tenantId, id: conversationId });
}

/**
 * Em que ponto da entrega a mensagem esta ('fila' | 'aguardando_conexao' |
 * 'subindo' | 'enviando'), em `metadados.entregaFase`. E o que permite, num
 * reinicio, separar "com certeza nao saiu" de "pode ter chegado".
 * Tambem limpa um erro anterior: numa nova tentativa, o balao volta a
 * "enviando" em vez de continuar dizendo "nao entregue".
 */
export async function marcarFaseEntrega(tenantId, conversationId, mensagemId, fase) {
  await db
    .update(messages)
    .set({
      erroEnvio: null,
      metadados: sql`json_set(coalesce(${messages.metadados}, '{}'), '$.entregaFase', ${fase})`
    })
    .where(and(eq(messages.tenantId, tenantId), eq(messages.id, mensagemId), isNull(messages.entregueEm)));
  emitir(EVENTOS.CONVERSA, { tenantId, id: conversationId });
}

/** Respostas de atendente sem resultado de entrega, com a fase e o estado da conversa. */
export async function listarEntregasSemResultado({ desde, ate }) {
  return db
    .select({
      id: messages.id,
      tenantId: messages.tenantId,
      conversationId: messages.conversationId,
      metadados: messages.metadados,
      createdAt: messages.createdAt,
      conversaStatus: conversations.status
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.direcao, 'saida'),
        eq(messages.autorTipo, 'humano'),
        isNull(messages.entregueEm),
        isNull(messages.erroEnvio),
        gte(messages.createdAt, desde),
        lt(messages.createdAt, ate)
      )
    );
}
