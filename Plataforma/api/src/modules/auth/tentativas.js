/**
 * Limite de tentativas de login.
 *
 * Duas travas, as duas em memoria (uma maquina so; reiniciar o servidor zera,
 * e isso e aceitavel — quem ataca nao controla quando o servidor reinicia):
 *
 *   USUARIO — 5 erros SEGUIDOS no mesmo login bloqueiam esse login por 15 min,
 *   contados a partir do ultimo erro. Acertar zera. Protege a senha de UMA
 *   pessoa contra quem tenta adivinhar.
 *
 *   IP — 20 erros do mesmo aparelho em 15 min bloqueiam o aparelho por 15 min.
 *   Protege contra quem varia o login para escapar da trava de usuario. Acertar
 *   NAO zera: um acerto no meio de 19 chutes nao apaga os chutes.
 *
 * A checagem acontece ANTES do scrypt: e isso que impede uma enxurrada de
 * tentativas de ocupar a fila de 2 calculos (core/crypto.js) e travar o login
 * dos funcionarios.
 *
 * O relogio e injetavel so para os testes nao esperarem 15 minutos.
 */

export const LIMITE_USUARIO = 5;
export const LIMITE_IP = 20;
export const JANELA_MS = 15 * 60_000;

/** Acima disto, cada erro novo aproveita para varrer o que ja expirou (memoria limitada). */
const VARRER_ACIMA_DE = 5_000;

let agora = () => Date.now();
/** login -> { erros, ultimoEm } */
const porUsuario = new Map();
/** ip -> { erros: number[] (instantes, so os da janela), bloqueadoAte } */
const porIp = new Map();

/**
 * Quanto falta (ms) para poder tentar de novo. 0 = pode tentar.
 * @param {{ usuario: string, ip?: string | null }} chaves
 */
export function bloqueio({ usuario, ip }) {
  const t = agora();
  let espera = 0;

  const u = porUsuario.get(usuario);
  if (u && u.erros >= LIMITE_USUARIO) espera = Math.max(espera, u.ultimoEm + JANELA_MS - t);

  const i = ip ? porIp.get(ip) : null;
  if (i?.bloqueadoAte) espera = Math.max(espera, i.bloqueadoAte - t);

  return Math.max(0, espera);
}

/**
 * Conta um erro de login. Devolve o que ESTE erro acabou de bloquear
 * (`'usuario'`, `'ip'` ou null), para o chamador registrar o bloqueio uma vez.
 */
export function registrarErro({ usuario, ip }) {
  const t = agora();
  if (porUsuario.size + porIp.size > VARRER_ACIMA_DE) varrer(t);

  let bloqueou = null;

  const anterior = porUsuario.get(usuario);
  // Erro depois de 15 min sem erros comeca uma sequencia nova.
  const erros = anterior && t - anterior.ultimoEm < JANELA_MS ? anterior.erros + 1 : 1;
  porUsuario.set(usuario, { erros, ultimoEm: t });
  if (erros === LIMITE_USUARIO) bloqueou = 'usuario';

  if (ip) {
    const i = porIp.get(ip) ?? { erros: [], bloqueadoAte: 0 };
    i.erros = i.erros.filter((em) => t - em < JANELA_MS);
    i.erros.push(t);
    if (i.erros.length >= LIMITE_IP && !(i.bloqueadoAte > t)) {
      i.bloqueadoAte = t + JANELA_MS;
      i.erros = [];
      bloqueou = 'ip';
    }
    porIp.set(ip, i);
  }

  return bloqueou;
}

/** Login certo: zera a sequencia de erros DESTE usuario (o IP continua contando). */
export function registrarAcerto({ usuario }) {
  porUsuario.delete(usuario);
}

/** Tira da memoria o que ja nao bloqueia nem conta. */
function varrer(t) {
  for (const [chave, u] of porUsuario) if (t - u.ultimoEm >= JANELA_MS) porUsuario.delete(chave);
  for (const [chave, i] of porIp) {
    i.erros = i.erros.filter((em) => t - em < JANELA_MS);
    if (i.erros.length === 0 && !(i.bloqueadoAte > t)) porIp.delete(chave);
  }
}

/** So para os testes: troca o relogio (sem argumento, volta ao de verdade) e zera tudo. */
export function _paraTestes({ relogio } = {}) {
  agora = relogio ?? (() => Date.now());
  porUsuario.clear();
  porIp.clear();
}
