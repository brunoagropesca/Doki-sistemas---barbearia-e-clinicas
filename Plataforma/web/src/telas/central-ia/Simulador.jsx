import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Aviso, Botao, Etiqueta, Selecao } from '../../componentes/ui.jsx';
import { TextoWhatsapp } from '../../lib/TextoWhatsapp.jsx';

/**
 * Aba "Simulador WhatsApp & Bastidores".
 *
 * Conversa de teste: voce escreve como um cliente e ve, ao lado, o que
 * aconteceu por tras — quem respondeu, o que a Sofia pediu a Atena, quais
 * consultas a Atena fez no banco. Nada e enviado a nenhum WhatsApp.
 */

const QUEM_RESPONDEU = {
  menu: { rotulo: 'Menu estático', tom: 'sucesso' },
  ia: { rotulo: 'Sofia (IA)', tom: 'primario' },
  fallback_humano: { rotulo: 'IA indisponível → atendente humano', tom: 'alerta' }
};

const NOME_MODO = { menu: 'Menu Tradicional', hibrido: 'Híbrido', ia: 'IA no Comando' };

const MODOS = [
  [null, 'Usar o modo configurado'],
  ['menu', 'Forçar: Menu Tradicional'],
  ['hibrido', 'Forçar: Modo Híbrido'],
  ['ia', 'Forçar: IA no Comando']
];

const NOMES_FERRAMENTA = {
  listar_servicos: 'Listar serviços',
  listar_profissionais: 'Listar profissionais',
  consultar_horarios: 'Consultar horários livres',
  consultar_varios_servicos: 'Horários para vários serviços',
  consultar_dados_do_cliente: 'Dados do cliente',
  consultar_agendamentos_do_cliente: 'Agendamentos do cliente',
  criar_agendamento: 'Criar agendamento',
  agendar_varios_servicos: 'Agendar vários serviços',
  remarcar_agendamento: 'Remarcar agendamento',
  atualizar_agendamento: 'Atualizar OS',
  cancelar_agendamento: 'Cancelar agendamento',
  excluir_agendamento: 'Excluir agendamento',
  mover_etapa_atendimento: 'Mover etapa no quadro'
};

const ESCRITAS = new Set([
  'criar_agendamento',
  'agendar_varios_servicos',
  'remarcar_agendamento',
  'atualizar_agendamento',
  'cancelar_agendamento',
  'excluir_agendamento',
  'mover_etapa_atendimento'
]);

export function Simulador() {
  const [turnos, setTurnos] = useState([]); // [{ cliente, resposta? }]
  const [texto, setTexto] = useState('');
  const [modo, setModo] = useState(null);
  const [escrita, setEscrita] = useState(false);
  const [selecionado, setSelecionado] = useState(null);
  const fimRef = useRef(null);

  const simular = useMutation({
    mutationFn: (corpo) => api.post('/api/ia/simular', corpo)
  });

  useEffect(() => {
    fimRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turnos]);

  /** A conversa ate aqui, no formato do servidor. A tela guarda: o simulador nao grava nada. */
  function montarHistorico() {
    return turnos.flatMap((t) => [
      { papel: 'user', conteudo: t.cliente },
      ...(t.resposta ? [{ papel: 'assistant', conteudo: t.resposta.baloes.join('\n\n') }] : [])
    ]);
  }

  function enviar() {
    const limpo = texto.trim();
    if (!limpo || simular.isPending) return;

    const historico = montarHistorico();
    // O indice e capturado AGORA. Ler `turnos.length` la na frente, quando a
    // resposta chegar, ja pegaria a lista atualizada e apontaria o turno errado.
    const indice = turnos.length;

    setTurnos((t) => [...t, { cliente: limpo }]);
    setTexto('');

    // Em que submenu o cliente de teste esta: o servidor devolve a cada turno
    // e a tela manda de volta, porque o simulador nao grava conversa nenhuma.
    const menuEstado = [...turnos].reverse().find((t) => t.resposta)?.resposta.menuEstado ?? null;

    simular.mutate(
      { mensagem: limpo, historico, modo, permitirEscrita: escrita, menuEstado },
      {
        onSuccess: (r) => {
          setTurnos((t) => t.map((turno, i) => (i === indice ? { ...turno, resposta: r } : turno)));
          setSelecionado(indice); // mostra os bastidores da resposta nova
        }
      }
    );
  }

  function limpar() {
    setTurnos([]);
    setSelecionado(null);
    simular.reset();
  }

  const bastidores = selecionado != null ? turnos[selecionado]?.resposta : null;

  return (
    <div className="ci-simulador">
      <section className="ci-bloco ci-chat">
        <header className="ci-bloco__topo">
          <div>
            <h2 className="ci-titulo-secao">💬 Simulador de WhatsApp</h2>
            <p className="texto-fraco">Converse como um cliente. Nada é enviado a nenhum número.</p>
          </div>
          <Botao variante="fantasma" tamanho="sm" onClick={limpar} disabled={turnos.length === 0}>
            Limpar conversa
          </Botao>
        </header>

        <div className="ci-chat__opcoes">
          <Selecao value={modo ?? ''} onChange={(e) => setModo(e.target.value || null)} aria-label="Modo de atendimento">
            {MODOS.map(([v, r]) => (
              <option key={r} value={v ?? ''}>{r}</option>
            ))}
          </Selecao>

          <label className={`ci-escrita ${escrita ? 'ci-escrita--ligada' : ''}`}>
            <input type="checkbox" checked={escrita} onChange={(e) => setEscrita(e.target.checked)} />
            <span>Permitir que a Atena grave no banco</span>
          </label>
        </div>

        {escrita ? (
          <Aviso tom="alerta">
            <strong>Gravação ligada.</strong> A Atena vai criar, remarcar, cancelar e excluir agendamentos de verdade,
            no cliente “Simulador (teste)”. Confira e apague depois na Agenda.
          </Aviso>
        ) : (
          <p className="texto-fraco" style={{ padding: '0 var(--e4)' }}>
            Somente leitura: a Atena consulta o banco mas não altera nada. Ligue a opção acima para ver ela agendar de
            verdade.
          </p>
        )}

        <div className="ci-chat__mensagens">
          {turnos.length === 0 && (
            <p className="texto-fraco" style={{ textAlign: 'center', padding: 'var(--e6)' }}>
              Comece com um <strong>“oi”</strong>, um número do menu (<strong>1</strong>) ou algo como{' '}
              <strong>“quero cortar o cabelo amanhã à tarde”</strong>.
            </p>
          )}

          {turnos.map((t, i) => (
            <div key={i} className="coluna" style={{ gap: 6 }}>
              <div className="ci-msg ci-msg--cliente">{t.cliente}</div>

              {t.resposta?.baloes.map((b, j) => (
                <button
                  key={j}
                  className={`ci-msg ci-msg--sistema ${selecionado === i ? 'ci-msg--destaque' : ''}`}
                  onClick={() => setSelecionado(i)}
                  title="Ver os bastidores desta resposta"
                >
                  <TextoWhatsapp texto={b} />
                </button>
              ))}

              {!t.resposta && simular.isPending && i === turnos.length - 1 && (
                <div className="ci-msg ci-msg--sistema ci-msg--pensando">Pensando…</div>
              )}
            </div>
          ))}
          <div ref={fimRef} />
        </div>

        {simular.isError && <Aviso tom="perigo">{simular.error.message}</Aviso>}

        <form
          className="ci-chat__envio"
          onSubmit={(e) => {
            e.preventDefault();
            enviar();
          }}
        >
          <textarea
            className="entrada"
            rows={2}
            value={texto}
            placeholder="Escreva como o cliente..."
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                enviar();
              }
            }}
          />
          <Botao type="submit" carregando={simular.isPending} disabled={!texto.trim()}>
            Enviar
          </Botao>
        </form>
      </section>

      <aside className="ci-bloco ci-bastidores">
        <h2 className="ci-titulo-secao">🎬 Bastidores</h2>
        {bastidores ? (
          <Bastidores resposta={bastidores} />
        ) : (
          <p className="texto-fraco" style={{ marginTop: 'var(--e3)' }}>
            Envie uma mensagem e clique em uma resposta para ver como ela foi construída: qual modo atendeu, o que a
            Sofia pediu à Atena e o que a Atena consultou no banco.
          </p>
        )}
      </aside>
    </div>
  );
}

function Bastidores({ resposta }) {
  const b = resposta.bastidores;
  const quem = QUEM_RESPONDEU[resposta.respondidoPor] ?? { rotulo: resposta.respondidoPor, tom: 'neutro' };

  return (
    <div className="coluna" style={{ marginTop: 'var(--e3)' }}>
      <div className="linha" style={{ gap: 6 }}>
        <Etiqueta tom={quem.tom}>{quem.rotulo}</Etiqueta>
        <Etiqueta tom="neutro">Modo: {NOME_MODO[b.modo] ?? b.modo}</Etiqueta>
        <Etiqueta tom="neutro">{b.duracaoMs} ms</Etiqueta>
        {resposta.transferido && <Etiqueta tom="alerta">Iria para a fila humana</Etiqueta>}
      </div>

      {resposta.respondidoPor === 'menu' && (
        <Aviso tom="sucesso">
          <strong>0 tokens gastos.</strong> Respondido pelo menu estático com dados do banco
          {b.opcao ? ` (opção “${b.opcao}”)` : ''}.
        </Aviso>
      )}

      {b.provedor && (
        <div className="ci-fato">
          <span className="texto-fraco">Sofia respondeu com</span>
          <span className="mono">{b.provedor} / {b.modelo}</span>
          <span className="texto-fraco">{b.latenciaMs} ms • {b.voltas} volta(s)</span>
        </div>
      )}

      {b.ferramentas?.length > 0 && (
        <div className="ci-fato">
          <span className="texto-fraco">Ferramentas da Sofia</span>
          <span className="mono">{b.ferramentas.join(', ')}</span>
        </div>
      )}

      {b.erro && <Aviso tom="perigo">{b.erro}</Aviso>}

      {/* Leituras que a Sofia fez direto: mesmas ferramentas da Atena, sem o
          modelo dela no meio (0 tokens da Atena). */}
      {(b.consultas ?? []).length > 0 && (
        <div className="ci-atena">
          <div className="ci-atena__topo">
            <strong>🔎 Consultas diretas da Sofia</strong>
            <span className="texto-fraco">sem acionar a Atena</span>
          </div>
          {b.consultas.map((f, i) => (
            <ConsultaFerramenta key={i} ferramenta={f} />
          ))}
        </div>
      )}

      {(b.atena ?? []).map((t, i) => (
        <TraceAtena key={i} trace={t} indice={i + 1} />
      ))}

      {!b.permitiuEscrita && (b.atena ?? []).length > 0 && (
        <p className="texto-fraco">Modo somente leitura: nenhuma alteração foi feita no banco.</p>
      )}
    </div>
  );
}

/** Uma ferramenta que rodou: o que foi pedido e o que o banco devolveu. */
function ConsultaFerramenta({ ferramenta: f }) {
  const falhou = Boolean(f.resultado?.erro);
  const escrita = ESCRITAS.has(f.nome);
  return (
    <details className={`ci-consulta ${falhou ? 'ci-consulta--erro' : ''}`}>
      <summary>
        <span className="crescer">{NOMES_FERRAMENTA[f.nome] ?? f.nome}</span>
        {escrita && <Etiqueta tom={falhou ? 'perigo' : 'alerta'}>{falhou ? 'escrita recusada' : 'ESCREVEU NO BANCO'}</Etiqueta>}
        {!escrita && <Etiqueta tom={falhou ? 'perigo' : 'info'}>{falhou ? 'erro' : 'consulta'}</Etiqueta>}
      </summary>
      <div className="ci-consulta__corpo">
        <div className="texto-fraco">Argumentos</div>
        <pre>{JSON.stringify(f.argumentos, null, 2)}</pre>
        <div className="texto-fraco">Resultado do banco</div>
        <pre>{JSON.stringify(f.resultado, null, 2)}</pre>
      </div>
    </details>
  );
}

/** Um pedido da Sofia a Atena e tudo o que a Atena fez para responder. */
function TraceAtena({ trace, indice }) {
  return (
    <div className="ci-atena">
      <div className="ci-atena__topo">
        <strong>📚 Atena — pedido {indice}</strong>
        {trace.modelo && <span className="mono texto-fraco">{trace.provedor} / {trace.modelo} • {trace.latenciaMs} ms</span>}
      </div>

      <div className="ci-atena__pedido">
        <span className="texto-fraco">Sofia pediu:</span> “{trace.pedido}”
      </div>

      {trace.erro && <Aviso tom="perigo">A Atena não respondeu: {trace.erro}</Aviso>}
      {trace.semPermissoes && <Aviso tom="alerta">A Atena está sem nenhuma permissão habilitada.</Aviso>}

      {(trace.ferramentas ?? []).map((f, i) => (
        <ConsultaFerramenta key={i} ferramenta={f} />
      ))}

      {trace.ferramentas?.length === 0 && !trace.erro && !trace.semPermissoes && (
        <p className="texto-fraco">Respondeu sem consultar o banco.</p>
      )}

      {/* A conclusao da Atena. Sem ela os bastidores mostram as consultas mas
          nao a resposta, e quem depura nao sabe o que a Sofia recebeu. */}
      {trace.resposta && (
        <div className="ci-atena__resposta">
          <span className="texto-fraco">Atena respondeu à Sofia:</span> “{trace.resposta}”
        </div>
      )}
    </div>
  );
}
