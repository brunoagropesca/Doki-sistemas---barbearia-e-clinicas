import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, fecharBanco, inicializarBanco } from './client.js';
import { rodarMigrations } from './migrate.js';
import { tenants } from './schema/tenants.js';
import { gerarHashSenha } from '../core/crypto.js';
import { senhaSchema, usernameSchema } from '../modules/auth/auth.schemas.js';
import * as authRepo from '../modules/auth/auth.repo.js';

const nomeSchema = z.string().trim().min(2, 'Informe o nome.').max(120);

/**
 * Cria (ou redefine a senha de) o usuario DEV.
 *
 * O DEV e o perfil do desenvolvedor da plataforma: invisivel para a empresa,
 * usado para configurar o sistema — a primeira coisa que so ele faz e
 * adicionar e remover contas de WhatsApp. Por isso ele NAO pode ser criado
 * pela API nem pela tela (nenhum atendente, gerente ou dono consegue criar um):
 * nasce so por aqui, por quem tem acesso a maquina onde o sistema roda.
 *
 * Uso:   npm run usuario:dev            (pergunta o que faltar)
 *        CRIAR-DEV.bat                  (o mesmo, com duplo clique)
 */

/**
 * @param {object} p
 * @param {string} [p.empresa]  slug da empresa; dispensavel se houver uma so
 * @param {string} p.username
 * @param {string} p.nome
 * @param {string} p.senha
 * @returns {Promise<{ acao: 'criado'|'senha_redefinida', usuario: object, empresa: object }>}
 */
export async function garantirUsuarioDev({ empresa, username, nome, senha }) {
  const login = usernameSchema.parse(username);
  const senhaValida = senhaSchema.parse(senha);
  const nomeValido = nomeSchema.parse(nome);

  const alvo = await escolherEmpresa(empresa);

  const existente = await authRepo.buscarPorUsername(alvo.id, login);

  if (existente) {
    // Nunca mexe na senha de um usuario comum: quem roda este comando e o
    // DEV, e "redefinir" o dono da empresa por aqui seria tomar a conta dele.
    if (existente.cargo !== 'dev') {
      throw new Error(`O login "${login}" ja e de um usuario comum desta empresa. Escolha outro login para o DEV.`);
    }

    await authRepo.atualizarUsuario(existente.id, {
      passwordHash: await gerarHashSenha(senhaValida),
      nome: nomeValido,
      ativo: true
    });
    await authRepo.revogarTodasDoUsuario(existente.id);
    return { acao: 'senha_redefinida', usuario: existente, empresa: alvo };
  }

  const criado = await authRepo.criarUsuario({
    tenantId: alvo.id,
    username: login,
    nome: nomeValido,
    cargo: 'dev',
    // O DEV nao entra na fila de atendimento: nao e atendente.
    statusPresenca: 'offline',
    passwordHash: await gerarHashSenha(senhaValida)
  });

  return { acao: 'criado', usuario: criado, empresa: alvo };
}

async function escolherEmpresa(slug) {
  const todas = await db.select().from(tenants).where(eq(tenants.ativo, true));

  if (todas.length === 0) {
    throw new Error('Nenhuma empresa cadastrada. Rode o INICIAR.bat uma vez para criar a empresa de demonstracao.');
  }

  if (slug) {
    const achada = todas.find((t) => t.slug === String(slug).toLowerCase().trim());
    if (!achada) throw new Error(`Empresa "${slug}" nao encontrada. Empresas: ${todas.map((t) => t.slug).join(', ')}.`);
    return achada;
  }

  if (todas.length === 1) return todas[0];
  throw new Error(`Ha ${todas.length} empresas; informe qual com --empresa=<identificador>: ${todas.map((t) => t.slug).join(', ')}.`);
}

// ============================================================================
// Linha de comando
// ============================================================================

function lerArgumento(nome) {
  const prefixo = `--${nome}=`;
  const achado = process.argv.find((a) => a.startsWith(prefixo));
  return achado ? achado.slice(prefixo.length) : undefined;
}

function perguntar(texto, { oculto = false } = {}) {
  return new Promise((resolver) => {
    if (!oculto || !process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(texto, (resposta) => {
        rl.close();
        resolver(resposta.trim());
      });
      return;
    }

    // Digitacao oculta: a senha nao aparece na tela (nem fica no historico da janela).
    process.stdout.write(texto);
    const entrada = process.stdin;
    entrada.setRawMode(true);
    entrada.resume();
    entrada.setEncoding('utf8');

    let digitado = '';
    const aoDigitar = (trecho) => {
      for (const c of trecho) {
        if (c === '\r' || c === '\n') {
          entrada.setRawMode(false);
          entrada.pause();
          entrada.off('data', aoDigitar);
          process.stdout.write('\n');
          resolver(digitado);
          return;
        }
        if (c === '\u0003') process.exit(130); // Ctrl+C
        if (c === '\u007f' || c === '\b') digitado = digitado.slice(0, -1);
        else digitado += c;
      }
    };
    entrada.on('data', aoDigitar);
  });
}

async function principal() {
  await rodarMigrations();
  await inicializarBanco();

  console.log('\nCriar o usuario DEV (acesso temporario de configuracao).\n');

  const empresa = lerArgumento('empresa');
  const username = lerArgumento('usuario') ?? (await perguntar('Login do DEV (ex: bruno.dev): '));
  const nome = lerArgumento('nome') ?? (await perguntar('Nome: '));

  // A senha nunca vem por argumento: apareceria na lista de processos da maquina.
  let senha = process.env.DEV_SENHA;
  if (!senha) {
    senha = await perguntar('Senha (minimo 8 caracteres; nao aparece na tela): ', { oculto: true });
    const confirma = await perguntar('Repita a senha: ', { oculto: true });
    if (senha !== confirma) throw new Error('As senhas nao conferem.');
  }

  const r = await garantirUsuarioDev({ empresa, username, nome, senha });

  console.log(
    r.acao === 'criado'
      ? `\nUsuario DEV "${r.usuario.username}" criado na empresa "${r.empresa.slug}".`
      : `\nSenha do usuario DEV "${r.usuario.username}" redefinida.`
  );
  console.log('Ele NAO aparece em nenhuma lista do sistema. Entre com esse login na tela normal de login.\n');
  console.log('Regras do DEV:');
  console.log('  - So entra enquanto o CRIAR-DEV.bat estiver na pasta da Plataforma.');
  console.log('  - Ao clicar em "Sair", ele e APAGADO do banco. Para entrar de novo, rode este .bat outra vez.');
  console.log('  - Se fechar o navegador sem clicar em "Sair", e apagado no proximo inicio do sistema.\n');
}

// Compara pelo endereco que o proprio Node gera: montar a URL na mao quebrava
// em pasta com espaco no nome (o Node escreve %20) e o script nao rodava.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await principal();
  } catch (err) {
    console.error(`\nNao foi possivel: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    fecharBanco();
  }
}
