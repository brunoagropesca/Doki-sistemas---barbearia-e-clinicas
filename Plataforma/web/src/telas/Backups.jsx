import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Aviso, Botao, Carregando, Entrada, Modal } from '../componentes/ui.jsx';
import './Backups.css';

/**
 * Backups e armazenamento — a pagina do DONO.
 *
 * O dono e quem perde se o computador morrer. Aqui ele ve num relance: quando
 * foi o ultimo backup, se a copia FORA do computador (pendrive/nuvem) esta em
 * dia, e quanto o sistema ocupa. E faz o que precisa: backup agora, baixar,
 * restaurar (digitando RESTAURAR) e escolher a pasta da copia externa.
 * "Apagar dados" nao esta aqui: continua so na pagina do DEV.
 */

const dataHora = (iso) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const tamanho = (bytes) => {
  if (bytes == null) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
};

/** "há 3 horas", "há 2 dias" — o que importa e a idade, nao a data. */
function haQuanto(iso) {
  if (!iso) return 'nunca';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return `há ${d} dia${d === 1 ? '' : 's'}`;
}

export function Backups() {
  const queryClient = useQueryClient();
  const [aviso, setAviso] = useState(null);
  const [restaurando, setRestaurando] = useState(null); // backup escolhido para restaurar

  const { data, isLoading, isError, error } = useQuery({ queryKey: ['backups'], queryFn: () => api.get('/api/backups') });
  const recarregar = () => queryClient.invalidateQueries({ queryKey: ['backups'] });
  const falhou = (err) => setAviso({ tom: 'perigo', texto: err.message });

  const criar = useMutation({
    mutationFn: () => api.post('/api/backups', { incluirArquivos: true }),
    onSuccess: () => {
      setAviso({ tom: 'sucesso', texto: 'Backup feito. A cópia externa (se configurada) sai em seguida.' });
      recarregar();
    },
    onError: falhou
  });
  const apagar = useMutation({ mutationFn: (id) => api.delete(`/api/backups/${id}`), onSuccess: recarregar, onError: falhou });
  const cancelar = useMutation({ mutationFn: () => api.delete('/api/backups-restauracao'), onSuccess: recarregar, onError: falhou });

  if (isLoading) return <Carregando />;
  if (isError) return <Aviso tom="perigo">{error.message}</Aviso>;

  const { armazenamento: arm, restauracaoPendente: pendente, ultimaRestauracao: ultima } = data;
  const copia = arm.copiaExterna;

  return (
    <div className="coluna bk">
      <header className="bk-topo">
        <div>
          <h1>Backups</h1>
          <p className="texto-suave">Cópias de segurança dos seus dados, e quanto o sistema ocupa no computador.</p>
        </div>
        <Botao carregando={criar.isPending} onClick={() => criar.mutate()}>
          Fazer backup agora
        </Botao>
      </header>

      {aviso && (
        <Aviso tom={aviso.tom} aoFechar={() => setAviso(null)}>
          {aviso.texto}
        </Aviso>
      )}

      {pendente && (
        <Aviso tom="alerta" titulo="Restauração agendada">
          O backup de <strong>{dataHora(pendente.agendadoEm)}</strong> vai substituir os dados atuais no{' '}
          <strong>próximo início do sistema</strong>. Feche o sistema (PARAR) e abra de novo (INICIAR) para aplicar. O estado de
          agora foi guardado num backup de segurança.
          <div className="bk-aviso-acao">
            <Botao variante="secundario" tamanho="sm" carregando={cancelar.isPending} onClick={() => cancelar.mutate()}>
              Cancelar restauração
            </Botao>
          </div>
        </Aviso>
      )}
      {ultima && !pendente && (
        <Aviso tom={ultima.ok ? 'sucesso' : 'perigo'}>
          Última restauração ({dataHora(ultima.em)}): {ultima.ok ? 'aplicada com sucesso.' : `falhou — ${ultima.erro}`}
        </Aviso>
      )}

      {/* Situacao num relance: o que protege e se esta em dia. */}
      <section className="bk-situacao" aria-label="Situação">
        <div className="bk-tile">
          <span className="bk-tile__rotulo">Último backup</span>
          <strong className="bk-tile__valor">{haQuanto(arm.ultimoBackupEm)}</strong>
          <span className="bk-tile__detalhe">{arm.ultimoBackupEm ? dataHora(arm.ultimoBackupEm) : 'Faça o primeiro agora'}</span>
        </div>
        <div className={`bk-tile${copia.atrasada ? ' bk-tile--alerta' : ''}`}>
          <span className="bk-tile__rotulo">Cópia fora do computador</span>
          <strong className="bk-tile__valor">{copia.pasta ? haQuanto(copia.ultimaCopiaEm) : 'não configurada'}</strong>
          <span className="bk-tile__detalhe">
            {copia.atrasada
              ? copia.pasta
                ? 'Mais de 7 dias sem cópia — confira a pasta abaixo'
                : 'Se este computador falhar, os backups vão junto'
              : 'Em dia'}
          </span>
        </div>
        <div className="bk-tile">
          <span className="bk-tile__rotulo">Espaço usado</span>
          <strong className="bk-tile__valor">{tamanho(arm.totalBytes)}</strong>
          <span className="bk-tile__detalhe">{arm.livreNoDiscoBytes != null ? `${tamanho(arm.livreNoDiscoBytes)} livres no disco` : ''}</span>
        </div>
      </section>

      <UsoDoDisco arm={arm} />

      <CopiaExterna copia={copia} aoMudar={recarregar} aoAvisar={setAviso} />

      <section className="cartao bk-lista" aria-label="Backups">
        <header className="bk-lista__cabeca">
          <h2>Backups guardados</h2>
          <p className="texto-fraco">
            Um automático por dia (ficam os 14 mais recentes). Fotos e áudios ficam uma vez só, compartilhados por todos.
          </p>
        </header>
        {data.backups.length === 0 ? (
          <p className="texto-fraco bk-vazio">Nenhum backup ainda.</p>
        ) : (
          data.backups.map((b) => (
            <div key={b.id} className={`bk-linha${pendente?.id === b.id ? ' bk-linha--agendado' : ''}`}>
              <div className="bk-linha__info">
                <strong>{dataHora(b.criadoEm)}</strong>
                <span className={`bk-motivo bk-motivo--${b.motivo}`}>{b.motivoTexto}</span>
                <span className="texto-fraco bk-linha__detalhe">
                  {tamanho(b.tamanhoBytes)}
                  {b.comArquivos ? ' · com fotos e áudios' : ' · só os dados'}
                  {b.resumo && ` · ${b.resumo.clientes} clientes, ${b.resumo.conversas} conversas`}
                  {b.por && ` · por ${b.por}`}
                </span>
              </div>
              <div className="bk-linha__acoes">
                <Botao
                  variante="fantasma"
                  tamanho="sm"
                  onClick={() => api.baixar(`/api/backups/${b.id}/baixar`, null, `backup-${b.id}.db`).catch(falhou)}
                >
                  Baixar
                </Botao>
                <Botao variante="secundario" tamanho="sm" disabled={Boolean(pendente)} onClick={() => setRestaurando(b)}>
                  Restaurar
                </Botao>
                {b.motivo === 'manual' && (
                  <Botao
                    variante="fantasma"
                    tamanho="sm"
                    disabled={pendente?.id === b.id}
                    onClick={() => confirm(`Apagar o backup de ${dataHora(b.criadoEm)}? Não dá para desfazer.`) && apagar.mutate(b.id)}
                  >
                    Apagar
                  </Botao>
                )}
              </div>
            </div>
          ))
        )}
      </section>

      {restaurando && (
        <ModalRestaurar
          backup={restaurando}
          aoFechar={() => setRestaurando(null)}
          aoAgendar={() => {
            setRestaurando(null);
            recarregar();
          }}
        />
      )}
    </div>
  );
}

/** Barra empilhada por categoria + legenda com os valores (a cor nunca fala sozinha). */
function UsoDoDisco({ arm }) {
  const total = arm.totalBytes || 1;
  return (
    <section className="cartao bk-disco" aria-label="Uso do disco">
      <h2>Onde está o espaço</h2>
      <div className="bk-barra" role="img" aria-label={arm.categorias.map((c) => `${c.rotulo}: ${tamanho(c.bytes)}`).join(', ')}>
        {arm.categorias
          .filter((c) => c.bytes > 0)
          .map((c) => (
            <span key={c.chave} className={`bk-barra__parte bk-cor--${c.chave}`} style={{ flexGrow: c.bytes / total }} title={`${c.rotulo}: ${tamanho(c.bytes)}`} />
          ))}
      </div>
      <ul className="bk-legenda">
        {arm.categorias.map((c) => (
          <li key={c.chave}>
            <span className={`bk-legenda__cor bk-cor--${c.chave}`} aria-hidden="true" />
            <span className="bk-legenda__rotulo">{c.rotulo}</span>
            <span className="bk-legenda__valor mono">{tamanho(c.bytes)}</span>
          </li>
        ))}
      </ul>
      {arm.midiaPorAno.length > 0 && (
        <p className="texto-fraco bk-anos">
          Fotos, áudios e anexos por ano:{' '}
          {arm.midiaPorAno.map((a) => `${a.ano}: ${tamanho(a.bytes)} (${a.arquivos} arquivo${a.arquivos === 1 ? '' : 's'})`).join(' · ')}
        </p>
      )}
    </section>
  );
}

function CopiaExterna({ copia, aoMudar, aoAvisar }) {
  const [pasta, setPasta] = useState(copia.pasta ?? '');
  const [teste, setTeste] = useState(null);
  useEffect(() => setPasta(copia.pasta ?? ''), [copia.pasta]);

  const testar = useMutation({
    mutationFn: () => api.post('/api/backups/copia-externa/testar', { pasta }),
    onSuccess: setTeste,
    onError: (err) => setTeste({ ok: false, erro: err.message })
  });
  const salvar = useMutation({
    mutationFn: () => api.put('/api/backups/copia-externa', { pasta: pasta.trim() || null }),
    onSuccess: () => {
      setTeste(null);
      aoAvisar({ tom: 'sucesso', texto: pasta.trim() ? 'Pasta salva. A cópia sai a cada backup.' : 'Cópia externa desligada.' });
      aoMudar();
    },
    onError: (err) => setTeste({ ok: false, erro: err.message })
  });
  const agora = useMutation({
    mutationFn: () => api.post('/api/backups/copia-externa/agora'),
    onSuccess: ({ resultado }) => {
      aoAvisar(resultado.ok ? { tom: 'sucesso', texto: 'Cópia externa feita.' } : { tom: 'perigo', texto: resultado.erro ?? 'A cópia não foi feita.' });
      aoMudar();
    },
    onError: (err) => aoAvisar({ tom: 'perigo', texto: err.message })
  });

  const mudou = (copia.pasta ?? '') !== pasta.trim();

  return (
    <section className="cartao bk-copia" aria-label="Cópia fora do computador">
      <h2>Cópia fora do computador</h2>
      <p className="texto-suave">
        O backup mora neste computador: se o disco falhar, ele vai junto. Escolha uma pasta em <strong>outro lugar</strong> — um
        pendrive, um HD externo ou a pasta do OneDrive / Google Drive — e cada backup é copiado para lá.
      </p>
      <div className="bk-copia__linha">
        <Entrada
          value={pasta}
          onChange={(e) => {
            setPasta(e.target.value);
            setTeste(null);
          }}
          placeholder="Ex.: E:\Backups  ou  C:\Users\Você\OneDrive\Backups"
          aria-label="Pasta da cópia externa"
          className="mono"
        />
        <Botao variante="secundario" disabled={!pasta.trim()} carregando={testar.isPending} onClick={() => testar.mutate()}>
          Testar pasta
        </Botao>
        <Botao disabled={!mudou} carregando={salvar.isPending} onClick={() => salvar.mutate()}>
          Salvar
        </Botao>
      </div>
      {teste && (
        <p className={teste.ok ? 'bk-copia__ok' : 'bk-copia__erro'} role="status">
          {teste.ok ? '✓ A pasta existe e aceita gravação.' : teste.erro}
        </p>
      )}
      {copia.pasta && (
        <div className="bk-copia__estado">
          <span>
            {copia.ultimaCopiaEm ? `Última cópia: ${dataHora(copia.ultimaCopiaEm)}` : 'Ainda não houve cópia.'}
            {copia.ultimoErro && <span className="bk-copia__erro"> · {copia.ultimoErro}</span>}
          </span>
          <Botao variante="fantasma" tamanho="sm" carregando={agora.isPending} onClick={() => agora.mutate()}>
            Copiar agora
          </Botao>
        </div>
      )}
    </section>
  );
}

function ModalRestaurar({ backup, aoFechar, aoAgendar }) {
  const [palavra, setPalavra] = useState('');
  const restaurar = useMutation({
    mutationFn: () => api.post(`/api/backups/${backup.id}/restaurar`, { confirmacao: palavra.trim() }),
    onSuccess: aoAgendar
  });
  const pronto = palavra.trim() === 'RESTAURAR';

  return (
    <Modal
      titulo="Restaurar backup"
      aberto
      aoFechar={aoFechar}
      rodape={
        <>
          <Botao variante="secundario" onClick={aoFechar}>
            Cancelar
          </Botao>
          <Botao variante="perigo" disabled={!pronto} carregando={restaurar.isPending} onClick={() => restaurar.mutate()}>
            Restaurar
          </Botao>
        </>
      }
    >
      <p>
        O sistema volta para <strong>{dataHora(backup.criadoEm)}</strong>. Tudo o que foi feito depois disso — conversas,
        agendamentos, cadastros — será substituído.
      </p>
      <ul className="bk-modal__lista">
        <li>A troca acontece no <strong>próximo início</strong> do sistema (feche e abra de novo).</li>
        <li>Antes, o estado de agora vira um <strong>backup de segurança</strong>: dá para voltar atrás.</li>
        <li>Até reiniciar, você pode cancelar a restauração nesta página.</li>
      </ul>
      {restaurar.isError && <Aviso tom="perigo">{restaurar.error.message}</Aviso>}
      <label className="bk-modal__confirmar">
        <span>
          Para confirmar, digite <strong>RESTAURAR</strong>:
        </span>
        <Entrada value={palavra} onChange={(e) => setPalavra(e.target.value)} autoFocus aria-label="Digite RESTAURAR" />
      </label>
    </Modal>
  );
}
