import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { haPublicoGuardado } from '../lib/publicoDeCampanha.js';
import { Aviso, Botao, Carregando, Cartao, Modal, Status, Tabela, Vazio } from '../componentes/ui.jsx';
import { BarraProgresso, Controles, EM_PREPARO } from './campanhas/comum.jsx';
import './campanhas/campanhas.css';

/**
 * Campanhas de disparo.
 *
 * A lista e o painel de controle: cada campanha ativa mostra o progresso ao
 * vivo e os botoes Iniciar / Pausar / Parar. Criar e montar uma campanha
 * acontece no assistente em etapas (/campanhas/nova), que impoe a revisao
 * humana: nada sai sem alguem ler e aprovar.
 */
export function Campanhas() {
  const navegar = useNavigate();
  const queryClient = useQueryClient();
  const [erro, setErro] = useState(null);
  const [apagando, setApagando] = useState(null);

  /**
   * Chegou dos Contatos com gente marcada? Vai direto para o assistente, que
   * ja comeca com esse publico.
   */
  useEffect(() => {
    if (haPublicoGuardado()) navegar('/campanhas/nova', { replace: true });
  }, [navegar]);

  const lista = useQuery({
    queryKey: ['campanhas'],
    queryFn: () => api.get('/api/campanhas'),
    // Com alguma campanha andando, a barra precisa andar junto; parada, nao
    // ha por que perguntar ao servidor toda hora.
    refetchInterval: (q) =>
      (q.state.data?.campanhas ?? []).some((c) => ['enviando', 'gerando'].includes(c.status)) ? 3000 : 20_000
  });
  const campanhas = lista.data?.campanhas ?? [];

  const apagar = useMutation({
    mutationFn: (id) => api.delete(`/api/campanhas/${id}`),
    onSuccess: () => {
      setApagando(null);
      queryClient.invalidateQueries({ queryKey: ['campanhas'] });
    },
    onError: (err) => {
      setApagando(null);
      setErro(err.message);
    }
  });

  const abrir = (c) => navegar(`/campanhas/${c.id}`);

  return (
    <div className="coluna">
      <header className="linha linha--entre">
        <div>
          <h1>Campanhas</h1>
          <p className="texto-suave">Disparo em massa com uma mensagem pessoal para cada cliente, escrita pela IA.</p>
        </div>
        <Botao onClick={() => navegar('/campanhas/nova')}>Nova campanha</Botao>
      </header>

      {erro && (
        <Aviso tom="perigo" aoFechar={() => setErro(null)}>
          {erro}
        </Aviso>
      )}

      <Cartao semPadding titulo={`${campanhas.length} campanha(s)`}>
        {lista.isLoading ? (
          <Carregando />
        ) : campanhas.length === 0 ? (
          <Vazio
            titulo="Nenhuma campanha ainda"
            descricao="Crie uma para reativar clientes que sumiram, avisar de uma novidade ou lembrar de um retorno."
            acao={<Botao onClick={() => navegar('/campanhas/nova')}>Nova campanha</Botao>}
          />
        ) : (
          <Tabela cabecalho={['Campanha', 'Status', 'Progresso', 'Resultado', '']}>
            {campanhas.map((c) => (
              <tr key={c.id}>
                <td>
                  <div className="camp-lista__nome">
                    <button type="button" onClick={() => abrir(c)}>
                      {c.nome}
                    </button>
                    <span className="texto-fraco camp-lista__objetivo" title={c.objetivo}>
                      {c.objetivo || 'Sem objetivo descrito'}
                    </span>
                  </div>
                </td>
                <td>
                  <Status valor={c.status} />
                </td>
                <td style={{ minWidth: 220 }}>
                  <BarraProgresso campanha={c} />
                </td>
                <td>
                  <div className="camp-resultado">
                    <span>
                      <b>{c.progresso.enviadas}</b> enviada(s)
                    </span>
                    <span className={c.progresso.falhas > 0 ? 'camp-resultado--falha' : ''}>
                      <b>{c.progresso.falhas}</b> falha(s)
                    </span>
                    <span>
                      <b>{c.progresso.respostas}</b> resposta(s)
                    </span>
                  </div>
                </td>
                <td>
                  <AcoesDaLinha
                    campanha={c}
                    aoAbrir={() => abrir(c)}
                    aoApagar={() => setApagando(c)}
                    aoErro={setErro}
                  />
                </td>
              </tr>
            ))}
          </Tabela>
        )}
      </Cartao>

      {apagando && (
        <Modal
          titulo="Apagar campanha?"
          aberto
          aoFechar={() => setApagando(null)}
          rodape={
            <>
              <Botao variante="secundario" onClick={() => setApagando(null)}>
                Voltar
              </Botao>
              <Botao variante="perigo" carregando={apagar.isPending} onClick={() => apagar.mutate(apagando.id)}>
                Apagar
              </Botao>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            <strong>{apagando.nome}</strong> sai da lista. As mensagens que já foram enviadas continuam nas conversas
            de cada cliente.
          </p>
        </Modal>
      )}
    </div>
  );
}

/**
 * Os botoes de cada linha mudam com a fase da campanha.
 *
 * Em montagem: continuar de onde parou. Ativa (pronta, enviando, pausada,
 * gerando): Iniciar / Pausar / Parar. Encerrada: ver o relatorio.
 */
function AcoesDaLinha({ campanha: c, aoAbrir, aoApagar, aoErro }) {
  const ativa = ['pronta', 'enviando', 'pausada'].includes(c.status);
  const emMontagem = EM_PREPARO.includes(c.status) && c.status !== 'pronta';

  // Ativa: so os tres controles (o nome da campanha ja abre o relatorio).
  if (ativa) return <Controles campanha={c} aoErro={aoErro} />;

  return (
    <div className="camp-controles">
      <Botao tamanho="sm" variante={emMontagem ? 'secundario' : 'fantasma'} onClick={aoAbrir}>
        {c.status === 'gerando' ? 'Acompanhar' : emMontagem ? 'Continuar' : 'Relatório'}
      </Botao>
      {c.status !== 'gerando' && (
        <Botao tamanho="sm" variante="fantasma" onClick={aoApagar} aria-label={`Apagar ${c.nome}`} title="Apagar">
          ✕
        </Botao>
      )}
    </div>
  );
}
