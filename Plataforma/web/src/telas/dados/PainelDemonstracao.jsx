import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Aviso, Botao, Entrada } from '../../componentes/ui.jsx';

/**
 * Banco de DEMONSTRACAO — para mostrar o sistema a um cliente.
 *
 * Gera uma empresa ficticia com 3 meses de movimento (20 profissionais, 5
 * atendentes, 40 servicos, 110 produtos, conversas em todos os estados...).
 * "Entrar" liga a demonstracao SO neste navegador: donos e atendentes seguem
 * no banco de verdade, e nada da demonstracao sai pelo WhatsApp real.
 *
 * "Exportar" e o contrario: traz o movimento ficticio PARA a empresa real,
 * misturado com o dela (ver api/.../demonstracao/exportar.js). Pede para
 * digitar EXPORTAR e faz um backup antes.
 */

const tamanho = (bytes) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
const numero = (n) => (n ?? 0).toLocaleString('pt-BR');

export function PainelDemonstracao() {
  const [aviso, setAviso] = useState(null);
  const [confirmarExcluir, setConfirmarExcluir] = useState(false);
  const [confirmarExportar, setConfirmarExportar] = useState(false);
  const [textoExportar, setTextoExportar] = useState('');

  const estado = useQuery({
    queryKey: ['dev', 'demonstracao'],
    queryFn: () => api.get('/api/dev/demonstracao'),
    // Enquanto gera, acompanha o progresso de perto.
    refetchInterval: (q) => (q.state.data?.geracao?.rodando || q.state.data?.exportacao?.rodando ? 700 : false)
  });
  const falhou = (err) => setAviso({ tom: 'perigo', texto: err.message });

  const gerar = useMutation({
    mutationFn: () => api.post('/api/dev/demonstracao/gerar'),
    onSuccess: () => estado.refetch(),
    onError: falhou
  });
  const entrar = useMutation({
    mutationFn: () => api.post('/api/dev/demonstracao/entrar'),
    // Recarrega a pagina inteira: cada tela passa a ler a empresa ficticia.
    onSuccess: () => window.location.assign('/'),
    onError: falhou
  });
  const exportar = useMutation({
    mutationFn: () => api.post('/api/dev/demonstracao/exportar', { confirmar: textoExportar }),
    onSuccess: () => {
      setConfirmarExportar(false);
      setTextoExportar('');
      estado.refetch();
    },
    onError: falhou
  });
  const excluir = useMutation({
    mutationFn: () => api.delete('/api/dev/demonstracao'),
    onSuccess: (r) => {
      setConfirmarExcluir(false);
      setAviso({ tom: 'sucesso', texto: `Banco de demonstração apagado. ${tamanho(r.liberados)} liberados no disco.` });
      estado.refetch();
    },
    onError: falhou
  });

  const d = estado.data;
  const g = d?.geracao;
  const r = d?.resumo;
  const x = d?.exportacao;
  const ocupado = g?.rodando || x?.rodando;

  return (
    <section className="dados-dev__secao demo">
      <div className="dados-dev__cabeca">
        <div>
          <h2>Banco de demonstração</h2>
          <p className="texto-suave">
            Uma empresa fictícia com 3 meses de movimento, para mostrar o sistema a um cliente. Só este navegador entra nela —
            o banco de verdade e o WhatsApp real continuam intactos.
          </p>
        </div>
      </div>

      {aviso && (
        <Aviso tom={aviso.tom} aoFechar={() => setAviso(null)}>
          {aviso.texto}
        </Aviso>
      )}
      {g?.erro && <Aviso tom="perigo">A última geração falhou: {g.erro}</Aviso>}
      {x?.erro && !x.rodando && <Aviso tom="perigo">A exportação falhou e nada foi gravado na empresa: {x.erro}</Aviso>}
      {x?.resultado && !x.rodando && (
        <Aviso tom="sucesso">
          Demonstração exportada para a empresa: {numero(x.resultado.contagem.leads)} clientes, {numero(x.resultado.contagem.appointments)}{' '}
          agendamentos, {numero(x.resultado.contagem.conversations)} conversas. Backup de antes: {x.resultado.backupId} (em Backups).
        </Aviso>
      )}

      <div className="demo__cartao">
        {x?.rodando ? (
          <div className="demo__gerando" role="status">
            <strong>Exportando para a empresa…</strong>
            <span className="texto-suave">{x.etapa}</span>
            <span className="demo__barra">
              <span style={{ width: `${x.pct}%` }} />
            </span>
          </div>
        ) : g?.rodando ? (
          <div className="demo__gerando" role="status">
            <strong>Gerando a demonstração…</strong>
            <span className="texto-suave">{g.etapa}</span>
            <span className="demo__barra">
              <span style={{ width: `${g.pct}%` }} />
            </span>
          </div>
        ) : d?.existe && r ? (
          <>
            <div className="demo__topo">
              <div>
                <strong>{r.empresa}</strong>
                <span className="texto-fraco">
                  Gerada em {new Date(r.geradoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · {tamanho(d.tamanhoBytes)} no disco
                </span>
              </div>
              {d.ativo && <span className="demo__selo">● Ativa neste navegador</span>}
            </div>
            <dl className="demo__numeros">
              {[
                ['Profissionais', r.profissionais],
                ['Equipe no sistema', r.equipe],
                ['Serviços', r.servicos],
                ['Produtos', r.produtos],
                ['Clientes', r.clientes],
                ['Conversas', r.conversas],
                ['Mensagens', r.mensagens],
                ['Agendamentos', r.agendamentos],
                ['Vendas', r.vendas],
                ['Campanhas', r.campanhas]
              ].map(([rotulo, n]) => (
                <div key={rotulo}>
                  <dt>{rotulo}</dt>
                  <dd>{numero(n)}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <p className="texto-suave">Nenhuma demonstração gerada ainda. Leva poucos segundos.</p>
        )}

        <div className="demo__acoes">
          {d?.existe && !ocupado && (
            <Botao carregando={entrar.isPending} onClick={() => entrar.mutate()}>
              {d.ativo ? 'Abrir a demonstração' : 'Entrar na demonstração'}
            </Botao>
          )}
          <Botao
            variante={d?.existe ? 'secundario' : 'primario'}
            carregando={gerar.isPending || g?.rodando}
            disabled={ocupado}
            onClick={() => {
              if (!d?.existe || confirm('Gerar de novo apaga a demonstração atual (inclusive o que foi mexido nela) e cria outra do zero. Continuar?')) {
                gerar.mutate();
              }
            }}
          >
            {d?.existe ? 'Gerar de novo' : 'Gerar demonstração'}
          </Botao>
          {d?.existe && !ocupado && (
            <Botao variante="secundario" onClick={() => setConfirmarExportar(true)}>
              Exportar demonstração…
            </Botao>
          )}
          {d?.existe && !ocupado && (
            <Botao variante="perigo" onClick={() => setConfirmarExcluir(true)}>
              Excluir demonstração
            </Botao>
          )}
        </div>

        {confirmarExportar && (
          <div className="demo__confirmar" role="alertdialog" aria-label="Exportar a demonstração">
            <p>
              <strong>Trazer os dados da demonstração para a empresa de verdade?</strong> Clientes, agenda, conversas, vendas,
              campanhas, profissionais, serviços e produtos fictícios entram <strong>misturados</strong> com os reais — a Sofia e a
              recepção passam a ver os profissionais e serviços da demonstração ao marcar horário.
            </p>
            <p className="texto-suave">
              Para nada sair para gente de verdade: os telefones viram números impossíveis, conversas chegam finalizadas, campanhas
              pausadas e sem aceitar campanha, e lembretes já constam como enviados. Usuários, conexões e configurações da
              demonstração não vêm. Um backup é feito antes — é o caminho de volta (Backups → restaurar).
            </p>
            <label className="coluna" style={{ gap: 4 }}>
              <span>
                Digite <strong className="mono">EXPORTAR</strong> para confirmar
              </span>
              <Entrada value={textoExportar} autoComplete="off" onChange={(e) => setTextoExportar(e.target.value)} />
            </label>
            <div className="linha">
              <Botao variante="perigo" disabled={textoExportar !== 'EXPORTAR'} carregando={exportar.isPending} onClick={() => exportar.mutate()}>
                Exportar para a empresa
              </Botao>
              <Botao
                variante="fantasma"
                onClick={() => {
                  setConfirmarExportar(false);
                  setTextoExportar('');
                }}
              >
                Cancelar
              </Botao>
            </div>
          </div>
        )}

        {confirmarExcluir && (
          <div className="demo__confirmar" role="alertdialog" aria-label="Excluir a demonstração">
            <p>
              <strong>Excluir o banco de demonstração?</strong> O arquivo é apagado do disco e o espaço volta a ficar livre. O banco
              de verdade não é tocado.
            </p>
            <div className="linha">
              <Botao variante="perigo" carregando={excluir.isPending} onClick={() => excluir.mutate()}>
                Sim, excluir
              </Botao>
              <Botao variante="fantasma" onClick={() => setConfirmarExcluir(false)}>
                Cancelar
              </Botao>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
