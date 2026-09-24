/**
 * Icones dos canais de contato (WhatsApp, Instagram, Gmail), em SVG proprio:
 * nitidos em qualquer tamanho, sem baixar imagem de fora e sem depender de
 * emoji (que muda de desenho em cada celular).
 */

export function IconeWhatsapp({ tamanho = 24 }) {
  return (
    <svg width={tamanho} height={tamanho} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#25D366" />
      {/* Balao de conversa */}
      <path
        d="M16 6.5a9.5 9.5 0 0 0-8.2 14.3L6.5 25.5l4.8-1.3A9.5 9.5 0 1 0 16 6.5z"
        fill="none"
        stroke="#fff"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      {/* Telefone */}
      <path
        d="M12.6 11.2c.3-.3.8-.3 1 .1l1 1.6c.2.3.1.7-.1 1l-.6.6c.6 1.3 1.6 2.3 2.9 2.9l.6-.6c.3-.2.7-.3 1-.1l1.6 1c.4.2.4.7.1 1l-.7.8c-.6.6-1.5.8-2.3.5-2.5-1-4.4-2.9-5.4-5.4-.3-.8-.1-1.7.5-2.3z"
        fill="#fff"
      />
    </svg>
  );
}

export function IconeInstagram({ tamanho = 24 }) {
  return (
    <svg width={tamanho} height={tamanho} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <radialGradient id="ig-fundo" cx="0.3" cy="1.07" r="1.2">
          <stop offset="0" stopColor="#FDDB77" />
          <stop offset="0.15" stopColor="#FDDB77" />
          <stop offset="0.45" stopColor="#F4504A" />
          <stop offset="0.7" stopColor="#D62976" />
          <stop offset="1" stopColor="#5B51D8" />
        </radialGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#ig-fundo)" />
      <rect x="8" y="8" width="16" height="16" rx="4.8" fill="none" stroke="#fff" strokeWidth="1.9" />
      <circle cx="16" cy="16" r="3.9" fill="none" stroke="#fff" strokeWidth="1.9" />
      <circle cx="20.6" cy="11.4" r="1.15" fill="#fff" />
    </svg>
  );
}

export function IconeGmail({ tamanho = 24 }) {
  return (
    <svg width={tamanho} height={tamanho} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#fff" />
      {/* O "M" do Gmail: laterais azul e verde, dobra vermelha, canto amarelo. */}
      <path d="M7 11.2v11.3c0 .8.7 1.5 1.5 1.5H11V14.1z" fill="#4285F4" />
      <path d="M21 14.1V24h2.5c.8 0 1.5-.7 1.5-1.5V11.2z" fill="#34A853" />
      <path d="M21 9.4v4.7l4-2.9V9.6c0-1.8-2.1-2.9-3.6-1.8z" fill="#FBBC04" />
      <path d="M11 14.1V9.4l5 3.8 5-3.8v4.7l-5 3.8z" fill="#EA4335" />
      <path d="M7 9.6v1.6l4 2.9V9.4l-1.4-1.1C8.1 7.1 7 8 7 9.6z" fill="#C5221F" />
    </svg>
  );
}
