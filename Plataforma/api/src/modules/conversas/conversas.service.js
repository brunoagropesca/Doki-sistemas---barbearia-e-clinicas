import {
  Conflito,
  ehViolacaoDeUnicidade,
  NaoEncontrado,
  RegraDeNegocio,
  SemPermissao
} from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { formatarTelefone } from '../../core/phone.js';
import { paraOggOpus } from '../../core/audio.js';
import { readFile } from 'node:fs/promises';
import { caminhoDe, salvarAnexo, salvarAudio } from '../equipe/arquivos.js';
import { transcreverAudio } from '../../ai/transcricao.js';
import { NIVEL_CARGO } from '../../db/schema/auth.js';
import { ETAPAS_ATENDIMENTO } from '../../db/schema/conversations.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import * as agenda from '../agenda/agenda.service.js';
import * as agendaRepo from '../agenda/agenda.repo.js';
import { FUSO_PADRAO, fimDoDia, inicioDoDia } from '../../core/datetime.js';
import { escopoDe, obterConfiguracao as configEquipe, veTudo } from '../equipe/equipe.config.js';
import { escolherAtendente } from '../equipe/distribuidor.js';
import { atenaPermite } from '../../ai/permissoes.js';
import { gerarResumoFinal } from '../../ai/resumo.js';
import { atualizarMemoria } from '../leads/memoria.js';
import { agendarPedidoDeAvaliacao } from '../../automacao/avaliacaoGoogle.js';
import * as repo from './conversas.repo.js';
import { criar as criarNotificacoes, fecharDaConversa as fecharNotificacoes } from '../notificacoes/notificacoes.repo.js';

const log = comContexto({ modulo: 'conversas' });

/**
 * Mesa de atendimento.
 *
 * A regra central deste modulo: quando um humano assume, a IA cala a boca.
 * Nada e mais constrangedor para a empresa do que o cliente receber uma
 * resposta automatica no meio de uma conversa com uma pessoa de verdade.
 * Isso e garantido pelo `status`: com 'humana', o gateway nao aciona a IA.
 */

function apresentar(linha) {
  if (!linha) return null;
  const c = linha.conversa;

  return {
    id: c.id,
    leadId: c.leadId,
    leadNome: linha.leadNome,
    leadTelefone: linha.leadTelefone,
    leadTelefoneFormatado: linha.leadTelefone ? formatarTelefone(linha.leadTelefone) : null,
    leadHumor: linha.leadHumor,
    leadFotoUrl: linha.leadFotoUrl ?? null,

    canal: c.canal,
    canalNome: linha.canalNome,
    canalChave: linha.canalChave,
    channelInstanceId: c.channelInstanceId,

    status: c.status,
    assignedUserId: c.assignedUserId,
    atendenteNome: linha.atendenteNome,
    assumidaEm: c.assumidaEm?.getTime() ?? null,
    naFilaDesde: c.naFilaDesde?.getTime() ?? null,

    ultimaMensagemPreview: c.ultimaMensagemPreview,
    ultimaMensagemEm: c.ultimaMensagemEm?.getTime() ?? null,
    naoLidas: c.naoLidas,

    primeiraRespostaSegundos: c.primeiraRespostaSegundos,
    totalMensagensCliente: c.totalMensagensCliente,
    totalMensagensIa: c.totalMensagensIa,
    totalMensagensHumano: c.totalMensagensHumano,

    etapaAtendimento: c.etapaAtendimento,
    // Humor lido pela Sofia nesta conversa. Cai para o do cadastro quando a
    // leitura ainda nao rodou — melhor mostrar o de ontem do que nada.
    humor: c.humor ?? linha.leadHumor ?? null,
    humorResumo: c.humorResumo ?? null,
    humorAtualizadoEm: c.humorAtualizadoEm?.getTime() ?? null,
    humorNaMensagem: c.humorNaMensagem ?? 0,
    anotacoesHumanas: c.anotacoesHumanas ?? '',

    resumo: c.resumo,
    finalizadaEm: c.finalizadaEm?.getTime() ?? null,
    createdAt: c.createdAt.getTime()
  };
}

function apresentarMensagem(linha) {
  const m = linha.mensagem;
  return {
    id: m.id,
    direcao: m.direcao,
    autorTipo: m.autorTipo,
    autorNome: linha.autorNome,
    tipo: m.tipo,
    conteudo: m.conteudo,
    midiaUrl: m.midiaUrl,
    transcricao: m.transcricao,
    erroEnvio: m.erroEnvio,
    entregueEm: m.entregueEm?.getTime() ?? null,
    metadados: m.metadados ?? {},
    createdAt: m.createdAt.getTime()
  };
}

export async function listar(tenantId, filtros, usuario) {
  const escopo = await escopoDe(tenantId, usuario);
  const { dia, atendenteId, ...resto } = filtros;

  const recorte = {};

  // "Finalizados de um dia": o dia e o da EMPRESA, nao o do servidor.
  if (dia) {
    const tenant = await agendaRepo.buscarTenant(tenantId);
    const fuso = tenant?.fusoHorario || FUSO_PADRAO;
    recorte.finalizadaDe = inicioDoDia(dia, fuso);
    recorte.finalizadaAte = fimDoDia(dia, fuso);
  }

  // Quem pode ver so o que e dele nao escolhe outro atendente: o servidor
  // devolve o dele, sem erro (o dono usa o mesmo endpoint com um seletor).
  if (atendenteId) {
    recorte.atendenteId = escopo.tudo || atendenteId === usuario?.id ? atendenteId : usuario?.id;
  }

  const { itens, proximoCursor } = await repo.listar(tenantId, {
    ...resto,
    ...recorte,
    usuarioId: usuario?.id,
    escopo
  });
  return { itens: itens.map(apresentar), proximoCursor };
}

/**
 * Uma conversa.
 *
 * `usuario` e opcional: quem chama sem ele age em nome do sistema (a Atena, o
 * gateway). Com ele, a privacidade da equipe vale.
 */
export async function obter(tenantId, id, usuario) {
  const linha = await garantirVisivel(tenantId, await repo.buscarPorId(tenantId, id), usuario);
  return apresentar(linha);
}

export async function mensagens(tenantId, conversationId, { limite, antesDe } = {}, usuario) {
  const conversa = await garantirVisivel(tenantId, await repo.buscarPorId(tenantId, conversationId), usuario);

  const linhas = await repo.listarMensagens(tenantId, conversationId, { limite, antesDe });

  // O banco devolve do mais novo pro mais velho (para a paginacao funcionar);
  // a tela le de cima pra baixo, entao invertemos aqui.
  const lista = linhas.map(apresentarMensagem).reverse();

  return {
    conversa: apresentar(conversa),
    mensagens: lista,
    proximoCursor: linhas.length > 0 ? linhas.at(-1).mensagem.id : null
  };
}

/**
 * Encontra a conversa aberta de um lead NAQUELA conexao, ou abre uma.
 * Usado pelo gateway quando chega mensagem de um cliente.
 *
 * Cada conexao (W1, W2, Telegram...) tem a sua conversa: o mesmo cliente pode
 * escrever para dois numeros da empresa, e misturar tudo num fio so faria a
 * resposta do atendente sair por um numero que nao e o que ele escolheu — ou
 * pior, o cliente ver a resposta de um numero que nunca procurou.
 */
/**
 * Por qual conexao falar com o cliente numa mensagem que PARTE de nos (ex.: o
 * lembrete de vespera): a da conversa mais recente dele — o numero que ele ja
 * conhece. Sem conversa, a W1.
 *
 * @returns {Promise<{ channelInstanceId: string|null, chave: string }>}
 */
export async function conexaoDoLead(tenantId, leadId) {
  return (
    (await repo.ultimaConexaoDoLead(tenantId, leadId)) ??
    (await repo.conexaoPorChave(tenantId, 'W1')) ?? { channelInstanceId: null, chave: 'W1' }
  );
}

/** Id da conversa aberta do cliente (qualquer conexao), ou null. */
export async function conversaAbertaDoLead(tenantId, leadId) {
  return (await repo.buscarQualquerAbertaDoLead(tenantId, leadId))?.id ?? null;
}

export async function encontrarOuAbrir(tenantId, { leadId, canal = 'whatsapp', channelInstanceId = null }) {
  const aberta = await repo.buscarAbertaDoLead(tenantId, leadId, channelInstanceId);
  if (aberta) return aberta.id;

  // Conversa antiga, de antes de existir uma por conexao (ficou sem numero
  // gravado): adota, em vez de abrir uma segunda ao lado dela.
  if (channelInstanceId) {
    const semConexao = await repo.buscarAbertaDoLead(tenantId, leadId, null);
    if (semConexao && semConexao.canal === canal) {
      try {
        await repo.atualizar(tenantId, semConexao.id, { channelInstanceId });
        return semConexao.id;
      } catch (err) {
        if (!ehViolacaoDeUnicidade(err)) throw err;
        // Outra mensagem adotou/abriu primeiro; a busca abaixo a encontra.
        const outra = await repo.buscarAbertaDoLead(tenantId, leadId, channelInstanceId);
        if (outra) return outra.id;
        throw err;
      }
    }
  }

  try {
    return await repo.criar(tenantId, { leadId, canal, channelInstanceId, status: 'bot' });
  } catch (err) {
    /**
     * Corrida de rajada.
     *
     * Tres mensagens do mesmo cliente chegam na mesma fracao de segundo. As
     * tres procuram conversa aberta, nenhuma acha, as tres tentam criar. O
     * indice unico parcial recusa as duas ultimas.
     *
     * Isso nao e erro: significa que outra mensagem acabou de abrir a
     * conversa. Buscamos de novo e usamos a dela — e o cliente continua
     * vendo um unico atendimento em vez de tres.
     */
    if (!ehViolacaoDeUnicidade(err)) throw err;

    const abertaPorOutro = await repo.buscarAbertaDoLead(tenantId, leadId, channelInstanceId);
    if (abertaPorOutro) {
      log.debug({ tenantId, leadId }, 'Conversa aberta por mensagem simultanea; reaproveitando');
      return abertaPorOutro.id;
    }

    throw err;
  }
}

/**
 * Registra uma mensagem recebida do cliente.
 *
 * Devolve `duplicada: true` quando o canal reenviou algo que ja temos.
 * WhatsApp e Telegram reenviam quando acham que nao confirmamos o
 * recebimento — sem esta checagem, a mesma mensagem apareceria duas vezes
 * na tela e a IA responderia duas vezes.
 */
export async function registrarRecebida(tenantId, conversationId, { conteudo, externalId, tipo = 'texto', midiaUrl, transcricao, metadados }) {
  if (externalId && (await repo.mensagemExternaExiste(tenantId, externalId))) {
    log.debug({ tenantId, externalId }, 'Mensagem externa repetida descartada');
    return { duplicada: true };
  }

  const id = await repo.registrarMensagem(tenantId, conversationId, {
    direcao: 'entrada',
    autorTipo: 'lead',
    tipo,
    conteudo,
    midiaUrl: midiaUrl ?? null,
    transcricao: transcricao ?? null,
    externalId: externalId ?? null,
    metadados: metadados ?? {}
  });

  return { id, duplicada: false };
}

/** Registra uma mensagem que enviamos (IA, menu ou sistema). */
export async function registrarEnviada(tenantId, conversationId, { conteudo, autorTipo = 'ia', metadados, erroEnvio, externalId }) {
  return repo.registrarMensagem(tenantId, conversationId, {
    direcao: 'saida',
    autorTipo,
    tipo: 'texto',
    conteudo,
    externalId: externalId ?? null,
    metadados: metadados ?? {},
    erroEnvio: erroEnvio ?? null,
    entregueEm: erroEnvio ? null : new Date()
  });
}

/** Confere se este usuario pode agir nesta conversa. */
export async function podeAgir(tenantId, conversa, usuario) {
  // Quem acompanha a equipe inteira (o dono, por padrao) mexe em qualquer
  // conversa. Os demais, so na propria ou numa que ainda nao tem dono.
  const escopo = await escopoDe(tenantId, usuario);
  if (escopo.tudo) return true;
  return !conversa.assignedUserId || conversa.assignedUserId === usuario.id;
}

/**
 * A conversa existe PARA ESTA PESSOA?
 *
 * Fora do escopo, respondemos "nao encontrada" em vez de "sem permissao": um
 * 403 confirmaria que aquele cliente existe e esta sendo atendido por alguem —
 * e essa confirmacao e justamente o que a privacidade deveria impedir.
 */
async function garantirVisivel(tenantId, linha, usuario) {
  if (!linha) throw new NaoEncontrado('Conversa');
  if (!usuario) return linha;

  const escopo = await escopoDe(tenantId, usuario);
  if (escopo.tudo) return linha;

  const dono = linha.conversa.assignedUserId;
  if (dono && dono !== usuario.id) throw new NaoEncontrado('Conversa');
  return linha;
}

/**
 * Um atendente ASSUME a conversa — "pesca" o cliente para si.
 *
 * Assumir e diferente de ATENDER, e a separacao e proposital:
 *
 *   ASSUMIR  — a conversa passa a ser minha. Sai da vitrine da Sofia (ou da
 *              fila comum) e vai para o meu "Todos". Nada mais muda: se a IA
 *              conduzia, continua conduzindo; se estava na fila, continua
 *              aguardando ate eu escrever.
 *   ATENDER  — o momento em que eu MANDO A PRIMEIRA MENSAGEM. So ai a conversa
 *              vira "Humano" e a Sofia se cala (ver `virarHumano`).
 *
 * Quem decide "e atendimento humano" e o que a pessoa faz, nao um clique. Um
 * atendente que assume e ainda esta lendo o historico nao pode calar a Sofia e
 * deixar o cliente sem resposta.
 */
export async function assumir(tenantId, id, usuario) {
  const linha = await repo.buscarPorId(tenantId, id);
  if (!linha) throw new NaoEncontrado('Conversa');

  const c = linha.conversa;

  if (c.status === 'finalizada') {
    throw new RegraDeNegocio('Esta conversa ja foi finalizada.');
  }
  // Dois atendentes clicam em "Assumir" no mesmo cliente da vitrine ao mesmo
  // tempo: o segundo precisa ouvir QUE foi pego e por quem, em vez de um erro
  // seco. (Quem enxerga a equipe inteira, como o dono, pode tomar a conversa.)
  if (c.assignedUserId && c.assignedUserId !== usuario.id && !(await veTudo(tenantId, usuario))) {
    throw new Conflito(`${linha.atendenteNome ?? 'Outra pessoa'} ja esta atendendo esta conversa.`);
  }

  await repo.atualizar(tenantId, id, {
    assignedUserId: usuario.id,
    assumidaEm: new Date(),
    naoLidas: 0
  });

  // Assumir uma conversa que era de outro (o dono entrando, por exemplo) leva
  // junto os horarios dela.
  if (c.assignedUserId && c.assignedUserId !== usuario.id) {
    await agenda.transferirResponsavel(tenantId, id, usuario.id);
  }

  // Alguem pegou o cliente: a notificacao de encaminhamento sai da tela de todos.
  await fecharNotificacoes(tenantId, id);

  log.info({ tenantId, conversationId: id, userId: usuario.id }, 'Conversa assumida');
  return obter(tenantId, id);
}

/**
 * O atendente ESCREVEU: a conversa vira "Humano" e a Sofia se cala.
 *
 * Aqui nasce a metrica de primeira resposta — quantos segundos o cliente
 * esperou ate uma PESSOA responder. Gravamos no momento em que o fato acontece:
 * calcular depois, por consulta, ficaria caro e impreciso.
 */
async function virarHumano(tenantId, linha, usuario) {
  const c = linha.conversa;

  const mudancas = {
    status: 'humana',
    assignedUserId: usuario.id,
    assumidaEm: c.assumidaEm ?? new Date(),
    naoLidas: 0
  };

  if (c.primeiraRespostaSegundos == null) {
    const primeira = await repo.primeiraMensagemNaoRespondida(tenantId, c.id);
    if (primeira) {
      mudancas.primeiraRespostaSegundos = Math.max(0, Math.round((Date.now() - primeira.getTime()) / 1000));
    }
  }

  await repo.atualizar(tenantId, c.id, mudancas);

  // Quem passa a atender uma conversa que era de outro leva os horarios dela.
  if (c.assignedUserId && c.assignedUserId !== usuario.id) {
    await agenda.transferirResponsavel(tenantId, c.id, usuario.id);
  }

  await fecharNotificacoes(tenantId, c.id);

  log.info({ tenantId, conversationId: c.id, userId: usuario.id }, 'Conversa passou a ser atendida por humano');
}

/** Devolve a conversa para a IA. */
export async function devolverParaIa(tenantId, id, usuario) {
  const linha = await repo.buscarPorId(tenantId, id);
  if (!linha) throw new NaoEncontrado('Conversa');
  if (!(await podeAgir(tenantId, linha.conversa, usuario))) {
    throw new SemPermissao('Esta conversa esta com outro atendente.');
  }

  // Devolver para a IA solta a conversa — a nao ser que haja um horario por
  // acontecer. Nesse caso o cliente continua sendo DE alguem: a Sofia volta a
  // responder, mas o atendente responsavel segue vendo a conversa e o horario.
  const temHorario = await agenda.temAbertaDaConversa(tenantId, id);
  await repo.atualizar(tenantId, id, {
    status: 'bot',
    assignedUserId: temHorario ? linha.conversa.assignedUserId : null,
    assumidaEm: null
  });
  // A conversa voltou para a Sofia: nao ha mais quem "Atender". Sem isto o
  // aviso ficava na tela e o botao dava erro 422 antes de sumir.
  await fecharNotificacoes(tenantId, id);
  return obter(tenantId, id);
}

/** Cliente (ou a IA) pediu atendimento humano: entra na fila. */
export async function enviarParaFila(tenantId, id) {
  const linha = await repo.buscarPorId(tenantId, id);
  // O relogio da espera so comeca quando a conversa ENTRA na fila: reenviar
  // quem ja esta esperando nao pode zerar o tempo (senao nunca passa de 30 min).
  const entrando = linha?.conversa.status !== 'na_fila';
  await repo.atualizar(tenantId, id, { status: 'na_fila', ...(entrando ? { naFilaDesde: new Date() } : {}) });
  return obter(tenantId, id);
}

/**
 * Devolucao feita pelo SISTEMA: o atendente nao escreve ha horas e o cliente
 * estava falando sozinho. So o status muda (a Sofia volta a responder); o
 * `assignedUserId` fica — o atendente continua dono do cliente e dos horarios.
 * Diferente de `devolverParaIa`, que e a pessoa soltando a conversa.
 */
export async function devolverParaIaAutomatico(tenantId, id) {
  await repo.atualizar(tenantId, id, { status: 'bot' });
  return obter(tenantId, id);
}

/**
 * Para quem esta conversa pode ir.
 *
 * Mostra a carga de cada um (e quem esta cheio) para a escolha ser informada:
 * passar um cliente irritado para quem ja tem oito conversas abertas e so
 * mudar o nome de quem vai demorar a responder. Quem esta na capacidade
 * aparece marcado, mas nao e bloqueado — quem transfere pode ter um motivo
 * que o sistema nao conhece.
 */
export async function destinosDeTransferencia(tenantId, usuario) {
  // Sem filtro de presenca de proposito: ver `atendentesDisponiveis`.
  const equipe = await repo.atendentesDisponiveis(tenantId);

  return equipe
    .filter((a) => a.id !== usuario?.id)
    .map((a) => ({
      id: a.id,
      nome: a.nome,
      statusPresenca: a.statusPresenca,
      emAtendimento: Number(a.emAtendimento),
      capacidade: a.capacidade,
      lotado: Number(a.emAtendimento) >= a.capacidade
    }));
}

/**
 * Entrega uma conversa da fila a alguem da equipe.
 *
 * COMO a escolha e feita sai de Equipe > Atendentes:
 *
 *   - "menos carregado": vai para quem tem menos conversas abertas agora. Bom
 *     para responder rapido, mas quem responde depressa recebe mais.
 *   - "rodizio": cada um recebe na sua vez, em ordem fixa. Distribui parelho,
 *     que e o que importa quando o atendimento vale comissao.
 *
 * Em qualquer criterio, quem esta na capacidade maxima e pulado, e sem
 * ninguem disponivel a conversa CONTINUA na fila — melhor esperar do que
 * empurrar para alguem afogado, que so faria o cliente esperar do mesmo jeito.
 *
 * Com a distribuicao automatica desligada, ninguem recebe nada sozinho: a
 * conversa espera na fila ate um atendente clicar em "Assumir".
 *
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.forcar] true ignora o modo manual (o botao "Distribuir")
 */
export async function distribuir(tenantId, id, { forcar = false } = {}) {
  const linha = await repo.buscarPorId(tenantId, id);
  if (!linha) throw new NaoEncontrado('Conversa');

  // Conversa que ja tem dono (a IA marcou um horario e a atribuiu, por exemplo)
  // nao vai para outra pessoa quando o cliente pede um humano: ele ja tem quem
  // cuide dele, e trocar de atendente no meio seria o oposto de atendimento.
  if (linha.conversa.assignedUserId && !forcar) {
    return {
      atribuida: true,
      motivo: 'ja_tem_dono',
      atendente: { id: linha.conversa.assignedUserId, nome: linha.atendenteNome },
      conversa: await obter(tenantId, id)
    };
  }

  const config = await configEquipe(tenantId);

  if (!config.distribuicaoAutomatica && !forcar) {
    await repo.atualizar(tenantId, id, { status: 'na_fila' });
    log.debug({ tenantId, conversationId: id }, 'Distribuicao manual: conversa aguarda na fila');
    return { atribuida: false, motivo: 'manual', conversa: await obter(tenantId, id) };
  }

  // Aqui NAO cai em quem nao esta de plantao: sem ninguem, a conversa espera.
  const escolhido = await escolherAtendente(tenantId);

  if (!escolhido) {
    log.warn({ tenantId, conversationId: id }, 'Sem atendente disponivel; conversa permanece na fila');
    await repo.atualizar(tenantId, id, { status: 'na_fila' });
    return { atribuida: false, conversa: await obter(tenantId, id) };
  }

  /**
   * Atribuir NAO e atender. A conversa fica na fila DO atendente escolhido —
   * aguardando ate ele escrever — e a Sofia continua calada (o cliente pediu um
   * humano). So vira "Humano" quando a primeira mensagem sair: ver `virarHumano`.
   */
  await repo.atualizar(tenantId, id, { assignedUserId: escolhido.id, assumidaEm: new Date() });

  if (linha.conversa.assignedUserId && linha.conversa.assignedUserId !== escolhido.id) {
    await agenda.transferirResponsavel(tenantId, id, escolhido.id);
  }

  log.info({ tenantId, conversationId: id, userId: escolhido.id }, 'Conversa distribuida automaticamente');
  return { atribuida: true, atendente: escolhido, conversa: await obter(tenantId, id) };
}

/**
 * O botao "Distribuir" — `distribuir` com as regras de QUEM pede.
 *
 * `distribuir` e usada pela IA e pelas rotinas, sem usuario, e por isso nao
 * olha permissao nenhuma. Chamada direto pela rota, uma atendente conseguia
 * tirar do colega uma conversa que ela nem enxerga — e a resposta ainda trazia
 * nome e telefone do cliente. Aqui:
 *   - conversa fora do escopo de quem pede → 404, como nas outras rotas;
 *   - conversa que ja tem responsavel so e redistribuida pela gerencia (quem
 *     ve tudo); a fila (sem dono) qualquer atendente distribui, como antes;
 *   - a conversa so volta na resposta se continuar visivel para quem pediu.
 *     Se foi para outra pessoa, volta so quem recebeu.
 */
export async function distribuirManual(tenantId, id, usuario) {
  const linha = await garantirVisivel(tenantId, await repo.buscarPorId(tenantId, id), usuario);
  const gerencia = await veTudo(tenantId, usuario);

  if (linha.conversa.assignedUserId && !gerencia) {
    throw new SemPermissao('Só a gerência redistribui uma conversa que já tem responsável.');
  }

  const r = await distribuir(tenantId, id, { forcar: true });
  const destino = r.atendente ? { id: r.atendente.id, nome: r.atendente.nome } : null;
  const continuaVisivel = !destino || destino.id === usuario.id || gerencia;

  return {
    atribuida: r.atribuida,
    motivo: r.motivo ?? null,
    atendente: destino,
    ...(continuaVisivel ? { conversa: await obter(tenantId, id, usuario) } : {})
  };
}

/** Transfere para outro atendente, guardando o rastro de quem passou por ela. */
export async function transferir(tenantId, id, { paraUserId, motivo }, usuario) {
  const linha = await repo.buscarPorId(tenantId, id);
  if (!linha) throw new NaoEncontrado('Conversa');
  if (!(await podeAgir(tenantId, linha.conversa, usuario))) {
    throw new SemPermissao('Esta conversa esta com outro atendente.');
  }

  const destino = await repo.buscarUsuario(tenantId, paraUserId);
  if (!destino) throw new NaoEncontrado('Atendente de destino');
  if (destino.id === linha.conversa.assignedUserId) {
    throw new RegraDeNegocio('A conversa ja esta com este atendente.');
  }

  const historico = [
    ...(linha.conversa.historicoTransferencias ?? []),
    {
      de: linha.conversa.assignedUserId,
      deNome: linha.atendenteNome,
      para: destino.id,
      paraNome: destino.nome,
      motivo: motivo ?? '',
      em: Date.now()
    }
  ];

  // O status NAO muda: quem recebe uma conversa "Humano" continua com ela como
  // humano; uma da Sofia continua com a Sofia; uma da fila continua aguardando.
  // Transferir troca de QUEM e, nao de que tipo de atendimento e.
  await repo.atualizar(tenantId, id, {
    assignedUserId: destino.id,
    assumidaEm: new Date(),
    historicoTransferencias: historico
  });

  // Os horarios ainda por acontecer acompanham o cliente: quem herda a conversa
  // herda tambem o compromisso de falar com ele ate o dia do servico.
  await agenda.transferirResponsavel(tenantId, id, destino.id);

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'conversa.transferir',
    entidade: 'conversa',
    entidadeId: id,
    dados: { depois: { para: destino.nome, motivo } }
  });

  // Registra no proprio fio da conversa, para o proximo atendente entender
  // o contexto sem precisar procurar em outro lugar.
  await repo.registrarMensagem(tenantId, id, {
    direcao: 'saida',
    autorTipo: 'sistema',
    tipo: 'texto',
    conteudo: `Conversa transferida para ${destino.nome}${motivo ? `: ${motivo}` : ''}.`,
    metadados: { tipo: 'transferencia', de: usuario.id, para: destino.id }
  });

  // Quem recebe precisa SABER que recebeu: sem aviso, a conversa aparecia em
  // silencio na lista dele. E os avisos antigos desta conversa (para quem
  // cuidava antes) saem da tela — ela nao e mais problema deles.
  await fecharNotificacoes(tenantId, id);
  await criarNotificacoes(tenantId, {
    userIds: [destino.id],
    conversationId: id,
    leadNome: linha.leadNome,
    motivo: `Transferida por ${usuario.nome ?? 'um colega'}${motivo ? `: ${motivo}` : ''}`,
    urgente: false
  });

  return obter(tenantId, id);
}

/** Atendente humano responde ao cliente. */
export async function responder(tenantId, id, { conteudo, audio, duracaoSegundos, anexo }, usuario) {
  const linha = await repo.buscarPorId(tenantId, id);
  if (!linha) throw new NaoEncontrado('Conversa');

  const c = linha.conversa;
  if (c.status === 'finalizada') {
    throw new RegraDeNegocio('Esta conversa foi finalizada. Reabra para continuar.');
  }
  if (!(await podeAgir(tenantId, c, usuario))) {
    throw new SemPermissao('Assuma a conversa antes de responder.');
  }

  // Escrever e o que torna a conversa "Humano". Nao exigimos "assumir" antes:
  // obrigar um clique extra so cria um passo que o atendente esquece com o
  // cliente esperando do outro lado.
  if (c.status !== 'humana' || c.assignedUserId !== usuario.id) {
    await virarHumano(tenantId, linha, usuario);
  }

  const conteudoMensagem = audio
    ? await prepararRespostaDeAudio({ tenantId, audio, duracaoSegundos })
    : anexo
      ? await prepararAnexo(anexo, conteudo, tenantId)
      : { tipo: 'texto', conteudo, midiaUrl: null, transcricao: null, metadados: {} };

  const mensagemId = await repo.registrarMensagem(tenantId, id, {
    direcao: 'saida',
    autorTipo: 'humano',
    autorUserId: usuario.id,
    ...conteudoMensagem
  });

  return { id: mensagemId, conversa: await obter(tenantId, id) };
}

/**
 * Prepara a resposta em AUDIO do atendente: converte e guarda o arquivo.
 *
 * A transcricao NAO acontece aqui: ela levava de 2 a 4,5 s (medido) e o audio
 * so saia para o cliente depois dela — o atendente esperava por um texto que
 * so serve para a previa da lista e a busca (ele sabe o que gravou). Agora o
 * audio sai primeiro e `transcreverRespostaDeAudio` preenche o texto depois.
 */
async function prepararRespostaDeAudio({ tenantId, audio, duracaoSegundos }) {
  // Nao usa regex de "um ; so" (como `salvarImagem`, que basta para imagem):
  // o `type` de um Blob gravado pelo `MediaRecorder` costuma vir com parametro
  // extra — `audio/webm;codecs=opus` — entao a data URL tem DOIS ';' antes do
  // `base64,`. Procurar o marcador funciona qualquer que seja o numero deles.
  const MARCADOR = ';base64,';
  const bruta = String(audio ?? '').trim();
  const posicao = bruta.startsWith('data:') ? bruta.indexOf(MARCADOR) : -1;
  if (posicao === -1) throw new RegraDeNegocio('Audio invalido.');

  const bruto = Buffer.from(bruta.slice(posicao + MARCADOR.length), 'base64');
  if (bruto.length === 0) throw new RegraDeNegocio('O audio chegou vazio.');

  let ogg;
  try {
    // O microfone do navegador grava webm/opus; o WhatsApp so desenha a bolha
    // de voz de verdade para ogg/opus. Ver core/audio.js para o porque.
    ogg = await paraOggOpus(bruto);
  } catch (err) {
    log.warn({ err, tenantId }, 'Falha ao converter audio gravado pelo atendente');
    throw new RegraDeNegocio('Não foi possível processar este áudio. Tente gravar de novo.');
  }

  const { url } = await salvarAudio(ogg, 'audio/ogg', { tenantId });

  return {
    tipo: 'audio',
    // O rotulo ate a transcricao chegar; ai o CONTEUDO vira o texto falado,
    // igual ao lado de quem recebe (previa da lista e busca sem caso especial).
    conteudo: ROTULO_AUDIO,
    midiaUrl: url,
    transcricao: null,
    // O balao mostra "Transcrevendo..." ate `transcreverRespostaDeAudio` terminar.
    metadados: { ...(duracaoSegundos ? { duracaoSegundos } : {}), statusTranscricao: 'pendente' }
  };
}

const ROTULO_AUDIO = '🎤 Áudio';

/**
 * Transcreve, DEPOIS do envio, o audio que o atendente mandou, e atualiza o
 * balao (a tela recebe o aviso de mudanca e recarrega). Nunca lanca: sem
 * provedor ou com falha, o balao diz "Transcricao indisponivel" — o audio ja saiu.
 */
export async function transcreverRespostaDeAudio(tenantId, conversationId, mensagemId) {
  let texto = null;
  const detalhe = {};
  try {
    const m = await repo.buscarMensagem(tenantId, conversationId, mensagemId);
    if (!m || m.tipo !== 'audio' || m.transcricao || !m.midiaUrl) return null;
    const destino = caminhoDe(m.midiaUrl.replace('/api/arquivos/', ''));
    if (destino) {
      const transcricao = await transcreverAudio({
        tenantId,
        conversationId,
        bytes: await readFile(destino),
        mimetype: 'audio/ogg',
        nomeArquivo: destino.split(/[\\/]/).pop(),
        detalhe
      });
      texto = transcricao?.texto ?? null;
    }
  } catch (err) {
    log.warn({ err, tenantId, mensagemId }, 'Transcricao do audio do atendente falhou');
  }
  try {
    await repo.concluirTranscricao(tenantId, conversationId, mensagemId, {
      texto,
      status: detalhe.semFala ? 'sem_fala' : 'falhou'
    });
  } catch (err) {
    log.warn({ err, tenantId, mensagemId }, 'Nao foi possivel gravar o resultado da transcricao');
  }
  return texto;
}

/**
 * Transcreve um audio RECEBIDO que ja esta gravado na conversa (o balao
 * mostrava "Transcrevendo...") e fecha o estado dele. Quem chama (o gateway)
 * usa o texto devolvido como a mensagem que a Sofia le.
 *
 * @param {() => Promise<{texto?: string}|null>} transcrever  a chamada ja pronta (vem do canal)
 * @returns {Promise<string|null>}
 */
export async function transcreverRecebida(tenantId, conversationId, mensagemId, transcrever) {
  const detalhe = {};
  let texto = null;
  try {
    texto = (await transcrever(detalhe))?.texto ?? null;
  } catch (err) {
    log.warn({ err, tenantId, mensagemId }, 'Transcricao do audio recebido falhou');
  }
  await repo
    .concluirTranscricao(tenantId, conversationId, mensagemId, { texto, status: detalhe.semFala ? 'sem_fala' : 'falhou' })
    .catch((err) => log.warn({ err, tenantId, mensagemId }, 'Nao foi possivel gravar o resultado da transcricao'));
  return texto;
}

/** Rotulo que aparece na previa da lista quando o anexo vai sem legenda. */
const ROTULO_ANEXO = { imagem: '📷 Foto', video: '🎥 Vídeo' };

/**
 * Prepara foto/video/documento do atendente. O CONTEUDO e a legenda (ou um
 * rotulo), para a previa da lista e a busca funcionarem sem caso especial.
 */
async function prepararAnexo({ dataUrl, nome }, legenda, tenantId) {
  const salvo = await salvarAnexo(dataUrl, nome, { tenantId });
  const texto = legenda?.trim() || null;
  return {
    tipo: salvo.tipo,
    conteudo: texto ?? ROTULO_ANEXO[salvo.tipo] ?? `📄 ${salvo.nomeArquivo}`,
    midiaUrl: salvo.url,
    transcricao: null,
    metadados: { nomeArquivo: salvo.nomeArquivo, mimetype: salvo.mimetype, bytes: salvo.bytes, legenda: texto }
  };
}

/**
 * Encerra a conversa.
 *
 * Se ninguem escreveu resumo e a Atena tem permissao para isso, ela escreve um
 * DEPOIS de fechar, em segundo plano (`agendarResumo`) — o atendente nao fica
 * esperando a IA. O resumo escrito por um atendente sempre tem preferencia:
 * so gastamos uma chamada de IA quando nao ha nada digitado.
 *
 * @param {object} [opcoes]
 * @param {object[]} [opcoes.provedores] injetado nos testes
 * @param {boolean} [opcoes.concluirPassados] false = nao conclui as OS que ja
 *   passaram (a rotina de fechar o dia nao sabe se o cliente veio). Padrao:
 *   true — o atendente que finaliza continua concluindo como sempre.
 * @param {boolean} [opcoes.pedirAvaliacao] false = nao manda o pedido de
 *   avaliacao no Google. O "fechar o dia" so pede a quem teve o atendimento
 *   concluido; conversas ociosas encerradas em lote nao sao "fim de atendimento".
 */
export async function finalizar(tenantId, id, { resumo } = {}, usuario, opcoes = {}) {
  const linha = await repo.buscarPorId(tenantId, id);
  if (!linha) throw new NaoEncontrado('Conversa');
  if (linha.conversa.status === 'finalizada') return obter(tenantId, id);

  if (!(await podeAgir(tenantId, linha.conversa, usuario))) {
    throw new SemPermissao('Esta conversa esta com outro atendente.');
  }

  const resumoFinal = resumo?.trim() || linha.conversa.resumo || null;
  // A Atena escreve o resumo DEPOIS, em segundo plano (ver `agendarResumo`):
  // esperar a IA aqui deixava a tela parada 6 a 10 s a cada "Finalizar".
  const resumoPelaIa = !resumoFinal && (await atenaPermite(tenantId, 'resumo'));

  await repo.atualizar(tenantId, id, {
    status: 'finalizada',
    finalizadaEm: new Date(),
    resumo: resumoFinal,
    naoLidas: 0
  });

  // As OS criadas nesta sessao recebem o resumo, as anotacoes e o humor
  // congelados; as que ja aconteceram viram concluidas.
  const os = await agenda.encerrarPorConversa(
    tenantId,
    id,
    {
      resumo: resumoFinal,
      anotacoes: linha.conversa.anotacoesHumanas,
      humor: linha.conversa.humor
    },
    { usuario, concluirPassados: opcoes.concluirPassados ?? true }
  );

  // Sem await: a resposta ao atendente nao espera a IA.
  const resumindo = resumoPelaIa ? agendarResumo(tenantId, id, linha.leadNome, opcoes.provedores ?? null) : null;
  // A ficha do cliente (o que a Sofia lembra na PROXIMA conversa) vem depois
  // do resumo: as preferencias saem dele. Tambem sem await.
  agendarMemoria(tenantId, id, linha.conversa.leadId, resumindo, opcoes.provedores ?? null);
  // Avaliacao do Google (funcao da Sofia): decide sozinha se manda — desligada,
  // sem link ou cliente frustrado, nao manda. Tambem sem await.
  if (opcoes.pedirAvaliacao !== false) agendarPedidoDeAvaliacao(tenantId, id, { provedores: opcoes.provedores ?? null });

  // Atendimento encerrado: os avisos dele (ex.: cliente frustrado) saem da
  // tela de todos. Antes ficavam presos, e "Atender" dava erro 422.
  await fecharNotificacoes(tenantId, id);

  log.info({ tenantId, conversationId: id, userId: usuario.id, os, resumoPelaIa }, 'Conversa finalizada');
  return obter(tenantId, id);
}

/** Resumos sendo escritos agora (para os testes esperarem). */
const resumosEmAndamento = new Set();

/** Espera os resumos em segundo plano terminarem. Usado pelos testes. */
export function aguardarResumos() {
  return Promise.all([...resumosEmAndamento]);
}

/**
 * A Atena escreve o resumo de uma conversa ja finalizada.
 *
 * Nunca lanca: falhar so significa ficar sem resumo, como ja era quando a IA
 * estava fora do ar. E nunca sobrescreve: se nesse meio tempo alguem gravou
 * um resumo (a atendente, por exemplo), o dela vale.
 */
function agendarResumo(tenantId, id, leadNome, provedores) {
  const trabalho = (async () => {
    try {
      const recentes = await repo.listarMensagens(tenantId, id, { limite: 40 });
      const texto = await gerarResumoFinal({
        tenantId,
        conversationId: id,
        leadNome,
        // O banco devolve do mais novo ao mais velho; o resumo le em ordem.
        mensagens: recentes.map((r) => r.mensagem).reverse(),
        provedores
      });
      if (!texto) return;

      const atual = await repo.buscarPorId(tenantId, id);
      if (!atual || atual.conversa.resumo) return;

      await repo.atualizar(tenantId, id, { resumo: texto });
      await agenda.anexarResumoNasOs(tenantId, id, texto);
      log.info({ tenantId, conversationId: id }, 'Resumo da Atena gravado depois de finalizar');
    } catch (err) {
      log.warn({ err, tenantId, conversationId: id }, 'A Atena nao conseguiu escrever o resumo');
    }
  })();

  resumosEmAndamento.add(trabalho);
  trabalho.finally(() => resumosEmAndamento.delete(trabalho));
  return trabalho;
}

/**
 * Atualiza a memoria do cliente depois de finalizar (ver leads/memoria.js).
 * Espera o resumo da Atena, quando ha um sendo escrito, e le o resumo que
 * ficou gravado (o do atendente ou o dela). Nunca lanca.
 */
function agendarMemoria(tenantId, id, leadId, resumindo, provedores) {
  if (!leadId) return;
  const trabalho = (async () => {
    await resumindo;
    const atual = await repo.buscarPorId(tenantId, id).catch(() => null);
    await atualizarMemoria(tenantId, leadId, { resumo: atual?.conversa.resumo ?? null, conversationId: id, provedores });
  })();
  // Mesmo conjunto dos resumos: `aguardarResumos` cobre os dois nos testes.
  resumosEmAndamento.add(trabalho);
  trabalho.finally(() => resumosEmAndamento.delete(trabalho));
}

/**
 * Grava a leitura de humor feita pela Sofia.
 *
 * Nunca lanca: a leitura de humor e um enfeite do atendimento, e derrubar uma
 * resposta ao cliente porque a classificacao falhou seria trocar o essencial
 * pelo acessorio. `numeroDaMensagem` marca em que ponto da conversa a leitura
 * foi feita, e e isso que impede a proxima mensagem de pagar outra chamada.
 */
export async function registrarHumor(tenantId, id, { humor, resumo, numeroDaMensagem }) {
  try {
    const linha = await repo.buscarPorId(tenantId, id);
    if (!linha) return null;

    await repo.atualizar(tenantId, id, {
      humor,
      humorResumo: resumo || null,
      humorAtualizadoEm: new Date(),
      humorNaMensagem: numeroDaMensagem ?? linha.conversa.totalMensagensCliente
    });

    await repo.atualizarHumorDoLead(tenantId, linha.conversa.leadId, humor);

    log.debug({ tenantId, conversationId: id, humor }, 'Humor do cliente atualizado');
    return obter(tenantId, id);
  } catch (err) {
    log.warn({ err, tenantId, conversationId: id }, 'Nao foi possivel gravar o humor');
    return null;
  }
}

/** Anotacoes do atendente. Texto livre, sobrescreve o anterior. */
export async function salvarAnotacoes(tenantId, id, texto, usuario) {
  const linha = await garantirVisivel(tenantId, await repo.buscarPorId(tenantId, id), usuario);

  await repo.atualizar(tenantId, id, { anotacoesHumanas: texto ?? '' });

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'conversa.anotacoes',
    entidade: 'conversa',
    entidadeId: id,
    dados: { depois: { tamanho: (texto ?? '').length } }
  });

  return obter(tenantId, id);
}

/**
 * Move a conversa de etapa no quadro de atendimento.
 *
 * So vale enquanto a conversa esta aberta: depois de finalizada, o cartao
 * pertence a OS, e mexer na etapa aqui nao mudaria nada na tela.
 */
export async function moverEtapa(tenantId, id, etapa, { usuario, origem = 'humano' } = {}) {
  const linha = await garantirVisivel(tenantId, await repo.buscarPorId(tenantId, id), usuario);

  if (!ETAPAS_ATENDIMENTO.includes(etapa)) {
    throw new RegraDeNegocio(`Etapa desconhecida: "${etapa}".`);
  }
  if (linha.conversa.status === 'finalizada') {
    throw new RegraDeNegocio('Esta conversa ja foi finalizada.');
  }
  if (linha.conversa.etapaAtendimento === etapa) return obter(tenantId, id);

  await repo.atualizar(tenantId, id, { etapaAtendimento: etapa });

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'conversa.etapa',
    entidade: 'conversa',
    entidadeId: id,
    dados: { antes: { etapa: linha.conversa.etapaAtendimento }, depois: { etapa, origem } }
  });

  return obter(tenantId, id);
}

/** Reabre uma conversa encerrada. */
export async function reabrir(tenantId, id, usuario) {
  const linha = await garantirVisivel(tenantId, await repo.buscarPorId(tenantId, id), usuario);
  if (linha.conversa.status !== 'finalizada') {
    throw new RegraDeNegocio('Esta conversa nao esta finalizada.');
  }

  // O cliente ja voltou a escrever: abriu uma conversa NOVA no mesmo numero.
  // Reabrir a antiga bateria no indice de "uma conversa aberta por cliente" e a
  // atendente leria "Ja existe um registro com esses dados." sem entender nada.
  // Dizemos o que houve e qual e a conversa certa (a tela oferece abri-la).
  const atual = await repo.buscarAbertaDoLead(tenantId, linha.conversa.leadId, linha.conversa.channelInstanceId);
  if (atual) {
    throw new Conflito('Este cliente já voltou a escrever e tem uma conversa aberta. Continue por ela.', {
      conversaAtualId: atual.id
    });
  }

  await repo.atualizar(tenantId, id, {
    status: 'humana',
    assignedUserId: usuario.id,
    assumidaEm: new Date(),
    finalizadaEm: null
  });

  return obter(tenantId, id);
}

export async function marcarLida(tenantId, id, usuario) {
  const linha = await garantirVisivel(tenantId, await repo.buscarPorId(tenantId, id), usuario);

  // As nao lidas sao do RESPONSAVEL. O dono (ou a gerencia) abre a conversa
  // para acompanhar: se isso zerasse o contador, a atendente nunca ficaria
  // sabendo que o cliente escreveu. Conversa sem responsavel (fila, IA)
  // continua sendo zerada por quem abrir — ali quem abre e quem vai atender.
  const dono = linha.conversa.assignedUserId;
  if (dono && dono !== usuario?.id) return { ok: true, acompanhando: true };

  await repo.atualizar(tenantId, id, { naoLidas: 0 });
  return { ok: true };
}

export async function metricas(tenantId, { dias = 7 } = {}, usuario) {
  const desde = Date.now() - dias * 86_400_000;
  // Os numeros seguem o mesmo recorte das listas: o atendente ve o proprio
  // desempenho, nao o da empresa.
  const numeros = await repo.metricas(tenantId, desde, await escopoDe(tenantId, usuario));
  const atendentes = await repo.atendentesDisponiveis(tenantId);

  return {
    periodoDias: dias,
    ...numeros,
    atendentesOnline: atendentes.length,
    atendentes: atendentes.map((a) => ({
      id: a.id,
      nome: a.nome,
      emAtendimento: Number(a.emAtendimento),
      capacidade: a.capacidade,
      disponivel: Number(a.emAtendimento) < a.capacidade
    }))
  };
}
