import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Aviso, Botao, Carregando, Entrada } from '../componentes/ui.jsx';
import './TextosDev.css';

/**
 * Textos do sistema — pagina do perfil DEV.
 *
 * O jeito principal de editar e o modo de edicao (o botao flutuante do DEV,
 * clicando no texto na propria tela). Esta pagina e o painel de controle: a lista de tudo que ja foi
 * trocado, a troca manual (para textos que nao da para clicar, como os da
 * tela de login) e as mensagens que o sistema manda sozinho ao cliente.
 *
 * A pagina inteira fica fora da troca de textos (`data-sem-textos`): ela
 * mostra os textos ORIGINAIS, e trocar o que ela exibe confundiria a lista.
 */
export function TextosDev() {
  const queryClient = useQueryClient();
  const [busca, setBusca] = useState('');
  const [manual, setManual] = useState({ original: '', novo: '' });
  const [aviso, setAviso] = useState(null);

  const { data, isLoading } = useQuery({ queryKey: ['dev', 'textos'], queryFn: () => api.get('/api/dev/textos') });

  const aoMudar = (novo, mensagem) => {
    queryClient.setQueryData(['dev', 'textos'], novo);
    queryClient.invalidateQueries({ queryKey: ['textos'] });
    setAviso(mensagem ? { tom: 'sucesso', texto: mensagem } : null);
  };
  const aoFalhar = (err) => setAviso({ tom: 'perigo', texto: err.message });

  const trocar = useMutation({
    mutationFn: (d) => api.put('/api/dev/textos/interface', d),
    onSuccess: (novo, d) => aoMudar(novo, d.novo ? null : `"${d.original}" voltou ao original.`),
    onError: aoFalhar
  });
  const restaurarTudo = useMutation({
    mutationFn: () => api.delete('/api/dev/textos/interface'),
    onSuccess: (novo) => aoMudar(novo, 'Todos os textos da tela voltaram ao original.'),
    onError: aoFalhar
  });
  const mensagem = useMutation({
    mutationFn: ({ chave, texto }) => api.put(`/api/dev/textos/mensagens/${chave}`, { texto }),
    onSuccess: (novo) => aoMudar(novo, 'Mensagem salva.'),
    onError: aoFalhar
  });

  if (isLoading || !data) return <Carregando />;

  const termo = busca.trim().toLowerCase();
  const lista = data.interface.filter(
    (t) => !termo || t.original.toLowerCase().includes(termo) || t.novo.toLowerCase().includes(termo)
  );

  return (
    <div className="coluna textos-dev" data-sem-textos>
      <header className="textos-dev__topo">
        <div>
          <h1>Textos do sistema</h1>
          <p className="texto-suave">
            Troque qualquer texto que aparece na tela e as mensagens que o sistema manda sozinho ao cliente. Só o
            perfil DEV vê esta página.
          </p>
        </div>
      </header>

      <Aviso tom="info" titulo="Como funciona">
        Vá até a tela que quer mudar, ligue o botão <strong>✏️ Editar textos</strong> (no rodapé, só o DEV vê) e
        clique no texto: título, botão, menu, dica, aviso. Para ir a outra tela, saia do modo (Esc) e navegue
        normalmente. A troca vale para todo lugar onde aquele texto aparece, para toda a empresa. Textos que mudam com o dado (como &quot;Ficha de Carlos&quot;) são trocados um a um.
      </Aviso>

      {aviso && (
        <Aviso tom={aviso.tom} aoFechar={() => setAviso(null)}>
          {aviso.texto}
        </Aviso>
      )}

      {/* ---- Mensagens ao cliente ---- */}
      <section className="textos-dev__secao">
        <h2>Mensagens automáticas ao cliente</h2>
        <p className="texto-fraco">O que o sistema escreve no WhatsApp sem ninguém digitar. Em branco = texto padrão.</p>
        <div className="textos-dev__mensagens">
          {data.mensagens.map((m) => (
            <CartaoMensagem
              key={m.chave}
              m={m}
              salvando={mensagem.isPending && mensagem.variables?.chave === m.chave}
              aoSalvar={(texto) => mensagem.mutate({ chave: m.chave, texto })}
            />
          ))}
        </div>
      </section>

      {/* ---- Troca manual ---- */}
      <section className="textos-dev__secao">
        <h2>Trocar um texto pelo nome</h2>
        <p className="texto-fraco">
          Para textos que não dá para clicar (a tela de login, por exemplo). Escreva o texto exatamente como aparece.
        </p>
        <form
          className="textos-dev__manual"
          onSubmit={(e) => {
            e.preventDefault();
            trocar.mutate(manual, { onSuccess: () => setManual({ original: '', novo: '' }) });
          }}
        >
          <Entrada
            placeholder="Texto original (ex.: Entrar)"
            value={manual.original}
            maxLength={1000}
            onChange={(e) => setManual({ ...manual, original: e.target.value })}
          />
          <span className="textos-dev__seta" aria-hidden="true">→</span>
          <Entrada
            placeholder="Novo texto"
            value={manual.novo}
            maxLength={1000}
            onChange={(e) => setManual({ ...manual, novo: e.target.value })}
          />
          <Botao type="submit" disabled={!manual.original.trim() || !manual.novo.trim()} carregando={trocar.isPending}>
            Trocar
          </Botao>
        </form>
      </section>

      {/* ---- Lista das trocas ---- */}
      <section className="textos-dev__secao">
        <div className="linha linha--entre">
          <h2>
            Textos alterados <span className="texto-fraco">({data.interface.length})</span>
          </h2>
          {data.interface.length > 0 && (
            <Botao
              variante="fantasma"
              tamanho="sm"
              carregando={restaurarTudo.isPending}
              onClick={() => {
                if (confirm(`Voltar os ${data.interface.length} textos da tela ao original?`)) restaurarTudo.mutate();
              }}
            >
              Voltar tudo ao original
            </Botao>
          )}
        </div>

        {data.interface.length === 0 ? (
          <p className="texto-fraco">Nenhum texto da tela foi trocado ainda.</p>
        ) : (
          <>
            <Entrada placeholder="Buscar pelo texto original ou pelo novo..." value={busca} onChange={(e) => setBusca(e.target.value)} />
            <div className="textos-dev__lista">
              {lista.map((t) => (
                <LinhaTexto
                  key={t.original}
                  t={t}
                  aoSalvar={(novo) => trocar.mutate({ original: t.original, novo })}
                  aoRestaurar={() => trocar.mutate({ original: t.original, novo: '' })}
                />
              ))}
              {lista.length === 0 && <p className="texto-fraco">Nada encontrado para &quot;{busca}&quot;.</p>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function LinhaTexto({ t, aoSalvar, aoRestaurar }) {
  const [valor, setValor] = useState(t.novo);
  const mudou = valor.trim() !== t.novo;
  return (
    <div className="textos-dev__linha">
      <div className="textos-dev__original" title={t.original}>
        {t.original}
      </div>
      <span className="textos-dev__seta" aria-hidden="true">→</span>
      <Entrada value={valor} maxLength={1000} onChange={(e) => setValor(e.target.value)} aria-label={`Novo texto para ${t.original}`} />
      <div className="textos-dev__acoes">
        {mudou && (
          <Botao tamanho="sm" disabled={!valor.trim()} onClick={() => aoSalvar(valor)}>
            Salvar
          </Botao>
        )}
        <Botao variante="fantasma" tamanho="sm" onClick={aoRestaurar} title="Voltar ao original">
          Restaurar
        </Botao>
      </div>
    </div>
  );
}

function CartaoMensagem({ m, salvando, aoSalvar }) {
  const [valor, setValor] = useState(m.texto ?? '');
  const mudou = valor.trim() !== (m.texto ?? '');
  return (
    <article className={`textos-dev__mensagem${m.texto ? ' textos-dev__mensagem--alterada' : ''}`}>
      <div className="linha linha--entre">
        <strong>{m.titulo}</strong>
        <span className={`textos-dev__selo${m.texto ? ' textos-dev__selo--alterada' : ''}`}>{m.texto ? 'Alterada' : 'Padrão'}</span>
      </div>
      <p className="texto-fraco">Quando: {m.quando}</p>
      <textarea
        className="entrada entrada--area"
        rows={2}
        maxLength={1000}
        placeholder={m.padrao}
        value={valor}
        onChange={(e) => setValor(e.target.value)}
      />
      <div className="linha linha--fim">
        {m.texto && (
          <Botao
            variante="fantasma"
            tamanho="sm"
            onClick={() => {
              setValor('');
              aoSalvar('');
            }}
          >
            Voltar ao padrão
          </Botao>
        )}
        <Botao tamanho="sm" disabled={!mudou} carregando={salvando} onClick={() => aoSalvar(valor)}>
          Salvar
        </Botao>
      </div>
    </article>
  );
}
