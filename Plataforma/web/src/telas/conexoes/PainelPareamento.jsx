import { useId, useRef, useState } from 'react';
import { Aviso, Botao, Cartao } from '../../componentes/ui.jsx';
import { Confirmacao } from './Confirmacao.jsx';
import { PainelQr } from './PainelQr.jsx';
import { estadoDaSessao, formatarDataHora, formatarTelefone } from './formatar.js';
import { useAcaoCanal } from './hooks.js';

/**
 * Cartao "Conexão": o que a pessoa precisa fazer AGORA com esta sessao.
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
        <p className="cx-pareamento__texto">
          {estado.chave === 'erro' ? 'A conexão falhou. Você pode tentar de novo. ' : 'Esta sessão não está conectada. '}
          Clique em Conectar para ligar o número: se a sessão ainda estiver salva ele volta sozinho; se não, vai aparecer um
          QR Code para ler.
        </p>
        <div className="linha">
          <Botao type="button" carregando={ocupado} disabled={ocupado} onClick={conectar}>
            Conectar
          </Botao>
        </div>
      </>
    );
  }

  return (
    <Cartao titulo="Pareamento por QR Code">
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
    </Cartao>
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

  const telefone = formatarTelefone(canal.identificador);

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
          <p className="cx-conectado__titulo">{canal.nomePerfil || 'WhatsApp conectado'}</p>
          {telefone && <p className="cx-conectado__numero">{telefone}</p>}
          {canal.conectadoEm && <p className="texto-fraco">Conectado desde {formatarDataHora(canal.conectadoEm)}</p>}
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
