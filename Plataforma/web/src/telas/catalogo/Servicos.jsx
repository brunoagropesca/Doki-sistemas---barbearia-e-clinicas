import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { AreaTexto, Aviso, Botao, Campo, Carregando, Entrada, Modal, Selecao, Vazio } from '../../componentes/ui.jsx';
import { Busca, Chips, MenuAcoes, normalizar } from '../equipe/ListaEquipe.jsx';
import '../Equipe.css';
import './Catalogo.css';

/**
 * Aba de servicos do catalogo.
 *
 * Tres coisas que a tela antiga nao tinha e a empresa pedia:
 *   - CATEGORIAS de verdade: uma coluna com a contagem de cada uma, que filtra
 *     a lista, e onde se renomeia (ou junta) uma categoria de uma vez;
 *   - FILTROS: busca, situacao (ativo / inativo / sem ninguem que execute);
 *   - EDITAR: antes so dava para criar — preco errado era excluir e refazer.
 *
 * E o teto de 25 servicos ATIVOS fica sempre a vista, com a razao dele: e o
 * tamanho em que a Sofia ainda le o catalogo inteiro em cada conversa. O
 * servidor e quem trava; a tela so avisa antes, para ninguem preencher um
 * cadastro inteiro e descobrir no "Salvar".
 */

const LIMITE_PADRAO = 25;

const SITUACOES = [
  { chave: 'todos', rotulo: 'Todos' },
  { chave: 'ativos', rotulo: 'Ativos', ponto: 'sucesso' },
  { chave: 'inativos', rotulo: 'Inativos', ponto: 'neutro' },
  { chave: 'sem-profissional', rotulo: 'Sem profissional', ponto: 'alerta' }
];

const passaNaSituacao = {
  todos: () => true,
  ativos: (s) => s.ativo,
  inativos: (s) => !s.ativo,
  'sem-profissional': (s) => s.profissionais.length === 0
};

/** Centavos -> "45,00" para os campos de dinheiro. */
const emReais = (centavos) => ((Number(centavos) || 0) / 100).toFixed(2).replace('.', ',');

const duracaoLegivel = (min) => (min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? String(min % 60).padStart(2, '0') : ''}` : `${min} min`);

export function Servicos({ podeEditar, limite = LIMITE_PADRAO, pedidoNovo }) {
  const queryClient = useQueryClient();
  const [busca, setBusca] = useState('');
  const [situacao, setSituacao] = useState('todos');
  const [categoria, setCategoria] = useState(null); // null = todas
  const [ficha, setFicha] = useState(null); // { servico } ou { novo: true, categoria }
  const [renomeando, setRenomeando] = useState(null);

  const consulta = useQuery({ queryKey: ['servicos', 'todos'], queryFn: () => api.get('/api/servicos', { incluirInativos: 'true' }) });
  const todos = consulta.data?.servicos ?? [];
  const ativos = todos.filter((s) => s.ativo).length;
  const cheio = ativos >= limite;

  // O botao "Novo servico" mora no cabecalho da pagina (como na Equipe): cada
  // clique la vira um numero novo, que esta aba escuta.
  const [ultimoPedido, setUltimoPedido] = useState(pedidoNovo);
  if (pedidoNovo !== ultimoPedido) {
    setUltimoPedido(pedidoNovo);
    if (pedidoNovo) setFicha({ novo: true, categoria });
  }

  const categorias = useMemo(() => {
    const mapa = new Map();
    for (const s of todos) mapa.set(s.categoria, (mapa.get(s.categoria) ?? 0) + 1);
    return [...mapa.entries()].sort(([a], [b]) => a.localeCompare(b, 'pt-BR')).map(([nome, total]) => ({ nome, total }));
  }, [todos]);

  // Categoria escolhida que sumiu (renomeada, ultimo servico excluido): volta para "todas".
  const categoriaAtual = categoria && categorias.some((c) => c.nome === categoria) ? categoria : null;

  const termo = normalizar(busca.trim());
  const daCategoria = todos.filter((s) => !categoriaAtual || s.categoria === categoriaAtual);
  const buscados = daCategoria.filter(
    (s) => !termo || normalizar(`${s.nome} ${s.categoria} ${s.profissionais.map((p) => p.nome).join(' ')}`).includes(termo)
  );
  const visiveis = buscados.filter(passaNaSituacao[situacao]);

  // Agrupa por categoria so quando "todas" estao a mostra: dentro de uma
  // categoria, o titulo repetido seria ruido.
  const grupos = categoriaAtual
    ? [{ nome: null, itens: visiveis }]
    : categorias.map((c) => ({ nome: c.nome, itens: visiveis.filter((s) => s.categoria === c.nome) })).filter((g) => g.itens.length);

  const invalidar = () => {
    queryClient.invalidateQueries({ queryKey: ['servicos'] });
    queryClient.invalidateQueries({ queryKey: ['catalogo', 'metricas'] });
  };

  const alternar = useMutation({
    mutationFn: (s) => api.patch(`/api/servicos/${s.id}`, { ativo: !s.ativo }),
    onSuccess: invalidar
  });
  const excluir = useMutation({
    mutationFn: (s) => api.delete(`/api/servicos/${s.id}`),
    onSuccess: invalidar
  });

  function remover(s) {
    if (confirm(`Excluir "${s.nome}"?\n\nSe ele tiver horários marcados, o sistema pede para desativar em vez de excluir.`)) {
      excluir.mutate(s);
    }
  }

  const erroAcao = alternar.error ?? excluir.error;

  return (
    <div className="coluna">
      <AvisoLimite ativos={ativos} limite={limite} />

      {consulta.isLoading ? (
        <Carregando />
      ) : todos.length === 0 ? (
        <Vazio
          titulo="Nenhum serviço cadastrado"
          descricao="Cadastre os serviços para poder agendar — e para a Sofia saber o que oferecer. Sem serviço cadastrado ela não informa preço nenhum."
          acao={podeEditar && <Botao onClick={() => setFicha({ novo: true })}>Cadastrar o primeiro serviço</Botao>}
        />
      ) : (
        <div className="cat-layout">
          <nav className="cartao cat-categorias" aria-label="Categorias">
            <div className="cat-categorias__titulo">
              <span>Categorias</span>
              {podeEditar && (
                <button
                  type="button"
                  className="cat-categorias__nova"
                  // Categoria nao existe sozinha: nasce com o primeiro servico
                  // dela. Por isso "+ Nova" abre o cadastro ja no campo de nova.
                  title="A categoria nasce com o primeiro serviço dela"
                  onClick={() => setFicha({ novo: true, categoria: '' })}
                >
                  + Nova
                </button>
              )}
            </div>
            <ul>
              <li>
                <button
                  type="button"
                  className={`cat-categoria${!categoriaAtual ? ' cat-categoria--ativa' : ''}`}
                  aria-pressed={!categoriaAtual}
                  onClick={() => setCategoria(null)}
                >
                  <span>Todas</span>
                  <small>{todos.length}</small>
                </button>
              </li>
              {categorias.map((c) => (
                <li key={c.nome} className="cat-categorias__item">
                  <button
                    type="button"
                    className={`cat-categoria${categoriaAtual === c.nome ? ' cat-categoria--ativa' : ''}`}
                    aria-pressed={categoriaAtual === c.nome}
                    onClick={() => setCategoria(c.nome)}
                  >
                    <span>{c.nome}</span>
                    <small>{c.total}</small>
                  </button>
                  {podeEditar && (
                    <button
                      type="button"
                      className="cat-categoria__editar"
                      title={`Renomear "${c.nome}"`}
                      aria-label={`Renomear a categoria ${c.nome}`}
                      onClick={() => setRenomeando(c.nome)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
                        <path d="m13.5 6.5 4 4" />
                      </svg>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </nav>

          <div className="coluna cat-principal">
            <div className="eq-ferramentas">
              <Busca valor={busca} aoMudar={setBusca} rotulo="Serviço, categoria ou profissional" />
              <Chips
                rotulo="Situação"
                valor={situacao}
                aoMudar={setSituacao}
                opcoes={SITUACOES.map((f) => ({ ...f, total: buscados.filter(passaNaSituacao[f.chave]).length }))}
              />
            </div>

            {erroAcao && <Aviso tom="perigo">{erroAcao.message}</Aviso>}

            <section className="cartao eq-lista cat-lista" aria-label="Serviços">
              <div className="eq-linha eq-linha--cabecalho" aria-hidden="true">
                <span>Serviço</span>
                <span>Duração</span>
                <span>Preço</span>
                <span>Quem faz</span>
                <span>Situação</span>
                <span />
              </div>

              {visiveis.length === 0 ? (
                <p className="eq-lista__vazia">Nenhum serviço com esse filtro.</p>
              ) : (
                grupos.map((g) => (
                  <div key={g.nome ?? 'lista'} role="group" aria-label={g.nome ?? undefined}>
                    {g.nome && (
                      <div className="cat-grupo">
                        {g.nome}
                        <small>{g.itens.length}</small>
                      </div>
                    )}
                    {g.itens.map((s) => (
                      <LinhaServico
                        key={s.id}
                        servico={s}
                        podeEditar={podeEditar}
                        podeAtivar={!cheio}
                        aoAbrir={() => podeEditar && setFicha({ servico: s })}
                        aoAlternar={() => alternar.mutate(s)}
                        aoExcluir={() => remover(s)}
                      />
                    ))}
                  </div>
                ))
              )}

              <p className="eq-lista__rodape">
                {visiveis.length === todos.length
                  ? `${todos.length} serviço${todos.length === 1 ? '' : 's'} · ${ativos} ativo${ativos === 1 ? '' : 's'}`
                  : `Mostrando ${visiveis.length} de ${todos.length}`}
              </p>
            </section>
          </div>
        </div>
      )}

      {ficha && (
        <FichaServico
          servico={ficha.servico}
          categoriaInicial={ficha.categoria}
          categorias={categorias.map((c) => c.nome)}
          semVaga={cheio}
          limite={limite}
          aoFechar={() => setFicha(null)}
          aoSalvar={() => {
            setFicha(null);
            invalidar();
          }}
        />
      )}

      {renomeando && (
        <ModalRenomearCategoria
          atual={renomeando}
          categorias={categorias.map((c) => c.nome)}
          aoFechar={() => setRenomeando(null)}
          aoSalvar={(para) => {
            setRenomeando(null);
            if (categoriaAtual === renomeando) setCategoria(para);
            invalidar();
          }}
        />
      )}
    </div>
  );
}

/**
 * O teto sempre a vista, com a razao. Fica discreto longe do limite e muda de
 * tom perto dele (a partir de 80%) e quando chega.
 */
function AvisoLimite({ ativos, limite }) {
  const fracao = Math.min(1, ativos / limite);
  const nivel = ativos >= limite ? 'cheio' : fracao >= 0.8 ? 'alto' : 'ok';
  const restam = Math.max(0, limite - ativos);

  return (
    <div className={`cat-limite cat-limite--${nivel}`} role="status">
      <div className="cat-limite__numeros">
        <strong className="mono">
          {ativos}
          <span> / {limite}</span>
        </strong>
        <span>serviços ativos</span>
      </div>
      <div className="cat-limite__texto">
        <p>
          {nivel === 'cheio'
            ? 'Limite atingido. Para ativar ou cadastrar outro serviço ativo, desative um dos atuais.'
            : nivel === 'alto'
              ? `Restam ${restam} vaga${restam === 1 ? '' : 's'} para serviços ativos.`
              : `O catálogo aceita no máximo ${limite} serviços ativos.`}
        </p>
        <small>
          É o tamanho que a Sofia consegue ler inteiro em cada conversa, sem inventar. Serviços inativos não contam.
        </small>
      </div>
      <span className="cat-limite__trilho" aria-hidden="true">
        <span className="cat-limite__barra" style={{ width: `${fracao * 100}%` }} />
      </span>
    </div>
  );
}

function LinhaServico({ servico: s, podeEditar, podeAtivar, aoAbrir, aoAlternar, aoExcluir }) {
  const proprios = s.profissionais.filter((p) => p.precoProprio);
  return (
    <div
      className={`eq-linha${s.ativo ? '' : ' eq-linha--inativa'}${podeEditar ? '' : ' eq-linha--travada'}`}
      role={podeEditar ? 'button' : undefined}
      tabIndex={podeEditar ? 0 : undefined}
      onClick={aoAbrir}
      onKeyDown={(e) => podeEditar && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), aoAbrir())}
      aria-label={podeEditar ? `Editar ${s.nome}` : undefined}
    >
      <span className="eq-pessoa__texto">
        <strong>{s.nome}</strong>
        {/* A categoria ja aparece no titulo do grupo (ou no filtro escolhido). */}
        {s.descricao && <small>{s.descricao}</small>}
      </span>

      <span className="eq-celula">
        {duracaoLegivel(s.duracaoMinutos)}
        {s.intervaloAposMinutos > 0 && <small title="Folga após o atendimento">+{s.intervaloAposMinutos} min de folga</small>}
      </span>

      <span className="eq-celula">
        <span className="mono">{s.precoFormatado}</span>
        {proprios.length > 0 && (
          <small title={proprios.map((p) => `${p.nome}: ${p.precoFormatado}`).join('\n')}>
            {proprios.length} com valor próprio
          </small>
        )}
      </span>

      <span className="eq-celula">
        {s.profissionais.length === 0 ? (
          // Sem ninguem o servico nao aparece para agendar: precisa saltar aos olhos.
          <span className="eq-alerta">Ninguém executa</span>
        ) : (
          <span className="cat-pessoas" title={s.profissionais.map((p) => p.nome).join(', ')}>
            {s.profissionais.slice(0, 4).map((p) => (
              <span key={p.id} className="cat-pessoa" style={{ '--cor': p.cor || 'var(--superficie-3)' }}>
                {p.nome.slice(0, 1).toUpperCase()}
              </span>
            ))}
            {s.profissionais.length > 4 && <span className="cat-pessoa cat-pessoa--mais">+{s.profissionais.length - 4}</span>}
          </span>
        )}
      </span>

      <span className="eq-celula">
        <span className={`eq-situacao${s.ativo ? '' : ' eq-situacao--inativa'}`}>
          <span className={`eq-ponto eq-ponto--${s.ativo ? 'sucesso' : 'neutro'}`} aria-hidden="true" />
          {s.ativo ? 'Ativo' : 'Inativo'}
        </span>
      </span>

      <span className="eq-acoes">
        {podeEditar && (
          <MenuAcoes
            rotulo={`Ações de ${s.nome}`}
            acoes={[
              { rotulo: 'Editar', aoClicar: aoAbrir },
              s.ativo
                ? { rotulo: 'Desativar', aoClicar: aoAlternar }
                : { rotulo: 'Ativar', desabilitado: !podeAtivar, dica: podeAtivar ? undefined : 'Limite de serviços ativos atingido', aoClicar: aoAlternar },
              { rotulo: 'Excluir', perigo: true, aoClicar: aoExcluir }
            ]}
          />
        )}
      </span>
    </div>
  );
}

const NOVA_CATEGORIA = '__nova__';

/** Criar e editar servico: o mesmo formulario. */
function FichaServico({ servico, categoriaInicial, categorias, semVaga, limite, aoFechar, aoSalvar }) {
  const editando = Boolean(servico);
  const categoriaDeInicio = servico?.categoria ?? categoriaInicial ?? categorias[0] ?? 'Geral';

  const [form, setForm] = useState(() => ({
    nome: servico?.nome ?? '',
    descricao: servico?.descricao ?? '',
    categoria: categorias.includes(categoriaDeInicio) ? categoriaDeInicio : NOVA_CATEGORIA,
    categoriaNova: categorias.includes(categoriaDeInicio) ? '' : categoriaDeInicio,
    duracaoMinutos: servico?.duracaoMinutos ?? 30,
    intervaloAposMinutos: servico?.intervaloAposMinutos ?? 0,
    preco: servico ? emReais(servico.precoCentavos) : '',
    // Sem vaga, o novo nasce inativo (e o servidor recusaria ativo).
    ativo: servico?.ativo ?? !semVaga,
    // Guarda o vinculo inteiro: editar o servico nao pode apagar o preco
    // proprio que um profissional tem nele.
    profissionais: (servico?.profissionais ?? []).map((p) => ({
      professionalId: p.id,
      precoCentavos: p.precoProprio ? p.precoCentavos : null,
      duracaoMinutos: p.duracaoPropria ? p.duracaoMinutos : null
    }))
  }));
  const mudar = (campo) => (e) => setForm({ ...form, [campo]: e.target.value });

  const equipe = useQuery({ queryKey: ['profissionais', 'todos'], queryFn: () => api.get('/api/profissionais', { incluirInativos: 'true' }) });
  const marcados = new Set(form.profissionais.map((p) => p.professionalId));
  // Ativos, mais qualquer inativo que ja esteja ligado (para dar para desligar).
  const pessoas = (equipe.data?.profissionais ?? []).filter((p) => p.ativo || marcados.has(p.id));

  const salvar = useMutation({
    mutationFn: (corpo) => (editando ? api.patch(`/api/servicos/${servico.id}`, corpo) : api.post('/api/servicos', corpo)),
    onSuccess: aoSalvar
  });
  const erros = salvar.error?.camposComErro ?? {};

  // Ativar um inativo tambem ocupa vaga.
  const ativarSemVaga = semVaga && form.ativo && !(editando && servico.ativo);

  function alternarProfissional(id) {
    setForm({
      ...form,
      profissionais: marcados.has(id)
        ? form.profissionais.filter((p) => p.professionalId !== id)
        : [...form.profissionais, { professionalId: id }]
    });
  }

  function enviar() {
    const categoria = form.categoria === NOVA_CATEGORIA ? form.categoriaNova.trim() : form.categoria;
    salvar.mutate({
      nome: form.nome,
      descricao: form.descricao,
      categoria: categoria || 'Geral',
      duracaoMinutos: Number(form.duracaoMinutos),
      intervaloAposMinutos: Number(form.intervaloAposMinutos) || 0,
      precoCentavos: form.preco,
      ativo: form.ativo,
      profissionais: form.profissionais
    });
  }

  return (
    <Modal
      titulo={editando ? `Editar ${servico.nome}` : 'Novo serviço'}
      aberto
      largura={640}
      aoFechar={aoFechar}
      rodape={
        <>
          <Botao variante="secundario" onClick={aoFechar}>
            Cancelar
          </Botao>
          <Botao carregando={salvar.isPending} disabled={ativarSemVaga} onClick={enviar}>
            {editando ? 'Salvar alterações' : 'Cadastrar serviço'}
          </Botao>
        </>
      }
    >
      {salvar.isError && salvar.error.codigo !== 'VALIDACAO' && <Aviso tom="perigo">{salvar.error.message}</Aviso>}
      {semVaga && !editando && (
        <Aviso tom="alerta">
          O catálogo já tem {limite} serviços ativos. Este será cadastrado como <strong>inativo</strong> — ative depois de
          desativar outro.
        </Aviso>
      )}

      <div className="cat-form">
        <Campo rotulo="Nome" obrigatorio erro={erros.nome}>
          <Entrada value={form.nome} onChange={mudar('nome')} autoFocus={!editando} placeholder="Corte degradê" />
        </Campo>

        <Campo rotulo="Categoria" erro={erros.categoria}>
          <Selecao value={form.categoria} onChange={mudar('categoria')} aria-label="Categoria">
            {categorias.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value={NOVA_CATEGORIA}>+ Nova categoria…</option>
          </Selecao>
          {form.categoria === NOVA_CATEGORIA && (
            <Entrada
              className="cat-form__nova"
              value={form.categoriaNova}
              onChange={mudar('categoriaNova')}
              placeholder="Nome da nova categoria"
              maxLength={60}
              aria-label="Nome da nova categoria"
            />
          )}
        </Campo>

        <Campo rotulo="Preço" obrigatorio erro={erros.precoCentavos} dica="Pode digitar 45,90 ou R$ 45,90.">
          <Entrada value={form.preco} onChange={mudar('preco')} placeholder="45,00" inputMode="decimal" />
        </Campo>

        <Campo rotulo="Duração (minutos)" obrigatorio erro={erros.duracaoMinutos}>
          <Entrada type="number" min="5" max="600" value={form.duracaoMinutos} onChange={mudar('duracaoMinutos')} />
        </Campo>

        <Campo rotulo="Folga após (minutos)" dica="Limpeza ou preparo. Ocupa a agenda, não é cobrado." erro={erros.intervaloAposMinutos}>
          <Entrada type="number" min="0" max="120" value={form.intervaloAposMinutos} onChange={mudar('intervaloAposMinutos')} />
        </Campo>

        <Campo rotulo="Situação" dica={ativarSemVaga ? `Sem vaga: o limite é ${limite} ativos.` : 'Inativo some da agenda e da Sofia.'}>
          <label className="cat-interruptor">
            <input type="checkbox" checked={form.ativo} onChange={(e) => setForm({ ...form, ativo: e.target.checked })} />
            <span>{form.ativo ? 'Ativo' : 'Inativo'}</span>
          </label>
        </Campo>
      </div>

      <Campo rotulo="Descrição" dica="Opcional. Ajuda a Sofia a explicar o serviço para o cliente.">
        <AreaTexto rows={2} value={form.descricao} onChange={mudar('descricao')} maxLength={1000} />
      </Campo>

      <Campo rotulo="Quem executa" dica="Sem ninguém marcado, o serviço não aparece na tela de agendar. Preço próprio de cada um se ajusta na Equipe.">
        {equipe.isLoading ? (
          <Carregando />
        ) : pessoas.length === 0 ? (
          <p className="texto-fraco">Nenhum profissional cadastrado ainda — cadastre na Equipe.</p>
        ) : (
          <div className="eq-chips">
            {pessoas.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={marcados.has(p.id)}
                className={`eq-chip${marcados.has(p.id) ? ' eq-chip--ativo' : ''}`}
                onClick={() => alternarProfissional(p.id)}
              >
                <span className="cat-pessoa cat-pessoa--mini" style={{ '--cor': p.cor || 'var(--superficie-3)' }} aria-hidden="true" />
                {p.nome}
                {!p.ativo && <small>inativo</small>}
              </button>
            ))}
          </div>
        )}
      </Campo>
    </Modal>
  );
}

function ModalRenomearCategoria({ atual, categorias, aoFechar, aoSalvar }) {
  const [nome, setNome] = useState(atual);
  const renomear = useMutation({
    mutationFn: () => api.post('/api/servicos/categorias/renomear', { de: atual, para: nome.trim() }),
    onSuccess: () => aoSalvar(nome.trim())
  });
  const juntaCom = nome.trim() !== atual && categorias.find((c) => c === nome.trim());

  return (
    <Modal
      titulo={`Renomear "${atual}"`}
      aberto
      aoFechar={aoFechar}
      rodape={
        <>
          <Botao variante="secundario" onClick={aoFechar}>
            Cancelar
          </Botao>
          <Botao carregando={renomear.isPending} disabled={!nome.trim() || nome.trim() === atual} onClick={() => renomear.mutate()}>
            {juntaCom ? 'Juntar categorias' : 'Renomear'}
          </Botao>
        </>
      }
    >
      {renomear.isError && <Aviso tom="perigo">{renomear.error.message}</Aviso>}
      <Campo rotulo="Novo nome" dica="Todos os serviços desta categoria passam para o novo nome.">
        <Entrada value={nome} onChange={(e) => setNome(e.target.value)} maxLength={60} autoFocus />
      </Campo>
      {juntaCom && (
        <Aviso tom="alerta">
          Já existe a categoria "{juntaCom}". Os serviços de "{atual}" vão para ela e as duas viram uma só.
        </Aviso>
      )}
    </Modal>
  );
}
