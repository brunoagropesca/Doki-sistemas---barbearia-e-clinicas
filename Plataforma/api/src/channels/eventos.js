/**
 * Console de conexoes: o "diario de bordo" dos canais.
 *
 * Cada coisa relevante que acontece numa conexao (QR gerado, conectou, caiu,
 * ligacao recusada, mensagem que nao saiu) vira uma linha aqui, e a tela
 * "Console de Conexoes em Tempo Real" apenas le esta lista.
 *
 * Fica em MEMORIA de proposito: e um painel de diagnostico do que esta
 * acontecendo agora, nao um historico. Guardar em banco aumentaria a escrita
 * por causa de um dado que ninguem consulta depois de um reinicio — e o que
 * precisa de rastro permanente (quem desconectou, quem removeu) ja vai pra
 * auditoria. Cada empresa tem seu proprio anel e o anel e limitado, entao
 * nunca cresce sem controle.
 *
 * Regra: NUNCA escrever aqui o conteudo de uma mensagem de cliente, nem um
 * telefone inteiro. O console e visto por gerentes, e o log de uma conexao
 * nao deve virar copia das conversas. Use `mascarar()` no telefone.
 */

import { ver } from '../core/painel.js';
import { anotar } from '../core/diario.js';

const MAX_POR_EMPRESA = 300;

export const NIVEIS = ['info', 'sucesso', 'aviso', 'erro'];

/** Anel de eventos por empresa. */
const porEmpresa = new Map();

/** Numero de ordem global: a tela pede "o que veio depois do ultimo que eu vi". */
let sequencia = 0;

/**
 * Registra um evento.
 *
 * @param {string} tenantId
 * @param {object} e
 * @param {string|null} [e.chave]   qual conexao ('W1'); null para o que vale pra empresa toda
 * @param {'info'|'sucesso'|'aviso'|'erro'} [e.nivel]
 * @param {string} [e.tipo]         'conexao' | 'qr' | 'chamada' | 'mensagem' | 'envio' | 'admin'
 * @param {string} e.mensagem
 */
export function registrarEvento(tenantId, { chave = null, nivel = 'info', tipo = 'conexao', mensagem }) {
  if (!tenantId || !mensagem) return null;

  const evento = {
    id: ++sequencia,
    em: Date.now(),
    chave,
    nivel: NIVEIS.includes(nivel) ? nivel : 'info',
    tipo,
    mensagem: String(mensagem).slice(0, 300)
  };

  let anel = porEmpresa.get(tenantId);
  if (!anel) {
    anel = [];
    porEmpresa.set(tenantId, anel);
  }

  // O mesmo diario de bordo, agora tambem na janela do servidor.
  ver(
    evento.nivel === 'erro' ? 'erro' : evento.nivel === 'aviso' ? 'aviso' : 'whatsapp',
    evento.mensagem,
    evento.chave ?? undefined
  );

  // E no diario permanente (data/logs/conexoes.log): o anel some a cada
  // reinicio, e era justamente o que faltava para investigar uma queda.
  anotar(`${evento.nivel.toUpperCase()} ${tenantId} ${evento.chave ?? '-'} [${evento.tipo}] ${evento.mensagem}`);

  anel.push(evento);
  if (anel.length > MAX_POR_EMPRESA) anel.splice(0, anel.length - MAX_POR_EMPRESA);

  return evento;
}

/**
 * Lista os eventos de uma empresa, do mais antigo para o mais novo.
 *
 * `depoisDe` = 0 devolve os ultimos `limite`; com um numero, so os mais novos
 * que ele — e assim a tela busca apenas o que faltava a cada sondagem.
 */
export function listarEventos(tenantId, { depoisDe = 0, limite = 100, chave } = {}) {
  const anel = porEmpresa.get(tenantId) ?? [];
  const teto = Math.max(1, Math.min(limite, MAX_POR_EMPRESA));

  let lista = chave ? anel.filter((e) => e.chave === chave) : anel;

  if (depoisDe > 0) {
    return lista.filter((e) => e.id > depoisDe).slice(0, teto);
  }
  return lista.slice(-teto);
}

/** Maior id ja gerado — a tela usa como ponto de partida da sondagem. */
export function ultimoIdDeEvento(tenantId) {
  const anel = porEmpresa.get(tenantId);
  return anel?.length ? anel.at(-1).id : 0;
}

/** Zera um anel (uso dos testes). */
export function limparEventos(tenantId) {
  if (tenantId) porEmpresa.delete(tenantId);
  else porEmpresa.clear();
}
