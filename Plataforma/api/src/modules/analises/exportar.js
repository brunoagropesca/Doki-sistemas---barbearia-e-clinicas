import { gerarXlsx } from '../../core/planilha.js';
import { relatorio } from './analises.service.js';

/**
 * Dashboard -> planilha do Excel. Os MESMOS numeros da tela (sai do mesmo
 * relatorio), uma aba por assunto, em formato de tabela: da para filtrar,
 * ordenar e montar tabela dinamica sem redigitar nada.
 *
 * Dinheiro vai em REAIS (o sistema guarda centavos); porcentagem como
 * porcentagem do Excel; datas como data de verdade (ordenam certo).
 */

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const ORDEM_SEMANA = [1, 2, 3, 4, 5, 6, 0];
const ORIGEM_AGENDA = { humano: 'Equipe', ia: 'Sofia (IA)', cliente: 'Cliente', sistema: 'Sistema' };
const ORIGEM_CONTATO = { whatsapp: 'WhatsApp', manual: 'Cadastro manual', campanha: 'Campanha', importacao: 'Importação', indicacao: 'Indicação' };
const STATUS_CONVERSA = { bot: 'Com a IA', na_fila: 'Na fila', humana: 'Com atendente', finalizada: 'Finalizada' };
const HUMOR = { satisfeito: 'Satisfeito', neutro: 'Neutro', duvida: 'Em dúvida', frustrado: 'Frustrado' };
const AGENTE = { atendente: 'Sofia', atena: 'Atena', aquiles: 'Aquiles' };

const reais = (centavos) => (centavos ?? 0) / 100;
const br = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
/** Variacao % contra o anterior; vazio quando nao da para comparar. */
const variacao = (atual, anterior, completo) => (completo && anterior > 0 ? Math.round(((atual - anterior) / anterior) * 1000) / 10 : null);

export async function planilhaDoDashboard(tenantId, filtros) {
  const d = await relatorio(tenantId, filtros);
  const p = d.periodo;
  const r = d.resumo;
  const a = d.resumoAnterior;
  const completo = p.anterior.completo;

  const cabecalho = [
    `Dashboard — ${br(p.de)} a ${br(p.ate)} (${p.dias} dia${p.dias === 1 ? '' : 's'})`,
    completo
      ? `Comparado com ${br(p.anterior.de)} a ${br(p.anterior.ate)}`
      : `Sem comparação: os registros começam em ${br(p.inicioDosDados) || '—'}`,
    `Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: p.fuso })}`
  ];

  // Indicador, formato, atual, anterior (a variacao sai das duas).
  const indicadores = [
    ['Faturamento total', 'reais', reais(r.faturamentoCentavos), reais(a.faturamentoCentavos)],
    ['Faturamento em serviços', 'reais', reais(r.servicosCentavos), reais(a.servicosCentavos)],
    ['Faturamento em produtos', 'reais', reais(r.produtosCentavos), reais(a.produtosCentavos)],
    ['Atendimentos concluídos', 'inteiro', r.atendimentos, a.atendimentos],
    ['Ticket médio', 'reais', reais(r.ticketMedioCentavos), reais(a.ticketMedioCentavos)],
    ['Horas de serviço', 'decimal', r.horasTrabalhadas, a.horasTrabalhadas],
    ['Clientes atendidos', 'inteiro', r.clientesAtendidos, a.clientesAtendidos],
    ['Clientes na 1ª visita', 'inteiro', r.clientesNovos, a.clientesNovos],
    ['Novos contatos', 'inteiro', r.novosContatos, a.novosContatos],
    ['Conversas no WhatsApp', 'inteiro', r.conversas, a.conversas],
    ['Produtos vendidos (itens)', 'inteiro', r.itensVendidos, a.itensVendidos],
    ['Faltas', 'inteiro', r.faltas, a.faltas],
    ['Cancelamentos', 'inteiro', r.cancelados, a.cancelados],
    ['Taxa de faltas', 'porcento', r.taxaFalta, a.taxaFalta],
    ['Taxa de cancelamento', 'porcento', r.taxaCancelamento, a.taxaCancelamento],
    ['Descontos dados', 'reais', reais(r.descontosCentavos), reais(a.descontosCentavos)]
  ];

  const abas = [];

  // Resumo: cada indicador numa linha; cada celula leva o proprio formato
  // (dinheiro, quantidade, horas, %).
  abas.push({
    nome: 'Resumo',
    antes: cabecalho,
    colunas: [
      { titulo: 'Indicador', largura: 30 },
      { titulo: 'Período', largura: 16 },
      { titulo: 'Período anterior', largura: 18 },
      { titulo: 'Variação', formato: 'porcento', largura: 12 }
    ],
    linhas: indicadores.map(([nome, formato, atual, anterior]) => [
      nome,
      { v: atual, formato },
      completo ? { v: anterior, formato } : null,
      // Em taxa (%), a diferenca em pontos diz mais que "% de %": fica vazia.
      formato === 'porcento' ? null : variacao(atual, anterior, completo)
    ])
  });

  abas.push({
    nome: 'Evolução',
    antes: [cabecalho[0], `Agrupado por ${p.granularidade === 'dia' ? 'dia' : p.granularidade === 'semana' ? 'semana' : 'mês'}`],
    colunas: [
      { titulo: 'De', formato: 'data', largura: 12 },
      { titulo: 'Até', formato: 'data', largura: 12 },
      { titulo: 'Dias', formato: 'inteiro', largura: 7 },
      { titulo: 'Serviços', formato: 'reais', largura: 15 },
      { titulo: 'Produtos', formato: 'reais', largura: 15 },
      { titulo: 'Total', formato: 'reais', largura: 15 },
      { titulo: 'Atendimentos', formato: 'inteiro', largura: 14 },
      { titulo: 'Clientes novos', formato: 'inteiro', largura: 15 },
      { titulo: 'Observação', largura: 34 }
    ],
    linhas: d.serie.map((b) => [
      b.inicio,
      b.fim,
      b.dias,
      reais(b.servicosCentavos),
      reais(b.produtosCentavos),
      reais(b.servicosCentavos + b.produtosCentavos),
      b.atendimentos,
      b.novosClientes,
      b.parcial ? `Só ${b.dias} dia${b.dias === 1 ? '' : 's'} dentro do período` : ''
    ])
  });

  // Dia x hora em formato "longo": uma linha por celula do mapa de calor —
  // o jeito certo para tabela dinamica.
  const c = d.calor;
  const linhasCalor = [];
  for (const dia of ORDEM_SEMANA) {
    for (let h = 0; h < 24; h++) {
      const v = [c.atendimentos[dia][h], c.faturamento[dia][h], c.mensagens[dia][h], c.vendas[dia][h], c.faltas[dia][h]];
      if (v.some((x) => x > 0)) linhasCalor.push([DIAS[dia], `${String(h).padStart(2, '0')}h`, v[0], reais(v[1]), v[2], v[3], v[4]]);
    }
  }
  abas.push({
    nome: 'Dia e hora',
    antes: [cabecalho[0], 'Uma linha por dia da semana e hora (base do mapa de calor)'],
    colunas: [
      { titulo: 'Dia da semana', largura: 14 },
      { titulo: 'Hora', largura: 8 },
      { titulo: 'Atendimentos', formato: 'inteiro' },
      { titulo: 'Faturamento', formato: 'reais', largura: 15 },
      { titulo: 'Mensagens de clientes', formato: 'inteiro', largura: 22 },
      { titulo: 'Produtos vendidos', formato: 'inteiro', largura: 18 },
      { titulo: 'Faltas e cancelamentos', formato: 'inteiro', largura: 22 }
    ],
    linhas: linhasCalor
  });

  // O mapa de calor como grade (dia x hora), do jeito que aparece na tela.
  const horas = Array.from({ length: 24 }, (_, h) => h).filter((h) => ORDEM_SEMANA.some((dia) => c.atendimentos[dia][h] > 0));
  abas.push({
    nome: 'Mapa de calor',
    antes: [cabecalho[0], 'Atendimentos concluídos por dia da semana e hora'],
    colunas: [
      { titulo: 'Dia', largura: 12 },
      ...horas.map((h) => ({ titulo: `${String(h).padStart(2, '0')}h`, formato: 'inteiro', largura: 7 })),
      { titulo: 'Total', formato: 'inteiro', largura: 9 }
    ],
    linhas: ORDEM_SEMANA.map((dia) => [DIAS[dia], ...horas.map((h) => c.atendimentos[dia][h]), c.porDiaSemana.atendimentos[dia]])
  });

  abas.push({
    nome: 'Serviços',
    antes: [cabecalho[0]],
    colunas: [
      { titulo: 'Serviço', largura: 32 },
      { titulo: 'Categoria', largura: 16 },
      { titulo: 'Vezes', formato: 'inteiro', largura: 9 },
      { titulo: 'Faturamento', formato: 'reais', largura: 15 },
      { titulo: 'Participação', formato: 'porcento', largura: 13 },
      { titulo: 'Ticket médio', formato: 'reais', largura: 14 },
      { titulo: 'Descontos', formato: 'reais', largura: 13 },
      { titulo: 'Duração média (min)', formato: 'inteiro', largura: 19 },
      { titulo: 'Faltas', formato: 'inteiro', largura: 9 }
    ],
    linhas: d.servicos.map((s) => [
      s.nome,
      s.categoria,
      s.quantidade,
      reais(s.faturamentoCentavos),
      s.participacao,
      reais(s.ticketMedioCentavos),
      reais(s.descontosCentavos),
      s.duracaoMediaMin,
      s.faltas
    ])
  });

  abas.push({
    nome: 'Categorias',
    antes: [cabecalho[0]],
    colunas: [
      { titulo: 'Categoria', largura: 22 },
      { titulo: 'Atendimentos', formato: 'inteiro', largura: 14 },
      { titulo: 'Faturamento', formato: 'reais', largura: 15 },
      { titulo: 'Participação', formato: 'porcento', largura: 13 }
    ],
    linhas: d.categorias.map((x) => [x.nome, x.quantidade, reais(x.faturamentoCentavos), x.participacao])
  });

  abas.push({
    nome: 'Profissionais',
    antes: [cabecalho[0], 'Ocupação = horas de serviço ÷ horas da jornada cadastrada no período'],
    colunas: [
      { titulo: 'Profissional', largura: 24 },
      { titulo: 'Situação', largura: 10 },
      { titulo: 'Atendimentos', formato: 'inteiro', largura: 14 },
      { titulo: 'Faturamento', formato: 'reais', largura: 15 },
      { titulo: 'Participação', formato: 'porcento', largura: 13 },
      { titulo: 'Ticket médio', formato: 'reais', largura: 14 },
      { titulo: 'Clientes', formato: 'inteiro', largura: 10 },
      { titulo: 'Na 1ª visita', formato: 'inteiro', largura: 12 },
      { titulo: 'Horas de serviço', formato: 'decimal', largura: 16 },
      { titulo: 'Horas de jornada', formato: 'decimal', largura: 16 },
      { titulo: 'Ocupação', formato: 'porcento', largura: 11 },
      { titulo: 'Faltas', formato: 'inteiro', largura: 9 },
      { titulo: 'Cancelamentos', formato: 'inteiro', largura: 14 }
    ],
    linhas: d.profissionais.map((x) => [
      x.nome,
      x.ativo ? 'Ativo' : 'Inativo',
      x.atendimentos,
      reais(x.faturamentoCentavos),
      x.participacao,
      reais(x.ticketMedioCentavos),
      x.clientes,
      x.clientesNovos,
      x.horasTrabalhadas,
      x.horasDisponiveis,
      x.ocupacao,
      x.faltas,
      x.cancelados
    ])
  });

  const pr = d.produtos;
  abas.push({
    nome: 'Produtos',
    antes: [
      cabecalho[0],
      `Estoque hoje: ${pr.estoque.itens} itens · ${pr.estoque.abaixoDoMinimo} abaixo do mínimo · ${pr.estoque.semEstoque} zerados`
    ],
    colunas: [
      { titulo: 'Produto', largura: 34 },
      { titulo: 'Categoria', largura: 16 },
      { titulo: 'Situação', largura: 12 },
      { titulo: 'Vendidos', formato: 'inteiro', largura: 10 },
      { titulo: 'Faturamento', formato: 'reais', largura: 15 },
      { titulo: 'Lucro', formato: 'reais', largura: 14 },
      { titulo: 'Margem', formato: 'porcento', largura: 10 },
      { titulo: 'Perdas', formato: 'inteiro', largura: 9 },
      { titulo: 'Estoque', formato: 'inteiro', largura: 9 },
      { titulo: 'Estoque mínimo', formato: 'inteiro', largura: 15 }
    ],
    linhas: pr.lista.map((x) => [
      x.nome,
      x.categoria,
      !x.ativo ? 'Inativo' : x.estoque <= 0 ? 'Zerado' : x.abaixoDoMinimo ? 'Repor' : 'Ok',
      x.vendidos,
      reais(x.faturamentoCentavos),
      reais(x.lucroCentavos),
      x.faturamentoCentavos ? x.margem : null,
      x.perdas,
      x.estoque,
      x.estoqueMinimo
    ])
  });

  abas.push({
    nome: 'Vendas por pessoa',
    antes: [cabecalho[0], 'Vendas de produto no balcão, por quem registrou'],
    colunas: [
      { titulo: 'Quem vendeu', largura: 26 },
      { titulo: 'Itens', formato: 'inteiro', largura: 9 },
      { titulo: 'Faturamento', formato: 'reais', largura: 15 }
    ],
    linhas: pr.vendedores.map((v) => [v.nome, v.itens, reais(v.faturamentoCentavos)])
  });

  const cl = d.clientes;
  abas.push({
    nome: 'Clientes que mais gastaram',
    antes: [cabecalho[0], 'Serviços + produtos no período'],
    colunas: [
      { titulo: 'Cliente', largura: 28 },
      { titulo: 'Visitas', formato: 'inteiro', largura: 9 },
      { titulo: 'Gasto no período', formato: 'reais', largura: 17 }
    ],
    linhas: cl.top.map((x) => [x.nome, x.visitas, reais(x.gastoCentavos)])
  });

  abas.push({
    nome: 'Clientes em risco',
    antes: [cabecalho[0], `Vieram 2+ vezes e sumiram há mais de 45 dias (${cl.emRisco} no total; os 10 que mais gastaram)`],
    colunas: [
      { titulo: 'Cliente', largura: 28 },
      { titulo: 'Última visita', formato: 'data', largura: 14 },
      { titulo: 'Dias sem vir', formato: 'inteiro', largura: 13 },
      { titulo: 'Visitas', formato: 'inteiro', largura: 9 },
      { titulo: 'Gasto total', formato: 'reais', largura: 14 }
    ],
    linhas: cl.risco.map((x) => [x.nome, x.ultimaVisita, x.diasSemVir, x.visitas, reais(x.gastoTotalCentavos)])
  });

  // Indicadores soltos de clientes, WhatsApp, agenda, campanhas e IA: uma
  // tabela "Assunto / Indicador / Valor" (filtravel por assunto).
  const at = d.atendimento;
  const ag = d.agenda;
  const cp = d.campanhas;
  const ia = d.ia;
  const soltos = [
    ['Clientes', 'Contatos na base', cl.base, 'inteiro'],
    ['Clientes', 'Novos contatos no período', cl.novosContatos, 'inteiro'],
    ['Clientes', 'Atendidos no período', cl.atendidos, 'inteiro'],
    ['Clientes', 'Voltaram (não era a 1ª visita)', cl.recorrentes, 'inteiro'],
    ['Clientes', 'Na 1ª visita', cl.primeiraVisita, 'inteiro'],
    ['Clientes', 'Voltam a cada (dias, média)', cl.frequenciaRetornoDias, 'inteiro'],
    ['Clientes', 'Em risco', cl.emRisco, 'inteiro'],
    ...cl.porOrigem.map((o) => ['Clientes', `Novos contatos via ${ORIGEM_CONTATO[o.origem] ?? o.origem}`, o.total, 'inteiro']),
    ['WhatsApp', 'Conversas', at.conversas, 'inteiro'],
    ['WhatsApp', 'Finalizadas', at.finalizadas, 'inteiro'],
    ['WhatsApp', 'Ainda abertas', at.abertasAgora, 'inteiro'],
    ['WhatsApp', 'Resolvidas só pela IA', at.resolvidasSoPelaIa, 'inteiro'],
    ['WhatsApp', 'Taxa de resolução pela IA', at.taxaResolucaoIa, 'porcento'],
    ['WhatsApp', 'Passaram por uma pessoa', at.passaramPorPessoa, 'inteiro'],
    ['WhatsApp', 'Viraram agendamento', at.conversao, 'porcento'],
    ['WhatsApp', '1ª resposta média (segundos)', at.primeiraRespostaMediaSeg, 'inteiro'],
    ['WhatsApp', 'Mensagens de clientes', at.mensagens.clientes, 'inteiro'],
    ['WhatsApp', 'Mensagens da Sofia (IA)', at.mensagens.ia, 'inteiro'],
    ['WhatsApp', 'Mensagens da equipe', at.mensagens.equipe, 'inteiro'],
    ...at.porStatus.map((s) => ['WhatsApp', `Situação: ${STATUS_CONVERSA[s.status] ?? s.status}`, s.total, 'inteiro']),
    ...at.humor.map((h) => ['WhatsApp', `Humor: ${HUMOR[h.humor] ?? h.humor}`, h.total, 'inteiro']),
    ['Agenda', 'Horários marcados no período', ag.marcados, 'inteiro'],
    ['Agenda', 'Marcados a partir de conversa', ag.viaConversa, 'inteiro'],
    ['Agenda', 'Antecedência média (horas)', ag.antecedenciaMediaHoras, 'inteiro'],
    ['Agenda', 'Horários nos próximos 7 dias', ag.proximos7Dias, 'inteiro'],
    ['Agenda', 'Receita prevista nos próximos 7 dias', reais(ag.receitaPrevista7DiasCentavos), 'reais'],
    ...ag.porOrigem.map((o) => ['Agenda', `Marcados por: ${ORIGEM_AGENDA[o.origem] ?? o.origem}`, o.total, 'inteiro']),
    ...ag.motivosCancelamento.map((m) => ['Agenda', `Cancelamento: ${m.motivo}`, m.total, 'inteiro']),
    ['Campanhas', 'Mensagens enviadas', cp.enviadas, 'inteiro'],
    ['Campanhas', 'Respostas', cp.respostas, 'inteiro'],
    ['Campanhas', 'Taxa de resposta', cp.taxaResposta, 'porcento'],
    ['Campanhas', 'Interessados', cp.interessados, 'inteiro'],
    ['Campanhas', 'Pediram para sair', cp.recusas, 'inteiro'],
    ['IA', 'Chamadas aos modelos', ia.chamadas, 'inteiro'],
    ['IA', 'Falhas', ia.falhas, 'inteiro'],
    ['IA', 'Taxa de sucesso', ia.taxaSucesso, 'porcento'],
    ['IA', 'Tokens de entrada', ia.tokensEntrada, 'inteiro'],
    ['IA', 'Tokens de saída', ia.tokensSaida, 'inteiro'],
    ['IA', 'Tempo médio de resposta (ms)', ia.latenciaMediaMs, 'inteiro'],
    ...ia.porAgente.map((x) => ['IA', `Chamadas: ${AGENTE[x.agente] ?? x.agente}`, x.chamadas, 'inteiro'])
  ];
  // Cada formato em sua coluna, para a celula ter o formato certo.
  abas.push({
    nome: 'Indicadores',
    antes: [cabecalho[0]],
    colunas: [
      { titulo: 'Assunto', largura: 12 },
      { titulo: 'Indicador', largura: 40 },
      { titulo: 'Quantidade', formato: 'inteiro', largura: 12 },
      { titulo: 'Valor (R$)', formato: 'reais', largura: 14 },
      { titulo: 'Taxa', formato: 'porcento', largura: 10 }
    ],
    linhas: soltos.map(([assunto, nome, v, f]) => [
      assunto,
      nome,
      f === 'inteiro' ? v : null,
      f === 'reais' ? v : null,
      f === 'porcento' ? v : null
    ])
  });

  abas.push({
    nome: 'Atendentes',
    antes: [cabecalho[0], 'Conversas que cada atendente assumiu no período'],
    colunas: [
      { titulo: 'Atendente', largura: 24 },
      { titulo: 'Conversas', formato: 'inteiro', largura: 11 },
      { titulo: 'Finalizadas', formato: 'inteiro', largura: 12 },
      { titulo: 'Mensagens enviadas', formato: 'inteiro', largura: 19 },
      { titulo: '1ª resposta média (s)', formato: 'inteiro', largura: 20 }
    ],
    linhas: at.porAtendente.map((x) => [x.nome, x.conversas, x.finalizadas, x.mensagens, x.primeiraRespostaMediaSeg])
  });

  abas.push({
    nome: 'Campanhas',
    antes: [cabecalho[0], 'Mensagens enviadas no período'],
    colunas: [
      { titulo: 'Campanha', largura: 34 },
      { titulo: 'Enviadas', formato: 'inteiro', largura: 10 },
      { titulo: 'Respostas', formato: 'inteiro', largura: 11 },
      { titulo: 'Taxa de resposta', formato: 'porcento', largura: 16 },
      { titulo: 'Interessados', formato: 'inteiro', largura: 13 },
      { titulo: 'Pediram para sair', formato: 'inteiro', largura: 17 }
    ],
    linhas: cp.lista.map((x) => [x.nome, x.enviadas, x.respostas, x.taxaResposta, x.interessados, x.recusas])
  });

  abas.push({
    nome: 'IA por modelo',
    antes: [cabecalho[0]],
    colunas: [
      { titulo: 'Provedor · modelo', largura: 36 },
      { titulo: 'Chamadas', formato: 'inteiro', largura: 11 },
      { titulo: 'Falhas', formato: 'inteiro', largura: 9 },
      { titulo: 'Tokens', formato: 'inteiro', largura: 13 }
    ],
    linhas: ia.porModelo.map((x) => [x.modelo, x.chamadas, x.falhas, x.tokens])
  });

  return {
    buffer: gerarXlsx(abas),
    nomeArquivo: `dashboard_${p.de}_a_${p.ate}.xlsx`,
    abas: abas.map((x) => x.nome)
  };
}
