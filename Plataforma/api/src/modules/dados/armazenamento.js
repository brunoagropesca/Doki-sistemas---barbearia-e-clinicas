import { existsSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { env } from '../../config/env.js';
import { pastaDeBackups, pastaDoCofre } from '../../db/restauracao.js';
import { PASTA_ARQUIVOS } from '../equipe/arquivos.js';
import { lerCopiaExterna } from './copia-externa.js';

/**
 * Quanto o sistema ocupa no disco, por categoria — para o dono ver num relance
 * se esta crescendo como esperado e se a copia externa esta em dia.
 *
 * A midia vem separada por ANO (o ano em que o arquivo foi gravado): e a mesma
 * divisao da regra de guardar midia de conversa por ano cheio.
 */

/** Uma copia externa com mais de 7 dias e um aviso em destaque na tela. */
export const DIAS_PARA_AVISAR_COPIA = 7;

function tamanho(caminho) {
  if (!existsSync(caminho)) return 0;
  const st = statSync(caminho);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const d of readdirSync(caminho, { withFileTypes: true })) total += tamanho(join(caminho, d.name));
  return total;
}

/** Bytes da midia (uploads) por ano de gravacao. */
function midiaPorAno() {
  const anos = new Map();
  const andar = (pasta) => {
    if (!existsSync(pasta)) return;
    for (const d of readdirSync(pasta, { withFileTypes: true })) {
      const c = join(pasta, d.name);
      if (d.isDirectory()) andar(c);
      else {
        const st = statSync(c);
        const ano = new Date(st.mtimeMs).getFullYear();
        const atual = anos.get(ano) ?? { ano, arquivos: 0, bytes: 0 };
        atual.arquivos += 1;
        atual.bytes += st.size;
        anos.set(ano, atual);
      }
    }
  };
  andar(PASTA_ARQUIVOS);
  return [...anos.values()].sort((a, b) => b.ano - a.ano);
}

/** Espaco livre no disco onde ficam os dados (null se o sistema nao informar). */
function livreNoDisco(pasta) {
  try {
    const s = statfsSync(pasta);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * @param {object} p
 * @param {string|null} p.ultimoBackupEm  ISO do backup mais recente
 */
export function usoDoDisco({ ultimoBackupEm = null, agora = Date.now() } = {}) {
  const banco = env.DATABASE_URL.startsWith('file:') ? resolve(env.DATABASE_URL.slice('file:'.length)) : null;
  const bancoBytes = banco ? ['', '-wal', '-shm'].reduce((t, s) => t + tamanho(banco + s), 0) : 0;
  const cofreBytes = tamanho(pastaDoCofre());
  const backupsBytes = Math.max(0, tamanho(pastaDeBackups()) - cofreBytes);
  const midia = midiaPorAno();
  const midiaBytes = midia.reduce((t, a) => t + a.bytes, 0);
  const whatsappBytes = tamanho(resolve(env.WHATSAPP_AUTH_DIR));

  const copia = lerCopiaExterna();
  const idadeCopiaDias = copia.ultimaCopiaEm ? (agora - new Date(copia.ultimaCopiaEm).getTime()) / 86_400_000 : null;

  return {
    categorias: [
      { chave: 'banco', rotulo: 'Banco de dados', bytes: bancoBytes },
      { chave: 'midia', rotulo: 'Fotos, áudios e anexos', bytes: midiaBytes },
      { chave: 'backups', rotulo: 'Backups (bancos)', bytes: backupsBytes },
      { chave: 'cofre', rotulo: 'Backups (fotos e áudios)', bytes: cofreBytes },
      { chave: 'whatsapp', rotulo: 'Sessões do WhatsApp', bytes: whatsappBytes }
    ],
    totalBytes: bancoBytes + midiaBytes + backupsBytes + cofreBytes + whatsappBytes,
    midiaPorAno: midia,
    // O disco onde estao os backups (o mesmo dos dados, no uso normal).
    livreNoDiscoBytes: livreNoDisco(existsSync(pastaDeBackups()) ? pastaDeBackups() : resolve('.')),
    ultimoBackupEm,
    copiaExterna: {
      pasta: copia.pasta ?? null,
      ultimaCopiaEm: copia.ultimaCopiaEm ?? null,
      ultimoErro: copia.ultimoErro ?? null,
      // Aviso: pasta configurada e sem copia ha mais de 7 dias (ou nunca), ou sem pasta nenhuma.
      atrasada: !copia.pasta || idadeCopiaDias === null || idadeCopiaDias > DIAS_PARA_AVISAR_COPIA
    }
  };
}
