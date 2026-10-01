/**
 * As dependencias de uma pasta (api ou web) estao instaladas e EM DIA com o
 * package-lock.json?  Sai com 0 se sim, 1 se e preciso instalar (npm ci).
 *
 * Uso (pelo INICIAR.bat):  node dependencias.mjs api
 *
 * Antes o INICIAR.bat so instalava quando a pasta node_modules NAO existia. Numa
 * instalacao que ja existia, uma atualizacao que trouxesse uma dependencia nova
 * (ex.: o @fastify/static do modo loja) nao instalava nada — e a API nao subia.
 *
 * Compara o CONTEUDO, nao a data: um `git pull` muda a data do lock mesmo sem
 * mudar nada. O npm registra o que instalou em node_modules/.package-lock.json;
 * se alguma versao do lock nao bate com a instalada, e preciso instalar.
 * Pacotes opcionais de outro sistema (ex.: o libsql do Mac) nunca sao
 * instalados aqui e nao contam.
 *
 * Sem dependencias: so o Node.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pasta = resolve(dirname(fileURLToPath(import.meta.url)), process.argv[2] ?? '.');
const lerJson = (caminho) => JSON.parse(readFileSync(caminho, 'utf8'));

function emDia() {
  const lock = join(pasta, 'package-lock.json');
  const instalado = join(pasta, 'node_modules', '.package-lock.json');
  if (!existsSync(join(pasta, 'node_modules')) || !existsSync(instalado)) return false;
  if (!existsSync(lock)) return true; // sem lock nao ha com o que comparar

  const esperado = lerJson(lock).packages ?? {};
  const tem = lerJson(instalado).packages ?? {};
  for (const [caminho, pacote] of Object.entries(esperado)) {
    if (caminho === '') continue; // o proprio projeto
    if (!tem[caminho]) {
      if (pacote.optional) continue; // opcional de outra plataforma: nao instala aqui
      return false;
    }
    if (tem[caminho].version !== pacote.version) return false;
  }
  return true;
}

try {
  process.exit(emDia() ? 0 : 1);
} catch {
  process.exit(1); // lock ilegivel: instalar de novo e o caminho seguro
}
