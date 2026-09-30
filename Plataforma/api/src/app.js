import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { logger } from './core/logger.js';
import { cinza, fg, negrito, painelAtivo, resumir, ver } from './core/painel.js';
import { bancoSaudavel } from './db/client.js';
import { registrarTratamentoDeErros } from './http/plugins/erros.js';
import { apenas, pluginAutenticacao } from './http/plugins/autenticacao.js';
import { rotasAuth } from './modules/auth/auth.routes.js';
import { rotasLeads } from './modules/leads/leads.routes.js';
import { rotasAgenda } from './modules/agenda/agenda.routes.js';
import { rotasMeuDia } from './modules/meu-dia/meu-dia.routes.js';
import { rotasHades } from './modules/hades/hades.routes.js';
import { rotasCatalogo } from './modules/catalogo/catalogo.routes.js';
import { rotasConversas } from './modules/conversas/conversas.routes.js';
import { rotasIa } from './modules/ia/ia.routes.js';
import { rotasCanais } from './modules/canais/canais.routes.js';
import { rotasCampanhas } from './modules/campanhas/campanhas.routes.js';
import { rotasQuadro } from './modules/quadro/quadro.routes.js';
import { rotasEquipe } from './modules/equipe/equipe.routes.js';
import { rotasPerfil } from './modules/perfil/perfil.routes.js';
import { rotasEmpresa } from './modules/empresa/empresa.routes.js';
import { rotasAnalises } from './modules/analises/analises.routes.js';
import { rotasDemonstracao } from './modules/demonstracao/demonstracao.routes.js';
import { invalidarCatalogo } from './ai/tools/catalogo-cache.js';
import { instalarAtenaPiloto } from './automacao/atena-piloto.js';
import { rotasAutomacao } from './automacao/automacao.routes.js';
import { rotasNotificacoes } from './modules/notificacoes/notificacoes.routes.js';
import { rotasFuncoes } from './modules/funcoes/funcoes.routes.js';
import { rotasTextos } from './modules/textos/textos.routes.js';
import { rotasDados } from './modules/dados/dados.routes.js';
import { rotasBackupsDoDono } from './modules/dados/backups-dono.routes.js';
import { pluginTravaDeLicenca, rotasLicenca } from './licenca/licenca.routes.js';
import { rotasTelas } from './http/telas.js';
import { rotasCertificado } from './http/https.js';

/**
 * Montagem do servidor.
 *
 * Separado de `main.js` de proposito: esta funcao devolve o app sem colocar
 * ele pra escutar numa porta. E isso que permite os testes subirem a API
 * inteira em memoria, com `app.inject()`, sem ocupar porta nem depender de
 * rede — testes rapidos e que podem rodar em paralelo.
 */
/**
 * @param {object} [opcoes]
 * @param {{ chave: string, cert: string, autoridadeDer: Buffer }} [opcoes.https]
 *   certificados da loja (http/certificados.js). Com eles o app atende em HTTPS
 *   (quem escuta a porta e o `escutarComHttps`, em http/https.js).
 */
export async function criarApp({ logger: loggerCustomizado, https } = {}) {
  const app = Fastify({
    ...(https ? { https: { key: https.chave, cert: https.cert } } : {}),
    loggerInstance: loggerCustomizado ?? logger,
    // Confia no cabecalho de proxy pra descobrir o IP real do cliente — mas
    // so quando quem repassa e ESTA maquina (o proxy do Vite, ou um proxy
    // local): assim o acesso pela rede registra o IP do celular, e ninguem de
    // fora consegue forjar o proprio IP mandando o cabecalho. Vale tambem em
    // producao: antes era `true` la, e com a API direto na rede um atacante
    // trocaria de "IP" a cada tentativa e escaparia do limite de login por
    // aparelho (modules/auth/tentativas.js).
    trustProxy: 'loopback',
    // Teto do corpo da requisicao: 5 MB. Sem limite, um POST gigante
    // derruba o servidor por consumo de memoria.
    bodyLimit: 5 * 1024 * 1024,
    // Desliga o log automatico do Fastify (duas linhas por requisicao) porque
    // temos o nosso, mais enxuto, no hook `onResponse` abaixo.
    //
    // NOTA: o Fastify 5 avisa que esta opcao sai na versao 6, em favor de um
    // `logController`. A substituta exige instanciar uma classe da propria
    // biblioteca, entao fica pra quando formos subir pro Fastify 6 — trocar
    // agora, no escuro, so adicionaria risco.
    disableRequestLogging: true
  });

  // --- Infraestrutura (a ordem importa) ---

  await app.register(cors, {
    // Lista fechada de origens, vinda da configuracao.
    // O sistema antigo respondia `Access-Control-Allow-Origin: *`, o que
    // permite qualquer site aberto no navegador do usuario chamar a API dele.
    origin: env.CORS_ORIGINS,
    // Necessario pro navegador enviar o cookie de sessao.
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  });

  await app.register(cookie, { secret: env.APP_SECRET });

  registrarTratamentoDeErros(app);

  // Precisa vir depois do cookie (le o cookie) e antes das rotas
  // (o hook de autenticacao tem que existir antes de elas serem registradas).
  await app.register(pluginAutenticacao);
  // Logo depois da autenticacao: com a licenca vencida, so login e licenca respondem.
  await app.register(pluginTravaDeLicenca);

  /**
   * Painel: o que as pessoas fazem nas telas.
   *
   * So escritas (POST, PUT, PATCH, DELETE) e erros. As leituras (GET) ficam de
   * fora: as telas consultam a API a cada poucos segundos, e mostrar isso
   * afogaria o que importa. PAINEL_LEITURAS=true traz de volta.
   */
  app.addHook('onResponse', async (req, res) => {
    if (!painelAtivo || req.url === '/health') return;
    const leitura = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    if (leitura && res.statusCode < 400 && !env.PAINEL_LEITURAS) return;

    const cor = res.statusCode >= 500 ? 196 : res.statusCode >= 400 ? 214 : 41;
    ver(
      'api',
      `${negrito(req.method.padEnd(6))} ${resumir(req.url.split('?')[0], 60)}  ${fg(cor, String(res.statusCode))}`,
      `${Math.round(res.elapsedTime)}ms${req.usuario?.nome ? ` · ${req.usuario.nome}` : ''}`
    );
  });

  // Log de requisicao enxuto: uma linha por resposta, com o que importa.
  app.addHook('onResponse', async (req, res) => {
    const nivel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    req.log[nivel](
      {
        metodo: req.method,
        rota: req.url,
        status: res.statusCode,
        ms: Math.round(res.elapsedTime),
        userId: req.usuario?.id
      },
      `${req.method} ${req.url} ${res.statusCode}`
    );
  });

  /**
   * Catalogo da IA sempre em dia.
   *
   * A IA le servicos e profissionais de um cache de 60 s (poupa banco e
   * tokens). Depois de QUALQUER mudanca bem-sucedida nessas telas, o cache e
   * derrubado — em onResponse, ja com a escrita concluida, para nao haver
   * janela em que uma leitura recarregue o dado velho.
   */
  app.addHook('onResponse', async (req, res) => {
    if (req.method === 'GET' || res.statusCode >= 400 || !req.tenantId) return;
    if (/^\/api\/(servicos|profissionais)(\/|$|\?)/.test(req.url)) invalidarCatalogo(req.tenantId);
  });

  // A Atena passa a reagir sozinha ao que acontece no sistema.
  instalarAtenaPiloto();

  // --- Rotas ---

  /** Saude do servico. Publica: monitoramento nao faz login. */
  app.get('/health', { config: apenas.publico }, async (_req, res) => {
    const banco = await bancoSaudavel();
    if (!banco) {
      res.status(503);
      return { ok: false, banco: 'indisponivel' };
    }
    return { ok: true, banco: 'ok', ambiente: env.NODE_ENV, versao: '0.1.0' };
  });

  // Cada modulo registra as proprias rotas. Adicionar um modulo novo e uma
  // linha aqui — nao mexer num arquivo de 2.000 linhas cheio de `if`.
  await app.register(rotasAuth);
  await app.register(rotasLeads);
  await app.register(rotasAgenda);
  await app.register(rotasMeuDia);
  await app.register(rotasCatalogo);
  await app.register(rotasConversas);
  await app.register(rotasIa);
  await app.register(rotasCanais);
  await app.register(rotasCampanhas);
  await app.register(rotasQuadro);
  await app.register(rotasEquipe);
  await app.register(rotasAutomacao);
  await app.register(rotasNotificacoes);
  await app.register(rotasFuncoes);
  await app.register(rotasTextos);
  await app.register(rotasDados);
  await app.register(rotasBackupsDoDono);
  await app.register(rotasLicenca);
  await app.register(rotasPerfil);
  await app.register(rotasEmpresa);
  await app.register(rotasAnalises);
  await app.register(rotasDemonstracao);
  // Hades: a parte do resto (config propria, chave propria). Ver modules/hades.
  await app.register(rotasHades);

  if (https) {
    // HSTS CURTO (1 dia): o navegador lembra de usar HTTPS, mas, se for preciso
    // voltar atras (certificado com problema), ninguem fica preso mais que um dia.
    app.addHook('onSend', async (req, res) => {
      if (req.protocol === 'https') res.header('strict-transport-security', 'max-age=86400');
    });
    await app.register(rotasCertificado, { autoridadeDer: https.autoridadeDer });
  }

  // Por ultimo: as telas compiladas (modo loja). Tudo que nao e /api cai aqui
  // e vira a tela; sem web/dist (desenvolvimento), nao registra nada.
  await app.register(rotasTelas);

  return app;
}
