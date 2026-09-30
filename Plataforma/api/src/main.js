// PRIMEIRO de tudo: restauracao de backup agendada, com o banco ainda fechado.
import './db/restaurar-antes-de-abrir.js';
import { env } from './config/env.js';
import { logger } from './core/logger.js';
import { faixaDeAbertura, ver } from './core/painel.js';
import { anunciarCascata } from './ai/cascade.js';
import { db } from './db/client.js';
import { tenants } from './db/schema/tenants.js';
import { fecharBanco, inicializarBanco } from './db/client.js';
import { ativarAutoVacuumIncremental } from './db/manutencao.js';
import { rodarMigrations } from './db/migrate.js';
import { limparSessoesExpiradas } from './modules/auth/auth.repo.js';
import { marcarSenhasDeFabrica, removerDevsAbandonados } from './modules/auth/auth.service.js';
import {
  encerrarTodas,
  instalarAdaptadorWhatsapp,
  reconectarInstanciasSalvas
} from './channels/whatsapp/baileys.adapter.js';
import { testarModelosNoBoot } from './modules/ia/ia.service.js';
import { criarApp } from './app.js';
import { iniciarRotinas } from './automacao/rotinas.js';
import { AUSENTE_APOS_MS, marcarAusentesSemPainel } from './modules/equipe/presenca.js';
import { sincronizarHistorico } from './modules/historico/historico.service.js';
import { iniciarBackupAutomatico } from './modules/dados/backups.js';
import { enviarMensagem } from './channels/gateway.js';
import { retomarInterrompidas as retomarCampanhasInterrompidas } from './modules/campanhas/campanhas.service.js';
import { entregarMensagem, marcarEntregasInterrompidas } from './modules/conversas/entrega.service.js';
import { gravarFalhaFatal, quedaRecente } from './core/falhas.js';
import { anotar, anotarAgora, comoTerminouOAnterior } from './core/diario.js';

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
  // Diario permanente (data/logs/conexoes.log): cada subida fica marcada, e se
  // a anterior nunca registrou a descida, ela terminou de forma abrupta
  // (janela fechada, reinicio do --watch, queda) — o que explica, depois, uma
  // mensagem "interrompida" ou a conexao do WhatsApp caindo naquela hora.
  const anterior = comoTerminouOAnterior();
  if (anterior === 'abrupto') anotar('SERVIDOR aviso: o processo anterior terminou sem desligar normalmente');
  anotar(`SERVIDOR iniciado · pid ${process.pid} · node ${process.version}`);

  // Migrations no boot: garante que o banco esta na versao que este codigo
  // espera. Evita a classe de bug "funciona na minha maquina" causada por
  // alguem ter esquecido de rodar a migration.
  await rodarMigrations();
  await inicializarBanco();
  // Uma vez por banco: liga o auto_vacuum incremental (com o VACUUM que a troca
  // exige), para o arquivo voltar a encolher depois de exclusoes. ANTES de
  // abrir a porta: o VACUUM trava o banco enquanto roda. Ver db/manutencao.js.
  await ativarAutoVacuumIncremental().catch((err) => logger.warn({ err }, 'Nao foi possivel ligar o auto_vacuum incremental'));

  const removidas = await limparSessoesExpiradas();
  if (removidas > 0) logger.info({ removidas }, 'Sessoes expiradas removidas');
  await removerDevsAbandonados();
  // Instalacao antiga: quem ainda usa a senha de fabrica cria a propria no proximo login.
  await marcarSenhasDeFabrica().catch((err) => logger.warn({ err }, 'Falha ao conferir senhas de fabrica'));

  // Respostas de atendente que estavam SAINDO quando o servidor caiu: sem
  // isto ficavam sem "entregue" e sem "falhou" — pareciam enviadas para sempre,
  // sem botao Reenviar. As que com certeza nao tinham saido (na fila, subindo
  // a midia) e sao recentes voltam para a fila la embaixo, quando o WhatsApp
  // ja estiver instalado; as demais aparecem como nao entregues.
  const retomar = [];
  const interrompidas = await marcarEntregasInterrompidas({ aoRetomar: (p) => retomar.push(p) }).catch((err) => {
    logger.warn({ err }, 'Falha ao marcar entregas interrompidas');
    return 0;
  });
  if (interrompidas > 0) ver('aviso', `${interrompidas} resposta(s) de atendente ficaram sem confirmação de envio`, 'marcadas como não entregues: confira e reenvie');

  // Atendimentos encerrados antes do historico existir (ou num boot que caiu
  // no meio) entram agora. Nao segura a subida: e so coleta para analise.
  sincronizarHistorico().catch((err) => logger.warn({ err }, 'Falha ao preencher o historico de atendimentos'));

  // Registra o WhatsApp no gateway ANTES de abrir a porta: se uma mensagem
  // chegar no primeiro segundo, o adaptador ja precisa existir.
  instalarAdaptadorWhatsapp();

  const app = await criarApp();

  await app.listen({ port: env.PORT, host: env.HOST });

  // O relogio da Atena: fechamento do dia, lembrete de vespera e demais rotinas.
  // O envio entra por injecao, como nas campanhas: as rotinas nao conhecem o canal.
  const pararRotinas = iniciarRotinas({ enviar: enviarMensagem });
  // Ao ligar ninguem esta conectado: passado o prazo, quem segue "online" sem
  // painel aberto sai da distribuicao (volta sozinho ao abrir). Ver presenca.js.
  setTimeout(() => marcarAusentesSemPainel().catch(() => {}), AUSENTE_APOS_MS).unref?.();
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

  // As interrompidas antes de sair: a entrega espera a conexao que acabou de
  // ser pedida acima e envia. Sem await: nao segura a subida.
  for (const p of retomar) {
    entregarMensagem(p.tenantId, p.conversationId, p.id).catch((err) =>
      logger.warn({ err, mensagemId: p.id }, 'Nao foi possivel retomar a entrega interrompida')
    );
  }
  if (retomar.length > 0) ver('sistema', `${retomar.length} resposta(s) interrompida(s) antes de sair voltaram para a fila`);

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

  // Subiu logo depois de uma queda: diz o que foi e onde esta o detalhe.
  const queda = quedaRecente();
  if (queda) {
    ver('aviso', `o servidor caiu às ${queda.quando.toLocaleTimeString('pt-BR', { hour12: false })} e foi religado`, `${queda.resumo} · detalhes em ${queda.arquivo}`);
  }
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
  const desligar = async (sinal, codigoDeSaida = 0) => {
    if (desligando) return; // Ctrl+C apertado duas vezes nao atropela o processo.
    desligando = true;

    logger.info({ sinal }, 'Desligando...');
    anotarAgora(`SERVIDOR encerrado · ${sinal}${codigoDeSaida ? ` · codigo ${codigoDeSaida}` : ''}`);
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
      process.exit(codigoDeSaida);
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
  // A causa vai para data/logs/falhas.log ANTES de tudo: no terminal ela se
  // perdia ao fechar a janela (uma queda ao enviar audio ficou sem explicacao).
  // Sai com codigo de ERRO (1): o painel entende que caiu e religa.
  process.on('uncaughtException', (err) => {
    const arquivo = gravarFalhaFatal('uncaughtException', err);
    logger.fatal({ err, arquivo }, 'Excecao nao capturada — encerrando');
    desligar('uncaughtException', 1);
  });

  process.on('unhandledRejection', (motivo) => {
    const arquivo = gravarFalhaFatal('unhandledRejection', motivo);
    logger.fatal({ err: motivo, arquivo }, 'Promise rejeitada sem tratamento — encerrando');
    desligar('unhandledRejection', 1);
  });
}

principal().catch((err) => {
  logger.fatal({ err }, 'Falha ao iniciar a API');
  process.exit(1);
});
