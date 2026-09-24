import { z } from 'zod';
import { definirFerramenta } from './registry.js';
import { consultarAtena } from '../atena.js';
import { ferramentasDaAtena } from './atena.tools.js';
import { comContexto } from '../../core/logger.js';
import { colorir, fala, resumir, ver } from '../../core/painel.js';

const log = comContexto({ modulo: 'sofia' });

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
 *                            cliente (leitura; permissoes da Atena valem igual)
 *   consultar_atena        — marcar, remarcar, cancelar: tudo que ESCREVE
 *   transferir_para_humano — passa a conversa para uma pessoa
 *
 * A Sofia continua sem escrever no banco. A separacao que importa ficou:
 * a personalidade calorosa (e a temperatura alta) dela nunca decide sozinha
 * uma marcacao — quem grava e a Atena, com temperatura baixa e travas.
 * O que mudou e que LER nao precisa de um segundo modelo.
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
  gruposAtena = [],
  provedores = null
}) {
  const transferirParaHumano = definirFerramenta({
    nome: 'transferir_para_humano',
    descricao:
      'Passa a conversa para um atendente humano: cliente pediu uma pessoa, você não sabe responder ' +
      'com segurança, ou cliente descontente cujo problema você já entendeu.',
    escrita: true,
    argumentos: z.object({
      motivo: z
        .string()
        .describe('O atendente lê antes de falar com o cliente. Reclamação: o que houve e o que o cliente espera.'),
      cliente_frustrado: z
        .boolean()
        .optional()
        .describe('Cliente descontente ou irritado: gera alerta urgente.')
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

  if (!atenaAtiva) return [transferirParaHumano];

  /**
   * As leituras sao as MESMAS ferramentas da Atena (mesmo codigo, mesmas
   * permissoes por grupo, mesmo aviso ao funil), so que sem o modelo dela no
   * meio. Montadas em modo leitura: nenhuma escrita chega a Sofia por aqui.
   */
  const leituras = ferramentasDaAtena({ tenantId, fuso, leadId, conversationId, permitirEscrita: false, grupos: gruposAtena })
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
      'Pede à Atena (agente de agenda) para MARCAR, REMARCAR ou CANCELAR, ou um dado que suas ' +
      'consultas não trazem. Ela não vê a conversa: escreva o pedido COMPLETO, com serviço(s), ' +
      'profissional, data e hora já combinados. Uma chamada por resposta.',
    escrita: true,
    argumentos: z.object({
      pedido: z
        .string()
        .describe('Ex: "Marcar Corte Degradê com o Carlos na sexta (25/09) às 14:00."')
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

  return [...leituras, consultar, transferirParaHumano];
}
