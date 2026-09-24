/**
 * Humor do cliente, lido pela Sofia durante a conversa.
 *
 * Quatro estados, os mesmos que o CRM guarda no cadastro. Cada um tem cor E
 * rosto: quem nao distingue as cores (e 8% dos homens nao distingue verde de
 * vermelho) continua lendo o estado pelo simbolo e pelo texto.
 */
export const HUMOR = {
  satisfeito: { rotulo: 'Satisfeito', icone: '😊', cor: '#07CA6B', tom: 'sucesso' },
  neutro: { rotulo: 'Neutro', icone: '😐', cor: '#38BDF8', tom: 'info' },
  duvida: { rotulo: 'Em duvida', icone: '🤔', cor: '#E89558', tom: 'alerta' },
  frustrado: { rotulo: 'Frustrado', icone: '😠', cor: '#EA2143', tom: 'perigo' }
};

export function Humor({ valor, compacto = false }) {
  const h = HUMOR[valor];
  if (!h) return null;

  return (
    <span
      className={`humor humor--${valor}${compacto ? ' humor--compacto' : ''}`}
      title={`Humor do cliente: ${h.rotulo}`}
    >
      <span aria-hidden="true">{h.icone}</span>
      {!compacto && <span>{h.rotulo}</span>}
      {compacto && <span className="mesa__so-leitor">{h.rotulo}</span>}
    </span>
  );
}
