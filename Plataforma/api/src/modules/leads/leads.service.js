import { Conflito, ehViolacaoDeUnicidade, NaoEncontrado, RegraDeNegocio, SemPermissao } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { formatarTelefone, normalizarTelefone, variantesDeBusca } from '../../core/phone.js';
import { formatarBRL } from '../../core/money.js';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { channelInstances } from '../../db/schema/conversations.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import { apagarImagem, salvarImagem } from '../equipe/arquivos.js';
import * as repo from './leads.repo.js';
import { corrigirMemoria, obterMemoria, podeVerMemoria } from './memoria.js';

const log = comContexto({ modulo: 'leads' });

/**
 * Regras de negocio dos contatos do CRM.
 */

/** Formata um lead + agregados para a resposta da API. */
function apresentar(linha) {
  if (!linha) return null;
  const { lead, ...agregados } = linha.lead ? linha : { lead: linha };

  return {
    id: lead.id,
    nome: lead.nome,
    telefone: lead.telefone,
    telefoneFormatado: formatarTelefone(lead.telefone),
    email: lead.email,
    endereco: lead.endereco ?? '',
    fotoUrl: lead.fotoUrl ?? null,
    observacoes: lead.observacoes,
    tags: lead.tags ?? [],
    origem: lead.origem,
    humor: lead.humor,
    responsavelId: lead.responsavelId,
    aceitaCampanha: lead.aceitaCampanha,
    iaAtiva: lead.iaAtiva !== false,
    ultimoContatoEm: lead.ultimoContatoEm,
    ultimaCampanhaEm: lead.ultimaCampanhaEm,
    createdAt: lead.createdAt,

    ...(agregados.totalAgendamentos !== undefined
      ? {
          totalAgendamentos: Number(agregados.totalAgendamentos) || 0,
          concluidos: Number(agregados.concluidos) || 0,
          faltas: Number(agregados.faltas) || 0,
          gastoTotalCentavos: Number(agregados.gastoTotalCentavos) || 0,
          gastoTotalFormatado: formatarBRL(Number(agregados.gastoTotalCentavos) || 0),
          ultimoAgendamentoEm: agregados.ultimoAgendamentoEm ? Number(agregados.ultimoAgendamentoEm) : null
        }
      : {})
  };
}

export async function listar(tenantId, filtros) {
  const { itens, proximoCursor } = await repo.listar(tenantId, filtros);
  return { itens: itens.map(apresentar), proximoCursor };
}

export async function obter(tenantId, id) {
  const linha = await repo.buscarComResumo(tenantId, id);
  if (!linha) throw new NaoEncontrado('Contato');

  const historico = await repo.historico(tenantId, id);
  return { ...apresentar(linha), historico };
}

/**
 * Cria um contato.
 *
 * O telefone e normalizado ANTES de qualquer coisa, e a busca por duplicado
 * usa as variantes com e sem nono digito. Esses dois passos sao o que impede
 * o mesmo cliente de virar tres cadastros.
 */
export async function criar(tenantId, dados, { usuario } = {}) {
  const telefone = normalizarTelefone(dados.telefone);

  const existente = await repo.buscarPorTelefone(tenantId, variantesDeBusca(telefone));
  if (existente) {
    throw new Conflito(`Este telefone ja esta cadastrado para "${existente.nome}".`, {
      leadExistenteId: existente.id
    });
  }

  const lead = await repo.criar(tenantId, {
    telefone,
    nome: dados.nome.trim(),
    email: dados.email || null,
    endereco: dados.endereco ?? '',
    observacoes: dados.observacoes ?? '',
    tags: dados.tags ?? [],
    origem: dados.origem ?? 'manual',
    responsavelId: dados.responsavelId ?? null,
    aceitaCampanha: dados.aceitaCampanha ?? true,
    iaAtiva: dados.iaAtiva ?? true
  });

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'lead.criar',
    entidade: 'lead',
    entidadeId: lead.id,
    dados: { depois: { nome: lead.nome, telefone: lead.telefone } }
  });

  log.info({ tenantId, leadId: lead.id }, 'Contato criado');
  return apresentar(lead);
}

export async function atualizar(tenantId, id, dados, { usuario } = {}) {
  const atual = await repo.buscarPorId(tenantId, id);
  if (!atual) throw new NaoEncontrado('Contato');

  const mudancas = {};

  if (dados.telefone !== undefined) {
    const telefone = normalizarTelefone(dados.telefone);
    if (telefone !== atual.telefone) {
      const outro = await repo.buscarPorTelefone(tenantId, variantesDeBusca(telefone));
      if (outro && outro.id !== id) {
        throw new Conflito(`Este telefone ja pertence a "${outro.nome}".`);
      }
      mudancas.telefone = telefone;
    }
  }

  const CAMPOS_SIMPLES = [
    'nome',
    'email',
    'endereco',
    'observacoes',
    'tags',
    'responsavelId',
    'aceitaCampanha',
    'iaAtiva'
  ];
  for (const campo of CAMPOS_SIMPLES) {
    if (dados[campo] !== undefined) mudancas[campo] = dados[campo];
  }

  if (Object.keys(mudancas).length === 0) return apresentar(atual);

  const lead = await repo.atualizar(tenantId, id, mudancas);

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'lead.atualizar',
    entidade: 'lead',
    entidadeId: id,
    dados: { antes: Object.fromEntries(Object.keys(mudancas).map((k) => [k, atual[k]])), depois: mudancas }
  });

  return apresentar(lead);
}

/**
 * Exclui (logicamente) um contato.
 *
 * O registro some das listas mas continua no banco. Motivo pratico: os
 * agendamentos dele apontam pra este id, e o faturamento do mes passado
 * precisa continuar batendo.
 */
export async function excluir(tenantId, id, { usuario } = {}) {
  const lead = await repo.buscarPorId(tenantId, id);
  if (!lead) throw new NaoEncontrado('Contato');

  await repo.excluir(tenantId, id);

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'lead.excluir',
    entidade: 'lead',
    entidadeId: id,
    dados: { antes: { nome: lead.nome, telefone: lead.telefone } }
  });

  log.info({ tenantId, leadId: id, porUserId: usuario?.id }, 'Contato movido para a lixeira');
  return { ok: true };
}

/**
 * O que a Sofia lembra do contato (secao da ficha). Quem nao enxerga nenhuma
 * conversa dele pela privacidade da equipe recebe `restrita`, sem conteudo.
 */
export async function obterMemoriaDoContato(tenantId, id, { usuario } = {}) {
  const memoria = await obterMemoria(tenantId, id);
  if (!memoria) throw new NaoEncontrado('Contato');
  if (!(await podeVerMemoria(tenantId, id, usuario))) return { memoria: null, restrita: true };
  return { memoria, restrita: false };
}

/** O atendente corrige ou apaga itens da memoria. Auditado: e dado do cliente. */
export async function corrigirMemoriaDoContato(tenantId, id, dados, { usuario } = {}) {
  if (!(await repo.buscarPorId(tenantId, id))) throw new NaoEncontrado('Contato');
  if (!(await podeVerMemoria(tenantId, id, usuario))) {
    throw new SemPermissao('Este cliente é atendido por outra pessoa da equipe.');
  }
  const r = await corrigirMemoria(tenantId, id, dados);
  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'lead.memoria',
    entidade: 'lead',
    entidadeId: id,
    dados: { antes: r.antes.texto, depois: r.depois.texto }
  });
  return { memoria: r.depois, restrita: false };
}

/**
 * Localiza um contato pelo telefone ou cria na hora.
 *
 * Usado pelo gateway de mensagens: quando chega um WhatsApp de numero
 * desconhecido, o contato precisa existir antes da mensagem ser guardada.
 */
export async function encontrarOuCriarPorTelefone(tenantId, telefoneBruto, nomeSugerido = 'Contato WhatsApp') {
  const telefone = normalizarTelefone(telefoneBruto);

  const existente = await repo.buscarPorTelefone(tenantId, variantesDeBusca(telefone));
  if (existente) {
    // Se o contato foi criado com nome generico e agora sabemos o nome de
    // verdade (o perfil do WhatsApp), aproveitamos pra melhorar o cadastro.
    const nomeEhGenerico = /^(contato|cliente|lead)\b/i.test(existente.nome);
    if (nomeEhGenerico && nomeSugerido && !/^(contato|cliente|lead)\b/i.test(nomeSugerido)) {
      return repo.atualizar(tenantId, existente.id, { nome: nomeSugerido, ultimoContatoEm: new Date() });
    }
    await repo.atualizar(tenantId, existente.id, { ultimoContatoEm: new Date() });
    return existente;
  }

  /**
   * O cliente que voltou depois de ter sido excluido.
   *
   * O telefone e unico por empresa, e o indice do banco nao sabe de exclusao
   * logica: o numero continua ocupado pelo cadastro na lixeira. Como a busca
   * acima esconde excluidos, sem este resgate a criacao falharia e a mensagem
   * dele ficaria sem resposta — para sempre, a cada nova tentativa.
   *
   * Restaurar e melhor do que criar um cadastro novo: o historico, os
   * agendamentos e as anotacoes daquela pessoa continuam ligados a ela.
   */
  const naLixeira = await repo.buscarPorTelefoneComExcluidos(tenantId, variantesDeBusca(telefone));
  if (naLixeira) {
    log.info({ tenantId, leadId: naLixeira.id }, 'Cliente excluido voltou a escrever; cadastro restaurado');
    return repo.restaurar(tenantId, naLixeira.id, { ultimoContatoEm: new Date() });
  }

  try {
    return await repo.criar(tenantId, {
      telefone,
      nome: nomeSugerido,
      observacoes: '',
      tags: [],
      origem: 'whatsapp',
      ultimoContatoEm: new Date()
    });
  } catch (err) {
    /**
     * Corrida de primeira mensagem.
     *
     * O cliente manda "oi" / "tudo bem?" / "queria marcar" em dois segundos.
     * As tres chegam quase juntas, as tres procuram o cadastro, nenhuma acha,
     * e as tres tentam criar. Duas falham na restricao de telefone unico.
     *
     * Isso NAO e erro: significa que outra mensagem acabou de criar o
     * cadastro. Buscamos de novo e seguimos.
     *
     * A alternativa — travar a tabela antes de procurar — seria mais cara e
     * mais fragil do que simplesmente tratar a colisao, que e rara.
     */
    if (!ehViolacaoDeUnicidade(err)) throw err;

    const criadoPorOutro = await repo.buscarPorTelefoneComExcluidos(tenantId, variantesDeBusca(telefone));
    if (criadoPorOutro) {
      log.debug({ tenantId, telefone }, 'Cadastro criado por outra mensagem simultanea; reaproveitando');
      return criadoPorOutro.deletedAt
        ? repo.restaurar(tenantId, criadoPorOutro.id, { ultimoContatoEm: new Date() })
        : criadoPorOutro;
    }

    throw err;
  }
}

// ============================================================================
// FOTO DO PERFIL DO WHATSAPP
// ============================================================================

/** Quanto tempo uma foto vale antes de perguntarmos de novo. */
const VALIDADE_DA_FOTO_MS = 7 * 86_400_000;

/** Teto do download: foto de perfil e pequena; 3 MB ja e folga grande. */
const LIMITE_FOTO_BYTES = 3 * 1024 * 1024;

/** Formatos que o navegador desenha — o mesmo conjunto aceito no upload. */
const TIPOS_DE_FOTO = /^image\/(png|jpe?g|webp|gif)$/i;

/**
 * Baixa a imagem da URL assinada do WhatsApp e devolve uma data URL.
 *
 * Confere o tipo ANTES de gravar: a URL vem de fora, e um HTML de erro
 * gravado com extensao de imagem viraria um arquivo servido pelo nosso
 * dominio. Devolve null em qualquer contratempo — foto e enfeite.
 */
async function baixarComoDataUrl(url, { timeoutMs = 10_000 } = {}) {
  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controle.signal });
    if (!res.ok) return null;

    const tipo = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!TIPOS_DE_FOTO.test(tipo)) return null;

    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > LIMITE_FOTO_BYTES) return null;

    return `data:${tipo.toLowerCase()};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(prazo);
  }
}

/**
 * Guarda no cadastro a foto de perfil do cliente no WhatsApp.
 *
 * Roda em segundo plano, a partir de uma mensagem recebida, e NUNCA lanca:
 * uma foto que nao veio nao pode atrapalhar o atendimento.
 *
 * O carimbo `fotoSincronizadaEm` e gravado mesmo quando nao ha foto. Sem ele,
 * um cliente sem foto publica faria o sistema perguntar ao WhatsApp a cada
 * mensagem que ele mandasse, para sempre receber a mesma negativa.
 *
 * @param {string} tenantId
 * @param {string} leadId
 * @param {() => Promise<string|null>} buscarUrl  devolve a URL assinada (ou null)
 * @param {object} [opts]
 * @param {boolean} [opts.forcar]  ignora a validade (usado pelo botao "atualizar foto")
 */
export async function sincronizarFoto(tenantId, leadId, buscarUrl, { forcar = false } = {}) {
  try {
    const lead = await repo.buscarPorId(tenantId, leadId);
    if (!lead) return { ok: false, motivo: 'sem_lead' };

    const idade = Date.now() - (lead.fotoSincronizadaEm?.getTime() ?? 0);
    if (!forcar && idade < VALIDADE_DA_FOTO_MS) return { ok: false, motivo: 'recente' };

    const url = await buscarUrl();
    if (!url) {
      await repo.atualizar(tenantId, leadId, { fotoSincronizadaEm: new Date() });
      return { ok: false, motivo: 'sem_foto' };
    }

    const dataUrl = await baixarComoDataUrl(url);
    if (!dataUrl) {
      await repo.atualizar(tenantId, leadId, { fotoSincronizadaEm: new Date() });
      return { ok: false, motivo: 'download_falhou' };
    }

    const fotoUrl = await salvarImagem(dataUrl, 'lead', { tenantId });
    const anterior = lead.fotoUrl;

    await repo.atualizar(tenantId, leadId, { fotoUrl, fotoSincronizadaEm: new Date() });

    // So apagamos arquivo nosso: um caminho que nao veio da pasta de uploads
    // pode ser qualquer outra coisa.
    if (anterior?.startsWith('/api/arquivos/')) await apagarImagem(anterior);

    log.debug({ tenantId, leadId }, 'Foto do perfil do WhatsApp guardada');
    return { ok: true, fotoUrl };
  } catch (err) {
    log.debug({ err, tenantId, leadId }, 'Nao foi possivel sincronizar a foto do perfil');
    return { ok: false, motivo: 'erro' };
  }
}

/**
 * Busca a foto do perfil AGORA, a pedido da tela.
 *
 * Tenta uma conexao de WhatsApp de cada vez: a foto so aparece para quem esta
 * conectado, e a empresa pode ter varios numeros. A primeira que responder
 * ganha.
 *
 * O `import` do gateway e feito aqui dentro, e nao no topo, porque o gateway
 * importa ESTE arquivo: no topo, os dois ficariam esperando um pelo outro na
 * hora de carregar.
 */
export async function atualizarFotoDoWhatsapp(tenantId, leadId) {
  const lead = await repo.buscarPorId(tenantId, leadId);
  if (!lead) throw new NaoEncontrado('Contato');

  const { obterAdaptador } = await import('../../channels/gateway.js');
  const adaptador = obterAdaptador('whatsapp');

  if (!adaptador?.fotoDePerfil) {
    throw new RegraDeNegocio('O WhatsApp nao esta disponivel neste servidor.');
  }

  const instancias = await db
    .select({ chave: channelInstances.chave })
    .from(channelInstances)
    .where(and(eq(channelInstances.tenantId, tenantId), isNull(channelInstances.deletedAt)))
    .orderBy(channelInstances.chave)
    .limit(5);

  const resultado = await sincronizarFoto(
    tenantId,
    leadId,
    async () => {
      for (const { chave } of instancias) {
        const url = await adaptador.fotoDePerfil({
          tenantId,
          instanciaChave: chave,
          telefone: lead.telefone
        });
        if (url) return url;
      }
      return null;
    },
    { forcar: true }
  );

  if (!resultado.ok) {
    throw new RegraDeNegocio(
      resultado.motivo === 'sem_foto'
        ? 'Este cliente nao tem foto publica no WhatsApp (ou nenhum numero esta conectado agora).'
        : 'Nao consegui baixar a foto do WhatsApp agora. Tente de novo em instantes.'
    );
  }

  return { fotoUrl: resultado.fotoUrl };
}

/**
 * Acoes em lote: aplicar etiqueta, ligar/desligar IA, marcar quem nao quer campanha.
 *
 * O limite de 500 nao e arbitrario: sem ele, um clique em "selecionar tudo"
 * numa base de 50 mil contatos monta uma consulta gigante e trava o banco pra
 * todo mundo. Operacao em massa maior que isso deve virar processo em segundo
 * plano, nao uma requisicao HTTP.
 */
export async function acaoEmLote(
  tenantId,
  { ids, adicionarTag, removerTag, aceitaCampanha, iaAtiva },
  { usuario } = {}
) {
  if (!ids?.length) throw new RegraDeNegocio('Selecione pelo menos um contato.');
  if (ids.length > 500) {
    throw new RegraDeNegocio('Selecione no maximo 500 contatos por vez.');
  }

  let afetados = 0;

  // Etiqueta mexe no JSON de cada lead, entao precisa ler antes de escrever.
  if (adicionarTag || removerTag) {
    const alvos = await repo.listarPorIds(tenantId, ids);
    for (const lead of alvos) {
      const atuais = new Set(lead.tags ?? []);
      if (adicionarTag) atuais.add(adicionarTag);
      if (removerTag) atuais.delete(removerTag);
      await repo.atualizar(tenantId, lead.id, { tags: [...atuais] });
      afetados++;
    }
  }

  const diretos = {};
  if (aceitaCampanha !== undefined) diretos.aceitaCampanha = aceitaCampanha;
  if (iaAtiva !== undefined) diretos.iaAtiva = iaAtiva;

  if (Object.keys(diretos).length > 0) {
    afetados = Math.max(afetados, await repo.atualizarEmLote(tenantId, ids, diretos));
  }

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'lead.lote',
    entidade: 'lead',
    dados: { quantidade: ids.length, adicionarTag, removerTag, aceitaCampanha, iaAtiva }
  });

  return { afetados };
}

/** As etiquetas em uso, para a tela oferecer o filtro sem lista fixa. */
export function listarEtiquetas(tenantId) {
  return repo.contarEtiquetas(tenantId);
}
