import { apenas } from '../../http/plugins/autenticacao.js';
import * as service from './conversas.service.js';
import { veTudo } from '../equipe/equipe.config.js';
import { entregarComEspera } from './entrega.service.js';
import { gravarEntrega } from './conversas.repo.js';
import {
  abrirConversaSchema,
  anotacoesSchema,
  finalizarSchema,
  moverEtapaSchema,
  listarConversasSchema,
  listarMensagensSchema,
  metricasConversasSchema,
  responderSchema,
  transferirSchema
} from './conversas.schemas.js';

export async function rotasConversas(app) {
  /** GET /api/conversas/metricas — painel da mesa de atendimento. */
  app.get('/api/conversas/metricas', { config: apenas.atendente }, async (req) => {
    const filtros = metricasConversasSchema.parse(req.query);
    return service.metricas(req.tenantId, filtros, req.usuario);
  });

  /** GET /api/conversas — lista da mesa, com filtros de visao. */
  app.get('/api/conversas', { config: apenas.atendente }, async (req) => {
    const filtros = listarConversasSchema.parse(req.query);
    return service.listar(req.tenantId, filtros, req.usuario);
  });

  /**
   * GET /api/conversas/destinos — para quem esta conversa pode ser transferida.
   *
   * Fica aqui, e nao em /api/atendentes (que e de admin), porque transferir e
   * tarefa do dia a dia de quem atende: a recepcao precisa poder passar um
   * cliente ao colega sem ter acesso ao cadastro da equipe.
   */
  app.get('/api/conversas/destinos', { config: apenas.atendente }, async (req) => {
    return {
      atendentes: await service.destinosDeTransferencia(req.tenantId, req.usuario),
      // A tela so mostra o seletor de "ver outro atendente" a quem o servidor
      // vai de fato atender; para os demais ele seria um botao que nao faz nada.
      veTudo: await veTudo(req.tenantId, req.usuario)
    };
  });

  /** GET /api/conversas/:id */
  /**
   * POST /api/conversas/abrir — achar (ou abrir) a conversa de um cliente.
   *
   * E o que faz o botao "Enviar mensagem" da ficha do contato levar direto ao
   * fio certo, em vez de obrigar a procurar o nome na mesa. Reusa a conversa
   * aberta quando ela existe: falar com alguem nao pode criar um atendimento
   * paralelo ao que ja esta acontecendo.
   *
   * Declarada antes de '/api/conversas/:id' — senao 'abrir' viraria um id.
   */
  app.post('/api/conversas/abrir', { config: apenas.atendente }, async (req) => {
    const { leadId, canal, criar } = abrirConversaSchema.parse(req.body);
    if (!criar) {
      const aberta = await service.conversaAbertaDoLead(req.tenantId, leadId);
      return { conversa: aberta ? await service.obter(req.tenantId, aberta, req.usuario) : null };
    }
    // A aberta por qualquer conexao primeiro: sem isto, um cliente que
    // escreveu pela W1 ganhava uma SEGUNDA conversa, sem conexao, ao lado.
    const id = (await service.conversaAbertaDoLead(req.tenantId, leadId)) ?? (await service.encontrarOuAbrir(req.tenantId, { leadId, canal }));
    return { conversa: await service.obter(req.tenantId, id, req.usuario) };
  });

  app.get('/api/conversas/:id', { config: apenas.atendente }, async (req) => {
    return { conversa: await service.obter(req.tenantId, req.params.id, req.usuario) };
  });

  /** GET /api/conversas/:id/mensagens — o fio da conversa. */
  app.get('/api/conversas/:id/mensagens', { config: apenas.atendente }, async (req) => {
    const filtros = listarMensagensSchema.parse(req.query);
    return service.mensagens(req.tenantId, req.params.id, filtros, req.usuario);
  });

  /** POST /api/conversas/:id/assumir — humano entra e a IA cala. */
  app.post('/api/conversas/:id/assumir', { config: apenas.atendente }, async (req) => {
    return { conversa: await service.assumir(req.tenantId, req.params.id, req.usuario) };
  });

  /** POST /api/conversas/:id/devolver — volta para a IA. */
  app.post('/api/conversas/:id/devolver', { config: apenas.atendente }, async (req) => {
    return { conversa: await service.devolverParaIa(req.tenantId, req.params.id, req.usuario) };
  });

  /**
   * POST /api/conversas/:id/distribuir — entrega a conversa a alguem da equipe.
   *
   * `forcar` porque aqui alguem CLICOU: mesmo com a distribuicao automatica
   * desligada, o pedido explicito de um atendente deve ser atendido.
   * `distribuirManual` confere quem pede (escopo e gerencia) antes.
   */
  app.post('/api/conversas/:id/distribuir', { config: apenas.atendente }, async (req) => {
    return service.distribuirManual(req.tenantId, req.params.id, req.usuario);
  });

  /** POST /api/conversas/:id/transferir */
  app.post('/api/conversas/:id/transferir', { config: apenas.atendente }, async (req) => {
    const dados = transferirSchema.parse(req.body);
    return { conversa: await service.transferir(req.tenantId, req.params.id, dados, req.usuario) };
  });

  /**
   * POST /api/conversas/:id/mensagens — atendente responde.
   *
   * A mensagem e gravada primeiro e entregue ao canal em seguida. O resultado
   * da entrega vem em `entrega`: se o WhatsApp estiver fora do ar, a resposta
   * continua salva (nada do que o atendente digitou se perde) e a tela avisa
   * que ela NAO chegou ao cliente, com a opcao de reenviar.
   */
  // Limite proprio: um video de 16 MB passa de 21 MB em base64, bem acima dos
  // 5 MB que o resto da API aceita.
  app.post('/api/conversas/:id/mensagens', { config: apenas.atendente, bodyLimit: 24 * 1024 * 1024 }, async (req, res) => {
    const dados = responderSchema.parse(req.body);
    const r = await service.responder(req.tenantId, req.params.id, dados, req.usuario);

    let entrega;
    try {
      // Espera ate alguns segundos; se a conexao estiver fora, a entrega segue
      // em segundo plano e o balao mostra "aguardando conexao" (ver entrega.service).
      entrega = await entregarComEspera(req.tenantId, req.params.id, r.id, {}, () =>
        gravarEntrega(req.tenantId, r.id, { erroEnvio: 'Falha inesperada ao enviar. Tente reenviar.' }, req.params.id).catch(() => {})
      );
    } catch (err) {
      // A mensagem ja esta gravada; uma falha aqui nao pode fazer o atendente
      // achar que ela se perdeu e digitar de novo (duplicaria).
      req.log.error({ err }, 'Falha inesperada ao entregar a resposta');
      entrega = { entregue: false, erro: 'Falha inesperada ao enviar. Tente reenviar.' };
      // Ultima rede de seguranca: `entregarMensagem` ja tenta gravar o motivo
      // da falha varias vezes por conta propria; se AINDA ASSIM ela lancou um
      // erro (algo quebrou antes mesmo de chegar la), a mensagem ficaria sem
      // `erroEnvio` — invisivel, sem selo de falha e sem botao Reenviar,
      // parecendo enviada para sempre. Esta e a ultima tentativa de marcar.
      try {
        await gravarEntrega(req.tenantId, r.id, { erroEnvio: entrega.erro }, req.params.id);
      } catch (errGravar) {
        req.log.error({ err: errGravar, mensagemId: r.id }, 'Nao foi possivel marcar a falha da rede de seguranca');
      }
    }

    // Audio: o texto falado chega DEPOIS (2 a 4 s de IA que o atendente nao
    // precisa esperar). Sem await de proposito; a funcao nunca lanca.
    if (dados.audio) void service.transcreverRespostaDeAudio(req.tenantId, req.params.id, r.id);

    res.status(201);
    return { ...r, entrega };
  });

  /** POST /api/conversas/:id/mensagens/:mensagemId/reenviar — nova tentativa de entrega. */
  app.post('/api/conversas/:id/mensagens/:mensagemId/reenviar', { config: apenas.atendente }, async (req) => {
    const entrega = await entregarComEspera(req.tenantId, req.params.id, req.params.mensagemId, {
      reenvio: true,
      usuario: req.usuario
    });
    return { entrega };
  });

  /** POST /api/conversas/:id/finalizar */
  app.post('/api/conversas/:id/finalizar', { config: apenas.atendente }, async (req) => {
    const dados = finalizarSchema.parse(req.body ?? {});
    return { conversa: await service.finalizar(req.tenantId, req.params.id, dados, req.usuario) };
  });

  /** POST /api/conversas/:id/reabrir */
  app.post('/api/conversas/:id/reabrir', { config: apenas.atendente }, async (req) => {
    return { conversa: await service.reabrir(req.tenantId, req.params.id, req.usuario) };
  });

  /**
   * PATCH /api/conversas/:id/anotacoes — o bloco de notas do atendente.
   *
   * Fica separado das anotacoes da IA de proposito: ao finalizar a sessao,
   * as duas sao copiadas para a OS em campos distintos, e quem ler daqui a
   * meses precisa saber quem escreveu o que.
   */
  app.patch('/api/conversas/:id/anotacoes', { config: apenas.atendente }, async (req) => {
    const { texto } = anotacoesSchema.parse(req.body ?? {});
    return { conversa: await service.salvarAnotacoes(req.tenantId, req.params.id, texto, req.usuario) };
  });

  /** PATCH /api/conversas/:id/etapa — move o cartao no quadro de atendimento. */
  app.patch('/api/conversas/:id/etapa', { config: apenas.atendente }, async (req) => {
    const { etapa } = moverEtapaSchema.parse(req.body);
    return { conversa: await service.moverEtapa(req.tenantId, req.params.id, etapa, { usuario: req.usuario }) };
  });

  /** POST /api/conversas/:id/lida — zera o contador de nao lidas. */
  app.post('/api/conversas/:id/lida', { config: apenas.atendente }, async (req) => {
    return service.marcarLida(req.tenantId, req.params.id, req.usuario);
  });
}
