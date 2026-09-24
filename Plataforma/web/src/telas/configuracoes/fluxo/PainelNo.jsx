import { useState } from 'react';
import { LIMITES, TIPOS_NO, noPorId, textoDoMenu } from '@regras-do-fluxo';
import { AreaTexto, Aviso, Campo, Entrada, Selecao } from '../../../componentes/ui.jsx';
import { TextoWhatsapp } from '../../../lib/TextoWhatsapp.jsx';
import { SAIDA_UNICA, VISUAL } from './conversao.js';

/**
 * Painel lateral de UM passo: texto, opcoes e para onde cada saida leva.
 *
 * O "Leva para" tambem liga os passos — alem de arrastar a linha no canvas.
 * Da o mesmo resultado, e e o jeito de quem prefere teclado (ou nao acerta a
 * bolinha com o mouse).
 */
export function PainelNo({ no, fluxo, nodes, edges, ehInicio, acoes, problemas, aoFechar }) {
  const tipo = TIPOS_NO[no.type];
  const [recusa, setRecusa] = useState(null);

  const destinoDe = (handle) => edges.find((e) => e.source === no.id && e.sourceHandle === handle)?.target ?? '';
  const outros = nodes.filter((n) => n.id !== no.id);
  const ligar = (handle, destino) => setRecusa(acoes.ligar(no.id, handle, destino || null));

  const campoMensagem = {
    menu: { rotulo: 'Mensagem do menu', dica: 'Aparece acima da lista numerada.' },
    mensagem: { rotulo: 'Mensagem', dica: 'Use *asteriscos* para negrito e _sublinhados_ para itálico.' },
    servicos: { rotulo: 'Texto antes da lista (opcional)', dica: 'A lista de serviços e preços vem do catálogo, sempre atualizada.' },
    atendente: { rotulo: 'Mensagem ao chamar (opcional)', dica: 'Vazio: “Certo! Já estou chamando um de nossos atendentes…”' },
    sofia: { rotulo: 'Mensagem ao passar (opcional)', dica: 'Vazio: “Claro! Me conta o que você precisa…”. Em modo só-menu, a conversa volta ao início.' }
  }[no.type];

  const previa =
    no.type === 'menu'
      ? textoDoMenu(fluxo, noPorId(fluxo, no.id) ?? no, { podeVoltar: !ehInicio })
      : no.data.message;

  return (
    <div className="painel-no">
      <header className="painel__cab">
        <span className="no__icone" style={{ '--cor-no': VISUAL[no.type].cor }} aria-hidden="true">
          {VISUAL[no.type].icone}
        </span>
        <div className="crescer">
          <h2>{no.data.title || tipo.rotulo}</h2>
          <small className="texto-fraco">{tipo.descricao}</small>
        </div>
        <button type="button" className="painel__fechar" onClick={aoFechar} aria-label="Fechar painel">
          ×
        </button>
      </header>

      <div className="painel__corpo">
        {problemas && (problemas.erros.length > 0 || problemas.avisos.length > 0) && (
          <Aviso tom={problemas.erros.length ? 'perigo' : 'alerta'}>
            {[...problemas.erros, ...problemas.avisos].map((p, i) => (
              <div key={i}>{p.mensagem}</div>
            ))}
          </Aviso>
        )}

        <Campo rotulo="Nome do passo" dica="Só você vê: serve para achar o passo no desenho.">
          <Entrada
            value={no.data.title}
            maxLength={LIMITES.titulo}
            onChange={(e) => acoes.atualizar(no.id, { title: e.target.value })}
          />
        </Campo>

        <Campo rotulo={campoMensagem.rotulo} dica={campoMensagem.dica} obrigatorio={tipo.pedeMensagem}>
          <AreaTexto
            value={no.data.message}
            maxLength={LIMITES.mensagem}
            rows={no.type === 'menu' ? 3 : 5}
            autoFocus={tipo.pedeMensagem && !no.data.message}
            onChange={(e) => acoes.atualizar(no.id, { message: e.target.value })}
          />
        </Campo>

        {no.type === 'menu' && (
          <section className="painel__secao">
            <div className="painel__secao-topo">
              <h3>Opções</h3>
              <span className="texto-fraco">
                {(no.data.options ?? []).length}/{LIMITES.opcoes}
              </span>
            </div>
            <ol className="painel__opcoes">
              {(no.data.options ?? []).map((op, i, lista) => (
                <li key={op.id} className="painel__opcao">
                  <span className="no__opcao-num">{i + 1}</span>
                  <div className="painel__opcao-campos">
                    <Entrada
                      value={op.label}
                      maxLength={LIMITES.rotulo}
                      placeholder="Texto da opção"
                      aria-label={`Texto da opção ${i + 1}`}
                      onChange={(e) =>
                        acoes.atualizar(no.id, {
                          options: lista.map((o) => (o.id === op.id ? { ...o, label: e.target.value } : o))
                        })
                      }
                    />
                    <SeletorDestino
                      valor={destinoDe(op.id)}
                      outros={outros}
                      inicio={fluxo.inicio}
                      aoMudar={(destino) => ligar(op.id, destino)}
                      rotulo={`Destino da opção ${i + 1}`}
                    />
                  </div>
                  <div className="painel__opcao-botoes">
                    <button type="button" disabled={i === 0} onClick={() => acoes.moverOpcao(no.id, op.id, -1)} aria-label="Subir opção">
                      ▲
                    </button>
                    <button
                      type="button"
                      disabled={i === lista.length - 1}
                      onClick={() => acoes.moverOpcao(no.id, op.id, 1)}
                      aria-label="Descer opção"
                    >
                      ▼
                    </button>
                    <button type="button" className="perigo" onClick={() => acoes.removerOpcao(no.id, op.id)} aria-label="Remover opção">
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ol>
            {(no.data.options ?? []).length < LIMITES.opcoes && (
              <button type="button" className="painel__adicionar" onClick={() => acoes.adicionarOpcao(no.id)}>
                + Adicionar opção
              </button>
            )}
          </section>
        )}

        {tipo.saidas === 1 && (
          <Campo rotulo="Em seguida, vai para" dica="Opcional. Ex.: depois do aviso, mostrar um menu.">
            <SeletorDestino
              valor={destinoDe(SAIDA_UNICA)}
              outros={outros}
              inicio={fluxo.inicio}
              aoMudar={(destino) => ligar(SAIDA_UNICA, destino)}
              rotulo="Próximo passo"
              vazio="— termina aqui —"
            />
          </Campo>
        )}

        {recusa && (
          <Aviso tom="perigo" aoFechar={() => setRecusa(null)}>
            {recusa}
          </Aviso>
        )}

        <label className="painel__interruptor">
          <input
            type="checkbox"
            checked={Boolean(no.data.disabled)}
            disabled={ehInicio}
            onChange={(e) => acoes.atualizar(no.id, { disabled: e.target.checked || undefined })}
          />
          <span>
            Desativar este passo
            <small className="texto-fraco">
              {ehInicio ? 'O início não pode ser desativado.' : 'As opções que levam a ele somem do menu, sem apagar nada.'}
            </small>
          </span>
        </label>

        {previa && (
          <section className="painel__secao">
            <h3>Como o cliente vê</h3>
            <div className="whats">
              <div className="whats__balao">
                <TextoWhatsapp texto={previa} />
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function SeletorDestino({ valor, outros, inicio, aoMudar, rotulo, vazio = '— sem destino (fica escondida) —' }) {
  return (
    <Selecao className="painel__destino" value={valor} onChange={(e) => aoMudar(e.target.value)} aria-label={rotulo}>
      <option value="">{vazio}</option>
      {outros.map((n) => (
        <option key={n.id} value={n.id}>
          {`→ ${VISUAL[n.type].icone} ${n.data.title || TIPOS_NO[n.type].rotulo}${n.id === inicio ? ' (início)' : ''}`}
        </option>
      ))}
    </Selecao>
  );
}
