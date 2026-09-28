import { execFileSync } from 'node:child_process';
import ffmpegBin from 'ffmpeg-static';

/**
 * Um audio webm/opus DE VERDADE, tocavel, para os testes de envio.
 *
 * Nao existe forma barata de fingir isto: o codigo em teste (`core/audio.js`)
 * chama o ffmpeg de verdade para remuxar — e um binario local, sem rede e sem
 * custo, entao rodar de verdade aqui e mais simples e mais honesto do que
 * simular a saida dele. Bytes que nao sao audio real fariam o teste do
 * caminho feliz cair no caminho de erro.
 *
 * Gerado uma vez por arquivo de teste (a geracao leva ~100ms) e reaproveitado.
 */
export function webmDeMentira({ segundos = 1, kbps } = {}) {
  // `kbps`: o Chrome grava a ~128; sem ele, vale o padrao do ffmpeg.
  const taxa = kbps ? ['-b:a', `${kbps}k`] : [];
  return execFileSync(
    ffmpegBin,
    ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${segundos}`, '-c:a', 'libopus', ...taxa, '-f', 'webm', 'pipe:1'],
    { maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
  );
}

/** A mesma coisa, ja como data URL — o formato que a rota de mensagens espera. */
export function audioDataUrl(opcoes) {
  return `data:audio/webm;codecs=opus;base64,${webmDeMentira(opcoes).toString('base64')}`;
}

/**
 * O que o Safari (iPhone e Mac) grava: `audio/mp4` com AAC dentro, em mp4
 * fragmentado (o `MediaRecorder` escreve enquanto grava). O remux sozinho nao
 * da conta deste — e o caso que era sempre recusado.
 */
export function mp4DoSafari({ segundos = 1 } = {}) {
  return execFileSync(
    ffmpegBin,
    ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${segundos}`, '-c:a', 'aac', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1'],
    { maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
  );
}
