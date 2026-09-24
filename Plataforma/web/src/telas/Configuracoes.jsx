import { Navigate, useSearchParams } from 'react-router-dom';
import { EditorFluxo } from './configuracoes/fluxo/EditorFluxo.jsx';

/**
 * Configuracoes gerais: o construtor visual do menu de atendimento.
 *
 * As conexoes de WhatsApp moram em /conexoes; tudo que e Inteligencia
 * Artificial (agentes, modelos, chaves, modo de atendimento, simulador) mora na
 * Central de IA, em /ia.
 */
export function Configuracoes() {
  const [params] = useSearchParams();

  // Links antigos (?aba=canais) continuam funcionando: levam para a pagina nova.
  if (params.get('aba') === 'canais') return <Navigate to="/conexoes" replace />;

  return <EditorFluxo />;
}
