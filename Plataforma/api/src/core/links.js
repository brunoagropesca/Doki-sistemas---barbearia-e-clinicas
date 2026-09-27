/**
 * Link que um cliente consegue abrir: http(s) com endereco.
 *
 * Mora no core porque quem valida (a tela de configuracao, via ia.service) e
 * quem envia (automacao) nao devem depender um do outro.
 */
export function linkValido(link) {
  try {
    const u = new URL(String(link ?? '').trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && Boolean(u.hostname);
  } catch {
    return false;
  }
}
