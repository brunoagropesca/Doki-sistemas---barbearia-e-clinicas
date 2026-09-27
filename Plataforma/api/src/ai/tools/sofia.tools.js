import { z } from 'zod';
import { definirFerramenta } from './registry.js';
import { consultarAtena } from '../atena.js';
import { ferramentasDaAtena } from './atena.tools.js';
import { comContexto } from '../../core/logger.js';
import { colorir, fala, resumir, ver } from '../../core/painel.js';
import { interpretarData } from '../../core/datas-naturais.js';
import { dataNoFuso } from '../../core/datetime.js';
import { normalizar, resolverServico } from './catalogo-cache.js';
import { gravarOfertasHorario, lerOfertasHorario } from '../../modules/conversas/conversas.repo.js';
import { CHAVES_GRUPOS_SOFIA, GRUPOS_SOFIA } from '../agentes-padrao.js';

const log = comContexto({ modulo: 'sofia' });

// ============================================================================
// OFERTAS — a trava que antes vinha da Atena
// ============================================================================

/**
 * Os horarios que as consultas da Sofia MOSTRARAM nesta conversa.
 *
 * Marcar passava pela Atena (outro modelo) so para ter uma segunda checagem.
 * Agora a checagem e codigo: a Sofia so consegue reservar um horario que o
 * proprio sistema ofereceu nesta conversa — nao ha como ela "inventar" um
 * horario, nem ser convencida pelo cliente a marcar algo que nao foi
 * consultado. Validade de 2 h (depois disso, consulta de novo: e seguro, so
 * custa uma volta).
 *
 * Ficam na CONVERSA (banco): reiniciar o servidor nao apaga a trava. Sem
 * conversa (o simulador), ficam em memoria por cliente.
 */
export const VALIDADE_OFERTA_MS = 2 * 3_600_000;
const MAX_OFERTAS = 200;
const ofertasSemConversa = new Map();

/** "9h", "9:00", "14h30" -> "09:00" / "14:30". Outra coisa volta como veio (e nao casa). */
function horaCanonica(hora) {
  const m = String(hora ?? '').trim().match(/^(\d{1,2})(?:[:h](\d{2})?)?h?$/i);
  return m ? `${m[1].padStart(2, '0')}:${m[2] ?? '00'}` : String(hora ?? '').trim();
}

/**
 * Tira as ofertas de um resultado de consulta. Nos formatos de
 * `consultar_horarios` (horariosLivres, porProfissional, proximaDataComVaga
 * "HH:MM Nome") e `consultar_varios_servicos` (opcoes, proximaDataComVaga.opcoes).
 */
function ofertasDoResultado(nome, args, r) {
  const lista = [];
  if (!r || r.erro) return lista;
  if (nome === 'consultar_horarios') {
    const servicos = [r.servico];
    if (r.profissional) for (const hora of r.horariosLivres ?? []) lista.push({ servicos, profissional: r.profissional, data: r.data, hora });
    for (const p of r.porProfissional ?? []) for (const hora of p.horariosLivres ?? []) lista.push({ servicos, profissional: p.profissional, data: r.data, hora });
    const px = r.proximaDataComVaga;
    if (px?.data) {
      for (const h of px.horarios ?? []) {
        const [hora, ...prof] = h.split(' ');
        lista.push({ servicos, profissional: prof.join(' ') || null, data: px.data, hora });
      }
    }
  }
  if (nome === 'consultar_varios_servicos') {
    // O profissional PEDIDO na consulta monta as mesmas etapas na reserva.
    const profissional = args?.profissional ?? null;
    for (const o of r.opcoes ?? []) lista.push({ servicos: r.servicos, profissional, data: r.data, hora: o.inicio });
    const px = r.proximaDataComVaga;
    for (const o of px?.opcoes ?? []) lista.push({ servicos: r.servicos, profissional, data: px.data, hora: o.inicio });
  }
  return lista.filter((o) => o.data && o.hora);
}

async function lerOfertas(tenantId, conversationId, chaveMemoria) {
  const todas = conversationId ? await lerOfertasHorario(tenantId, conversationId) : (ofertasSemConversa.get(chaveMemoria) ?? []);
  const agora = Date.now();
  return todas.filter((o) => agora - o.em < VALIDADE_OFERTA_MS);
}

async function guardarOfertas(tenantId, conversationId, chaveMemoria, novas) {
  if (!novas.length) return;
  const agora = Date.now();
  const lista = [...(await lerOfertas(tenantId, conversationId, chaveMemoria)), ...novas.map((o) => ({ ...o, em: agora }))].slice(-MAX_OFERTAS);
  if (conversationId) await gravarOfertasHorario(tenantId, conversationId, lista);
  else ofertasSemConversa.set(chaveMemoria, lista);
}

/**
 * Consultas que a Sofia faz DIRETO, sem passar pelo modelo da Atena.
 *
 * Sao so leitura e a resposta ja sai pronta do codigo (horarios calculados,
 * datas convertidas, dia por extenso). Mandar isso pela Atena custava 2 a 4
 * chamadas de modelo (~2 mil tokens cada) para ela chamar a MESMA ferramenta
 * e reescrever o resultado — o maior custo por mensagem do sistema.
 */
export const LEITURAS_DIRETAS = ['consultar_horarios', 'consultar_varios_servicos', 'consultar_agendamentos_do_cliente'];

/**
 * Ferramentas da Sofia.
 *
 *   consultas diretas      — horarios, vagas em sequencia, agendamentos do
 *                            cliente (leitura)
 *
 * Cada uma obedece a um interruptor DA SOFIA (GRUPOS_SOFIA em
 * agentes-padrao.js); so `transferir_para_humano` e fixa. Os interruptores da
 * Atena valem para o que a ATENA faz, e Atena desligada so tira da Sofia o
 * `consultar_atena`.
 *
 *   reservar_horario       — MARCA, mas so um horario que as consultas desta
 *                            conversa ofereceram (as OFERTAS)
 *   consultar_atena        — remarcar, cancelar e o que as consultas nao trazem
 *   consultar_informacoes  — regras da casa, perguntas frequentes e extras da
 *                            base de conhecimento (so quando ha algo cadastrado)
 *   transferir_para_humano — passa a conversa para uma pessoa
 *
 * A personalidade calorosa (e a temperatura alta) da Sofia continua sem
 * decidir sozinha o QUE marcar: ela so reserva o que o sistema mostrou, pela
 * mesma ferramenta e com as mesmas travas da Atena. Ler e marcar nao precisam
 * de um segundo modelo; remarcar e cancelar (que mexem no que ja existe)
 * continuam passando pela Atena.
 */
export function ferramentasDaSofia({
  tenantId,
  fuso,
  leadId,
  leadNome,
  nomeEmpresa,
  conversationId,
  atenaAtiva = true,
  permitirEscrita = true,
  // Os interruptores DA SOFIA (GRUPOS_SOFIA). Cada ferramenta abaixo so entra
  // se o grupo dela estiver ligado — independente dos interruptores da Atena.
  permissoes = CHAVES_GRUPOS_SOFIA,
  provedores = null,
  informacoes = ''
}) {
  const pode = (grupo) => permissoes.includes(grupo);
  /** Os grupos da Atena que montam as ferramentas da Sofia que estao ligadas. */
  const gruposDaAtena = (...chaves) => chaves.filter(pode).map((c) => GRUPOS_SOFIA[c].grupoAtena);
  const transferirParaHumano = definirFerramenta({
    nome: 'transferir_para_humano',
    descricao: 'Passa para um atendente: cliente pediu uma pessoa, você não sabe responder, ou reclamação já entendida.',
    escrita: true,
    argumentos: z.object({
      motivo: z.string().describe('O atendente lê antes de falar: o que houve e o que o cliente quer.'),
      cliente_frustrado: z.boolean().optional().describe('Cliente descontente: alerta urgente.')
    }),
    async executar({ motivo, cliente_frustrado: clienteFrustrado = false }, contexto) {
      // A transferencia em si e feita pelo orquestrador, que tem a conversa
      // em maos. Aqui so sinalizamos a intencao.
      contexto.transferirParaHumano = { solicitado: true, motivo, clienteFrustrado };
      ver(
        'sofia',
        clienteFrustrado ? 'passando cliente FRUSTRADO a uma pessoa (alerta urgente)' : 'pediu para passar a conversa a uma pessoa',
        `motivo: ${resumir(motivo, 100)}`
      );
      return { sucesso: true, mensagem: 'Transferindo para um atendente.' };
    }
  });

  /**
   * Regras da casa, perguntas frequentes e outras informacoes da empresa.
   *
   * Iam no prompt em TODA mensagem (eram metade dele) e so importam quando o
   * cliente pergunta. Agora a Sofia le quando precisa: a resposta sai do
   * codigo, sem modelo no meio. Nao depende da Atena (nao e agenda).
   */
  const consultarInformacoes = pode('informacoes') && String(informacoes ?? '').trim()
    ? definirFerramenta({
        nome: 'consultar_informacoes',
        descricao: 'Regras da casa, perguntas frequentes e outras informações da empresa (Wi-Fi, produtos, crianças...).',
        // Objeto sem nenhum campo o Gemini recusa; o assunto so vai para o registro.
        argumentos: z.object({ assunto: z.string().optional().describe('O que o cliente perguntou.') }),
        async executar({ assunto } = {}, contexto) {
          // Nas consultas do turno: os bastidores mostram, e um valor em R$ que
          // venha daqui passa na trava de preco (e informacao oficial).
          const registro = { nome: 'consultar_informacoes', argumentos: { assunto }, resultado: { informacoes } };
          (contexto.consultas ??= []).push(registro);
          ver('sofia', 'consultou as informacoes da empresa', assunto ? resumir(assunto, 80) : undefined);
          return registro.resultado;
        }
      })
    : null;
  const daEmpresa = [consultarInformacoes, transferirParaHumano].filter(Boolean);

  const chaveMemoria = `${tenantId}:lead:${leadId}`;

  /**
   * As leituras sao as MESMAS ferramentas da Atena (mesmo codigo, mesmo aviso
   * ao funil), so que sem o modelo dela no meio — e por isso NAO dependem de a
   * Atena estar ligada. Montadas em modo leitura e so com os grupos que a
   * Sofia tem ligados: nenhuma escrita chega a ela por aqui.
   */
  const leituras = ferramentasDaAtena({
    tenantId,
    fuso,
    leadId,
    conversationId,
    permitirEscrita: false,
    grupos: gruposDaAtena('horarios', 'agendamentos')
  })
    .filter((f) => LEITURAS_DIRETAS.includes(f.nome))
    .map((f) => ({
      ...f,
      async executar(args, contexto) {
        // Os bastidores (simulador, auditoria) mostram cada consulta direta,
        // como mostram as da Atena.
        const registro = { nome: f.nome, argumentos: args };
        (contexto.consultas ??= []).push(registro);
        try {
          registro.resultado = await f.executar(args, contexto);
          // O que a consulta MOSTROU vira oferta: so isso pode ser reservado.
          // Tambem no contexto do turno: duas consultas em paralelo nao podem
          // apagar uma a gravacao da outra antes da reserva.
          const novas = ofertasDoResultado(f.nome, args, registro.resultado);
          (contexto.ofertasDoTurno ??= []).push(...novas.map((o) => ({ ...o, em: Date.now() })));
          await guardarOfertas(tenantId, conversationId, chaveMemoria, novas).catch((err) => {
            log.warn({ err, tenantId, conversationId }, 'Nao foi possivel guardar as ofertas; a reserva usa as do turno');
          });
          return registro.resultado;
        } catch (err) {
          registro.resultado = { erro: err.message };
          throw err;
        }
      }
    }));

  const consultar = definirFerramenta({
    nome: 'consultar_atena',
    descricao:
      'REMARCAR ou CANCELAR (para marcar: reservar_horario), ou dado que suas consultas não trazem. ' +
      'A Atena não vê a conversa: pedido completo (serviço, profissional, data, hora).',
    escrita: true,
    argumentos: z.object({
      pedido: z.string().describe('Ex: "Remarcar Corte de sexta 14:00 para sábado 10:00, com o Carlos."')
    }),
    async executar({ pedido }, contexto) {
      /**
       * O MESMO pedido duas vezes no mesmo turno roda UMA vez so.
       *
       * O modelo da Sofia as vezes dispara a mesma chamada em paralelo. Sem esta
       * guarda, "agende as 10:30" executava duas vezes: a primeira marcava o
       * horario, a segunda o encontrava ocupado (por causa da primeira) e
       * respondia "ja foi reservado" — e a Sofia repassava isso ao cliente que
       * tinha acabado de conseguir o horario.
       *
       * A segunda chamada recebe a MESMA resposta da primeira (a promessa em
       * andamento), entao o que a Sofia le e sempre o resultado real.
       */
      const chave = String(pedido).toLowerCase().replace(/\s+/g, ' ').trim();
      const emAndamento = (contexto.atenaPedidos ??= new Map());
      if (emAndamento.has(chave)) return emAndamento.get(chave);

      const execucao = (async () => {
      try {
        // Painel: a Sofia pergunta, a Atena responde. Os dois lados da conversa.
        fala('sofia', 'atena', pedido);

        const { resposta, trace } = await consultarAtena({
          tenantId,
          pedido,
          leadId,
          leadNome,
          fuso,
          nomeEmpresa,
          conversationId,
          permitirEscrita,
          provedores
        });

        // O rastro completo (ferramentas, argumentos, resultados) fica no
        // contexto para os "bastidores" do simulador e para auditoria. NAO
        // volta para a Sofia: ela so precisa da resposta, e devolver o rastro
        // gastaria tokens e a tentaria a repassar detalhes internos ao cliente.
        (contexto.atena ??= []).push(trace);

        fala(
          'atena',
          'sofia',
          resposta,
          [
            trace.escritas ? `${trace.escritas} alteracao(oes) na agenda` : null,
            trace.provedor ? `${trace.provedor}/${String(trace.modelo).replace(/^models\//, '')}` : null,
            trace.latenciaMs ? `${trace.latenciaMs}ms` : null
          ]
            .filter(Boolean)
            .join(' · ')
        );

        return { resposta };
      } catch (err) {
        ver('erro', `${colorir('atena', 'Atena')} nao conseguiu responder a ${colorir('sofia', 'Sofia')}`, resumir(err.message, 100));
        log.error({ err, tenantId }, 'Atena nao conseguiu responder');
        (contexto.atena ??= []).push({ pedido, erro: err.message });

        // Mensagem escrita para a Sofia agir com prudencia: sem os dados
        // reais, ela nao pode chutar preco nem horario.
        return {
          erro:
            'A Atena não conseguiu responder agora. NÃO informe preços nem horários ao cliente. ' +
            'Diga que vai verificar e ofereça chamar um atendente.'
        };
      }
      })();

      emAndamento.set(chave, execucao);
      return execucao;
    }
  });

  /**
   * RESERVAR — a escrita que mais acontece, agora SEM o modelo da Atena no meio.
   *
   * Antes, marcar 1 servico custava 4 chamadas da Sofia + 2 da Atena (que nem
   * via a conversa). Aqui a Sofia executa a MESMA ferramenta da Atena — mesmo
   * codigo, mesmas permissoes por grupo, mesmo escopo no cliente, mesmo teto de
   * escritas, conflito checado na transacao. O que a Atena dava de seguranca a
   * mais ("so marca o que foi consultado") virou regra de codigo: o horario
   * precisa estar nas OFERTAS desta conversa. Remarcar e cancelar continuam
   * pela Atena (consultar_atena).
   */
  const escritas = ferramentasDaAtena({ tenantId, fuso, leadId, conversationId, permitirEscrita, grupos: gruposDaAtena('reservar') });
  const criarUm = escritas.find((f) => f.nome === 'criar_agendamento');
  const criarVarios = escritas.find((f) => f.nome === 'agendar_varios_servicos');

  const reservar = definirFerramenta({
    nome: 'reservar_horario',
    descricao: 'Marca o horário que o cliente escolheu, exatamente como sua consulta mostrou. Horário não consultado é recusado.',
    escrita: true,
    argumentos: z.object({
      servicos: z.array(z.string()).min(1).describe('Na ordem da consulta.'),
      profissional: z.string().optional(),
      data: z.string().describe('A data da consulta.'),
      hora: z.string().describe('HH:MM da consulta.')
    }),
    async executar({ servicos, profissional, data, hora }, contexto) {
      const registro = { nome: 'reservar_horario', argumentos: { servicos, profissional, data, hora } };
      (contexto.consultas ??= []).push(registro);
      const devolver = (resultado) => {
        registro.resultado = resultado;
        return resultado;
      };

      // Modo seguro (simulador sem escrita): nada e gravado, e a Sofia sabe.
      if (!permitirEscrita) {
        return devolver({ erro: 'Modo de simulação: nada é gravado. Diga que o horário está disponível, sem confirmar a marcação.' });
      }

      const quando = interpretarData(data, { hoje: dataNoFuso(Date.now(), fuso) });
      if (!quando || quando.erro) return devolver({ erro: quando?.erro ?? 'Data não entendida. Use a data que a consulta mostrou.' });

      // Nome do servico como o catalogo conhece (a consulta devolveu o nome oficial).
      let nomes;
      try {
        nomes = await Promise.all(servicos.map(async (s) => normalizar((await resolverServico(tenantId, s)).nome)));
      } catch (err) {
        return devolver({ erro: err.message });
      }
      const alvoHora = horaCanonica(hora);
      const ofertas = [...(contexto.ofertasDoTurno ?? []), ...(await lerOfertas(tenantId, conversationId, chaveMemoria))];
      const agora = Date.now();
      const oferta = ofertas.find(
        (o) =>
          agora - o.em < VALIDADE_OFERTA_MS &&
          o.data === quando.data &&
          horaCanonica(o.hora) === alvoHora &&
          o.servicos.map(normalizar).join('|') === nomes.join('|') &&
          (!o.profissional || !profissional || normalizar(o.profissional).includes(normalizar(profissional)))
      );
      if (!oferta) {
        return devolver({ erro: 'Este horário não veio de uma consulta desta conversa. Consulte, ofereça ao cliente e só então reserve.' });
      }

      const ferramenta = servicos.length > 1 ? criarVarios : criarUm;
      if (!ferramenta) {
        return devolver({ erro: 'Marcar horário está desligado nas permissões da empresa. Ofereça chamar um atendente.' });
      }

      ver('sofia', `reservando direto: ${resumir(`${servicos.join(' + ')} · ${quando.dia} às ${alvoHora}`, 90)}`, 'horário que a consulta ofereceu');
      try {
        // A OFERTA manda (profissional e dados como o sistema mostrou), nao o texto do modelo.
        const resultado =
          servicos.length > 1
            ? await ferramenta.executar({ servicos: oferta.servicos, data: quando.data, hora: alvoHora, profissional: oferta.profissional ?? undefined }, contexto)
            : await ferramenta.executar({ servicoId: oferta.servicos[0], profissionalId: oferta.profissional ?? profissional, data: quando.data, hora: alvoHora }, contexto);
        return devolver(resultado);
      } catch (err) {
        // Conflito na transacao, teto de escritas, cliente nao identificado...:
        // a mensagem vai para a Sofia explicar, nunca um "marcado" falso.
        return devolver({ erro: err.message });
      }
    }
  });

  return [
    ...leituras,
    // Reservar so faz sentido com a consulta de horarios: so marca o que ela ofereceu.
    ...(pode('reservar') && pode('horarios') ? [reservar] : []),
    // Pedir a Atena precisa de DUAS coisas: o interruptor da Sofia e a Atena ligada.
    ...(pode('atena') && atenaAtiva ? [consultar] : []),
    ...daEmpresa
  ];
}
