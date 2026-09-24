import { useSearchParams } from 'react-router-dom';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Botao } from '../componentes/ui.jsx';
import { Personas } from './central-ia/Personas.jsx';
import { Cascata } from './central-ia/Cascata.jsx';
import { Simulador } from './central-ia/Simulador.jsx';
import { Metricas } from './central-ia/Metricas.jsx';
import { BaseConhecimento } from './central-ia/BaseConhecimento.jsx';
import './central-ia/CentralIa.css';

/**
 * Central de Configuracao da Inteligencia Artificial.
 *
 * Uma tela so para tudo que e IA: o que ela sabe da empresa (a base de
 * conhecimento), quem sao os agentes (Sofia e Atena), por
 * onde a IA passa (a cascata de provedores), como testar sem cliente de
 * verdade (o simulador) e quanto ela custa (as metricas).
 */

const ABAS = [
  ['conhecimento', '📚', 'Base de conhecimento'],
  ['personas', '🎭', 'Agentes'],
  ['cascata', '🌊', 'Cascata e provedores'],
  ['simulador', '💬', 'Simulador'],
  ['metricas', '📊', 'Métricas']
];

export function CentralIa() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();

  // A aba fica na URL: recarregar a pagina ou mandar o link para alguem
  // leva de volta para onde voce estava.
  const aba = ABAS.some(([chave]) => chave === params.get('aba')) ? params.get('aba') : 'conhecimento';

  // Serve de "termometro": se o banco responde, o sistema esta de pe.
  const banco = useQuery({ queryKey: ['ia', 'banco'], queryFn: () => api.get('/api/ia/banco'), refetchInterval: 30_000 });
  const atualizando = useIsFetching({ queryKey: ['ia'] }) > 0;

  return (
    <div className="ci">
      <header className="ci-cabecalho">
        <div className="ci-cabecalho__marca">
          <span className="ci-icone-grande" aria-hidden="true">⚡</span>
          <div>
            <h1>Central de Configuração da Inteligência Artificial</h1>
            <p className="texto-fraco">Base de conhecimento, agentes, cascata de modelos, simulador e métricas.</p>
          </div>
        </div>

        <div className="linha">
          <span className={`ci-status ${banco.isError ? 'ci-status--erro' : ''}`}>
            <span className="ci-status__ponto" aria-hidden="true" />
            {banco.isError ? 'Banco offline' : banco.data ? `${banco.data.motor} Local Online` : 'Verificando...'}
          </span>
          <Botao
            variante="secundario"
            tamanho="sm"
            carregando={atualizando}
            onClick={() => queryClient.invalidateQueries()}
          >
            🔄 Atualizar
          </Botao>
        </div>
      </header>

      <nav className="ci-abas" role="tablist" aria-label="Seções da central de IA">
        {ABAS.map(([chave, icone, rotulo]) => (
          <button
            key={chave}
            role="tab"
            aria-selected={aba === chave}
            className={`ci-aba ${aba === chave ? 'ci-aba--ativa' : ''}`}
            onClick={() => setParams({ aba: chave }, { replace: true })}
          >
            <span aria-hidden="true">{icone}</span> {rotulo}
          </button>
        ))}
      </nav>

      <div role="tabpanel">
        {aba === 'conhecimento' && <BaseConhecimento />}
        {aba === 'personas' && <Personas />}
        {aba === 'cascata' && <Cascata />}
        {aba === 'simulador' && <Simulador />}
        {aba === 'metricas' && <Metricas />}
      </div>
    </div>
  );
}
