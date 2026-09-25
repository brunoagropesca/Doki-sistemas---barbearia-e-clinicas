# Adaptação do sistema para clínicas

Guia para levar a plataforma (hoje afinada para barbearia) a **clínicas**, com foco em **clínica odontológica**. O mesmo caminho serve para estética, fisioterapia, psicologia e consultórios médicos pequenos.

- **Base analisada:** `main` em `f1034e8` ("Assinatura do atendente"), 920 testes passando.
- **Princípio:** **um sistema só**, que muda de comportamento pelo **segmento** da empresa. Nada de copiar o projeto para uma versão "clínica": cada correção feita num lado teria de ser refeita no outro, para sempre.
- Ver também `DIFICULDADE-DE-ADAPTACAO.md`, nesta pasta: o relatório original, em linguagem direta, sobre o tamanho do esforço — este documento aqui é o roteiro de execução a partir dele.

---

## 1. Diagnóstico: quanto o sistema depende de "barbearia" hoje

**Pouco.** O núcleo é genérico:

| Parte | Situação para clínica |
|---|---|
| WhatsApp (Baileys), fila, livechat, transferência, assinatura do atendente | Pronto |
| Sofia (atendimento) e Atena (agenda) | Prontas; só o texto de fábrica fala em "clínica/barbearia" |
| Agenda por profissional, jornada, bloqueios, encaixe, vários serviços na mesma visita | Pronto |
| Lembrete de véspera (Inteligência Artificial › Agentes › "Lembrete na Véspera") | Pronto, e é o recurso que mais reduz falta em consultório |
| Campanhas (Aquiles), painel do dono, exportação para Excel | Prontos, com ressalvas de publicidade (seção 6) |
| Base de conhecimento (endereço, pagamento, horário, perguntas frequentes) | Pronta |
| Textos da interface editáveis (perfil DEV › Textos do sistema) | Pronto: troca "Cliente" por "Paciente" sem código |
| Campo `segmento` da empresa (`tenants.segmento`: barbearia, clinica, salao, outro) | **Existe, mas nenhum código o usa** |

Onde "barbearia" aparece no código: textos de exemplo das telas (placeholders), o prompt de fábrica da Sofia, o seed de demonstração (Carlos/Julia, Corte Degradê…) e o gerador do banco de demonstração. **Nenhuma regra de negócio depende disso.**

O que falta está nas seções 3 e 4: coisas que clínica precisa e barbearia não.

---

## 2. Fase 0 — Colocar uma clínica para rodar só configurando (sem código)

Checklist de implantação, na tela, para uma clínica pequena usar já:

1. **Empresa e base de conhecimento** (Inteligência Artificial › Base de conhecimento):
   - nome, logo, "sobre";
   - endereço, estacionamento, acessibilidade;
   - formas de pagamento, parcelamento;
   - convênios aceitos (em texto, por enquanto);
   - perguntas frequentes: "atende criança?", "faz clareamento?", "precisa de avaliação?".
2. **Profissionais** (Equipe): cada dentista com a jornada dele e os procedimentos que faz. Duração e preço podem ser diferentes por profissional.
3. **Catálogo** (Catálogo): procedimentos com duração realista. Crie **"Avaliação"** como o procedimento de entrada: é o que a Sofia deve oferecer quando o paciente não sabe o que precisa. Para procedimentos sem preço fixo, **por enquanto** use o preço da avaliação e explique na base de conhecimento. A solução definitiva está na seção 3.2.
4. **Sofia** (Inteligência Artificial › Agentes): reescrever o prompt de personalidade para clínica. Sugestão:
   > Você é a Sofia, recepcionista virtual da clínica {nome}. Atende pacientes com cordialidade e calma, tira dúvidas e conduz ao agendamento. Nunca dá diagnóstico, nunca indica medicamento e nunca promete resultado de tratamento: isso é com o dentista, na consulta. Em caso de dor forte, inchaço, sangramento ou trauma, trate como urgência e ofereça o primeiro horário ou chame a equipe.
5. **Lembrete na véspera:** ligar e escolher o horário (Inteligência Artificial › Agentes).
6. **Vocabulário** (perfil DEV › Textos do sistema): "Cliente" → "Paciente", "Clientes" → "Pacientes", "Serviços" → "Procedimentos", "Atendimentos" conforme o gosto da clínica.
7. **Menu do WhatsApp** (Inteligência Artificial › Menu Tradicional): opções como "Agendar avaliação", "Remarcar", "Convênios", "Falar com a recepção".
8. **Produtos/Estoque:** ignorar (não há como esconder ainda; ver seção 3.4).
9. **Campanhas:** só usar depois de ler a seção 6.

**Esforço:** 1 dia de implantação por clínica.

---

## 3. Fase 1 — Ajustes pequenos de código (≈ 1 semana)

### 3.1 Segmento "clínica" como chave de comportamento
Hoje `tenants.segmento` existe e ninguém lê. Ele passa a decidir os **padrões**: vocabulário da tela, textos de exemplo, prompt de fábrica da Sofia, catálogo inicial do seed e o que aparece no menu. A empresa continua podendo mudar tudo; o segmento só muda o ponto de partida.

### 3.2 Preço "sob avaliação" e "a partir de"
Hoje todo serviço tem preço fixo obrigatório, e a regra da Sofia é "nunca invente preço: só o do CATÁLOGO". Em odontologia, boa parte dos procedimentos (canal, implante, aparelho) só tem preço depois da avaliação.
- **Catálogo:** campo `tipoPreco` com três valores: `fixo` (como hoje), `a_partir_de` ou `sob_avaliacao`.
- **Resumo do catálogo que vai para a Sofia:** mostra "a partir de R$ X" ou "valor definido na avaliação".
- **Regra nova da Sofia:** para `sob_avaliacao`, não falar valor; explicar e oferecer a avaliação.
- **Agenda:** um procedimento `sob_avaliacao` não pode ser marcado direto pela IA sem avaliação anterior. Isso é configurável.

### 3.3 Urgência odontológica
"Estou com muita dor", "inchou o rosto", "quebrei o dente", "está sangrando" não podem entrar na conversa normal. Nem ficar "30 min na fila".
- Detector barato em código, no mesmo estilo do `pareceIrritado` de `ai/saida.js`, com palavras de urgência.
- Com urgência:
  - aviso no prompt da Sofia: oferecer o **primeiro horário do dia** ou transferir com `cliente_frustrado`/urgente;
  - notificação **urgente** à equipe, mesmo com a Sofia respondendo;
  - fora do horário: texto próprio ("procure um pronto-atendimento odontológico se…"), que a clínica escreve.

### 3.4 Esconder o que clínica não usa
Interruptor (em Funções do sistema ou por segmento) para **Produtos/Estoque/Vendas**. Consultório gasta material; não vende no balcão.

### 3.5 Textos de exemplo neutros
Placeholders com "barbearia" (Equipe, Base de conhecimento, Perfil, seletor de emoji) passam a depender do segmento.

---

## 4. Fase 2 — Funcionalidades de clínica (≈ 3–6 semanas)

Em ordem de importância.

### 4.1 Dependentes: um telefone, vários pacientes ⭐ (a mais importante)
A mãe marca para os três filhos pelo WhatsApp dela. Hoje **cada telefone é um cadastro** (índice único `idx_leads_tenant_telefone`), então os filhos não têm ficha, histórico nem agendamento próprios.
- **Modelo:**
  - o `lead` é o **contato** (quem conversa);
  - uma tabela nova `pacientes` (`id`, `leadId` responsável, `nome`, `nascimento`, `parentesco`, observações);
  - `appointments.pacienteId` (NULL = o próprio contato, como hoje).
- **Sofia:** quando o contato tem dependentes, perguntar **para quem** é o horário. As ferramentas de consulta e reserva recebem `paciente`.
- **Telas:**
  - ficha do contato com "Pacientes vinculados";
  - agenda e quadro mostram o **paciente** (e o responsável);
  - lembrete de véspera: "lembrete da consulta do **Pedro** amanhã às 14h".
- Barbearia também ganha com isso (pai e filho), então não é código só de clínica.

### 4.2 Plano de tratamento e sessões
Canal em 3 sessões, ortodontia mensal, clareamento em 2 etapas. Hoje a agenda só conhece visitas avulsas (ou vários serviços na mesma visita, em `sequencia.js`).
- `planos_tratamento` (paciente, dentista, procedimentos previstos, orçamento aprovado, status) e `appointments.planoId`.
- Marcar a próxima sessão respeitando um intervalo mínimo (ex.: 7 dias).
- Painel: sessões previstas × realizadas, pacientes com plano parado.

### 4.3 Retorno / recall
"Limpeza a cada 6 meses", "revisão do aparelho a cada 30 dias".
- `services.retornoDias` (opcional).
- Rotina diária (mesmo mecanismo do lembrete de véspera, em `automacao/rotinas.js`): quem fez o procedimento há X dias e não tem nada marcado recebe **uma** mensagem ("está na hora da sua limpeza, quer que eu veja um horário?"). A resposta cai na Sofia.
- Desligado por padrão; texto editável; respeita `aceitaCampanha`, `bloqueado` e o intervalo mínimo entre mensagens (15 dias, igual às campanhas).

### 4.4 Convênios (planos odontológicos)
- Cadastro de convênios da clínica; no paciente: convênio, número da carteirinha, validade.
- Por procedimento: coberto ou não pelo convênio X, preço de tabela do convênio.
- Sofia: "atende meu convênio?" responde a partir do cadastro. Procedimento **coberto** não tem preço para o paciente; **não coberto** usa o preço particular.
- Fora do escopo: faturamento de guias (TISS) com as operadoras. Isso é trabalho de sistema de gestão odontológica.

### 4.5 Consultório / cadeira como recurso
Dois dentistas dividindo uma cadeira: a agenda precisa impedir dois atendimentos na mesma **sala**. `salas` + `appointments.salaId` + conferência de conflito também por sala, no mesmo lugar onde hoje confere o profissional (`agenda.criar` e `vagasEmSequencia`).

### 4.6 Confirmação ativa
O lembrete de véspera já pede para responder se precisar remarcar. Para clínica vale fechar o ciclo:
- "responda **1** para confirmar ou **2** para remarcar";
- a resposta muda o status da OS para confirmado;
- no painel: taxa de confirmação e lista de "não confirmados" para a recepção ligar.

---

## 5. O que NÃO fazer (e por quê)

- **Prontuário, anamnese e odontograma:** são documentos legais da profissão, com regras próprias de guarda, sigilo e assinatura. Construir isso é outro produto. **Integre** com o sistema odontológico que a clínica já usa (exportar agenda e pacientes, link para a ficha) e mantenha esta plataforma no que ela faz bem: atendimento, agenda e relacionamento.
- **Diagnóstico ou orientação clínica pela IA:** a Sofia **nunca** diz o que o paciente tem nem o que tomar. A regra vai no prompt de fábrica do segmento **e** num filtro de saída em código, como o de bastidores em `ai/saida.js`, porque só prompt não garante.
- **Um repositório separado para clínicas:** ver o princípio no topo.

---

## 6. Cuidados legais — confirmar com advogado / conselho profissional antes de vender

- **LGPD — dado de saúde é dado sensível:**
  - as conversas passam por provedores de IA (Gemini, Groq), alguns fora do Brasil. É preciso base legal, termo de uso e política de privacidade adequados;
  - avaliar provedor com servidor no Brasil ou anonimização;
  - os resumos da Atena e a leitura de humor não devem registrar queixa clínica além do necessário;
  - prever exclusão e anonimização a pedido do paciente.
- **Publicidade:** o conselho de odontologia (CFO) tem regras sobre anúncio de preço, desconto e promoção, e sobre "antes e depois". O **Aquiles** (campanhas) precisaria, para o segmento clínica, de travas: não citar preço nem desconto, não prometer resultado, texto revisado. Confirmar as regras vigentes antes de liberar campanhas para clínicas.
- **Sigilo:** atendentes veem só o que é seu (regra atual de privacidade por atendente). Revisar se o dono e os perfis de gerência precisam ver o conteúdo clínico das conversas.

---

## 7. Roteiro sugerido

| Etapa | Entrega | Esforço |
|---|---|---|
| 0 | Implantar a primeira clínica só com configuração (seção 2) | 1 dia |
| 1 | Segmento, preço sob avaliação, urgência, esconder produtos, textos neutros (seção 3) | ~1 semana |
| 2 | **Dependentes** (4.1) + confirmação ativa (4.6) | ~1–2 semanas |
| 3 | Retorno/recall (4.3) + plano de tratamento (4.2) | ~2 semanas |
| 4 | Convênios (4.4) + salas (4.5) | ~2 semanas |
| — | Revisão jurídica (seção 6), **antes** de vender para a primeira clínica | em paralelo |

**Recomendação:** fazer as etapas 1 e 2 e implantar numa clínica real antes de construir o resto. O uso real diz se convênio ou plano de tratamento vem primeiro.

---

## 8. Prompts para o Claude Code

Mesmo formato dos prompts de correção (um por vez, na ordem, suíte completa ao fim, sem commit sem pedir).

**Importante:** estes prompts **ainda não foram prototipados e validados** como os anteriores. Antes de rodar um deles, peça a validação: "prototipe numa cópia, rode a suíte e me devolva o prompt ajustado".

### Prompt 0 — preparação (cole no início de cada sessão)
```
Leia o Plataforma/CONTINUAR-SESSAO.md e o "Para Clinicas/ADAPTACAO-PARA-CLINICAS.md" inteiros. Responda em português.
Rode a suíte da API e me diga quantos testes passam antes de mudar algo. Mudança mínima, no padrão do projeto;
teste que depende do expediente usa abrirACasa(); nada de copiar o projeto — tudo que for de clínica depende de
tenants.segmento. Ao terminar: suíte completa, resultado e explicação. Não faça commit sem eu pedir.
```

### Prompt 1 — Segmento como chave de comportamento (seção 3.1 e 3.5)
```
tenants.segmento existe (barbearia | clinica | salao | outro) e nenhum código o lê. Faça o segmento decidir os PADRÕES:
1. api: um módulo único (ex.: modules/empresa/segmentos.js) com, por segmento: vocabulário (cliente/paciente,
   serviço/procedimento, profissional), prompt de fábrica da Sofia, textos de exemplo e se Produtos aparece.
2. obterAgente: quando a empresa nunca editou o prompt (igual ao de fábrica, incluindo PROMPTS_ANTIGOS), usar o do
   segmento. Prompt editado nunca é tocado.
3. web: um hook (ex.: useVocabulario) usado nos títulos e placeholders que hoje dizem "barbearia"/"barbeiro"/"cliente"
   (Equipe.jsx, BaseConhecimento.jsx, Perfil.jsx, SeletorEmoji.jsx e os títulos de Contatos/Agenda). A troca de textos do
   DEV (Textos do sistema) continua valendo POR CIMA.
4. Tela para escolher o segmento (Base de conhecimento › Identidade), só dono/admin.
Testes: segmento clinica → a Sofia recebe o prompt de clínica; prompt editado é preservado; vocabulário da API muda.
Verifique no navegador as telas com segmento barbearia e clinica.
```

### Prompt 2 — Preço sob avaliação (seção 3.2)
```
Serviço ganha tipoPreco: 'fixo' (padrão, comportamento atual) | 'a_partir_de' | 'sob_avaliacao' (migration só ADD,
com DEFAULT 'fixo'). O catálogo (tela e API) permite escolher; com 'sob_avaliacao' o preço vira opcional.
resumoDoCatalogo (ai/tools/catalogo-cache.js) escreve "a partir de R$ X" ou "valor definido na avaliação".
Regra nova no prompt da Sofia: com 'sob_avaliacao', nunca citar valor; explicar e oferecer a Avaliação.
Configuração: "exigir avaliação antes de marcar procedimentos sob avaliação" — com ela, reservar_horario recusa esses
procedimentos para quem não tem avaliação concluída, com uma mensagem que a Sofia entenda.
Testes: resumo do catálogo nos três tipos; recusa da reserva sem avaliação; barbearia sem mudança nenhuma.
```

### Prompt 3 — Urgência (seção 3.3)
```
Detector em código (ai/saida.js, ao lado de pareceIrritado): pareceUrgencia(texto) para dor forte, inchaço, sangramento,
dente quebrado/caído, trauma. Só vale com segmento clinica (e configurável).
Com urgência:
- aviso no CONTEXTO do prompt: oferecer o primeiro horário de hoje (consultar_horarios com data hoje) ou transferir
  com cliente_frustrado=true;
- notificarEncaminhamento URGENTE à equipe mesmo que a Sofia continue respondendo;
- casa fechada: mensagem própria editável 'urgencia.fora_do_horario' (a clínica escreve a orientação).
Não diagnosticar nem orientar tratamento. Testes com frases reais ("to com muita dor de dente", "meu rosto inchou") e
frases que NÃO são urgência ("dor de cabeça pra escolher horário").
```

### Prompt 4 — Esconder Produtos/Estoque (seção 3.4)
```
Nova função em Funções do sistema: 'produtos' (ligada por padrão; desligada por padrão no segmento clinica). Desligada:
some a parte de produtos do Catálogo e do painel, as rotas de produtos/vendas respondem 404, e o dashboard omite as abas
de produtos (inclusive na exportação Excel). Testes das rotas e da exportação.
```

### Prompt 5 — Dependentes (seção 4.1)
```
Objetivo: um contato (lead, quem conversa no WhatsApp) com vários pacientes (ex.: mãe e 3 filhos).
1. Tabela pacientes (id, tenantId, leadId, nome, nascimento opcional, parentesco, observacoes, carimbos, exclusão lógica)
   e appointments.pacienteId (NULL = o próprio contato). Migrations só ADD/CREATE.
2. API: CRUD de pacientes dentro do contato; agenda aceita pacienteId (validar que é do mesmo contato); listagens e
   resumo da OS mostram o paciente.
3. Sofia/Atena: consultar_agendamentos_do_cliente devolve o paciente de cada horário; consultas e reserva aceitam
   `paciente` (nome); com mais de um paciente e o pedido sem dizer para quem, a Sofia pergunta. Atualize os prompts.
4. Lembrete de véspera: agrupa por contato, mas cita o paciente ("consulta do Pedro amanhã às 14h").
5. Telas: ficha do contato com "Pacientes vinculados" (adicionar/editar); agenda, quadro e marcar horário com o
   paciente; vocabulário pelo segmento.
Testes: mãe marca para 2 filhos em horários diferentes; a Sofia pergunta "para quem?" quando ambíguo; lembrete cita os
nomes; contato sem dependentes funciona como hoje (a barbearia não pode mudar de comportamento).
```

### Prompt 6 — Confirmação ativa (seção 4.6)
```
Lembrete de véspera com confirmação: o texto termina com "responda 1 para confirmar ou 2 para remarcar" (editável).
A resposta "1"/"confirmo"/"sim" em até 24h, de quem recebeu lembrete, marca as OS de amanhã como confirmadas SEM
chamar a IA (e responde "Confirmado!"); "2"/"remarcar" vai para a Sofia com o contexto de remarcação. Cuidado com o menu
híbrido (iaConduzindo) — o "1" não pode cair no menu. Painel: confirmados × não confirmados de amanhã, com lista para
a recepção. Testes de cada resposta e do conflito com o menu.
```

### Prompts 7 a 10 — plano de tratamento, retorno, convênios e salas (seções 4.2 a 4.5)
Escreva cada um no mesmo formato, a partir da seção correspondente, **depois** de implantar a primeira clínica: o uso real define os detalhes (intervalos, regras de convênio, quantas salas).

---

## 9. Checklist rápido para vender a uma clínica

- [ ] Segmento "clínica" configurado; vocabulário e prompt conferidos.
- [ ] Catálogo com Avaliação e preços revisados (fixo / a partir de / sob avaliação).
- [ ] Dentistas com jornada correta; feriados bloqueados.
- [ ] Base de conhecimento completa (convênios, pagamento, endereço, perguntas frequentes).
- [ ] Lembrete na véspera ligado (e confirmação ativa, quando existir).
- [ ] Mensagem de urgência fora do horário escrita **pela clínica**.
- [ ] Campanhas desligadas até a revisão de publicidade (seção 6).
- [ ] Termo de uso e privacidade (LGPD, dado de saúde) assinados.
- [ ] Teste real: a recepção simula 10 conversas (agendar, remarcar, criança, urgência, convênio, preço de canal) no Simulador e depois pelo WhatsApp.
