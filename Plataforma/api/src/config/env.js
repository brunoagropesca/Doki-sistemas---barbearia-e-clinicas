import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ehSegredoPadrao, SEGREDO_PADRAO } from './segredo-padrao.js';

/**
 * Configuracao central da aplicacao.
 *
 * Regra de ouro: NENHUM outro arquivo le `process.env` diretamente.
 * Todo mundo importa daqui. Assim existe um unico lugar que sabe quais
 * variaveis existem, qual o valor padrao de cada uma e o que e obrigatorio.
 *
 * Se uma variavel estiver faltando ou com valor invalido, a aplicacao
 * morre agora, no boot, com uma mensagem clara — em vez de quebrar daqui
 * a duas semanas no meio de um atendimento real.
 */

const bool = (padrao) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? padrao : v === 'true' || v === '1'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // --- Servidor HTTP ---
  // O 0 e permitido de proposito: e a convencao para "deixe o sistema
  // operacional escolher uma porta livre", usada pelos testes.
  PORT: z.coerce.number().int().min(0).max(65535).default(3333),
  HOST: z.string().default('127.0.0.1'),

  /**
   * Origens que podem chamar a API pelo navegador (CORS).
   * Lista separada por virgula. O sistema antigo usava "*", que permite
   * qualquer site aberto no navegador do usuario chamar a API dele.
   */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    ),

  // --- Banco de dados ---
  /**
   * `file:` para SQLite local. Para migrar pra nuvem depois, troca por uma
   * URL libsql://... (Turso) — o resto do codigo nao muda uma linha.
   */
  DATABASE_URL: z.string().default('file:./data/plataforma.db'),

  // --- Seguranca ---
  /**
   * Chave usada para assinar/derivar segredos. Em producao e OBRIGATORIA
   * e precisa ter pelo menos 32 caracteres.
   */
  APP_SECRET: z.string().min(32).default(SEGREDO_PADRAO),

  /** Quantos dias um login continua valido antes de exigir nova senha. */
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  /**
   * A "chave" do perfil DEV: o CRIAR-DEV.bat na pasta da Plataforma. Sem este
   * arquivo presente, o DEV nao entra (e quem ja esta dentro cai na proxima
   * requisicao). Apagar o .bat de uma instalacao tranca o perfil de vez.
   */
  DEV_ARQUIVO_CHAVE: z.string().default(fileURLToPath(new URL('../../../CRIAR-DEV.bat', import.meta.url))),

  // --- Logs ---
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool(true),

  // --- Teste automatico dos modelos de IA ---
  /**
   * Testar os modelos do Gemini sozinho: ao iniciar o sistema e quando uma
   * chave nova e salva. Desligar em testes automatizados (que nao podem
   * falar com o Google) ou para poupar cota.
   */
  IA_TESTE_AUTOMATICO: bool(true),
  /**
   * Validade de um teste, em horas. Ao iniciar, so retesta se o ultimo teste
   * for mais velho que isto. Sem esse limite, cada salvar de arquivo no modo
   * `npm run dev` (que reinicia o servidor) dispararia dezenas de chamadas.
   */
  IA_TESTE_VALIDADE_HORAS: z.coerce.number().positive().default(6),

  /**
   * Endereco da API do Gemini. O padrao e o do Google; existe para apontar
   * para um proxy da empresa ou para um servidor simulado nos testes.
   */
  GEMINI_BASE_URL: z.string().default('https://generativelanguage.googleapis.com/v1beta'),

  // --- Painel de atividade (terminal colorido) ---
  /**
   * Narra no terminal cada acao do sistema: mensagem que chegou, modelo que
   * respondeu, Sofia falando com a Atena. So existe em desenvolvimento; em
   * producao o log continua sendo JSON puro.
   */
  PAINEL_ATIVO: bool(true),
  /**
   * Mostra o TEXTO das mensagens dos clientes no painel. O terminal e da
   * maquina de quem desenvolve, mas se a janela for compartilhada (tela
   * aberta numa reuniao) desligue: o painel passa a mostrar so quem falou.
   * O telefone sai sempre mascarado. Conversa entre agentes nao e afetada.
   */
  PAINEL_CONTEUDO: bool(true),
  /**
   * Mostra tambem as LEITURAS da API (GET). Por padrao ficam de fora: as telas
   * consultam a API a cada poucos segundos e isso afogaria o que importa.
   */
  PAINEL_LEITURAS: bool(false),

  // --- Integracoes ---
  /** Pasta onde o Baileys guarda as credenciais de cada numero de WhatsApp. */
  WHATSAPP_AUTH_DIR: z.string().default('./data/whatsapp'),
  /** Pasta de uploads (audios recebidos, anexos). */
  UPLOADS_DIR: z.string().default('./data/uploads'),
  /**
   * As telas COMPILADAS (`vite build`), que a propria API serve no modo loja
   * (ver http/telas.js). Em desenvolvimento quem serve as telas e o Vite, e
   * esta pasta pode nem existir — ai a API simplesmente nao serve telas.
   */
  PASTA_TELAS: z.string().default(fileURLToPath(new URL('../../../web/dist', import.meta.url))),

  /** Pasta dos backups do banco (e das fotos/audios). Os testes usam outra. */
  BACKUP_DIR: z.string().default('./data/backups'),

  // --- Licenca de uso ---
  /**
   * Sem serial valido o sistema trava (telas e WhatsApp). LIGADA por padrao em
   * qualquer ambiente: a instalacao do cliente roda em modo de desenvolvimento,
   * entao nao da para depender do NODE_ENV. So os testes desligam.
   */
  LICENCA_EXIGIDA: bool(true),

  /**
   * SO VALE NOS TESTES (NODE_ENV=test). Fora deles, senha provisoria sempre
   * trava o login ate a pessoa criar a propria — nao ha como desligar.
   * Nos testes nasce desligada: dezenas de arquivos entram com a senha do
   * seed ou com usuarios recem-cadastrados. Quem testa a regra liga.
   */
  SENHA_PROVISORIA_NOS_TESTES: bool(false),
  /** Onde fica o serial ativado desta instalacao (fora do banco: ver licenca.js). */
  LICENCA_ARQUIVO: z.string().default('./data/licenca.json'),
  /** Chave publica alternativa, em PEM. So para testes; em uso real vem de chave-publica.js. */
  LICENCA_CHAVE_PUBLICA: z.string().optional(),
  /** Onde o GERAR-SERIAL guarda a chave PRIVADA (so no computador do fornecedor). */
  LICENCA_CHAVE_PRIVADA: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const problemas = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
    .join('\n');
  console.error(`\n[CONFIG] Variaveis de ambiente invalidas:\n${problemas}\n`);
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDev = env.NODE_ENV === 'development';

/**
 * O segredo de fabrica nao pode passar em NENHUM ambiente fora dos testes.
 *
 * Antes a trava era so de producao — mas a instalacao do cliente roda como
 * `development`, entao todas usavam o mesmo segredo, que esta no git. Ele cifra
 * as chaves de IA no banco: qualquer copia do banco (um backup no pendrive, por
 * exemplo) abriria as chaves. O INICIAR.bat gera um segredo proprio para cada
 * instalacao (`npm run env:preparar`, ver db/preparar-env.js).
 */
if (!isTest && ehSegredoPadrao(env.APP_SECRET)) {
  console.error(
    '\n[CONFIG] O APP_SECRET ainda e o de fabrica (o mesmo de toda instalacao).\n' +
      '         Rode o INICIAR.bat, que gera um segredo proprio para esta maquina\n' +
      '         (ou, no terminal, na pasta api: npm run env:preparar).\n'
  );
  process.exit(1);
}
