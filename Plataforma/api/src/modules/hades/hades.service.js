import { RegraDeNegocio } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { relatorio } from '../analises/analises.service.js';
import * as empresa from '../empresa/empresa.service.js';
import { configComChave, salvarConfig } from './hades.config.js';
import { gerarHades, listarModelosHades, modeloPadrao } from './gemini-hades.js';

const log = comContexto({ modulo: 'hades' });

/**
 * O Hades conversando com o dono.
 *
 * O que ele sabe do negocio vem de um RESUMO montado aqui a cada pergunta, a
 * partir dos mesmos numeros do Dashboard (ultimos 30 dias contra os 30
 * anteriores, mais o ano). Ele so LE: nao marca, nao cancela, nao manda
 * mensagem para ninguem. O que ele sabe do mundo vem da pesquisa do Google.
 */

/** Regras que valem sempre, por cima da persona editavel na tela. */
const REGRAS = [
  'REGRAS (sempre):',
  '- Responda em português do Brasil, em markdown simples: parágrafos curtos, **negrito** no que importa, listas quando ajudar. Sem tabelas largas.',
  '- Números do negócio: use SOMENTE os do RESUMO DO NEGÓCIO abaixo. Não invente nem "estime" um número que não está lá; se faltar, diga que não tem esse dado.',
  '- Tendências do mercado, preços da região, datas comemorativas e novidades do ramo: pesquise na internet e diga de onde tirou.',
  '- Separe o que é FATO (dos números) do que é SUGESTÃO sua.',
  '- Você só aconselha: não diz que marcou, mandou mensagem ou mudou algo no sistema.',
  '- Seja breve na primeira resposta; aprofunde se o dono pedir.'
].join('\n');

const reais = (centavos) => `R$ ${((centavos ?? 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const variacao = (atual, anterior) => {
  if (!anterior) return atual ? '(sem base anterior)' : '';
  const v = ((atual - anterior) / anterior) * 100;
  return `(${v >= 0 ? '+' : ''}${v.toFixed(1)}% vs 30 dias anteriores)`;
};

/** Resumo dos numeros em texto enxuto (poucos tokens, so o que ajuda a decidir). */
async function resumoDoNegocio(tenantId) {
  const [emp, r, ano] = await Promise.all([
    empresa.obter(tenantId).catch(() => null),
    relatorio(tenantId, { dias: 30 }),
    relatorio(tenantId, { dias: 365 }).catch(() => null)
  ]);
  const a = r.resumo;
  const b = r.resumoAnterior;
  const linhas = [];

  if (emp) {
    linhas.push(`EMPRESA: ${emp.nome}${emp.segmento ? ` (${emp.segmento})` : ''}`);
    const sobre = empresa.textoParaIa(emp);
    if (sobre) linhas.push(sobre.slice(0, 1500));
  }
  linhas.push(`HOJE: ${new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: r.periodo.fuso })}`);
  linhas.push(`PERÍODO: ${r.periodo.de} a ${r.periodo.ate}${r.periodo.anterior.completo ? '' : ' (os registros anteriores estão incompletos: comparações são frágeis)'}`);

  linhas.push('NÚMEROS (30 dias):');
  linhas.push(`- Faturamento: ${reais(a.faturamentoCentavos)} ${variacao(a.faturamentoCentavos, b.faturamentoCentavos)} — serviços ${reais(a.servicosCentavos)}, produtos ${reais(a.produtosCentavos)}`);
  linhas.push(`- Atendimentos: ${a.atendimentos} ${variacao(a.atendimentos, b.atendimentos)}; ticket médio ${reais(a.ticketMedioCentavos)}`);
  linhas.push(`- Clientes atendidos: ${a.clientesAtendidos} (${a.clientesNovos} na 1ª visita); novos contatos: ${a.novosContatos}; conversas: ${a.conversas}`);
  linhas.push(`- Faltas: ${a.faltas} (${a.taxaFalta}%); cancelamentos: ${a.cancelados}; descontos dados: ${reais(a.descontosCentavos)}; produtos vendidos: ${a.itensVendidos}`);

  if (r.servicos?.length) {
    linhas.push('SERVIÇOS que mais faturam:');
    for (const s of r.servicos.slice(0, 8)) linhas.push(`- ${s.nome}: ${s.quantidade}x, ${reais(s.faturamentoCentavos)}`);
  }
  if (r.profissionais?.length) {
    linhas.push('PROFISSIONAIS:');
    for (const p of r.profissionais.filter((x) => x.ativo || x.atendimentos).slice(0, 12)) {
      linhas.push(`- ${p.nome}: ${p.atendimentos} atendimentos, ${reais(p.faturamentoCentavos)}, ocupação ${p.ocupacao}%, faltas ${p.faltas}`);
    }
  }

  const dias = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const porDia = r.calor.porDiaSemana.atendimentos;
  linhas.push('MOVIMENTO (atendimentos por dia da semana, 30 dias):');
  linhas.push(`- ${[1, 2, 3, 4, 5, 6, 0].map((d) => `${dias[d]} ${porDia[d]}`).join(', ')}`);
  if (r.calor.picos.atendimentos) linhas.push(`- Pico: ${r.calor.picos.atendimentos.rotulo}`);
  const porHora = r.calor.porHora.atendimentos.map((v, h) => ({ h, v })).filter((x) => x.v > 0);
  if (porHora.length) {
    const fracas = [...porHora].sort((x, y) => x.v - y.v).slice(0, 4).map((x) => `${x.h}h`);
    const fortes = [...porHora].sort((x, y) => y.v - x.v).slice(0, 4).map((x) => `${x.h}h`);
    linhas.push(`- Horas mais cheias: ${fortes.join(', ')}; mais vazias (com algum movimento): ${fracas.join(', ')}`);
  }
  const mes = r.calor.visoes?.mes?.porLinha?.atendimentos;
  if (mes) linhas.push(`- Por semana do mês (dias 1-7, 8-14, 15-21, 22-28, 29-31): ${mes.join(', ')}`);

  if (ano?.calor?.visoes?.ano) {
    const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    const porMes = ano.calor.visoes.ano.porLinha.faturamento;
    const comDados = porMes.map((v, i) => (v ? `${meses[i]} ${reais(v)}` : null)).filter(Boolean);
    if (comDados.length) linhas.push(`FATURAMENTO POR MÊS (últimos 12 meses): ${comDados.join(', ')}`);
  }

  const c = r.clientes;
  linhas.push(`CLIENTES: base ${c.base}; recorrentes no período ${c.recorrentes}; retorno médio ${c.frequenciaRetornoDias ?? '?'} dias; em risco de sumir: ${c.emRisco}`);
  const g = r.agenda;
  linhas.push(`AGENDA: ${g.proximos7Dias} horários nos próximos 7 dias (${reais(g.receitaPrevista7DiasCentavos)} previstos); antecedência média ${g.antecedenciaMediaHoras ?? '?'} h`);
  if (g.motivosCancelamento?.length) linhas.push(`- Motivos de cancelamento: ${g.motivosCancelamento.map((m) => `${m.motivo} (${m.total})`).join('; ')}`);
  const e = r.produtos.estoque;
  linhas.push(`PRODUTOS: lucro ${reais(r.produtos.lucroCentavos)} no período; ${e.abaixoDoMinimo} abaixo do mínimo, ${e.semEstoque} sem estoque`);
  const at = r.atendimento;
  linhas.push(`WHATSAPP: ${at.conversas} conversas; ${at.taxaResolucaoIa}% resolvidas só pela IA; 1ª resposta média ${at.primeiraRespostaMediaSeg ?? '?'} s`);

  return linhas.join('\n');
}

/** Resumo guardado por 5 min por empresa: a conversa nao recalcula o Dashboard a cada frase. */
const cacheResumo = new Map();
async function resumoEmCache(tenantId) {
  const c = cacheResumo.get(tenantId);
  if (c && Date.now() - c.em < 5 * 60_000) return c.texto;
  const texto = await resumoDoNegocio(tenantId);
  cacheResumo.set(tenantId, { em: Date.now(), texto });
  return texto;
}

/** Garante um modelo: o escolhido, ou o melhor "flash" que a chave enxerga (e grava). */
async function modeloDe(tenantId, cfg) {
  if (cfg.modelo) return cfg.modelo;
  const lista = await listarModelosHades(cfg.apiKey);
  const escolhido = modeloPadrao(lista);
  if (!escolhido) throw new RegraDeNegocio('Não encontrei um modelo Gemini para esta chave. Escolha um na configuração do Hades.');
  await salvarConfig(tenantId, { modelo: escolhido });
  return escolhido;
}

function traduzirErro(err) {
  if (err instanceof RegraDeNegocio) return err;
  const status = err?.status;
  if (status === 400 || status === 401 || status === 403) return new RegraDeNegocio('O Google recusou a chave do Hades. Confira a chave na configuração (Inteligência Artificial > Agentes > Hades).');
  if (status === 429) return new RegraDeNegocio('A cota da chave do Hades acabou por agora. Tente de novo em alguns minutos.');
  return new RegraDeNegocio(`O Hades não conseguiu responder agora (${String(err?.message ?? err).slice(0, 160)}).`);
}

/**
 * Uma volta da conversa. `mensagens`: o historico que a tela guarda
 * ([{ papel: 'user'|'assistant', conteudo }]), a ultima e a pergunta.
 */
export async function conversar(tenantId, mensagens) {
  const cfg = await configComChave(tenantId);
  if (!cfg.ativo) throw new RegraDeNegocio('O Hades está desligado na configuração.');
  if (!cfg.apiKey) throw new RegraDeNegocio('O Hades ainda não tem chave de API. Configure em Inteligência Artificial > Agentes > Hades.');

  try {
    const modelo = await modeloDe(tenantId, cfg);
    const resumo = await resumoEmCache(tenantId);
    const systemPrompt = `${cfg.systemPrompt}\n\nSeu nome é ${cfg.nome}.\n\n${REGRAS}\n\nRESUMO DO NEGÓCIO (dados reais do sistema):\n${resumo}`;
    const inicio = Date.now();
    const r = await gerarHades({
      apiKey: cfg.apiKey,
      modelo,
      systemPrompt,
      mensagens: mensagens.slice(-20),
      temperatura: cfg.temperatura,
      pesquisaWeb: cfg.pesquisaWeb
    });
    log.info({ tenantId, modelo, ms: Date.now() - inicio, buscas: r.buscas.length, tokens: r.tokens }, 'Hades respondeu');
    return { texto: r.texto, fontes: r.fontes, buscas: r.buscas, modelo };
  } catch (err) {
    log.warn({ err, tenantId }, 'Hades falhou');
    throw traduzirErro(err);
  }
}

/** Botao "Testar" da configuracao: uma pergunta curtinha, sem pesquisa. */
export async function testar(tenantId) {
  const cfg = await configComChave(tenantId);
  if (!cfg.apiKey) throw new RegraDeNegocio('Cole a chave de API do Gemini antes de testar.');
  try {
    const modelo = await modeloDe(tenantId, cfg);
    const inicio = Date.now();
    await gerarHades({ apiKey: cfg.apiKey, modelo, systemPrompt: 'Responda apenas: OK', mensagens: [{ papel: 'user', conteudo: 'teste' }], pesquisaWeb: false, timeoutMs: 20_000 });
    return { ok: true, modelo, latenciaMs: Date.now() - inicio };
  } catch (err) {
    throw traduzirErro(err);
  }
}

/** Modelos que a chave do Hades enxerga, para escolher na tela. */
export async function modelos(tenantId) {
  const cfg = await configComChave(tenantId);
  if (!cfg.apiKey) throw new RegraDeNegocio('Cole a chave de API do Gemini para ver os modelos.');
  const lista = await listarModelosHades(cfg.apiKey);
  if (lista === null) throw new RegraDeNegocio('Não consegui consultar os modelos com esta chave. Confira a chave.');
  return {
    modelos: lista
      .filter((m) => /gemini/.test(m.nome) && !/embedding|image|tts|aqa/i.test(m.nome))
      .map((m) => ({ nome: m.nome, nomeExibicao: m.nomeExibicao })),
    sugerido: modeloPadrao(lista)
  };
}
