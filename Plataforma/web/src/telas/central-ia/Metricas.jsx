import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Aviso, Carregando, Cartao, Metrica, Selecao, Tabela } from '../../componentes/ui.jsx';

/**
 * Aba "Metricas & Banco de Dados": quanto a IA gastou, quem gastou (Sofia ou
 * Atena), como estao as conversas e quanto ha em cada tabela.
 */

const NOME_AGENTE = { atendente: 'Sofia (atendimento)', atena: 'Atena (dados e agenda)' };

const nomeDoAgente = (a) => NOME_AGENTE[a.agente] ?? a.origem;

function formatarBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 ** 2).toFixed(2)} MB`;
}

function formatarSegundos(s) {
  if (!s) return '—';
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function Metricas() {
  const [dias, setDias] = useState(7);

  const uso = useQuery({ queryKey: ['ia', 'uso', dias], queryFn: () => api.get('/api/ia/uso', { dias }) });
  const banco = useQuery({ queryKey: ['ia', 'banco'], queryFn: () => api.get('/api/ia/banco') });
  const conversas = useQuery({
    queryKey: ['conversas', 'metricas', dias],
    queryFn: () => api.get('/api/conversas/metricas', { dias })
  });

  if (uso.isLoading || banco.isLoading) return <Carregando />;
  if (uso.isError) return <Aviso tom="perigo">{uso.error.message}</Aviso>;

  const u = uso.data;
  const c = conversas.data;
  const taxaSucesso = u.total > 0 ? Math.round((u.sucessos / u.total) * 100) : null;

  return (
    <div className="coluna">
      <div className="linha linha--entre">
        <h2 className="ci-titulo-secao">📊 Uso da IA</h2>
        <Selecao value={dias} onChange={(e) => setDias(Number(e.target.value))} style={{ width: 'auto' }} aria-label="Período">
          <option value={1}>Últimas 24 horas</option>
          <option value={7}>Últimos 7 dias</option>
          <option value={30}>Últimos 30 dias</option>
        </Selecao>
      </div>

      <div className="grade">
        <Metrica rotulo="Chamadas de IA" valor={u.total} />
        <Metrica
          rotulo="Taxa de sucesso"
          valor={taxaSucesso == null ? '—' : `${taxaSucesso}%`}
          tom={taxaSucesso != null && taxaSucesso < 90 ? 'alerta' : 'sucesso'}
          detalhe={`${u.falhas} falha(s)`}
        />
        <Metrica rotulo="Tokens consumidos" valor={(u.tokensEntrada + u.tokensSaida).toLocaleString('pt-BR')} detalhe={`${u.tokensEntrada.toLocaleString('pt-BR')} entrada • ${u.tokensSaida.toLocaleString('pt-BR')} saída`} />
        <Metrica rotulo="Tempo médio de resposta" valor={`${u.latenciaMedia} ms`} />
      </div>

      <Cartao titulo="Quem está gastando: Sofia ou Atena" semPadding>
        {u.porAgente.length === 0 ? (
          <p className="texto-fraco" style={{ padding: 'var(--e5)' }}>Nenhuma chamada de IA no período.</p>
        ) : (
          <Tabela cabecalho={['Agente', 'Chamadas', 'Falhas', 'Tokens', 'Tempo médio']}>
            {u.porAgente.map((a) => (
              <tr key={`${a.origem}-${a.agente}`}>
                <td><strong>{nomeDoAgente(a)}</strong></td>
                <td>{a.chamadas}</td>
                <td>{a.falhas > 0 ? <span style={{ color: 'var(--perigo)' }}>{a.falhas}</span> : 0}</td>
                <td className="mono">{a.tokens.toLocaleString('pt-BR')}</td>
                <td className="mono">{a.latenciaMedia} ms</td>
              </tr>
            ))}
          </Tabela>
        )}
      </Cartao>

      {u.porProvedor.length > 0 && (
        <Cartao titulo="Uso por modelo" semPadding>
          <Tabela cabecalho={['Provedor', 'Modelo', 'Chamadas', 'Tokens']}>
            {u.porProvedor.map((p, i) => (
              <tr key={i}>
                <td>{p.provedor}</td>
                <td className="mono">{p.modelo.replace(/^models\//, '')}</td>
                <td>{p.chamadas}</td>
                <td className="mono">{p.tokens.toLocaleString('pt-BR')}</td>
              </tr>
            ))}
          </Tabela>
        </Cartao>
      )}

      {c && (
        <>
          <h2 className="ci-titulo-secao">💬 Atendimento no período</h2>
          <div className="grade">
            <Metrica rotulo="Conversas" valor={c.total} />
            <Metrica rotulo="Com a IA" valor={c.comBot} />
            <Metrica rotulo="Na fila" valor={c.naFila} tom={c.naFila > 0 ? 'alerta' : undefined} />
            <Metrica rotulo="Com atendente" valor={c.comHumano} />
            <Metrica rotulo="Tempo até a 1ª resposta humana" valor={formatarSegundos(c.tempoMedioPrimeiraRespostaSegundos)} />
          </div>
        </>
      )}

      {banco.data && (
        <>
          <h2 className="ci-titulo-secao">🗄️ Banco de dados</h2>
          <div className="grade">
            <Metrica rotulo="Motor" valor={banco.data.motor} detalhe="Local" />
            <Metrica rotulo="Tamanho do arquivo" valor={formatarBytes(banco.data.arquivo?.tamanhoBytes)} detalhe="Faça backup com frequência" />
          </div>

          <Cartao titulo="Registros por tabela" semPadding>
            <Tabela cabecalho={['Tabela', 'Registros']}>
              {banco.data.tabelas.map((t) => (
                <tr key={t.rotulo}>
                  <td>{t.rotulo}</td>
                  <td className="mono">{t.registros.toLocaleString('pt-BR')}</td>
                </tr>
              ))}
            </Tabela>
          </Cartao>
        </>
      )}
    </div>
  );
}
