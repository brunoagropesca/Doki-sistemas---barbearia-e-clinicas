import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/autenticacao.jsx';
import {
  AreaTexto,
  Aviso,
  Botao,
  Campo,
  Carregando,
  Cartao,
  Entrada,
  Etiqueta,
  FotoLead,
  Modal,
  Selecao,
  Tabela,
  Vazio
} from '../componentes/ui.jsx';
import { AssistenteAgendar } from './agenda/AssistenteAgendar.jsx';
import { guardarPublico } from '../lib/publicoDeCampanha.js';
import { useFuncoes } from '../lib/funcoes.jsx';
import './contatos/contatos.css';

/**
 * CRM de contatos.
 *
 * A lista responde perguntas de trabalho ("quem sumiu?", "quem nunca marcou
 * nada?") em vez de so mostrar nomes em ordem. Cada pergunta dessas e um
 * filtro pronto — e o que a pessoa marca ali vira, no clique seguinte, o
 * publico de uma campanha.
 */

/**
 * Os filtros inteligentes.
 *
 * Cada um e uma pergunta que alguem faz de verdade antes de uma campanha.
 * Ficam aqui, e nao na tela, porque o mesmo conjunto vai ser reaproveitado
 * pela pagina de campanhas para escolher o publico.
 */
export const FILTROS_CRM = [
  { chave: 'todos', rotulo: 'Todos', params: {} },
  { chave: 'novos', rotulo: 'Novos (7 dias)', params: { novosDias: 7 } },
  { chave: 'sem_agendamento', rotulo: 'Nunca agendaram', params: { semAgendamento: 'true' } },
  { chave: 'recorrentes', rotulo: 'Recorrentes', params: { minimoConcluidos: 2 } },
  { chave: 'sumidos', rotulo: 'Sem retorno (30 dias)', params: { diasInativo: 30 } },
  { chave: 'faltosos', rotulo: 'Já faltaram', params: { comFaltas: 'true' } },
  { chave: 'sem_campanha', rotulo: 'Não recebem campanha', params: { aceitaCampanha: 'false' } },
  { chave: 'sem_ia', rotulo: 'IA desligada', params: { iaAtiva: 'false' } }
];

export function Contatos() {
  const { podeAcessar } = useAuth();
  const { ligada } = useFuncoes();
  const navegar = useNavigate();
  const queryClient = useQueryClient();

  const [busca, setBusca] = useState('');
  const [filtroCrm, setFiltroCrm] = useState('todos');
  const [etiqueta, setEtiqueta] = useState('');
  const [marcados, setMarcados] = useState([]);
  const [modalAberto, setModalAberto] = useState(false);
  const [agendandoPara, setAgendandoPara] = useState(null);
  const [recado, setRecado] = useState(null);

  // As etiquetas nao sao uma lista fixa: quem usa cria as proprias, entao o
  // filtro pergunta ao servidor quais existem hoje.
  const etiquetas = useQuery({
    queryKey: ['leads', 'etiquetas'],
    queryFn: () => api.get('/api/leads/etiquetas')
  });

  const params = {
    busca,
    tag: etiqueta,
    limite: 100,
    ...(FILTROS_CRM.find((f) => f.chave === filtroCrm)?.params ?? {})
  };

  const lista = useQuery({
    queryKey: ['leads', params],
    queryFn: () => api.get('/api/leads', params)
  });

  const contatos = lista.data?.itens ?? [];
  const todosMarcados = contatos.length > 0 && marcados.length === contatos.length;

  function recarregar() {
    queryClient.invalidateQueries({ queryKey: ['leads'] });
  }

  const excluir = useMutation({
    mutationFn: (id) => api.delete(`/api/leads/${id}`),
    onSuccess: () => {
      setRecado({ tom: 'sucesso', texto: 'Contato movido para a lixeira.' });
      recarregar();
    },
    onError: (err) => setRecado({ tom: 'perigo', texto: err.message })
  });

  const abrirConversa = useMutation({
    mutationFn: (leadId) => api.post('/api/conversas/abrir', { leadId }),
    onSuccess: (r) => navegar(`/conversas/${r.conversa.id}`),
    onError: (err) => setRecado({ tom: 'perigo', texto: err.message })
  });

  const lote = useMutation({
    mutationFn: (acao) => api.post('/api/leads/lote', { ids: marcados, ...acao }),
    onSuccess: (r) => {
      setRecado({ tom: 'sucesso', texto: `${r.afetados} contato(s) atualizado(s).` });
      setMarcados([]);
      recarregar();
    },
    onError: (err) => setRecado({ tom: 'perigo', texto: err.message })
  });

  function marcar(id) {
    setMarcados((atuais) => (atuais.includes(id) ? atuais.filter((x) => x !== id) : [...atuais, id]));
  }

  /** Trocar de filtro limpa a selecao: marcar em uma lista e agir em outra seria uma surpresa ruim. */
  function trocarFiltro(mudar) {
    setMarcados([]);
    mudar();
  }

  return (
    <div className="coluna">
      <header className="linha linha--entre">
        <div>
          <h1>Contatos</h1>
          <p className="texto-suave">Seus clientes, o que cada um já fez e quem entra nas campanhas.</p>
        </div>
        <Botao onClick={() => setModalAberto(true)}>Novo contato</Botao>
      </header>

      {recado && (
        <Aviso tom={recado.tom} aoFechar={() => setRecado(null)}>
          {recado.texto}
        </Aviso>
      )}

      <div className="filtros-crm">
        {FILTROS_CRM.map((f) => (
          <button
            key={f.chave}
            type="button"
            className={`filtro-crm ${filtroCrm === f.chave ? 'filtro-crm--ativo' : ''}`}
            onClick={() => trocarFiltro(() => setFiltroCrm(f.chave))}
          >
            {f.rotulo}
          </button>
        ))}

        {(etiquetas.data?.etiquetas ?? []).length > 0 && (
          <Selecao
            value={etiqueta}
            aria-label="Filtrar por etiqueta"
            style={{ width: 'auto' }}
            onChange={(e) => trocarFiltro(() => setEtiqueta(e.target.value))}
          >
            <option value="">Todas as etiquetas</option>
            {etiquetas.data.etiquetas.map((et) => (
              <option key={et.nome} value={et.nome}>
                {et.nome} ({et.total})
              </option>
            ))}
          </Selecao>
        )}
      </div>

      {marcados.length > 0 && (
        <AcoesEmMassa
          quantidade={marcados.length}
          carregando={lote.isPending}
          aoAgir={(acao) => lote.mutate(acao)}
          aoLimpar={() => setMarcados([])}
          aoCriarCampanha={
            podeAcessar('admin') && ligada('campanhas')
              ? () => {
                  // A campanha nao e definida aqui: levamos o publico e a
                  // pessoa decide o resto na pagina de Campanhas.
                  guardarPublico(contatos.filter((c) => marcados.includes(c.id)));
                  navegar('/campanhas/nova');
                }
              : null
          }
        />
      )}

      <Cartao
        semPadding
        acao={
          <Entrada
            placeholder="Buscar por nome, telefone ou anotacao..."
            value={busca}
            onChange={(ev) => setBusca(ev.target.value)}
            style={{ maxWidth: 320 }}
          />
        }
        titulo={`${contatos.length} contato(s)`}
      >
        {lista.isLoading ? (
          <Carregando />
        ) : contatos.length === 0 ? (
          <Vazio
            titulo="Nenhum contato encontrado"
            descricao={
              busca || etiqueta || filtroCrm !== 'todos'
                ? 'Tente outro termo ou limpe os filtros.'
                : 'Clientes que mandarem mensagem no WhatsApp entram aqui automaticamente.'
            }
          />
        ) : (
          <Tabela
            cabecalho={[
              <input
                key="marcar-todos"
                type="checkbox"
                checked={todosMarcados}
                aria-label="Marcar todos os contatos da lista"
                onChange={() => setMarcados(todosMarcados ? [] : contatos.map((c) => c.id))}
              />,
              'Cliente',
              'Visitas',
              'Ja gastou',
              'Etiquetas',
              ''
            ]}
          >
            {contatos.map((c) => (
              <tr key={c.id}>
                <td className="contato__marca">
                  <input
                    type="checkbox"
                    checked={marcados.includes(c.id)}
                    aria-label={`Marcar ${c.nome}`}
                    onChange={() => marcar(c.id)}
                  />
                </td>
                <td>
                  <div className="contato__quem">
                    <FotoLead nome={c.nome} url={c.fotoUrl} tamanho={34} />
                    <div>
                      <strong>{c.nome}</strong>
                      <div className="texto-fraco">{c.telefoneFormatado}</div>
                    </div>
                  </div>
                </td>
                <td>
                  {c.concluidos ?? 0}
                  {c.faltas > 0 && <span className="texto-fraco"> · {c.faltas} falta(s)</span>}
                </td>
                <td className="mono">{c.gastoTotalFormatado}</td>
                <td>
                  <div className="linha" style={{ gap: 4 }}>
                    {(c.tags ?? []).slice(0, 3).map((t) => (
                      <Etiqueta key={t} tom="info">
                        {t}
                      </Etiqueta>
                    ))}
                    {!c.aceitaCampanha && <Etiqueta tom="perigo">nao receber</Etiqueta>}
                    {!c.iaAtiva && <Etiqueta tom="alerta">sem IA</Etiqueta>}
                  </div>
                </td>
                <td>
                  <div className="contato__acoes">
                    <Botao variante="fantasma" tamanho="sm" onClick={() => navegar(`/contatos/${c.id}`)}>
                      Ver cadastro
                    </Botao>
                    <Botao variante="fantasma" tamanho="sm" onClick={() => setAgendandoPara(c)}>
                      Agendar
                    </Botao>
                    <Botao
                      variante="fantasma"
                      tamanho="sm"
                      carregando={abrirConversa.isPending && abrirConversa.variables === c.id}
                      onClick={() => abrirConversa.mutate(c.id)}
                    >
                      Enviar mensagem
                    </Botao>
                    {podeAcessar('admin') && (
                      <Botao
                        variante="fantasma"
                        tamanho="sm"
                        onClick={() => {
                          if (confirm(`Mover ${c.nome} para a lixeira? O historico dele e preservado.`)) {
                            excluir.mutate(c.id);
                          }
                        }}
                      >
                        Apagar
                      </Botao>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Tabela>
        )}
      </Cartao>

      <ModalNovoContato
        aberto={modalAberto}
        aoFechar={() => setModalAberto(false)}
        aoSalvar={() => {
          setModalAberto(false);
          recarregar();
        }}
      />

      {agendandoPara && (
        <AssistenteAgendar
          dataInicial={new Date().toLocaleDateString('sv-SE')}
          clienteInicial={agendandoPara}
          aoFechar={() => setAgendandoPara(null)}
          aoSalvar={() => {
            setAgendandoPara(null);
            setRecado({ tom: 'sucesso', texto: 'Horario marcado.' });
            queryClient.invalidateQueries({ queryKey: ['agenda'] });
            recarregar();
          }}
        />
      )}
    </div>
  );
}

/**
 * Barra de acoes em massa.
 *
 * Só aparece quando há contatos marcados, e sempre diz quantos são: uma ação
 * que atinge 80 pessoas de uma vez não pode ser disparada sem a pessoa ver o
 * número antes.
 */
function AcoesEmMassa({ quantidade, carregando, aoAgir, aoLimpar, aoCriarCampanha }) {
  return (
    <div className="massa">
      <span className="massa__contagem">{quantidade} marcado(s)</span>

      {aoCriarCampanha && (
        <Botao tamanho="sm" onClick={aoCriarCampanha}>
          Criar campanha ({quantidade})
        </Botao>
      )}

      <Botao
        variante="secundario"
        tamanho="sm"
        disabled={carregando}
        onClick={() => {
          const tag = prompt('Qual etiqueta aplicar aos contatos marcados?');
          if (tag?.trim()) aoAgir({ adicionarTag: tag.trim() });
        }}
      >
        Etiquetar
      </Botao>

      <Botao variante="secundario" tamanho="sm" disabled={carregando} onClick={() => aoAgir({ aceitaCampanha: false })}>
        Não enviar campanhas
      </Botao>
      <Botao variante="secundario" tamanho="sm" disabled={carregando} onClick={() => aoAgir({ aceitaCampanha: true })}>
        Voltar a aceitar
      </Botao>
      <Botao variante="secundario" tamanho="sm" disabled={carregando} onClick={() => aoAgir({ iaAtiva: false })}>
        Desligar IA
      </Botao>
      <Botao variante="secundario" tamanho="sm" disabled={carregando} onClick={() => aoAgir({ iaAtiva: true })}>
        Ligar IA
      </Botao>

      <Botao variante="fantasma" tamanho="sm" onClick={aoLimpar}>
        Limpar seleção
      </Botao>
    </div>
  );
}

function ModalNovoContato({ aberto, aoFechar, aoSalvar }) {
  const vazio = { nome: '', telefone: '', email: '', endereco: '', observacoes: '' };
  const [form, setForm] = useState(vazio);

  const criar = useMutation({
    mutationFn: (dados) => api.post('/api/leads', dados),
    onSuccess: () => {
      setForm(vazio);
      aoSalvar();
    }
  });

  const erros = criar.error?.camposComErro ?? {};

  return (
    <Modal
      titulo="Novo contato"
      aberto={aberto}
      aoFechar={aoFechar}
      rodape={
        <>
          <Botao variante="secundario" onClick={aoFechar}>
            Cancelar
          </Botao>
          <Botao
            carregando={criar.isPending}
            onClick={() =>
              criar.mutate({ ...form, email: form.email || undefined })
            }
          >
            Salvar
          </Botao>
        </>
      }
    >
      {/* Conflito (telefone ja cadastrado) merece destaque: e o erro mais
          comum aqui, e a mensagem do servidor ja diz de quem e o numero. */}
      {criar.isError && criar.error.codigo !== 'VALIDACAO' && <Aviso tom="perigo">{criar.error.message}</Aviso>}

      <Campo rotulo="Nome" obrigatorio erro={erros.nome}>
        <Entrada value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} autoFocus />
      </Campo>

      <Campo
        rotulo="Telefone"
        obrigatorio
        erro={erros.telefone}
        dica="Pode digitar com ou sem DDD, com parenteses ou hifen — o sistema padroniza."
      >
        <Entrada
          value={form.telefone}
          onChange={(e) => setForm({ ...form, telefone: e.target.value })}
          placeholder="(11) 98888-7777"
        />
      </Campo>

      <Campo rotulo="E-mail" erro={erros.email}>
        <Entrada type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </Campo>

      <Campo rotulo="Endereco" erro={erros.endereco}>
        <Entrada
          value={form.endereco}
          placeholder="Rua, numero, bairro"
          onChange={(e) => setForm({ ...form, endereco: e.target.value })}
        />
      </Campo>

      <Campo rotulo="Anotacoes" dica="Preferencias, alergias, o que for util lembrar.">
        <AreaTexto value={form.observacoes} onChange={(e) => setForm({ ...form, observacoes: e.target.value })} />
      </Campo>
    </Modal>
  );
}
