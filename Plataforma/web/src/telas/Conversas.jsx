import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Aviso, Botao, Campo, Carregando, FotoLead, Modal, Status, Vazio } from '../componentes/ui.jsx';
import { TextoWhatsapp } from '../lib/TextoWhatsapp.jsx';
import { BalaoAudio } from './conversas/BalaoAudio.jsx';
import { Compositor, IconeAnexo, tamanhoLegivel } from './conversas/Compositor.jsx';
import { Humor } from './conversas/Humor.jsx';
import { PainelLead } from './conversas/PainelLead.jsx';
import { Transferir } from './conversas/Transferir.jsx';
import { useAuth } from '../lib/autenticacao.jsx';
import { PerfilAtendente } from './conversas/PerfilAtendente.jsx';
import { VistaAgendamentos, VistaFinalizados } from './conversas/Vistas.jsx';
import './Conversas.css';

/**
 * No celular a lista e a conversa sao "telas" diferentes: abrir uma conversa
 * (ou uma vista) EMPILHA no historico, para o voltar do Android — e o gesto de
 * voltar — fechar a conversa em vez de sair da mesa. No computador as duas
 * colunas estao lado a lado: trocar de conversa so substitui o endereco.
 */
const ehCelular = () => window.matchMedia('(max-width: 820px)').matches;

/**
 * Mesa de atendimento.
 *
 * Duas colunas: a lista de conversas e o fio da conversa escolhida.
 * No celular, uma de cada vez.
 */

/**
 * Os quatro filtros da mesa.
 *
 *   TODOS  — o que e MEU, com a IA ou com gente. So o dono enxerga tudo.
 *   HUMANO — clientes sendo atendidos por uma pessoa. A conversa so vem para
 *            ca quando o atendente ESCREVE (assumir sozinho nao basta).
 *   FILA   — o que a IA jogou para um humano atender. Sem dono, todos veem.
 *   SOFIA  — atendimento so da IA, ainda sem dono. Todos veem: e a vitrine de
 *            onde um atendente "pesca" um cliente ou o sistema atribui.
 */
const FILTROS = [
  { chave: 'todos', rotulo: 'Todos', dica: 'Suas conversas, com a IA ou com gente' },
  { chave: 'humano', rotulo: 'Humano', dica: 'Clientes que uma pessoa já respondeu' },
  { chave: 'fila', rotulo: 'Fila', dica: 'Pediram um atendente e esperam' },
  { chave: 'sofia', rotulo: 'Sofia', dica: 'Atendimento só da IA, sem dono ainda' }
];

function quando(ms) {
  if (!ms) return '';
  const data = new Date(ms);
  const agora = new Date();
  const mesmoDia = data.toDateString() === agora.toDateString();

  return mesmoDia
    ? data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/** Icone de cada tipo de canal. Canais novos entram aqui. */
const ICONE_CANAL = { whatsapp: '💬', telegram: '✈️', instagram: '📷', web: '🌐' };
/** O que dizer quando um filtro esta vazio: cada um esconde uma pergunta diferente. */
const DESCRICAO_VAZIA = {
  todos: 'Você ainda não tem conversas. Pegue uma na Sofia ou na Fila — ou espere o sistema atribuir uma a você.',
  humano: 'Nenhum cliente sendo atendido por uma pessoa. Uma conversa vem para cá quando você envia a primeira mensagem.',
  fila: 'Ninguém esperando por atendimento humano no momento.',
  sofia: 'Nenhum atendimento da IA sem dono agora. Quando um cliente estiver sendo atendido só pela Sofia, aparece aqui.'
};

const NOME_CANAL = { whatsapp: 'WhatsApp', telegram: 'Telegram', instagram: 'Instagram', web: 'Site' };

export function Conversas() {
  const [params, setParams] = useSearchParams();
  // Um link antigo (?filtro=ativas, minhas, bot, finalizadas) cai em "Todos" em
  // vez de mostrar uma lista sem aba correspondente.
  const pedido = params.get('filtro');
  const filtro = FILTROS.some((f) => f.chave === pedido) ? pedido : 'todos';
  const selecionada = params.get('id');
  const vista = ['finalizados', 'agendamentos'].includes(params.get('vista')) ? params.get('vista') : null;

  const queryClient = useQueryClient();
  const local = useLocation();
  const navegar = useNavigate();

  /** Vai para o novo endereco: empilhado no celular, substituido no computador. */
  function empilhar(novos) {
    if (ehCelular()) setParams(novos, { state: { empilhado: true } });
    else setParams(novos, { replace: true });
  }

  /** Fecha o que esta aberto: no celular, volta o que foi empilhado. */
  function desempilhar(novos) {
    if (local.state?.empilhado) navegar(-1);
    else setParams(novos, { replace: true });
  }

  // Conexoes: o filtro por canal so existe para o que esta CONECTADO agora.
  // Sem nenhuma conexao no ar nao ha o que separar, e a barra nem aparece.
  const canais = useQuery({
    queryKey: ['canais'],
    queryFn: () => api.get('/api/canais'),
    refetchInterval: 15_000
  });
  const conectados = (canais.data?.canais ?? []).filter((c) => c.status === 'conectado' && c.ativo !== false);
  const pedida = params.get('conexao');
  // Uma conexao que caiu depois de escolhida deixa de filtrar (senao a lista
  // ficaria vazia sem explicacao e sem a barra para desfazer).
  const conexao = conectados.some((c) => c.chave === pedida) ? pedida : null;

  const lista = useQuery({
    queryKey: ['conversas', filtro, conexao],
    queryFn: () => api.get('/api/conversas', { filtro, ...(conexao ? { instancia: conexao } : {}) }),
    // O tempo real (SSE, no layout) atualiza na hora. Este polling e so a rede
    // de seguranca para quando a conexao de eventos estiver fora do ar.
    refetchInterval: 30_000
  });

  const conversas = lista.data?.itens ?? [];

  // Quantos esperam na fila: o numero que faz alguem olhar a aba. Mesma consulta
  // do menu lateral, entao o cache e compartilhado (nao ha chamada extra).
  const metricas = useQuery({
    queryKey: ['conversas', 'metricas'],
    queryFn: () => api.get('/api/conversas/metricas', { dias: 1 }),
    refetchInterval: 20_000
  });
  const naFila = metricas.data?.naFila ?? 0;

  /** Abre uma conversa a partir da lista da esquerda: sai de qualquer vista aberta. */
  function abrir(id) {
    const novos = new URLSearchParams(params);
    novos.set('id', id);
    novos.delete('vista');
    empilhar(novos);
  }

  /** Abre uma conversa a partir de uma vista: ao voltar, cai de volta na vista. */
  function abrirDaVista(id) {
    const novos = new URLSearchParams(params);
    novos.set('id', id);
    empilhar(novos);
  }

  function escolherVista(v) {
    const novos = new URLSearchParams(params);
    novos.delete('id');
    if (v) novos.set('vista', v);
    else novos.delete('vista');
    if (v) empilhar(novos);
    else desempilhar(novos);
  }

  function trocarFiltro(chave) {
    const novos = new URLSearchParams();
    novos.set('filtro', chave);
    if (conexao) novos.set('conexao', conexao);
    setParams(novos, { replace: true });
  }

  function trocarConexao(chave) {
    const novos = new URLSearchParams(params);
    if (chave) novos.set('conexao', chave);
    else novos.delete('conexao');
    novos.delete('id');
    novos.delete('vista');
    setParams(novos, { replace: true });
  }

  return (
    <div className="mesa">
      <aside className={`mesa__lista ${selecionada || vista ? 'mesa__lista--escondida' : ''}`}>
        <PerfilAtendente vista={vista} aoEscolher={escolherVista} />

        {conectados.length > 0 && (
          <div className="mesa__canais" role="group" aria-label="Filtrar por canal">
            <button
              type="button"
              className={`mesa__canal ${!conexao ? 'mesa__canal--ativo' : ''}`}
              aria-pressed={!conexao}
              onClick={() => trocarConexao(null)}
              title="Todos os canais"
            >
              <span aria-hidden="true">🗂️</span>
              <span>Todos</span>
            </button>
            {conectados.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`mesa__canal ${conexao === c.chave ? 'mesa__canal--ativo' : ''}`}
                aria-pressed={conexao === c.chave}
                onClick={() => trocarConexao(c.chave)}
                title={`${NOME_CANAL[c.canal] ?? c.canal} — ${c.nome}`}
              >
                <span aria-hidden="true">{ICONE_CANAL[c.canal] ?? '💬'}</span>
                <span>{c.chave}</span>
                <span className="mesa__so-leitor"> {NOME_CANAL[c.canal] ?? c.canal}, {c.nome}</span>
              </button>
            ))}
          </div>
        )}

        <div className="mesa__filtros" role="tablist" aria-label="Filtrar conversas">
          {FILTROS.map((f) => (
            <button
              key={f.chave}
              role="tab"
              aria-selected={filtro === f.chave}
              className={`mesa__filtro ${filtro === f.chave ? 'mesa__filtro--ativo' : ''}`}
              onClick={() => trocarFiltro(f.chave)}
            >
              {f.rotulo}
              {f.chave === 'fila' && naFila > 0 && <span className="mesa__contagem">{naFila}</span>}
            </button>
          ))}
        </div>

        <div className="mesa__itens">
          {lista.isLoading ? (
            <Carregando />
          ) : conversas.length === 0 ? (
            <Vazio
              titulo="Nenhuma conversa aqui"
              descricao={DESCRICAO_VAZIA[filtro]}
            />
          ) : (
            conversas.map((c) => (
              <button
                key={c.id}
                className={`conversa ${selecionada === c.id ? 'conversa--ativa' : ''}`}
                onClick={() => abrir(c.id)}
              >
                <FotoLead nome={c.leadNome} url={c.leadFotoUrl} tamanho={38} />
                <div className="conversa__conteudo">
                <div className="conversa__topo">
                  <strong className="conversa__nome">{c.leadNome}</strong>
                  <span className={`conversa__hora${c.naoLidas > 0 ? ' conversa__hora--nova' : ''}`}>{quando(c.ultimaMensagemEm)}</span>
                </div>
                {/* Como no WhatsApp: o contador fica na linha da previa, nunca
                    disputa espaco com as etiquetas (ali ele era empurrado para
                    fora do cartao quando o nome do atendente era comprido). */}
                <div className="conversa__linha">
                  <span className="conversa__previa">{c.ultimaMensagemPreview || 'Sem mensagens'}</span>
                  {c.naoLidas > 0 && <span className="conversa__nao-lidas">{c.naoLidas}</span>}
                </div>
                <div className="conversa__rodape">
                  {c.canalChave && (
                    <span className="conversa__canal" title={`${NOME_CANAL[c.canal] ?? c.canal} — ${c.canalNome ?? c.canalChave}`}>
                      <span aria-hidden="true">{ICONE_CANAL[c.canal] ?? '💬'}</span> {c.canalChave}
                    </span>
                  )}
                  {/* Com atendente, o selo ja diz quem: "Com Camila" (o nome solto
                      numa coluna estreita virava "C..."). */}
                  <Status valor={c.status} rotulo={c.status === 'humana' && c.atendenteNome ? `Com ${c.atendenteNome.split(' ')[0]}` : undefined} />
                  <Humor valor={c.humor} compacto />
                  {c.atendenteNome && c.status !== 'humana' && (
                    <span className="conversa__atendente" title={`Com ${c.atendenteNome}`}>
                      {c.atendenteNome.split(' ')[0]}
                    </span>
                  )}
                </div>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className={`mesa__fio ${!selecionada && !vista ? 'mesa__fio--escondido' : ''}`}>
        {selecionada ? (
          <Fio
            key={selecionada}
            conversationId={selecionada}
            aoVoltar={() => {
              const novos = new URLSearchParams(params);
              novos.delete('id');
              desempilhar(novos);
            }}
            aoMudar={() => queryClient.invalidateQueries({ queryKey: ['conversas'] })}
            veioDeLista={Boolean(vista)}
          />
        ) : vista === 'finalizados' ? (
          <VistaFinalizados aoAbrir={abrirDaVista} aoVoltar={() => escolherVista(null)} />
        ) : vista === 'agendamentos' ? (
          <VistaAgendamentos aoAbrir={abrirDaVista} aoVoltar={() => escolherVista(null)} />
        ) : (
          <Vazio titulo="Escolha uma conversa" descricao="Selecione alguém na lista ao lado para ver o histórico e responder." />
        )}
      </section>
    </div>
  );
}

/**
 * Rascunho da resposta, por conversa, guardado no navegador.
 *
 * Sem isto, o texto que a atendente digitava sumia quando outra pessoa
 * assumia a conversa (a tela virava um aviso de erro) ou quando a pagina
 * recarregava. O localStorage fica num try/catch: em aba anonima ou com o
 * armazenamento bloqueado ele falha, e ai o rascunho vale so enquanto a tela
 * estiver aberta — como era antes.
 *
 * A chave leva QUEM escreve, alem da conversa: no computador da recepcao,
 * dividido pela equipe, a Bia nao pode abrir a conversa e dar de cara com o
 * rascunho que a Camila deixou (nem mandar sem querer).
 */
const chaveRascunho = (usuarioId, id) => `rascunho:${usuarioId ?? 'anonimo'}:${id}`;

function lerRascunho(usuarioId, id) {
  try {
    return localStorage.getItem(chaveRascunho(usuarioId, id)) ?? '';
  } catch {
    return '';
  }
}

function gravarRascunho(usuarioId, id, texto) {
  try {
    if (texto) localStorage.setItem(chaveRascunho(usuarioId, id), texto);
    else localStorage.removeItem(chaveRascunho(usuarioId, id));
  } catch {
    // Sem armazenamento: segue so na memoria da tela.
  }
}

function Fio({ conversationId, aoVoltar, aoMudar, veioDeLista = false }) {
  const queryClient = useQueryClient();
  const navegar = useNavigate();
  const { usuario, podeAcessar } = useAuth();
  const [texto, setTextoBruto] = useState(() => lerRascunho(usuario?.id, conversationId));
  // Aceita valor ou funcao, como o setState normal: todo o codigo que ja chama
  // setTexto continua igual, e o setTexto('') depois de enviar limpa o rascunho.
  const setTexto = (valor) =>
    setTextoBruto((atual) => {
      const novo = typeof valor === 'function' ? valor(atual) : valor;
      gravarRascunho(usuario?.id, conversationId, novo);
      return novo;
    });
  const [perfilAberto, setPerfilAberto] = useState(false);
  const [transferindo, setTransferindo] = useState(false);
  // "Finalizar" pede confirmacao: o botao fica ao lado de outros, e encerrar
  // tira o atendimento da lista — um clique errado nao pode fazer isso sozinho.
  const [confirmandoFim, setConfirmandoFim] = useState(false);
  const [resumoFim, setResumoFim] = useState('');
  const fimRef = useRef(null);

  const dados = useQuery({
    queryKey: ['conversa', conversationId],
    queryFn: () => api.get(`/api/conversas/${conversationId}/mensagens`),
    refetchInterval: 30_000
  });

  const conversa = dados.data?.conversa;
  const mensagens = dados.data?.mensagens ?? [];

  // Rola para a ultima mensagem sempre que chegar algo novo.
  useEffect(() => {
    fimRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [mensagens.length]);

  function recarregar() {
    queryClient.invalidateQueries({ queryKey: ['conversa', conversationId] });
    // Finalizar, assumir e devolver mexem no quadro de atendimento tambem.
    queryClient.invalidateQueries({ queryKey: ['quadro'] });
    aoMudar?.();
  }

  const responder = useMutation({
    // `payload` e `{ conteudo }` (texto) ou `{ audio, duracaoSegundos }`
    // (recado de voz) — o schema no servidor exige um OU outro.
    mutationFn: (payload) => api.post(`/api/conversas/${conversationId}/mensagens`, payload),
    onSuccess: () => {
      // A mensagem SEMPRE fica gravada na conversa, entao o campo limpa mesmo
      // quando a entrega falha. Quem avisa da falha e o aviso acima do campo
      // (a resposta traz `entrega`) e o botao "Reenviar" no proprio balao.
      setTexto('');
      recarregar();
    }
  });

  // "/atena <pedido>" nao vai para o cliente: e uma ordem para a Atena, que
  // executa com as mesmas ferramentas e travas de sempre.
  const comandoAtena = useMutation({
    mutationFn: (comando) => api.post('/api/atena/comando', { conversationId, comando }),
    onSuccess: () => {
      setTexto('');
      recarregar();
    }
  });

  function enviar() {
    const limpo = texto.trim();

    const ehComando = /^\/atena(\s|$)/i.test(limpo);
    if (ehComando) {
      const pedido = limpo.replace(/^\/atena\s*/i, '');
      if (!comandoAtena.isPending) comandoAtena.mutate(pedido);
      return;
    }

    // Enquanto uma resposta esta saindo, ignora novo envio: agora a mensagem
    // chega de verdade no WhatsApp do cliente, e dois Enter seguidos
    // mandariam a mesma resposta duas vezes.
    if (limpo && !responder.isPending) responder.mutate({ conteudo: limpo });
  }

  function enviarAudio(dataUrl, duracaoSegundos) {
    if (!responder.isPending) responder.mutate({ audio: dataUrl, duracaoSegundos });
  }

  function enviarAnexo({ dataUrl, nome, legenda }) {
    if (!responder.isPending) responder.mutate({ anexo: { dataUrl, nome }, ...(legenda ? { conteudo: legenda } : {}) });
  }

  const acao = useMutation({
    mutationFn: ({ rota, corpo }) => api.post(`/api/conversas/${conversationId}/${rota}`, corpo ?? {}),
    onSuccess: recarregar
  });

  if (dados.isLoading) return <Carregando />;
  // 404 aqui quase sempre e "a conversa deixou de ser sua" (outra pessoa
  // assumiu, ou ela foi transferida): o servidor responde "nao encontrada"
  // de proposito, para nao revelar quem atende. Em vez de um erro vermelho,
  // explicamos e devolvemos o que a pessoa tinha escrito.
  if (dados.isError && dados.error.status === 404) {
    return (
      <div className="fio fio--indisponivel">
        <Aviso tom="info">Esta conversa não está mais com você — outra pessoa assumiu ou ela foi transferida.</Aviso>
        {texto && (
          <div className="fio__rascunho-perdido">
            <p className="texto-fraco">O que você tinha escrito:</p>
            <blockquote>{texto}</blockquote>
            <Botao variante="secundario" onClick={() => navigator.clipboard?.writeText(texto)}>
              Copiar texto
            </Botao>
          </div>
        )}
        <div>
          <Botao onClick={aoVoltar}>Voltar para a lista</Botao>
        </div>
      </div>
    );
  }
  if (dados.isError) return <Aviso tom="perigo">{dados.error.message}</Aviso>;

  const finalizada = conversa.status === 'finalizada';
  const eMinha = conversa.assignedUserId === usuario?.id;

  // O servidor grava a resposta sempre, mas so consegue entregar no WhatsApp
  // se a sessao estiver de pe. So um `entregue === false` explicito e falha:
  // se a resposta vier sem `entrega` (servidor antigo), tratamos como sucesso
  // em vez de assustar o atendente com um aviso falso.
  const entrega = responder.data?.entrega;
  // Se a mensagem ja aparece como entregue na conversa (por exemplo depois de
  // um "Reenviar" bem-sucedido), o aviso some sozinho: ele seria mentira.
  const enviada = mensagens.find((m) => m.id === responder.data?.id);
  const entregaFalhou = entrega?.entregue === false && !enviada?.entregueEm;

  return (
    <div className={`fio-area${perfilAberto ? ' fio-area--com-painel' : ''}`}>
      <div className="fio">
      <header className="fio__topo">
        {/* No celular o botao sempre aparece (a lista some quando ha conversa
            aberta). No desktop so faz sentido quando se veio de uma das listas
            pessoais: la a conversa TROCOU a lista, e sem isto nao ha volta. */}
        <button
          className={`fio__voltar${veioDeLista ? ' fio__voltar--lista' : ''}`}
          onClick={aoVoltar}
          aria-label="Voltar para a lista"
          title="Voltar para a lista"
        >
          ‹
        </button>

        {/* O nome abre o perfil: e onde a mao vai procurar quem e a pessoa. */}
        <button
          type="button"
          className="fio__lead crescer"
          onClick={() => setPerfilAberto((a) => !a)}
          aria-expanded={perfilAberto}
          title="Ver o perfil do cliente"
        >
          <FotoLead nome={conversa.leadNome} url={conversa.leadFotoUrl} tamanho={38} />
          <span className="fio__lead-texto">
            <strong>{conversa.leadNome}</strong>
            <span className="texto-fraco">{conversa.leadTelefoneFormatado}</span>
          </span>
        </button>

        <Humor valor={conversa.humor} compacto />
        <Status valor={conversa.status} />
      </header>

      <div className="fio__acoes">
        {/* ASSUMIR = pescar: a conversa passa a ser minha. NAO cala a Sofia —
            isso so acontece quando eu escrevo a primeira mensagem. */}
        {!finalizada && !eMinha && (
          <Botao
            tamanho="sm"
            onClick={() => acao.mutate({ rota: 'assumir' })}
            carregando={acao.isPending && acao.variables?.rota === 'assumir'}
            title="Leva esta conversa para o seu Todos. A Sofia só se cala quando você enviar uma mensagem."
          >
            Assumir
          </Botao>
        )}
        {!finalizada && conversa.status !== 'bot' && (eMinha || podeAcessar('owner')) && (
          <Botao variante="secundario" tamanho="sm" onClick={() => acao.mutate({ rota: 'devolver' })}>
            Devolver para a IA
          </Botao>
        )}
        {!finalizada && (
          <Botao
            variante="secundario"
            tamanho="sm"
            onClick={() => setTransferindo(true)}
            title="Passa este atendimento para outro atendente"
          >
            Transferir
          </Botao>
        )}
        {!finalizada && (
          <Botao
            variante="fantasma"
            tamanho="sm"
            onClick={() => setConfirmandoFim(true)}
            title="Encerra o atendimento. Se ninguem escreveu resumo, a Atena escreve."
          >
            Finalizar
          </Botao>
        )}
        {!finalizada && (
          <Botao
            variante="fantasma"
            tamanho="sm"
            onClick={() => setTexto((t) => (/^\/atena/i.test(t) ? t : '/atena '))}
            title="Manda a Atena fazer algo por este cliente (remarcar, cancelar, consultar...)"
          >
            Pedir à Atena
          </Botao>
        )}
        {finalizada && (
          <Botao variante="secundario" tamanho="sm" onClick={() => acao.mutate({ rota: 'reabrir' })}>
            Reabrir
          </Botao>
        )}
      </div>

      {acao.isError && (
        <Aviso tom="perigo">
          {acao.error.message}
          {/* "Reabrir" recusado porque o cliente ja abriu outra conversa: leva
              direto para ela, em vez de a atendente ter de procurar na lista. */}
          {acao.error.detalhes?.conversaAtualId && (
            <>
              {' '}
              <Botao
                variante="secundario"
                tamanho="sm"
                onClick={() => navegar(`/conversas?id=${acao.error.detalhes.conversaAtualId}`)}
              >
                Abrir a conversa atual
              </Botao>
            </>
          )}
        </Aviso>
      )}

      {/* Dono da conversa, mas ainda sem ter escrito: explica o que falta, porque
          "e minha" e "estou atendendo" parecem a mesma coisa e nao sao. */}
      {eMinha && !finalizada && conversa.status === 'bot' && (
        <Aviso tom="info">
          Esta conversa é sua, mas a <strong>Sofia ainda responde</strong> ao cliente. Ela se cala assim que você
          enviar a primeira mensagem.
        </Aviso>
      )}
      {eMinha && !finalizada && conversa.status === 'na_fila' && (
        <Aviso tom="info">
          O cliente pediu um atendente e a Sofia já está calada. Envie a primeira mensagem para começar o
          atendimento.
        </Aviso>
      )}

      <div
        className="fio__mensagens"
        // A foto da ULTIMA mensagem termina de carregar depois da rolagem e
        // empurra o fim para baixo: rola de novo so nesse caso, para nao
        // arrancar quem esta lendo o historico mais acima.
        onLoadCapture={(e) => {
          const todas = e.currentTarget.querySelectorAll('.msg');
          if (todas[todas.length - 1]?.contains(e.target)) fimRef.current?.scrollIntoView({ block: 'end' });
        }}
      >
        {mensagens.map((m) => (
          <Mensagem key={m.id} mensagem={m} conversationId={conversationId} aoMudar={recarregar} />
        ))}
        <div ref={fimRef} />
      </div>

      {/* Nao apaga nem bloqueia o texto: a mensagem ja esta na conversa. O
          `role="alert"` do Aviso faz o leitor de tela anunciar na hora. */}
      {entregaFalhou && (
        <div className="fio__aviso">
          <Aviso tom="perigo" aoFechar={() => responder.reset()}>
            A mensagem foi salva, mas <strong>NÃO</strong> chegou ao cliente
            {entrega.erro ? `: ${entrega.erro}` : '.'}
          </Aviso>
        </div>
      )}

      {finalizada ? (
        <div className="fio__encerrado">
          Conversa finalizada. Reabra para voltar a responder.
          {conversa.resumo && <p className="texto-suave" style={{ marginTop: 'var(--e2)' }}>{conversa.resumo}</p>}
        </div>
      ) : (
        <Compositor
          texto={texto}
          setTexto={setTexto}
          aoEnviarTexto={enviar}
          aoEnviarAudio={enviarAudio}
          aoEnviarAnexo={enviarAnexo}
          enviando={responder.isPending || comandoAtena.isPending}
          nomeCliente={conversa.leadNome}
          conversationId={conversationId}
        />
      )}

      {responder.isError && <Aviso tom="perigo">{responder.error.message}</Aviso>}
      {comandoAtena.isError && <Aviso tom="perigo">{comandoAtena.error.message}</Aviso>}
      </div>

      {/* Fica a direita do fio, entrando por deslizamento. */}
      {perfilAberto && <PainelLead conversa={conversa} aoFechar={() => setPerfilAberto(false)} />}

      <Modal
        titulo="Finalizar atendimento"
        aberto={confirmandoFim}
        aoFechar={() => setConfirmandoFim(false)}
        rodape={
          <>
            <Botao variante="fantasma" onClick={() => setConfirmandoFim(false)}>
              Cancelar
            </Botao>
            <Botao
              carregando={acao.isPending && acao.variables?.rota === 'finalizar'}
              onClick={() => {
                const resumo = resumoFim.trim();
                acao.mutate(
                  { rota: 'finalizar', corpo: resumo ? { resumo } : {} },
                  {
                    onSuccess: () => {
                      setConfirmandoFim(false);
                      setResumoFim('');
                    }
                  }
                );
              }}
            >
              Finalizar
            </Botao>
          </>
        }
      >
        <p>O atendimento sai da sua lista. Se o cliente escrever de novo, uma conversa nova começa.</p>
        <Campo rotulo="Resumo (opcional)">
          <textarea
            className="entrada entrada--area"
            rows={3}
            placeholder="Em branco, a Atena escreve o resumo em segundo plano."
            value={resumoFim}
            onChange={(e) => setResumoFim(e.target.value)}
          />
        </Campo>
        {acao.isError && acao.variables?.rota === 'finalizar' && <Aviso tom="perigo">{acao.error.message}</Aviso>}
      </Modal>

      {transferindo && (
        <Transferir
          conversationId={conversationId}
          aoFechar={() => setTransferindo(false)}
          aoTransferir={() => {
            setTransferindo(false);
            // Depois de transferir, a conversa some da mesa de quem transferiu:
            // voltar para a lista evita a tela tentar recarregar algo que ela
            // nao enxerga mais e mostrar um erro sem sentido.
            recarregar();
            aoVoltar();
          }}
        />
      )}
    </div>
  );
}

function Mensagem({ mensagem: m, conversationId, aoMudar }) {
  // Aviso do sistema (transferencia) nao e fala de ninguem: fica centralizado.
  if (m.autorTipo === 'sistema') {
    return (
      <div className="msg msg--sistema">
        <div className="msg__sistema-card">
          <span className="msg__sistema-icone" aria-hidden="true">⚙</span>
          <p className="msg__sistema-texto">{m.conteudo}</p>
        </div>
      </div>
    );
  }

  const doCliente = m.direcao === 'entrada';
  const autor =
    m.autorTipo === 'ia' ? 'IA'
    : m.autorTipo === 'menu' ? 'Menu'
    : m.autorNome ?? 'Atendente';

  // So vira player quando o arquivo existe de verdade: um audio antigo cujo
  // arquivo sumiu deve cair no texto (a transcricao), nao num player mudo.
  const ehAudio = m.tipo === 'audio' && Boolean(m.midiaUrl);
  const ehAnexo = ['imagem', 'video', 'documento'].includes(m.tipo) && Boolean(m.midiaUrl);

  // Estado de entrega so faz sentido para o que NOS mandamos: mensagem do
  // cliente ja chegou, por definicao.
  const falhou = !doCliente && Boolean(m.erroEnvio);
  // Tique discreto so quando o servidor confirmou a entrega de uma resposta de
  // atendente. Sem confirmacao (mensagens antigas) nao afirmamos nada.
  const entregue = !doCliente && m.autorTipo === 'humano' && Boolean(m.entregueEm) && !falhou;

  return (
    <div className={`msg ${doCliente ? 'msg--cliente' : 'msg--nossa'}`}>
      <div className="msg__balao">
        {!doCliente && <div className="msg__autor">{autor}</div>}
        {/* Recado de voz: o balao vira player. O texto do audio e a propria
            transcricao, e ela aparece dentro do player, atras de um link —
            mostra-la aqui tambem seria a mesma frase duas vezes. */}
        {ehAudio ? (
          <BalaoAudio
            url={m.midiaUrl}
            transcricao={m.transcricao}
            duracaoSegundos={m.metadados?.duracaoSegundos}
            statusTranscricao={m.metadados?.statusTranscricao}
            criadaEm={m.createdAt}
          />
        ) : ehAnexo ? (
          <BalaoAnexo mensagem={m} />
        ) : (
          <div className="msg__texto"><TextoWhatsapp texto={m.conteudo} /></div>
        )}
        {/* Falha de envio precisa aparecer: a mensagem esta na tela mas o
            cliente nao recebeu. */}
        {falhou && <FalhaDeEnvio mensagem={m} conversationId={conversationId} aoMudar={aoMudar} />}
        <div className="msg__hora">
          {new Date(m.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          {entregue && (
            <span className="msg__entregue">
              {' · '}
              <span aria-hidden="true">✓ </span>
              Entregue
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Rotulos que o servidor usa como conteudo quando o anexo vai sem legenda. */
const ROTULO_SEM_LEGENDA = /^(📷 Foto|🎥 Vídeo|📄 .*)$/;

/**
 * Foto, video ou documento dentro do balao. A legenda vem de `metadados`
 * (anexo do atendente); sem ela, o conteudo so aparece se nao for o rotulo.
 */
function BalaoAnexo({ mensagem: m }) {
  const meta = m.metadados ?? {};
  const legenda = 'legenda' in meta ? meta.legenda : ROTULO_SEM_LEGENDA.test(m.conteudo) ? null : m.conteudo;
  const nome = meta.nomeArquivo ?? 'arquivo';
  const extensao = nome.includes('.') ? nome.split('.').pop().toUpperCase() : 'ARQ';

  return (
    <div className="msg__anexo">
      {m.tipo === 'imagem' && (
        <a href={m.midiaUrl} target="_blank" rel="noreferrer" title="Abrir a foto">
          <img className="msg__imagem" src={m.midiaUrl} alt={legenda || 'Foto enviada'} loading="lazy" />
        </a>
      )}
      {m.tipo === 'video' && <video className="msg__video" src={m.midiaUrl} controls preload="metadata" />}
      {m.tipo === 'documento' && (
        <a className="msg__documento" href={m.midiaUrl} download={nome} title={`Baixar ${nome}`}>
          <span className="msg__doc-icone" aria-hidden="true">
            <IconeAnexo tipo="documento" />
          </span>
          <span className="msg__doc-info">
            <strong className="msg__doc-nome">{nome}</strong>
            <span className="msg__doc-detalhe">
              {extensao}
              {meta.bytes ? ` · ${tamanhoLegivel(meta.bytes)}` : ''}
            </span>
          </span>
          <span className="msg__doc-baixar" aria-hidden="true">⭳</span>
        </a>
      )}
      {legenda && <div className="msg__texto msg__legenda"><TextoWhatsapp texto={legenda} /></div>}
    </div>
  );
}

/**
 * Selo "Nao entregue" dentro do balao, com o botao de tentar de novo.
 *
 * E um componente a parte porque so existe quando ha falha: assim cada balao
 * com problema tem o proprio estado de "reenviando", e os hooks nao ficam
 * atras do `return` antecipado da mensagem de sistema (hook condicional quebra
 * o React).
 */
function FalhaDeEnvio({ mensagem: m, conversationId, aoMudar }) {
  // Reenviar so vale para resposta de atendente que ainda nao foi entregue:
  // a IA e o menu tem o proprio fluxo, e o servidor recusaria.
  const podeReenviar = m.autorTipo === 'humano' && !m.entregueEm;

  const reenviar = useMutation({
    mutationFn: () => api.post(`/api/conversas/${conversationId}/mensagens/${m.id}/reenviar`, {}),
    // Atualiza a conversa (o selo some se entregou) e a lista ao lado. Tambem
    // quando o servidor recusa (409 "ja esta sendo enviada", 422): o estado
    // real pode ter mudado e a tela nao deve esperar o proximo polling.
    onSettled: aoMudar
  });

  const entrega = reenviar.data?.entrega;
  // Mesmo criterio do envio normal: so `entregue === false` explicito e falha.
  const aindaFalhou = reenviar.isSuccess && entrega?.entregue === false;
  const reenviouOk = reenviar.isSuccess && !aindaFalhou;

  let resultado = '';
  if (reenviar.isError) {
    resultado = `Não foi possível reenviar: ${reenviar.error.message}`;
  } else if (aindaFalhou) {
    resultado = entrega.erro ? `Ainda não chegou ao cliente: ${entrega.erro}` : 'Ainda não chegou ao cliente.';
  } else if (reenviouOk) {
    resultado = entrega?.jaEntregue ? 'Esta mensagem já tinha sido entregue.' : 'Reenviada: chegou ao cliente.';
  }

  return (
    <div className="msg__falha">
      {/* Entre o reenvio dar certo e a lista atualizar, o selo antigo
          contradiria o resultado logo abaixo: escondemos nesse intervalo. */}
      {!reenviouOk && (
        <div className="msg__falha-texto">
          <IconeAlerta />
          <span>Não entregue — {m.erroEnvio}</span>
        </div>
      )}

      {/* Some assim que reenvia com sucesso: sem isto, um segundo clique
          ainda poderia sair enquanto a lista atualiza. */}
      {podeReenviar && !reenviouOk && (
        <div className="msg__falha-acoes">
          <Botao
            variante="secundario"
            tamanho="sm"
            type="button"
            onClick={() => reenviar.mutate()}
            carregando={reenviar.isPending}
            aria-label={`Reenviar a mensagem das ${new Date(m.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`}
          >
            {reenviar.isPending ? 'Reenviando...' : 'Reenviar'}
          </Botao>
        </div>
      )}

      {/* Regiao sempre presente: leitor de tela so anuncia mudancas em uma
          regiao que ja existia na pagina. */}
      <div className="msg__falha-status" role="status">
        {resultado}
      </div>
    </div>
  );
}

/** Triangulo de alerta. Junto com o texto, para a falha nao depender so da cor. */
function IconeAlerta() {
  return (
    <svg
      className="msg__falha-icone"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
