import { spawn } from 'node:child_process';
import ffmpegBin from 'ffmpeg-static';

/**
 * Conversao de audio: navegador -> mensagem de voz do WhatsApp.
 *
 * O microfone do navegador grava em `webm/opus` (Chrome e Edge — Firefox grava
 * ogg/opus direto, mas o Windows do dono roda Chrome). O WhatsApp so desenha a
 * "bolha de microfone" com onda sonora (`ptt`, push-to-talk) para audio
 * `ogg/opus` de verdade; mandar webm chega como anexo generico, ou nem toca,
 * dependendo do aparelho do cliente.
 *
 * A conversao RECODIFICA para Opus mono a 32 kbit/s — o padrao da propria
 * mensagem de voz do WhatsApp. Antes era so um remux (trocar o "envelope" webm
 * pelo ogg, mesmo codec), mas o navegador grava a ~128 kbit/s: 4 s de fala
 * ocupavam 69 KB, contra ~17 KB de um audio de 7 s do WhatsApp. Para voz, 32
 * kbit/s mono soa igual, o arquivo fica ~4x menor (no disco, no backup e no
 * upload para o cliente) e o custo e ~0,2 s por audio curto. O remux ficou de
 * reserva, se a recodificacao falhar.
 *
 * `ffmpeg-static` empacota o binario do ffmpeg dentro do pacote do npm — quem
 * clona o projeto e roda `npm install` ja tem tudo, sem instalar nada a parte
 * no sistema operacional.
 *
 * O ffmpeg e chamado DIRETO (antes era pelo `fluent-ffmpeg`). A biblioteca
 * avisava "terminou" quando o processo saia, antes de a saida chegar inteira:
 * num teste com 60 audios ao mesmo tempo, 15 sairam CORTADOS pela metade
 * (dados como sucesso) e 27 falharam com "Output stream closed". Aqui o
 * resultado so vale no evento `close` do processo — que so acontece depois de
 * a saida ter sido lida ate o fim.
 */

/** Teto de tempo para a conversao. Um audio de WhatsApp e curto; travar disso e sinal de arquivo corrompido. */
const TIMEOUT_MS = 15_000;

/**
 * Converte um audio (o que o `MediaRecorder` do navegador gravou) para
 * `ogg/opus`, pronto para o Baileys mandar como mensagem de voz.
 *
 * Sempre RECODIFICA para Opus mono 32 kbit/s (o tamanho da mensagem de voz do
 * WhatsApp). Serve para todos os navegadores: Chrome/Edge/Firefox gravam Opus
 * a ~128 kbit/s, e o Safari (iPhone e Mac) grava `audio/mp4` com AAC.
 * Se a recodificacao falhar, tenta o REMUX (so troca o envelope) — o audio
 * sai maior, mas sai.
 *
 * @param {Buffer} bytes
 * @returns {Promise<Buffer>}
 * @throws  quando o ffmpeg falha nas duas formas (arquivo corrompido, vazio, sem audio)
 */
export async function paraOggOpus(bytes) {
  try {
    return await rodarFfmpeg(bytes, ARGS_VOZ_WHATSAPP);
  } catch (errRecodificar) {
    try {
      return await rodarFfmpeg(bytes, ['-c:a', 'copy']);
    } catch (errRemux) {
      throw new Error(`Nao foi possivel converter o audio: ${errRecodificar.message}`, { cause: errRemux });
    }
  }
}

/** Opus mono, 32 kbit/s, 48 kHz: o que o proprio WhatsApp usa em mensagem de voz. */
const ARGS_VOZ_WHATSAPP = ['-c:a', 'libopus', '-ac', '1', '-b:a', '32k', '-ar', '48000'];

/** Uma passada do ffmpeg: bytes na entrada (stdin), ogg na saida (stdout), com prazo. */
function rodarFfmpeg(bytes, argsDoAudio) {
  return new Promise((resolve, reject) => {
    const processo = spawn(
      ffmpegBin,
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', ...argsDoAudio, '-f', 'ogg', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );

    const saida = [];
    const erros = [];
    processo.stdout.on('data', (p) => saida.push(p));
    processo.stderr.on('data', (p) => erros.push(p));
    // O ffmpeg desiste cedo de um arquivo invalido e fecha a entrada no meio da
    // escrita (EPIPE). Stream sem ouvinte de 'error' derrubaria o servidor; o
    // motivo de verdade chega pelo codigo de saida, logo abaixo.
    processo.stdin.on('error', () => {});
    processo.stdout.on('error', () => {});
    processo.stderr.on('error', () => {});

    let terminou = false;
    const fim = (err, valor) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(prazo);
      if (err) reject(err);
      else resolve(valor);
    };

    const prazo = setTimeout(() => {
      processo.kill('SIGKILL');
      fim(new Error('Conversao de audio demorou demais.'));
    }, TIMEOUT_MS);
    prazo.unref?.();

    // Binario ausente ou sem permissao (npm install incompleto).
    processo.on('error', (err) => fim(new Error(`ffmpeg nao iniciou: ${err.message}`)));

    // 'close' (e nao 'exit'): so dispara depois de stdout/stderr lidos ate o fim.
    processo.on('close', (codigo) => {
      const ogg = Buffer.concat(saida);
      if (codigo === 0 && ogg.length > 0) return fim(null, ogg);
      const motivo = Buffer.concat(erros).toString('utf8').trim().split(/\r?\n/).slice(-2).join(' ');
      fim(new Error(motivo || (codigo === 0 ? 'A conversao nao gerou audio.' : `ffmpeg saiu com codigo ${codigo}`)));
    });

    processo.stdin.end(bytes);
  });
}
