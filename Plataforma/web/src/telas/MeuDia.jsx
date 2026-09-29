import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/autenticacao.jsx';
import { Aviso, Botao, Carregando, Vazio } from '../componentes/ui.jsx';
import { Cabecalho, DetalheOS, Etapas, PROXIMOS } from './agenda/DetalheOS.jsx';
import './MeuDia.css';

/**
 * A unica tela do login de PROFISSIONAL: os atendimentos dele no dia.
 *
 * Cada cartao e o topo da ordem de servico (servico, horario, cliente, etapas
 * e os botoes de status); clicar no cartao abre o painel completo da OS. Nao
 * ha menu nem outras telas — a API tambem recusa qualquer outra rota para
 * este cargo, entao esconder aqui e so conveniencia.
 *
 * Sem canal de tempo real (ele abre a presenca de atendente): a lista se
 * atualiza sozinha a cada 30 s e ao voltar para a aba.
 */

/** 'AAAA-MM-DD' no horario local do aparelho. */
const isoDe = (d) => d.toLocaleDateString('sv-SE');
const somarDias = (iso, n) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return isoDe(d);
};

const ENCERRADOS = ['concluido', 'cancelado', 'faltou'];
/** Acoes que tiram o cliente da cadeira: no celular, um toque errado custa caro. */
const CONFIRMAR = {
  cancelado: 'Cancelar este atendimento?',
  faltou: 'Marcar que o cliente faltou?'
};

export function MeuDia() {
  const { usuario, sair } = useAuth();
  const hoje = isoDe(new Date());
  const [data, setData] = useState(hoje);
  const [aberto, setAberto] = useState(null);

  const dia = useQuery({
    queryKey: ['agenda', 'meu-dia', 'lista', data],
    queryFn: () => api.get('/api/meu-dia', { data }),
    refetchInterval: 30_000
  });

  const profissional = dia.data?.profissional;
  const lista = dia.data?.agendamentos ?? [];
  const ativos = lista.filter((a) => !['cancelado', 'faltou'].includes(a.status));
  const concluidos = lista.filter((a) => a.status === 'concluido').length;
  const proximo = data === hoje ? lista.find((a) => !ENCERRADOS.includes(a.status) && a.fimEm > Date.now()) : null;

  const tituloDia = new Date(`${data}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  const nome = profissional?.nome ?? usuario?.nome ?? '';

  return (
    <div className="md">
      <header className="md-topo">
        <span className="md-topo__foto" style={{ background: profissional?.cor }} aria-hidden="true">
          {profissional?.fotoUrl ? <img src={profissional.fotoUrl} alt="" /> : nome.trim().charAt(0).toUpperCase()}
        </span>
        <div className="md-topo__nome">
          <strong>{nome}</strong>
          {profissional?.funcao && <small className="texto-fraco">{profissional.funcao}</small>}
        </div>
        <Botao variante="fantasma" tamanho="sm" onClick={sair}>
          Sair
        </Botao>
      </header>

      <nav className="md-dia" aria-label="Escolher o dia">
        <button type="button" className="md-dia__seta" onClick={() => setData(somarDias(data, -1))} aria-label="Dia anterior">
          ‹
        </button>
        <div className="md-dia__centro">
          <span className="md-dia__rotulo">
            {data === hoje ? 'Hoje' : data === somarDias(hoje, 1) ? 'Amanhã' : data === somarDias(hoje, -1) ? 'Ontem' : ''}
          </span>
          <strong className="md-dia__titulo">{tituloDia.charAt(0).toUpperCase() + tituloDia.slice(1)}</strong>
        </div>
        <button type="button" className="md-dia__seta" onClick={() => setData(somarDias(data, 1))} aria-label="Próximo dia">
          ›
        </button>
      </nav>
      {data !== hoje && (
        <button type="button" className="md-voltar link" onClick={() => setData(hoje)}>
          Voltar para hoje
        </button>
      )}

      {dia.isLoading ? (
        <Carregando texto="Buscando seus atendimentos..." />
      ) : dia.isError ? (
        <Aviso tom="perigo">{dia.error.message}</Aviso>
      ) : lista.length === 0 ? (
        <Vazio titulo="Nenhum atendimento neste dia" descricao="Quando a recepção ou a Sofia marcarem um horário com você, ele aparece aqui." />
      ) : (
        <>
          <p className="md-resumo texto-suave">
            {ativos.length} atendimento{ativos.length === 1 ? '' : 's'}
            {concluidos > 0 && ` · ${concluidos} concluído${concluidos === 1 ? '' : 's'}`}
            {proximo && (
              <>
                {' · '}
                próximo às <strong>{proximo.horaInicio}</strong>
              </>
            )}
          </p>
          <ul className="md-lista">
            {lista.map((a) => (
              <li key={a.id}>
                <CartaoAtendimento a={a} aoAbrir={() => setAberto(a.id)} />
              </li>
            ))}
          </ul>
        </>
      )}

      {aberto && <DetalheOS id={aberto} modoProfissional aoFechar={() => setAberto(null)} />}
    </div>
  );
}

/** O topo da OS (como no painel) + os botoes de status, direto no cartao. */
function CartaoAtendimento({ a, aoAbrir }) {
  const queryClient = useQueryClient();
  const mudar = useMutation({
    mutationFn: (status) => api.patch(`/api/meu-dia/${a.id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agenda'] })
  });

  const acoes = PROXIMOS[a.status] ?? [];
  const fora = a.status === 'cancelado' || a.status === 'faltou';

  return (
    <article
      className={`md-cartao${fora ? ' md-cartao--fora' : ''}${a.status === 'em_andamento' ? ' md-cartao--agora' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Abrir o atendimento de ${a.leadNome}, ${a.horaInicio}`}
      onClick={aoAbrir}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          aoAbrir();
        }
      }}
    >
      <Cabecalho a={a} mostrarCliente />
      <Etapas status={a.status} />

      {mudar.isError && <Aviso tom="perigo">{mudar.error.message}</Aviso>}
      {acoes.length > 0 && (
        // Os botoes agem sem abrir o painel.
        <div className="os__acoes" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {acoes.map(([status, rotulo]) => (
            <Botao
              key={status}
              variante={status === 'cancelado' || status === 'faltou' ? 'secundario' : 'primario'}
              tamanho="sm"
              disabled={mudar.isPending}
              carregando={mudar.isPending && mudar.variables === status}
              onClick={() => {
                if (CONFIRMAR[status] && !confirm(CONFIRMAR[status])) return;
                mudar.mutate(status);
              }}
            >
              {rotulo}
            </Botao>
          ))}
        </div>
      )}
    </article>
  );
}
