import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Aviso, Botao, Selecao } from '../../componentes/ui.jsx';
import { formatarHora } from './formatar.js';

/**
 * Console de conexoes em tempo real.
 *
 * Le o "diario de bordo" da API (QR gerado, conectou, caiu, ligacao recusada,
 * resposta que nao saiu...) sondando a cada 2s. So pede o que veio DEPOIS do
 * ultimo evento visto, e acumula na tela ate 500 linhas.
 *
 * "Limpar tela" so limpa o que esta aqui: nada e apagado no servidor.
 */

const LINHAS_MAXIMAS = 500;
const INTERVALO_MS = 2000;

/** Texto junto da cor: quem nao distingue cores tambem le o nivel. */
const NIVEL = {
  info: { rotulo: 'INFO', classe: 'info' },
  sucesso: { rotulo: 'OK', classe: 'sucesso' },
  aviso: { rotulo: 'AVISO', classe: 'aviso' },
  erro: { rotulo: 'ERRO', classe: 'erro' }
};

export function Console({ canais }) {
  const [eventos, setEventos] = useState([]);
  const [pausado, setPausado] = useState(false);
  const [filtro, setFiltro] = useState('todas');
  const [erro, setErro] = useState(null);
  const [noFim, setNoFim] = useState(true);

  const ultimoId = useRef(0);
  const areaRef = useRef(null);

  // Sondagem. So gira enquanto o console esta na tela e nao esta pausado; ao
  // retomar, continua do ultimo evento visto (nada se perde, nada se repete).
  useEffect(() => {
    if (pausado) return undefined;

    let ativo = true;
    let timer;

    async function buscar() {
      try {
        const r = await api.get('/api/canais/eventos', {
          depoisDe: ultimoId.current,
          limite: ultimoId.current ? 300 : 100
        });
        if (!ativo) return;
        setErro(null);

        // O servidor reiniciou: a numeracao dele recomecou e o nosso "ultimo
        // visto" ficou no futuro. Comeca de novo em vez de esperar para sempre.
        if (r.ultimoId < ultimoId.current) {
          ultimoId.current = 0;
          setEventos([]);
        } else if (r.eventos.length > 0) {
          ultimoId.current = r.eventos.at(-1).id;
          setEventos((antigos) => {
            const vistos = new Set(antigos.map((e) => e.id));
            const novos = r.eventos.filter((e) => !vistos.has(e.id));
            return [...antigos, ...novos].slice(-LINHAS_MAXIMAS);
          });
        }
      } catch (err) {
        if (ativo) setErro(err.message);
      }
      if (ativo) timer = setTimeout(buscar, INTERVALO_MS);
    }

    buscar();
    return () => {
      ativo = false;
      clearTimeout(timer);
    };
  }, [pausado]);

  const visiveis = filtro === 'todas' ? eventos : eventos.filter((e) => e.chave === filtro);

  // Acompanha o fim enquanto a pessoa esta no fim; se ela rolou para cima para
  // ler, nao puxa de volta.
  useEffect(() => {
    if (noFim && areaRef.current) areaRef.current.scrollTop = areaRef.current.scrollHeight;
  }, [visiveis.length, noFim]);

  function aoRolar() {
    const el = areaRef.current;
    if (!el) return;
    setNoFim(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  }

  function irParaOFim() {
    setNoFim(true);
    if (areaRef.current) areaRef.current.scrollTop = areaRef.current.scrollHeight;
  }

  return (
    <div className="cx-console">
      <div className="cx-console__barra">
        <div className="cx-console__filtro">
          <span className="campo__rotulo" id="cx-console-filtro">
            Sessão
          </span>
          <Selecao aria-labelledby="cx-console-filtro" value={filtro} onChange={(e) => setFiltro(e.target.value)}>
            <option value="todas">Todas</option>
            {canais.map((c) => (
              <option key={c.id} value={c.chave}>
                {c.chave} — {c.nome}
              </option>
            ))}
          </Selecao>
        </div>

        <div className="linha">
          <Botao type="button" variante="secundario" tamanho="sm" aria-pressed={pausado} onClick={() => setPausado((p) => !p)}>
            {pausado ? 'Retomar' : 'Pausar'}
          </Botao>
          <Botao type="button" variante="secundario" tamanho="sm" onClick={() => setEventos([])}>
            Limpar tela
          </Botao>
        </div>
      </div>

      {erro && <Aviso tom="alerta">Não foi possível atualizar o console: {erro}</Aviso>}
      {pausado && <p className="texto-fraco">Atualização pausada. Nada se perde: ao retomar, continua de onde parou.</p>}

      <div
        ref={areaRef}
        className="cx-console__area"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Eventos das conexões"
        tabIndex={0}
        onScroll={aoRolar}
      >
        {visiveis.length === 0 ? (
          <p className="cx-console__vazio">Nenhum evento ainda. Conecte uma sessão para ver o que acontece aqui.</p>
        ) : (
          visiveis.map((e) => {
            const nivel = NIVEL[e.nivel] ?? NIVEL.info;
            return (
              <div key={e.id} className={`cx-log cx-log--${nivel.classe}`}>
                <span className="cx-log__hora">{formatarHora(e.em)}</span>
                <span className="cx-log__sessao">{e.chave ?? 'geral'}</span>
                <span className="cx-log__nivel">{nivel.rotulo}</span>
                <span className="cx-log__texto">{e.mensagem}</span>
              </div>
            );
          })
        )}
      </div>

      {!noFim && (
        <div className="linha linha--fim">
          <Botao type="button" variante="secundario" tamanho="sm" onClick={irParaOFim}>
            Ir para o fim
          </Botao>
        </div>
      )}
    </div>
  );
}
