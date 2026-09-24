import { useEffect, useRef, useState } from 'react';
import { EXPIRA_MINUTOS_PADRAO, MENSAGEM_ERRO_PADRAO, passoDoFluxo } from '@regras-do-fluxo';
import { Campo, Entrada } from '../../../componentes/ui.jsx';
import { TextoWhatsapp } from '../../../lib/TextoWhatsapp.jsx';

/**
 * Painel do fluxo inteiro (quando nenhum passo esta aberto): testar, ver os
 * problemas e ajustar o que vale para o menu todo.
 */
export function PainelFluxo({ fluxo, validacao, config, aoMudarConfig, aoIrPara }) {
  const [aba, setAba] = useState('testar');
  const total = validacao.erros.length + validacao.avisos.length;

  return (
    <div className="painel-fluxo">
      <div className="painel-fluxo__abas" role="tablist">
        {[
          ['testar', 'Testar'],
          ['problemas', `Problemas${total ? ` (${total})` : ''}`],
          ['ajustes', 'Ajustes']
        ].map(([chave, rotulo]) => (
          <button
            key={chave}
            type="button"
            role="tab"
            aria-selected={aba === chave}
            className={`painel-fluxo__aba${aba === chave ? ' painel-fluxo__aba--ativa' : ''}${
              chave === 'problemas' && validacao.erros.length ? ' painel-fluxo__aba--erro' : ''
            }`}
            onClick={() => setAba(chave)}
          >
            {rotulo}
          </button>
        ))}
      </div>

      <div className="painel__corpo">
        {aba === 'testar' && <Teste fluxo={fluxo} />}
        {aba === 'problemas' && <Problemas validacao={validacao} aoIrPara={aoIrPara} />}
        {aba === 'ajustes' && <Ajustes config={config} aoMudar={aoMudarConfig} />}
      </div>
    </div>
  );
}

/**
 * Conversa de teste com o fluxo QUE ESTA NA TELA (salvo ou nao). Usa o mesmo
 * motor do servidor; so a lista de servicos e um marcador, porque a real vem
 * do catalogo no momento do envio.
 */
function Teste({ fluxo }) {
  const [msgs, setMsgs] = useState([]);
  const [estado, setEstado] = useState(null);
  const [texto, setTexto] = useState('');
  const fim = useRef(null);

  // Com chaves de proposito: no Chrome novo `scrollIntoView` devolve uma
  // Promise, e um efeito que devolve Promise derruba a tela no React.
  useEffect(() => {
    fim.current?.scrollIntoView({ block: 'end' });
  }, [msgs.length]);

  async function enviar(t) {
    const limpo = t.trim();
    if (!limpo) return;
    setTexto('');
    const r = await passoDoFluxo(fluxo, estado, limpo, {
      listarServicos: async () => '📋 *Lista de serviços e preços do catálogo*\n_(no WhatsApp entram os valores reais)_'
    });

    const respostas = r
      ? r.baloes.map((b) => ({ de: 'nos', texto: b }))
      : [{ de: 'sistema', texto: 'Não é uma opção do menu: no modo híbrido a Sofia responderia; no modo só-menu, o menu é repetido.' }];
    if (r?.transferir) respostas.push({ de: 'sistema', texto: 'A conversa iria para a fila de atendimento humano.' });
    if (r?.entregarParaIa) respostas.push({ de: 'sistema', texto: 'Saiu do menu: a próxima mensagem livre vai para a Sofia.' });

    if (r) setEstado(r.estado);
    setMsgs((m) => [...m, { de: 'cliente', texto: limpo }, ...respostas]);
  }

  function reiniciar() {
    setMsgs([]);
    setEstado(null);
  }

  return (
    <div className="teste">
      <div className="teste__topo">
        <span className="texto-fraco">Simula o cliente com o desenho atual, mesmo sem salvar.</span>
        <button type="button" className="teste__reiniciar" onClick={reiniciar} disabled={!msgs.length}>
          Recomeçar
        </button>
      </div>

      <div className="whats whats--conversa">
        {msgs.length === 0 && <p className="whats__vazio">Escreva “oi” para ver o menu de início.</p>}
        {msgs.map((m, i) =>
          m.de === 'sistema' ? (
            <div key={i} className="whats__sistema">{m.texto}</div>
          ) : (
            <div key={i} className={`whats__balao${m.de === 'cliente' ? ' whats__balao--cliente' : ''}`}>
              <TextoWhatsapp texto={m.texto} />
            </div>
          )
        )}
        <div ref={fim} />
      </div>

      <div className="teste__atalhos">
        {['oi', '1', '2', '3', '0'].map((t) => (
          <button key={t} type="button" onClick={() => enviar(t)}>
            {t}
          </button>
        ))}
      </div>
      <form
        className="teste__envio"
        onSubmit={(e) => {
          e.preventDefault();
          enviar(texto);
        }}
      >
        <Entrada value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Mensagem do cliente…" aria-label="Mensagem do cliente" />
        <button type="submit" className="teste__enviar" aria-label="Enviar" disabled={!texto.trim()}>
          ➤
        </button>
      </form>
    </div>
  );
}

function Problemas({ validacao, aoIrPara }) {
  if (!validacao.erros.length && !validacao.avisos.length) {
    return <p className="texto-suave">Nenhum problema. O fluxo pode ser salvo. ✓</p>;
  }
  const item = (p, tom, i) => (
    <li key={`${tom}${i}`}>
      <button type="button" className={`problema problema--${tom}`} onClick={() => p.noId && aoIrPara(p.noId)} disabled={!p.noId}>
        <span aria-hidden="true">{tom === 'erro' ? '⛔' : '⚠'}</span>
        <span>{p.mensagem}</span>
      </button>
    </li>
  );
  return (
    <div className="coluna" style={{ gap: 'var(--e3)' }}>
      {validacao.erros.length > 0 && (
        <p className="texto-suave">
          <strong>Erros</strong> impedem salvar. <strong>Avisos</strong> não impedem, mas mostram algo que o cliente não vai ver.
        </p>
      )}
      <ul className="problemas">
        {validacao.erros.map((p, i) => item(p, 'erro', i))}
        {validacao.avisos.map((p, i) => item(p, 'aviso', i))}
      </ul>
    </div>
  );
}

function Ajustes({ config, aoMudar }) {
  return (
    <div className="coluna">
      <Campo rotulo="Mensagem quando o número não existe" dica="Aparece acima do menu repetido.">
        <Entrada
          value={config.mensagemErro ?? ''}
          placeholder={MENSAGEM_ERRO_PADRAO}
          maxLength={500}
          onChange={(e) => aoMudar({ ...config, mensagemErro: e.target.value })}
        />
      </Campo>
      <Campo
        rotulo="Voltar ao início depois de (minutos)"
        dica="Se o cliente some no meio de um submenu e volta mais tarde, os números passam a valer para o menu de início."
      >
        <Entrada
          type="number"
          min={5}
          max={1440}
          value={config.expiraMinutos ?? EXPIRA_MINUTOS_PADRAO}
          onChange={(e) => aoMudar({ ...config, expiraMinutos: Math.max(5, Math.min(1440, Number(e.target.value) || 5)) })}
        />
      </Campo>
    </div>
  );
}
