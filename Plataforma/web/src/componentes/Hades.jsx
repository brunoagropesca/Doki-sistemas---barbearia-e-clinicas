import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/autenticacao.jsx';
import { useFuncoes } from '../lib/funcoes.jsx';
import './Hades.css';

/**
 * Hades — o assistente administrativo do dono, no botao flutuante do canto.
 *
 * So aparece para o dono e o DEV (e se o DEV nao o desligou em Funcoes do
 * sistema). A conversa fica guardada NESTE navegador, por pessoa: o servidor
 * nao guarda historico (a cada pergunta, a tela manda as ultimas mensagens).
 * O que ele sabe do negocio o servidor monta na hora (numeros do Dashboard);
 * o que ele sabe do mundo vem da pesquisa do Google.
 */

const SUGESTOES = [
  'Como foi meu último mês?',
  'Quais são meus dias e horários mais fracos, e o que faço com eles?',
  'Que tendências do ramo eu deveria aproveitar agora?',
  'Sugira uma promoção para a próxima semana.'
];
const MAX_GUARDADAS = 40;

const chaveDaConversa = (usuarioId) => `hades.conversa.${usuarioId}`;

function lerConversa(usuarioId) {
  try {
    const salvo = JSON.parse(localStorage.getItem(chaveDaConversa(usuarioId)) ?? '[]');
    return Array.isArray(salvo) ? salvo : [];
  } catch {
    return [];
  }
}

export function Hades() {
  const { usuario, podeAcessar } = useAuth();
  const { ligada } = useFuncoes();
  const pode = Boolean(usuario) && podeAcessar('owner') && ligada('agente_hades');

  const config = useQuery({
    queryKey: ['hades', 'config'],
    queryFn: () => api.get('/api/hades/config'),
    enabled: pode,
    staleTime: 60_000
  });

  // Com o botao na tela, os avisos de atendimento sobem para nao ficar embaixo dele.
  useEffect(() => {
    if (!pode) return undefined;
    document.documentElement.style.setProperty('--hades-espaco', '72px');
    return () => document.documentElement.style.removeProperty('--hades-espaco');
  }, [pode]);

  if (!pode || !config.data) return null;
  const cfg = config.data.config;
  if (!cfg.ativo) return null;
  return <HadesFlutuante cfg={cfg} usuarioId={usuario.id} />;
}

function HadesFlutuante({ cfg, usuarioId }) {
  const [aberto, setAberto] = useState(false);
  const [mensagens, setMensagens] = useState(() => lerConversa(usuarioId));
  const [texto, setTexto] = useState('');
  const fimRef = useRef(null);
  const campoRef = useRef(null);

  // Guarda a conversa neste navegador (as ultimas 40 falas).
  useEffect(() => {
    try {
      localStorage.setItem(chaveDaConversa(usuarioId), JSON.stringify(mensagens.slice(-MAX_GUARDADAS)));
    } catch {
      // sem armazenamento: vale so nesta visita
    }
  }, [mensagens, usuarioId]);

  const perguntar = useMutation({
    mutationFn: (historico) =>
      api.post('/api/hades/conversar', { mensagens: historico.map(({ papel, conteudo }) => ({ papel, conteudo })).slice(-20) }),
    onSuccess: (r) =>
      setMensagens((m) => [...m, { papel: 'assistant', conteudo: r.texto, fontes: r.fontes, buscas: r.buscas, em: Date.now() }])
  });

  // "Pensando" vira "pesquisando" depois de uns segundos: com a internet, a
  // resposta demora, e o dono precisa saber que nao travou.
  const [pesquisando, setPesquisando] = useState(false);
  useEffect(() => {
    if (!perguntar.isPending) {
      setPesquisando(false);
      return undefined;
    }
    const t = setTimeout(() => setPesquisando(true), 3500);
    return () => clearTimeout(t);
  }, [perguntar.isPending]);

  useEffect(() => {
    if (aberto) fimRef.current?.scrollIntoView({ block: 'end' });
  }, [aberto, mensagens.length, perguntar.isPending]);

  useEffect(() => {
    if (!aberto) return undefined;
    campoRef.current?.focus();
    const tecla = (e) => e.key === 'Escape' && setAberto(false);
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [aberto]);

  function enviar(conteudo) {
    const pergunta = conteudo.trim();
    if (!pergunta || perguntar.isPending) return;
    const historico = [...mensagens, { papel: 'user', conteudo: pergunta, em: Date.now() }];
    setMensagens(historico);
    setTexto('');
    perguntar.reset();
    perguntar.mutate(historico);
  }

  const semChave = !cfg.temChave;

  return (
    <>
      {aberto && (
        <section className="hades" role="dialog" aria-label={`Conversa com ${cfg.nome}`}>
          <header className="hades__topo">
            <span className="hades__selo" aria-hidden="true">
              <IconeHades />
            </span>
            <div className="crescer">
              <strong>{cfg.nome}</strong>
              <small>Assistente administrativo{cfg.pesquisaWeb ? ' · com pesquisa na internet' : ''}</small>
            </div>
            {mensagens.length > 0 && (
              <button type="button" className="hades__acao" onClick={() => setMensagens([])} title="Começar uma conversa nova">
                Nova conversa
              </button>
            )}
            <button type="button" className="hades__fechar" onClick={() => setAberto(false)} aria-label="Fechar">
              ×
            </button>
          </header>

          <div className="hades__fio" aria-live="polite">
            {semChave ? (
              <div className="hades__vazio">
                <p>
                  O {cfg.nome} ainda não tem uma chave de API.{' '}
                  <Link to="/ia?aba=personas&agente=hades" onClick={() => setAberto(false)}>
                    Configure em Inteligência Artificial › Agentes › {cfg.nome}
                  </Link>
                  .
                </p>
              </div>
            ) : mensagens.length === 0 ? (
              <div className="hades__vazio">
                <p>
                  Olá. Eu olho os números do seu negócio e o que está acontecendo no ramo lá fora. Pergunte o que
                  quiser — ou comece por uma destas:
                </p>
                <div className="hades__sugestoes">
                  {SUGESTOES.map((s) => (
                    <button key={s} type="button" onClick={() => enviar(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              mensagens.map((m, i) => (
                <div key={`${m.em}-${i}`} className={`hades__msg hades__msg--${m.papel === 'user' ? 'dono' : 'hades'}`}>
                  <div className="hades__balao">
                    {m.papel === 'user' ? m.conteudo : <Markdown texto={m.conteudo} />}
                  </div>
                  {m.fontes?.length > 0 && (
                    <div className="hades__fontes">
                      <span>Fontes:</span>
                      {m.fontes.map((f) => (
                        <a key={f.url} href={f.url} target="_blank" rel="noopener noreferrer" title={f.titulo}>
                          {f.titulo}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
            {perguntar.isPending && (
              <div className="hades__msg hades__msg--hades">
                <div className="hades__balao hades__balao--pensando" role="status">
                  <span className="hades__pontos" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  {pesquisando && cfg.pesquisaWeb ? 'Pesquisando e analisando…' : 'Pensando…'}
                </div>
              </div>
            )}
            {perguntar.isError && (
              <div className="hades__erro" role="alert">
                {perguntar.error.message}{' '}
                <button type="button" onClick={() => perguntar.mutate(mensagens)}>
                  Tentar de novo
                </button>
              </div>
            )}
            <div ref={fimRef} />
          </div>

          <form
            className="hades__compositor"
            onSubmit={(e) => {
              e.preventDefault();
              enviar(texto);
            }}
          >
            <textarea
              ref={campoRef}
              value={texto}
              rows={1}
              disabled={semChave}
              placeholder={`Pergunte ao ${cfg.nome}…`}
              aria-label={`Mensagem para o ${cfg.nome}`}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={(e) => {
                // Enter envia; Shift+Enter quebra a linha.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  enviar(texto);
                }
              }}
            />
            <button type="submit" disabled={semChave || !texto.trim() || perguntar.isPending} aria-label="Enviar">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h13M13 6l6 6-6 6" />
              </svg>
            </button>
          </form>
        </section>
      )}

      <button
        type="button"
        className={`hades-botao${aberto ? ' hades-botao--aberto' : ''}`}
        onClick={() => setAberto((a) => !a)}
        aria-expanded={aberto}
        aria-label={aberto ? `Fechar ${cfg.nome}` : `Abrir ${cfg.nome}, o assistente administrativo`}
        title={cfg.nome}
      >
        <IconeHades />
      </button>
    </>
  );
}

/** Elmo com chama: o Hades. */
function IconeHades() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2.5c1.6 2 3.8 3.2 3.8 6 0 1.4-.7 2.4-1.5 3 .1-1.3-.5-2.4-1.5-3-.2 1.4-1.3 2.1-2.1 2.8-.8.7-1.2 1.4-1.2 2.4" />
      <path d="M5 13.5c0-3 2-5.2 4-6.2M19 13.5c0-1.3-.4-2.5-1-3.5" />
      <path d="M5 13.5v2.8c0 1.5 1 2.7 2.4 3.1L9 20v-3.5h6V20l1.6-.6c1.4-.4 2.4-1.6 2.4-3.1v-2.8" />
      <path d="M9 16.5v-2h6v2" />
    </svg>
  );
}

// ─── Markdown simples e seguro (sem HTML injetado) ─────────────────────────

/** **negrito**, *italico* ou _italico_, `codigo` e [links](https://...) dentro de uma linha. */
function Inline({ texto }) {
  const partes = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_(?!\w)|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let ultimo = 0;
  let m;
  let i = 0;
  while ((m = re.exec(texto))) {
    if (m.index > ultimo) partes.push(texto.slice(ultimo, m.index));
    const t = m[0];
    if (t.startsWith('**')) partes.push(<strong key={i++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) partes.push(<code key={i++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const rotulo = t.slice(1, t.indexOf(']'));
      partes.push(
        <a key={i++} href={m[2]} target="_blank" rel="noopener noreferrer">
          {rotulo}
        </a>
      );
    } else partes.push(<em key={i++}>{t.slice(1, -1)}</em>);
    ultimo = m.index + t.length;
  }
  if (ultimo < texto.length) partes.push(texto.slice(ultimo));
  return partes.map((p, k) => <Fragment key={k}>{p}</Fragment>);
}

/** Paragrafos, titulos (#) e listas (- , * , 1.). */
function Markdown({ texto }) {
  const blocos = [];
  let lista = null;
  const fecharLista = () => {
    if (lista) blocos.push(lista);
    lista = null;
  };
  for (const linhaCrua of String(texto).split('\n')) {
    const linha = linhaCrua.trimEnd();
    const item = linha.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
    if (item) {
      const tipo = item[1] ? 'ol' : 'ul';
      if (!lista || lista.tipo !== tipo) {
        fecharLista();
        lista = { tipo, itens: [] };
      }
      lista.itens.push(item[2]);
      continue;
    }
    fecharLista();
    if (!linha.trim()) continue;
    const titulo = linha.match(/^#{1,6}\s+(.*)$/);
    blocos.push(titulo ? { tipo: 'h', texto: titulo[1] } : { tipo: 'p', texto: linha });
  }
  fecharLista();

  return (
    <div className="hades__md">
      {blocos.map((b, i) => {
        if (b.tipo === 'h') return <h4 key={i}><Inline texto={b.texto} /></h4>;
        if (b.tipo === 'p') return <p key={i}><Inline texto={b.texto} /></p>;
        const Lista = b.tipo;
        return (
          <Lista key={i}>
            {b.itens.map((t, j) => (
              <li key={j}>
                <Inline texto={t} />
              </li>
            ))}
          </Lista>
        );
      })}
    </div>
  );
}
