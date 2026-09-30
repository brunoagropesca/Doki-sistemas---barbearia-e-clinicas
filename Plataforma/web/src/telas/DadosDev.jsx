import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Aviso, Botao, Carregando, Entrada } from '../componentes/ui.jsx';
import { PainelDemonstracao } from './dados/PainelDemonstracao.jsx';
import './DadosDev.css';

/**
 * Backups e dados — pagina do perfil DEV.
 *
 * Em cima, o que protege (backups); embaixo, separado e vermelho, o que
 * destroi (apagar dados). Apagar sempre faz um backup antes, e a pagina diz
 * isso na cara, para ninguem hesitar em usar e nem usar sem saber.
 */

const dataHora = (iso) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const tamanho = (bytes) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
};

export function DadosDev() {
  const queryClient = useQueryClient();
  const [aviso, setAviso] = useState(null);
  const [comArquivos, setComArquivos] = useState(true);

  const { data, isLoading } = useQuery({ queryKey: ['dev', 'backups'], queryFn: () => api.get('/api/dev/backups') });
  const recarregar = () => queryClient.invalidateQueries({ queryKey: ['dev', 'backups'] });
  const falhou = (err) => setAviso({ tom: 'perigo', texto: err.message });

  const criar = useMutation({
    mutationFn: () => api.post('/api/dev/backups', { incluirArquivos: comArquivos }),
    onSuccess: () => {
      setAviso({ tom: 'sucesso', texto: 'Backup criado.' });
      recarregar();
    },
    onError: falhou
  });
  const apagar = useMutation({
    mutationFn: (id) => api.delete(`/api/dev/backups/${id}`),
    onSuccess: recarregar,
    onError: falhou
  });
  const restaurar = useMutation({
    mutationFn: (id) => api.post(`/api/dev/backups/${id}/restaurar`),
    onSuccess: recarregar,
    onError: falhou
  });
  const cancelar = useMutation({
    mutationFn: () => api.delete('/api/dev/backups-restauracao'),
    onSuccess: recarregar,
    onError: falhou
  });

  if (isLoading || !data) return <Carregando />;

  const pendente = data.restauracaoPendente;
  const ultima = data.ultimaRestauracao;

  return (
    <div className="coluna dados-dev">
      <header>
        <h1>Backups e dados</h1>
        <p className="texto-suave">
          Cópias de segurança do banco e a limpeza de dados da empresa. Só o perfil DEV vê esta página.
        </p>
      </header>

      {aviso && (
        <Aviso tom={aviso.tom} aoFechar={() => setAviso(null)}>
          {aviso.texto}
        </Aviso>
      )}

      {data.clientesDeExemplo?.length > 0 && (
        <Aviso tom="alerta" titulo="Clientes de exemplo da instalação antiga">
          O cadastro ainda tem {data.clientesDeExemplo.length === 1 ? 'o cliente' : 'os clientes'} de exemplo que as instalações
          antigas criavam ({data.clientesDeExemplo.map((c) => c.nome).join(', ')}), sem nenhuma conversa. Os telefones são
          celulares de verdade: uma campanha para "todos os clientes" mandaria mensagem para desconhecidos. Confira com a loja e
          apague em Clientes, se forem mesmo de exemplo.
        </Aviso>
      )}

      {pendente && (
        <Aviso tom="alerta" titulo="Restauração agendada">
          O backup de <strong>{dataHora(pendente.agendadoEm)}</strong> ({pendente.id}) vai substituir o banco atual no{' '}
          <strong>próximo início do sistema</strong>. Feche o sistema (PARAR.bat) e abra de novo (INICIAR.bat) para
          aplicar. O estado atual foi guardado no backup {pendente.backupDeSeguranca}.
          <div style={{ marginTop: 'var(--e2)' }}>
            <Botao variante="secundario" tamanho="sm" carregando={cancelar.isPending} onClick={() => cancelar.mutate()}>
              Cancelar restauração
            </Botao>
          </div>
        </Aviso>
      )}

      {ultima && !pendente && (
        <Aviso tom={ultima.ok ? 'sucesso' : 'perigo'}>
          Última restauração ({dataHora(ultima.em)}): {ultima.ok ? `backup ${ultima.id} aplicado.` : `falhou — ${ultima.erro}`}
        </Aviso>
      )}

      {/* ---------------- Backups ---------------- */}
      <PainelDemonstracao />

      <section className="dados-dev__secao">
        <div className="dados-dev__cabeca">
          <div>
            <h2>Backups</h2>
            <p className="texto-fraco">
              Um backup automático é feito todo dia (ficam os 14 mais recentes). Os manuais ficam até você apagar.
            </p>
            {/* As fotos e audios ficam UMA vez para todos os backups (o cofre). */}
            {data.cofre?.arquivos > 0 && (
              <p className="texto-fraco">
                Fotos e áudios dos backups: {tamanho(data.cofre.bytes)} ({data.cofre.arquivos} arquivos, uma cópia de
                cada, compartilhada por todos).
              </p>
            )}
          </div>
          <div className="dados-dev__criar">
            <label className="opcao">
              <input type="checkbox" checked={comArquivos} onChange={(e) => setComArquivos(e.target.checked)} />
              <span>Incluir fotos e áudios</span>
            </label>
            <Botao carregando={criar.isPending} onClick={() => criar.mutate()}>
              Fazer backup agora
            </Botao>
          </div>
        </div>

        {data.backups.length === 0 ? (
          <p className="texto-fraco">Nenhum backup ainda.</p>
        ) : (
          <div className="dados-dev__lista">
            {data.backups.map((b) => (
              <div key={b.id} className={`backup${pendente?.id === b.id ? ' backup--agendado' : ''}`}>
                <div className="crescer">
                  <strong>{dataHora(b.criadoEm)}</strong>
                  <span className={`backup__motivo backup__motivo--${b.motivo}`}>{b.motivoTexto}</span>
                  <div className="texto-fraco backup__detalhes">
                    {tamanho(b.tamanhoBytes)}
                    {b.comArquivos ? ' · com fotos e áudios' : ' · só o banco'}
                    {b.resumo && ` · ${b.resumo.clientes} clientes, ${b.resumo.conversas} conversas, ${b.resumo.agendamentos} agendamentos`}
                    {b.por && ` · por ${b.por}`}
                  </div>
                </div>
                <div className="backup__acoes">
                  <a className="botao botao--fantasma botao--sm" href={`/api/dev/backups/${b.id}/baixar`} download>
                    Baixar
                  </a>
                  <Botao
                    variante="secundario"
                    tamanho="sm"
                    disabled={Boolean(pendente)}
                    carregando={restaurar.isPending && restaurar.variables === b.id}
                    onClick={() => {
                      if (
                        confirm(
                          `Restaurar o backup de ${dataHora(b.criadoEm)}?\n\nTudo o que foi feito depois dele será substituído. ` +
                            'A troca acontece no próximo início do sistema, e o estado atual é guardado antes.'
                        )
                      ) {
                        restaurar.mutate(b.id);
                      }
                    }}
                  >
                    Restaurar
                  </Botao>
                  <Botao
                    variante="fantasma"
                    tamanho="sm"
                    disabled={pendente?.id === b.id}
                    onClick={() => {
                      if (confirm(`Apagar o backup de ${dataHora(b.criadoEm)}? Não dá para desfazer.`)) apagar.mutate(b.id);
                    }}
                  >
                    Apagar
                  </Botao>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---------------- Apagar dados ---------------- */}
      <ApagarDados grupos={data.grupos} aoApagar={(r) => {
        setAviso({
          tom: 'sucesso',
          texto: `Dados apagados. Backup de segurança feito antes: ${r.backup}.`
        });
        recarregar();
        queryClient.invalidateQueries();
      }} />
    </div>
  );
}

function ApagarDados({ grupos, aoApagar }) {
  const [marcados, setMarcados] = useState([]);
  const [confirmacao, setConfirmacao] = useState('');

  const apagar = useMutation({
    mutationFn: () => api.post('/api/dev/dados/apagar', { grupos: marcados, confirmacao }),
    onSuccess: (r) => {
      setMarcados([]);
      setConfirmacao('');
      aoApagar(r);
    }
  });

  function alternar(g) {
    setMarcados((atual) => {
      if (atual.includes(g.chave)) {
        // Desmarcar um grupo que outro exige desmarca o outro tambem.
        return atual.filter((c) => c !== g.chave && !grupos.find((x) => x.chave === c)?.exige?.includes(g.chave));
      }
      // Marcar um grupo marca junto o que ele exige.
      return [...new Set([...atual, g.chave, ...(g.exige ?? [])])];
    });
  }

  const pronto = marcados.length > 0 && confirmacao === 'APAGAR';

  return (
    <section className="dados-dev__secao dados-dev__perigo">
      <h2>Apagar dados</h2>
      <p className="texto-suave">
        Escolha o que apagar. <strong>Antes de apagar, o sistema faz um backup completo sozinho</strong> — dá para voltar
        pela lista acima. Nunca são apagados: a empresa, os donos, as conexões de WhatsApp e as configurações.
      </p>

      <div className="dados-dev__grupos">
        {grupos.map((g) => (
          <label key={g.chave} className={`opcao opcao--cartao${marcados.includes(g.chave) ? ' dados-dev__grupo--marcado' : ''}`}>
            <input type="checkbox" checked={marcados.includes(g.chave)} onChange={() => alternar(g)} />
            <span>
              <strong>{g.titulo}</strong>
              <div className="texto-fraco">{g.descricao}</div>
            </span>
          </label>
        ))}
      </div>

      {apagar.isError && <Aviso tom="perigo">{apagar.error.message}</Aviso>}

      <div className="dados-dev__confirmar">
        <label className="campo" style={{ marginBottom: 0 }}>
          <span className="campo__rotulo">
            Para confirmar, digite <strong>APAGAR</strong>
          </span>
          <Entrada value={confirmacao} onChange={(e) => setConfirmacao(e.target.value)} placeholder="APAGAR" autoComplete="off" />
        </label>
        <Botao variante="perigo" disabled={!pronto} carregando={apagar.isPending} onClick={() => apagar.mutate()}>
          Apagar {marcados.length ? `${marcados.length} grupo${marcados.length > 1 ? 's' : ''}` : 'dados'}
        </Botao>
      </div>
    </section>
  );
}
