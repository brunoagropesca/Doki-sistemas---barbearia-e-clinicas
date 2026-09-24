import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/autenticacao.jsx';
import { Aviso, Botao, Carregando, Entrada, Etiqueta, Modal } from '../componentes/ui.jsx';
import { DetalheOS } from './agenda/DetalheOS.jsx';
import { PerfilLead } from './agenda/PerfilLead.jsx';
import { HUMOR, Humor } from './conversas/Humor.jsx';
import './Quadro.css';

/**
 * Quadro de atendimento.
 *
 * Um cartao e um atendimento: comeca como conversa, vira OS quando o horario
 * fecha. As quatro primeiras colunas sao a conversa (a Atena as move enquanto
 * conduz o papo); as quatro ultimas sao o estado real do agendamento.
 *
 * Arrastar entre as colunas finais muda o status da OS — com as mesmas regras
 * da agenda. O servidor recusa o que nao pode; a tela mostra o motivo.
 */

function hojeISO() {
  return new Date().toLocaleDateString('sv-SE');
}

export function Quadro() {
  const queryClient = useQueryClient();
  const navegar = useNavigate();
  const { podeAcessar } = useAuth();

  const [data, setData] = useState(hojeISO());
  const [arrastando, setArrastando] = useState(null);
  const [sobre, setSobre] = useState(null);
  const [osAberta, setOsAberta] = useState(null);
  const [perfilAberto, setPerfilAberto] = useState(null);
  const [fechamento, setFechamento] = useState(false);
  // Oito colunas nao cabem numa tela. "Do dia" esconde as etapas de conversa
  // e deixa so as quatro do fluxo da OS — a visao de quem esta fechando o dia.
  const [foco, setFoco] = useState('tudo');

  const quadro = useQuery({
    queryKey: ['quadro', data],
    queryFn: () => api.get('/api/quadro', { data }),
    // O tempo real (SSE) atualiza o quadro na hora que algo muda. Este polling
    // e so a rede de seguranca para um telao que perdeu a conexao.
    refetchInterval: 60_000
  });

  const mover = useMutation({
    mutationFn: ({ cartaoId, coluna }) => api.patch('/api/quadro/mover', { cartaoId, coluna }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quadro'] });
      queryClient.invalidateQueries({ queryKey: ['agenda'] });
      queryClient.invalidateQueries({ queryKey: ['conversas'] });
    }
  });

  const todasAsColunas = quadro.data?.colunas ?? [];
  const colunas = foco === 'dia' ? todasAsColunas.filter((c) => c.tipo === 'os') : todasAsColunas;
  const escondidas = todasAsColunas.length - colunas.length;

  function soltar(coluna) {
    setSobre(null);
    const cartao = arrastando;
    setArrastando(null);
    if (!cartao || cartao.coluna === coluna) return;
    mover.mutate({ cartaoId: cartao.id, coluna });
  }

  return (
    <div className="coluna">
      <header className="linha linha--entre">
        <div>
          <h1>Quadro de atendimento</h1>
          <p className="texto-suave">Do primeiro "oi" ate o servico entregue.</p>
        </div>
        <div className="linha">
          <div className="abas abas--compacta" role="tablist">
            {[
              ['tudo', 'Fluxo completo'],
              ['dia', 'Do dia']
            ].map(([id, rotulo]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={foco === id}
                className={`abas__aba${foco === id ? ' abas__aba--ativa' : ''}`}
                onClick={() => setFoco(id)}
              >
                {rotulo}
              </button>
            ))}
          </div>
          <Entrada type="date" value={data} onChange={(e) => setData(e.target.value)} style={{ width: 'auto' }} />
          <Botao variante="fantasma" tamanho="sm" onClick={() => setData(hojeISO())}>
            Hoje
          </Botao>
          {podeAcessar('admin') && (
            <Botao variante="secundario" onClick={() => setFechamento(true)}>
              Fechar o dia
            </Botao>
          )}
        </div>
      </header>

      {mover.isError && <Aviso tom="perigo">{mover.error.message}</Aviso>}

      {escondidas > 0 && (
        <p className="texto-fraco">
          Mostrando so o fluxo do horario marcado. {escondidas} etapas de conversa estao escondidas.
        </p>
      )}

      {quadro.isLoading ? (
        <Carregando />
      ) : quadro.isError ? (
        <Aviso tom="perigo">{quadro.error.message}</Aviso>
      ) : (
        <div className="quadro">
          {colunas.map((c) => (
            <section
              key={c.chave}
              className={`quadro__coluna${sobre === c.chave ? ' quadro__coluna--alvo' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setSobre(c.chave);
              }}
              onDragLeave={() => setSobre((atual) => (atual === c.chave ? null : atual))}
              onDrop={() => soltar(c.chave)}
            >
              <header className="quadro__topo" style={{ borderTopColor: c.cor }}>
                <div className="linha linha--entre">
                  <strong>{c.titulo}</strong>
                  <span className="quadro__contador">{c.total}</span>
                </div>
                <p className="texto-fraco">{c.descricao}</p>
              </header>

              <div className="quadro__cartoes">
                {c.cartoes.length === 0 ? (
                  <p className="quadro__vazio">Nada aqui.</p>
                ) : (
                  c.cartoes.map((cartao) => (
                    <Cartao
                      key={cartao.id}
                      cartao={cartao}
                      aoArrastar={() => setArrastando(cartao)}
                      aoSoltarFora={() => setArrastando(null)}
                      aoAbrir={() => {
                        if (cartao.tipo === 'os') setOsAberta(cartao.agendamentoId);
                        else navegar(`/conversas?id=${cartao.conversationId}`);
                      }}
                      aoAbrirPerfil={() => setPerfilAberto(cartao.leadId)}
                    />
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      {osAberta && (
        <DetalheOS
          id={osAberta}
          podeExcluir={podeAcessar('admin')}
          aoFechar={() => setOsAberta(null)}
          aoAbrirPerfil={(id) => {
            setOsAberta(null);
            setPerfilAberto(id);
          }}
        />
      )}

      {perfilAberto && (
        <PerfilLead
          leadId={perfilAberto}
          aoFechar={() => setPerfilAberto(null)}
          aoAbrirOS={(id) => {
            setPerfilAberto(null);
            setOsAberta(id);
          }}
        />
      )}

      {fechamento && <ModalFecharDia data={data} aoFechar={() => setFechamento(false)} />}
    </div>
  );
}

/** Por que o cartao esta pedindo uma pessoa (vem do servidor em `precisaDeGente`). */
const PRECISA_DE_GENTE = {
  na_fila: { rotulo: 'Na fila', dica: 'O cliente foi para a fila humana e ninguém assumiu ainda.' },
  sem_resposta: { rotulo: 'Esperando resposta', dica: 'A última mensagem é do cliente e ninguém respondeu.' }
};

function Cartao({ cartao, aoArrastar, aoSoltarFora, aoAbrir, aoAbrirPerfil }) {
  const humor = HUMOR[cartao.humor];
  const atencao = PRECISA_DE_GENTE[cartao.precisaDeGente];

  return (
    <article
      className={`cartao-q cartao-q--${cartao.tipo}${atencao ? ' cartao-q--atencao' : ''}`}
      title={atencao?.dica}
      draggable
      onDragStart={aoArrastar}
      onDragEnd={aoSoltarFora}
      style={{ borderLeftColor: atencao ? 'var(--alerta)' : (cartao.profissionalCor ?? humor?.cor ?? 'var(--borda-forte)') }}
    >
      <div className="linha linha--entre">
        <button type="button" className="link" onClick={aoAbrirPerfil}>
          <strong>{cartao.leadNome}</strong>
        </button>
        {humor && <Humor valor={cartao.humor} compacto />}
      </div>

      <button type="button" className="cartao-q__corpo" onClick={aoAbrir}>
        <span className="cartao-q__titulo">{cartao.titulo}</span>
        {cartao.quando && <span className="texto-fraco">{cartao.quando}</span>}
        {cartao.profissionalNome && (
          <span className="texto-fraco">
            <span style={{ color: cartao.profissionalCor }}>●</span> {cartao.profissionalNome}
          </span>
        )}
        {cartao.resumo && <span className="cartao-q__resumo">{cartao.resumo}</span>}
      </button>

      <div className="linha" style={{ gap: 4 }}>
        {atencao && (
          <span className="cartao-q__atencao">
            <span className="cartao-q__ponto" aria-hidden="true" />
            {atencao.rotulo}
          </span>
        )}
        {cartao.valor && <span className="mono texto-fraco">{cartao.valor}</span>}
        {cartao.criadoPor === 'ia' && <Etiqueta tom="info">via IA</Etiqueta>}
        {cartao.naoLidas > 0 && <Etiqueta tom="perigo">{cartao.naoLidas} nova(s)</Etiqueta>}
        {cartao.atendenteNome && <span className="texto-fraco">{cartao.atendenteNome}</span>}
      </div>
    </article>
  );
}

/**
 * Rotina de fim de dia.
 *
 * Mostra o que vai acontecer antes de acontecer, e devolve a lista do que
 * ficou em aberto — porque concluir atendimento no automatico viraria
 * faturamento inventado.
 */
function ModalFecharDia({ data, aoFechar }) {
  const queryClient = useQueryClient();

  const fechar = useMutation({
    mutationFn: () => api.post('/api/quadro/fechar-dia', { data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quadro'] });
      queryClient.invalidateQueries({ queryKey: ['agenda'] });
      queryClient.invalidateQueries({ queryKey: ['conversas'] });
    }
  });

  const r = fechar.data;

  return (
    <Modal
      titulo="Fechar o dia"
      aberto
      aoFechar={aoFechar}
      largura={560}
      rodape={
        r ? (
          <Botao onClick={aoFechar}>Pronto</Botao>
        ) : (
          <>
            <Botao variante="secundario" onClick={aoFechar}>
              Cancelar
            </Botao>
            <Botao carregando={fechar.isPending} onClick={() => fechar.mutate()}>
              Fechar {new Date(`${data}T12:00:00`).toLocaleDateString('pt-BR')}
            </Botao>
          </>
        )
      }
    >
      {fechar.isError && <Aviso tom="perigo">{fechar.error.message}</Aviso>}

      {!r ? (
        <div className="coluna">
          <p>
            Isto encerra as sessoes de atendimento que ficaram abertas em ordens ja finalizadas e arquiva o que
            terminou no dia (concluido, cancelado e faltas).
          </p>
          <Aviso tom="info">
            Atendimentos ainda confirmados ou em execucao <strong>nao</strong> sao concluidos automaticamente: eles
            voltam numa lista para voce decidir.
          </Aviso>
        </div>
      ) : (
        <div className="coluna">
          <div className="grade">
            <div>
              <div className="texto-fraco">Ordens arquivadas</div>
              <strong>{r.arquivadas}</strong>
            </div>
            <div>
              <div className="texto-fraco">Sessoes finalizadas</div>
              <strong>{r.conversasFinalizadas}</strong>
            </div>
            <div>
              <div className="texto-fraco">Ficaram em aberto</div>
              <strong>{r.pendentes.length}</strong>
            </div>
          </div>

          {r.pendentes.length > 0 && (
            <div>
              <h3 style={{ marginBottom: 'var(--e2)' }}>Precisam de uma decisao</h3>
              <div className="coluna" style={{ gap: 'var(--e2)' }}>
                {r.pendentes.map((p) => (
                  <div key={p.id} className="linha linha--entre">
                    <span>
                      <span className="mono">{p.hora}</span> · {p.leadNome} — {p.servicoNome}
                    </span>
                    <Etiqueta tom="alerta">{p.status}</Etiqueta>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
