import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Aviso, Carregando } from '../componentes/ui.jsx';
import './FuncoesDev.css';

/**
 * Funcoes do sistema — a pagina do perfil DEV.
 *
 * Liga e desliga as funcoes matrizes da empresa. Cada cartao diz o que a
 * funcao faz e, principalmente, o que acontece quando ela sai: desligar sem
 * saber o efeito e o jeito mais rapido de parar o atendimento de alguem.
 *
 * Salva na hora, a cada clique. Nao ha "salvar" no fim da pagina porque cada
 * interruptor e uma decisao independente — e o efeito e imediato no sistema.
 */
export function FuncoesDev() {
  const queryClient = useQueryClient();
  const [erro, setErro] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['dev', 'funcoes'],
    queryFn: () => api.get('/api/dev/funcoes')
  });

  const alternar = useMutation({
    mutationFn: ({ chave, ligada }) => api.put(`/api/dev/funcoes/${chave}`, { ligada }),
    onSuccess: (novo) => {
      setErro(null);
      queryClient.setQueryData(['dev', 'funcoes'], novo);
      // O menu e as telas leem outra consulta: atualiza para refletir na hora.
      queryClient.invalidateQueries({ queryKey: ['funcoes'] });
    },
    onError: (err) => setErro(err.message)
  });

  if (isLoading || !data) return <Carregando />;

  const desligadas = data.funcoes.filter((f) => !f.ligada).length;

  return (
    <div className="coluna funcoes-dev">
      <header className="funcoes-dev__topo">
        <div>
          <h1>Funções do sistema</h1>
          <p className="texto-suave">
            Liga e desliga as funções matrizes desta empresa. Só o perfil DEV vê esta página; a empresa não sabe que
            ela existe.
          </p>
        </div>
        <div className={`funcoes-dev__resumo${desligadas ? ' funcoes-dev__resumo--alerta' : ''}`}>
          <strong>{data.funcoes.length - desligadas}</strong> de {data.funcoes.length} ligadas
        </div>
      </header>

      {erro && <Aviso tom="perigo">{erro}</Aviso>}

      {data.grupos.map((g) => (
        <section key={g.chave} className="funcoes-dev__grupo">
          <div className="funcoes-dev__grupo-topo">
            <h2>{g.titulo}</h2>
            <span className="texto-fraco">{g.descricao}</span>
          </div>

          <div className="funcoes-dev__grade">
            {data.funcoes
              .filter((f) => f.grupo === g.chave)
              .map((f) => {
                const salvando = alternar.isPending && alternar.variables?.chave === f.chave;
                return (
                  <article key={f.chave} className={`funcao${f.ligada ? '' : ' funcao--desligada'}`}>
                    <div className="funcao__topo">
                      <div className="crescer">
                        <h3 className="funcao__titulo">{f.titulo}</h3>
                        <span className={`funcao__estado${f.ligada ? ' funcao__estado--ligada' : ''}`}>
                          {f.ligada ? 'Ligada' : 'Desligada'}
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={f.ligada}
                        aria-label={`${f.titulo}: ${f.ligada ? 'ligada' : 'desligada'}`}
                        className={`interruptor${f.ligada ? ' interruptor--ligado' : ''}`}
                        disabled={salvando}
                        onClick={() => {
                          if (f.ligada && !confirm(`Desligar "${f.titulo}"?\n\n${f.desligada}`)) return;
                          alternar.mutate({ chave: f.chave, ligada: !f.ligada });
                        }}
                      >
                        <span className="interruptor__bola" />
                      </button>
                    </div>
                    <p className="funcao__descricao">{f.descricao}</p>
                    <p className="funcao__efeito">
                      <strong>Desligada:</strong> {f.desligada}
                    </p>
                  </article>
                );
              })}
          </div>
        </section>
      ))}
    </div>
  );
}
