import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/autenticacao.jsx';
import { EscolherFoto } from './equipe/EscolherFoto.jsx';
import { Servicos } from './catalogo/Servicos.jsx';
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
  const podeEditar = podeAcessar('admin');
  const [aba, setAba] = useState('servicos');
  // "Novo servico" fica no cabecalho, como na Equipe; cada clique e um numero novo.
  const [pedidoNovo, setPedidoNovo] = useState(0);

  const metricas = useQuery({ queryKey: ['catalogo', 'metricas'], queryFn: () => api.get('/api/catalogo/metricas') });
  const m = metricas.data;
  const limite = m?.servicos?.limiteAtivos ?? 25;

  return (
    <div className="coluna">
      <header className="linha linha--entre">
        <div>
          <h1>Catálogo</h1>
          <p className="texto-suave">Serviços oferecidos e produtos vendidos no balcão.</p>
        </div>
        {podeEditar && aba === 'servicos' && (
          <Botao className="eq-novo" onClick={() => setPedidoNovo((n) => n + 1)}>
            + Novo serviço
          </Botao>
        )}
      </header>

      <div className="grade">
        <Metrica
          rotulo="Serviços ativos"
          valor={m ? `${m.servicos.ativos} / ${limite}` : '—'}
          tom={m && m.servicos.ativos >= limite ? 'alerta' : undefined}
          detalhe={m ? `${m.servicos.total - m.servicos.ativos} inativo(s)` : undefined}
        />
        <Metrica rotulo="Preço médio" valor={m?.servicos?.precoMedioFormatado ?? '—'} />
        <Metrica rotulo="Produtos ativos" valor={m?.produtos?.ativos ?? '—'} />
        <Metrica
          rotulo="Estoque baixo"
          valor={m?.produtos?.estoqueBaixo ?? '—'}
          tom={m?.produtos?.estoqueBaixo > 0 ? 'alerta' : undefined}
          detalhe={m?.produtos?.estoqueBaixo > 0 ? 'Precisa repor' : 'Tudo em dia'}
        />
        <Metrica rotulo="Valor em estoque" valor={m?.produtos?.valorEstoqueFormatado ?? '—'} />
      </div>

      <div className="eq-navegacao">
        <div className="eq-abas" role="tablist" aria-label="Parte do catálogo">
          {[
            { id: 'servicos', titulo: 'Serviços', total: m?.servicos?.total },
            { id: 'produtos', titulo: 'Produtos', total: m?.produtos?.total }
          ].map((a) => (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={aba === a.id}
              className={`eq-aba${aba === a.id ? ' eq-aba--ativa' : ''}`}
              onClick={() => setAba(a.id)}
            >
              {a.titulo}
              {a.total != null && <small>{a.total}</small>}
            </button>
          ))}
        </div>
      </div>

      {aba === 'servicos' ? (
        <Servicos podeEditar={podeEditar} limite={limite} pedidoNovo={pedidoNovo} />
      ) : (
        <Produtos podeEditar={podeEditar} />
      )}
    </div>
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
