import { Aviso, Campo, Cartao, Entrada } from '../../componentes/ui.jsx';
import { Interruptor } from '../conexoes/Interruptor.jsx';
import { Grupo } from './EtapaIa.jsx';
import { duracao } from './comum.jsx';
import '../Conexoes.css';
import '../agenda/assistente.css';

/**
 * Etapa 5 — o ritmo do disparo.
 *
 * Tudo aqui existe para o disparo parecer uma pessoa mandando mensagem, e
 * nao um robo: intervalo que varia, horario comercial, teto por dia e o
 * "digitando..." antes de cada mensagem. Rajada de mensagens em sequencia e
 * a forma mais rapida de o WhatsApp bloquear o numero da empresa.
 *
 * O ritmo pode ser ajustado ate com o disparo andando: vale a partir da
 * proxima mensagem.
 */

export const ENVIO_PADRAO = {
  intervaloMinSegundos: 25,
  intervaloMaxSegundos: 70,
  limiteDiario: 150,
  janelaInicio: '09:00',
  janelaFim: '20:00',
  simularDigitacao: true
};

const PRESETS = [
  {
    nome: 'Cauteloso',
    dica: 'Número novo ou que já levou bloqueio',
    valores: { intervaloMinSegundos: 60, intervaloMaxSegundos: 150, limiteDiario: 80 }
  },
  {
    nome: 'Equilibrado',
    dica: 'Recomendado para a maioria',
    valores: { intervaloMinSegundos: 25, intervaloMaxSegundos: 70, limiteDiario: 150 }
  },
  {
    nome: 'Mais rápido',
    dica: 'Número antigo, com conversas frequentes',
    valores: { intervaloMinSegundos: 12, intervaloMaxSegundos: 35, limiteDiario: 250 }
  }
];

/**
 * Quanto o disparo vai levar, com o ritmo escolhido.
 *
 * Conta o intervalo medio, o "digitando..." (media de ~5s) e a janela de
 * horario: um publico de 400 com teto de 150/dia leva 3 dias, e a pessoa
 * precisa saber disso antes de clicar em iniciar.
 */
function estimar({ total, envio }) {
  const min = Number(envio.intervaloMinSegundos) || 0;
  const max = Number(envio.intervaloMaxSegundos) || 0;
  const porMensagem = (min + max) / 2 + (envio.simularDigitacao ? 5 : 0) + 1;

  const [hi, mi] = String(envio.janelaInicio).split(':').map(Number);
  const [hf, mf] = String(envio.janelaFim).split(':').map(Number);
  const janelaSeg = Math.max(0, (hf * 60 + mf - (hi * 60 + mi)) * 60);

  const cabemNaJanela = porMensagem > 0 ? Math.floor(janelaSeg / porMensagem) : 0;
  const porDia = Math.min(Number(envio.limiteDiario) || 0, cabemNaJanela);
  const dias = porDia > 0 ? Math.ceil(total / porDia) : Infinity;

  return {
    porHora: porMensagem > 0 ? Math.round(3600 / porMensagem) : 0,
    porDia,
    dias,
    duracaoSeg: dias <= 1 ? total * porMensagem : null
  };
}

export function EtapaEnvio({ campanha: c, envio, setEnvio, canal }) {
  const mudar = (campo, valor) => setEnvio((atual) => ({ ...atual, [campo]: valor }));
  const total = c.progresso.aprovadas;
  const est = estimar({ total, envio });
  const presetAtivo = PRESETS.find(
    (p) =>
      Number(envio.intervaloMinSegundos) === p.valores.intervaloMinSegundos &&
      Number(envio.intervaloMaxSegundos) === p.valores.intervaloMaxSegundos &&
      Number(envio.limiteDiario) === p.valores.limiteDiario
  );

  const intervaloInvalido = Number(envio.intervaloMaxSegundos) < Number(envio.intervaloMinSegundos);
  const intervaloArriscado = Number(envio.intervaloMinSegundos) < 10;
  const janelaInvalida = envio.janelaFim <= envio.janelaInicio;

  return (
    <div className="assist__duas">
      <Cartao titulo="Ritmo do disparo">
        <div className="assist__secao">
          <Grupo rotulo="Comece por um perfil">
            <div className="presets">
              {PRESETS.map((p) => (
                <button
                  key={p.nome}
                  type="button"
                  className={`filtro-chip ${presetAtivo?.nome === p.nome ? 'filtro-chip--ativo' : ''}`}
                  aria-pressed={presetAtivo?.nome === p.nome}
                  title={p.dica}
                  onClick={() => setEnvio((atual) => ({ ...atual, ...p.valores }))}
                >
                  {p.nome}
                </button>
              ))}
            </div>
          </Grupo>

          <div className="grade">
            <Campo
              rotulo="Intervalo mínimo (s)"
              erro={intervaloArriscado ? 'Menos de 10s entre envios é risco alto de bloqueio.' : null}
            >
              <Entrada
                type="number"
                min="10"
                max="900"
                value={envio.intervaloMinSegundos}
                onChange={(e) => mudar('intervaloMinSegundos', e.target.value)}
              />
            </Campo>
            <Campo rotulo="Intervalo máximo (s)" erro={intervaloInvalido ? 'Precisa ser maior ou igual ao mínimo.' : null}>
              <Entrada
                type="number"
                min="10"
                max="900"
                value={envio.intervaloMaxSegundos}
                onChange={(e) => mudar('intervaloMaxSegundos', e.target.value)}
              />
            </Campo>
            <Campo rotulo="Limite por dia" dica="Recomendado: até 150.">
              <Entrada
                type="number"
                min="1"
                max="500"
                value={envio.limiteDiario}
                onChange={(e) => mudar('limiteDiario', e.target.value)}
              />
            </Campo>
          </div>
          <p className="assist__ajuda">
            Entre uma mensagem e a próxima, o sistema sorteia uma espera entre o mínimo e o máximo, como uma pessoa que não
            manda tudo no mesmo ritmo.
          </p>

          <div className="grade">
            <Campo rotulo="Enviar a partir das" erro={janelaInvalida ? 'O fim precisa ser depois do início.' : null}>
              <Entrada type="time" value={envio.janelaInicio} onChange={(e) => mudar('janelaInicio', e.target.value)} />
            </Campo>
            <Campo rotulo="Até as">
              <Entrada type="time" value={envio.janelaFim} onChange={(e) => mudar('janelaFim', e.target.value)} />
            </Campo>
          </div>
          <p className="assist__ajuda">
            Fora desse horário a campanha espera sozinha e continua no dia seguinte, sem ninguém precisar retomar.
          </p>

          <Interruptor
            rotulo='Mostrar "digitando…" antes de cada mensagem'
            descricao="O cliente vê você digitando por alguns segundos, proporcional ao tamanho do texto, antes de a mensagem chegar."
            ligado={envio.simularDigitacao}
            aoAlternar={(v) => mudar('simularDigitacao', v)}
          />
        </div>
      </Cartao>

      <div className="coluna">
        <div className="estimativa" aria-live="polite">
          <div>
            <strong>{total}</strong>
            <span>mensagens aprovadas</span>
          </div>
          <div>
            <strong>~{est.porHora}</strong>
            <span>por hora</span>
          </div>
          <div>
            <strong>{est.porDia}</strong>
            <span>por dia, no máximo</span>
          </div>
          <div>
            <strong>
              {est.dias === Infinity ? '—' : est.duracaoSeg != null ? `~${duracao(est.duracaoSeg)}` : `~${est.dias} dias`}
            </strong>
            <span>para enviar tudo</span>
          </div>
        </div>

        <Cartao titulo="Resumo">
          <dl className="resumo" style={{ margin: 0 }}>
            <div>
              <dt>Campanha</dt>
              <dd>{c.nome}</dd>
            </div>
            <div>
              <dt>Sai pelo número</dt>
              <dd>{canal ? canal.nome : '—'}</dd>
            </div>
            <div>
              <dt>Público</dt>
              <dd>
                {total} de {c.totalAlvos} contato(s)
              </dd>
            </div>
          </dl>
        </Cartao>

        {canal && canal.status !== 'conectado' && (
          <Aviso tom="alerta">
            O número {canal.nome} está desconectado. Se iniciar agora, o disparo espera alguns minutos pela reconexão e depois
            pausa. Conecte em Conexões antes.
          </Aviso>
        )}
        <Aviso tom="info">
          Quando o cliente responde, a conversa aparece na mesa de atendimento com a mensagem da campanha, e a Sofia (ou a
          equipe) continua dali. Quem responder pedindo para parar não recebe mais campanhas.
        </Aviso>
      </div>
    </div>
  );
}
