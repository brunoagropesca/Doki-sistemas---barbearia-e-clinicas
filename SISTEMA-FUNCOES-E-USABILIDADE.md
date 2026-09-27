# Especificação Técnica, Funcional e Usabilidade do Sistema (Doki Sistemas)

> **Público-alvo deste documento:** Modelos de Linguagem (LLMs) e Agentes de IA que precisam compreender a arquitetura, regras de negócio, catálogo de ferramentas, fluxos e usabilidade operacional completa da plataforma.

---

## 1. Visão Geral e Arquitetura

O sistema é uma plataforma completa de **CRM, Atendimento Multicanal (WhatsApp), Agenda Inteligente e Campanhas Ativas com Inteligência Artificial** para estabelecimentos baseados em agendamento de serviços (barbearias, salões de beleza e clínicas odontológicas/médicas).

### 🛠️ Stack Tecnológica
* **Backend:** Node.js (v22+) + Fastify + Drizzle ORM (SQLite/libsql via `better-sqlite3`/`libsql`) + Zod para validação estrita de esquemas.
* **Frontend:** React + Vite + `@tanstack/react-query` + `@xyflow/react` (fluxos visuais interativos) + Design System próprio com tokens CSS.
* **Comunicação em Tempo Real:** Server-Sent Events (SSE via rota `/api/eventos`).
* **WhatsApp:** Adaptador próprio construído sobre `@whiskeysockets/baileys` (gerencia até 5 conexões simultâneas: `W1` a `W5`).
* **Processamento de Áudio:** `ffmpeg-static` para remux quase instantâneo sem perda (`webm/opus` do navegador ⇄ `ogg/opus` com waveform nativo do WhatsApp).

### 🛡️ Princípios Arquiteturais Inegociáveis
1. **Multi-tenant rígido:** Toda tabela e query possui `tenant_id` como primeira chave. Nenhuma consulta acessa dados de outro estabelecimento.
2. **Soft-delete universal:** Nada é excluído fisicamente do banco de dados; utiliza-se a coluna `deleted_at`. O histórico financeiro e de atendimentos permanece íntegro.
3. **Dinheiro como inteiro:** Todos os valores monetários são gravados em **centavos** (ex.: `R$ 45,00` = `4500`). Operações de ponto flutuante são proibidas para evitar imprecisões.
4. **Data e Hora absolutas:** Armazenadas em milissegundos UTC (timestamp); os cálculos de fuso e dia da semana usam a timezone da empresa (`tenant.fuso_horario`).
5. **Cálculo dinâmico de agenda:** Horários livres não são listas estáticas no código. São calculados sob demanda a partir de: jornada de trabalho do profissional + duração do serviço + intervalo de limpeza/higienização + bloqueios de agenda e agendamentos existentes.
6. **Perfis de Acesso (RBAC):**
   * `dev`: Cargo temporário invisível (ativado por arquivo físico `CRIAR-DEV.bat`). Gerencia conexões WhatsApp, backups, migrações estruturais e banco de demonstração. Rotas exclusivas de DEV retornam 404 para os demais cargos.
   * `owner` (Dono): Visão global de faturamento, campanhas, visualização de chaves de API cifradas, auditoria e gestão da equipe.
   * `admin` (Gerente): Operação gerencial, relatórios e equipe, sem acesso às chaves mestras e infraestrutura do DEV.
   * `atendente` (Recepção/Atendente): Conversas atribuídas a si, fila humana, contatos, agenda diária e catálogo de serviços.

---

## 2. Ecossistema dos Três Agentes de IA

A inteligência da plataforma é dividida em três personas com responsabilidades e travas isoladas:

```
[ Cliente no WhatsApp ]
        │
        ▼
   ┌─────────┐                ┌──────────────────┐
   │  SOFIA  │ ──(Marca/Altera)─▶│      ATENA       │ ──(Escrita)──▶ [ Banco de Dados ]
   │ (Front) │ ◀─(Resumo Fatos)──│ (Cérebro/Agenda) │
   └─────────┘                   └──────────────────┘
        │
   (Lê horários/catálogo direto)
        │
        ▼
[ Banco de Dados ]

                                 ┌──────────────────┐
                                 │     AQUILES      │ ──(Disparo)──▶ [ Campanhas WhatsApp ]
                                 │ (Redator 1 a 1)  │
                                 └──────────────────┘
```

### 1. Sofia (Atendente de Frente / WhatsApp)
* **Função:** Atendimento em linguagem natural, acolhimento, triagem e negociação de horários com o cliente.
* **Comportamento:** Calorosa, empática, fluida e resolutiva. **Nunca inventa preços nem horários**.
* **Leituras Diretas (sem acordar a Atena):** Consulta disponibilidade de horários, vagas em sequência e agendamentos do cliente por código puro. Economiza milhares de tokens por mensagem.
* **Escritas:** Só pode executar `reservar_horario` para horários que o próprio sistema ofertou nos últimos 120 minutos (sistema de **Ofertas**). Pedidos complexos de reagendamento ou cancelamento são delegados para a Atena.

### 2. Atena (Cérebro Operacional / Backoffice)
* **Função:** Execução de regras de negócio estritas de agendamento, cancelamento, reagendamento e funil de atendimento.
* **Comportamento:** Factual, analítica e concisa. Responde para a Sofia em blocos de fatos estruturados (`FEITO`, `NÃO FEITO`, `OPÇÕES`, `FALTA`).
* **Travas de Segurança:**
  * **Escopo:** Só manipula agendamentos pertencentes ao cliente da sessão atual.
  * **Histórico protegido:** Proibida de excluir agendamentos nos estados `concluido`, `em_andamento` ou `faltou`.
  * **Teto de escritas:** Máximo de 5 modificações por turno (evita alucinações em loop).
  * **Sem autoridade de preço:** Não concede descontos nem altera valores de serviços (isso cabe exclusivamente a uma pessoa).

### 3. Aquiles (Copywriter de Campanhas em Massa)
* **Função:** Escrever mensagens personalizadas 1 a 1 para disparos em lote no WhatsApp.
* **Comportamento:** Analisa histórico do cliente (tempo ausente, serviços habituais, gastos) para gerar mensagens humanas e contextuais.
* **Filtros Anti-robô:** Bloqueia clichês como *"vi no sistema que você..."*, remove emojis de tom de pele soltos e respeita níveis de ousadia e tamanho.

### 4. Cascata de Provedores e Transcrição
* **Provedores Suportados:** Google Gemini, Groq, OpenAI, Ollama.
* **Fallback automático:** Falhas de cota ou rede acionam o próximo provedor na fila de prioridade configurada.
* **Transcrição de Voz:** Áudios recebidos dos clientes são transcritos via cascata própria (**Groq Whisper** como primário ultra-rápido, **Gemini Flash Multimodal** como reserva). O áudio transcrito vira o texto da mensagem para o bot. Se ambos falharem, a conversa é transferida para a fila humana.

---

## 3. Catálogo de Módulos e Funcionalidades

| Módulo / Menu | Funções Principais | Usabilidade e Regras de Negócio |
|---|---|---|
| **Conversas (Livechat)** | Atendimento humano x bot, envio de mensagens de texto, áudios com player próprio, anexos (fotos, PDFs, vídeos) com editor embutido (desenho, texto, corte), emojis nativos. | • Alternância de controle: `bot` (Sofia) vs `humana` (atendente).<br>• Respostas rápidas com atalho `/` e variáveis dinâmicas (`{nome}`, `{saudacao}`, `{atendente}`).<br>• Subchat interno da Atena (cor laranja) para o atendente dar comandos `/atena` sem vazar pro cliente.<br>• Rascunhos salvos no `localStorage` por conversa.<br>• Resumos automáticos gerados por IA ao finalizar a conversa em segundo plano. |
| **Agenda** | Grade de horários por profissional, criação manual de agendamentos (OS), bloqueios de horário, cancelamentos e faltas. | • Respeita jornada de trabalho de cada profissional.<br>• Cálculo de tempo de serviço + intervalo de limpeza/higienização.<br>• Suporte a múltiplos serviços na mesma visita (encadeamento atômico sem sobreposição). |
| **Quadro (Kanban)** | Visualização rápida do status dos atendimentos do dia e das conversas em andamento. | • Colunas por etapa (Novo, Entendendo, Orçamento, Aguardando, Confirmado, Concluído).<br>• **Cartão pisca em laranja** quando um cliente precisa de intervenção humana (está na fila ou sem resposta após envio). Conversas com a IA ativa não disparam alarme falso. |
| **Catálogo** | Cadastro de Serviços, Categorias e Produtos de balcão/estoque. | • Serviços possuem preço, duração e profissionais vinculados.<br>• Profissional pode ter preço e duração próprios para o mesmo serviço.<br>• Controle de estoque simples para produtos físicos. |
| **Contatos (CRM / Leads)** | Ficha completa do cliente, histórico unificado de conversas e agendamentos, tags, notas internas. | • Histórico de receita gerada e frequência de retorno.<br>• Identificação automática de clientes em risco de churn (ex.: sumidos há 45+ dias).<br>• Linha do tempo das conversas com resumo da IA e humor do cliente. |
| **Campanhas** | Assistente em 5 etapas para disparos em massa via WhatsApp com personalização via Aquiles. | • Etapas: Criação → Filtro de Leads → Configuração IA → Revisão Cartão a Cartão → Envio Controlado.<br>• **Proteção anti-bloqueio:** Janela de horários permitida, descanso aleatório entre envios, simulação de "digitando…", limite diário.<br>• **Regra de ouro:** Bloqueio de reenvio por 15 dias para o mesmo cliente; clientes com horário futuro agendado não recebem convite de agendamento. |
| **Central de IA** | Gerenciamento de Provedores/Chaves, Personas dos Agentes, Base de Conhecimento e Simulador de Atendimento. | • **Base de Conhecimento:** Identidade, Endereço, Regras da Casa, Formas de Pagamento/Pix e FAQs injetados no prompt da Sofia.<br>• **Simulador:** Chat para testar o comportamento da Sofia/Atena com visualização dos bastidores (logs de ferramentas acionadas) em modo somente-leitura ou escrita. |
| **Menu Tradicional (Fluxo n8n)** | Editor visual em canvas com nós arrastáveis para montar o menu interativo do WhatsApp. | • Tipos de Nós: `menu` (opções 1 a 5), `mensagem`, `servicos` (lista dinâmica), `atendente` (vai pra fila) e `sofia` (entrega para a IA).<br>• Memória de navegação (`menu_estado`): digitar "0" volta ao nível anterior; expira após 60 min de inatividade. |
| **Equipe & Presença** | Cadastro de profissionais (prestadores) e atendentes (usuários do sistema), escalas e jornadas. | • **Monitor de Presença:** Conectado à sessão SSE do navegador. Usuário fica "ausente" 5 minutos após fechar a última aba do painel, saindo da distribuição automática.<br>• Definição de limites de conversas simultâneas por atendente. |
| **Conexões WhatsApp** | Pareamento via QR Code (Baileys), monitoramento de conexão e console de eventos em tempo real. | • Até 5 números simultâneos (W1–W5).<br>• Opção de **recusa automática de chamadas de voz/vídeo** com envio de mensagem explicativa de aviso.<br>• Reconexão exponencial inteligente para quedas temporárias de rede. |
| **Dashboard & Métricas** | Relatórios gerenciais de desempenho, conversão e financeiro para o Dono. | • Mapas de calor 7×24 de faturamento, novos clientes e horários de pico.<br>• Métricas de conversão do bot e desempenho individual de atendentes.<br>• **Exportação para Excel (.xlsx):** Gera planilhas nativas ricas com abas analíticas sem dependências pesadas. |
| **Perfil Pessoal** | Gestão de dados do atendente logado. | • Edição de nome, avatar e troca de senha.<br>• Gerenciador de Respostas Rápidas individuais e atalhos de teclado. |
| **Demonstração (DEV)** | Gerador de banco de dados sintético completo para testes e demonstrações de venda. | • Cria uma empresa fictícia completa ("Estilo & Arte") com 90 dias de histórico, profissionais, centenas de agendamentos e conversas com IA realistas sem encostar no banco de produção. |

---

## 4. Usabilidade e Ergonomia dos Atendentes (Mesa de Atendimento)

Regras de usabilidade implementadas para a operação humana no dia a dia:

1. **Distribuição Justa e Privacidade:**
   * Atendentes normais visualizam apenas as conversas sob sua responsabilidade e a fila geral desatribuída. Donos/Gerentes enxergam todas.
   * A distribuição automática prioriza o atendente online com menor número de conversas ativas em relação ao seu teto configurado.
2. **Transferência Transparente:**
   * Ao transferir uma conversa para outro colega, é obrigatório registrar um motivo. O colega de destino recebe uma notificação instantânea com o nome de quem passou e o contexto, e os alertas antigos daquela conversa somem da tela do atendente anterior.
3. **Preservação de Rascunho:**
   * Se um atendente estiver digitando uma resposta longa e outro colega assumir a conversa no mesmo segundo, o texto não se perde: o sistema armazena em `localStorage` e exibe um painel com aviso explicativo e o botão "Copiar o que você tinha escrito".
4. **Comandos Internos no Chat:**
   * Digitar `/` no campo de texto abre o menu suspenso de Respostas Rápidas.
   * O atendente pode acionar o subchat da Atena (interface laranja) para solicitar que a IA faça alterações na agenda sem que o cliente veja a interação.
5. **Assinatura do Atendente:**
   * As respostas enviadas por atendentes humanos levam automaticamente a assinatura configurada (ex.: `*Camila:* Olá...`), mantendo a transparência e humanização.

---

## 5. Catálogo Completo de Ferramentas (Tools) da IA

### 🛠️ Ferramentas da Sofia (`sofia.tools.js`)

| Nome da Ferramenta | Tipo | Descrição e Parâmetros |
|---|---|---|
| `consultar_horarios` | Leitura | Consulta horários livres e preço de um serviço em uma data. Se o dia estiver lotado, já calcula automaticamente a próxima data com vaga nos próximos 14 dias.<br>• `servicoId` (string, obrigatório): Nome ou termo do serviço.<br>• `profissionalId` (string, opcional): Nome do profissional desejado.<br>• `data` (string, opcional): Data natural ("hoje", "amanhã", "sexta", "dia 25"). |
| `consultar_varios_servicos` | Leitura | Planeja múltiplos serviços em sequência na mesma visita, calculando encaixes dinâmicos e menor tempo de espera entre profissionais.<br>• `servicos` (array de strings, obrigatório): Lista de serviços desejados.<br>• `profissional` (string, opcional): Preferência de profissional.<br>• `data` / `hora` (opcionais). |
| `consultar_agendamentos_do_cliente` | Leitura | Lista os agendamentos já marcados para o cliente da conversa.<br>• `apenasFuturos` (boolean, opcional): Filtrar apenas compromissos a realizar. |
| `reservar_horario` | Escrita | **Marca o horário consultado**. Valida se os dados enviados batem com uma oferta gerada pelas consultas dos últimos 120 minutos nesta conversa.<br>• `servicos` (array de strings)<br>• `profissional` (string, opcional)<br>• `data` (string formato AAAA-MM-DD)<br>• `hora` (string HH:MM) |
| `consultar_atena` | Escrita/Delegação | Delega ações complexas (remarcar, cancelar ou regras especiais) ao agente Atena em linguagem natural.<br>• `pedido` (string): Descrição detalhada do comando. |
| `consultar_informacoes` | Leitura | Consulta a Base de Conhecimento da empresa (regras da casa, Wi-Fi, endereço, estacionamento, convênios).<br>• `assunto` (string, opcional). |
| `transferir_para_humano` | Controle | Transfere a conversa imediatamente para a fila de atendimento humano.<br>• `motivo` (string): Contexto da transferência.<br>• `cliente_frustrado` (boolean): Aciona alerta de urgência se o cliente demonstrar irritação. |

---

### 🛠️ Ferramentas da Atena (`atena.tools.js`)

| Nome da Ferramenta | Tipo | Descrição e Parâmetros |
|---|---|---|
| `listar_servicos` | Leitura | Retorna catálogo de serviços com preços, durações e profissionais habilitados. |
| `listar_profissionais` | Leitura | Retorna lista de profissionais e especialidades/serviços que atendem. |
| `consultar_dados_do_cliente` | Leitura | Retorna histórico do cliente: nome, telefone, etiquetas, histórico de faltas e visitas concluídas. |
| `criar_agendamento` | Escrita | Cria agendamento atômico de um serviço garantindo ausência de duplicidade e conflito de horário.<br>• `servicoId`, `profissionalId`, `data`, `hora`, `observacoes`. |
| `agendar_varios_servicos` | Escrita | Registra uma sequência de múltiplos serviços em visita única (operação "tudo ou nada"). |
| `remarcar_agendamento` | Escrita | Altera data, horário ou profissional de um agendamento existente do cliente.<br>• `agendamentoId`, `data`, `hora`, `profissionalId`. |
| `cancelar_agendamento` | Escrita | Cancela um agendamento do cliente, mantendo o registro para fins de histórico e métricas.<br>• `agendamentoId`, `motivo`. |
| `excluir_agendamento` | Escrita | Remove um agendamento criado por engano (só permitido para status `pendente`, `confirmado` ou `cancelado`). |
| `atualizar_agendamento` | Escrita | Atualiza apenas o campo de observações da OS (alergias, pedidos especiais). **Não aceita novos preços**. |
| `mover_etapa_atendimento` | Escrita | Move o lead no Kanban de atendimento interno (`novo`, `entendendo`, `orcamento`, `aguardando`). |

---

## 6. Tratamento de Casos Especiais e Resiliência

1. **Áudios de Clientes:**
   * Nunca são ignorados. São transcritos via Groq/Gemini antes de acionar a Sofia. Se o áudio for inaudível ou o serviço falhar, transfere para humano com áudio preservado no player do chat.
2. **Datas em Linguagem Natural:**
   * Expressões como *"depois de amanhã"*, *"próxima terça"* e *"dia 10"* são resolvidas por script determinístico antes de chegar à agenda (`interpretarData`), evitando erros de interpretação temporal e timezone do LLM.
3. **Ligações de WhatsApp Recusadas:**
   * O sistema detecta chamadas de voz e vídeo recebidas, rejeita a chamada automaticamente e envia uma mensagem de texto configurável explicando que o canal opera apenas via mensagens.
4. **Proteção contra Alucinações de Bastidores:**
   * O filtro de saída sanitiza termos como *"Atena"*, *"ferramenta"*, marcadores internos ou formatações Markdown brutas indesejadas antes de entregar o texto ao cliente.
