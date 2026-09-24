import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';

/**
 * Consultas e acoes da Central de Conexoes.
 *
 * Tudo que fala com /api/canais passa por aqui, para as telas nao precisarem
 * saber qual e a rota nem lembrar de atualizar a lista depois de cada acao.
 */

/** A chave da lista de sessoes. A tela de Campanhas usa a mesma, entao o cache e dividido. */
export const CHAVE_CANAIS = ['canais'];

/**
 * A lista de sessoes.
 *
 * Enquanto alguma sessao esta ligando ou esperando a leitura do QR Code, a
 * tela precisa acompanhar de perto (o codigo vence em poucos segundos). Fora
 * disso, um olhar a cada 8s basta para perceber que o celular caiu.
 * O React Query pausa esse relogio sozinho quando a aba do navegador esta em
 * segundo plano, entao nao gastamos requisicao a toa.
 */
export function useCanais() {
  return useQuery({
    queryKey: CHAVE_CANAIS,
    queryFn: () => api.get('/api/canais'),
    refetchInterval: (consulta) => {
      const canais = consulta.state.data?.canais ?? [];
      const acompanhar = canais.some((c) => c.status === 'conectando' || c.status === 'aguardando_qr');
      return acompanhar ? 2000 : 8000;
    }
  });
}

// --- Leitura e escrita dos campos de uma sessao ---------------------------

/**
 * O servidor devolve `iaHabilitada`, `nome` e `ativo` soltos e as
 * preferencias dentro de `config`. Estas duas funcoes escondem essa diferenca.
 */
const CAMPOS_NA_RAIZ = ['iaHabilitada', 'nome', 'ativo'];

export function lerCampoDoCanal(canal, campo) {
  return CAMPOS_NA_RAIZ.includes(campo) ? canal[campo] : canal.config?.[campo];
}

function aplicarValores(canal, valores) {
  const raiz = {};
  const config = {};
  for (const [campo, valor] of Object.entries(valores)) {
    (CAMPOS_NA_RAIZ.includes(campo) ? raiz : config)[campo] = valor;
  }
  return { ...canal, ...raiz, config: { ...canal.config, ...config } };
}

/** Troca uma sessao dentro da lista guardada em cache, sem esperar nova ida ao servidor. */
function atualizarCanalNoCache(clienteQuery, chave, transformar) {
  clienteQuery.setQueryData(CHAVE_CANAIS, (antigo) =>
    antigo ? { ...antigo, canais: antigo.canais.map((c) => (c.chave === chave ? transformar(c) : c)) } : antigo
  );
}

/**
 * Salva campos de UMA sessao (PATCH).
 *
 * Nao mexemos no cache antes da resposta: quem quer mostrar o valor "otimista"
 * usa `mutacao.variables` enquanto `mutacao.isPending`. Assim, se der erro, a
 * tela volta sozinha ao valor de antes, sem desfazer nada na mao.
 *
 * `sufixo` escolhe a rota: '/config' (preferencias, dono e gerente) ou ''
 * (nome e ativo, so o perfil tecnico).
 */
function useAlterarCanal(chave, sufixo) {
  const clienteQuery = useQueryClient();

  return useMutation({
    mutationFn: (alteracoes) => api.patch(`/api/canais/${encodeURIComponent(chave)}${sufixo}`, alteracoes),
    onSuccess: (dados, alteracoes) => {
      // Grava so os campos que foram enviados, com o valor que o SERVIDOR
      // aceitou (ele apara espacos, por exemplo). Trocar a sessao inteira
      // poderia apagar outra alteracao que ainda esta a caminho.
      if (!dados?.canal) return;
      const valores = Object.fromEntries(Object.keys(alteracoes).map((campo) => [campo, lerCampoDoCanal(dados.canal, campo)]));
      atualizarCanalNoCache(clienteQuery, chave, (c) => aplicarValores(c, valores));
    },
    // Devolver a promessa mantem a mutacao "pendente" ate a lista ser buscada
    // de novo: o interruptor nao pisca entre o valor novo e o antigo.
    onSettled: () => clienteQuery.invalidateQueries({ queryKey: CHAVE_CANAIS })
  });
}

/** Preferencias da conexao: IA, chamadas, "marcar como lida" e mensagem de chamada. */
export function useSalvarConfig(chave) {
  return useAlterarCanal(chave, '/config');
}

/** Nome e "sessao ativa" (so o perfil tecnico chega aqui; o servidor confere de novo). */
export function useAtualizarSessao(chave) {
  return useAlterarCanal(chave, '');
}

/**
 * Conectar e desconectar. Recebe `{ rota, corpo }`:
 *  - rota 'conectar'
 *  - rota 'desconectar' com corpo { sair: false } (guarda a sessao) ou { sair: true } (apaga)
 */
export function useAcaoCanal(chave) {
  const clienteQuery = useQueryClient();

  return useMutation({
    mutationFn: ({ rota, corpo }) => api.post(`/api/canais/${encodeURIComponent(chave)}/${rota}`, corpo ?? {}),
    // Botao so volta a ficar clicavel depois que a lista reflete o novo estado;
    // senao daria tempo de clicar em "Conectar" duas vezes.
    onSettled: () => clienteQuery.invalidateQueries({ queryKey: CHAVE_CANAIS })
  });
}

/** Cria uma sessao nova (so o perfil tecnico). */
export function useCriarSessao() {
  const clienteQuery = useQueryClient();

  return useMutation({
    mutationFn: (nome) => api.post('/api/canais', { nome, canal: 'whatsapp' }),
    onSuccess: (dados) => {
      // Ja coloca a sessao nova na lista: quem chamou vai selecionar a chave
      // dela agora, e ela precisa existir na lista neste instante.
      clienteQuery.setQueryData(CHAVE_CANAIS, (antigo) => {
        if (!antigo || antigo.canais.some((c) => c.chave === dados.canal.chave)) return antigo;
        const canais = [...antigo.canais, dados.canal].sort((a, b) => a.chave.localeCompare(b.chave));
        return { ...antigo, canais };
      });
      clienteQuery.invalidateQueries({ queryKey: CHAVE_CANAIS });
    }
  });
}

/** Remove a sessao (so o perfil tecnico). */
export function useRemoverSessao(chave) {
  const clienteQuery = useQueryClient();

  return useMutation({
    mutationFn: () => api.delete(`/api/canais/${encodeURIComponent(chave)}`),
    onSuccess: () => {
      clienteQuery.setQueryData(CHAVE_CANAIS, (antigo) =>
        antigo ? { ...antigo, canais: antigo.canais.filter((c) => c.chave !== chave) } : antigo
      );
      clienteQuery.invalidateQueries({ queryKey: CHAVE_CANAIS });
    }
  });
}

// --- Relogio --------------------------------------------------------------

/**
 * O "agora" da tela, atualizado a cada `intervaloMs`.
 *
 * Serve para a contagem regressiva do QR Code. O relogio para de girar assim
 * que o componente sai da tela (senao ficaria disparando para sempre).
 */
export function useAgora(intervaloMs = 1000) {
  const [agora, setAgora] = useState(() => Date.now());

  useEffect(() => {
    // Atualiza ja na montagem: o valor inicial pode ter ficado velho entre a
    // renderizacao e o efeito.
    setAgora(Date.now());
    const relogio = setInterval(() => setAgora(Date.now()), intervaloMs);
    return () => clearInterval(relogio);
  }, [intervaloMs]);

  return agora;
}
