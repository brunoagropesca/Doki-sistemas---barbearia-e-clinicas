import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { settings } from '../../db/schema/ai.js';
import { NaoEncontrado } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { fecharTodas as fecharNotificacoes } from '../notificacoes/notificacoes.repo.js';
import { cancelarAvisosPendentes } from '../auth/auth.repo.js';

const log = comContexto({ modulo: 'funcoes' });

/**
 * Funcoes matrizes do sistema — os interruptores do perfil DEV.
 *
 * Cada empresa tem o proprio conjunto. Tudo nasce LIGADO: desligar e uma
 * decisao de quem configura a plataforma (vender um plano sem campanhas, tirar
 * a IA de uma clinica que so quer agenda...), nunca da empresa cliente — ela
 * nem ve esta lista.
 *
 * Desligada, a funcao some de verdade, nao so da tela:
 *   - TELAS: saem do menu e as rotas da API respondem 404 (como se nao
 *     existissem), pelo mesmo motivo de o DEV ser invisivel;
 *   - MOTOR: o atendimento automatico pula aquela etapa.
 *
 * Para criar uma funcao nova: acrescente aqui e chame `funcaoLigada` no ponto
 * que ela controla. A pagina DEV e a tela leem esta lista, nao ha outro lugar.
 */
export const FUNCOES = [
  // --- Motor de atendimento ---
  {
    chave: 'atendimento_ia',
    grupo: 'motor',
    titulo: 'Atendimento por IA (Sofia)',
    descricao: 'A Sofia responde os clientes no WhatsApp em linguagem livre.',
    desligada: 'O que o menu não resolve vai direto para a fila humana. A tela "Inteligência Artificial" continua (ela também configura a Atena e os provedores), e as campanhas seguem com IA própria.'
  },
  {
    chave: 'agente_atena',
    grupo: 'motor',
    titulo: 'Agente de agenda (Atena)',
    descricao: 'A Atena consulta horários e marca, remarca e cancela pela conversa.',
    desligada: 'A Sofia continua conversando, mas não mexe na agenda: dúvida de horário vai para um atendente.'
  },
  {
    chave: 'menu_automatico',
    grupo: 'motor',
    titulo: 'Menu automático',
    descricao: 'O cliente navega por opções numeradas antes de falar com a IA ou com uma pessoa.',
    desligada: 'O menu é pulado: toda mensagem vai para a Sofia (ou para a fila, se a IA também estiver desligada).'
  },
  {
    chave: 'transcricao_audio',
    grupo: 'motor',
    titulo: 'Transcrição de áudio',
    descricao: 'Áudios dos clientes viram texto para a IA entender.',
    desligada: 'Áudio de cliente vai direto para a fila humana, sem transcrever. O áudio continua tocando no livechat.'
  },
  {
    chave: 'leitura_humor',
    grupo: 'motor',
    titulo: 'Leitura de humor',
    descricao: 'A IA classifica o humor do cliente e resume em que pé está o atendimento.',
    desligada: 'As conversas deixam de ganhar humor e resumo automáticos. Cliente frustrado só vira alerta se a Sofia marcar.'
  },
  {
    chave: 'notificacoes_encaminhamento',
    grupo: 'motor',
    titulo: 'Notificações de encaminhamento',
    descricao: 'Avisa o atendente quando a IA passa um cliente para ele (urgente se frustrado).',
    desligada: 'A conversa continua indo para a fila, mas ninguém é notificado na tela.'
  },

  // --- Telas do sistema ---
  {
    chave: 'campanhas',
    grupo: 'telas',
    titulo: 'Campanhas',
    descricao: 'Disparos em massa pelo WhatsApp, com público e mensagem gerada por IA.',
    desligada: 'Some do menu e a API de campanhas deixa de responder. Uma campanha enviando é pausada.'
  },
  {
    chave: 'quadro',
    grupo: 'telas',
    titulo: 'Quadro de atendimentos',
    descricao: 'O quadro em colunas com os cartões de cada atendimento.',
    desligada: 'Some do menu e a API do quadro deixa de responder. Agenda e conversas seguem normais.'
  },
  {
    chave: 'avisos_gerencia',
    grupo: 'telas',
    titulo: 'Avisos da gerência',
    descricao: 'O popup piscando que a gerência manda para a tela de um atendente.',
    desligada: 'Some o botão "Mandar aviso" e ninguém recebe mais o popup (os pendentes deixam de aparecer).'
  },
  {
    chave: 'metricas_profissional',
    grupo: 'telas',
    titulo: 'Métricas do profissional',
    descricao: 'O resumo de desempenho no topo da ficha do profissional.',
    desligada: 'A faixa de métricas some da ficha. O histórico de atendimentos continua sendo coletado.'
  }
];

export const GRUPOS = [
  { chave: 'motor', titulo: 'Motor de atendimento', descricao: 'O que acontece sozinho quando o cliente escreve.' },
  { chave: 'telas', titulo: 'Telas e recursos', descricao: 'Áreas e recursos que a equipe usa no sistema.' }
];

const CHAVE_CONFIG = 'dev.funcoes';
const CHAVES = new Set(FUNCOES.map((f) => f.chave));

/**
 * Cache em memoria por empresa. Estas chaves sao lidas a cada mensagem e a
 * cada requisicao das telas desligaveis; ir ao banco toda vez seria desperdicio
 * para um dado que muda uma vez na vida. Quem grava por aqui atualiza na hora;
 * uma mudanca feita por outro processo vale em ate 30s (`VALIDADE_MS`).
 */
const cache = new Map(); // tenantId -> { em, valor }
/** Validade da memoria: uma mudanca feita por outro processo vale em ate 30s. */
const VALIDADE_MS = 30_000;

async function lerDesligadas(tenantId) {
  const guardado = cache.get(tenantId);
  if (guardado && Date.now() - guardado.em < VALIDADE_MS) return guardado.valor;
  const linha = await db.query.settings.findFirst({
    where: and(eq(settings.tenantId, tenantId), eq(settings.chave, CHAVE_CONFIG))
  });
  const valor = linha?.valor && typeof linha.valor === 'object' ? linha.valor : {};
  cache.set(tenantId, { em: Date.now(), valor });
  return valor;
}

/** A funcao esta ligada nesta empresa? Chave desconhecida conta como ligada. */
export async function funcaoLigada(tenantId, chave) {
  const estado = await lerDesligadas(tenantId);
  return estado[chave] !== false;
}

/** `{ chave: true|false }` de todas as funcoes, para a tela esconder o que esta desligado. */
export async function estadoDasFuncoes(tenantId) {
  const estado = await lerDesligadas(tenantId);
  return Object.fromEntries(FUNCOES.map((f) => [f.chave, estado[f.chave] !== false]));
}

/** A lista completa, com textos e estado — o que a pagina DEV mostra. */
export async function listarFuncoes(tenantId) {
  const estado = await estadoDasFuncoes(tenantId);
  return {
    grupos: GRUPOS,
    funcoes: FUNCOES.map((f) => ({ ...f, ligada: estado[f.chave] }))
  };
}

export async function definirFuncao(tenantId, chave, ligada) {
  if (!CHAVES.has(chave)) throw new NaoEncontrado('Funcao');

  const atual = { ...(await lerDesligadas(tenantId)) };
  // So guarda o que esta DESLIGADO: funcao nova nasce ligada sem migrar nada.
  if (ligada) delete atual[chave];
  else atual[chave] = false;

  const existe = await db.query.settings.findFirst({
    where: and(eq(settings.tenantId, tenantId), eq(settings.chave, CHAVE_CONFIG))
  });
  if (existe) {
    await db
      .update(settings)
      .set({ valor: atual })
      .where(and(eq(settings.tenantId, tenantId), eq(settings.chave, CHAVE_CONFIG)));
  } else {
    await db.insert(settings).values({
      tenantId,
      chave: CHAVE_CONFIG,
      valor: atual,
      descricao: 'Funcoes do sistema desligadas pelo perfil DEV'
    });
  }
  cache.set(tenantId, { em: Date.now(), valor: atual });

  // Desligar as notificacoes limpa as que estavam na tela: uma urgente sem
  // "x" ficaria presa para sempre, e religar nao deve ressuscitar alertas velhos.
  if (chave === 'notificacoes_encaminhamento' && !ligada) await fecharNotificacoes(tenantId);
  // Mesmo raciocinio para os avisos: religar nao faz um aviso de semanas atras piscar.
  if (chave === 'avisos_gerencia' && !ligada) await cancelarAvisosPendentes(tenantId);

  log.info({ tenantId, chave, ligada }, 'Funcao do sistema alterada');
  return listarFuncoes(tenantId);
}

/**
 * Gancho de rota: a funcao desligada responde 404, como rota inexistente.
 * Uso, dentro do plugin de rotas do modulo:
 *   app.addHook('onRequest', exigirFuncao('campanhas'))
 * Roda depois da autenticacao (o plugin de auth e global e vem antes).
 */
export function exigirFuncao(chave) {
  return async (req, res) => {
    if (!req.tenantId || !req.routeOptions?.url) return;
    // O DEV passa: ele precisa conferir a tela antes de religar (e a faixa
    // "desligada" que ele ve na tela promete exatamente isso).
    if (req.usuario?.cargo === 'dev') return;
    if (await funcaoLigada(req.tenantId, chave)) return;
    res.code(404).send({ erro: { codigo: 'NAO_ENCONTRADO', mensagem: 'Recurso nao encontrado.' } });
    return res;
  };
}
