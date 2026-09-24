import { Carregando, Cartao, Etiqueta } from '../componentes/ui.jsx';
import { AtivarSerial, CodigoDaInstalacao, useLicenca } from '../componentes/Licenca.jsx';

/**
 * Licenca — onde o dono cola o serial de cada mes (antes de vencer, para o
 * sistema nunca travar) e le o codigo da instalacao para o fornecedor.
 */

const dataBR = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');

const SITUACAO = {
  ativa: { tom: 'sucesso', texto: 'Ativa' },
  aviso: { tom: 'alerta', texto: 'Perto de vencer' },
  tolerancia: { tom: 'perigo', texto: 'Vencida (em tolerância)' },
  bloqueada: { tom: 'perigo', texto: 'Bloqueada' },
  sem_licenca: { tom: 'perigo', texto: 'Não ativada' },
  invalida: { tom: 'perigo', texto: 'Serial inválido' }
};

export function LicencaPagina() {
  const licenca = useLicenca();
  if (!licenca) return <Carregando />;

  const s = SITUACAO[licenca.situacao] ?? { tom: 'neutro', texto: licenca.situacao };

  return (
    <div className="coluna" style={{ maxWidth: 720 }}>
      <header>
        <h1>Licença</h1>
        <p className="texto-suave">
          A licença mantém o sistema e o atendimento automático funcionando. Quando receber o serial do mês, cole abaixo.
        </p>
      </header>

      <Cartao titulo="Situação">
        <div className="coluna" style={{ gap: 'var(--e2)' }}>
          <div>
            <Etiqueta tom={s.tom}>{s.texto}</Etiqueta>
          </div>
          {licenca.cliente && (
            <div>
              Cliente: <strong>{licenca.cliente}</strong>
            </div>
          )}
          {licenca.tipo === 'permanente' ? (
            <div>
              Tipo: <strong>Permanente</strong> — não vence.
            </div>
          ) : licenca.validoAte ? (
            <div>
              Válida até <strong>{dataBR(licenca.validoAte)}</strong>
              {licenca.diasRestantes >= 0 && ` (faltam ${licenca.diasRestantes} dias)`}. Depois disso, o sistema ainda
              funciona por 5 dias de tolerância e então é bloqueado.
            </div>
          ) : null}
          {licenca.relogioAtrasado && (
            <div className="texto-fraco">O relógio deste computador parece atrasado; a licença usa a data mais recente já vista.</div>
          )}
          <CodigoDaInstalacao codigo={licenca.codigoInstalacao} />
        </div>
      </Cartao>

      <Cartao titulo="Renovar">
        <AtivarSerial />
      </Cartao>
    </div>
  );
}
