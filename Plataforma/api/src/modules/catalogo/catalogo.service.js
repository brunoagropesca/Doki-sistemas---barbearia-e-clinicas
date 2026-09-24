import { Conflito, NaoEncontrado, RegraDeNegocio } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { formatarBRL } from '../../core/money.js';
import { emTransacao } from '../../db/client.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import * as repo from './catalogo.repo.js';
import { apagarImagem, salvarImagem } from '../equipe/arquivos.js';

const log = comContexto({ modulo: 'catalogo' });

// ============================================================================
// SERVICOS
// ============================================================================

function apresentarServico(s, vinculos = []) {
  return {
    id: s.id,
    nome: s.nome,
    descricao: s.descricao,
    categoria: s.categoria,
    duracaoMinutos: s.duracaoMinutos,
    intervaloAposMinutos: s.intervaloAposMinutos,
    /** Quanto o horario realmente ocupa na agenda (atendimento + limpeza). */
    ocupacaoTotalMinutos: s.duracaoMinutos + s.intervaloAposMinutos,
    precoCentavos: s.precoCentavos,
    precoFormatado: formatarBRL(s.precoCentavos),
    ativo: s.ativo,
    profissionais: vinculos.map((v) => ({
      id: v.professionalId,
      nome: v.profissionalNome,
      cor: v.profissionalCor,
      // Nulo significa "usa o padrao do servico" — o front mostra o efetivo.
      precoCentavos: v.precoCentavos ?? s.precoCentavos,
      precoFormatado: formatarBRL(v.precoCentavos ?? s.precoCentavos),
      precoProprio: v.precoCentavos != null,
      duracaoMinutos: v.duracaoMinutos ?? s.duracaoMinutos,
      duracaoPropria: v.duracaoMinutos != null
    })),
    createdAt: s.createdAt.getTime()
  };
}

export async function listarServicos(tenantId, filtros) {
  const lista = await repo.listarServicos(tenantId, filtros);
  const vinculos = await repo.vinculosDosServicos(tenantId, lista.map((s) => s.id));

  // Agrupa os vinculos por servico em memoria — uma passada, em vez de
  // procurar na lista inteira para cada servico.
  const porServico = new Map();
  for (const v of vinculos) {
    if (!porServico.has(v.serviceId)) porServico.set(v.serviceId, []);
    porServico.get(v.serviceId).push(v);
  }

  return lista.map((s) => apresentarServico(s, porServico.get(s.id) ?? []));
}

export async function obterServico(tenantId, id) {
  const servico = await repo.buscarServico(tenantId, id);
  if (!servico) throw new NaoEncontrado('Servico');
  const vinculos = await repo.vinculosDosServicos(tenantId, [id]);
  return apresentarServico(servico, vinculos);
}

/** Confere que os profissionais informados existem nesta empresa. */
async function validarProfissionais(tenantId, lista) {
  if (!lista?.length) return;
  const ids = lista.map((v) => v.professionalId);
  const encontrados = await repo.profissionaisValidos(tenantId, ids);

  if (encontrados.length !== new Set(ids).size) {
    throw new RegraDeNegocio('Um ou mais profissionais informados nao existem nesta empresa.');
  }
}

export async function criarServico(tenantId, dados, { usuario } = {}) {
  const { profissionais = [], ...campos } = dados;
  await validarProfissionais(tenantId, profissionais);

  const servico = await repo.criarServico(tenantId, campos);

  if (profissionais.length > 0) {
    await repo.definirProfissionaisDoServico(tenantId, servico.id, profissionais);
  }

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'servico.criar',
    entidade: 'servico',
    entidadeId: servico.id,
    dados: { depois: { nome: servico.nome, preco: servico.precoCentavos } }
  });

  log.info({ tenantId, serviceId: servico.id }, 'Servico criado');
  return obterServico(tenantId, servico.id);
}

export async function atualizarServico(tenantId, id, dados, { usuario } = {}) {
  const atual = await repo.buscarServico(tenantId, id);
  if (!atual) throw new NaoEncontrado('Servico');

  const { profissionais, ...campos } = dados;

  if (profissionais !== undefined) {
    await validarProfissionais(tenantId, profissionais);
    await repo.definirProfissionaisDoServico(tenantId, id, profissionais);
  }

  if (Object.keys(campos).length > 0) {
    await repo.atualizarServico(tenantId, id, campos);
  }

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'servico.atualizar',
    entidade: 'servico',
    entidadeId: id,
    dados: { antes: { preco: atual.precoCentavos, duracao: atual.duracaoMinutos }, depois: campos }
  });

  return obterServico(tenantId, id);
}

/**
 * Exclui um servico.
 *
 * Bloqueado quando existem agendamentos futuros usando ele. O caminho certo
 * nesse caso e DESATIVAR: o servico some da tela de agendar mas os horarios
 * ja marcados continuam validos e o historico continua legivel.
 */
export async function excluirServico(tenantId, id, { usuario } = {}) {
  const servico = await repo.buscarServico(tenantId, id);
  if (!servico) throw new NaoEncontrado('Servico');

  if (await repo.servicoTemAgendamentos(tenantId, id)) {
    throw new Conflito(
      `"${servico.nome}" tem agendamentos futuros e nao pode ser excluido. Desative-o para tirar da tela de agendar sem afetar os horarios ja marcados.`
    );
  }

  await repo.excluirServico(tenantId, id);

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'servico.excluir',
    entidade: 'servico',
    entidadeId: id,
    dados: { antes: { nome: servico.nome } }
  });

  return { ok: true };
}

// ============================================================================
// PRODUTOS
// ============================================================================

function apresentarProduto(p) {
  const margem = p.precoCentavos - p.custoCentavos;
  return {
    id: p.id,
    nome: p.nome,
    descricao: p.descricao,
    categoria: p.categoria,
    sku: p.sku,
    precoCentavos: p.precoCentavos,
    precoFormatado: formatarBRL(p.precoCentavos),
    custoCentavos: p.custoCentavos,
    custoFormatado: formatarBRL(p.custoCentavos),
    margemCentavos: margem,
    margemFormatada: formatarBRL(margem),
    margemPercentual: p.precoCentavos > 0 ? Math.round((margem / p.precoCentavos) * 100) : 0,
    estoque: p.estoque,
    estoqueMinimo: p.estoqueMinimo,
    estoqueBaixo: p.estoque <= p.estoqueMinimo,
    fotoUrl: p.fotoUrl ?? null,
    ativo: p.ativo,
    createdAt: p.createdAt.getTime()
  };
}

export async function listarProdutos(tenantId, filtros) {
  const lista = await repo.listarProdutos(tenantId, filtros);
  return lista.map(apresentarProduto);
}

export async function obterProduto(tenantId, id) {
  const produto = await repo.buscarProduto(tenantId, id);
  if (!produto) throw new NaoEncontrado('Produto');

  const historico = await repo.historicoEstoque(tenantId, id);
  return {
    ...apresentarProduto(produto),
    historicoEstoque: historico.map((m) => ({
      tipo: m.tipo,
      quantidade: m.quantidade,
      estoqueResultante: m.estoqueResultante,
      motivo: m.motivo,
      em: m.createdAt.getTime()
    }))
  };
}

/**
 * Cria um produto.
 *
 * O estoque inicial nao e escrito direto na coluna: ele entra como um
 * lancamento de entrada. Assim o historico do produto comeca do zero e fecha
 * — nunca aparece um saldo que "sempre esteve la" sem origem.
 */
export async function criarProduto(tenantId, dados, { usuario } = {}) {
  const { estoque: estoqueInicial = 0, foto, ...campos } = dados;

  if (foto) campos.fotoUrl = await salvarImagem(foto, 'produto');

  const produto = await repo.criarProduto(tenantId, { ...campos, estoque: 0 });

  if (estoqueInicial > 0) {
    await repo.movimentarEstoque(tenantId, {
      productId: produto.id,
      tipo: 'entrada',
      quantidade: estoqueInicial,
      motivo: 'Estoque inicial do cadastro'
    });
  }

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'produto.criar',
    entidade: 'produto',
    entidadeId: produto.id,
    dados: { depois: { nome: produto.nome, estoqueInicial } }
  });

  return obterProduto(tenantId, produto.id);
}

export async function atualizarProduto(tenantId, id, dados, { usuario } = {}) {
  const atual = await repo.buscarProduto(tenantId, id);
  if (!atual) throw new NaoEncontrado('Produto');

  // O estoque NAO entra por aqui de proposito: mudar saldo e sempre um
  // movimento, para manter o historico fechando. Veja `ajustarEstoque`.
  const { estoque, foto, removerFoto, ...campos } = dados;
  if (estoque !== undefined) {
    throw new RegraDeNegocio('Para mudar o estoque use o ajuste de estoque, que registra o motivo.');
  }

  if (foto) {
    campos.fotoUrl = await salvarImagem(foto, 'produto');
    // A antiga so sai depois que a nova esta em disco.
    if (atual.fotoUrl) await apagarImagem(atual.fotoUrl);
  } else if (removerFoto) {
    campos.fotoUrl = null;
    if (atual.fotoUrl) await apagarImagem(atual.fotoUrl);
  }

  if (Object.keys(campos).length > 0) {
    await repo.atualizarProduto(tenantId, id, campos);
  }

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'produto.atualizar',
    entidade: 'produto',
    entidadeId: id,
    dados: { antes: { preco: atual.precoCentavos }, depois: campos }
  });

  return obterProduto(tenantId, id);
}

/**
 * Ajusta o estoque manualmente (recebimento, perda, contagem).
 *
 * Exige motivo. Ajuste sem motivo e como caixa sem comprovante: quando o
 * numero nao bater, ninguem vai conseguir reconstruir o que aconteceu.
 */
export async function ajustarEstoque(tenantId, id, { tipo, quantidade, motivo }, { usuario } = {}) {
  const produto = await repo.buscarProduto(tenantId, id);
  if (!produto) throw new NaoEncontrado('Produto');

  // 'entrada' soma, 'saida' e 'perda' subtraem, 'ajuste' aceita o sinal dado.
  const delta =
    tipo === 'entrada' ? Math.abs(quantidade)
    : tipo === 'saida' || tipo === 'perda' ? -Math.abs(quantidade)
    : quantidade;

  const r = await repo.movimentarEstoque(tenantId, {
    productId: id,
    tipo,
    quantidade: delta,
    motivo
  });

  if (!r.ok) throw new RegraDeNegocio(r.motivo);

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'produto.estoque',
    entidade: 'produto',
    entidadeId: id,
    dados: { antes: { estoque: produto.estoque }, depois: { estoque: r.estoque, tipo, motivo } }
  });

  return obterProduto(tenantId, id);
}

export async function excluirProduto(tenantId, id, { usuario } = {}) {
  const produto = await repo.buscarProduto(tenantId, id);
  if (!produto) throw new NaoEncontrado('Produto');

  await repo.excluirProduto(tenantId, id);

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'produto.excluir',
    entidade: 'produto',
    entidadeId: id,
    dados: { antes: { nome: produto.nome, estoque: produto.estoque } }
  });

  return { ok: true };
}

// ============================================================================
// VENDA DE PRODUTO
// ============================================================================

/**
 * Registra a venda e baixa o estoque como UMA operacao.
 *
 * Os dois passos moram na mesma transacao. Separados, uma falha no meio
 * deixaria a venda registrada com o estoque intacto — e o saldo na tela
 * nunca mais bateria com a prateleira.
 */
export async function venderProduto(tenantId, { productId, leadId, appointmentId, quantidade }, { usuario } = {}) {
  const produto = await repo.buscarProduto(tenantId, productId);
  if (!produto) throw new NaoEncontrado('Produto');
  if (!produto.ativo) throw new RegraDeNegocio(`"${produto.nome}" esta desativado e nao pode ser vendido.`);

  const totalCentavos = produto.precoCentavos * quantidade;

  const vendaId = await emTransacao(async (tx) => {
    const baixa = await repo.movimentarEstoque(
      tenantId,
      {
        productId,
        tipo: 'venda',
        quantidade: -Math.abs(quantidade),
        motivo: 'Venda no balcao'
      },
      tx
    );

    if (!baixa.ok) throw new RegraDeNegocio(baixa.motivo);

    return repo.registrarVenda(
      tenantId,
      {
        productId,
        leadId: leadId ?? null,
        appointmentId: appointmentId ?? null,
        quantidade,
        // Preco congelado: se o produto subir de preco amanha, esta venda
        // continua valendo o que valia hoje.
        precoUnitarioCentavos: produto.precoCentavos,
        totalCentavos,
        vendidoPorUserId: usuario?.id ?? null,
        vendidoEm: new Date()
      },
      tx
    );
  });

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'produto.vender',
    entidade: 'venda',
    entidadeId: vendaId,
    dados: { depois: { produto: produto.nome, quantidade, total: totalCentavos } }
  });

  log.info({ tenantId, vendaId, productId, quantidade }, 'Venda registrada');

  return {
    id: vendaId,
    produtoNome: produto.nome,
    quantidade,
    totalCentavos,
    totalFormatado: formatarBRL(totalCentavos)
  };
}

export async function listarVendas(tenantId, filtros) {
  const linhas = await repo.listarVendas(tenantId, filtros);
  return linhas.map((l) => ({
    id: l.venda.id,
    produtoNome: l.produtoNome,
    leadId: l.venda.leadId,
    quantidade: l.venda.quantidade,
    totalCentavos: l.venda.totalCentavos,
    totalFormatado: formatarBRL(l.venda.totalCentavos),
    vendidoEm: l.venda.vendidoEm.getTime()
  }));
}

export async function metricas(tenantId) {
  const m = await repo.metricas(tenantId);
  return {
    servicos: { ...m.servicos, precoMedioFormatado: formatarBRL(m.servicos.precoMedio) },
    produtos: {
      ...m.produtos,
      valorEstoqueFormatado: formatarBRL(m.produtos.valorEstoqueCentavos)
    }
  };
}
