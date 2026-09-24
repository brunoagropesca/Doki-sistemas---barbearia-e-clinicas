import { useEffect, useRef, useState } from 'react';
import { formatar } from './BalaoAudio.jsx';

/**
 * Gravador de audio do atendente: o botao de microfone e, enquanto grava, a
 * barra que substitui o campo de texto.
 *
 * Fica num componente a parte (e nao dentro do formulario de `Conversas.jsx`)
 * porque o `MediaRecorder` tem ciclo de vida proprio — pedir o microfone,
 * gravar, soltar o microfone de volta — e misturar isso com o estado do
 * campo de texto deixaria as duas coisas dificeis de acompanhar.
 *
 * Fluxo: clique no microfone pede permissao e comeca a gravar. Enquanto grava,
 * um ponto vermelho pulsa e o tempo conta. **X** descarta; o botao de enviar
 * para a gravacao e entrega o audio pronto pra cima, em base64 (o mesmo
 * formato que `salvarImagem` ja usa no backend — sem multipart).
 */

/**
 * Formatos que o `MediaRecorder` sabe gravar, em ordem de preferencia.
 *
 * `webm/opus` e o que Chrome e Edge gravam (a Plataforma roda em Windows, e e
 * o navegador do guia de testes). O audio SAI desse formato; quem converte
 * para ogg/opus — o que o WhatsApp precisa para desenhar a bolha de voz — e o
 * servidor (`core/audio.js`), com ffmpeg.
 */
const FORMATOS = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

function formatoSuportado() {
  if (typeof MediaRecorder === 'undefined') return null;
  return FORMATOS.find((f) => MediaRecorder.isTypeSupported(f)) ?? null;
}

/** Blob -> data URL. O FileReader faz a base64 que o backend espera. */
function paraDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.onerror = () => reject(leitor.error);
    leitor.readAsDataURL(blob);
  });
}

/**
 * @param {object} p
 * @param {(dataUrl: string, duracaoSegundos: number) => void} p.aoGravar
 * @param {boolean} [p.desabilitado]      enquanto uma resposta anterior ainda esta enviando
 * @param {(gravando: boolean) => void} [p.aoAlternar]  avisa o formulario para esconder o campo de texto
 */
export function GravarAudio({ aoGravar, desabilitado, aoAlternar }) {
  const [gravando, setGravandoEstado] = useState(false);
  const [segundos, setSegundos] = useState(0);
  const [erro, setErro] = useState(null);

  // O campo de texto some enquanto se grava (nao da para escrever e gravar ao
  // mesmo tempo); o formulario que decide isso precisa saber do estado.
  function setGravando(valor) {
    setGravandoEstado(valor);
    aoAlternar?.(valor);
  }

  const gravadorRef = useRef(null);
  const pedacosRef = useRef([]);
  const trilhaRef = useRef(null);
  const cronometroRef = useRef(null);
  const inicioRef = useRef(0);

  // Solta o microfone se o componente sumir com a gravacao em andamento (o
  // atendente trocou de conversa no meio de uma gravacao).
  useEffect(() => () => pararTrilha(), []);

  function pararTrilha() {
    trilhaRef.current?.getTracks().forEach((t) => t.stop());
    trilhaRef.current = null;
    clearInterval(cronometroRef.current);
  }

  async function comecar() {
    setErro(null);

    const formato = formatoSuportado();
    if (!formato) {
      setErro('Este navegador não grava áudio. Tente pelo Chrome ou Edge.');
      return;
    }

    let trilha;
    try {
      trilha = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Negou a permissao, ou nao ha microfone — o navegador nao distingue os
      // dois casos no erro, entao a mensagem cobre ambos.
      setErro('Não consegui acessar o microfone. Verifique a permissão do navegador.');
      return;
    }

    trilhaRef.current = trilha;
    pedacosRef.current = [];

    const gravador = new MediaRecorder(trilha, { mimeType: formato });
    gravador.ondataavailable = (e) => e.data.size > 0 && pedacosRef.current.push(e.data);
    gravador.start();
    gravadorRef.current = gravador;

    inicioRef.current = Date.now();
    setSegundos(0);
    setGravando(true);
    cronometroRef.current = setInterval(() => {
      setSegundos((Date.now() - inicioRef.current) / 1000);
    }, 200);
  }

  /** Para o gravador e devolve o blob final — as duas acoes (enviar/cancelar) precisam disso. */
  function pararGravacao() {
    return new Promise((resolve) => {
      const gravador = gravadorRef.current;
      if (!gravador || gravador.state === 'inactive') {
        resolve(null);
        return;
      }
      gravador.onstop = () => resolve(new Blob(pedacosRef.current, { type: gravador.mimeType }));
      gravador.stop();
    });
  }

  async function cancelar() {
    await pararGravacao();
    pararTrilha();
    setGravando(false);
    setSegundos(0);
  }

  async function confirmar() {
    const duracaoSegundos = (Date.now() - inicioRef.current) / 1000;
    const blob = await pararGravacao();
    pararTrilha();
    setGravando(false);
    setSegundos(0);

    // Recado tao curto que provavelmente foi um toque sem querer no botao —
    // menos de meio segundo nao vira audio nenhum.
    if (!blob || duracaoSegundos < 0.5) return;

    const dataUrl = await paraDataUrl(blob);
    aoGravar(dataUrl, duracaoSegundos);
  }

  if (!gravando) {
    return (
      <>
        <button
          type="button"
          className="fio__mic"
          onClick={comecar}
          disabled={desabilitado}
          aria-label="Gravar um áudio"
          title="Gravar um áudio"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <rect x="9" y="2.5" width="6" height="12" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3.5" />
          </svg>
        </button>
        {erro && <span className="fio__mic-erro" role="alert">{erro}</span>}
      </>
    );
  }

  return (
    <div className="fio__gravando" role="status" aria-label="Gravando áudio">
      <button type="button" className="fio__gravando-cancelar" onClick={cancelar} aria-label="Cancelar gravação" title="Cancelar">
        <span aria-hidden="true">✕</span>
      </button>

      <span className="fio__gravando-ponto" aria-hidden="true" />
      <span className="fio__gravando-tempo">{formatar(segundos)}</span>
      <span className="fio__gravando-dica">Gravando…</span>

      <button
        type="button"
        className="fio__gravando-enviar"
        onClick={confirmar}
        disabled={desabilitado}
        aria-label="Enviar áudio"
        title="Enviar"
      >
        <span aria-hidden="true">➤</span>
      </button>
    </div>
  );
}
