import { createInterface } from 'node:readline/promises';

/**
 * `npm run db:instalar` — o que o INICIAR.bat roda TODA vez, antes de subir.
 *
 *   - aplica as mudancas de estrutura do banco (migrations);
 *   - se ainda NAO ha empresa, pergunta o nome dela e o login do dono, cria
 *     tudo (db/instalar.js) e mostra a senha inicial uma vez so;
 *   - se ja ha empresa, nao pergunta nada.
 *
 * Decidir por "tem empresa?" (e nao por "o arquivo do banco existe?") e o que
 * torna isto seguro de repetir: uma instalacao interrompida no meio deixa um
 * banco sem empresa, e a proxima execucao simplesmente pergunta de novo.
 *
 * Sem terminal (instalacao automatizada), aceita argumentos:
 *   npm run db:instalar -- --empresa "Nome" [--dono login] [--nome "Nome do dono"]
 */

// Antes de carregar o resto (o logger le isto ao nascer): no INICIAR, so
// avisos e erros. As linhas de "aplicando migrations" nao interessam ao dono.
process.env.LOG_LEVEL = 'warn';

const { rodarMigrations } = await import('./migrate.js');
const { db, fecharBanco, inicializarBanco } = await import('./client.js');
const { instalar } = await import('./instalar.js');
const { usernameSchema } = await import('../modules/auth/auth.schemas.js');

const argumento = (nome) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/**
 * Uma conversa no terminal que NUNCA fica pendurada: se a entrada acabar (sem
 * terminal, ou respostas redirecionadas que terminaram), a pergunta falha com
 * uma mensagem clara em vez de esperar para sempre.
 */
function terminal() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const semResposta = () =>
    new Error('Sem respostas no terminal: rode com --empresa "Nome da empresa" [--dono login] [--nome "Nome do dono"].');

  // Fila de linhas: com respostas redirecionadas (`< arquivo`), o readline le
  // tudo de uma vez, e uma linha que chega antes da pergunta se perderia com
  // `rl.question`. Aqui ela espera a vez.
  const linhas = [];
  const esperando = [];
  let fechado = false;
  rl.on('line', (l) => {
    const quem = esperando.shift();
    if (!quem) return linhas.push(l);
    // Sem terminal nao ha eco do que foi "digitado": mostra, para o registro ficar legivel.
    if (!process.stdin.isTTY) process.stdout.write(`${l}\n`);
    quem.responder(l);
  });
  rl.on('close', () => {
    fechado = true;
    for (const quem of esperando.splice(0)) quem.falhar(semResposta());
  });

  return {
    perguntar(texto) {
      process.stdout.write(texto);
      if (linhas.length > 0) {
        const l = linhas.shift();
        // Sem terminal nao ha eco do que foi "digitado": mostra, para o registro ficar legivel.
        if (!process.stdin.isTTY) process.stdout.write(`${l}\n`);
        return Promise.resolve(l);
      }
      if (fechado) return Promise.reject(semResposta());
      return new Promise((responder, falhar) => esperando.push({ responder, falhar }));
    },
    fechar: () => rl.close()
  };
}

async function perguntar() {
  const empresa = argumento('empresa');
  if (empresa) return { empresa, dono: argumento('dono') ?? 'dono', nomeDono: argumento('nome') };

  const t = terminal();
  try {
    console.log('\n  Primeira instalacao: vamos criar a empresa e o acesso do dono.\n');
    let nome = '';
    while (nome.trim().length < 2) nome = await t.perguntar('  Nome da empresa: ');
    let dono = '';
    for (;;) {
      dono = ((await t.perguntar('  Usuario do dono [dono]: ')).trim() || 'dono').toLowerCase();
      if (usernameSchema.safeParse(dono).success) break;
      console.log('    Use pelo menos 3 letras ou numeros (pode ter ponto, hifen e underline).');
    }
    const nomeDono = (await t.perguntar('  Nome do dono [Dono]: ')).trim() || 'Dono';
    return { empresa: nome.trim(), dono, nomeDono };
  } finally {
    t.fechar();
  }
}

async function esperarEnter() {
  const t = terminal();
  try {
    await t.perguntar('  Depois de anotar, aperte ENTER para continuar...');
  } catch {
    // Sem terminal (instalacao automatizada): nao ha quem apertar ENTER.
  } finally {
    t.fechar();
  }
}

try {
  await rodarMigrations();
  await inicializarBanco();

  if (await db.query.tenants.findFirst()) {
    console.log('        Banco ja existe e esta atualizado.');
  } else {
    const r = await instalar(await perguntar());
    const linha = '='.repeat(62);
    console.log(`
  ${linha}
    INSTALACAO PRONTA: ${r.tenant.nome}

    Usuario do dono:  ${r.username}
    Senha inicial:    ${r.senha}

    ANOTE AGORA. Esta senha aparece so esta vez.
    No primeiro acesso o sistema pede para criar uma senha nova.
  ${linha}
`);
    await esperarEnter();
  }
} catch (err) {
  console.error(`\n  [ERRO] A instalacao nao foi concluida: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  try {
    fecharBanco();
  } catch {
    // ja fechado
  }
}
