import { useId, useRef, useState } from 'react';
import { Aviso, Botao } from '../../componentes/ui.jsx';
import { Confirmacao } from './Confirmacao.jsx';
import { EtiquetaSessao } from './EstadoSessao.jsx';
import { PainelQr } from './PainelQr.jsx';
import { estadoDaSessao, formatarDataHora, formatarTelefone } from './formatar.js';
import { useAcaoCanal } from './hooks.js';

/**
 * Cartao da conexao: QUEM e o numero (nome, telefone, estado) e o que a pessoa
 * precisa fazer AGORA com ele.
 *
 * Cada estado do servidor vira uma tela diferente:
 *  desativada -> so um aviso (ninguem conecta o que foi desligado de proposito)
 *  desconectado / erro -> botao Conectar
 *  conectando -> "Iniciando..."
 *  aguardando_qr -> QR Code + contagem
 *  conectado -> dados do numero + Desconectar / Sair da conta
 */

/**
 * Frase curta lida pelo leitor de tela quando o estado muda. O texto visivel
 * de cada estado e longo; anunciar so isto evita o leitor recitar a tela toda.
 */
const FRASE_DO_ESTADO = {
  desativada: 'Esta sessão está desativada.',
  desconectado: 'Sessão desconectada.',
  erro: 'A sessão está com erro.',
  conectando: 'Iniciando a conexão.',
  aguardando_qr: 'QR Code pronto para leitura.',
  conectado: 'Sessão conectada.'
};

/** Linha de apoio sob o nome, quando ainda nao ha numero para mostrar. */
const SUBTITULO = {
  desativada: 'Número desativado',
  desconectado: 'Nenhum número conectado',
  erro: 'A conexão falhou',
  conectando: 'Iniciando a conexão…',
  aguardando_qr: 'Esperando a leitura do QR Code',
  conectado: 'Recebendo mensagens'
};

export function PainelPareamento({ canal, ehDev }) {
  // Uma mutacao so para todos os botoes do cartao: so uma acao roda por vez.
  const acao = useAcaoCanal(canal.chave);
  const estado = estadoDaSessao(canal);
  const ocupado = acao.isPending;

  const conectar = () => acao.mutate({ rota: 'conectar' });
  // "Cancelar" e "Desconectar" sao a mesma chamada: desliga guardando a sessao.
  const desligarGuardandoSessao = () => acao.mutate({ rota: 'desconectar', corpo: { sair: false } });

  let conteudo;

  if (estado.chave === 'desativada') {
    conteudo = (
      <>
        <Aviso tom="alerta">Esta sessão está desativada.</Aviso>
        <p className="texto-fraco">
          {ehDev
            ? 'Use o interruptor “Sessão ativa”, mais abaixo, para colocá-la de volta no ar.'
            : 'Para reativá-la, fale com o suporte técnico.'}
        </p>
      </>
    );
  } else if (estado.chave === 'conectado') {
    conteudo = <CartaoConectado canal={canal} acao={acao} aoDesconectar={desligarGuardandoSessao} />;
  } else if (estado.chave === 'aguardando_qr') {
    conteudo = (
      <PainelQr canal={canal} aoCancelar={desligarGuardandoSessao} cancelando={ocupado} desabilitado={ocupado} />
    );
  } else if (estado.chave === 'conectando') {
    conteudo = (
      <div className="cx-iniciando">
        <p className="cx-iniciando__linha">
          <span className="carregando__girando" aria-hidden="true" />
          <span>Iniciando a conexão…</span>
        </p>
        <p className="texto-fraco">Isso costuma levar alguns segundos. O QR Code aparece aqui assim que estiver pronto.</p>
        {/* Sem isto, uma conexao que travasse em "conectando" deixaria a pessoa sem saida. */}
        <div className="linha">
          <Botao type="button" variante="secundario" carregando={ocupado} disabled={ocupado} onClick={desligarGuardandoSessao}>
            Cancelar
          </Botao>
        </div>
      </div>
    );
  } else {
    // desconectado ou com erro
    conteudo = (
      <>
        {canal.ultimoErro && <Aviso tom={estado.chave === 'erro' ? 'perigo' : 'alerta'}>{canal.ultimoErro}</Aviso>}
        <div className="cx-desligado">
          <span className="cx-desligado__icone" aria-hidden="true">
            <IconeQr />
          </span>
          <p className="cx-desligado__titulo">
            {estado.chave === 'erro' ? 'Tente conectar de novo' : 'Conecte o WhatsApp da empresa'}
          </p>
          <p className="texto-fraco">
            Se o número já foi conectado antes, ele volta sozinho. Se não, aparece um QR Code para ler com o celular.
          </p>
          <Botao type="button" carregando={ocupado} disabled={ocupado} onClick={conectar}>
            Conectar número
          </Botao>
        </div>
      </>
    );
  }

  const telefone = formatarTelefone(canal.identificador);

  return (
    <section className={`cartao cx-conexao cx-conexao--${estado.tom}`} aria-label="Conexão do número">
      <header className="cx-conexao__topo">
        <span className="cx-conexao__marca" aria-hidden="true">
          <IconeWhatsapp />
        </span>
        <div className="crescer">
          <h2 className="cx-conexao__nome">{canal.nome}</h2>
          <p className={`cx-conexao__apoio${telefone ? ' mono' : ''}`}>{telefone || SUBTITULO[estado.chave]}</p>
        </div>
        <EtiquetaSessao canal={canal} />
      </header>

      <div className="cx-conexao__corpo">
        {/* Persistente: o leitor de tela so percebe mudanca de texto em uma regiao que ja existia. */}
        <p className="cx-so-leitor" role="status">
          {FRASE_DO_ESTADO[estado.chave]}
        </p>

        {acao.isError && (
          <Aviso tom="perigo" aoFechar={acao.reset}>
            {acao.error.message}
          </Aviso>
        )}

        {conteudo}
      </div>
    </section>
  );
}

function IconeWhatsapp() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2c-1.5 0-3-.4-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.2.3-.9.9-.9 2.2s.9 2.5 1 2.7c.1.2 1.8 2.8 4.4 3.9 1.6.7 2.3.8 3.1.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3z" />
    </svg>
  );
}

function IconeQr() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" />
    </svg>
  );
}

/**
 * Sessao conectada. E um componente separado para a caixa de confirmacao
 * ("Sair da conta") nascer fechada toda vez que a sessao volta a este estado.
 */
function CartaoConectado({ canal, acao, aoDesconectar }) {
  const [confirmando, setConfirmando] = useState(false);
  const idDica = useId();
  const gatilhoRef = useRef(null);

  const ocupado = acao.isPending;
  const desconectando = ocupado && acao.variables?.corpo?.sair === false;
  const saindo = ocupado && acao.variables?.corpo?.sair === true;

  function cancelarSaida() {
    setConfirmando(false);
    // Devolve o foco ao botao que abriu a confirmacao; senao ele cai no topo da pagina.
    gatilhoRef.current?.focus();
  }

  function sairDaConta() {
    acao.mutate({ rota: 'desconectar', corpo: { sair: true } }, { onSuccess: () => setConfirmando(false) });
  }

  return (
    <div className="cx-conectado-bloco">
      <div className="cx-conectado">
        <span className="cx-conectado__icone" aria-hidden="true">
          ✓
        </span>
        <div className="crescer">
          <p className="cx-conectado__titulo">{canal.nomePerfil ? `Conectado como “${canal.nomePerfil}”` : 'WhatsApp conectado'}</p>
          {canal.conectadoEm && <p className="texto-fraco">Desde {formatarDataHora(canal.conectadoEm)}</p>}
        </div>
      </div>

      <div className="linha">
        <Botao
          type="button"
          variante="secundario"
          carregando={desconectando}
          disabled={ocupado}
          onClick={aoDesconectar}
          title="Desliga a conexão mas mantém a sessão salva: para voltar, basta conectar de novo, sem ler o QR Code."
          aria-describedby={idDica}
        >
          Desconectar
        </Botao>
        <Botao
          ref={gatilhoRef}
          type="button"
          variante="perigo"
          disabled={ocupado}
          aria-expanded={confirmando}
          onClick={() => setConfirmando(true)}
        >
          Sair da conta
        </Botao>
      </div>

      <p id={idDica} className="texto-fraco">
        “Desconectar” mantém a sessão salva: para voltar, basta conectar de novo, sem ler o QR Code. “Sair da conta”
        apaga a sessão deste número.
      </p>

      {confirmando && (
        <Confirmacao
          titulo="Sair da conta neste número?"
          rotuloConfirmar="Sim, sair da conta"
          aoConfirmar={sairDaConta}
          aoCancelar={cancelarSaida}
          carregando={saindo}
        >
          <p>
            O WhatsApp deste número será desconectado e a sessão será apagada. Para usar a sessão {canal.chave} de novo,
            será preciso ler o QR Code outra vez.
          </p>
        </Confirmacao>
      )}
    </div>
  );
}
