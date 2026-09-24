import { Botao } from '../../componentes/ui.jsx';
import { formatarDuracao } from './formatar.js';
import { useAgora } from './hooks.js';

/**
 * QR Code para parear o WhatsApp.
 *
 * O codigo vence em poucos segundos e o SERVIDOR troca por um novo sozinho;
 * esta tela so mostra o que ele mandou e conta o tempo que falta.
 */

/**
 * Acima disto a contagem nao e confiavel: o relogio do computador esta muito
 * diferente do relogio do servidor (o vencimento vem em horario do servidor).
 * Melhor nao mostrar um numero absurdo do que assustar a pessoa.
 */
const LIMITE_DA_CONTAGEM_S = 120;

const PASSOS = [
  'Abra o WhatsApp no celular.',
  'Toque em Aparelhos conectados.',
  'Toque em Conectar um aparelho.',
  'Aponte a câmera para este código.'
];

export function PainelQr({ canal, aoCancelar, cancelando, desabilitado }) {
  // O relogio redesenha este painel a cada segundo. E barato (poucos
  // elementos, e o React nao mexe na imagem enquanto o texto dela nao muda).
  const agora = useAgora(1000);

  const restante = canal.qrExpiraEm ? Math.ceil((canal.qrExpiraEm - agora) / 1000) : null;
  const vencido = restante !== null && restante <= 0;
  const confiavel = restante !== null && restante <= LIMITE_DA_CONTAGEM_S;

  return (
    <div className="cx-qr">
      {/* Codigo vencido fica esmaecido: ninguem deve tentar ler um QR que nao vale mais. */}
      <div className={`cx-qr__imagem ${vencido ? 'cx-qr__imagem--vencido' : ''}`}>
        {canal.qrCode ? (
          <img
            src={canal.qrCode}
            width={260}
            height={260}
            alt={`QR Code para conectar o WhatsApp da sessão ${canal.chave}, ${canal.nome}. Leia com a câmera do WhatsApp no celular.`}
          />
        ) : (
          // O estado ja e "aguardando QR", mas a imagem ainda nao chegou.
          <div className="cx-qr__espera">
            <span className="carregando__girando" aria-hidden="true" />
            <span>Preparando o código…</span>
          </div>
        )}
      </div>

      <div className="cx-qr__texto">
        <h3 className="cx-qr__titulo">Leia o código para conectar</h3>

        <ol className="cx-qr__passos">
          {PASSOS.map((passo) => (
            <li key={passo}>{passo}</li>
          ))}
        </ol>

        {restante !== null && (
          // `role="timer"` ja vem com aria-live desligado: o leitor de tela
          // nao le a contagem a cada segundo. So o vencimento e avisado (abaixo).
          <p className={`cx-qr__contagem ${vencido ? 'cx-qr__contagem--gerando' : ''}`} role="timer">
            {vencido ? (
              <>
                <span className="carregando__girando" aria-hidden="true" /> Gerando um novo código…
              </>
            ) : confiavel ? (
              `O código expira em ${formatarDuracao(restante)}`
            ) : (
              'O código expira em poucos instantes'
            )}
          </p>
        )}

        {/* Sempre presente, para o leitor de tela perceber a mudanca de texto. */}
        <span className="cx-so-leitor" role="status">
          {vencido ? 'O código venceu. Gerando um novo código.' : ''}
        </span>

        <div className="linha">
          <Botao type="button" variante="secundario" carregando={cancelando} disabled={desabilitado} onClick={aoCancelar}>
            Cancelar
          </Botao>
        </div>
      </div>
    </div>
  );
}
