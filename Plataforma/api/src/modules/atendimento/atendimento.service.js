import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { menuFlows, settings } from '../../db/schema/ai.js';
import { tenants } from '../../db/schema/tenants.js';
import { dataNoFuso, diaDaSemana, horaNoFuso, FUSO_PADRAO } from '../../core/datetime.js';
import { NOMES_DIAS } from '../../core/datas-naturais.js';
import { comContexto } from '../../core/logger.js';
import { conversar, dividirEmBaloes } from '../../ai/agente.js';
import { gerar } from '../../ai/cascade.js';
import { formatarParaWhatsapp, pareceIrritado, tirarFrasesDeBastidores, vazaBastidores } from '../../ai/saida.js';
import { TONS } from '../../ai/agentes-padrao.js';
import { ferramentasDaSofia } from '../../ai/tools/sofia.tools.js';
import { lerHumor } from '../../ai/humor.js';
import { avancarEtapa } from '../../automacao/funil.js';
import { atenaPermite } from '../../ai/permissoes.js';
import { resumoDoCatalogo } from '../../ai/tools/catalogo-cache.js';
import * as catalogo from '../catalogo/catalogo.service.js';
import * as conversas from '../conversas/conversas.service.js';
import { obterAgente } from '../ia/ia.service.js';
import { textoDosServicos } from './menu.js';
import { fluxoDaEmpresa, passoDoFluxo, reapresentar, validarFluxo } from './fluxo.js';
import { RegraDeNegocio } from '../../core/errors.js';
import { lerEstadoMenu, gravarEstadoMenu } from '../conversas/conversas.repo.js';
import { colorir, negrito, resumir, ver } from '../../core/painel.js';
import { funcaoLigada } from '../funcoes/funcoes.js';
import { mensagemAoCliente } from '../textos/textos.js';

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
  const [tenant, menu, sofia, atena, catalogoResumo] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) }),
    db.query.menuFlows.findFirst({
      where: and(eq(menuFlows.tenantId, tenantId), eq(menuFlows.ativo, true))
    }),
    obterAgente(tenantId, 'atendente'),
    obterAgente(tenantId, 'atena'),
    // O catalogo verificado vai no prompt da Sofia so quando a Atena pode
    // consultar catalogo: a fonte e a mesma e a empresa controla o acesso.
    atenaPermite(tenantId, 'catalogo').then((ok) => (ok ? resumoDoCatalogo(tenantId) : null))
  ]);

  return {
    fuso: tenant?.fusoHorario || FUSO_PADRAO,
    nomeEmpresa: tenant?.nome ?? 'nossa empresa',
    fluxo: fluxoDaEmpresa(menu),
    sofia,
    atena,
    catalogoResumo
  };
}

/** Monta as instrucoes da Sofia a partir do perfil configurado + contexto vivo. */
function montarSystemPrompt({ agente, nomeEmpresa, fuso, leadNome, hoje, horaAtual, atenaAtiva, catalogoResumo, irritado = false }) {
  const base =
    agente?.systemPrompt?.trim() ||
    `Voce e a atendente virtual de ${nomeEmpresa}. Seja calorosa, direta e objetiva.`;

  const regraDeDados = atenaAtiva
    ? [
        '1. Preços: use o CATALOGO abaixo. Horários livres e agendamentos do cliente: use',
        '   suas consultas (consultar_horarios; consultar_varios_servicos para 2+ serviços na',
        '   mesma visita; consultar_agendamentos_do_cliente). São instantâneas: use à vontade.',
        '   O que suas consultas não trazem: peça à Atena.',
        '2. MARCAR, REMARCAR ou CANCELAR: só pela consultar_atena, com o pedido completo',
        '   (serviço(s), profissional, data e hora exatos que a consulta mostrou e o cliente',
        '   escolheu). Uma chamada por resposta. Só confirme o que ela relatar como FEITO; se',
        '   disser NÃO FEITO ou FALTA, explique ou pergunte. Nunca prometa "já te retorno".',
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
    : [
        '1. A Atena (agente de dados e agenda) está DESATIVADA. Você não tem como consultar',
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
    '   Se o mesmo pedido já deu errado uma vez, transfira.',
    '',
    ...(catalogoResumo ? ['CATALOGO (dados verificados do sistema):', catalogoResumo, ''] : []),
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
  provedores = null
}) {
  const modo = modoOverride ?? (await config(tenantId, 'modo_atendimento', 'hibrido'));
  const { fuso, nomeEmpresa, fluxo, sofia, atena, catalogoResumo } = await contextoDaEmpresa(tenantId);
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

  // --- Caminho do menu (modos 'menu' e 'hibrido') ---
  if (modo !== 'ia' && menuLigado) {
    // Onde o cliente esta no menu. No simulador nao ha conversa: a tela guarda
    // o estado e manda de volta a cada turno.
    const estadoAntes = simulacao ? menuEstado : await lerEstadoMenu(tenantId, conversationId);
    const guardar = async (estado) => {
      detalhes.menuEstado = estado;
      if (!simulacao && conversationId) await gravarEstadoMenu(tenantId, conversationId, estado);
    };

    const r = await passoDoFluxo(fluxo, estadoAntes, texto, {
      listarServicos: () => textoDosServicos(() => catalogo.listarServicos(tenantId, {}))
    });

    if (r) {
      ver('menu', `cliente foi para ${negrito(r.caminho.join(' → '))}`, 'resposta pronta, sem gastar IA');
      await guardar(r.estado);
      const base = { ...detalhes, opcao: r.caminho.at(-1), caminho: r.caminho, custoIa: 0 };

      if (r.transferir) {
        await paraFila();
        return {
          baloes: r.baloes,
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
      baloes: [await mensagemAoCliente(tenantId, 'fila.ia_desligada')],
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
      baloes: [await mensagemAoCliente(tenantId, 'fila.ia_desligada')],
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
    // As consultas diretas da Sofia obedecem as MESMAS permissoes da Atena.
    gruposAtena: atena.ferramentas ?? [],
    provedores
  });

  ver('sofia', 'lendo a conversa e decidindo a resposta', `Atena ${atenaAtiva ? 'ligada' : 'desligada'}${permitirEscrita ? '' : ' · somente leitura'}`);

  try {
    const r = await conversar({
      tenantId,
      conversationId,
      agentKey: 'atendente',
      systemPrompt: montarSystemPrompt({
        catalogoResumo,
        agente: sofia,
        nomeEmpresa,
        fuso,
        leadNome,
        hoje: dataNoFuso(Date.now(), fuso),
        horaAtual: horaNoFuso(Date.now(), fuso),
        atenaAtiva,
        irritado: pareceIrritado(texto)
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

    if (contexto.transferirParaHumano?.solicitado) {
      await paraFila();
      const aviso = r.texto?.trim()
        ? await semBastidores({ tenantId, conversationId, texto: r.texto, provedores })
        : await mensagemAoCliente(tenantId, 'fila.transferencia');
      return {
        baloes: baloesParaWhatsapp(aviso),
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
        baloes: [await mensagemAoCliente(tenantId, 'fila.ia_falhou')],
        respondidoPor: 'fallback_humano',
        transferido: true,
        detalhes: { ...detalhes, motivo: 'sem_resposta', motivoTransferencia: 'A IA não conseguiu concluir o pedido do cliente: veja a conversa.' }
      };
    }

    const final = await semBastidores({ tenantId, conversationId, texto: r.texto, provedores });
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
      baloes: [await mensagemAoCliente(tenantId, 'fila.ia_falhou')],
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


