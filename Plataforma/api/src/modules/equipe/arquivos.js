import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { RegraDeNegocio } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { db } from '../../db/client.js';
import { arquivos } from '../../db/schema/arquivos.js';

const log = comContexto({ modulo: 'arquivos' });

/**
 * Toda funcao de salvar EXIGE a empresa do arquivo: e ela que decide quem pode
 * abri-lo (GET /api/arquivos so entrega para a mesma empresa). Sem a empresa,
 * erro alto — e assim que um ponto de gravacao novo nao passa despercebido.
 */
function exigirEmpresa(tenantId) {
  if (!tenantId) throw new Error('Arquivo sem empresa: as funcoes de salvar exigem { tenantId }.');
}

/** Anota de quem e o arquivo (depois de gravado: se falhar, sobra um arquivo orfao, que a limpeza leva). */
async function registrar(nome, tenantId) {
  await db.insert(arquivos).values({ nome, tenantId }).onConflictDoNothing();
}

/** De que empresa e o arquivo (null = desconhecido: arquivo antigo que ninguem cita). */
export async function donoDoArquivo(nome) {
  const linha = await db.query.arquivos.findFirst({ where: eq(arquivos.nome, nome) });
  return linha?.tenantId ?? null;
}

/**
 * Guarda de fotos enviadas pela tela.
 *
 * A imagem chega como data URL no JSON (`data:image/png;base64,...`) e e
 * gravada como ARQUIVO; no banco fica so o caminho. Guardar a imagem dentro da
 * linha faria toda listagem de catalogo arrastar megabytes atraves do banco
 * para desenhar uma tabela de nome e preco.
 *
 * Nao usamos multipart de proposito: exigiria mais uma dependencia no servidor
 * para resolver um problema que o navegador ja resolve com FileReader.
 */

/** Pasta das fotos. Fica ao lado do banco, entao um backup leva as duas. */
const PASTA = resolve(process.env.PASTA_ARQUIVOS || 'data/uploads');

/** Exportada para o backup copiar os arquivos junto com o banco. */
export const PASTA_ARQUIVOS = PASTA;

/** So formatos que todo navegador desenha. SVG fica de fora: aceita script. */
const TIPOS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

/** Teto por imagem. Foto de celular moderna passa disso sem redimensionar. */
const LIMITE_BYTES = 3 * 1024 * 1024;

/**
 * Formatos de audio que o WhatsApp manda e que o navegador toca.
 *
 * O audio de gravacao do WhatsApp e sempre `audio/ogg; codecs=opus`. Os demais
 * aparecem quando a pessoa ENCAMINHA uma musica ou um audio salvo.
 */
const TIPOS_AUDIO = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm'
};

/** Teto por audio recebido. Recado de WhatsApp raramente passa de 1 MB. */
const LIMITE_AUDIO_BYTES = 16 * 1024 * 1024;

/**
 * Grava um audio recebido de um canal e devolve o caminho publico.
 *
 * Diferente de `salvarImagem`, aqui os bytes ja vem prontos (o Baileys baixa e
 * decifra o arquivo do WhatsApp) — nao ha data URL para desmontar.
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {string} mimetype   como o canal declarou, ex: 'audio/ogg; codecs=opus'
 * @param {{ tenantId: string }} empresa  de quem e o audio (obrigatorio)
 * @returns {Promise<{url: string, extensao: string, bytes: number}>}
 */
export async function salvarAudio(bytes, mimetype = 'audio/ogg', { tenantId } = {}) {
  exigirEmpresa(tenantId);
  const dados = Buffer.from(bytes ?? []);
  if (dados.length === 0) throw new RegraDeNegocio('O audio chegou vazio.');
  if (dados.length > LIMITE_AUDIO_BYTES) {
    throw new RegraDeNegocio(
      `Audio muito grande (${Math.round(dados.length / 1024 / 1024)} MB). O limite e ${LIMITE_AUDIO_BYTES / 1024 / 1024} MB.`
    );
  }

  // 'audio/ogg; codecs=opus' -> 'audio/ogg'. O parametro depois do ';' nao muda
  // a extensao e so atrapalharia a busca na tabela.
  const base = String(mimetype ?? '').split(';')[0].trim().toLowerCase();
  // Desconhecido vira `.ogg`: e o que o WhatsApp manda em 99% dos casos, e um
  // arquivo com extensao errada pelo menos TOCA (o navegador olha o conteudo).
  const extensao = TIPOS_AUDIO[base] ?? 'ogg';

  const nome = `audio-${randomUUID()}.${extensao}`;
  const destino = join(PASTA, nome);

  await mkdir(dirname(destino), { recursive: true });
  await writeFile(destino, dados);
  await registrar(nome, tenantId);

  log.debug({ nome, bytes: dados.length }, 'Audio gravado');
  return { url: `/api/arquivos/${nome}`, extensao, bytes: dados.length };
}

/**
 * Anexos que o atendente manda no livechat (foto, video, documento).
 *
 * A extensao do arquivo gravado sai SEMPRE destas tabelas, nunca do nome que
 * veio do navegador: e ela que decide o Content-Type ao servir o arquivo, e um
 * ".html" servido como pagina do nosso proprio dominio seria um script rodando
 * com a sessao de quem clicou.
 */
const ANEXOS_IMAGEM = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const ANEXOS_VIDEO = { 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov' };

/** Documento e reconhecido pela extensao do nome: o navegador costuma mandar tipo vazio ou generico. */
export const EXTENSOES_DOCUMENTO = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
  rar: 'application/vnd.rar'
};

/** Limite do proprio WhatsApp para foto e video enviados como midia. */
export const LIMITE_ANEXO_BYTES = 16 * 1024 * 1024;

/**
 * Grava um anexo do livechat e devolve o que a mensagem precisa guardar.
 *
 * @param {string} dataUrl       `data:<tipo>;base64,...`
 * @param {string} [nomeOriginal] so para exibir e para o WhatsApp mostrar ao cliente
 * @param {{ tenantId: string }} empresa  de quem e o anexo (obrigatorio)
 * @returns {Promise<{ tipo: 'imagem'|'video'|'documento', url: string, mimetype: string, bytes: number, nomeArquivo: string }>}
 */
export async function salvarAnexo(dataUrl, nomeOriginal = '', { tenantId } = {}) {
  exigirEmpresa(tenantId);
  const bruta = String(dataUrl ?? '').trim();
  const MARCADOR = ';base64,';
  const posicao = bruta.startsWith('data:') ? bruta.indexOf(MARCADOR) : -1;
  if (posicao === -1) throw new RegraDeNegocio('Arquivo invalido.');

  // 'data:video/mp4;codecs=...;base64,' -> 'video/mp4'
  const mimeInformado = bruta.slice(5, posicao).split(';')[0].trim().toLowerCase();
  const bytes = Buffer.from(bruta.slice(posicao + MARCADOR.length), 'base64');
  if (bytes.length === 0) throw new RegraDeNegocio('O arquivo chegou vazio.');
  if (bytes.length > LIMITE_ANEXO_BYTES) {
    throw new RegraDeNegocio(`Arquivo muito grande (${(bytes.length / 1024 / 1024).toFixed(1)} MB). O limite é 16 MB.`);
  }

  // Nome so para exibir: sem caminho e sem caracteres de controle.
  const nomeLimpo = String(nomeOriginal ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120);

  let tipo;
  let extensao;
  let mimetype = mimeInformado;

  if (ANEXOS_IMAGEM[mimeInformado]) {
    tipo = 'imagem';
    extensao = ANEXOS_IMAGEM[mimeInformado];
  } else if (ANEXOS_VIDEO[mimeInformado]) {
    tipo = 'video';
    extensao = ANEXOS_VIDEO[mimeInformado];
  } else {
    const extDoNome = nomeLimpo.includes('.') ? nomeLimpo.split('.').pop().toLowerCase() : '';
    if (!EXTENSOES_DOCUMENTO[extDoNome]) {
      throw new RegraDeNegocio(
        'Tipo de arquivo não aceito. Envie foto (PNG, JPG, WEBP, GIF), vídeo (MP4) ou documento (PDF, Word, Excel, PowerPoint, TXT, CSV, ZIP).'
      );
    }
    tipo = 'documento';
    extensao = extDoNome;
    mimetype = EXTENSOES_DOCUMENTO[extDoNome];
  }

  const nome = `anexo-${randomUUID()}.${extensao}`;
  const destino = join(PASTA, nome);
  await mkdir(dirname(destino), { recursive: true });
  await writeFile(destino, bytes);
  await registrar(nome, tenantId);

  log.debug({ nome, bytes: bytes.length, tipo }, 'Anexo gravado');
  return {
    tipo,
    url: `/api/arquivos/${nome}`,
    mimetype,
    bytes: bytes.length,
    nomeArquivo: nomeLimpo || `arquivo.${extensao}`
  };
}

/**
 * Grava uma data URL e devolve o caminho publico.
 *
 * @param {string} dataUrl  `data:image/png;base64,...`
 * @param {string} prefixo  'produto' | 'profissional' — so para o nome do arquivo
 * @param {{ tenantId: string }} empresa  de quem e a imagem (obrigatorio)
 * @returns {Promise<string>} caminho publico, ex: `/api/arquivos/produto-ab12.png`
 */
export async function salvarImagem(dataUrl, prefixo = 'foto', { tenantId } = {}) {
  exigirEmpresa(tenantId);
  const casou = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl ?? '').trim());
  if (!casou) {
    throw new RegraDeNegocio('Imagem invalida. Envie um arquivo PNG, JPG, WEBP ou GIF.');
  }

  const [, tipo, base64] = casou;
  const extensao = TIPOS[tipo.toLowerCase()];
  if (!extensao) {
    throw new RegraDeNegocio(`Formato de imagem nao aceito (${tipo}). Use PNG, JPG, WEBP ou GIF.`);
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new RegraDeNegocio('A imagem chegou vazia.');
  if (bytes.length > LIMITE_BYTES) {
    throw new RegraDeNegocio(
      `Imagem muito grande (${Math.round(bytes.length / 1024 / 1024)} MB). O limite e 3 MB.`
    );
  }

  // O nome e sorteado, nunca vem do cliente: nome de arquivo enviado por fora
  // e o caminho classico para escrever onde nao devia.
  const nome = `${prefixo}-${randomUUID()}.${extensao}`;
  const destino = join(PASTA, nome);

  await mkdir(dirname(destino), { recursive: true });
  await writeFile(destino, bytes);
  await registrar(nome, tenantId);

  log.debug({ nome, bytes: bytes.length }, 'Imagem gravada');
  return `/api/arquivos/${nome}`;
}

/**
 * Caminho em disco de um arquivo publico, ou null se o nome for suspeito.
 *
 * A checagem de prefixo e o que impede `../../.env` de virar download: depois
 * de normalizar, o caminho TEM que continuar dentro da pasta de uploads.
 */
export function caminhoDe(nome) {
  if (!nome || nome.includes('\0')) return null;

  const destino = resolve(join(PASTA, normalize(nome)));
  if (destino !== PASTA && !destino.startsWith(PASTA + sep)) {
    log.warn({ nome }, 'Tentativa de ler arquivo fora da pasta publica');
    return null;
  }
  return destino;
}

/** Apaga a imagem antiga quando ela e trocada. Falhar aqui nunca e fatal. */
export async function apagarImagem(caminhoPublico) {
  const nome = String(caminhoPublico ?? '').replace('/api/arquivos/', '');
  const destino = caminhoDe(nome);
  if (!destino) return;

  try {
    await unlink(destino);
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn({ err, nome }, 'Nao foi possivel apagar a imagem antiga');
  }
  await db.delete(arquivos).where(eq(arquivos.nome, nome)).catch(() => {});
}

export const TIPOS_ACEITOS = TIPOS;
