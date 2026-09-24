import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/autenticacao.jsx';
import { useFuncoes } from '../../lib/funcoes.jsx';
import { Botao } from '../../componentes/ui.jsx';
import { GravarAudio } from './GravarAudio.jsx';
import { SeletorEmoji } from './SeletorEmoji.jsx';
import { PreviaAnexo } from './PreviaAnexo.jsx';
import './Compositor.css';

/**
 * Barra de envio do livechat, no molde do WhatsApp Web:
 *
 *   [😊] [📎] [⚡]  [ campo de texto ........ ]  [🎤 ou ➤]
 *
 * - 😊 abre os emojis; eles entram onde o cursor estava.
 * - 📎 abre o menu de anexos (Documento, Fotos, Vídeo). O arquivo escolhido
 *   abre uma PREVIA com campo de legenda antes de sair — ninguem manda o
 *   arquivo errado para um cliente por um clique so.
 * - ⚡ (ou digitar "/" no comeco) abre as respostas rapidas da pessoa logada.
 * - Campo vazio mostra o microfone; com texto, o botao de enviar.
 */

/** Limite do WhatsApp para midia; o servidor confere de novo. */
const LIMITE_BYTES = 16 * 1024 * 1024;

const TIPOS_ANEXO = {
  documento: {
    rotulo: 'Documento',
    cor: '#7f66ff',
    accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.txt,.csv,.zip,.rar'
  },
  imagem: { rotulo: 'Fotos', cor: '#007bfc', accept: 'image/png,image/jpeg,image/webp,image/gif' },
  video: { rotulo: 'Vídeo', cor: '#ff2e74', accept: 'video/mp4,video/3gpp,video/quicktime' }
};

const EXTENSOES_DOC = TIPOS_ANEXO.documento.accept.split(',').map((e) => e.slice(1));

/** Decide o tipo do anexo pelo arquivo, nao pelo botao: quem colou uma imagem nao clicou em "Fotos". */
function tipoDoArquivo(arquivo) {
  if (TIPOS_ANEXO.imagem.accept.split(',').includes(arquivo.type)) return 'imagem';
  if (TIPOS_ANEXO.video.accept.split(',').includes(arquivo.type)) return 'video';
  const ext = arquivo.name.includes('.') ? arquivo.name.split('.').pop().toLowerCase() : '';
  return EXTENSOES_DOC.includes(ext) ? 'documento' : null;
}

export function tamanhoLegivel(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

function lerComoDataUrl(arquivo) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.onerror = () => reject(leitor.error);
    leitor.readAsDataURL(arquivo);
  });
}

function saudacao() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

const primeiroNome = (nome) => String(nome ?? '').trim().split(/\s+/)[0] ?? '';

/**
 * Cores dos cartoes de resposta rapida. Fica LONGE de laranja e verde-agua de
 * proposito: essas duas ja tem dono no sistema (verde-agua = Atena, e o
 * laranja e a cor do subchat dela aqui do lado) — usa-las aqui confundiria.
 */
const PALETA_CARTOES = ['#7f66ff', '#3b82f6', '#ec4899', '#22c55e', '#ef4444', '#6366f1'];

/** Troca as variaveis da resposta rapida pelos dados desta conversa. */
export function preencherVariaveis(texto, { cliente, atendente }) {
  return texto
    .replace(/\{nome\}/gi, primeiroNome(cliente) || 'tudo bem')
    .replace(/\{atendente\}/gi, primeiroNome(atendente))
    .replace(/\{saudacao\}/gi, saudacao());
}

/**
 * @param {object} p
 * @param {string} p.texto
 * @param {(t: string) => void} p.setTexto
 * @param {() => void} p.aoEnviarTexto
 * @param {(dataUrl: string, duracao: number) => void} p.aoEnviarAudio
 * @param {(anexo: { dataUrl: string, nome: string, legenda: string }) => void} p.aoEnviarAnexo
 * @param {boolean} p.enviando
 * @param {string} p.nomeCliente
 * @param {string} p.conversationId
 */
export function Compositor({ texto, setTexto, aoEnviarTexto, aoEnviarAudio, aoEnviarAnexo, enviando, nomeCliente, conversationId }) {
  const { usuario } = useAuth();
  const queryClient = useQueryClient();
  const [gravando, setGravando] = useState(false);
  const [painel, setPainel] = useState(null); // 'emoji' | 'anexo' | 'respostas' | null
  const [aba, setAba] = useState('respostas'); // dentro do painel de respostas: 'respostas' | 'atena'
  // Atena desligada pelo DEV: a aba some (um "/atena" digitado ainda chega a
  // API, que responde que ela esta desligada — nunca vai parar no cliente).
  const atenaLigada = useFuncoes().ligada('agente_atena');
  const [anexo, setAnexo] = useState(null); // { arquivo, tipo, dataUrl }
  const [erro, setErro] = useState(null);
  const [destaque, setDestaque] = useState(0);

  // O subchat da Atena: efemero (nao grava nada aqui). O pedido e a resposta
  // JA ficam registrados de verdade na conversa pelo `/api/atena/comando` —
  // esta lista e so a conveniencia de ver a troca sem sair do compositor.
  const [turnosAtena, setTurnosAtena] = useState([]); // [{ pedido, resposta? , erro? }]
  const [pedidoAtena, setPedidoAtena] = useState('');

  const campoRef = useRef(null);
  const campoAtenaRef = useRef(null);
  const fimAtenaRef = useRef(null);
  const raizRef = useRef(null);
  const selecaoRef = useRef({ inicio: 0, fim: 0 });
  const entradasRef = useRef({});

  const respostas = useQuery({
    queryKey: ['respostas-rapidas'],
    queryFn: () => api.get('/api/perfil/respostas-rapidas'),
    staleTime: 60_000
  });

  // Mesma rota que o "/atena ..." digitado direto no campo principal — as
  // mesmas ferramentas e travas, e o resultado tambem fica gravado na
  // conversa como aviso de sistema. Aqui so muda o lugar de onde se pede.
  const pedirAtena = useMutation({
    mutationFn: (comando) => api.post('/api/atena/comando', { conversationId, comando }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversa', conversationId] });
      queryClient.invalidateQueries({ queryKey: ['quadro'] });
      queryClient.invalidateQueries({ queryKey: ['conversas'] });
    }
  });

  async function enviarParaAtena(e) {
    e.preventDefault();
    const pedido = pedidoAtena.trim();
    if (!pedido || pedirAtena.isPending) return;
    setPedidoAtena('');
    const indice = turnosAtena.length;
    setTurnosAtena((t) => [...t, { pedido }]);
    try {
      const r = await pedirAtena.mutateAsync(pedido);
      setTurnosAtena((t) => t.map((x, i) => (i === indice ? { ...x, resposta: r.resposta } : x)));
    } catch (err) {
      setTurnosAtena((t) => t.map((x, i) => (i === indice ? { ...x, erro: err.message } : x)));
    }
  }

  useEffect(() => {
    fimAtenaRef.current?.scrollIntoView({ block: 'end' });
  }, [turnosAtena.length]);

  // Fecha o painel aberto ao clicar fora da barra ou apertar Esc.
  useEffect(() => {
    if (!painel) return undefined;
    const fora = (e) => {
      if (!raizRef.current?.contains(e.target)) setPainel(null);
    };
    const esc = (e) => e.key === 'Escape' && setPainel(null);
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', fora);
      document.removeEventListener('keydown', esc);
    };
  }, [painel]);

  // "/" no comeco do campo, ainda sem espaco, e o gatilho das respostas rapidas
  // — o mesmo do WhatsApp Business. Depois do espaco, e texto normal (ou o
  // pedido de um "/atena ...").
  const digitandoAtalho = /^\/[^\s]*$/.test(texto);
  const listaAberta = painel === 'respostas' || digitandoAtalho;
  const termo = digitandoAtalho ? texto.slice(1).toLowerCase() : '';

  // Digitar "/" e sempre sobre BUSCAR uma resposta — se a pessoa estava na
  // aba da Atena, volta para a lista em vez de esconder o que ela digitou.
  useEffect(() => {
    if (digitandoAtalho) setAba('respostas');
  }, [digitandoAtalho]);

  // Cor por ID, pela ordem da lista COMPLETA (nao da filtrada): assim cada
  // resposta tem sempre a mesma cor, e ate 6 respostas ficam todas distintas
  // — sem isso, um hash por atalho colidia e repetia cor sem necessidade.
  const coresPorId = useMemo(() => {
    const mapa = new Map();
    (respostas.data?.respostas ?? []).forEach((r, i) => mapa.set(r.id, PALETA_CARTOES[i % PALETA_CARTOES.length]));
    return mapa;
  }, [respostas.data]);

  const opcoes = useMemo(() => {
    const minhas = respostas.data?.respostas ?? [];
    if (!termo) return minhas;
    // Quem casa pelo ATALHO vem antes de quem so tem o termo no meio do texto:
    // "/o" + Enter tem que pegar "/ola", nao "/endereco" (que tem "o" no texto).
    const peloAtalho = minhas.filter((o) => o.atalho.startsWith(termo));
    const peloTexto = minhas.filter((o) => !o.atalho.startsWith(termo) && o.texto.toLowerCase().includes(termo));
    return [...peloAtalho, ...peloTexto];
  }, [respostas.data, termo]);

  useEffect(() => setDestaque(0), [termo, listaAberta]);

  // O campo cresce com o texto (ate um teto) em vez de rolar dentro de duas linhas.
  useEffect(() => {
    const c = campoRef.current;
    if (!c) return;
    c.style.height = 'auto';
    c.style.height = `${Math.min(c.scrollHeight, 140)}px`;
  }, [texto, gravando]);

  function lembrarCursor() {
    const c = campoRef.current;
    if (c) selecaoRef.current = { inicio: c.selectionStart, fim: c.selectionEnd };
  }

  function focarNoFim(valor) {
    requestAnimationFrame(() => {
      const c = campoRef.current;
      if (!c) return;
      c.focus();
      c.setSelectionRange(valor.length, valor.length);
    });
  }

  function inserirEmoji(emoji) {
    const { inicio, fim } = selecaoRef.current;
    const novo = texto.slice(0, inicio) + emoji + texto.slice(fim);
    setTexto(novo);
    const pos = inicio + emoji.length;
    selecaoRef.current = { inicio: pos, fim: pos };
    requestAnimationFrame(() => {
      campoRef.current?.focus();
      campoRef.current?.setSelectionRange(pos, pos);
    });
  }

  function escolherOpcao(o) {
    const valor = preencherVariaveis(o.texto, { cliente: nomeCliente, atendente: usuario?.nome });
    setTexto(valor);
    setPainel(null);
    focarNoFim(valor);
  }

  /** Troca de chip: limpa um "/atalho" pela metade para a aba escolhida realmente aparecer. */
  function irParaAba(nova) {
    setAba(nova);
    if (/^\//.test(texto)) setTexto('');
    if (nova === 'atena') requestAnimationFrame(() => campoAtenaRef.current?.focus());
  }

  async function abrirArquivo(arquivo) {
    setErro(null);
    setPainel(null);
    if (!arquivo) return;
    const tipo = tipoDoArquivo(arquivo);
    if (!tipo) {
      setErro('Tipo de arquivo não aceito. Use foto (PNG, JPG, WEBP, GIF), vídeo MP4 ou documento (PDF, Word, Excel…).');
      return;
    }
    if (arquivo.size > LIMITE_BYTES) {
      setErro(`O arquivo tem ${tamanhoLegivel(arquivo.size)}. O limite do WhatsApp é 16 MB.`);
      return;
    }
    try {
      setAnexo({ arquivo, tipo, dataUrl: await lerComoDataUrl(arquivo) });
    } catch {
      setErro('Não consegui ler este arquivo.');
    }
  }

  function aoColar(e) {
    const item = [...(e.clipboardData?.files ?? [])][0];
    if (item) {
      e.preventDefault();
      abrirArquivo(item);
    }
  }

  function aoTeclar(e) {
    // As setas/Enter so escolhem um cartao na aba de respostas: na aba da
    // Atena, o Enter do campo principal e so o Enter do campo principal.
    if (listaAberta && aba === 'respostas' && opcoes.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setDestaque((d) => (d + 1) % opcoes.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setDestaque((d) => (d - 1 + opcoes.length) % opcoes.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        escolherOpcao(opcoes[Math.min(destaque, opcoes.length - 1)]);
        return;
      }
    }
    if (e.key === 'Escape' && listaAberta) {
      e.preventDefault();
      setPainel(null);
      if (digitandoAtalho) setTexto('');
      return;
    }
    // Enter envia; Shift+Enter quebra linha — a convencao de todo app de mensagem.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      aoEnviarTexto();
    }
  }

  const alternar = (p) => setPainel((atual) => (atual === p ? null : p));
  const ehAtena = /^\/atena(\s|$)/i.test(texto);
  const temTexto = texto.trim().length > 0;

  if (anexo) {
    return (
      <PreviaAnexo
        anexo={anexo}
        // O que ja estava digitado vira a legenda, como no WhatsApp Web.
        legendaInicial={/^\//.test(texto) ? '' : texto}
        enviando={enviando}
        aoCancelar={() => setAnexo(null)}
        aoEnviar={(pronto) => {
          aoEnviarAnexo(pronto);
          setAnexo(null);
        }}
      />
    );
  }

  return (
    <div className="compositor" ref={raizRef}>
      {erro && (
        <div className="compositor__erro" role="alert">
          <span>{erro}</span>
          <button type="button" onClick={() => setErro(null)} aria-label="Fechar aviso">×</button>
        </div>
      )}

      {painel === 'emoji' && (
        <div className="compositor__painel compositor__painel--emoji">
          <SeletorEmoji aoEscolher={inserirEmoji} />
        </div>
      )}

      {painel === 'anexo' && (
        <div className="compositor__painel compositor__painel--anexo" role="menu" aria-label="Anexar">
          {Object.entries(TIPOS_ANEXO).map(([chave, t]) => (
            <button
              key={chave}
              type="button"
              role="menuitem"
              className="anexar__item"
              onClick={() => entradasRef.current[chave]?.click()}
            >
              <span className="anexar__icone" style={{ background: t.cor }} aria-hidden="true">
                <IconeAnexo tipo={chave} />
              </span>
              {t.rotulo}
            </button>
          ))}
        </div>
      )}

      {listaAberta && !gravando && (
        <div
          className={`compositor__painel compositor__painel--respostas${aba === 'atena' ? ' compositor__painel--atena' : ''}`}
          role="region"
          aria-label={aba === 'atena' ? 'Falar com a Atena' : 'Respostas rápidas'}
        >
          <div className="respostas__chips" role="tablist" aria-label="Assistente do compositor">
            <button
              type="button"
              role="tab"
              aria-selected={aba === 'respostas'}
              className={`respostas__chip${aba === 'respostas' ? ' respostas__chip--ativo' : ''}`}
              onClick={() => irParaAba('respostas')}
            >
              <span aria-hidden="true">⚡</span> Respostas rápidas
            </button>
            {atenaLigada && (
              <button
                type="button"
                role="tab"
                aria-selected={aba === 'atena'}
                className={`respostas__chip respostas__chip--atena${aba === 'atena' ? ' respostas__chip--ativo' : ''}`}
                onClick={() => irParaAba('atena')}
              >
                <span aria-hidden="true">🧠</span> Falar com Atena
              </button>
            )}
            {aba === 'respostas' && (
              <Link to="/perfil#respostas" className="respostas__gerenciar">
                Gerenciar
              </Link>
            )}
          </div>

          {aba === 'respostas' ? (
            <div className="respostas__cartoes" role="listbox" aria-label="Respostas rápidas">
              {opcoes.map((o, i) => {
                const cor = coresPorId.get(o.id) ?? PALETA_CARTOES[0];
                return (
                  <button
                    key={o.id}
                    type="button"
                    role="option"
                    aria-selected={i === destaque}
                    className={`cartao-resposta${i === destaque ? ' cartao-resposta--ativo' : ''}`}
                    style={{ '--cor-cartao': cor }}
                    onMouseEnter={() => setDestaque(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => escolherOpcao(o)}
                  >
                    <span className="cartao-resposta__atalho">/{o.atalho}</span>
                    <span className="cartao-resposta__texto">{o.texto}</span>
                  </button>
                );
              })}
              {(respostas.data?.respostas ?? []).length === 0 && !respostas.isLoading && (
                <p className="respostas__vazio">
                  Você ainda não tem respostas rápidas. <Link to="/perfil#respostas">Crie as suas no seu perfil</Link>.
                </p>
              )}
              {opcoes.length === 0 && (respostas.data?.respostas ?? []).length > 0 && (
                <p className="respostas__vazio">
                  Nenhuma resposta com "/{termo}". {termo && 'atena'.startsWith(termo) && 'Toque em "Falar com Atena" acima.'}
                </p>
              )}
            </div>
          ) : (
            <div className="atena-chat">
              <div className="atena-chat__conversa">
                {turnosAtena.length === 0 && (
                  <p className="atena-chat__intro">
                    Peça pra remarcar, cancelar ou consultar algo sobre <strong>{nomeCliente || 'este cliente'}</strong>. O
                    que combinarem fica registrado na conversa — o cliente nunca vê.
                  </p>
                )}
                {turnosAtena.map((t, i) => (
                  <div key={i} className="atena-chat__turno">
                    <div className="atena-chat__balao atena-chat__balao--pedido">{t.pedido}</div>
                    {t.erro ? (
                      <div className="atena-chat__balao atena-chat__balao--erro">Não deu: {t.erro}</div>
                    ) : t.resposta !== undefined ? (
                      <div className="atena-chat__balao atena-chat__balao--resposta">
                        <span className="atena-chat__selo">🧠 Atena</span>
                        {t.resposta}
                      </div>
                    ) : (
                      <div className="atena-chat__balao atena-chat__balao--pensando">
                        <span className="atena-chat__selo">🧠 Atena</span>
                        <span className="atena-chat__pontos" aria-hidden="true"><i /><i /><i /></span>
                        pensando…
                      </div>
                    )}
                  </div>
                ))}
                <div ref={fimAtenaRef} />
              </div>
              <form className="atena-chat__envio" onSubmit={enviarParaAtena}>
                <input
                  ref={campoAtenaRef}
                  className="atena-chat__campo"
                  value={pedidoAtena}
                  onChange={(e) => setPedidoAtena(e.target.value)}
                  placeholder="Ex.: remarcar para sexta às 15h"
                  maxLength={500}
                  aria-label="Pedido para a Atena"
                />
                <button
                  type="submit"
                  className="atena-chat__enviar"
                  disabled={!pedidoAtena.trim() || pedirAtena.isPending}
                  aria-label="Pedir à Atena"
                  title="Pedir à Atena"
                >
                  {pedirAtena.isPending ? <span className="compositor__girando" aria-hidden="true" /> : <IconeEnviar />}
                </button>
              </form>
            </div>
          )}
        </div>
      )}

      {Object.entries(TIPOS_ANEXO).map(([chave, t]) => (
        <input
          key={chave}
          ref={(el) => {
            entradasRef.current[chave] = el;
          }}
          type="file"
          accept={t.accept}
          hidden
          onChange={(e) => {
            abrirArquivo(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      ))}

      <form
        className="compositor__barra"
        onSubmit={(e) => {
          e.preventDefault();
          aoEnviarTexto();
        }}
      >
        {/* Gravando, o resto some: nao da para escrever e gravar ao mesmo tempo. */}
        {!gravando && (
          <div className="compositor__ferramentas">
            <BotaoIcone rotulo="Emojis" ativo={painel === 'emoji'} onClick={() => { lembrarCursor(); alternar('emoji'); }}>
              <IconeEmoji />
            </BotaoIcone>
            <BotaoIcone rotulo="Anexar arquivo, foto ou vídeo" ativo={painel === 'anexo'} onClick={() => alternar('anexo')}>
              <IconeClipe />
            </BotaoIcone>
            <BotaoIcone rotulo="Respostas rápidas (ou digite /)" ativo={painel === 'respostas'} onClick={() => alternar('respostas')}>
              <IconeRaio />
            </BotaoIcone>
          </div>
        )}

        {!gravando && (
          <textarea
            ref={campoRef}
            className="compositor__campo"
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={aoTeclar}
            onKeyUp={lembrarCursor}
            onClick={lembrarCursor}
            onBlur={lembrarCursor}
            onPaste={aoColar}
            placeholder="Mensagem  ·  / para respostas rápidas"
            rows={1}
            aria-label="Mensagem"
          />
        )}

        {temTexto && !gravando ? (
          ehAtena ? (
            <Botao type="submit" carregando={enviando} disabled={enviando}>
              Pedir à Atena
            </Botao>
          ) : (
            <button type="submit" className="compositor__enviar" disabled={enviando} aria-label="Enviar" title="Enviar (Enter)">
              {enviando ? <span className="compositor__girando" aria-hidden="true" /> : <IconeEnviar />}
            </button>
          )
        ) : (
          <GravarAudio aoGravar={aoEnviarAudio} desabilitado={enviando} aoAlternar={setGravando} />
        )}
      </form>
    </div>
  );
}

function BotaoIcone({ rotulo, ativo, onClick, children }) {
  return (
    <button
      type="button"
      className={`compositor__icone${ativo ? ' compositor__icone--ativo' : ''}`}
      onClick={onClick}
      aria-label={rotulo}
      aria-expanded={ativo}
      title={rotulo}
    >
      {children}
    </button>
  );
}

const svg = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false };

function IconeEmoji() {
  return (
    <svg {...svg}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      <circle cx="9" cy="10" r="0.6" fill="currentColor" />
      <circle cx="15" cy="10" r="0.6" fill="currentColor" />
    </svg>
  );
}

function IconeClipe() {
  return (
    <svg {...svg}>
      <path d="M21 11.5 12.6 19.9a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />
    </svg>
  );
}

function IconeRaio() {
  return (
    <svg {...svg}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </svg>
  );
}

export function IconeEnviar() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z" />
    </svg>
  );
}

export function IconeAnexo({ tipo }) {
  const p = { ...svg, width: 20, height: 20, stroke: '#fff', strokeWidth: 2 };
  if (tipo === 'imagem') {
    return (
      <svg {...p}>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8.5" cy="8.5" r="1.6" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    );
  }
  if (tipo === 'video') {
    return (
      <svg {...p}>
        <rect x="2" y="6" width="14" height="12" rx="2" />
        <path d="m22 8-6 4 6 4z" />
      </svg>
    );
  }
  return (
    <svg {...p}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h5" />
    </svg>
  );
}
