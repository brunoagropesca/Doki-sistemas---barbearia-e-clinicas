import { Carregando } from '../componentes/ui.jsx';
import { AtivarSerial, CodigoDaInstalacao, ContatoFornecedor, useLicenca } from '../componentes/Licenca.jsx';
import './LicencaPagina.css';

/**
 * Licenca — onde o dono cola o serial de cada mes (antes de vencer, para o
 * sistema nunca travar) e le o codigo da instalacao para o fornecedor.
 *
 * Em cima, a situacao num relance (cor + quantos dias faltam); embaixo, o
 * caminho para renovar em 3 passos ao lado de com quem falar.
 */

const dataBR = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');

const SITUACAO = {
  ativa: { tom: 'ok', titulo: 'Licença ativa', icone: '✓' },
  aviso: { tom: 'alerta', titulo: 'Perto de vencer', icone: '!' },
  tolerancia: { tom: 'perigo', titulo: 'Vencida — em tolerância', icone: '!' },
  bloqueada: { tom: 'perigo', titulo: 'Sistema bloqueado', icone: '✕' },
  sem_licenca: { tom: 'perigo', titulo: 'Licença não ativada', icone: '✕' },
  invalida: { tom: 'perigo', titulo: 'Serial inválido', icone: '✕' }
};

/** Mensalidade: a barra mostra quanto do mes ainda resta. */
const DIAS_DO_CICLO = 30;

export function LicencaPagina() {
  const licenca = useLicenca();
  if (!licenca) return <Carregando />;

  const s = SITUACAO[licenca.situacao] ?? { tom: 'alerta', titulo: licenca.situacao, icone: '?' };
  const permanente = licenca.tipo === 'permanente';
  const dias = licenca.diasRestantes;
  const temPrazo = !permanente && licenca.validoAte && dias != null;
  const restante = temPrazo ? Math.max(0, Math.min(100, (dias / DIAS_DO_CICLO) * 100)) : 0;

  let detalhe;
  if (permanente) detalhe = 'Licença permanente — não vence.';
  else if (temPrazo && dias >= 0) detalhe = `Válida até ${dataBR(licenca.validoAte)} · faltam ${dias} dia${dias === 1 ? '' : 's'}`;
  else if (licenca.validoAte) detalhe = `Venceu em ${dataBR(licenca.validoAte)}`;
  else detalhe = 'Cole o serial recebido para liberar o sistema.';

  return (
    <div className="coluna lic">
      <header>
        <h1>Licença</h1>
        <p className="texto-suave">A licença mantém o sistema e o atendimento automático funcionando.</p>
      </header>

      <section className={`lic-situacao lic-situacao--${s.tom}`} aria-label="Situação da licença">
        <div className="lic-situacao__principal">
          <span className="lic-situacao__icone" aria-hidden="true">
            {s.icone}
          </span>
          <div className="lic-situacao__texto">
            <h2>{s.titulo}</h2>
            <p>{detalhe}</p>
            {licenca.cliente && (
              <p className="texto-fraco">
                Cliente: <strong>{licenca.cliente}</strong>
              </p>
            )}
          </div>
        </div>

        {temPrazo && dias >= 0 && (
          <div className="lic-situacao__prazo">
            <span className="lic-barra" role="progressbar" aria-valuenow={dias} aria-valuemin={0} aria-valuemax={DIAS_DO_CICLO} aria-label="Dias restantes">
              <span style={{ width: `${restante}%` }} />
            </span>
            <small className="texto-fraco">
              Depois do vencimento, o sistema ainda funciona por 5 dias de tolerância e então é bloqueado.
            </small>
          </div>
        )}
        {licenca.relogioAtrasado && (
          <small className="texto-fraco">
            O relógio deste computador parece atrasado; a licença usa a data mais recente já vista.
          </small>
        )}

        <CodigoDaInstalacao codigo={licenca.codigoInstalacao} />
      </section>

      <div className="lic-grade">
        <section className="lic-bloco">
          <h2>Renovar a licença</h2>
          <ol className="lic-passos">
            <li>
              <strong>Copie o código</strong> desta instalação (no quadro acima).
            </li>
            <li>
              <strong>Fale com a Doki Sistemas</strong> e envie o código — pelo WhatsApp ele já vai na mensagem.
            </li>
            <li>
              <strong>Cole o serial</strong> recebido aqui embaixo e clique em Ativar.
            </li>
          </ol>
          <AtivarSerial />
        </section>

        <section className="lic-bloco">
          <h2>Fale com a Doki Sistemas</h2>
          <p className="texto-suave">Renovação, serial, suporte e dúvidas.</p>
          <ContatoFornecedor codigo={licenca.codigoInstalacao} />
        </section>
      </div>
    </div>
  );
}
