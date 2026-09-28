import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { carimbos, colunaTenant, instante, jsonTexto } from './_shared.js';

/**
 * Provedor de IA configurado pela empresa (Gemini, Groq, OpenAI, Ollama).
 *
 * SOBRE A CHAVE DE API:
 * no sistema antigo a chave ficava em texto puro no banco E a rota
 * `GET /api/ai/status` devolvia ela inteira pra qualquer um que chamasse,
 * sem login. Aqui ela e guardada cifrada (veja `core/crypto.js`) e NUNCA sai
 * pela API — o que o front recebe e so os 4 ultimos caracteres, o suficiente
 * pra pessoa conferir qual chave esta ativa.
 */
export const aiProviders = sqliteTable(
  'ai_providers',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    provedor: text('provedor', { enum: ['gemini', 'groq', 'openai', 'anthropic', 'ollama'] }).notNull(),

    /** Cifrada com AES-256-GCM a partir do APP_SECRET. Nunca em texto puro. */
    apiKeyCifrada: text('api_key_cifrada'),
    /** Ultimos 4 caracteres, so pra exibir na tela. Nao e segredo. */
    apiKeySufixo: text('api_key_sufixo'),

    baseUrl: text('base_url'),
    modeloPadrao: text('modelo_padrao'),
    /**
     * O modelo primario foi escolhido pela PESSOA (true) ou pelo sistema (false)?
     *
     * Depois de cada teste de modelos o sistema escolhe sozinho o melhor para
     * atendimento — mas so enquanto a pessoa nao escolheu um. Escolha manual
     * nunca e sobrescrita, nem quando o teste dela falha: pode ser so uma
     * oscilacao do Google, e a decisao de trocar e de quem esta no comando.
     */
    modeloManual: integer('modelo_manual', { mode: 'boolean' }).notNull().default(false),

    habilitado: integer('habilitado', { mode: 'boolean' }).notNull().default(false),
    /** Ordem na cascata: 1 tenta primeiro. */
    prioridade: integer('prioridade').notNull().default(100),

    /** Resultado do ultimo teste de cada modelo: `[{ nome, ok, latenciaMs, ativo }]`. */
    modelos: jsonTexto('modelos', []),
    testadoEm: instante('testado_em'),

    ...carimbos()
  },
  (t) => [
    uniqueIndex('idx_ai_tenant_provedor').on(t.tenantId, t.provedor),
    index('idx_ai_tenant_prioridade').on(t.tenantId, t.prioridade)
  ]
);

/**
 * Perfil de agente = a personalidade e as instrucoes de uma IA com uma funcao.
 *
 * O sistema antigo tinha dois "agentes", mas so um deles usava IA de verdade —
 * o outro era uma cadeia de `if` com palavras-chave, apesar de ter um campo
 * `model` no banco que nao era lido por ninguem.
 *
 * Aqui todo perfil cadastrado e, de fato, um perfil de IA. A consulta
 * deterministica ao banco (precos, horarios) nao virou "agente": virou
 * ferramenta, em `ai/tools/`. Ferramenta nao precisa de temperatura nem de
 * tom de voz — precisa de estar certa.
 */
export const agentProfiles = sqliteTable(
  'agent_profiles',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    /** Funcao do agente: 'atendente', 'classificador_humor', 'redator_campanha'. */
    chave: text('chave').notNull(),
    nome: text('nome').notNull(),
    avatar: text('avatar'),

    systemPrompt: text('system_prompt').notNull().default(''),
    tom: text('tom').notNull().default('acolhedor'),
    /**
     * Temperatura em milesimos (700 = 0.7).
     *
     * Guardada como inteiro porque SQLite guarda decimal como ponto flutuante,
     * e 0.7 nao tem representacao exata em binario — ler de volta pode devolver
     * 0.6999999999999999. Inteiro entra e sai identico. A divisao por 1000
     * acontece na hora de montar a chamada da IA.
     */
    temperaturaMilesimos: integer('temperatura_milesimos').notNull().default(700),

    /** Nulo = usa a cascata normal de provedores. */
    modeloPreferido: text('modelo_preferido'),
    maxTokens: integer('max_tokens').notNull().default(800),

    /** Quais ferramentas este agente pode acionar: `['listar_servicos', ...]`. */
    ferramentas: jsonTexto('ferramentas', []),

    /**
     * Ajustes proprios de cada agente que nao cabem nas colunas comuns.
     * Aquiles: `{ exemplos: string[], herdarSofia: boolean }` — mensagens
     * modelo para imitar o jeito de escrever, e se fala com a voz da Sofia.
     */
    config: jsonTexto('config', {}),

    ativo: integer('ativo', { mode: 'boolean' }).notNull().default(true),

    ...carimbos()
  },
  (t) => [uniqueIndex('idx_agents_tenant_chave').on(t.tenantId, t.chave)]
);

/**
 * Menu de atendimento (a arvore de opcoes numeradas do WhatsApp).
 *
 * Guardar a arvore inteira em JSON e proposital: ela e editada e lida sempre
 * como um bloco unico, nunca em pedacos, e a empresa muda a estrutura dela
 * com frequencia. Normalizar isso em tabelas daria junções recursivas pra
 * montar um menu que cabe em 2 KB.
 */
export const menuFlows = sqliteTable(
  'menu_flows',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    nome: text('nome').notNull().default('Menu principal'),
    mensagemBoasVindas: text('mensagem_boas_vindas').notNull().default(''),
    mensagemErro: text('mensagem_erro').notNull().default(''),

    /**
     * Formato ANTIGO (arvore): `[{ id, titulo, acao, respostaCustomizada, subOpcoes }]`.
     * So e lido quando `fluxo` ainda esta vazio — ai e convertido na hora.
     */
    opcoes: jsonTexto('opcoes', []),

    /**
     * O fluxo desenhado no editor visual, no formato do n8n
     * (`{ versao, inicio, nodes, connections, config }`). Ver
     * `modules/atendimento/fluxo.js`, que define e valida a estrutura.
     */
    fluxo: jsonTexto('fluxo', {}),

    ativo: integer('ativo', { mode: 'boolean' }).notNull().default(true),

    ...carimbos()
  },
  (t) => [index('idx_menus_tenant_ativo').on(t.tenantId, t.ativo)]
);

/**
 * Registro de cada chamada de IA.
 *
 * Existe por tres motivos concretos:
 *  1. CUSTO — sem isto ninguem sabe quanto a IA gastou no mes, nem qual
 *     empresa gastou mais. Descobrir isso pela fatura do provedor e tarde demais.
 *  2. DEPURACAO — quando a IA responde uma bobagem, da pra ver exatamente qual
 *     prompt gerou aquilo e qual modelo respondeu.
 *  3. CASCATA — mostra com que frequencia o provedor principal falha e o
 *     sistema precisa cair pro reserva.
 */
export const aiCalls = sqliteTable(
  'ai_calls',
  {
    id: text('id').primaryKey(),
    tenantId: colunaTenant(),

    /** De onde partiu: 'atendimento', 'campanha', 'humor', 'transcricao'. */
    origem: text('origem').notNull(),
    agentKey: text('agent_key'),

    provedor: text('provedor').notNull(),
    modelo: text('modelo').notNull(),

    sucesso: integer('sucesso', { mode: 'boolean' }).notNull(),
    latenciaMs: integer('latencia_ms').notNull().default(0),

    tokensEntrada: integer('tokens_entrada').notNull().default(0),
    tokensSaida: integer('tokens_saida').notNull().default(0),

    /** Tentativas que falharam antes desta dar certo: `[{ provedor, modelo, erro }]`. */
    tentativas: jsonTexto('tentativas', []),
    erro: text('erro'),

    conversationId: text('conversation_id'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date())
  },
  (t) => [
    index('idx_aicalls_tenant_data').on(t.tenantId, t.createdAt),
    index('idx_aicalls_tenant_origem').on(t.tenantId, t.origem)
  ]
);

/**
 * Totais MENSAIS das chamadas de IA antigas.
 *
 * `ai_calls` guarda uma linha por chamada e e a tabela que mais cresce. O
 * detalhe fica ~90 dias (depurar, ver o que falhou); passado disso, cada mes
 * INTEIRO vira uma linha por combinacao (origem, agente, provedor, modelo) —
 * os relatorios de uso e custo por mes e por ANO continuam exatos.
 * Ver modules/ia/uso-antigo.js.
 */
export const aiCallsMensais = sqliteTable(
  'ai_calls_mensais',
  {
    tenantId: colunaTenant(),
    /** 'AAAA-MM', no fuso da empresa (o mesmo mes que o relatorio mostra). */
    mes: text('mes').notNull(),
    origem: text('origem').notNull(),
    /** '' quando a chamada nao tinha agente (a chave unica nao aceita nulo). */
    agentKey: text('agent_key').notNull().default(''),
    provedor: text('provedor').notNull(),
    modelo: text('modelo').notNull(),
    chamadas: integer('chamadas').notNull().default(0),
    sucessos: integer('sucessos').notNull().default(0),
    tokensEntrada: integer('tokens_entrada').notNull().default(0),
    tokensSaida: integer('tokens_saida').notNull().default(0),
    /** Soma da latencia das chamadas COM sucesso: media = soma / sucessos. */
    latenciaSomaSucessoMs: integer('latencia_soma_sucesso_ms').notNull().default(0)
  },
  (t) => [uniqueIndex('uq_aicalls_mensais').on(t.tenantId, t.mes, t.origem, t.agentKey, t.provedor, t.modelo)]
);

/**
 * Configuracoes da empresa, em formato chave-valor.
 *
 * Para preferencias que nao merecem coluna propria: modo de atendimento,
 * tamanho da janela de contexto, segundos de agrupamento de mensagem.
 * O valor vai em JSON pra aceitar numero, texto, booleano ou objeto.
 */
export const settings = sqliteTable(
  'settings',
  {
    tenantId: colunaTenant(),
    chave: text('chave').notNull(),
    valor: jsonTexto('valor', null),
    descricao: text('descricao'),

    ...carimbos()
  },
  (t) => [uniqueIndex('idx_settings_tenant_chave').on(t.tenantId, t.chave)]
);
