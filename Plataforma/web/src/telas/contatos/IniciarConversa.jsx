import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Aviso, Botao, Modal } from '../../componentes/ui.jsx';
import './IniciarConversa.css';

/**
 * "Enviar mensagem" (lista de clientes e ficha do cliente).
 *
 * Com atendimento aberto, vai direto ao fio dele. Sem nenhum, PERGUNTA antes
 * de abrir um atendimento novo: abrir sem querer criava uma conversa vazia
 * na mesa de todo mundo so por um clique para conferir.
 *
 * Uso: const envio = useEnviarMensagem({ aoErro });
 *      <Botao onClick={() => envio.enviar(lead)} carregando={envio.carregando(lead.id)} />
 *      {envio.popup}
 */
export function useEnviarMensagem({ aoErro } = {}) {
  const navegar = useNavigate();
  const [pergunta, setPergunta] = useState(null); // { id, nome } do cliente sem atendimento

  const irPara = (r) => navegar(`/conversas?id=${r.conversa.id}`);

  // So procura (criar: false): a conversa aberta, por qualquer conexao.
  const procurar = useMutation({
    mutationFn: (lead) => api.post('/api/conversas/abrir', { leadId: lead.id, criar: false }),
    onSuccess: (r, lead) => (r.conversa ? irPara(r) : setPergunta(lead)),
    onError: (err) => aoErro?.(err.message)
  });

  const iniciar = useMutation({
    mutationFn: (lead) => api.post('/api/conversas/abrir', { leadId: lead.id }),
    onSuccess: irPara
  });

  function fechar() {
    setPergunta(null);
    iniciar.reset();
  }

  const primeiroNome = pergunta?.nome?.split(' ')[0] || 'este cliente';

  const popup = (
    <Modal
      titulo="Nova conversa"
      aberto={Boolean(pergunta)}
      aoFechar={fechar}
      largura={420}
      className="iniciar-conversa"
      rodape={
        <>
          <Botao variante="secundario" onClick={fechar}>
            Agora não
          </Botao>
          <Botao carregando={iniciar.isPending} onClick={() => iniciar.mutate(pergunta)}>
            Iniciar conversa
          </Botao>
        </>
      }
    >
      <div className="iniciar-conversa__corpo">
        {/* Dois baloes que "chegam" um depois do outro: a conversa comecando. */}
        <div className="iniciar-conversa__ilustracao" aria-hidden="true">
          <span className="iniciar-conversa__balao iniciar-conversa__balao--1" />
          <span className="iniciar-conversa__balao iniciar-conversa__balao--2">
            <i />
            <i />
            <i />
          </span>
        </div>
        <p className="iniciar-conversa__titulo">{pergunta?.nome} não tem nenhum atendimento aberto.</p>
        <p className="texto-fraco">
          Quer iniciar uma nova conversa com {primeiroNome}? Ela abre na mesa de atendimento e a primeira mensagem sai pelo
          WhatsApp de onde {primeiroNome} falou por último.
        </p>
        {iniciar.isError && <Aviso tom="perigo">{iniciar.error.message}</Aviso>}
      </div>
    </Modal>
  );

  return {
    enviar: (lead) => procurar.mutate(lead),
    carregando: (leadId) => procurar.isPending && procurar.variables?.id === leadId,
    popup
  };
}
