import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { AreaTexto, Aviso, Botao, Campo, Carregando, Etiqueta, Modal, Vazio } from '../../componentes/ui.jsx';

/**
 * Passar o atendimento para outra pessoa.
 *
 * A escolha mostra CARGA e PRESENÇA de cada um, porque transferir sem saber
 * disso é só mudar o nome de quem vai demorar a responder. Quem está lotado ou
 * offline aparece marcado, mas continua selecionável: quem transfere costuma
 * ter um motivo que o sistema não conhece ("é cliente dele há dez anos").
 *
 * O motivo não é enfeite — fica no histórico da conversa e é a primeira coisa
 * que a pessoa do outro lado lê ao assumir.
 */

const PRESENCA = {
  online: { rotulo: 'online', tom: 'sucesso' },
  ausente: { rotulo: 'ausente', tom: 'alerta' },
  offline: { rotulo: 'offline', tom: 'neutro' }
};

export function Transferir({ conversationId, aoFechar, aoTransferir }) {
  const [escolhido, setEscolhido] = useState(null);
  const [motivo, setMotivo] = useState('');

  const destinos = useQuery({
    queryKey: ['conversas', 'destinos'],
    queryFn: () => api.get('/api/conversas/destinos')
  });

  const transferir = useMutation({
    mutationFn: () =>
      api.post(`/api/conversas/${conversationId}/transferir`, {
        paraUserId: escolhido,
        motivo: motivo.trim() || undefined
      }),
    onSuccess: aoTransferir
  });

  const atendentes = destinos.data?.atendentes ?? [];

  return (
    <Modal
      titulo="Transferir atendimento"
      aberto
      aoFechar={aoFechar}
      largura={520}
      rodape={
        <>
          <Botao variante="secundario" onClick={aoFechar}>
            Cancelar
          </Botao>
          <Botao carregando={transferir.isPending} disabled={!escolhido} onClick={() => transferir.mutate()}>
            Transferir
          </Botao>
        </>
      }
    >
      {transferir.isError && <Aviso tom="perigo">{transferir.error.message}</Aviso>}

      {destinos.isLoading ? (
        <Carregando />
      ) : atendentes.length === 0 ? (
        <Vazio
          titulo="Ninguém para receber"
          descricao="Não há outro atendente cadastrado e ativo nesta empresa."
        />
      ) : (
        <div className="coluna">
          <div className="coluna" style={{ gap: 'var(--e2)' }}>
            {atendentes.map((a) => {
              const presenca = PRESENCA[a.statusPresenca] ?? PRESENCA.offline;
              const ativo = escolhido === a.id;

              return (
                <label key={a.id} className={`opcao opcao--cartao${ativo ? ' opcao--ativa' : ''}`}>
                  <input
                    type="radio"
                    name="destino"
                    checked={ativo}
                    onChange={() => setEscolhido(a.id)}
                  />
                  <span className="crescer">
                    <span className="linha linha--entre">
                      <strong>{a.nome}</strong>
                      <Etiqueta tom={presenca.tom}>{presenca.rotulo}</Etiqueta>
                    </span>
                    <span className="texto-fraco">
                      {a.emAtendimento} de {a.capacidade} conversas
                      {a.lotado ? ' · no limite' : ''}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <Campo rotulo="Motivo" dica="Aparece no histórico e ajuda quem vai assumir.">
            <AreaTexto
              rows={2}
              value={motivo}
              placeholder="Ex: cliente dele, vou sair para o almoço..."
              onChange={(e) => setMotivo(e.target.value)}
            />
          </Campo>
        </div>
      )}
    </Modal>
  );
}
