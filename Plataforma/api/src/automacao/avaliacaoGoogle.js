import { comContexto } from '../core/logger.js';
import { gerar } from '../ai/cascade.js';
import { obterAgente } from '../modules/ia/ia.service.js';
import { obterAdaptador } from '../channels/gateway.js';
import { assinar, nomeDeAssinatura, obterConfiguracao as configDaEquipe } from '../modules/equipe/equipe.config.js';
import * as repo from '../modules/conversas/conversas.repo.js';
import { linkValido } from '../core/links.js';

const log = comContexto({ modulo: 'avaliacao-google' });

/**
 * Pedido de avaliacao no Google ao finalizar o atendimento (funcao da Sofia).
 *
 * Dois baloes, nesta ordem:
 *   1. o agradecimento com o pedido — escrito pela IA a partir da conversa,
 *      tendo a mensagem configurada como base (o "jeito da casa");
 *   2. so o link, sozinho: no WhatsApp um link num balao proprio vira
 *      cartao clicavel, e o cliente nao precisa garimpar no meio do texto.
 *
 * Cliente FRUSTRADO nao recebe (humor lido pela Sofia durante a conversa):
 * pedir estrela a quem saiu irritado e convite para a nota 1 — e para piorar
 * o que ja foi ruim.
 *
 * Roda em segundo plano depois do "Finalizar" e nunca lanca: falhar aqui so
 * significa nao ter pedido a avaliacao, nunca travar o encerramento.
 */

export const MENSAGEM_PADRAO =
  'Obrigado pela preferência! Se puder, deixe sua avaliação no Google — leva 1 minutinho e ajuda muito a gente a crescer.';

const LIMITE_BALAO = 500;

/** A configuracao gravada na Sofia, com os padroes. */
export function configDaAvaliacao(sofia) {
  const c = sofia?.config?.avaliacaoGoogle ?? {};
  return {
    ativo: Boolean(c.ativo),
    link: String(c.link ?? '').trim(),
    mensagem: String(c.mensagem ?? '').trim() || MENSAGEM_PADRAO
  };
}

const INSTRUCOES = [
  'Voce escreve UMA mensagem curta de WhatsApp para o cliente, logo depois do fim do atendimento,',
  'agradecendo e pedindo que ele deixe uma avaliacao no Google.',
  'Use a MENSAGEM BASE como referencia de conteudo e tom, adaptando ao que aconteceu na conversa',
  '(o servico, o nome do cliente, algo que ele disse) — sem inventar nada que nao esteja nela.',
  'Regras: portugues do Brasil, no maximo 2 frases, no maximo 1 emoji, sem markdown,',
  'NAO coloque link nem endereco (o link vai em outra mensagem, logo depois),',
  'nao se apresente e nao ofereca mais nada. Devolva SOMENTE o texto da mensagem.'
].join('\n');

/** O primeiro balao. Sem IA (ou se ela falhar), vai a mensagem base como esta. */
async function escreverAgradecimento({ tenantId, conversationId, leadNome, sofia, base, provedores }) {
  try {
    const recentes = await repo.listarMensagens(tenantId, conversationId, { limite: 20 });
    const dialogo = recentes
      .map((r) => r.mensagem)
      .reverse()
      .filter((m) => m.autorTipo !== 'sistema' && m.conteudo?.trim())
      .map((m) => `${m.direcao === 'entrada' ? 'CLIENTE' : 'ATENDIMENTO'}: ${m.conteudo.trim().slice(0, 300)}`)
      .join('\n');

    const persona = sofia?.systemPrompt ? `\n\nQuem voce e (personalidade):\n${sofia.systemPrompt.slice(0, 1500)}` : '';
    const r = await gerar({
      tenantId,
      origem: 'avaliacao',
      conversationId,
      systemPrompt: INSTRUCOES + persona,
      mensagens: [
        {
          papel: 'user',
          conteudo: `Cliente: ${leadNome || '(sem nome)'}\n\nMENSAGEM BASE:\n${base}\n\nConversa:\n${dialogo || '(sem mensagens)'}\n\nEscreva a mensagem.`
        }
      ],
      temperatura: 0.6,
      maxTokens: 160,
      timeoutMs: 10_000,
      provedores
    });

    // Link que escapou da regra sai do texto: ele tem o balao dele.
    const texto = String(r?.texto ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .trim();
    if (texto) return texto.slice(0, LIMITE_BALAO);
  } catch (err) {
    log.warn({ err, tenantId, conversationId }, 'IA nao escreveu o pedido de avaliacao; vai a mensagem base');
  }
  return base.slice(0, LIMITE_BALAO);
}

/**
 * Decide e envia. Devolve o que aconteceu (os testes e o log leem):
 * { enviado: true } ou { enviado: false, motivo }.
 */
export async function pedirAvaliacao(tenantId, conversationId, { provedores = null } = {}) {
  const sofia = await obterAgente(tenantId, 'atendente');
  const cfg = configDaAvaliacao(sofia);
  if (!cfg.ativo) return { enviado: false, motivo: 'desligada' };
  if (!linkValido(cfg.link)) return { enviado: false, motivo: 'sem_link' };

  const linha = await repo.buscarPorId(tenantId, conversationId);
  if (!linha) return { enviado: false, motivo: 'sem_conversa' };
  const { conversa, leadNome, leadTelefone } = linha;

  if (conversa.humor === 'frustrado') {
    log.info({ tenantId, conversationId }, 'Cliente frustrado: pedido de avaliacao nao enviado');
    return { enviado: false, motivo: 'frustrado' };
  }
  // Conversa reaberta e finalizada de novo: o cliente ja recebeu o pedido.
  const jaPedido = (await repo.listarMensagens(tenantId, conversationId, { limite: 60 })).some(
    (r) => r.mensagem.metadados?.avaliacaoGoogle
  );
  if (jaPedido) return { enviado: false, motivo: 'ja_pedido' };

  const adaptador = obterAdaptador(conversa.canal);
  const chave = linha.canalChave ?? (await repo.chaveDaUltimaEntrada(tenantId, conversationId));
  // Simulador e canais sem envio: nao ha para onde mandar.
  if (!adaptador?.enviar || !leadTelefone || !chave) return { enviado: false, motivo: 'sem_canal' };

  const agradecimento = await escreverAgradecimento({
    tenantId,
    conversationId,
    leadNome,
    sofia,
    base: cfg.mensagem,
    provedores
  });

  // Mesma assinatura das respostas da Sofia (Equipe > Atendentes > Privacidade).
  let assinatura = null;
  try {
    if ((await configDaEquipe(tenantId)).assinaturaSofia) assinatura = nomeDeAssinatura(sofia?.nome) || 'Sofia';
  } catch {
    // Sem a configuracao, sai sem assinatura.
  }

  const baloes = [agradecimento, cfg.link];
  for (const [i, balao] of baloes.entries()) {
    let erroEnvio = null;
    let externalId = null;
    try {
      const texto = i === 0 && assinatura ? assinar(assinatura, balao) : balao;
      const r = await adaptador.enviar({ tenantId, instanciaChave: chave, destino: leadTelefone, texto });
      externalId = r?.idExterno ?? null;
    } catch (err) {
      erroEnvio = String(err?.message ?? err).slice(0, 300);
      log.warn({ err, tenantId, conversationId }, 'Falha ao enviar o pedido de avaliacao');
    }
    // Gravado mesmo se falhou: o atendente ve na conversa o que tentou sair.
    await repo.registrarMensagem(tenantId, conversationId, {
      direcao: 'saida',
      autorTipo: 'ia',
      tipo: 'texto',
      conteudo: balao,
      externalId,
      metadados: { avaliacaoGoogle: true, balao: i + 1, totalBaloes: baloes.length },
      erroEnvio,
      entregueEm: erroEnvio ? null : new Date()
    });
    if (erroEnvio) return { enviado: false, motivo: 'falha_envio', erro: erroEnvio };
    // Pausa curta entre os baloes, como nas respostas da Sofia.
    if (i < baloes.length - 1) await new Promise((r) => setTimeout(r, 700));
  }

  log.info({ tenantId, conversationId }, 'Pedido de avaliacao no Google enviado');
  return { enviado: true };
}

/** Pedidos em andamento (para os testes esperarem). */
const emAndamento = new Set();

/** Dispara sem esperar. Nunca lanca. */
export function agendarPedidoDeAvaliacao(tenantId, conversationId, opcoes = {}) {
  const trabalho = pedirAvaliacao(tenantId, conversationId, opcoes).catch((err) => {
    log.warn({ err, tenantId, conversationId }, 'Pedido de avaliacao falhou');
    return { enviado: false, motivo: 'erro' };
  });
  emAndamento.add(trabalho);
  trabalho.finally(() => emAndamento.delete(trabalho));
  return trabalho;
}

export function aguardarAvaliacoes() {
  return Promise.all([...emAndamento]);
}
