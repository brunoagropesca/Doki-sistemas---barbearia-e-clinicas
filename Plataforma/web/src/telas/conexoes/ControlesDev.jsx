import { useState } from 'react';
import { Aviso, Botao, Cartao } from '../../componentes/ui.jsx';
import { Confirmacao } from './Confirmacao.jsx';
import { Interruptor } from './Interruptor.jsx';
import { useAtualizarSessao, useRemoverSessao } from './hooks.js';

/**
 * Controles que so o perfil tecnico enxerga: ativar/desativar e remover.
 * Renderizado apenas quando `ehDev`; o servidor confere de novo e responde
 * "nao existe" a qualquer outra pessoa que tente a mesma chamada.
 */
export function ControlesDev({ canal, aoRemovida }) {
  const atualizar = useAtualizarSessao(canal.chave);
  const remover = useRemoverSessao(canal.chave);
  const [confirmando, setConfirmando] = useState(false);

  const ativo = atualizar.isPending ? Boolean(atualizar.variables?.ativo) : canal.ativo !== false;

  return (
    <Cartao titulo="Controles técnicos">
      <div className="coluna">
        <p className="texto-fraco">Estes controles só aparecem para o perfil técnico.</p>

        <Interruptor
          rotulo="Sessão ativa"
          descricao="Desativada, a conta sai do ar (a sessão salva é mantida) e ninguém consegue conectá-la."
          ligado={ativo}
          ocupado={atualizar.isPending}
          erro={atualizar.isError ? atualizar.error.message : undefined}
          aoAlternar={(novo) => atualizar.mutate({ ativo: novo })}
        />

        {remover.isError && <Aviso tom="perigo">{remover.error.message}</Aviso>}

        {confirmando ? (
          <Confirmacao
            titulo={`Remover a sessão ${canal.chave}?`}
            rotuloConfirmar="Sim, remover"
            carregando={remover.isPending}
            aoCancelar={() => setConfirmando(false)}
            aoConfirmar={() => remover.mutate(undefined, { onSuccess: () => aoRemovida?.() })}
          >
            <p>
              A conta será desconectada do WhatsApp e a sessão apagada. As conversas antigas continuam no histórico. Isso
              não pode ser desfeito.
            </p>
          </Confirmacao>
        ) : (
          <div className="linha">
            <Botao type="button" variante="perigo" tamanho="sm" onClick={() => setConfirmando(true)}>
              Remover sessão
            </Botao>
          </div>
        )}
      </div>
    </Cartao>
  );
}
