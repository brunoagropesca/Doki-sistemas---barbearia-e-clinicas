import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { menuFlows, settings } from '../../db/schema/ai.js';
import { tenants } from '../../db/schema/tenants.js';
import { dataNoFuso, diaDaSemana, horaNoFuso, FUSO_PADRAO } from '../../core/datetime.js';
import { NOMES_DIAS } from '../../core/datas-naturais.js';
import { comContexto } from '../../core/logger.js';
import { conversar, dividirEmBaloes } from '../../ai/agente.js';
import { gerar } from '../../ai/cascade.js';
import {
  formatarParaWhatsapp,
  pareceIrritado,
  pareceReclamacao,
  pediuDesculpas,
  precosNaoVerificados,
  precosPermitidos,
  tirarFrasesDeBastidores,
  vazaBastidores
} from '../../ai/saida.js';
import { TONS } from '../../ai/agentes-padrao.js';
import { ferramentasDaSofia } from '../../ai/tools/sofia.tools.js';
import { lerHumor } from '../../ai/humor.js';
import { avancarEtapa } from '../../automacao/funil.js';
import { catalogoDaEmpresa, resumoDoCatalogo } from '../../ai/tools/catalogo-cache.js';
import * as catalogo from '../catalogo/catalogo.service.js';
import * as conversas from '../conversas/conversas.service.js';
import { obterAgente } from '../ia/ia.service.js';
import { textoDosServicos } from './menu.js';
import { fluxoDaEmpresa, iaConduzindo, passoDoFluxo, reapresentar, validarFluxo } from './fluxo.js';
import { RegraDeNegocio } from '../../core/errors.js';
import {
  lerEstadoMenu,
  gravarEstadoMenu,
  humorDaConversa,
  ultimaMensagemHumanaEm as lerUltimaMensagemHumana
} from '../conversas/conversas.repo.js';
import { itensNaoLidos, itensRelevantes } from '../empresa/relevancia.js';
import { colorir, negrito, resumir, ver } from '../../core/painel.js';
import { funcaoLigada } from '../funcoes/funcoes.js';
import { mensagemAoCliente } from '../textos/textos.js';
import { expedienteDaEmpresa } from './expediente.js';
import { baseParaIa } from '../empresa/empresa.service.js';
import { memoriaParaPrompt } from '../leads/memoria.js';

const log = comContexto({ modulo: 'atendimento' });

/**
 * O cerebro do atendimento automatico.
 *
 * Decide, para cada mensagem do cliente, quem responde:
 *   - o menu estatico (zero custo, resposta instantanea),
 *   - a IA (entende linguagem livre, custa e demora um pouco),
 *   - ou ninguem, porque um humano assumiu a conversa.
 *
 * Tres modos, configurados pela empresa:
 *   'menu'    — so menu. Nunca gasta com IA.
 *   'hibrido' — menu para quem digita numero, IA para quem escreve livremente.
 *               E o padrao: cobre os dois tipos de cliente pagando IA so
 *               quando ela e realmente necessaria.
 *   'ia'      — IA sempre, inclusive na saudacao.
 */

const MODOS = ['menu', 'hibrido', 'ia'];

/** Le uma configuracao da empresa, com valor padrao. */
async function config(tenantId, chave, padrao) {
  const linha = await db.query.settings.findFirst({
    where: and(eq(settings.tenantId, tenantId), eq(settings.chave, chave))
  });
  return linha?.valor ?? padrao;
}

async function contextoDaEmpresa(tenantId) {
  const [tenant, menu, sofia, atena, catalogoResumo, base, servicosDoCatalogo] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) }),
    db.query.menuFlows.findFirst({
      where: and(eq(menuFlows.tenantId, tenantId), eq(menuFlows.ativo, true))
    }),
    obterAgente(tenantId, 'atendente'),
    obterAgente(tenantId, 'atena'),
    // Preco e informacao PUBLICA (esta no menu, na parede da loja): vai para a
    // Sofia sempre. Antes dependia da permissao "catalogo" da Atena — com a
    // Atena desligada, "quanto custa o corte?" virava transferencia para humano.
    resumoDoCatalogo(tenantId),
    // Endereco, Pix, horario, regras da casa: o que a empresa cadastrou em
    // Inteligencia Artificial > Base de conhecimento.
    baseParaIa(tenantId),
    // A lista (em cache): diz se o catalogo esta VAZIO e quais precos existem
    // de verdade — a trava contra preco inventado (ver `semPrecoInventado`).
    catalogoDaEmpresa(tenantId)
  ]);

  return {
    fuso: tenant?.fusoHorario || FUSO_PADRAO,
    nomeEmpresa: tenant?.nome ?? 'nossa empresa',
    fluxo: fluxoDaEmpresa(menu),
    sofia,
    atena,
    catalogoResumo,
    // O essencial vai no prompt; os detalhes (regras, FAQ, extras), so quando
    // a Sofia consulta (consultar_informacoes).
    baseConhecimento: base.texto,
    baseDetalhes: base.detalhes,
    baseItens: base.itens,
    baseIndice: base.indice,
    servicosDoCatalogo
  };
}

/** Todos os precos reais do catalogo: o do servico e o proprio de cada profissional. */
function precosDoCatalogo(servicos) {
  return servicos.flatMap((s) => [s.precoCentavos, ...(s.profissionais ?? []).map((p) => p.precoCentavos)]);
}

/**
 * O aviso de que o cliente foi para a fila, respeitando o horario da casa.
 *
 * "Um instante! 🙏" as 23h e uma promessa que ninguem cumpre: com a casa
 * FECHADA, os baloes viram o texto que diz QUANDO alguem responde (e a Sofia
 * continua ajudando enquanto isso — ver o gateway). Aberta, nada muda.
 */
async function avisoDeTransferencia(tenantId, baloes) {
  const { aberta, proximaAbertura } = await expedienteDaEmpresa(tenantId);
  if (aberta) return baloes;
  const texto = await mensagemAoCliente(tenantId, 'fila.fora_do_horario');
  return [texto.replace('{abertura}', proximaAbertura ?? 'no próximo horário de atendimento')];
}

/**
 * O que dizer quando chega foto/video/documento SEM texto: vai para uma
 * pessoa conferir. Respeita o horario da casa como qualquer transferencia.
 */
export async function avisoDeMidiaRecebida(tenantId) {
  const [texto] = await avisoDeTransferencia(tenantId, [await mensagemAoCliente(tenantId, 'fila.midia_recebida')]);
  return texto;
}

/** Minutos na fila sem ninguem assumir ate a Sofia voltar a ajudar (0 = nunca). */
export const FILA_ESPERA_MINUTOS_PADRAO = 30;
/** Horas sem o atendente escrever ate a conversa "Humano" voltar para a Sofia (0 = nunca). */
export const HUMANO_ABANDONO_HORAS_PADRAO = 12;

/**
 * O cliente esta na fila e escreveu de novo: a Sofia volta a ajudar?
 *
 * Antes, tudo o que ele escrevia depois de "quero falar com uma pessoa" ficava
 * sem resposta ate alguem assumir — inclusive a noite e por dias. Ela volta
 * quando ninguem vai aparecer logo: casa FECHADA, ou fila parada ha mais que
 * `fila_espera_minutos`. A conversa CONTINUA na fila: quando alguem assumir,
 * assume normalmente.
 *
 * @param {{ naFilaDesde?: number|null, ultimaMensagemEm?: number|null }} conversa  como `conversas.obter` devolve
 */
export async function sofiaAjudaNaFila(tenantId, conversa, agora = Date.now()) {
  const limite = Number(await config(tenantId, 'fila_espera_minutos', FILA_ESPERA_MINUTOS_PADRAO));
  if (!limite) return false;
  if (!(await expedienteDaEmpresa(tenantId, agora)).aberta) return true;
  // Conversa que entrou na fila antes de existir `naFilaDesde`: a ultima
  // mensagem e a melhor aproximacao que ha.
  const desde = conversa.naFilaDesde ?? conversa.ultimaMensagemEm;
  return Boolean(desde) && agora - desde >= limite * 60_000;
}

/**
 * Conversa com atendente em que ele SUMIU (esqueceu de finalizar)?
 *
 * Sem isto o cliente falava sozinho para sempre: com status 'humana' a IA fica
 * em silencio. Conta desde a ultima mensagem do atendente (ou, se ele nunca
 * escreveu, desde que assumiu).
 *
 * @param {{ id: string, assumidaEm?: number|null }} conversa  como `conversas.obter` devolve
 */
export async function atendenteSumiu(tenantId, conversa, agora = Date.now()) {
  const horas = Number(await config(tenantId, 'humano_abandono_horas', HUMANO_ABANDONO_HORAS_PADRAO));
  if (!horas) return false;
  const ultimaHumana = await lerUltimaMensagemHumana(tenantId, conversa.id);
  const desde = ultimaHumana?.getTime() ?? conversa.assumidaEm;
  return Boolean(desde) && agora - desde >= horas * 3_600_000;
}

/**
 * Regras de dados quando PARTE das ferramentas de agenda da Sofia esta
 * desligada. Cada linha diz o que ela faz e, para o que nao tem, o caminho
 * (uma pessoa) — senao ela prometeria algo que nao consegue cumprir.
 */
function regrasParciais(cap) {
  const consultas = [
    cap.horarios ? 'Horários livres: consultar_horarios (consultar_varios_servicos para 2+ serviços na mesma visita).' : null,
    cap.agendamentos ? 'Agendamentos do cliente: consultar_agendamentos_do_cliente.' : null
  ].filter(Boolean);

  return [
    `1. Preços: use o CATALOGO abaixo.${consultas.length ? ` ${consultas.join(' ')} São instantâneas: use à vontade.` : ''}`,
    ...(cap.horarios ? [] : ['   Horários livres você NÃO consegue ver: para marcar, use transferir_para_humano.']),
    ...(cap.agendamentos || cap.atena ? [] : ['   Os horários que o cliente já tem você NÃO consegue ver: use transferir_para_humano.']),
    ...(cap.atena ? ['   O que suas consultas não trazem: peça à Atena.'] : []),
    cap.reservar
      ? '2. MARCAR: reservar_horario, com o horário que sua consulta mostrou e o cliente escolheu.'
      : cap.horarios
        ? '2. MARCAR: você não marca. Mostre as opções e, com o horário escolhido, use transferir_para_humano.'
        : '2. MARCAR: use transferir_para_humano.',
    cap.atena
      ? '   REMARCAR ou CANCELAR: consultar_atena, com o pedido completo.'
      : '   REMARCAR ou CANCELAR: use transferir_para_humano.',
    '   Só confirme o que voltou com sucesso; se não deu, explique ou pergunte. Nunca prometa "já te retorno".',
    '3. NUNCA invente preço, horário ou disponibilidade: só o CATALOGO e o que suas consultas',
    '   ou a Atena devolveram.',
    '4. Datas: passe como o cliente falou ("sexta", "dia 25"); a resposta traz o dia por',
    '   extenso, use-o. Cliente não disse o dia? Pergunte. Nunca escolha por ele.',
    '5. Mais de uma opção de horário: ofereça poucas (2 ou 3), não a lista inteira.',
    '6. Mensagem sem pedido novo ("ok", "obrigado", emoji): responda curto, sem',
    '   consultar nada e sem cumprimentar de novo.'
  ];
}

/** Monta as instrucoes da Sofia a partir do perfil configurado + contexto vivo. */
export function montarSystemPrompt({
  agente,
  nomeEmpresa,
  fuso,
  leadNome,
  hoje,
  horaAtual,
  atenaAtiva,
  // Nomes das ferramentas que a Sofia recebeu neste turno (ver `tem` abaixo).
  ferramentasDaSofia = null,
  catalogoResumo,
  catalogoVazio = false,
  baseConhecimento,
  indiceDetalhes = '',
  informacoesRelevantes = [],
  irritado = false,
  reclamacao = false,
  aguardandoHumano = false,
  // Ficha do cliente (leads/memoria.js): ja destilada e com teto de tamanho.
  memoriaCliente = ''
}) {
  const base =
    agente?.systemPrompt?.trim() ||
    `Voce e a atendente virtual de ${nomeEmpresa}. Seja calorosa, direta e objetiva.`;

  /**
   * O que a Sofia TEM nesta conversa, lido da lista real de ferramentas (cada
   * uma obedece a um interruptor dela). Sem a lista (chamadas antigas/testes),
   * vale o de antes: tudo, se a Atena estiver ligada.
   */
  const tem = (nome) => (ferramentasDaSofia ? ferramentasDaSofia.includes(nome) : atenaAtiva);
  const cap = {
    horarios: tem('consultar_horarios'),
    agendamentos: tem('consultar_agendamentos_do_cliente'),
    reservar: tem('reservar_horario'),
    atena: tem('consultar_atena')
  };
  const tudo = cap.horarios && cap.agendamentos && cap.reservar && cap.atena;
  const alguma = cap.horarios || cap.agendamentos || cap.reservar || cap.atena;

  const regraDeDados = tudo
    ? [
        '1. Preços: use o CATALOGO abaixo. Horários livres e agendamentos do cliente: use',
        '   suas consultas (consultar_horarios; consultar_varios_servicos para 2+ serviços na',
        '   mesma visita; consultar_agendamentos_do_cliente). São instantâneas: use à vontade.',
        '   O que suas consultas não trazem: peça à Atena.',
        '2. MARCAR: reservar_horario, com o horário que sua consulta mostrou e o cliente',
        '   escolheu. REMARCAR ou CANCELAR: consultar_atena, com o pedido completo. Só confirme',
        '   o que voltou com sucesso; se não deu, explique ou pergunte. Nunca prometa "já te retorno".',
        '3. NUNCA invente preço, horário ou disponibilidade: só o CATALOGO e o que as consultas',
        '   ou a Atena devolveram. Horário para vários serviços juntos: só os que vieram em',
        '   "opcoes" (se vier "obs" ou "esperaEntreServicos", conte ao cliente).',
        '4. Datas: passe como o cliente falou ("sexta", "dia 25"); a resposta traz o dia por',
        '   extenso, use-o. Se vier "aviso", confirme com o cliente. Cliente não disse o dia?',
        '   Pergunte, ou consulte sem data (vem o próximo dia com vaga). Nunca escolha por ele.',
        '5. Mais de uma opção de horário: ofereça poucas (2 ou 3), não a lista inteira.',
        '6. Mensagem sem pedido novo ("ok", "obrigado", emoji): responda curto, sem',
        '   consultar nada e sem cumprimentar de novo.'
      ]
    : alguma
      ? regrasParciais(cap)
      : catalogoResumo
        ? [
            // Sem nenhuma ferramenta de agenda o PRECO continua respondivel (o
            // catalogo vai sempre); o que exige uma pessoa e a agenda.
            '1. A agenda está DESATIVADA. Preços: use o CATALOGO abaixo. Horários e',
            '   agendamentos você NÃO consegue ver nem marcar: para isso, use transferir_para_humano.',
            '2. NUNCA invente preço, horário ou disponibilidade. Dúvida que o CATALOGO não responde:',
            '   use transferir_para_humano.'
          ]
        : [
            '1. A agenda (horários e agendamentos) está DESATIVADA. Você não tem como consultar',
            '   preços, horários ou agendamentos.',
            '2. NUNCA invente preço, horário ou disponibilidade. Para qualquer dúvida desse tipo,',
            '   use transferir_para_humano.'
          ];

  return [
    base,
    '',
    'REGRAS INEGOCIÁVEIS:',
    ...regraDeDados,
    '7. Para o cliente, é VOCÊ quem verifica e agenda. Nunca cite a Atena, "o sistema",',
    '   cadastro, ferramentas nem erros internos.',
    '8. Se o cliente pedir para falar com uma pessoa, use transferir_para_humano',
    '   imediatamente, sem insistir.',
    // O roteiro de reclamacao/irritacao so entra quando ha sinal disso nas
    // ultimas mensagens (~250 tokens a menos em quase toda mensagem). Sem o
    // sinal, fica a versao de uma linha: a Sofia ainda sabe o que fazer.
    ...(reclamacao || irritado
      ? [
          '9. RECLAMAÇÃO sobre algo que já aconteceu (serviço, atendimento, cobrança): acolha',
          '   antes de transferir, para o atendente já chegar sabendo de tudo:',
          '   a) Peça desculpas pelo transtorno, sem culpar ninguém e sem discutir.',
          '   b) Pergunte o que houve, UMA pergunta por mensagem: o quê, quando, com qual',
          '      serviço ou profissional, e o que ele gostaria que fosse feito.',
          '   c) Não prometa reembolso, desconto, brinde nem solução: quem decide é a equipe.',
          '   d) Entendeu (1 a 3 trocas)? Avise que vai passar para um atendente e use',
          '      transferir_para_humano com cliente_frustrado=true e um motivo que resuma tudo.',
          '   e) Pediu uma pessoa, não quer explicar ou ficou mais irritado: transfira na hora.',
          '10. IRRITAÇÃO com ESTA conversa (você não resolveu, repetiu, demorou): não investigue',
          '   nem se justifique. Resolva nesta resposta ou transfira com cliente_frustrado=true.',
          '   Se o mesmo pedido já deu errado uma vez, transfira.'
        ]
      : [
          '9. Reclamação ou irritação: acolha, não prometa nada e use transferir_para_humano',
          '   com cliente_frustrado=true.'
        ]),
    '',
    // Sem catalogo no prompt, a regra "use o CATALOGO abaixo" apontava para o
    // vazio — e o modelo preenchia com uma tabela "tipica de barbearia". O
    // vazio precisa ser DITO. (E a trava de preco pega o que escapar.)
    ...(catalogoResumo
      ? ['CATALOGO (dados verificados do sistema):', catalogoResumo, '']
      : catalogoVazio
        ? [
            'CATALOGO: NENHUM serviço cadastrado ainda. NÃO cite serviço, preço nem duração —',
            'nenhum, nem de exemplo. Se perguntarem, diga que a equipe informa os serviços e',
            'valores e ofereça chamar um atendente.',
            ''
          ]
        : [
            'CATALOGO: grande demais para listar aqui. Preço de um serviço: consultar_horarios',
            '(o resultado traz o preço). NUNCA cite um valor que não veio de uma consulta.',
            ''
          ]),
    // Muda pouco (so quando a empresa edita): fica no bloco fixo, antes do
    // CONTEXTO, e o provedor segue reaproveitando o inicio do prompt.
    ...(baseConhecimento || indiceDetalhes
      ? [
          'BASE DE CONHECIMENTO (informações oficiais da empresa). Use para responder sobre',
          'endereço, contato, pagamento e horário de funcionamento.',
          // Regras da casa, FAQ e extras nao vao aqui (metade do prompt, raramente
          // usados). Vai so o INDICE, para ela saber que a resposta existe; o
          // texto ela le por consultar_informacoes (ou o codigo ja coloca abaixo,
          // em INFORMAÇÕES LIGADAS A ESTA MENSAGEM, quando casa com o pedido).
          ...(indiceDetalhes
            ? [`Também cadastrado (use consultar_informacoes antes de responder sobre isso; nunca de memória): ${indiceDetalhes}.`]
            : []),
          'O que não estiver aqui nem nas consultas você NÃO sabe: não invente; use',
          'transferir_para_humano se o cliente precisar.',
          ...(baseConhecimento ? [baseConhecimento] : []),
          ''
        ]
      : []),
    'ESTILO DE WHATSAPP:',
    '- Português brasileiro, natural, como uma profissional experiente.',
    '- Respostas curtas. Negrito com UM asterisco: *R$ 45,00*. Nunca use **.',
    '- Emojis com moderação.',
    '- Divida respostas longas escrevendo [BALAO] entre os trechos (no máximo 3 partes).',
    '',
    // O que muda a cada conversa (e a cada minuto) vai por ultimo: assim o
    // bloco fixo acima e identico entre chamadas e o provedor pode reaproveita-lo.
    // Datas alem de hoje NAO entram aqui: quem converte "sexta" e a Atena, por
    // codigo (core/datas-naturais.js), sem gastar token em toda mensagem.
    'CONTEXTO:',
    `- Empresa: ${nomeEmpresa}. Cliente: ${leadNome ?? 'ainda nao identificado'}.`,
    `- Hoje é ${NOMES_DIAS[diaDaSemana(hoje)]}, ${hoje.split('-').reverse().join('/')}, ${horaAtual} (fuso ${fuso}).`,
    `- Tom de voz: ${TONS[agente?.tom] ?? TONS.acolhedor}.`,
    ...(irritado
      ? ['- ATENÇÃO: o cliente parece irritado nesta mensagem. Siga a regra 10: resolva agora ou transfira.']
      : []),
    // Cliente na fila que a Sofia voltou a ajudar (casa fechada ou fila parada).
    // Sem isto ela transferiria de novo a cada "e ai?", em circulo.
    // Cliente que volta: o que ela ja sabe dele, de visitas anteriores. So
    // quando existe ficha — cliente novo nao paga nem uma linha. Preco nao
    // entra na ficha: a trava de preco continua aceitando so o catalogo.
    ...(memoriaCliente
      ? [
          '',
          'O QUE VOCÊ JÁ SABE DESTE CLIENTE (de atendimentos anteriores):',
          memoriaCliente,
          'Use com naturalidade, como quem lembra do cliente (ex.: sugerir o serviço de sempre ou',
          'o profissional de costume), sem listar tudo. Nunca diga que "consta no sistema" ou "no',
          'cadastro". Confirme antes de marcar. Preço: só do CATALOGO.'
        ]
      : []),
    ...(aguardandoHumano
      ? ['- O cliente já pediu um atendente e a equipe já foi avisada, mas ninguém assumiu ainda. Ajude no que',
         '  puder agora; não prometa prazo e não transfira de novo só porque ele insistiu.']
      : []),
    // O que da base casa com ESTA mensagem (escolhido pelo codigo, relevancia.js):
    // a resposta certa ja chega a ela, sem depender de lembrar de consultar.
    ...(informacoesRelevantes.length
      ? [
          '',
          'INFORMAÇÕES OFICIAIS LIGADAS A ESTA MENSAGEM (da base de conhecimento; use-as):',
          ...informacoesRelevantes.map((i) => `- ${i.tema}: ${i.texto}`)
        ]
      : [])
  ].join('\n');
}

/**
 * Reescreve UMA vez uma resposta que expos os bastidores ("a Atena pediu",
 * "o sistema indicou"). Chamada curta, so com o rascunho: nao reenvia a
 * conversa inteira. Se a reescrita falhar ou vazar de novo, tiramos as frases
 * culpadas — nunca deixamos o cliente sem resposta por causa disso.
 */
async function semBastidores({ tenantId, conversationId, texto, provedores }) {
  const trecho = vazaBastidores(texto);
  if (!trecho) return texto;

  ver('aviso', `${colorir('sofia', 'Sofia')} citou os bastidores ("${trecho}"): reescrevendo`);
  log.warn({ tenantId, conversationId, trecho }, 'Resposta citava os bastidores; reescrevendo');

  try {
    const r = await gerar({
      tenantId,
      origem: 'atendimento',
      agentKey: 'atendente',
      conversationId,
      systemPrompt:
        'Você revisa mensagens de WhatsApp de uma atendente para o cliente. Reescreva a mensagem sem citar ' +
        'Atena, sistema, cadastro, ferramentas, dados internos ou erros técnicos: quem verificou foi a própria ' +
        'atendente. Mantenha exatamente valores, datas, horários, nomes e o tom. Mantenha os [BALAO]. ' +
        'Não acrescente saudação: a conversa já está em andamento. ' +
        'Devolva só a mensagem.',
      mensagens: [{ papel: 'user', conteudo: texto }],
      temperatura: 0.3,
      maxTokens: 600,
      provedores,
      exigirRespostaCompleta: true
    });
    const nova = String(r.texto ?? '').trim();
    if (nova && !vazaBastidores(nova)) return nova;
  } catch (err) {
    log.warn({ err, tenantId }, 'Reescrita sem bastidores falhou; tirando as frases');
  }
  return tirarFrasesDeBastidores(texto);
}

/**
 * A Sofia falou de um tema que ESTA na base (Wi-Fi, estacionamento, crianca,
 * atraso...) sem ter lido o que a empresa cadastrou: nem veio no prompt, nem
 * ela consultou. Pode ter acertado — ou inventado ("temos Wi-Fi sim" numa casa
 * sem Wi-Fi). UMA revisao curta, so com o rascunho e o texto oficial daquele
 * tema. Se a revisao falhar, sai o rascunho (e fica no log): sem resposta e
 * pior, e o prompt ja pedia para consultar.
 */
async function semInformacaoNaoLida({ tenantId, conversationId, texto, naoLidos, provedores }) {
  if (!naoLidos.length) return texto;

  ver('aviso', `${colorir('sofia', 'Sofia')} falou de um tema da base sem ler: revisando com a informação oficial`);
  log.warn({ tenantId, conversationId, itens: naoLidos.length }, 'Resposta tocou em tema da base nao lido; revisando');

  try {
    const r = await gerar({
      tenantId,
      origem: 'atendimento',
      agentKey: 'atendente',
      conversationId,
      systemPrompt: [
        'Você revisa mensagens de WhatsApp de uma atendente para o cliente. Abaixo estão as informações',
        'OFICIAIS da empresa sobre o assunto da mensagem. Se a mensagem afirma algo diferente delas, ou',
        'algo sobre esse assunto que não está nelas, corrija usando só o que está aqui. O resto (valores,',
        'datas, horários, nomes, tom e os [BALAO]) fica exatamente igual. Não acrescente saudação.',
        'Devolva só a mensagem.',
        '',
        'INFORMAÇÕES OFICIAIS:',
        ...naoLidos.map((i) => `- ${i.tema}: ${i.texto}`)
      ].join('\n'),
      mensagens: [{ papel: 'user', conteudo: texto }],
      temperatura: 0.2,
      maxTokens: 600,
      provedores,
      exigirRespostaCompleta: true
    });
    const nova = String(r.texto ?? '').trim();
    if (nova) return nova;
  } catch (err) {
    log.warn({ err, tenantId }, 'Revisao com a base falhou; segue o rascunho');
  }
  return texto;
}

/**
 * A trava contra PRECO INVENTADO — em codigo, nao depende do modelo obedecer.
 *
 * Todo "R$ ..." da resposta precisa estar entre os valores verificados
 * (catalogo, somas dele, o que as consultas devolveram, base de conhecimento).
 * O que o cliente escreveu NAO conta. Se nao estiver: UMA reescrita curta tirando os
 * valores nao verificados. Se o valor inventado persistir, devolve null — e
 * quem chamou passa a conversa para uma pessoa: preco errado nao sai.
 *
 * @returns {Promise<string|null>}
 */
async function semPrecoInventado({ tenantId, conversationId, texto, permitidos, provedores }) {
  const inventados = precosNaoVerificados(texto, permitidos);
  if (!inventados.length) return texto;

  const reais = (c) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`;
  ver('aviso', `${colorir('sofia', 'Sofia')} citou preço que não existe no catálogo (${inventados.map(reais).join(', ')}): corrigindo`);
  log.warn({ tenantId, conversationId, inventados }, 'Resposta com preco nao verificado; reescrevendo');

  try {
    const r = await gerar({
      tenantId,
      origem: 'atendimento',
      agentKey: 'atendente',
      conversationId,
      systemPrompt:
        'Você revisa mensagens de WhatsApp de uma atendente para o cliente. A mensagem cita valores em R$ que ' +
        `NÃO existem no catálogo da empresa: ${inventados.map(reais).join(', ')}. Reescreva tirando esses ` +
        'valores (e os serviços que só existiam junto deles). Não troque por outro valor: diga que a equipe ' +
        'confirma os serviços e valores. Mantenha o resto, o tom e os [BALAO]. Não acrescente saudação. ' +
        'Devolva só a mensagem.',
      mensagens: [{ papel: 'user', conteudo: texto }],
      temperatura: 0.2,
      maxTokens: 600,
      provedores,
      exigirRespostaCompleta: true
    });
    const nova = String(r.texto ?? '').trim();
    if (nova && !precosNaoVerificados(nova, permitidos).length) return nova;
  } catch (err) {
    log.warn({ err, tenantId }, 'Reescrita sem preco inventado falhou');
  }
  return null;
}

/** Baloes prontos para o WhatsApp: divididos e com a formatacao que ele entende. */
function baloesParaWhatsapp(texto) {
  return dividirEmBaloes(texto).map(formatarParaWhatsapp).filter(Boolean);
}

/**
 * Processa uma mensagem do cliente e devolve o que responder.
 *
 * Nao envia nada: quem envia e o gateway, que sabe falar com o canal.
 * Essa separacao e o que permite testar toda a decisao de atendimento sem
 * WhatsApp nenhum.
 *
 * @param {object} p
 * @param {boolean} [p.simulacao]       nao mexe na fila nem em conversa real (usado pelo simulador)
 * @param {boolean} [p.permitirEscrita] false = a Atena so consulta, nao cria/edita/exclui
 * @param {string}  [p.modoOverride]    forca um modo ('menu'|'hibrido'|'ia') so nesta chamada
 * @param {object[]} [p.provedores]     injetado nos testes, no lugar dos provedores reais
 * @returns {Promise<{ baloes: string[], respondidoPor: string, transferido?: boolean, detalhes: object }>}
 */
export async function responder({
  tenantId,
  conversationId,
  leadId,
  leadNome,
  texto,
  historico = [],
  simulacao = false,
  permitirEscrita = true,
  modoOverride = null,
  menuEstado = null,
  aguardandoHumano = false,
  provedores = null
}) {
  const modo = modoOverride ?? (await config(tenantId, 'modo_atendimento', 'hibrido'));
  const { fuso, nomeEmpresa, fluxo, sofia, atena, catalogoResumo, baseConhecimento, baseDetalhes, baseItens, baseIndice, servicosDoCatalogo } =
    await contextoDaEmpresa(tenantId);
  // Interruptores do perfil DEV: valem por cima do que a empresa configurou.
  const [menuLigado, iaLigada, atenaLigada] = await Promise.all([
    funcaoLigada(tenantId, 'menu_automatico'),
    funcaoLigada(tenantId, 'atendimento_ia'),
    funcaoLigada(tenantId, 'agente_atena')
  ]);

  const detalhes = { modo, ferramentas: [], provedor: null, modelo: null, atena: [] };

  // No simulador nada pode mexer em conversa real: a "fila" e uma conversa de
  // verdade, e o simulador nao tem uma.
  const paraFila = async () => {
    if (!simulacao) await conversas.enviarParaFila(tenantId, conversationId);
  };

  ver('sistema', `modo de atendimento: ${negrito(modo)}`, simulacao ? 'simulador' : undefined);

  // Grava onde o cliente esta (menu ou "a Sofia conduz"). Fica fora do bloco do
  // menu porque o caminho da IA tambem grava. No simulador nao ha conversa: a
  // tela guarda o estado (detalhes.menuEstado) e manda de volta a cada turno.
  const guardar = async (estado) => {
    detalhes.menuEstado = estado;
    if (!simulacao && conversationId) await gravarEstadoMenu(tenantId, conversationId, estado);
  };
  /** Marca que a Sofia assumiu: as proximas respostas do cliente sao para ela. */
  const sofiaConduz = () => guardar({ conduz: 'ia', em: Date.now() });
  const hibridoComMenu = modo === 'hibrido' && menuLigado;

  const menuConta = modo !== 'ia' && menuLigado;
  const estadoAntes = !menuConta ? null : simulacao ? menuEstado : await lerEstadoMenu(tenantId, conversationId);

  // No hibrido, com a Sofia conduzindo, "2", "15" e "bom dia" respondem a ELA:
  // o menu so volta com "menu"/"0"/"voltar"… ou quando o estado expira.
  const pularMenu = hibridoComMenu && iaConduzindo(fluxo, estadoAntes, texto);
  if (pularMenu) ver('menu', 'a Sofia esta conduzindo: a mensagem vai direto para ela');

  // --- Caminho do menu (modos 'menu' e 'hibrido') ---
  if (menuConta && !pularMenu) {
    const r = await passoDoFluxo(fluxo, estadoAntes, texto, {
      listarServicos: () => textoDosServicos(() => catalogo.listarServicos(tenantId, {}))
    });

    if (r) {
      ver('menu', `cliente foi para ${negrito(r.caminho.join(' → '))}`, 'resposta pronta, sem gastar IA');
      // "Passar para a Sofia" nao deixa o estado vazio: vazio, o proximo "2" do
      // cliente (resposta a Sofia) seria lido como opcao do menu principal.
      if (r.entregarParaIa && hibridoComMenu) await sofiaConduz();
      else await guardar(r.estado);
      const base = { ...detalhes, opcao: r.caminho.at(-1), caminho: r.caminho, custoIa: 0 };

      if (r.transferir) {
        await paraFila();
        return {
          baloes: await avisoDeTransferencia(tenantId, r.baloes),
          respondidoPor: 'menu',
          transferido: true,
          detalhes: { ...base, motivoTransferencia: 'Cliente escolheu falar com um atendente no menu.' }
        };
      }
      // "Passar para a Sofia" responde com o aviso e SAI do menu: a proxima
      // mensagem do cliente, em linguagem livre, ja cai na IA (modo hibrido).
      return { baloes: r.baloes, respondidoPor: 'menu', detalhes: { ...base, entregouParaIa: Boolean(r.entregarParaIa) } };
    }

    if (modo === 'menu') {
      // Modo so-menu: linguagem livre nunca aciona IA. Reapresenta o menu em
      // que o cliente esta (nao o principal: ele se perderia).
      const de = reapresentar(fluxo, estadoAntes);
      await guardar(de?.estado ?? null);
      return { baloes: de?.baloes ?? [], respondidoPor: 'menu', detalhes: { ...detalhes, custoIa: 0 } };
    }

    ver('menu', 'nao e uma opcao do menu: passando para a Sofia');
    // Modo hibrido + linguagem livre: cai para a IA logo abaixo.
  }

  // --- Caminho da IA ---

  // A empresa escolheu "so menu" (nunca gastar IA), mas o DEV desligou o
  // menu: sem menu e sem permissao de IA, quem responde e uma pessoa.
  if (modo === 'menu' && !menuLigado) {
    ver('aviso', 'modo so-menu com o menu desligado: conversa vai para a fila humana');
    await paraFila();
    return {
      baloes: await avisoDeTransferencia(tenantId, [await mensagemAoCliente(tenantId, 'fila.ia_desligada')]),
      respondidoPor: 'fallback_humano',
      transferido: true,
      detalhes: { ...detalhes, motivo: 'menu_desligado', motivoTransferencia: 'O menu automatico esta desligado: o cliente veio direto para a fila.' }
    };
  }

  // A Sofia desativada na tela significa "nao quero IA respondendo". Chamar o
  // modelo mesmo assim gastaria dinheiro contra uma decisao explicita, e
  // ficar em silencio deixaria o cliente sem resposta: vai para uma pessoa.
  if (sofia.ativo === false || !iaLigada) {
    ver('aviso', `${colorir('sofia', 'Sofia')} esta desativada: conversa vai para a fila humana`);
    await paraFila();
    return {
      baloes: await avisoDeTransferencia(tenantId, [await mensagemAoCliente(tenantId, 'fila.ia_desligada')]),
      respondidoPor: 'fallback_humano',
      transferido: true,
      detalhes: { ...detalhes, motivo: 'sofia_desativada', motivoTransferencia: 'A IA esta desligada: o cliente veio direto para a fila.' }
    };
  }

  const atenaAtiva = atena.ativo !== false && atenaLigada;
  const contexto = {};

  const ferramentas = ferramentasDaSofia({
    tenantId,
    fuso,
    leadId,
    leadNome,
    nomeEmpresa,
    conversationId,
    atenaAtiva,
    permitirEscrita,
    // Os interruptores DELA (Inteligencia Artificial > Agentes > Sofia). A
    // Atena desligada pelo dono so tira o `consultar_atena` (ver atenaAtiva).
    // Ja o interruptor DEV "Agente de agenda" e trava de plataforma e promete
    // "a Sofia nao mexe na agenda": desligado, sobra so a base de conhecimento.
    permissoes: atenaLigada ? (sofia.ferramentas ?? []) : (sofia.ferramentas ?? []).filter((g) => g === 'informacoes'),
    provedores,
    informacoes: baseDetalhes
  });

  // O roteiro completo de reclamacao (regras 9 e 10) vai no prompt quando
  // QUALQUER sinal aparece — sao baratos e cobrem os buracos um do outro:
  //   - palavras de reclamacao ou irritacao agora ou nas 3 ultimas do cliente
  //     (a reclamacao dura algumas trocas: "foi ontem, com o Carlos");
  //   - a propria Sofia pediu desculpas ha pouco (ela ja percebeu o problema,
  //     mesmo que o cliente nao tenha usado nenhuma palavra da lista);
  //   - a leitura de humor desta conversa marcou "frustrado".
  const recentesDoCliente = historico.filter((m) => m.papel === 'user').slice(-3).map((m) => m.conteudo);
  const recentesDaSofia = historico.filter((m) => m.papel === 'assistant').slice(-2).map((m) => m.conteudo);
  const irritado = pareceIrritado(texto);
  const reclamacao =
    [texto, ...recentesDoCliente].some((t) => pareceReclamacao(t) || pareceIrritado(t)) ||
    recentesDaSofia.some(pediuDesculpas) ||
    (conversationId ? (await humorDaConversa(tenantId, conversationId)) === 'frustrado' : false);

  // O que da base casa com esta mensagem (e com a anterior do cliente, para
  // "e pra crianca?") vai no prompt do turno — escolhido pelo codigo.
  const informacoesRelevantes = itensRelevantes(baseItens, [texto, ...recentesDoCliente.slice(-1)]);
  if (informacoesRelevantes.length) ver('sofia', `${informacoesRelevantes.length} informação(ões) da base ligada(s) a esta mensagem`);

  // O que ela lembra deste cliente de conversas anteriores ('' = cliente novo).
  const memoriaCliente = await memoriaParaPrompt(tenantId, leadId);
  if (memoriaCliente) ver('sofia', 'cliente conhecido: ficha do cliente no prompt');

  ver('sofia', 'lendo a conversa e decidindo a resposta', `Atena ${atenaAtiva ? 'ligada' : 'desligada'}${permitirEscrita ? '' : ' · somente leitura'}`);

  try {
    const r = await conversar({
      tenantId,
      conversationId,
      agentKey: 'atendente',
      systemPrompt: montarSystemPrompt({
        catalogoResumo,
        catalogoVazio: servicosDoCatalogo.length === 0,
        baseConhecimento,
        indiceDetalhes: baseIndice,
        informacoesRelevantes,
        agente: sofia,
        nomeEmpresa,
        fuso,
        leadNome,
        hoje: dataNoFuso(Date.now(), fuso),
        horaAtual: horaNoFuso(Date.now(), fuso),
        atenaAtiva,
        ferramentasDaSofia: ferramentas.map((f) => f.nome),
        irritado,
        reclamacao,
        aguardandoHumano,
        memoriaCliente
      }),
      mensagens: [...historico, { papel: 'user', conteudo: texto }],
      ferramentas,
      contexto,
      temperatura: sofia.temperatura,
      maxTokens: sofia.maxTokens,
      // Consultar, pedir a marcacao a Atena e responder sao tres voltas; a quarta
      // e folga. Laco de repeticao nao consome o teto: para na hora (agente.js).
      maxVoltas: 4,
      provedores,
      // O que sai daqui vai para o WhatsApp do cliente: meia frase, nunca.
      exigirRespostaCompleta: true
    });

    detalhes.ferramentas = r.ferramentasUsadas.map((f) => f.nome);
    detalhes.provedor = r.provedor;
    detalhes.modelo = r.modelo;
    detalhes.latenciaMs = r.latenciaMs;
    detalhes.voltas = r.voltas;
    // O rastro completo do que a Atena fez (pedido, ferramentas, resultados).
    detalhes.atena = contexto.atena ?? [];
    // O que a Sofia consultou direto, sem o modelo da Atena.
    detalhes.consultas = contexto.consultas ?? [];

    // Os unicos valores que a Sofia pode citar neste turno (ver semPrecoInventado).
    // O que o CLIENTE escreveu nao entra: "o corte e R$ 10, ne?" nao pode virar
    // um preco confirmado.
    const permitidos = precosPermitidos(precosDoCatalogo(servicosDoCatalogo), [
      JSON.stringify(contexto.consultas ?? []),
      JSON.stringify(contexto.atena ?? []),
      String(baseConhecimento ?? ''),
      String(baseDetalhes ?? '')
    ]);

    if (contexto.transferirParaHumano?.solicitado) {
      await paraFila();
      const despedida = r.texto?.trim()
        ? await semPrecoInventado({
            tenantId,
            conversationId,
            texto: await semBastidores({ tenantId, conversationId, texto: r.texto, provedores }),
            permitidos,
            provedores
          })
        : null;
      // Despedida com preco inventado: vai o aviso padrao (ja esta transferindo).
      const aviso = despedida ?? (await mensagemAoCliente(tenantId, 'fila.transferencia'));
      return {
        // Mesmo quando a Sofia escreveu a propria despedida: fora do horario,
        // ela tambem prometeria "ja te chamo alguem".
        baloes: await avisoDeTransferencia(tenantId, baloesParaWhatsapp(aviso)),
        respondidoPor: 'ia',
        transferido: true,
        detalhes: {
          ...detalhes,
          motivoTransferencia: contexto.transferirParaHumano.motivo,
          clienteFrustrado: Boolean(contexto.transferirParaHumano.clienteFrustrado)
        }
      };
    }

    /**
     * A Sofia rodou todas as voltas (ou repetiu a mesma consulta) e nao chegou
     * a uma resposta. O texto que sobra e de reserva — "ja te respondo" — uma
     * promessa que ninguem cumpriria. Melhor uma pessoa, avisando o cliente.
     */
    if (r.semResposta) {
      log.warn({ tenantId, conversationId, repetiu: r.repetiu }, 'Sofia nao chegou a uma resposta; transbordando para humano');
      ver('aviso', `${colorir('sofia', 'Sofia')} nao chegou a uma resposta: conversa vai para a fila humana`);
      await paraFila();
      return {
        baloes: await avisoDeTransferencia(tenantId, [await mensagemAoCliente(tenantId, 'fila.ia_falhou')]),
        respondidoPor: 'fallback_humano',
        transferido: true,
        detalhes: { ...detalhes, motivo: 'sem_resposta', motivoTransferencia: 'A IA não conseguiu concluir o pedido do cliente: veja a conversa.' }
      };
    }

    const semBastidor = await semBastidores({ tenantId, conversationId, texto: r.texto, provedores });
    // Leu a base inteira (consultou) ou so o que o codigo colocou no prompt?
    const consultouBase = (contexto.consultas ?? []).some((c) => c.nome === 'consultar_informacoes');
    const naoLidos = itensNaoLidos(semBastidor, baseItens, consultouBase ? baseItens : informacoesRelevantes);
    if (naoLidos.length) detalhes.revisouComBase = naoLidos.length;
    const conferido = await semInformacaoNaoLida({ tenantId, conversationId, texto: semBastidor, naoLidos, provedores });
    const final = await semPrecoInventado({ tenantId, conversationId, texto: conferido, permitidos, provedores });
    if (final === null) {
      // Insistiu num preco que nao existe: essa resposta NAO sai. Uma pessoa
      // responde, sabendo o motivo.
      ver('aviso', `${colorir('sofia', 'Sofia')} insistiu em preço fora do catálogo: conversa vai para a fila humana`);
      await paraFila();
      return {
        baloes: await avisoDeTransferencia(tenantId, [await mensagemAoCliente(tenantId, 'fila.transferencia')]),
        respondidoPor: 'fallback_humano',
        transferido: true,
        detalhes: {
          ...detalhes,
          motivo: 'preco_nao_verificado',
          motivoTransferencia: 'A IA citou um preço que não existe no catálogo; a resposta foi barrada. Confira os valores com o cliente.'
        }
      };
    }
    // A Sofia respondeu: a partir daqui a conversa e dela ate o cliente pedir o
    // menu ou o estado expirar. So no hibrido — no modo 'ia' nao ha menu.
    if (hibridoComMenu) await sofiaConduz();
    return { baloes: baloesParaWhatsapp(final), respondidoPor: 'ia', detalhes };
  } catch (err) {
    /**
     * A IA nao respondeu (cota, provedor fora do ar, nenhuma chave).
     *
     * O sistema antigo devolvia um texto fixo de saudacao fingindo que tinha
     * respondido — o cliente recebia "Ola! Sou a assistente virtual..." no
     * meio de uma negociacao de horario.
     *
     * Aqui assumimos a falha: avisamos que vamos chamar alguem e colocamos a
     * conversa na fila humana. O cliente espera um pouco, mas fala com gente
     * de verdade em vez de receber resposta sem sentido.
     */
    log.error({ err, tenantId, conversationId }, 'IA indisponivel; transbordando para humano');
    ver('erro', `IA indisponivel: conversa vai para a fila humana`, resumir(err.message, 90));

    await paraFila();

    return {
      baloes: await avisoDeTransferencia(tenantId, [await mensagemAoCliente(tenantId, 'fila.ia_falhou')]),
      respondidoPor: 'fallback_humano',
      transferido: true,
      detalhes: { ...detalhes, erro: err.message, motivoTransferencia: 'A IA nao respondeu (fora do ar): o cliente veio para a fila.' }
    };
  }
}

/**
 * Le o humor do cliente, se ja for hora de ler.
 *
 * Roda DEPOIS que o cliente recebeu a resposta, e nunca lanca: humor e
 * informacao de apoio para o atendente, nao pode custar uma resposta.
 *
 * A cada quantas mensagens do cliente relemos e configuravel
 * (`humor_a_cada_mensagens`, padrao 3; zero desliga). Ler a cada mensagem
 * dobraria o numero de chamadas ao modelo para um dado que muda devagar —
 * ninguem passa de satisfeito a frustrado por causa de um "ok".
 *
 * @returns {Promise<{humor: string, resumo: string}|null>}
 */
export async function avaliarHumor({ tenantId, conversationId, leadNome, historico, provedores = null }) {
  try {
    if (!(await funcaoLigada(tenantId, 'leitura_humor'))) return null;
    const aCada = Number(await config(tenantId, 'humor_a_cada_mensagens', 3));
    if (!aCada || aCada < 1) return null;

    const conversa = await conversas.obter(tenantId, conversationId);
    const desdeAUltima = (conversa.totalMensagensCliente ?? 0) - (conversa.humorNaMensagem ?? 0);

    // `humorNaMensagem` nao vem na apresentacao da conversa; quando a leitura
    // nunca rodou, `humorAtualizadoEm` nulo garante a primeira avaliacao.
    if (conversa.humorAtualizadoEm && desdeAUltima < aCada) return null;

    const leitura = await lerHumor({
      tenantId,
      conversationId,
      leadNome,
      historico,
      provedores
    });

    if (!leitura) return null;

    ver('humor', `${negrito(leitura.humor)}${leitura.etapa ? ` · etapa: ${leitura.etapa}` : ''}`, resumir(leitura.resumo, 110));

    await conversas.registrarHumor(tenantId, conversationId, {
      humor: leitura.humor,
      resumo: leitura.resumo,
      numeroDaMensagem: conversa.totalMensagensCliente ?? 0
    });

    // A leitura tambem diz onde a negociacao esta. So avanca o cartao, e so se
    // a Atena tiver permissao para manter o quadro em dia.
    if (leitura.etapa) await avancarEtapa(tenantId, conversationId, leitura.etapa, { origem: 'leitura' });

    return leitura;
  } catch (err) {
    log.warn({ err, tenantId, conversationId }, 'Leitura de humor falhou; atendimento segue normal');
    return null;
  }
}

/**
 * Monta o historico recente no formato que o modelo espera.
 *
 * O tamanho vem da configuracao "Janela de contexto" da empresa. Antes, o
 * valor era gravado pela tela mas NUNCA lido: o codigo usava 8 fixo, entao
 * mexer na opcao nao mudava nada — e a empresa achava que estava
 * economizando tokens.
 */
export async function historicoParaIa(tenantId, conversationId, limite) {
  const janela = limite ?? (await config(tenantId, 'janela_contexto_mensagens', 8));

  // +1: a mensagem que acabou de chegar ja esta gravada e entra na contagem,
  // mas o gateway a retira depois. Sem o +1 a janela "de 4" daria so 3.
  const { mensagens } = await conversas.mensagens(tenantId, conversationId, { limite: Number(janela) + 1 });

  return mensagens
    // Mensagens de sistema (avisos de transferencia) nao sao parte do dialogo.
    .filter((m) => m.autorTipo !== 'sistema')
    .map((m) => ({
      papel: m.direcao === 'entrada' ? 'user' : 'assistant',
      conteudo: m.conteudo
    }));
}

/**
 * Historico ANTERIOR a um lote de mensagens do cliente (o que o gateway usa).
 *
 * `historicoParaIa` + "tirar a ultima" so funciona com uma mensagem por turno.
 * Com mensagens picotadas ("boa tarde" / "queria marcar" / "pra sexta"), as
 * duas primeiras ficavam soltas no historico E de novo dentro do lote — o
 * modelo lia tudo duas vezes. E com a fila de turnos por conversa, mensagens
 * do cliente que chegaram DEPOIS do lote sao do proximo turno: tambem ficam de
 * fora. (`historicoParaIa` nao muda: a Central de IA depende do formato dele.)
 *
 * @param {string[]} idsDoLote  ids das mensagens que formam o texto do turno
 */
export async function historicoAntesDoLote(tenantId, conversationId, idsDoLote = []) {
  const janela = Number(await config(tenantId, 'janela_contexto_mensagens', 8));
  // Folga para o proprio lote e para o que chegou depois dele, que sao descartados.
  const { mensagens } = await conversas.mensagens(tenantId, conversationId, { limite: janela + idsDoLote.length + 10 });

  const doLote = new Set(idsDoLote);
  const primeira = mensagens.findIndex((m) => doLote.has(m.id));
  const semSistema = (m) => m.autorTipo !== 'sistema';

  // Tudo antes da primeira mensagem do lote. (Se o lote nem aparece na janela
  // — nao deveria acontecer —, fica tudo menos ele.)
  const anteriores = (primeira >= 0 ? mensagens.slice(0, primeira) : mensagens.filter((m) => !doLote.has(m.id))).filter(semSistema);

  // Respostas NOSSAS que sairam entre as mensagens do lote (o turno anterior
  // terminando) continuam valendo: sem elas o modelo nao sabe o que ja disse.
  const intercaladas =
    primeira >= 0 ? mensagens.slice(primeira).filter((m) => !doLote.has(m.id) && m.direcao === 'saida' && semSistema(m)) : [];

  return [...anteriores, ...intercaladas].slice(-janela).map((m) => ({
    papel: m.direcao === 'entrada' ? 'user' : 'assistant',
    conteudo: m.conteudo
  }));
}

/**
 * Corta um historico ja montado (o do simulador) no tamanho da janela de contexto.
 * Mantem as mensagens MAIS RECENTES: e o fim da conversa que importa.
 */
export async function historicoLimitado(tenantId, historico) {
  const janela = Number(await config(tenantId, 'janela_contexto_mensagens', 8));
  return historico.slice(-janela);
}

// ============================================================================
// CONFIGURACAO DO ATENDIMENTO
// ============================================================================

export async function obterConfiguracao(tenantId) {
  const [modo, janela, menu] = await Promise.all([
    config(tenantId, 'modo_atendimento', 'hibrido'),
    config(tenantId, 'agrupamento_segundos', 8),
    db.query.menuFlows.findFirst({ where: and(eq(menuFlows.tenantId, tenantId), eq(menuFlows.ativo, true)) })
  ]);

  return {
    modo,
    modosDisponiveis: MODOS,
    agrupamentoSegundos: janela,
    janelaContextoMensagens: await config(tenantId, 'janela_contexto_mensagens', 8),
    // Horario em que a Atena fecha o dia sozinha (se a permissao estiver ligada).
    fechamentoHora: await config(tenantId, 'fechamento_hora', '22:00'),
    // Quando a Sofia volta a ajudar quem esta na fila / numa conversa cujo
    // atendente sumiu. 0 desliga (ver sofiaAjudaNaFila e atendenteSumiu).
    filaEsperaMinutos: Number(await config(tenantId, 'fila_espera_minutos', FILA_ESPERA_MINUTOS_PADRAO)),
    humanoAbandonoHoras: Number(await config(tenantId, 'humano_abandono_horas', HUMANO_ABANDONO_HORAS_PADRAO)),
    // Lembrete de vespera (automacao/rotinas.js). Desligado por padrao: mandar
    // mensagem ao cliente e decisao do dono.
    lembreteAtivo: Boolean(await config(tenantId, 'lembrete_ativo', false)),
    lembreteHora: await config(tenantId, 'lembrete_hora', '18:00'),
    menu: {
      id: menu?.id ?? null,
      nome: menu?.nome ?? 'Menu principal',
      // `padrao`: a empresa ainda nao salvou nenhum fluxo no editor novo (o que
      // aparece e o menu antigo convertido, ou o de fabrica).
      padrao: !menu?.fluxo?.nodes?.length,
      fluxo: fluxoDaEmpresa(menu)
    }
  };
}

export async function salvarConfiguracao(tenantId, dados) {
  const gravar = async (chave, valor) => {
    const existe = await db.query.settings.findFirst({
      where: and(eq(settings.tenantId, tenantId), eq(settings.chave, chave))
    });
    if (existe) {
      await db.update(settings).set({ valor }).where(and(eq(settings.tenantId, tenantId), eq(settings.chave, chave)));
    } else {
      await db.insert(settings).values({ tenantId, chave, valor });
    }
  };

  if (dados.modo !== undefined) await gravar('modo_atendimento', dados.modo);
  if (dados.agrupamentoSegundos !== undefined) await gravar('agrupamento_segundos', dados.agrupamentoSegundos);
  if (dados.janelaContextoMensagens !== undefined) {
    await gravar('janela_contexto_mensagens', dados.janelaContextoMensagens);
  }
  if (dados.fechamentoHora !== undefined) await gravar('fechamento_hora', dados.fechamentoHora);
  if (dados.filaEsperaMinutos !== undefined) await gravar('fila_espera_minutos', dados.filaEsperaMinutos);
  if (dados.humanoAbandonoHoras !== undefined) await gravar('humano_abandono_horas', dados.humanoAbandonoHoras);
  if (dados.lembreteAtivo !== undefined) await gravar('lembrete_ativo', dados.lembreteAtivo);
  if (dados.lembreteHora !== undefined) await gravar('lembrete_hora', dados.lembreteHora);

  return obterConfiguracao(tenantId);
}

/**
 * Salva o fluxo desenhado no editor.
 *
 * A validacao e a MESMA que o editor roda enquanto a pessoa desenha
 * (`fluxo.js`): aqui ela existe para que nada invalido chegue ao banco por
 * outro caminho. Erros voltam todos juntos, cada um apontando o passo.
 */
export async function salvarMenu(tenantId, { fluxo, nome }) {
  const { ID } = await import('../../core/ids.js');

  const { erros } = validarFluxo(fluxo);
  if (erros.length) {
    throw new RegraDeNegocio(`O menu tem ${erros.length === 1 ? 'um problema' : `${erros.length} problemas`}: ${erros[0].mensagem}`, {
      problemas: erros
    });
  }

  const existente = await db.query.menuFlows.findFirst({
    where: and(eq(menuFlows.tenantId, tenantId), eq(menuFlows.ativo, true))
  });

  const campos = {
    nome: nome ?? existente?.nome ?? 'Menu principal',
    mensagemErro: fluxo.config?.mensagemErro ?? '',
    fluxo
  };

  if (existente) {
    await db.update(menuFlows).set(campos).where(eq(menuFlows.id, existente.id));
  } else {
    await db.insert(menuFlows).values({ id: ID.menu(), tenantId, ativo: true, ...campos });
  }

  return obterConfiguracao(tenantId);
}

export { MODOS };


