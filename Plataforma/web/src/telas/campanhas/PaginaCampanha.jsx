import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Aviso, Carregando } from '../../componentes/ui.jsx';
import { AssistenteCampanha } from './AssistenteCampanha.jsx';
import { RelatorioCampanha } from './RelatorioCampanha.jsx';
import { EM_PREPARO } from './comum.jsx';
import './campanhas.css';

/**
 * /campanhas/:id — o assistente enquanto a campanha e montada; o relatorio
 * (com progresso ao vivo e controles) depois que o disparo comeca.
 *
 * "/campanhas/nova" tambem chega aqui, com id = "nova". Ao salvar a primeira
 * etapa, o endereco troca para o id de verdade e este MESMO componente
 * continua na tela — por isso o que foi preenchido nas outras etapas (como o
 * publico trazido dos Contatos) nao se perde.
 */
export function PaginaCampanha() {
  const { id } = useParams();
  const nova = id === 'nova';

  const consulta = useQuery({
    queryKey: ['campanha', id],
    queryFn: () => api.get(`/api/campanhas/${id}`),
    enabled: !nova,
    refetchInterval: (q) => {
      const status = q.state.data?.campanha?.status;
      if (status === 'gerando') return 1500;
      if (status === 'enviando') return 3000;
      return false;
    }
  });

  const campanha = consulta.data?.campanha ?? null;

  if (!nova && consulta.isLoading) return <Carregando texto="Abrindo a campanha..." />;
  if (!nova && consulta.isError) return <Aviso tom="perigo">{consulta.error.message}</Aviso>;

  if (campanha && !EM_PREPARO.includes(campanha.status)) {
    return <RelatorioCampanha campanha={campanha} />;
  }

  return <AssistenteCampanha campanha={campanha} />;
}
