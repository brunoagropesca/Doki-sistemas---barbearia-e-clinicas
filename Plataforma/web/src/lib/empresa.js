import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';

/**
 * A empresa de quem entrou: nome, logo e a base de conhecimento.
 *
 * O menu lateral e a pagina da Base de conhecimento leem a MESMA consulta
 * (cache compartilhado): salvou o nome ou o logo, o menu troca na hora.
 */
export function useEmpresa() {
  return useQuery({
    queryKey: ['empresa'],
    queryFn: () => api.get('/api/empresa'),
    staleTime: 5 * 60_000,
    select: (d) => d.empresa
  });
}
