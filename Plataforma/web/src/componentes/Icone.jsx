/**
 * Icones de traco do sistema (grade 24x24, traco 1.8, pontas arredondadas).
 *
 * Um desenho so para o menu lateral, a folha do "Mais" e a barra de abas do
 * celular: os emojis que o menu usava mudavam de cara em cada aparelho e
 * brigavam de cor com o tema. Estes herdam a cor do texto (`currentColor`),
 * entao acendem junto com o item ativo.
 */
const TRACOS = {
  inicio: <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z" />,
  painel: (
    <>
      <rect x="3.5" y="3.5" width="7" height="9" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="5" rx="1.5" />
      <rect x="13.5" y="11.5" width="7" height="9" rx="1.5" />
      <rect x="3.5" y="15.5" width="7" height="5" rx="1.5" />
    </>
  ),
  dashboard: (
    <>
      <path d="M3.5 20.5h17" />
      <path d="M6.5 16.5v-4M11 16.5V8M15.5 16.5v-6M20 16.5V5" />
    </>
  ),
  conversas: <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.1A8 8 0 1 1 20 12z" />,
  atendimentos: (
    <>
      <rect x="5" y="4.5" width="14" height="17" rx="2.5" />
      <path d="M9 4.5V3h6v1.5M9 13l2 2 4-4.5" />
    </>
  ),
  agenda: (
    <>
      <rect x="4" y="5" width="16" height="16" rx="2.5" />
      <path d="M8 3v4M16 3v4M4 10h16" />
    </>
  ),
  contatos: (
    <>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 5.2a3.5 3.5 0 0 1 0 6.6M18 14.5a6.5 6.5 0 0 1 3.5 5.5" />
    </>
  ),
  catalogo: (
    <>
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </>
  ),
  equipe: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" />
    </>
  ),
  campanhas: (
    <>
      <path d="m3 11 16-5v12L3 14z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </>
  ),
  ia: (
    <>
      <path d="M11 3.5 12.9 8.6 18 10.5l-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9z" />
      <path d="M19 3v4M17 5h4M18 16v4M16 18h4" />
    </>
  ),
  conexoes: (
    <>
      <path d="M9 2.5v5M15 2.5v5" />
      <path d="M6 7.5h12v3.5a6 6 0 0 1-12 0z" />
      <path d="M12 17v4.5" />
    </>
  ),
  licenca: (
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 20 3M16.5 6.5l3 3M14 9l2.5 2.5" />
    </>
  ),
  funcoes: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  textos: <path d="M4 7V4.5h16V7M9 19.5h6M12 4.5v15" />,
  backups: (
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="3" />
      <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  instalar: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
  planilha: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6M8 13h8M8 17h8M12 13v4" />
    </>
  ),
  adicionar: <path d="M12 5v14M5 12h14" />,
  organizar: (
    <>
      <rect x="3" y="9" width="6" height="6" rx="1.5" />
      <rect x="15" y="3" width="6" height="6" rx="1.5" />
      <rect x="15" y="15" width="6" height="6" rx="1.5" />
      <path d="M9 12h3m0-6v12m0-12h3m-3 12h3" />
    </>
  ),
  testar: <path d="M7 4.5v15l12-7.5z" />,
  sair: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  recolher: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <path d="M9 3v18M16 10l-2 2 2 2" />
    </>
  ),
  expandir: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <path d="M9 3v18M14 10l2 2-2 2" />
    </>
  ),
  // Modos de visualizacao: claro, medio e full black.
  sol: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  contraste: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" />
    </>
  ),
  lua: <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z" fill="currentColor" />,
  mais: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </>
  )
};

export function Icone({ nome, className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {TRACOS[nome]}
    </svg>
  );
}

/** O raio da marca — o mesmo do icone do app instalado e do favicon. */
export function Raio() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M18 5 9 18h6l-1 9 9-13h-6z" fill="currentColor" />
    </svg>
  );
}
