import { TOM_STATUS } from '../../componentes/ui.jsx';

/**
 * Funcoes pequenas de formatacao da Central de Conexoes.
 *
 * Ficam num arquivo so (e sem JSX) para as telas nao repetirem a mesma conta:
 * telefone, hora e o texto do estado de cada sessao.
 */

/**
 * Deixa o numero legivel: 5511999998888 vira "+55 (11) 99999-8888".
 *
 * O servidor guarda so os digitos. Numero que nao e brasileiro nao tem regra
 * de mascara conhecida aqui, entao sai apenas com o "+" na frente — melhor do
 * que inventar parenteses no lugar errado.
 */
export function formatarTelefone(bruto) {
  const digitos = String(bruto ?? '').replace(/\D/g, '');
  if (!digitos) return '';

  // 55 + DDD (2 digitos) + numero (8 digitos fixo ou 9 celular)
  const br = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digitos);
  if (br) return `+55 (${br[1]}) ${br[2]}-${br[3]}`;

  return `+${digitos}`;
}

/** Hora do console: 14:03:22 (sempre 24h, mesmo que o navegador prefira AM/PM). */
export function formatarHora(ms) {
  const data = new Date(ms);
  if (Number.isNaN(data.getTime())) return '--:--:--';
  return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

/** Data e hora curtas: 19/09/2026 14:03. */
export function formatarDataHora(ms) {
  const data = new Date(ms);
  if (Number.isNaN(data.getTime())) return '';
  return data.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** 75 vira "1min 15s"; 42 vira "42s". */
export function formatarDuracao(segundos) {
  const total = Math.max(0, Math.floor(segundos));
  const minutos = Math.floor(total / 60);
  const resto = total % 60;
  return minutos > 0 ? `${minutos}min ${resto}s` : `${resto}s`;
}

/**
 * Tamanho aceito para o nome de uma sessao. Fica aqui porque dois lugares
 * conferem (renomear e criar) e eles nao podem discordar um do outro. O
 * servidor confere de novo: validar na tela so poupa a ida e volta.
 */
export const NOME_SESSAO_MIN = 2;
export const NOME_SESSAO_MAX = 60;

/** O que a pessoa le em cada estado que o servidor devolve. */
const ROTULO_DO_ESTADO = {
  conectado: 'Conectado',
  conectando: 'Conectando…',
  aguardando_qr: 'Aguardando leitura do QR',
  desconectado: 'Desconectado',
  erro: 'Com erro'
};

/**
 * Estado que a tela mostra para uma sessao: texto e tom.
 *
 * "Desativada" vem antes de tudo porque quem desativou a sessao (o suporte
 * tecnico) quer que ela fique fora do ar; para o resto da equipe, o que o
 * WhatsApp esta fazendo por baixo deixa de importar.
 */
export function estadoDaSessao(canal) {
  if (canal.ativo === false) {
    return { chave: 'desativada', rotulo: 'Desativada', tom: 'neutro', emAndamento: false };
  }

  return {
    chave: canal.status,
    rotulo: ROTULO_DO_ESTADO[canal.status] ?? canal.status,
    // Uma unica fonte decide as cores dos status: a mesma tabela do resto do sistema.
    tom: TOM_STATUS[canal.status] ?? 'neutro',
    emAndamento: canal.status === 'conectando' || canal.status === 'aguardando_qr'
  };
}
