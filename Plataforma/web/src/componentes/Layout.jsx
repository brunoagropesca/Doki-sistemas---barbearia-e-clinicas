import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/autenticacao.jsx';
import { useTempoReal } from '../lib/tempoReal.js';
import { Botao } from './ui.jsx';
import { AvisoUrgente } from './AvisoUrgente.jsx';
import { useFuncoes } from '../lib/funcoes.jsx';
import { NotificacoesAtendimento } from './NotificacoesAtendimento.jsx';
import { EditorDeTextos } from './EditorDeTextos.jsx';
import { FaixaLicenca } from './Licenca.jsx';
import './Layout.css';

/**
 * Estrutura da aplicacao: menu lateral + area de conteudo.
 *
 * No celular o menu vira uma gaveta. Isso importa porque a recepcao costuma
 * conferir a agenda no telefone enquanto atende alguem no balcao.
 */

const ITENS = [
  { para: '/', rotulo: 'Painel', icone: '▤', fim: true },
  { para: '/conversas', rotulo: 'Conversas', icone: '💬', contador: 'conversas' },
  { para: '/quadro', rotulo: 'Atendimentos', icone: '🗂️', funcao: 'quadro' },
  { para: '/agenda', rotulo: 'Agenda', icone: '📅' },
  { para: '/contatos', rotulo: 'Contatos', icone: '👥' },
  { para: '/catalogo', rotulo: 'Catalogo', icone: '🏷️' },
  { para: '/equipe', rotulo: 'Equipe', icone: '✂️', cargoMinimo: 'admin' },
  { para: '/campanhas', rotulo: 'Campanhas', icone: '📣', cargoMinimo: 'admin', funcao: 'campanhas' },
  { para: '/ia', rotulo: 'Inteligência Artificial', icone: '⚡', cargoMinimo: 'admin' },
  { para: '/conexoes', rotulo: 'Conexões', icone: '🔌', cargoMinimo: 'admin' },
  { para: '/configuracoes', rotulo: 'Configuracoes', icone: '⚙️', cargoMinimo: 'admin' },
  { para: '/licenca', rotulo: 'Licença', icone: '🔑', cargoMinimo: 'owner' },
  // So o DEV alcanca este cargo: para todo o resto, o item nao existe.
  { para: '/dev', rotulo: 'Funções do sistema', icone: '🛠️', cargoMinimo: 'dev', fim: true },
  { para: '/dev/textos', rotulo: 'Textos do sistema', icone: '✏️', cargoMinimo: 'dev' },
  { para: '/dev/dados', rotulo: 'Backups e dados', icone: '💾', cargoMinimo: 'dev' }
];

const ROTULO_CARGO = { owner: 'Dono', admin: 'Administrador', atendente: 'Atendente', dev: 'Desenvolvedor' };

/**
 * No computador o menu pode ficar recolhido para sobrar tela (o editor de
 * menu e a mesa de conversas agradecem). A escolha fica gravada no navegador:
 * quem recolhe nao quer abrir de novo a cada visita.
 */
const CHAVE_RECOLHIDO = 'layout.menu-recolhido';

function lerRecolhido() {
  try {
    return localStorage.getItem(CHAVE_RECOLHIDO) === '1';
  } catch {
    return false;
  }
}

export function Layout() {
  const { usuario, sair, podeAcessar } = useAuth();
  const { ligada } = useFuncoes();
  const [menuAberto, setMenuAberto] = useState(false);
  const [recolhido, setRecolhido] = useState(lerRecolhido);
  // Recolhido, o mouse na abinha "espia" o menu: entra so a fileira de icones.
  // Abrir de vez continua sendo uma decisao — o clique na seta.
  const [espiando, setEspiando] = useState(false);

  function alternarRecolhido() {
    setEspiando(false);
    setRecolhido((r) => {
      try {
        localStorage.setItem(CHAVE_RECOLHIDO, r ? '0' : '1');
      } catch {
        // Navegador sem armazenamento: vale so nesta visita.
      }
      return !r;
    });
  }

  const espiar = () => recolhido && setEspiando(true);
  const pararDeEspiar = () => setEspiando(false);

  // Uma unica conexao de tempo real para o sistema todo.
  useTempoReal();

  // Contador de conversas esperando: o numero que faz a recepcao olhar a tela.
  const { data: metricas } = useQuery({
    queryKey: ['conversas', 'metricas'],
    queryFn: () => api.get('/api/conversas/metricas', { dias: 1 }),
    refetchInterval: 20_000
  });

  const naFila = metricas?.naFila ?? 0;

  return (
    <div className={`layout${recolhido ? ' layout--recolhido' : ''}${recolhido && espiando ? ' layout--espiando' : ''}`}>
      <button
        className="layout__abrir-menu"
        onClick={() => setMenuAberto(true)}
        aria-label="Abrir menu"
      >
        ☰
      </button>

      {/* Fundo escuro no celular: clicar fora fecha a gaveta. */}
      {menuAberto && <div className="layout__fundo" onClick={() => setMenuAberto(false)} role="presentation" />}

      {/*
        A abinha e o menu ficam dentro do MESMO ancestral para o "espiar" ser
        confiavel. "mouseenter"/"mouseleave" seguem a ARVORE do DOM, nao a
        posicao na tela — e como a abinha DESLIZA (da borda ate a beirada da
        fileira), quando ela e a `<aside>` eram irmaos so encostados
        visualmente, o navegador as vezes perdia o rastro de que o mouse
        continuava em cima dela no meio do movimento: o menu recolhia sozinho,
        ou nao recolhia quando devia. `display: contents` nao ocupa espaco
        nem muda o layout — so agrupa os dois, entao o hover passa a ser
        sempre o mesmo evento, em qualquer posicao da animacao.
      */}
      <div className="layout__zona-menu" onMouseEnter={espiar} onMouseLeave={pararDeEspiar}>
        {/* A abinha que fica no canto quando o menu esta recolhido: o unico
            jeito de traze-lo de volta, entao ela pede para ser puxada. */}
        <button
          className="layout__puxar"
          onClick={alternarRecolhido}
          onFocus={espiar}
          aria-label="Mostrar menu"
          title="Passe o mouse para espiar, clique para abrir"
          aria-expanded={!recolhido}
          tabIndex={recolhido ? 0 : -1}
        >
          <span aria-hidden="true">›</span>
        </button>

        {/* Recolhido, o menu sai tambem do caminho do teclado e do leitor de
            tela: senao o Tab passearia por links invisiveis. */}
        <aside
          className={`menu ${menuAberto ? 'menu--aberto' : ''}`}
          inert={recolhido && !espiando ? true : undefined}
        >
          <div className="menu__marca">
            <span className="menu__logo" aria-hidden="true">◆</span>
            <span className="crescer">Plataforma</span>
            <button
              type="button"
              className="menu__recolher"
              onClick={alternarRecolhido}
              aria-label={recolhido ? 'Abrir menu' : 'Recolher menu'}
              title={recolhido ? 'Abrir menu' : 'Recolher menu'}
            >
              <span aria-hidden="true">{recolhido ? '›' : '‹'}</span>
            </button>
          </div>

          <nav className="menu__nav" aria-label="Navegacao principal">
            {ITENS.filter((i) => (!i.cargoMinimo || podeAcessar(i.cargoMinimo)) && ligada(i.funcao)).map((item) => (
              <NavLink
                key={item.para}
                to={item.para}
                end={item.fim}
                className={({ isActive }) => `menu__item ${isActive ? 'menu__item--ativo' : ''}`}
                onClick={() => setMenuAberto(false)}
                // Espiando, so o icone aparece: o nome vem na dica do mouse.
                title={item.rotulo}
              >
                <span className="menu__icone" aria-hidden="true">{item.icone}</span>
                <span className="crescer">{item.rotulo}</span>
                {item.contador === 'conversas' && naFila > 0 && (
                  <span className="menu__badge" aria-label={`${naFila} na fila`}>
                    {naFila}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="menu__rodape">
            <NavLink
              to="/perfil"
              className={({ isActive }) => `menu__usuario${isActive ? ' menu__usuario--ativo' : ''}`}
              onClick={() => setMenuAberto(false)}
              title="Meu perfil"
            >
              <span className="menu__avatar" aria-hidden="true">
                {usuario?.avatar ? <img src={usuario.avatar} alt="" /> : (usuario?.nome?.[0]?.toUpperCase() ?? '?')}
                <span className={`menu__presenca menu__presenca--${usuario?.statusPresenca ?? 'offline'}`} />
              </span>
              <div className="crescer">
                <div className="menu__nome">{usuario?.nome}</div>
                <div className="menu__cargo">{ROTULO_CARGO[usuario?.cargo] ?? usuario?.cargo} · Meu perfil</div>
              </div>
              <span className="menu__seta" aria-hidden="true">›</span>
            </NavLink>
            <Botao variante="fantasma" tamanho="sm" onClick={sair} style={{ width: '100%' }}>
              Sair
            </Botao>
          </div>
        </aside>
      </div>

      <main className="conteudo">
        <FaixaLicenca />
        <Outlet />
      </main>

      <NotificacoesAtendimento />
      <AvisoUrgente />
      {usuario?.cargo === 'dev' && <EditorDeTextos />}

    </div>
  );
}
