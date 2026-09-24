import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';
import { useAuth } from './autenticacao.jsx';

/**
 * Funcoes do sistema ligadas/desligadas pelo perfil DEV.
 *
 * A tela so ESCONDE o que esta desligado; quem bloqueia de verdade e a API,
 * que responde 404 para a funcao desligada. Enquanto a lista carrega, tudo
 * conta como ligado: piscar o menu sumindo e voltando seria pior do que
 * mostrar por um instante algo que a API vai recusar.
 */
export function useFuncoes() {
  const { usuario } = useAuth();
  const { data } = useQuery({
    queryKey: ['funcoes'],
    queryFn: () => api.get('/api/funcoes'),
    enabled: Boolean(usuario),
    staleTime: 60_000
  });
  const estado = data?.funcoes ?? {};
  return { ligada: (chave) => !chave || estado[chave] !== false };
}

/**
 * Envolve uma tela inteira. Desligada, a empresa ve um aviso no lugar. O DEV
 * continua entrando (com uma faixa avisando), para conferir a tela antes de
 * religar.
 */
export function ExigeFuncao({ chave, children }) {
  const { ligada } = useFuncoes();
  const { usuario } = useAuth();

  if (ligada(chave)) return children;

  if (usuario?.cargo === 'dev') {
    return (
      <>
        <div className="faixa-funcao-desligada" role="status">
          Esta função está <strong>desligada</strong> para a empresa. Só você (DEV) está vendo esta tela, e ela
          não vai funcionar até ser religada em Funções do sistema.
        </div>
        {children}
      </>
    );
  }

  return (
    <div style={{ padding: 'var(--e6)' }}>
      <h1>Recurso indisponível</h1>
      <p className="texto-suave" style={{ marginTop: 'var(--e2)' }}>
        Este recurso não está ativo no seu sistema. Fale com o responsável pela plataforma.
      </p>
    </div>
  );
}
