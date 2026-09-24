import { ControlesDev } from './ControlesDev.jsx';
import { PainelPareamento } from './PainelPareamento.jsx';
import { Preferencias } from './Preferencias.jsx';

/**
 * Tudo sobre UMA sessao: a conexao (quem e, em que pe esta, o QR), as
 * preferencias e, para o perfil tecnico, os controles de ativar/remover.
 *
 * O nome, o numero e o estado moram no cartao da conexao — antes havia um
 * cabecalho so para eles, repetindo o que a lista e o resumo ja mostravam.
 *
 * `key={canal.chave}` no chamador garante que os rascunhos dos formularios
 * nao vazam de uma sessao para outra ao trocar de selecao.
 */
export function PainelSessao({ canal, ehDev, aoRemovida }) {
  return (
    <section className="cx-painel" aria-label={`Número ${canal.nome}`}>
      <div className="cx-painel__grade">
        <PainelPareamento canal={canal} ehDev={ehDev} />
        <Preferencias canal={canal} ehDev={ehDev} />
      </div>

      {ehDev && <ControlesDev canal={canal} aoRemovida={aoRemovida} />}
    </section>
  );
}
