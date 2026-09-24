import { useEffect, useRef, useState } from 'react';

/**
 * Recado de voz dentro do balao da conversa.
 *
 * Player PROPRIO, e nao a tag `<audio controls>` do navegador: cada navegador
 * desenha os controles de um jeito (e o Chrome desenha uma barra cinza clara
 * que some dentro do balao escuro). Com um player nosso, o recado tem a mesma
 * cara em qualquer lugar e usa as cores do sistema.
 *
 * A transcricao fica ESCONDIDA atras de "Ver transcricao". A conversa se le
 * pelo que foi dito, e um paragrafo de texto aberto em cada audio faria o fio
 * virar um muro — mas ela precisa estar a um clique, porque e ela que o
 * atendente usa para entender o pedido sem precisar ouvir.
 */
export function BalaoAudio({ url, transcricao, duracaoSegundos }) {
  const audioRef = useRef(null);
  const [tocando, setTocando] = useState(false);
  const [posicao, setPosicao] = useState(0);
  const [verTranscricao, setVerTranscricao] = useState(false);

  /**
   * Duracao: a que o WhatsApp informou vale desde o primeiro quadro; a do
   * arquivo so chega depois que o navegador le o cabecalho. Comecar pela do
   * canal evita a barra nascer com "0:00" e pular quando o arquivo carrega.
   */
  const [duracao, setDuracao] = useState(duracaoSegundos ?? 0);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const aoTocar = () => setTocando(true);
    const aoParar = () => setTocando(false);
    const aoAndar = () => setPosicao(el.currentTime);
    const aoTerminar = () => {
      setTocando(false);
      setPosicao(0);
      // Volta ao inicio: o proximo clique toca de novo em vez de nao fazer nada.
      el.currentTime = 0;
    };
    const aoCarregar = () => {
      // Audio de WhatsApp (ogg/opus) as vezes chega com duracao `Infinity` ate
      // o arquivo inteiro ser lido. Nesse caso ficamos com a do canal.
      if (Number.isFinite(el.duration) && el.duration > 0) setDuracao(el.duration);
    };

    el.addEventListener('play', aoTocar);
    el.addEventListener('pause', aoParar);
    el.addEventListener('timeupdate', aoAndar);
    el.addEventListener('ended', aoTerminar);
    el.addEventListener('loadedmetadata', aoCarregar);
    el.addEventListener('durationchange', aoCarregar);

    return () => {
      el.removeEventListener('play', aoTocar);
      el.removeEventListener('pause', aoParar);
      el.removeEventListener('timeupdate', aoAndar);
      el.removeEventListener('ended', aoTerminar);
      el.removeEventListener('loadedmetadata', aoCarregar);
      el.removeEventListener('durationchange', aoCarregar);
    };
  }, []);

  function alternar() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      // Tocar pode ser recusado (politica de autoplay, arquivo sumiu): sem o
      // catch isso viraria "promise rejeitada" no console do navegador.
      el.play().catch(() => setTocando(false));
    } else {
      el.pause();
    }
  }

  function arrastar(evento) {
    const el = audioRef.current;
    const segundo = Number(evento.target.value);
    setPosicao(segundo);
    if (el && Number.isFinite(segundo)) el.currentTime = segundo;
  }

  const fim = duracao > 0 ? duracao : 0;
  // Enquanto toca, mostra quanto ja andou; parado, mostra o tamanho do recado.
  const relogio = tocando || posicao > 0 ? posicao : fim;
  const progresso = fim > 0 ? Math.min(100, (posicao / fim) * 100) : 0;

  return (
    <div className="audio">
      <div className="audio__player">
        <button
          type="button"
          className="audio__botao"
          onClick={alternar}
          aria-label={tocando ? 'Pausar o áudio' : 'Tocar o áudio'}
        >
          <span aria-hidden="true">{tocando ? '❚❚' : '▶'}</span>
        </button>

        <input
          type="range"
          className="audio__barra"
          min="0"
          max={fim || 0}
          step="0.1"
          value={Math.min(posicao, fim || 0)}
          onChange={arrastar}
          // A barra ja tem o rotulo; o valor em segundos nao diz nada a quem
          // usa leitor de tela, entao anunciamos em minutos e segundos.
          aria-label="Posição do áudio"
          aria-valuetext={formatar(posicao)}
          style={{ '--progresso': `${progresso}%` }}
          disabled={!fim}
        />

        <span className="audio__tempo">{formatar(relogio)}</span>
      </div>

      {/* `preload="metadata"` busca so o cabecalho: a duracao aparece sem
          baixar o audio inteiro de cada conversa que o atendente abre. */}
      <audio ref={audioRef} src={url} preload="metadata" />

      {transcricao && (
        <div className="audio__transcricao">
          <button
            type="button"
            className="audio__link"
            onClick={() => setVerTranscricao((v) => !v)}
            aria-expanded={verTranscricao}
          >
            {verTranscricao ? 'Ocultar transcrição' : 'Ver transcrição'}
          </button>

          {verTranscricao && <p className="audio__texto">{transcricao}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * 73 -> "1:13". Segundos soltos nao dizem nada sobre o tamanho do recado.
 * Exportada porque `GravarAudio.jsx` usa o MESMO formato no cronometro de
 * quem esta gravando — o numero precisa ser identico nos dois lados do balao.
 */
export function formatar(segundos) {
  const total = Number.isFinite(segundos) && segundos > 0 ? Math.floor(segundos) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
