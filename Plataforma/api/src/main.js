// PRIMEIRO de tudo: restauracao de backup agendada, com o banco ainda fechado.
import './db/restaurar-antes-de-abrir.js';
import { env } from './config/env.js';
import { logger } from './core/logger.js';
import { faixaDeAbertura, ver } from './core/painel.js';
import { anunciarCascata } from './ai/cascade.js';
import { db } from './db/client.js';
import { tenants } from './db/schema/tenants.js';
import { fecharBanco, inicializarBanco } from './db/client.js';
import { rodarMigrations } from './db/migrate.js';
import { limparSessoesExpiradas } from './modules/auth/auth.repo.js';
import { removerDevsAbandonados } from './modules/auth/auth.service.js';
import {
  encerrarTodas,
  instalarAdaptadorWhatsapp,
  reconectarInstanciasSalvas
} from './channels/whatsapp/baileys.adapter.js';
import { testarModelosNoBoot } from './modules/ia/ia.service.js';
import { criarApp } from './app.js';
import { iniciarRotinas } from './automacao/rotinas.js';
import { sincronizarHistorico } from './modules/historico/historico.service.js';
import { iniciarBackupAutomatico } from './modules/dados/backups.js';
import { enviarMensagem } from './channels/gateway.js';
import { retomarInterrompidas as retomarCampanhasInterrompidas } from './modules/campanhas/campanhas.service.js';

/**
 * Ponto de entrada.
 *
 * Responsabilidades: subir na ordem certa e DESCER na ordem certa.
 *
 * O desligamento ordenado (a parte de baixo do arquivo) costuma ser esquecido
 * e e o que evita corromper dado: quando o processo morre no meio de uma
 * escrita, o banco fica num estado que precisa de reparo. Aqui o servidor para
 * de aceitar requisicao nova, termina as que ja estao em andamento e so entao
 * fecha o banco.
 */

async function principal() {
  // Migrations no boot: garante que o banco esta na versao que este codigo
  // espera. Evita a classe de bug "funciona na minha maquina" causada por
  // alguem ter esquecido de rodar a migration.
  await rodarMigrations();
  await inicializarBanco();

  const removidas = await limparSessoesExpiradas();
  if (removidas > 0) logger.info({ removidas }, 'Sessoes expiradas removidas');
  await removerDevsAbandonados();

  // Atendimentos encerrados antes do historico existir (ou num boot que caiu
  // no meio) entram agora. Nao segura a subida: e so coleta para analise.
  sincronizarHistorico().catch((err) => logger.warn({ err }, 'Falha ao preencher o historico de atendimentos'));

  // Registra o WhatsApp no gateway ANTES de abrir a porta: se uma mensagem
  // chegar no primeiro segundo, o adaptador ja precisa existir.
  instalarAdaptadorWhatsapp();

  const app = await criarApp();

  await app.listen({ port: env.PORT, host: env.HOST });

  // O relogio da Atena: fechamento do dia e demais rotinas automaticas.
  const pararRotinas = iniciarRotinas();
  // Um backup por dia (guarda os 14 ultimos), sem ninguem precisar lembrar.
  const pararBackups = iniciarBackupAutomatico();

  /**
   * Reconecta os numeros que estavam ativos, sem segurar o boot.
   *
   * Fica fora do `await` de proposito: ler QR Code e negociar sessao pode
   * levar dezenas de segundos, e a API precisa responder desde ja. Se a
   * reconexao falhar, a empresa continua usando o sistema pela tela.
   */
  reconectarInstanciasSalvas().catch((err) => {
    logger.warn({ err }, 'Falha ao reconectar canais salvos');
  });

  /**
   * Testa os modelos do Gemini em segundo plano.
   *
   * Assim, quando alguem abre a tela de cascata, o menu do modelo primario ja
   * mostra quais modelos responderam (e em quanto tempo), e a cascata ja
   * esta usando os melhores para WhatsApp — sem ninguem precisar clicar.
   */
  testarModelosNoBoot().catch((err) => {
    logger.warn({ err }, 'Falha ao iniciar o teste automático de modelos');
  });

  /**
   * Campanhas que estavam enviando (ou gerando mensagens) quando a API caiu.
   *
   * O laco de envio mora em memoria e morre com o processo. Sem isto, a
   * campanha ficaria "enviando" para sempre sem enviar nada. Se o WhatsApp
   * ainda estiver reconectando, o proprio disparo percebe e pausa com o motivo.
   */
  retomarCampanhasInterrompidas({ enviar: enviarMensagem })
    .then((n) => n > 0 && logger.info({ campanhas: n }, 'Campanhas interrompidas retomadas'))
    .catch((err) => logger.warn({ err }, 'Falha ao retomar campanhas interrompidas'));

  logger.info(
    { url: `http://${env.HOST}:${env.PORT}`, ambiente: env.NODE_ENV },
    'API no ar'
  );

  // Painel: a faixa de abertura e como esta a cascata de IA de cada empresa.
  faixaDeAbertura({ url: `http://${env.HOST}:${env.PORT}`, ambiente: env.NODE_ENV });
  db.select({ id: tenants.id, nome: tenants.nome })
    .from(tenants)
    .then(async (empresas) => {
      for (const e of empresas) {
        ver('sistema', `empresa ${e.nome}`, 'cascata de IA:');
        await anunciarCascata(e.id);
      }
    })
    .catch(() => {});

  // --- Desligamento ordenado ---

  let desligando = false;
  const desligar = async (sinal) => {
    if (desligando) return; // Ctrl+C apertado duas vezes nao atropela o processo.
    desligando = true;

    logger.info({ sinal }, 'Desligando...');
    ver('sistema', 'desligando com seguranca...', sinal);

    // Rede de seguranca: se algo travar, cai na marra depois de 10s em vez
    // de ficar pendurado pra sempre.
    const prazo = setTimeout(() => {
      logger.error('Desligamento demorou demais. Encerrando a forca.');
      process.exit(1);
    }, 10_000);
    prazo.unref();

    try {
      pararRotinas();
      pararBackups();
      await app.close(); // para de aceitar, termina o que esta em andamento
      // Fecha os WhatsApps antes do banco: o evento "fechou" de cada um tenta
      // gravar o estado, e nao pode encontrar o banco ja fechado.
      encerrarTodas();
      fecharBanco();
      logger.info('Desligado com seguranca.');
      ver('sistema', 'servidor desligado');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Falha no desligamento');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => desligar('SIGTERM'));
  process.on('SIGINT', () => desligar('SIGINT'));

  /**
   * Erro que escapou de tudo.
   *
   * O sistema antigo apenas registrava e seguia em frente. Isso e arriscado:
   * depois de uma excecao nao tratada, o processo pode estar com estado
   * corrompido — uma transacao pela metade, um arquivo meio escrito — e
   * continuar atendendo nesse estado causa dano pior e mais dificil de achar.
   * Aqui registramos e encerramos de forma ordenada; quem gerencia o processo
   * sobe de novo, limpo.
   */
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Excecao nao capturada — encerrando');
    desligar('uncaughtException');
  });

  process.on('unhandledRejection', (motivo) => {
    logger.fatal({ err: motivo }, 'Promise rejeitada sem tratamento — encerrando');
    desligar('unhandledRejection');
  });
}

principal().catch((err) => {
  logger.fatal({ err }, 'Falha ao iniciar a API');
  process.exit(1);
});
