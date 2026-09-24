import ffmpeg from 'fluent-ffmpeg';
import ffmpegBin from 'ffmpeg-static';
import { PassThrough } from 'node:stream';

/**
 * Conversao de audio: navegador -> mensagem de voz do WhatsApp.
 *
 * O microfone do navegador grava em `webm/opus` (Chrome e Edge — Firefox grava
 * ogg/opus direto, mas o Windows do dono roda Chrome). O WhatsApp so desenha a
 * "bolha de microfone" com onda sonora (`ptt`, push-to-talk) para audio
 * `ogg/opus` de verdade; mandar webm chega como anexo generico, ou nem toca,
 * dependendo do aparelho do cliente.
 *
 * A boa noticia: os dois formatos carregam o MESMO codec (Opus), so o
 * "envelope" (container) e diferente — como trocar o CD de caixa sem regravar
 * a musica. Por isso a conversao aqui e um REMUX (`-c:a copy`), nao uma
 * recodificacao: e quase instantaneo e nao perde qualidade nenhuma.
 *
 * `ffmpeg-static` empacota o binario do ffmpeg dentro do pacote do npm — quem
 * clona o projeto e roda `npm install` ja tem tudo, sem instalar nada a parte
 * no sistema operacional.
 */

ffmpeg.setFfmpegPath(ffmpegBin);

/** Teto de tempo para a conversao. Um audio de WhatsApp e curto; travar disso e sinal de arquivo corrompido. */
const TIMEOUT_MS = 15_000;

/**
 * Converte um audio (o que o `MediaRecorder` do navegador gravou) para
 * `ogg/opus`, pronto para o Baileys mandar como mensagem de voz.
 *
 * @param {Buffer} bytes
 * @returns {Promise<Buffer>}
 * @throws  quando o ffmpeg falha (arquivo corrompido, vazio, sem audio)
 */
export function paraOggOpus(bytes) {
  return new Promise((resolve, reject) => {
    const entrada = new PassThrough();
    entrada.end(bytes);

    const pedacos = [];
    const saida = new PassThrough();
    saida.on('data', (p) => pedacos.push(p));

    const prazo = setTimeout(() => {
      comando.kill('SIGKILL');
      reject(new Error('Conversao de audio demorou demais.'));
    }, TIMEOUT_MS);
    prazo.unref?.();

    const comando = ffmpeg(entrada)
      .audioCodec('copy') // remux: mesmo codec Opus, so troca o container
      .format('ogg')
      .on('error', (err) => {
        clearTimeout(prazo);
        reject(new Error(`Nao foi possivel converter o audio: ${err.message}`));
      })
      .on('end', () => {
        clearTimeout(prazo);
        resolve(Buffer.concat(pedacos));
      });

    comando.pipe(saida, { end: true });
  });
}
