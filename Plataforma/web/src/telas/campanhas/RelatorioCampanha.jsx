import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Aviso, Cartao, Etiqueta, Metrica, Status, Tabela } from '../../componentes/ui.jsx';
import { BarraProgresso, Controles, quando } from './comum.jsx';

/**
 * A campanha depois que o disparo comecou: progresso ao vivo, os controles
 * e, por cliente, o que saiu, o que falhou e quem respondeu.
 */

const ROTULO_ALVO = {
  aprovada: 'Na fila',
  enviando: 'Saindo agora',
  enviada: 'Enviada',
  falha: 'Falhou',
  respondeu: 'Respondeu',
  pulada: 'Não enviada',
  pendente: 'Não aprovada',
  aguardando: 'Sem mensagem'
};
const TOM_ALVO = { enviada: 'sucesso', falha: 'perigo', respondeu: 'info', enviando: 'primario', pulada: 'neutro' };
const ROTULO_CLASSIFICACAO = { interessado: 'interessado', recusa: 'recusou', neutro: 'neutro' };

const FILTROS = [
  ['todos', 'Todos', () => true],
  ['fila', 'Na fila', (a) => ['aprovada', 'enviando'].includes(a.status)],
  ['enviadas', 'Enviadas', (a) => ['enviada', 'respondeu'].includes(a.status)],
  ['respostas', 'Responderam', (a) => a.status === 'respondeu'],
  ['falhas', 'Falhas', (a) => a.status === 'falha'],
  ['puladas', 'Não enviadas', (a) => a.status === 'pulada']
];

export function RelatorioCampanha({ campanha: c }) {
  const navegar = useNavigate();
  const [erro, setErro] = useState(null);
  const [filtro, setFiltro] = useState('todos');

  const p = c.progresso;
  const interessados = c.alvos.filter((a) => a.classificacao === 'interessado').length;
  const taxaResposta = p.enviadas > 0 ? Math.round((p.respostas / p.enviadas) * 100) : 0;
  const teste = FILTROS.find(([v]) => v === filtro)[2];
  const visiveis = c.alvos.filter(teste);

  return (
    <div className="assist">
      <button type="button" className="assist__voltar" onClick={() => navegar('/campanhas')}>
        ← Campanhas
      </button>

      <header className="relatorio-topo">
        <div>
          <div className="linha">
            <h1 style={{ margin: 0 }}>{c.nome}</h1>
            <Status valor={c.status} />
          </div>
          <p className="texto-suave" style={{ margin: '4px 0 0', maxWidth: 720 }}>
            {c.objetivo}
          </p>
        </div>
        <Controles campanha={c} aoErro={setErro} />
      </header>

      {erro && (
        <Aviso tom="perigo" aoFechar={() => setErro(null)}>
          {erro}
        </Aviso>
      )}

      <Cartao>
        <BarraProgresso campanha={c} grande />
      </Cartao>

      <div className="relatorio-metricas">
        <Metrica rotulo="Enviadas" valor={p.enviadas} tom="sucesso" detalhe={`de ${p.paraEnviar}`} />
        <Metrica rotulo="Na fila" valor={p.aprovadas} />
        <Metrica rotulo="Falhas" valor={p.falhas} tom={p.falhas > 0 ? 'perigo' : undefined} />
        <Metrica rotulo="Responderam" valor={p.respostas} detalhe={`${taxaResposta}% de quem recebeu`} />
        <Metrica rotulo="Interessados" valor={interessados} tom={interessados > 0 ? 'sucesso' : undefined} />
      </div>

      <Cartao
        semPadding
        titulo="Por cliente"
        acao={
          <div className="segmentos" role="tablist" aria-label="Filtrar clientes">
            {FILTROS.map(([v, texto, t]) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={filtro === v}
                className={`segmento ${filtro === v ? 'segmento--ativo' : ''}`}
                onClick={() => setFiltro(v)}
              >
                {texto} ({c.alvos.filter(t).length})
              </button>
            ))}
          </div>
        }
      >
        <Tabela cabecalho={['Cliente', 'Mensagem', 'Situação']}>
          {visiveis.map((a) => (
            <tr key={a.id}>
              <td style={{ minWidth: 150 }}>
                <strong>{a.nomeCliente}</strong>
                <div className="texto-fraco">{a.telefoneFormatado}</div>
              </td>
              <td style={{ minWidth: 320 }}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{a.mensagem}</div>
                {a.erro && <div style={{ color: 'var(--perigo)', fontSize: 12, marginTop: 4 }}>{a.erro}</div>}
                {a.respostaTexto && (
                  <div className="resposta">
                    <strong>Respondeu:</strong> “{a.respostaTexto}”{' '}
                    {a.classificacao && (
                      <Etiqueta tom={a.classificacao === 'interessado' ? 'sucesso' : a.classificacao === 'recusa' ? 'perigo' : 'neutro'}>
                        {ROTULO_CLASSIFICACAO[a.classificacao]}
                      </Etiqueta>
                    )}
                  </div>
                )}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <Etiqueta tom={TOM_ALVO[a.status] ?? 'neutro'}>{ROTULO_ALVO[a.status] ?? a.status}</Etiqueta>
                {a.enviadoEm && <div className="texto-fraco">{quando(a.enviadoEm)}</div>}
              </td>
            </tr>
          ))}
        </Tabela>
      </Cartao>
    </div>
  );
}
