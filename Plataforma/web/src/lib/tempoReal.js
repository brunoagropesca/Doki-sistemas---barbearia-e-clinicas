import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Tempo real: o servidor avisa "isto mudou" e a tela busca de novo.
 *
 * A conexao (Server-Sent Events) so carrega o AVISO, nunca o dado: quem busca
 * e a mesma API de sempre, que ja aplica permissao e empresa. Por isso nao ha
 * o que vazar por este canal e nenhuma regra de seguranca foi duplicada nele.
 *
 * O navegador reconecta sozinho se a conexao cair. Alem disso as telas mantem
 * um polling lento como rede de seguranca — o aviso acelera, nao substitui.
 *
 * Deve ser usado UMA vez, no layout: uma conexao por aba, nao por tela.
 */

/** O que atualizar quando cada tipo de evento chega. */
const REACOES = {
  'conversa.mudou': [['conversas'], ['conversa'], ['quadro'], ['agenda', 'cliente']],
  'agenda.mudou': [['agenda'], ['quadro'], ['lead']],
  // So chega na aba de quem recebeu o aviso: o servidor enderecou o evento.
  'aviso.novo': [['avisos']],
  // Encaminhamento da IA: criado (so para quem recebeu) ou fechado (alguem atendeu).
  'notificacao.mudou': [['notificacoes']]
};

export function useTempoReal(ativo = true) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!ativo || typeof EventSource === 'undefined') return undefined;

    const fonte = new EventSource('/api/eventos', { withCredentials: true });

    const ouvintes = Object.entries(REACOES).map(([tipo, chaves]) => {
      const fn = () => {
        for (const queryKey of chaves) queryClient.invalidateQueries({ queryKey });
      };
      fonte.addEventListener(tipo, fn);
      return [tipo, fn];
    });

    return () => {
      for (const [tipo, fn] of ouvintes) fonte.removeEventListener(tipo, fn);
      fonte.close();
    };
  }, [ativo, queryClient]);
}
