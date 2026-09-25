import { z } from 'zod';
import { apenas } from '../../http/plugins/autenticacao.js';
import * as service from './ia.service.js';
import { simular } from '../atendimento/simulador.service.js';

const salvarProvedorSchema = z.object({
  apiKey: z.string().trim().min(10, 'A chave parece curta demais.').max(500).optional(),
  baseUrl: z.url('URL invalida.').optional().or(z.literal('')),
  modeloPadrao: z.string().trim().max(120).optional(),
  habilitado: z.boolean().optional(),
  prioridade: z.number().int().min(1).max(999).optional()
});

const alternarModeloSchema = z.object({
  modelo: z.string().trim().min(1),
  ativo: z.boolean()
});

const loteModelosSchema = z.object({
  acao: z.enum(['ativar_aprovados', 'desativar_reprovados'])
});

const salvarAgenteSchema = z.object({
  nome: z.string().trim().min(1).max(80).optional(),
  avatar: z.string().trim().max(10).optional(),
  systemPrompt: z.string().max(8000).optional(),
  tom: z.string().trim().max(40).optional(),
  temperatura: z.number().min(0).max(2).optional(),
  modeloPreferido: z.string().trim().max(120).nullish(),
  maxTokens: z.number().int().min(50).max(8000).optional(),
  ferramentas: z.array(z.string()).max(30).optional(),
  // Ajustes proprios do agente (hoje, os do Aquiles). Os limites finos
  // (quantos exemplos, tamanho de cada um) sao conferidos no servico.
  config: z
    .object({
      exemplos: z.array(z.string().max(2000)).max(20).optional(),
      herdarSofia: z.boolean().optional()
    })
    .optional(),
  ativo: z.boolean().optional()
});

const experimentarSchema = z.object({
  mensagem: z.string().trim().min(1, 'Escreva a mensagem de teste.').max(2000),
  systemPrompt: z.string().max(8000).optional(),
  temperatura: z.number().min(0).max(2).default(0.7)
});

const simularSchema = z.object({
  mensagem: z.string().trim().min(1, 'Escreva a mensagem do cliente.').max(2000),
  // A tela guarda a conversa e manda de volta a cada turno: o simulador nao
  // grava nada, entao nao ha onde ele lembrar sozinho. O teto de 40 evita que
  // uma conversa de teste esquecida aberta vire um payload gigante.
  historico: z
    .array(
      z.object({
        papel: z.enum(['user', 'assistant']),
        conteudo: z.string().max(4000)
      })
    )
    .max(40)
    .default([]),
  modo: z.enum(['menu', 'hibrido', 'ia']).nullish(),
  permitirEscrita: z.boolean().default(false),
  // Dois formatos: onde o cliente esta no menu ({ no, pilha, em }) ou "a Sofia
  // conduz" ({ conduz: 'ia', em }), que nao tem menu nenhum — por isso `no` e
  // `pilha` sao opcionais. Sem `conduz` aqui o Zod o descartaria e o simulador
  // voltaria a mostrar o menu no 2º turno.
  menuEstado: z
    .object({
      no: z.string().max(60).optional(),
      pilha: z.array(z.string().max(60)).max(20).optional(),
      em: z.number(),
      conduz: z.literal('ia').optional()
    })
    .nullish()
});

/**
 * Rotas de configuracao da IA.
 *
 * TODAS exigem admin. No sistema antigo, `GET /api/ai/status` devolvia a chave
 * de API inteira, em texto puro, sem exigir login nenhum.
 */
export async function rotasIa(app) {
  /** GET /api/ia/provedores — nunca inclui a chave, so os 4 ultimos digitos. */
  app.get('/api/ia/provedores', { config: apenas.admin }, async (req) => {
    return service.listarProvedores(req.tenantId);
  });

  app.put('/api/ia/provedores/:provedor', { config: apenas.admin }, async (req) => {
    const dados = salvarProvedorSchema.parse(req.body);
    const provedor = await service.salvarProvedor(req.tenantId, req.params.provedor, dados, {
      usuario: req.usuario
    });
    return { provedor };
  });

  app.delete('/api/ia/provedores/:provedor', { config: apenas.admin }, async (req) => {
    return service.removerProvedor(req.tenantId, req.params.provedor, { usuario: req.usuario });
  });

  /** POST /api/ia/provedores/:provedor/testar — chamada real e curta. */
  app.post('/api/ia/provedores/:provedor/testar', { config: apenas.admin }, async (req) => {
    return service.testarProvedor(req.tenantId, req.params.provedor);
  });

  /** POST /api/ia/provedores/:provedor/modelos — descobre o que a chave alcanca. */
  app.post('/api/ia/provedores/:provedor/modelos', { config: apenas.admin }, async (req) => {
    return service.descobrirModelos(req.tenantId, req.params.provedor);
  });

  app.patch('/api/ia/provedores/:provedor/modelos', { config: apenas.admin }, async (req) => {
    const { modelo, ativo } = alternarModeloSchema.parse(req.body);
    return service.alternarModelo(req.tenantId, req.params.provedor, modelo, ativo);
  });

  /** POST .../modelos/lote — "Ativar Aprovados" / "Desativar Reprovados". */
  app.post('/api/ia/provedores/:provedor/modelos/lote', { config: apenas.admin }, async (req) => {
    const { acao } = loteModelosSchema.parse(req.body);
    return service.acaoEmLoteModelos(req.tenantId, req.params.provedor, acao);
  });

  /**
   * GET /api/ia/provedores/:provedor/chave — o "olho" da tela.
   *
   * So o DONO pode: a chave da IA e um segredo que gasta dinheiro. Nao vai na
   * listagem; so sai daqui, quando alguem clica para ver, e fica na auditoria.
   * `no-store` impede o navegador ou um proxy de guardar a chave em cache.
   */
  app.get('/api/ia/provedores/:provedor/chave', { config: apenas.owner }, async (req, res) => {
    const r = await service.revelarChave(req.tenantId, req.params.provedor, { usuario: req.usuario });
    res.header('Cache-Control', 'no-store');
    return r;
  });

  // --- Agentes ---

  /**
   * POST /api/ia/provedores/:provedor/testar-modelos
   *
   * Inicia o teste de todos os modelos ativos e devolve NA HORA. Com 41
   * modelos e ate 1 minuto cada, a requisicao nao pode ficar pendurada; a
   * tela acompanha o `testeModelos` que vem em GET /api/ia/provedores.
   */
  app.post('/api/ia/provedores/:provedor/testar-modelos', { config: apenas.admin }, async (req) => {
    const { iniciado, total } = await service.iniciarTesteDeModelos(req.tenantId, req.params.provedor);
    return { iniciado, total };
  });

  // --- Agentes ---

  /**
   * Atendente pode LER o perfil dos agentes (pra saber com quem divide a mesa).
   * Junto vao os catalogos que a tela precisa para montar os controles:
   * as permissoes da Atena (checkboxes) e os tons de voz da Sofia (select).
   */
  app.get('/api/ia/agentes', { config: apenas.atendente }, async (req) => {
    return {
      agentes: await service.listarAgentes(req.tenantId),
      permissoesAtena: service.gruposDaAtena(),
      tons: service.tonsDisponiveis()
    };
  });

  app.put('/api/ia/agentes/:chave', { config: apenas.admin }, async (req) => {
    const dados = salvarAgenteSchema.parse(req.body);
    const agente = await service.salvarAgente(req.tenantId, req.params.chave, dados, { usuario: req.usuario });
    return { agente };
  });

  // --- Uso e teste ---

  /** GET /api/ia/uso — consumo e confiabilidade dos ultimos dias. */
  app.get('/api/ia/uso', { config: apenas.admin }, async (req) => {
    const dias = Number(req.query.dias) || 7;
    return service.uso(req.tenantId, { dias: Math.min(Math.max(dias, 1), 365) });
  });

  /** POST /api/ia/experimentar — testa um prompt sem mexer em conversa real. */
  app.post('/api/ia/experimentar', { config: apenas.admin }, async (req) => {
    const dados = experimentarSchema.parse(req.body);
    return service.experimentar(req.tenantId, dados);
  });

  /**
   * POST /api/ia/simular
   *
   * Conversa de teste com os "bastidores" (o que a Sofia pediu, o que a Atena
   * consultou). Nao envia nada a canal nenhum e, por padrao, nao grava no banco.
   */
  app.post('/api/ia/simular', { config: apenas.admin }, async (req) => {
    const dados = simularSchema.parse(req.body);
    return simular({ tenantId: req.tenantId, ...dados });
  });

  /** GET /api/ia/banco — quanto ha em cada tabela e o tamanho do arquivo. */
  app.get('/api/ia/banco', { config: apenas.admin }, async (req) => {
    return service.estatisticasDoBanco(req.tenantId);
  });
}
