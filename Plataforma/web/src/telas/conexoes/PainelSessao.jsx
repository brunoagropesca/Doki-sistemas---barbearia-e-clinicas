import { EtiquetaSessao } from './EstadoSessao.jsx';
import { ControlesDev } from './ControlesDev.jsx';
import { PainelPareamento } from './PainelPareamento.jsx';
import { Preferencias } from './Preferencias.jsx';
import { estadoDaSessao } from './formatar.js';

/** Frase de apoio sob o nome da sessao, conforme o estado. */
const SUBTITULO = {
  desativada: 'Sessão desativada',
  desconectado: 'Pronto para conexão via QR Code',
  erro: 'A conexão falhou; tente conectar de novo',
  conectando: 'Iniciando a conexão…',
  aguardando_qr: 'Aguardando a leitura do QR Code',
  conectado: 'Conectada e recebendo mensagens'
};

/**
 * Tudo sobre UMA sessao: cabecalho, pareamento (QR), preferencias e, para o
 * perfil tecnico, os controles de ativar/remover.
 *
 * `key={canal.chave}` no chamador garante que os rascunhos dos formularios
 * nao vazam de uma sessao para outra ao trocar de selecao.
 */
export function PainelSessao({ canal, ehDev, aoRemovida }) {
  const estado = estadoDaSessao(canal);

  return (
    <section className="cx-painel" aria-label={`Sessão ${canal.chave}`}>
      <header className="cx-painel__topo">
        <span className="cx-painel__chave">{canal.chave}</span>
        <div className="crescer">
          <h2 className="cx-painel__nome">{canal.nome}</h2>
          <p className="texto-fraco">{SUBTITULO[estado.chave] ?? ''}</p>
        </div>
        <EtiquetaSessao canal={canal} />
      </header>

      <div className="cx-painel__grade">
        <PainelPareamento canal={canal} ehDev={ehDev} />
        <Preferencias canal={canal} ehDev={ehDev} />
      </div>

      {ehDev && <ControlesDev canal={canal} aoRemovida={aoRemovida} />}
    </section>
  );
}
