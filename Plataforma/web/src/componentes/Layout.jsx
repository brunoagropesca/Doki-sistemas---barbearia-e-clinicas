import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/autenticacao.jsx';
import { useTempoReal } from '../lib/tempoReal.js';
import { AvisoUrgente } from './AvisoUrgente.jsx';
import { useFuncoes } from '../lib/funcoes.jsx';
import { NotificacoesAtendimento } from './NotificacoesAtendimento.jsx';
import { EditorDeTextos } from './EditorDeTextos.jsx';
import { FaixaLicenca } from './Licenca.jsx';
import { ConviteInstalar, useInstalar } from './InstalarApp.jsx';
import { Icone, Raio } from './Icone.jsx';
import { useEmpresa } from '../lib/empresa.js';
import './Layout.css';

/**
 * Estrutura da aplicacao: menu lateral + area de conteudo.
 *
 * No computador o menu e dividido em secoes e pode ser recolhido para uma
 * fileira so de icones. No celular a casca vira a de um aplicativo: barra do
 * topo com o nome da tela (e o "voltar" nas telas de detalhe), barra de abas
 * embaixo com o que a recepcao mais usa, e o resto do menu numa folha que
 * sobe pelo "Mais". Isso importa porque a recepcao confere a agenda e responde
 * cliente no telefone enquanto atende alguem no balcao — e instalado (PWA)
 * nao ha barra do navegador nem botao de voltar dele.
 */

/**
 * O menu, por secao. Uma secao sem nenhum item visivel para quem entrou (o
 * atendente nao ve "Negocio" inteira, por exemplo) some junto com o titulo.
 *
 * `tambem`: telas que nao estao no menu mas pertencem a este item — o item
 * fica aceso nelas. E o caso do editor do menu do WhatsApp (/configuracoes),
 * que se abre pela Inteligencia Artificial > Menu Tradicional > Configurar.
 */
const SECOES = [
  {
    titulo: 'Atendimento',
    itens: [
      { para: '/', rotulo: 'Painel', icone: 'painel', fim: true },
      { para: '/conversas', rotulo: 'Conversas', icone: 'conversas', contador: 'conversas' },
      { para: '/quadro', rotulo: 'Atendimentos', icone: 'atendimentos', funcao: 'quadro' },
      { para: '/agenda', rotulo: 'Agenda', icone: 'agenda' },
      { para: '/contatos', rotulo: 'Contatos', icone: 'contatos' }
    ]
  },
  {
    titulo: 'Negócio',
    itens: [
      { para: '/dashboard', rotulo: 'Dashboard', icone: 'dashboard', cargoMinimo: 'owner' },
      { para: '/catalogo', rotulo: 'Catálogo', icone: 'catalogo' },
      { para: '/equipe', rotulo: 'Equipe', icone: 'equipe', cargoMinimo: 'admin' },
      { para: '/campanhas', rotulo: 'Campanhas', icone: 'campanhas', cargoMinimo: 'admin', funcao: 'campanhas' }
    ]
  },
  {
    titulo: 'Sistema',
    itens: [
      { para: '/ia', rotulo: 'Inteligência Artificial', icone: 'ia', cargoMinimo: 'admin', tambem: ['/configuracoes'] },
      { para: '/conexoes', rotulo: 'Conexões', icone: 'conexoes', cargoMinimo: 'admin' },
      { para: '/licenca', rotulo: 'Licença', icone: 'licenca', cargoMinimo: 'owner' }
    ]
  },
  {
    // So o DEV alcanca este cargo: para todo o resto, a secao nao existe.
    titulo: 'Desenvolvedor',
    itens: [
      { para: '/dev', rotulo: 'Funções do sistema', icone: 'funcoes', cargoMinimo: 'dev', fim: true },
      { para: '/dev/textos', rotulo: 'Textos do sistema', icone: 'textos', cargoMinimo: 'dev' },
      { para: '/dev/dados', rotulo: 'Backups e dados', icone: 'backups', cargoMinimo: 'dev' }
    ]
  }
];
const ITENS = SECOES.flatMap((s) => s.itens);

const ROTULO_CARGO = { owner: 'Dono', admin: 'Administrador', atendente: 'Atendente', dev: 'Desenvolvedor' };

/**
 * Barra de abas do celular: o dia a dia da recepcao a um toque. Estes itens
 * saem da folha do "Mais" para nao aparecerem duas vezes.
 */
const ABAS = [
  { para: '/', rotulo: 'Início', icone: 'inicio', fim: true },
  { para: '/conversas', rotulo: 'Conversas', icone: 'conversas', contador: 'conversas' },
  { para: '/agenda', rotulo: 'Agenda', icone: 'agenda' },
  { para: '/contatos', rotulo: 'Contatos', icone: 'contatos' }
];
const NA_BARRA = new Set(ABAS.map((a) => a.para));

/** Telas de detalhe: no topo aparece "voltar" e o nome da tela de cima. */
const DETALHES = [
  { prefixo: '/contatos/', titulo: 'Contato', volta: '/contatos' },
  { prefixo: '/campanhas/nova', titulo: 'Nova campanha', volta: '/campanhas' },
  { prefixo: '/campanhas/', titulo: 'Campanha', volta: '/campanhas' },
  { prefixo: '/configuracoes', titulo: 'Menu do WhatsApp', volta: '/ia' }
];

/** O nome da tela na barra do topo (celular). */
function tituloDaTela(caminho, usuario) {
  const detalhe = DETALHES.find((d) => caminho.startsWith(d.prefixo));
  if (detalhe) return detalhe;
  if (caminho === '/') return { titulo: `Olá, ${usuario?.nome?.split(' ')[0] ?? ''}` };
  if (caminho === '/perfil') return { titulo: 'Meu perfil' };
  const item = ITENS.find((i) => i.para === caminho);
  return { titulo: item?.rotulo ?? 'Plataforma' };
}

/**
 * No computador o menu pode ficar recolhido — so os icones — para sobrar tela
 * (o editor de menu e a mesa de conversas agradecem). A escolha fica gravada
 * no navegador: quem recolhe nao quer abrir de novo a cada visita.
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

  function alternarRecolhido() {
    setRecolhido((r) => {
      try {
        localStorage.setItem(CHAVE_RECOLHIDO, r ? '0' : '1');
      } catch {
        // Navegador sem armazenamento: vale so nesta visita.
      }
      return !r;
    });
  }

  const local = useLocation();
  const navegar = useNavigate();
  const instalar = useInstalar();
  const { data: empresa } = useEmpresa();
  const nomeEmpresa = empresa?.nome || 'Plataforma';
  const logoEmpresa = empresa?.logo ? <img src={empresa.logo} alt="" /> : <Raio />;
  // Nome e logo levam a Base de conhecimento, onde se trocam. So para quem
  // pode editar; para os outros, a marca e so a marca.
  const marcaLeva = podeAcessar('admin') ? '/ia?aba=conhecimento' : null;
  const tela = tituloDaTela(local.pathname, usuario);

  // Conversa aberta no celular: tela cheia, como no WhatsApp — o fio tem o
  // proprio topo (com voltar) e a barra de envio precisa do rodape.
  const busca = new URLSearchParams(local.search);
  const conversaAberta = local.pathname.startsWith('/conversas') && (busca.has('id') || busca.has('vista'));

  // Com o teclado aberto a barra de abas so rouba espaco do que se digita.
  const digitando = useTecladoAberto();

  // Trocou de tela: a folha do "Mais" fecha sozinha.
  useEffect(() => setMenuAberto(false), [local.pathname]);

  function voltar() {
    // Veio de dentro do app: volta de verdade (preserva filtros e rolagem).
    // Abriu direto pelo link: sobe para a lista.
    if (window.history.state?.idx > 0) navegar(-1);
    else navegar(tela.volta ?? '/');
  }

  const noMais = !ABAS.some((a) => (a.fim ? local.pathname === a.para : local.pathname.startsWith(a.para)));

  // Uma unica conexao de tempo real para o sistema todo.
  useTempoReal();

  // Contador de conversas esperando: o numero que faz a recepcao olhar a tela.
  const { data: metricas } = useQuery({
    queryKey: ['conversas', 'metricas'],
    queryFn: () => api.get('/api/conversas/metricas', { dias: 1 }),
    refetchInterval: 20_000
  });

  const naFila = metricas?.naFila ?? 0;

  const visivel = (i) => (!i.cargoMinimo || podeAcessar(i.cargoMinimo)) && ligada(i.funcao);
  const secoes = SECOES.map((s) => ({ ...s, itens: s.itens.filter(visivel) })).filter((s) => s.itens.length > 0);

  return (
    <div
      className={[
        'layout',
        recolhido && 'layout--recolhido',
        conversaAberta && 'layout--conversa-aberta',
        digitando && 'layout--digitando'
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Barra do topo — so no celular. */}
      <header className="layout__topo">
        {tela.volta ? (
          <button type="button" className="layout__voltar" onClick={voltar} aria-label="Voltar">
            <span aria-hidden="true">‹</span>
          </button>
        ) : (
          <span className={`menu__logo layout__topo-logo${empresa?.logo ? ' menu__logo--imagem' : ''}`} aria-hidden="true">
            {logoEmpresa}
          </span>
        )}
        <h1 className="layout__titulo">{tela.titulo}</h1>
        <NavLink to="/perfil" className="layout__eu" aria-label="Meu perfil">
          <span className="menu__avatar">
            {usuario?.avatar ? <img src={usuario.avatar} alt="" /> : (usuario?.nome?.[0]?.toUpperCase() ?? '?')}
            <span className={`menu__presenca menu__presenca--${usuario?.statusPresenca ?? 'offline'}`} />
          </span>
        </NavLink>
      </header>

      {/* Fundo escuro no celular: clicar fora fecha a folha do "Mais". */}
      {menuAberto && <div className="layout__fundo" onClick={() => setMenuAberto(false)} role="presentation" />}

      <aside className={`menu${menuAberto ? ' menu--aberto' : ''}`}>
        <div className="menu__marca">
          {(() => {
            const conteudo = (
              <>
                <span className={`menu__logo${empresa?.logo ? ' menu__logo--imagem' : ''}`} aria-hidden="true">
                  {logoEmpresa}
                </span>
                <span className="menu__nome-sistema">{nomeEmpresa}</span>
              </>
            );
            return marcaLeva ? (
              <NavLink
                to={marcaLeva}
                className="menu__empresa crescer"
                onClick={() => setMenuAberto(false)}
                title={`${nomeEmpresa} · Base de conhecimento`}
              >
                {conteudo}
              </NavLink>
            ) : (
              <span className="menu__empresa crescer" title={nomeEmpresa}>
                {conteudo}
              </span>
            );
          })()}
          <button type="button" className="menu__fechar-folha" onClick={() => setMenuAberto(false)} aria-label="Fechar">
            ×
          </button>
        </div>

        <nav className="menu__nav" aria-label="Navegacao principal">
          {secoes.map((secao) => (
            <div className="menu__secao" key={secao.titulo}>
              <p className="menu__secao-titulo">{secao.titulo}</p>
              <div className="menu__secao-itens">
                {secao.itens.map((item) => {
                  const tambemAtivo = item.tambem?.some((p) => local.pathname.startsWith(p));
                  return (
                    <NavLink
                      key={item.para}
                      to={item.para}
                      end={item.fim}
                      className={({ isActive }) =>
                        [
                          'menu__item',
                          (isActive || tambemAtivo) && 'menu__item--ativo',
                          NA_BARRA.has(item.para) && 'menu__item--na-barra'
                        ]
                          .filter(Boolean)
                          .join(' ')
                      }
                      onClick={() => setMenuAberto(false)}
                      // Recolhido, so o icone aparece: o nome vem na dica do mouse.
                      title={recolhido ? item.rotulo : undefined}
                    >
                      <Icone nome={item.icone} className="menu__icone" />
                      <span className="menu__rotulo">{item.rotulo}</span>
                      {item.contador === 'conversas' && naFila > 0 && (
                        <span className="menu__badge" aria-label={`${naFila} na fila`}>
                          {naFila > 99 ? '99+' : naFila}
                        </span>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}

          {instalar.disponivel && (
            <div className="menu__secao menu__secao--app">
              <div className="menu__secao-itens">
                <button type="button" className="menu__item menu__item--instalar" onClick={instalar.instalar}>
                  <Icone nome="instalar" className="menu__icone" />
                  <span className="menu__rotulo">Instalar app</span>
                </button>
              </div>
            </div>
          )}
        </nav>

        <div className="menu__rodape">
          <button
            type="button"
            className="menu__item menu__recolher"
            onClick={alternarRecolhido}
            aria-expanded={!recolhido}
            title={recolhido ? 'Expandir menu' : undefined}
          >
            <Icone nome={recolhido ? 'expandir' : 'recolher'} className="menu__icone" />
            <span className="menu__rotulo">Recolher menu</span>
          </button>

          <div className="menu__conta">
            <NavLink
              to="/perfil"
              className={({ isActive }) => `menu__usuario${isActive ? ' menu__usuario--ativo' : ''}`}
              onClick={() => setMenuAberto(false)}
              title={recolhido ? `${usuario?.nome} · Meu perfil` : 'Meu perfil'}
            >
              <span className="menu__avatar" aria-hidden="true">
                {usuario?.avatar ? <img src={usuario.avatar} alt="" /> : (usuario?.nome?.[0]?.toUpperCase() ?? '?')}
                <span className={`menu__presenca menu__presenca--${usuario?.statusPresenca ?? 'offline'}`} />
              </span>
              <span className="menu__quem">
                <span className="menu__nome">{usuario?.nome}</span>
                <span className="menu__cargo">{ROTULO_CARGO[usuario?.cargo] ?? usuario?.cargo}</span>
              </span>
            </NavLink>
            <button type="button" className="menu__sair" onClick={sair} aria-label="Sair" title="Sair">
              <Icone nome="sair" />
            </button>
          </div>
        </div>
      </aside>

      <main className="conteudo">
        {usuario?.demonstracao && <FaixaDemonstracao />}
        <FaixaLicenca />
        <Outlet />
      </main>

      {/* Barra de abas — so no celular. */}
      <div className="layout__rodape">
        {instalar.convidar && !digitando && (
          <ConviteInstalar aoInstalar={instalar.instalar} aoDispensar={instalar.dispensar} />
        )}
        <nav className="layout__abas" aria-label="Navegacao rapida">
          {ABAS.map((aba) => (
            <NavLink
              key={aba.para}
              to={aba.para}
              end={aba.fim}
              className={({ isActive }) => `aba${isActive && !menuAberto ? ' aba--ativa' : ''}`}
            >
              <span className="aba__icone">
                <Icone nome={aba.icone} />
                {aba.contador === 'conversas' && naFila > 0 && (
                  <span className="aba__badge" aria-label={`${naFila} na fila`}>
                    {naFila > 99 ? '99+' : naFila}
                  </span>
                )}
              </span>
              <span className="aba__rotulo">{aba.rotulo}</span>
            </NavLink>
          ))}
          <button
            type="button"
            className={`aba${noMais || menuAberto ? ' aba--ativa' : ''}`}
            onClick={() => setMenuAberto((a) => !a)}
            aria-expanded={menuAberto}
          >
            <span className="aba__icone">
              <Icone nome="mais" />
            </span>
            <span className="aba__rotulo">Mais</span>
          </button>
        </nav>
      </div>

      {instalar.modal}
      <NotificacoesAtendimento />
      <AvisoUrgente />
      {usuario?.cargo === 'dev' && <EditorDeTextos />}
    </div>
  );
}

/**
 * O teclado do celular esta aberto? (Algum campo de texto com o foco.)
 *
 * Nao ha evento de "teclado abriu" no navegador; o foco num campo e o sinal
 * confiavel nos dois sistemas. A classe so tem efeito no CSS do celular.
 */
const CAMPO_DE_TEXTO = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]):not([type=file]), textarea, [contenteditable="true"]';

function useTecladoAberto() {
  const [aberto, setAberto] = useState(false);
  useEffect(() => {
    const conferir = () => setAberto(Boolean(document.activeElement?.matches?.(CAMPO_DE_TEXTO)));
    // No `focusout` o foco ainda nao chegou ao proximo campo: confere depois.
    const aoSair = () => setTimeout(conferir, 0);
    document.addEventListener('focusin', conferir);
    document.addEventListener('focusout', aoSair);
    return () => {
      document.removeEventListener('focusin', conferir);
      document.removeEventListener('focusout', aoSair);
    };
  }, []);
  return aberto;
}

/**
 * Faixa fixa da DEMONSTRACAO: impossivel esquecer que os dados sao ficticios
 * (nem confundir com a empresa de verdade). "Sair" volta ao banco real.
 */
function FaixaDemonstracao() {
  const [saindo, setSaindo] = useState(false);
  async function sair() {
    setSaindo(true);
    try {
      await api.post('/api/dev/demonstracao/sair');
    } finally {
      // Recarrega tudo: cada tela volta a ler a empresa de verdade.
      window.location.assign('/dev/dados');
    }
  }
  return (
    <div className="faixa-demo" role="status">
      <span className="faixa-demo__ponto" aria-hidden="true" />
      <span className="crescer">
        <strong>Modo demonstração</strong>
        <span className="faixa-demo__detalhe"> — dados fictícios. Nada daqui chega a clientes reais.</span>
      </span>
      <button type="button" className="faixa-demo__sair" onClick={sair} disabled={saindo}>
        {saindo ? 'Saindo…' : <>Sair<span className="faixa-demo__detalhe"> da demonstração</span></>}
      </button>
    </div>
  );
}
