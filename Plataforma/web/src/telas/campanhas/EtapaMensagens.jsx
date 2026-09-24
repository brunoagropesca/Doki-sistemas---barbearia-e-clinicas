import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { AreaTexto, Aviso, Botao, Cartao, Etiqueta, FotoLead, Modal } from '../../componentes/ui.jsx';
import { BarraProgresso } from './comum.jsx';

/**
 * Etapa 4 — a IA escreve, uma pessoa le e aprova.
 *
 * Enquanto a IA escreve (em segundo plano), a barra mede o andamento e as
 * mensagens prontas ja aparecem para revisar. Nada sai sem aprovacao: o
 * "Continuar" so libera quando nao sobra nenhuma para ler.
 *
 * Mensagens com texto de reserva (a IA nao respondeu) ficam destacadas — o
 * pior erro aqui e aprovar achando que foi personalizada.
 */

const FILTROS = [
  ['todas', 'Todas'],
  ['pendente', 'Para revisar'],
  ['aprovada', 'Aprovadas'],
  ['reserva', 'Texto genérico']
];

export function EtapaMensagens({ campanha: c }) {
  const queryClient = useQueryClient();
  const [filtro, setFiltro] = useState('todas');
  const [confirmarRefazer, setConfirmarRefazer] = useState(false);
  const [erro, setErro] = useState(null);

  const recarregar = () => {
    queryClient.invalidateQueries({ queryKey: ['campanha', c.id] });
    queryClient.invalidateQueries({ queryKey: ['campanhas'] });
  };
  const aoErrar = (err) => setErro(err.message);

  const aprovar = useMutation({
    mutationFn: (corpo) => api.post(`/api/campanhas/${c.id}/aprovar`, corpo),
    onSuccess: recarregar,
    onError: aoErrar
  });
  const gerar = useMutation({
    mutationFn: (refazer) => api.post(`/api/campanhas/${c.id}/gerar`, { refazer }),
    onSuccess: () => {
      setConfirmarRefazer(false);
      recarregar();
    },
    onError: aoErrar
  });

  const gerando = c.status === 'gerando';
  const p = c.progresso;
  const escritas = c.alvos.filter((a) => a.status !== 'aguardando');
  const reservas = escritas.filter((a) => a.mensagemReserva);
  const contagem = {
    todas: escritas.length,
    pendente: escritas.filter((a) => a.status === 'pendente').length,
    aprovada: escritas.filter((a) => a.status === 'aprovada').length,
    reserva: reservas.length
  };
  const visiveis = escritas.filter((a) =>
    filtro === 'todas' ? true : filtro === 'reserva' ? a.mensagemReserva : a.status === filtro
  );

  return (
    <div className="coluna">
      {erro && (
        <Aviso tom="perigo" aoFechar={() => setErro(null)}>
          {erro}
        </Aviso>
      )}

      {gerando && (
        <Cartao>
          <div className="gerando">
            <h2 className="gerando__titulo">A IA está escrevendo uma mensagem para cada cliente</h2>
            <BarraProgresso campanha={c} grande />
            <p className="assist__ajuda">
              Ela lê o histórico de atendimento de cada um antes de escrever. Pode sair desta tela: a geração continua e a
              campanha fica esperando você na lista.
            </p>
          </div>
        </Cartao>
      )}

      {!gerando && p.aguardando > 0 && (
        <Aviso tom="alerta" titulo={`${p.aguardando} contato(s) ainda sem mensagem`}>
          <div className="linha" style={{ marginTop: 6 }}>
            <span>A geração foi interrompida antes do fim.</span>
            <Botao tamanho="sm" carregando={gerar.isPending} onClick={() => gerar.mutate(false)}>
              Gerar as que faltam
            </Botao>
          </div>
        </Aviso>
      )}

      {reservas.length > 0 && !gerando && (
        <Aviso tom="alerta" titulo={`${reservas.length} mensagem(ns) com texto genérico`}>
          A IA não respondeu para estes clientes e entrou um texto padrão. Edite, peça outra versão ou tire da campanha.
        </Aviso>
      )}

      {escritas.length > 0 && (
        <div className="revisao-topo">
          <div className="segmentos" role="tablist" aria-label="Filtrar mensagens">
            {FILTROS.map(([v, texto]) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={filtro === v}
                className={`segmento ${filtro === v ? 'segmento--ativo' : ''}`}
                onClick={() => setFiltro(v)}
              >
                {texto} ({contagem[v]})
              </button>
            ))}
          </div>
          <div className="linha">
            <Botao variante="secundario" tamanho="sm" disabled={gerando} onClick={() => setConfirmarRefazer(true)}>
              Reescrever todas
            </Botao>
            <Botao
              tamanho="sm"
              disabled={gerando || contagem.pendente === 0}
              carregando={aprovar.isPending}
              onClick={() => aprovar.mutate({ todos: true })}
            >
              Aprovar todas ({contagem.pendente})
            </Botao>
          </div>
        </div>
      )}

      <div className="cartoes-msg">
        {visiveis.map((a) => (
          <CartaoMensagem key={a.id} alvo={a} campanhaId={c.id} aoMudar={recarregar} aoErrar={aoErrar} />
        ))}
      </div>

      {escritas.length > 0 && visiveis.length === 0 && <p className="texto-fraco">Nenhuma mensagem neste filtro.</p>}

      {confirmarRefazer && (
        <Modal
          titulo="Reescrever todas as mensagens?"
          aberto
          aoFechar={() => setConfirmarRefazer(false)}
          rodape={
            <>
              <Botao variante="secundario" onClick={() => setConfirmarRefazer(false)}>
                Voltar
              </Botao>
              <Botao carregando={gerar.isPending} onClick={() => gerar.mutate(true)}>
                Reescrever {escritas.length}
              </Botao>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            A IA escreve de novo para todo o público, com o objetivo e a configuração atuais. As edições e aprovações feitas
            até aqui se perdem. Use quando mudou o objetivo na etapa anterior.
          </p>
        </Modal>
      )}
    </div>
  );
}

/**
 * Uma mensagem, do jeito que o cliente vai ver.
 *
 * Salva ao sair do campo: nao exige clicar em "salvar" em cada uma das 300.
 */
function CartaoMensagem({ alvo: a, campanhaId, aoMudar, aoErrar }) {
  const queryClient = useQueryClient();

  const editar = useMutation({
    mutationFn: (mensagem) => api.patch(`/api/campanhas/alvos/${a.id}`, { mensagem }),
    onSuccess: aoMudar,
    onError: aoErrar
  });
  const regerar = useMutation({
    mutationFn: () => api.post(`/api/campanhas/alvos/${a.id}/regerar`),
    onSuccess: aoMudar,
    onError: aoErrar
  });
  const remover = useMutation({
    mutationFn: () => api.delete(`/api/campanhas/alvos/${a.id}`),
    onSuccess: aoMudar,
    onError: aoErrar
  });
  const aprovar = useMutation({
    mutationFn: (aprova) => api.post(`/api/campanhas/${campanhaId}/aprovar`, { alvoIds: [a.id], aprovar: aprova }),
    // Resposta imediata na tela: o cartao muda de cor no clique, sem esperar
    // a volta do servidor. Revisar 200 mensagens com meio segundo de atraso
    // em cada clique cansa.
    onMutate: (aprova) => {
      queryClient.setQueryData(['campanha', campanhaId], (antigo) =>
        antigo?.campanha
          ? {
              ...antigo,
              campanha: {
                ...antigo.campanha,
                alvos: antigo.campanha.alvos.map((x) => (x.id === a.id ? { ...x, status: aprova ? 'aprovada' : 'pendente' } : x))
              }
            }
          : antigo
      );
    },
    onSettled: aoMudar,
    onError: aoErrar
  });

  const aprovada = a.status === 'aprovada';
  const ocupado = regerar.isPending || remover.isPending;

  return (
    <article className={`cartao-msg ${aprovada ? 'cartao-msg--aprovada' : ''} ${a.mensagemReserva ? 'cartao-msg--reserva' : ''}`}>
      <div className="cartao-msg__topo">
        <FotoLead nome={a.nomeCliente} tamanho={28} />
        <span>
          <strong title={a.nomeCliente}>{a.nomeCliente}</strong>
          <small>{a.telefoneFormatado}</small>
        </span>
        {a.mensagemReserva && <Etiqueta tom="alerta">texto genérico</Etiqueta>}
        {aprovada && <Etiqueta tom="sucesso">aprovada</Etiqueta>}
      </div>

      <AreaTexto
        // Remonta quando o texto muda no servidor (outra versao da IA).
        key={a.mensagem}
        defaultValue={a.mensagem}
        aria-label={`Mensagem para ${a.nomeCliente}`}
        disabled={ocupado}
        onBlur={(e) => {
          const texto = e.target.value.trim();
          if (texto && texto !== a.mensagem) editar.mutate(texto);
        }}
      />

      {a.contextoGeracao?.linhas?.length > 0 && (
        <details className="contexto-ia">
          <summary>
            O que a IA leu deste cliente
            {a.contextoGeracao.autor ? ` · escrita por ${a.contextoGeracao.autor}` : ''}
          </summary>
          <ul>
            {a.contextoGeracao.linhas.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="cartao-msg__acoes">
        <span className="crescer" />
        <Botao tamanho="sm" variante="fantasma" disabled={ocupado} onClick={() => remover.mutate()} title="Tirar este cliente da campanha">
          Tirar
        </Botao>
        <Botao tamanho="sm" variante="secundario" carregando={regerar.isPending} disabled={ocupado} onClick={() => regerar.mutate()}>
          ↻ Outra versão
        </Botao>
        <Botao tamanho="sm" variante={aprovada ? 'secundario' : 'primario'} disabled={ocupado} onClick={() => aprovar.mutate(!aprovada)}>
          {aprovada ? 'Desaprovar' : '✓ Aprovar'}
        </Botao>
      </div>
    </article>
  );
}
