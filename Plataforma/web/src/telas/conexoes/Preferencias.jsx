import { useId, useState } from 'react';
import { AreaTexto, Botao, Cartao, Entrada } from '../../componentes/ui.jsx';
import { Interruptor } from './Interruptor.jsx';
import { NOME_SESSAO_MAX as NOME_MAX, NOME_SESSAO_MIN as NOME_MIN } from './formatar.js';
import { lerCampoDoCanal, useAtualizarSessao, useSalvarConfig } from './hooks.js';

/**
 * Cartao "Preferências do número".
 *
 * Dono e gerente ajustam as preferencias da conta e SALVAM de uma vez, no botao
 * da barra que aparece quando algo mudou: mexer em tres interruptores e gravar
 * tres vezes, cada uma com seu erro possivel, deixaria a conta num meio-termo
 * que ninguem escolheu. O NOME da sessao so o perfil tecnico edita; para os
 * demais ele ja aparece no cartao da conexao. Quem impede de verdade e o
 * servidor — aqui so decidimos o que mostrar.
 */

// Os mesmos limites que o servidor confere. Validar aqui nao substitui la:
// serve para a pessoa ver o problema antes de clicar.
const MENSAGEM_MIN = 3;
const MENSAGEM_MAX = 500;

/** Campos que o botao "Salvar" grava, na ordem em que aparecem na tela. */
const INTERRUPTORES = [
  {
    campo: 'iaHabilitada',
    rotulo: 'Sofia responde neste número',
    descricao: 'Desligado, só a equipe responde quem escrever para este número.'
  },
  {
    campo: 'rejeitarChamadas',
    rotulo: 'Recusar ligações',
    descricao: 'Recusa chamadas de voz e vídeo e avisa que o atendimento é por mensagem.'
  },
  {
    campo: 'marcarComoLida',
    rotulo: 'Marcar como lida ao chegar',
    descricao: 'O cliente vê os tiques azuis assim que a mensagem chega.'
  },
  {
    campo: 'sincronizarContatos',
    rotulo: 'Usar o nome do perfil do WhatsApp',
    descricao: 'Preenche o nome de quem ainda está como “Contato WhatsApp”.'
  }
];

export function Preferencias({ canal, ehDev }) {
  const salvar = useSalvarConfig(canal.chave);

  // Rascunho = so o que a pessoa mexeu e ainda nao gravou. Sem mexida, a tela
  // acompanha o servidor; uma atualizacao em segundo plano nunca apaga o que
  // esta sendo digitado.
  const [rascunho, setRascunho] = useState({});

  const valorDe = (campo) => (campo in rascunho ? rascunho[campo] : lerCampoDoCanal(canal, campo));

  const mensagem = valorDe('mensagemChamada') ?? '';
  const mensagemLimpa = String(mensagem).trim();
  const mensagemValida = mensagemLimpa.length >= MENSAGEM_MIN && mensagemLimpa.length <= MENSAGEM_MAX;
  const precisaMensagem = Boolean(valorDe('rejeitarChamadas'));

  // So conta como alteracao o que de fato difere do servidor.
  const alteracoes = {};
  for (const { campo } of INTERRUPTORES) {
    if (campo in rascunho && Boolean(rascunho[campo]) !== Boolean(lerCampoDoCanal(canal, campo))) {
      alteracoes[campo] = Boolean(rascunho[campo]);
    }
  }
  if ('mensagemChamada' in rascunho && mensagemLimpa !== String(canal.config?.mensagemChamada ?? '').trim()) {
    alteracoes.mensagemChamada = mensagemLimpa;
  }

  const mudou = Object.keys(alteracoes).length > 0;
  // A mensagem so precisa ser valida quando vai ser usada (ou esta sendo alterada).
  const bloqueado = ('mensagemChamada' in alteracoes || (precisaMensagem && 'rejeitarChamadas' in alteracoes)) && !mensagemValida;

  function gravar(e) {
    e.preventDefault();
    if (!mudou || bloqueado || salvar.isPending) return;
    salvar.mutate(alteracoes, { onSuccess: () => setRascunho({}) });
  }

  return (
    <Cartao titulo="Preferências do número">
      <form className="cx-config" onSubmit={gravar}>
        {ehDev && <NomeEditavel canal={canal} />}

        {INTERRUPTORES.map(({ campo, rotulo, descricao }) => (
          <div className="cx-config__item" key={campo}>
            <Interruptor
              rotulo={rotulo}
              descricao={descricao}
              ligado={Boolean(valorDe(campo))}
              ocupado={salvar.isPending}
              aoAlternar={(novo) => setRascunho((r) => ({ ...r, [campo]: novo }))}
            />

            {campo === 'rejeitarChamadas' && Boolean(valorDe(campo)) && (
              <MensagemDeChamada
                texto={mensagem}
                valida={mensagemValida}
                editando={'mensagemChamada' in rascunho}
                ocupado={salvar.isPending}
                aoMudar={(t) => setRascunho((r) => ({ ...r, mensagemChamada: t }))}
              />
            )}
          </div>
        ))}

        {salvar.isError && (
          <p className="campo__erro" role="alert">
            {salvar.error.message}
          </p>
        )}

        {/* Sem nada mudado, a barra e so a regiao viva (vazia ou "salvo"): um
            botao desabilitado ali so ocupava espaco. Mudou, ela acende. */}
        <div className={`cx-salvar${mudou || salvar.isPending ? ' cx-salvar--pendente' : ''}`}>
          <span className="cx-salvo crescer" role="status">
            {salvar.isSuccess && !mudou ? '✓ Preferências salvas.' : mudou ? 'Você tem alterações não salvas.' : ''}
          </span>
          {(mudou || salvar.isPending) && (
            <>
              {!salvar.isPending && (
                <Botao type="button" variante="fantasma" tamanho="sm" onClick={() => setRascunho({})}>
                  Descartar
                </Botao>
              )}
              <Botao type="submit" tamanho="sm" carregando={salvar.isPending} disabled={bloqueado || salvar.isPending}>
                Salvar
              </Botao>
            </>
          )}
        </div>
      </form>
    </Cartao>
  );
}

function NomeEditavel({ canal }) {
  const id = useId();
  const salvar = useAtualizarSessao(canal.chave);

  // `null` = "a pessoa ainda nao mexeu".
  const [rascunho, setRascunho] = useState(null);

  const texto = rascunho ?? canal.nome;
  const limpo = texto.trim();
  const valido = limpo.length >= NOME_MIN && limpo.length <= NOME_MAX;
  const mudou = limpo !== canal.nome;
  const editando = rascunho !== null;

  function salvarNome() {
    if (!valido || !mudou || salvar.isPending) return;
    salvar.mutate({ nome: limpo }, { onSuccess: () => setRascunho(null) });
  }

  return (
    <div className="cx-nome">
      <label htmlFor={id} className="campo__rotulo">
        Nome do número (aparece para a equipe)
      </label>
      <div className="cx-nome__linha">
        <Entrada
          id={id}
          value={texto}
          maxLength={NOME_MAX}
          erro={editando && !valido}
          readOnly={salvar.isPending}
          onChange={(e) => setRascunho(e.target.value)}
          onKeyDown={(e) => {
            // Enter aqui salva SO o nome (o formulario grande grava as preferencias).
            if (e.key === 'Enter') {
              e.preventDefault();
              salvarNome();
            }
          }}
        />
        <Botao type="button" variante="secundario" carregando={salvar.isPending} disabled={!valido || !mudou || salvar.isPending} onClick={salvarNome}>
          Salvar nome
        </Botao>
      </div>

      {editando && !valido && (
        <p className="campo__erro" role="alert">
          Dê um nome com pelo menos {NOME_MIN} caracteres.
        </p>
      )}
      {salvar.isError && (
        <p className="campo__erro" role="alert">
          {salvar.error.message}
        </p>
      )}
      {salvar.isSuccess && !editando && (
        <p className="cx-salvo" role="status">
          Nome salvo.
        </p>
      )}
    </div>
  );
}

function MensagemDeChamada({ texto, valida, editando, ocupado, aoMudar }) {
  const id = useId();
  const idContador = `${id}-contador`;

  return (
    <div className="cx-mensagem">
      <label htmlFor={id} className="campo__rotulo">
        Mensagem enviada a quem ligou
      </label>
      <AreaTexto
        id={id}
        rows={3}
        value={texto}
        maxLength={MENSAGEM_MAX}
        erro={editando && !valida}
        readOnly={ocupado}
        aria-describedby={idContador}
        onChange={(e) => aoMudar(e.target.value)}
      />
      {/* Mostra o motivo por escrito: nao depende so da cor vermelha. */}
      <span id={idContador} className={`cx-contador ${editando && !valida ? 'cx-contador--erro' : ''}`}>
        {texto.length}/{MENSAGEM_MAX} caracteres
        {editando && !valida ? ` — escreva pelo menos ${MENSAGEM_MIN}` : ''}
      </span>
    </div>
  );
}
