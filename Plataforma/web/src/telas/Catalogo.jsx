import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/autenticacao.jsx';
import { EscolherFoto } from './equipe/EscolherFoto.jsx';
import {
  AreaTexto,
  Aviso,
  Botao,
  Campo,
  Carregando,
  Cartao,
  Entrada,
  Etiqueta,
  Metrica,
  Modal,
  Tabela,
  Vazio
} from '../componentes/ui.jsx';

/** Centavos -> "45,00" para os campos de dinheiro. */
function emReais(centavos) {
  return ((Number(centavos) || 0) / 100).toFixed(2).replace('.', ',');
}

/** "45,00" -> 4500. Aceita ponto de milhar. */
function emCentavos(texto) {
  const limpo = String(texto ?? '').replace(/\./g, '').replace(',', '.').trim();
  return Math.round((Number(limpo) || 0) * 100);
}

export function Catalogo() {
  const { podeAcessar } = useAuth();
  const [aba, setAba] = useState('servicos');

  const metricas = useQuery({ queryKey: ['catalogo', 'metricas'], queryFn: () => api.get('/api/catalogo/metricas') });
  const m = metricas.data;

  return (
    <div className="coluna">
      <header>
        <h1>Catalogo</h1>
        <p className="texto-suave">Servicos oferecidos e produtos vendidos no balcao.</p>
      </header>

      <div className="grade">
        <Metrica rotulo="Servicos ativos" valor={m?.servicos?.ativos ?? '—'} />
        <Metrica rotulo="Preco medio" valor={m?.servicos?.precoMedioFormatado ?? '—'} />
        <Metrica rotulo="Produtos ativos" valor={m?.produtos?.ativos ?? '—'} />
        <Metrica
          rotulo="Estoque baixo"
          valor={m?.produtos?.estoqueBaixo ?? '—'}
          tom={m?.produtos?.estoqueBaixo > 0 ? 'alerta' : undefined}
          detalhe={m?.produtos?.estoqueBaixo > 0 ? 'Precisa repor' : 'Tudo em dia'}
        />
        <Metrica rotulo="Valor em estoque" valor={m?.produtos?.valorEstoqueFormatado ?? '—'} />
      </div>

      <div className="linha">
        <Botao variante={aba === 'servicos' ? 'primario' : 'fantasma'} onClick={() => setAba('servicos')}>
          Servicos
        </Botao>
        <Botao variante={aba === 'produtos' ? 'primario' : 'fantasma'} onClick={() => setAba('produtos')}>
          Produtos
        </Botao>
      </div>

      {aba === 'servicos' ? <Servicos podeEditar={podeAcessar('admin')} /> : <Produtos podeEditar={podeAcessar('admin')} />}
    </div>
  );
}

function Servicos({ podeEditar }) {
  const queryClient = useQueryClient();
  const [modal, setModal] = useState(false);

  const lista = useQuery({ queryKey: ['servicos'], queryFn: () => api.get('/api/servicos', { incluirInativos: 'true' }) });
  const servicos = lista.data?.servicos ?? [];

  return (
    <>
      <Cartao
        semPadding
        titulo={`${servicos.length} servico(s)`}
        acao={podeEditar && <Botao onClick={() => setModal(true)}>Novo servico</Botao>}
      >
        {lista.isLoading ? (
          <Carregando />
        ) : servicos.length === 0 ? (
          <Vazio titulo="Nenhum servico cadastrado" descricao="Cadastre os servicos para poder agendar e para a IA saber o que oferecer." />
        ) : (
          <Tabela cabecalho={['Servico', 'Duracao', 'Preco', 'Quem faz', '']}>
            {servicos.map((s) => (
              <tr key={s.id} style={{ opacity: s.ativo ? 1 : 0.55 }}>
                <td>
                  <strong>{s.nome}</strong>
                  <div className="texto-fraco">{s.categoria}</div>
                </td>
                <td>
                  {s.duracaoMinutos} min
                  {s.intervaloAposMinutos > 0 && (
                    <div className="texto-fraco" title="Folga apos o atendimento">
                      +{s.intervaloAposMinutos} de folga
                    </div>
                  )}
                </td>
                <td className="mono">{s.precoFormatado}</td>
                <td>
                  <div className="linha" style={{ gap: 4 }}>
                    {s.profissionais.length === 0 ? (
                      // Servico sem profissional nao aparece pra agendar: a
                      // pessoa precisa ver isso, nao descobrir no uso.
                      <Etiqueta tom="perigo">ninguem</Etiqueta>
                    ) : (
                      s.profissionais.map((p) => (
                        <Etiqueta key={p.id} tom="neutro">
                          {p.nome.split(' ')[0]}
                          {p.precoProprio && ` (${p.precoFormatado})`}
                        </Etiqueta>
                      ))
                    )}
                  </div>
                </td>
                <td>{!s.ativo && <Etiqueta tom="neutro">inativo</Etiqueta>}</td>
              </tr>
            ))}
          </Tabela>
        )}
      </Cartao>

      {modal && (
        <ModalServico
          aoFechar={() => setModal(false)}
          aoSalvar={() => {
            setModal(false);
            queryClient.invalidateQueries({ queryKey: ['servicos'] });
          }}
        />
      )}
    </>
  );
}

function ModalServico({ aoFechar, aoSalvar }) {
  const [form, setForm] = useState({
    nome: '',
    categoria: 'Geral',
    duracaoMinutos: 30,
    intervaloAposMinutos: 0,
    precoCentavos: '',
    profissionais: []
  });

  // Reaproveita a lista de servicos para descobrir quem sao os profissionais.
  const servicos = useQuery({ queryKey: ['servicos'], queryFn: () => api.get('/api/servicos') });
  const todosProfissionais = [
    ...new Map(
      (servicos.data?.servicos ?? []).flatMap((s) => s.profissionais).map((p) => [p.id, p])
    ).values()
  ];

  const criar = useMutation({
    mutationFn: (dados) => api.post('/api/servicos', dados),
    onSuccess: aoSalvar
  });

  const erros = criar.error?.camposComErro ?? {};

  function alternarProfissional(id) {
    const ja = form.profissionais.some((p) => p.professionalId === id);
    setForm({
      ...form,
      profissionais: ja
        ? form.profissionais.filter((p) => p.professionalId !== id)
        : [...form.profissionais, { professionalId: id }]
    });
  }

  return (
    <Modal
      titulo="Novo servico"
      aberto
      aoFechar={aoFechar}
      rodape={
        <>
          <Botao variante="secundario" onClick={aoFechar}>
            Cancelar
          </Botao>
          <Botao
            carregando={criar.isPending}
            onClick={() =>
              criar.mutate({
                ...form,
                duracaoMinutos: Number(form.duracaoMinutos),
                intervaloAposMinutos: Number(form.intervaloAposMinutos)
              })
            }
          >
            Salvar
          </Botao>
        </>
      }
    >
      {criar.isError && criar.error.codigo !== 'VALIDACAO' && <Aviso tom="perigo">{criar.error.message}</Aviso>}

      <Campo rotulo="Nome" obrigatorio erro={erros.nome}>
        <Entrada value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} autoFocus />
      </Campo>

      <Campo rotulo="Categoria">
        <Entrada value={form.categoria} onChange={(e) => setForm({ ...form, categoria: e.target.value })} />
      </Campo>

      <Campo rotulo="Duracao (minutos)" obrigatorio erro={erros.duracaoMinutos}>
        <Entrada
          type="number"
          min="5"
          value={form.duracaoMinutos}
          onChange={(e) => setForm({ ...form, duracaoMinutos: e.target.value })}
        />
      </Campo>

      <Campo
        rotulo="Folga apos o atendimento (minutos)"
        dica="Tempo de limpeza ou preparo. Ocupa a agenda mas nao e cobrado."
      >
        <Entrada
          type="number"
          min="0"
          value={form.intervaloAposMinutos}
          onChange={(e) => setForm({ ...form, intervaloAposMinutos: e.target.value })}
        />
      </Campo>

      <Campo rotulo="Preco" obrigatorio erro={erros.precoCentavos} dica="Pode digitar 45,90 ou R$ 45,90.">
        <Entrada
          value={form.precoCentavos}
          onChange={(e) => setForm({ ...form, precoCentavos: e.target.value })}
          placeholder="45,00"
        />
      </Campo>

      <Campo rotulo="Quem executa" dica="Sem ninguem marcado, o servico nao aparece na tela de agendar.">
        <div className="linha" style={{ gap: 6 }}>
          {todosProfissionais.map((p) => (
            <Botao
              key={p.id}
              type="button"
              tamanho="sm"
              variante={form.profissionais.some((x) => x.professionalId === p.id) ? 'primario' : 'secundario'}
              onClick={() => alternarProfissional(p.id)}
            >
              {p.nome}
            </Botao>
          ))}
        </div>
      </Campo>
    </Modal>
  );
}

function Produtos({ podeEditar }) {
  const queryClient = useQueryClient();
  const [ajuste, setAjuste] = useState(null);
  const [editando, setEditando] = useState(null); // produto, ou 'novo'

  const lista = useQuery({ queryKey: ['produtos'], queryFn: () => api.get('/api/produtos', { incluirInativos: 'true' }) });
  const produtos = lista.data?.produtos ?? [];

  const vender = useMutation({
    mutationFn: (productId) => api.post('/api/vendas', { productId, quantidade: 1 }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['produtos'] })
  });

  return (
    <>
      {vender.isError && <Aviso tom="perigo">{vender.error.message}</Aviso>}

      {podeEditar && (
        <div className="linha linha--fim">
          <Botao onClick={() => setEditando('novo')}>Cadastrar produto</Botao>
        </div>
      )}

      <Cartao semPadding titulo={`${produtos.length} produto(s)`}>
        {lista.isLoading ? (
          <Carregando />
        ) : produtos.length === 0 ? (
          <Vazio titulo="Nenhum produto cadastrado" />
        ) : (
          <Tabela cabecalho={['', 'Produto', 'Preco', 'Margem', 'Estoque', 'Acoes']}>
            {produtos.map((p) => (
              <tr key={p.id}>
                <td>
                  <span className="produto-foto">
                    {p.fotoUrl ? <img src={p.fotoUrl} alt="" /> : <span aria-hidden="true">—</span>}
                  </span>
                </td>
                <td>
                  <strong>{p.nome}</strong>
                  <div className="texto-fraco">{p.categoria}</div>
                </td>
                <td className="mono">{p.precoFormatado}</td>
                <td className="mono">
                  {p.margemFormatada}
                  <div className="texto-fraco">{p.margemPercentual}%</div>
                </td>
                <td>
                  <strong>{p.estoque}</strong>
                  {p.estoqueBaixo && (
                    <div>
                      <Etiqueta tom="alerta">repor</Etiqueta>
                    </div>
                  )}
                </td>
                <td>
                  <div className="linha" style={{ gap: 4 }}>
                    <Botao
                      tamanho="sm"
                      variante="secundario"
                      disabled={p.estoque < 1}
                      onClick={() => vender.mutate(p.id)}
                    >
                      Vender 1
                    </Botao>
                    {podeEditar && (
                      <>
                        <Botao tamanho="sm" variante="secundario" onClick={() => setEditando(p)}>
                          Editar
                        </Botao>
                        <Botao tamanho="sm" variante="fantasma" onClick={() => setAjuste(p)}>
                          Estoque
                        </Botao>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Tabela>
        )}
      </Cartao>

      {editando && (
        <ModalProduto
          produto={editando === 'novo' ? null : editando}
          aoFechar={() => setEditando(null)}
          aoSalvar={() => {
            setEditando(null);
            queryClient.invalidateQueries({ queryKey: ['produtos'] });
          }}
        />
      )}

      {ajuste && (
        <ModalEstoque
          produto={ajuste}
          aoFechar={() => setAjuste(null)}
          aoSalvar={() => {
            setAjuste(null);
            queryClient.invalidateQueries({ queryKey: ['produtos'] });
          }}
        />
      )}
    </>
  );
}

/**
 * Cadastro e edicao de produto, com foto.
 *
 * O estoque so aparece no cadastro NOVO: depois disso, saldo muda por
 * movimento (com motivo), nunca por edicao de campo — e o que mantem o
 * historico do produto fechando.
 */
function ModalProduto({ produto, aoFechar, aoSalvar }) {
  const novo = !produto;
  const [foto, setFoto] = useState(undefined);
  const [form, setForm] = useState({
    nome: produto?.nome ?? '',
    categoria: produto?.categoria ?? 'Geral',
    descricao: produto?.descricao ?? '',
    sku: produto?.sku ?? '',
    preco: emReais(produto?.precoCentavos),
    custo: emReais(produto?.custoCentavos),
    estoque: '0',
    estoqueMinimo: String(produto?.estoqueMinimo ?? 0),
    ativo: produto?.ativo ?? true
  });

  const salvar = useMutation({
    mutationFn: () => {
      const corpo = {
        nome: form.nome,
        categoria: form.categoria || 'Geral',
        descricao: form.descricao || undefined,
        sku: form.sku || undefined,
        precoCentavos: emCentavos(form.preco),
        custoCentavos: emCentavos(form.custo),
        estoqueMinimo: Number(form.estoqueMinimo) || 0,
        ativo: form.ativo,
        ...(foto ? { foto } : {}),
        ...(foto === null ? { removerFoto: true } : {})
      };
      return novo
        ? api.post('/api/produtos', { ...corpo, estoque: Number(form.estoque) || 0 })
        : api.patch(`/api/produtos/${produto.id}`, corpo);
    },
    onSuccess: aoSalvar
  });

  const erros = salvar.error?.camposComErro ?? {};

  return (
    <Modal
      titulo={novo ? 'Cadastrar produto' : `Editar ${produto.nome}`}
      aberto
      aoFechar={aoFechar}
      largura={620}
      rodape={
        <>
          <Botao variante="secundario" onClick={aoFechar}>
            Cancelar
          </Botao>
          <Botao carregando={salvar.isPending} disabled={!form.nome.trim()} onClick={() => salvar.mutate()}>
            Salvar
          </Botao>
        </>
      }
    >
      {salvar.isError && salvar.error.codigo !== 'VALIDACAO' && <Aviso tom="perigo">{salvar.error.message}</Aviso>}

      <div className="coluna">
        <EscolherFoto
          valorAtual={produto?.fotoUrl}
          rotulo="Foto do produto"
          aoEscolher={setFoto}
          aoRemover={() => setFoto(null)}
        />

        <Campo rotulo="Nome" obrigatorio erro={erros.nome}>
          <Entrada value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
        </Campo>

        <div className="grade">
          <Campo rotulo="Categoria">
            <Entrada value={form.categoria} onChange={(e) => setForm({ ...form, categoria: e.target.value })} />
          </Campo>
          <Campo rotulo="Codigo (SKU)">
            <Entrada value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
          </Campo>
          <Campo rotulo="Preco de venda (R$)" obrigatorio erro={erros.precoCentavos}>
            <Entrada value={form.preco} onChange={(e) => setForm({ ...form, preco: e.target.value })} />
          </Campo>
          <Campo rotulo="Custo (R$)" dica="Para calcular a margem.">
            <Entrada value={form.custo} onChange={(e) => setForm({ ...form, custo: e.target.value })} />
          </Campo>
          {novo && (
            <Campo rotulo="Estoque inicial">
              <Entrada
                type="number"
                value={form.estoque}
                onChange={(e) => setForm({ ...form, estoque: e.target.value })}
              />
            </Campo>
          )}
          <Campo rotulo="Avisar abaixo de" dica="Estoque minimo.">
            <Entrada
              type="number"
              value={form.estoqueMinimo}
              onChange={(e) => setForm({ ...form, estoqueMinimo: e.target.value })}
            />
          </Campo>
        </div>

        <Campo rotulo="Descricao">
          <AreaTexto
            value={form.descricao}
            rows={3}
            onChange={(e) => setForm({ ...form, descricao: e.target.value })}
          />
        </Campo>

        {!novo && (
          <label className="linha" style={{ gap: 8 }}>
            <input type="checkbox" checked={form.ativo} onChange={(e) => setForm({ ...form, ativo: e.target.checked })} />
            <span>Ativo (aparece para venda)</span>
          </label>
        )}
      </div>
    </Modal>
  );
}

function ModalEstoque({ produto, aoFechar, aoSalvar }) {
  const [form, setForm] = useState({ tipo: 'entrada', quantidade: 1, motivo: '' });

  const ajustar = useMutation({
    mutationFn: (dados) => api.post(`/api/produtos/${produto.id}/estoque`, dados),
    onSuccess: aoSalvar
  });

  const erros = ajustar.error?.camposComErro ?? {};

  return (
    <Modal
      titulo={`Estoque — ${produto.nome}`}
      aberto
      aoFechar={aoFechar}
      rodape={
        <>
          <Botao variante="secundario" onClick={aoFechar}>
            Cancelar
          </Botao>
          <Botao
            carregando={ajustar.isPending}
            onClick={() => ajustar.mutate({ ...form, quantidade: Number(form.quantidade) })}
          >
            Registrar
          </Botao>
        </>
      }
    >
      {ajustar.isError && ajustar.error.codigo !== 'VALIDACAO' && <Aviso tom="perigo">{ajustar.error.message}</Aviso>}

      <p className="texto-suave" style={{ marginBottom: 'var(--e4)' }}>
        Estoque atual: <strong>{produto.estoque}</strong>
      </p>

      <Campo rotulo="Tipo de movimento">
        <div className="linha" style={{ gap: 6 }}>
          {[
            ['entrada', 'Entrada'],
            ['saida', 'Saida'],
            ['perda', 'Perda'],
            ['ajuste', 'Ajuste']
          ].map(([valor, rotulo]) => (
            <Botao
              key={valor}
              type="button"
              tamanho="sm"
              variante={form.tipo === valor ? 'primario' : 'secundario'}
              onClick={() => setForm({ ...form, tipo: valor })}
            >
              {rotulo}
            </Botao>
          ))}
        </div>
      </Campo>

      <Campo rotulo="Quantidade" obrigatorio erro={erros.quantidade}>
        <Entrada
          type="number"
          value={form.quantidade}
          onChange={(e) => setForm({ ...form, quantidade: e.target.value })}
        />
      </Campo>

      <Campo
        rotulo="Motivo"
        obrigatorio
        erro={erros.motivo}
        dica="Ajuste sem motivo e caixa sem comprovante: quando o numero nao bater, ninguem vai saber explicar."
      >
        <Entrada
          value={form.motivo}
          onChange={(e) => setForm({ ...form, motivo: e.target.value })}
          placeholder="Recebimento nota 123"
        />
      </Campo>
    </Modal>
  );
}
