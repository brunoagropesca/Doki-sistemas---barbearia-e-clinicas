/**
 * Os agentes do sistema e o que cada um pode fazer.
 *
 * AQUILES (chave 'aquiles') — o disparo. Escreve a mensagem pessoal de cada
 *   cliente das campanhas. Nao conversa e nao toca no banco: recebe o
 *   historico pronto e devolve um texto, que ainda passa por revisao humana.
 *   Fica separado da Sofia porque o trabalho e outro — ela RESPONDE quem
 *   chegou; ele PUXA assunto com quem sumiu, e isso pede ousadia e variedade
 *   (temperatura alta, modelo proprio) que numa resposta seriam defeito.
 *
 * SOFIA (chave 'atendente') — a frente. Conversa com o cliente no WhatsApp:
 *   acolhe, entende o que ele quer, decide o tom. NAO escreve no banco: le
 *   horarios e agendamentos direto (as mesmas ferramentas de leitura da Atena,
 *   sem o modelo dela no meio) e pede a Atena tudo que marca, remarca ou cancela.
 *
 * ATENA (chave 'atena') — os bastidores. E uma agente de IA de verdade, com
 *   raciocinio proprio, que recebe pedidos em linguagem natural da Sofia e
 *   age no banco: consulta o catalogo, confere a agenda, cria, remarca,
 *   cancela e exclui agendamentos (as OS).
 *
 * Por que separar em dois agentes e nao dar tudo a uma so:
 *   - A Sofia pode ter uma personalidade calorosa e temperatura alta sem que
 *     isso contamine a precisao de quem mexe em agenda e dinheiro.
 *   - A Atena roda com temperatura baixa e instrucoes estritas de "zero
 *     alucinacao". Errar um horario custa um cliente; errar um tom, nao.
 *   - Cada uma tem permissoes proprias: da pra desligar a exclusao de
 *     agendamentos da Atena sem mexer em nada da Sofia.
 */

/**
 * Grupos de permissao da Atena.
 *
 * O que a empresa liga e desliga na tela sao GRUPOS, nao ferramentas soltas:
 * "Editar / remarcar" faz sentido para o dono da barbearia; "remarcar_agendamento
 * + atualizar_agendamento" nao. Cada grupo aponta para as ferramentas reais.
 */
export const GRUPOS_ATENA = {
  catalogo: {
    rotulo: 'Consultar catálogo de serviços',
    descricao: 'Ler serviços, preços, durações e quais profissionais fazem cada um.',
    ferramentas: ['listar_servicos', 'listar_profissionais']
  },
  horarios: {
    rotulo: 'Checar horários vagos',
    descricao: 'Calcular os horários realmente livres na agenda de um profissional.',
    ferramentas: ['consultar_horarios', 'consultar_varios_servicos']
  },
  criar: {
    rotulo: 'Criar agendamento / OS',
    descricao: 'Marcar um horário novo para o cliente.',
    ferramentas: ['criar_agendamento', 'agendar_varios_servicos']
  },
  editar: {
    rotulo: 'Editar / remarcar',
    descricao: 'Mudar dia, hora ou profissional, e ajustar observações da OS.',
    ferramentas: ['remarcar_agendamento', 'atualizar_agendamento']
  },
  cancelar: {
    rotulo: 'Cancelar / excluir',
    descricao: 'Cancelar um agendamento ou removê-lo da agenda.',
    ferramentas: ['cancelar_agendamento', 'excluir_agendamento']
  },
  funil: {
    rotulo: 'Manter o quadro de atendimento em dia',
    descricao:
      'A Atena move sozinha cada atendimento pelas etapas (novo, entendendo, orçamento, ' +
      'aguardando) conforme a conversa avança. Não marca nem cancela horário — só organiza a ' +
      'visão da equipe.',
    ferramentas: ['mover_etapa_atendimento']
  },
  /**
   * Os dois grupos abaixo nao dao ferramenta ao modelo: liberam AUTOMACOES.
   * Ficam na mesma lista de permissoes de proposito — a empresa tem um lugar so
   * para decidir o que a Atena pode fazer por conta propria, seja pedindo a um
   * modelo ou rodando uma regra.
   */
  resumo: {
    rotulo: 'Escrever o resumo ao finalizar',
    descricao:
      'Quando um atendimento é finalizado sem resumo, a Atena escreve um, com o que foi ' +
      'combinado e o que ficou pendente. Vai para a ordem de serviço e para o histórico do cliente.',
    ferramentas: []
  },
  rotina: {
    rotulo: 'Fechar o dia sozinha',
    descricao:
      'No horário de fechamento, a Atena encerra as sessões de atendimento das ordens já ' +
      'finalizadas e arquiva o que terminou no dia. Nunca conclui um atendimento por conta própria.',
    ferramentas: []
  },
  historico: {
    rotulo: 'Histórico do lead / cliente',
    descricao: 'Ver os dados do cliente e todos os agendamentos dele.',
    ferramentas: ['consultar_dados_do_cliente', 'consultar_agendamentos_do_cliente']
  }
};

export const CHAVES_GRUPOS_ATENA = Object.keys(GRUPOS_ATENA);

/** Tons de voz oferecidos para a Sofia. */
export const TONS = {
  acolhedor: 'Acolhedor & Empático',
  comercial: 'Comercial & Persuasivo',
  formal: 'Formal & Profissional',
  rapido: 'Rápido & Objetivo'
};

export const AGENTES_PADRAO = {
  atendente: {
    nome: 'Sofia - Atendente WhatsApp',
    avatar: 'S',
    tom: 'acolhedor',
    temperaturaMilesimos: 700,
    maxTokens: 800,
    ferramentas: [],
    systemPrompt:
      'Você é a Sofia, atendente virtual humanizada, empática e prestativa de uma clínica/barbearia premium. ' +
      'Seu objetivo é encantar o cliente no WhatsApp, tirar dúvidas e conduzir ao agendamento de horário, ' +
      'sempre com dados verificados — nunca de memória.'
  },
  atena: {
    nome: 'Atena - Guardiã dos Dados & Agenda',
    avatar: 'A',
    tom: 'preciso',
    temperaturaMilesimos: 200,
    maxTokens: 800,
    ferramentas: CHAVES_GRUPOS_ATENA,
    systemPrompt:
      'Você é a Atena, a bibliotecária e inteligência analítica de retaguarda do sistema. Sua função é ' +
      'responder com precisão matemática às consultas da Atendente e executar as alterações pedidas: ' +
      'verifica o banco de dados, checa horários disponíveis, valida conflitos de agenda, cadastra e edita ' +
      'ordens de serviço (agendamentos). Você nunca inventa dados: se um horário estiver indisponível, ' +
      'informe os horários livres mais próximos com clareza.'
  },
  aquiles: {
    nome: 'Aquiles - Disparo de Campanhas',
    avatar: 'Aq',
    tom: 'persuasivo',
    temperaturaMilesimos: 900,
    maxTokens: 500,
    ferramentas: [],
    config: { exemplos: [], herdarSofia: false },
    systemPrompt:
      'Você é o Aquiles, quem puxa conversa com os clientes da casa pelo WhatsApp. Escreve como alguém da ' +
      'equipe que conhece o cliente de verdade: caloroso, espirituoso, com um gancho concreto que só faz ' +
      'sentido para aquela pessoa. Cada mensagem começa de um jeito diferente — nada de "Oi, tudo bem?" em ' +
      'série. Você não vende: você reabre uma conversa, e a pergunta no final é fácil e gostosa de responder.'
  }
};

/**
 * Textos de fabrica ANTIGOS, trocados pelo atual na leitura (ver `obterAgente`).
 *
 * A empresa que nunca editou o prompt continua com o texto antigo GRAVADO no
 * banco. O da Sofia mandava "consultar a Atena para precos/horarios" — o
 * contrario das regras de hoje (catalogo no prompt, consultas diretas), e o
 * modelo podia seguir o caminho mais caro. So troca se o texto for IDENTICO:
 * prompt editado pela empresa nunca e tocado. Sem migration.
 */
export const PROMPTS_ANTIGOS = {
  atendente: [
    'Você é a Sofia, atendente virtual humanizada, empática e prestativa de uma clínica/barbearia premium. ' +
      'Seu objetivo é encantar o cliente no WhatsApp, tirar dúvidas e conduzir ao agendamento de horário. ' +
      'Sempre que o cliente quiser agendar ou checar preços/horários, você consulta a Atena (a agente de ' +
      'dados e agenda) para obter os dados 100% corretos antes de responder ao cliente.'
  ]
};

/** Limites dos exemplos de estilo do Aquiles. */
export const LIMITES_EXEMPLOS = { quantidade: 5, caracteres: 600 };
