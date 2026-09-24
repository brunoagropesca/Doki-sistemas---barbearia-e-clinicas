# Continuar o trabalho em outro computador — colar numa nova sessão do Claude Code

Você está continuando o desenvolvimento de uma **plataforma de atendimento para barbearia/clínica**. Leia este arquivo inteiro antes de mexer em qualquer coisa. Responda sempre em **português (Brasil)**.

## O que é o sistema

- **Sofia** = atendente de IA que conversa com o cliente no WhatsApp.
- **Atena** = agente de IA "cérebro do sistema": mexe em agenda, catálogo, quadro de atendimentos e resumos, com permissões por grupo.
- **Aquiles** = agente de IA das **campanhas**: escreve a mensagem pessoal de cada cliente do disparo em massa. (Novo.)
- **API** (`api/`): Fastify + Drizzle ORM (SQLite/libsql) + Zod. Camadas `rota → service → repo`. Multi-tenant (`tenantId` é sempre o 1º parâmetro). Exclusão lógica (`deletedAt`).
- **Web** (`web/`): React + Vite + @tanstack/react-query. Componentes próprios em `web/src/componentes/ui.jsx` (`Botao`, `Campo`, `Modal`, `Selecao` — dropdown próprio, NÃO `<select>` nativo —, `Cartao`, `FotoLead`…). Um CSS por tela.
- IA: cascata de provedores (`api/src/ai/cascade.js`): Gemini, Groq, OpenAI, Ollama. Loop de ferramentas em `ai/agente.js`. Perfis dos agentes em `api/src/ai/agentes-padrao.js`.
- WhatsApp: Baileys (`api/src/channels/whatsapp/`). Até 5 conexões; uma conversa por conexão.

## Como rodar numa máquina nova

```bash
git clone <repositorio>
cd Plataforma/api && npm install && cp .env.example .env   # preencha o .env (chaves NÃO vão no git)
npm run db:migrate            # aplica as migrations 0000–0012
npm run db:seed               # empresa demo; usuários: dono / recepcao, senha trocar@123
npm run dev                   # API na porta 3333
cd ../web && npm install && npm run dev   # tela na porta 5173 (proxy para a API)
```

- Testes: `cd api && npm test` → **597 testes, todos passando** no fim desta sessão. Usam banco separado (`data/teste.db`).
- Atalhos `.bat` na raiz (INICIAR / PARAR / SALVAR-VERSAO / CRIAR-DEV) para Windows.
- **Não vão no git:** `api/.env` (chaves de IA, segredo de cifra), `api/data/` (banco, fotos, sessão do WhatsApp). Numa máquina nova o banco começa do zero: **cadastre de novo as chaves de Gemini/Groq** em Inteligência Artificial → Cascata, e **reconecte o WhatsApp** (QR Code) em Conexões.

## O que foi feito nesta sessão

### 1. Campanhas — fluxo novo em 5 etapas (`web/src/telas/campanhas/`)
Criar → Contatos → Configurar IA → Mensagens (gerar e aprovar) → Enviar. Rotas: `/campanhas` (lista), `/campanhas/nova` e `/campanhas/:id` (assistente ou relatório, em `PaginaCampanha.jsx`).
- **Lista** com barra de progresso animada (listras andando = enviando; âmbar = esperando; verde = concluída) e botões **Iniciar/Retomar, Pausar, Parar** (Parar pede confirmação e é definitivo: o que não saiu vira "não enviada").
- **Etapa 3:** objetivo (prompt do dono), tom, tamanho (curta/média/longa), **ousadia** (contida/equilibrada/ousada), emoji, "usar histórico", assinatura, "evitar" e **teste com 3 clientes** sem gravar nada.
- **Etapa 4:** a IA escreve em segundo plano (barra de progresso), revisão por cartão (editar, "outra versão", tirar, aprovar). Mensagem com texto de reserva (IA falhou) fica marcada "texto genérico". Cada mensagem mostra **qual modelo a escreveu**.
- **Etapa 5:** perfis de ritmo (Cauteloso/Equilibrado/Mais rápido), intervalo aleatório, limite por dia, janela de horário, "digitando…" antes de cada mensagem, estimativa de duração.
- Backend: `api/src/modules/campanhas/` (service/repo/routes). Status: `rascunho → gerando → revisao → pronta → enviando ⇄ pausada → concluida | cancelada`. Alvos: `aguardando/pendente/aprovada/enviando/enviada/falha/respondeu/pulada`.
- **Regras que não podem quebrar:** nada sai sem aprovação humana; `enviadoEm` só recebe valor depois do canal confirmar; quem pediu para não receber campanha (e o contato do Simulador) nunca entra; bloqueio de 15 dias entre campanhas para o mesmo cliente; quem já tem horário marcado não recebe convite para agendar.
- Fora da janela de horário ou no limite do dia a campanha **espera sozinha** (continua "enviando", com motivo e hora de retorno). Número desconectado: espera até 5 min e pausa com o motivo. Ao reiniciar a API, campanhas interrompidas retomam sozinhas (`retomarInterrompidas` em `main.js`).
- Respostas dos clientes são contadas e classificadas (interessado/neutro/recusa) a partir do gateway; recusa desliga campanhas para aquele cliente.
- **Bug corrigido:** a campanha não virava "Concluída" ao chegar em 100% (esperava o intervalo de descanso; um Pausar nessa janela a deixava pausada para sempre). Agora `concluirSeTerminou` conclui na hora e cura campanhas antigas travadas ao abrir a lista/relatório.
- **`Modal` agora renderiza no `<body>`** (`createPortal`): dentro de cartões com `backdrop-filter` ele abria espremido.

### 2. Aquiles — o agente de disparo
- Perfil de fábrica em `agentes-padrao.js` (chave `aquiles`, temperatura 0.9). Configurável em **Inteligência Artificial → Personas**: liga/desliga, **modelo preferido** (`"provedor:modelo"`), temperatura, persona, **até 5 exemplos de estilo** (imita o jeito, nunca o conteúdo) e **"falar com a voz da Sofia"**. Guardados em `agent_profiles.config` (migration 0012).
- **`modeloPreferido` agora é respeitado pela cascata** (`priorizarModelo` em `cascade.js`): é a 1ª tentativa e o resto da cascata fica de reserva. (Antes o campo existia mas ninguém o lia.) Só o Aquiles usa por enquanto.
- Aquiles desligado → gerar/prévia avisam em vez de gerar 300 textos de reserva.
- Verificação anti-"ficha": se o texto diz "vi que…", "no cadastro", "histórico"…, o sistema pede uma reescrita automática, uma vez. Emoji de tom de pele solto é removido.

### 3. Página dos agentes reorganizada (`web/src/telas/central-ia/Personas.jsx`)
Lista de agentes à esquerda (Sofia/Atena/Aquiles, com estado e modelo) e o formulário só do escolhido à direita. Os três formulários ficam montados (só escondidos), então trocar de agente **não perde o que foi digitado**. O agente aberto vai na URL (`?agente=`). No celular a lista vira uma fileira rolável. O bloco "Como o WhatsApp é atendido" (menu/híbrido/IA) ficou embaixo, inalterado.

### 4. Outros
- Teste instável do WhatsApp estabilizado (`whatsapp-adapter.test.js`): espera o fim da resposta da Sofia e a pasta de sessão ser apagada.
- Migrations novas: **0011** (campanhas: `ia_config`, `simular_digitacao`, estado de espera, `mensagem_reserva`, índice) e **0012** (`agent_profiles.config`). Ambas só acrescentam colunas.

### 5. Sessão de 22/09/2026 — livechat estilo WhatsApp, respostas rápidas e Meu perfil
- **Barra de envio nova** (`web/src/telas/conversas/Compositor.jsx` + `.css`): 😊 emojis (`SeletorEmoji.jsx`, lista própria, "Recentes" no localStorage), 📎 menu Documento/Fotos/Vídeo com **prévia e legenda** antes de enviar (colar imagem com Ctrl+V também abre), ⚡ respostas rápidas (ou digitar `/` no começo). Campo vazio mostra o microfone; com texto, o botão de enviar.
- **Anexos no backend:** `responderSchema` aceita `anexo: { dataUrl, nome }` (+ `conteudo` como legenda); `salvarAnexo` em `equipe/arquivos.js` (extensão sempre das tabelas internas, nunca do nome enviado; HTML/SVG/EXE recusados; 16 MB); rota de mensagens com `bodyLimit` de 24 MB; Baileys manda `image`/`video`/`document` (`conteudoDeMidia`). Documentos são servidos como `attachment` + `nosniff`.
- **Respostas rápidas por atendente:** tabela `quick_replies` (**migration 0013**), módulo `api/src/modules/perfil/` (`/api/perfil`, `/api/perfil/respostas-rapidas`). Variáveis `{saudacao}`, `{nome}`, `{atendente}`. Atalho `atena` é reservado.
- **Página Meu perfil** (`/perfil`, `web/src/telas/Perfil.jsx`): foto, status, nome/e-mail/telefone, trocar senha, respostas rápidas. Abre clicando no próprio nome no rodapé do menu, ou pelo menu do topo das Conversas.
- Testes: **639 passando** (novos em `perfil.test.js`, `conversas.test.js` e `whatsapp-adapter.test.js`).
- Envio real testado pelo usuário: foto e PDF chegaram. (Uma foto falhou só porque foi enviada antes de conectar o número.)
- **Prévia com editor de foto** (`web/src/telas/conversas/PreviaAnexo.jsx` + `.css`): lápis, pincel translúcido, texto (arrastar para mover, clicar para editar), 8 cores, desfazer (Ctrl+Z) e limpar. Foto sempre inteira com margem (`ResizeObserver`). Tudo roda no navegador: foto editada sai em JPG (fundo branco, até 2560 px); sem edição, vai o arquivo original.
- Corrigido: no celular o fio da conversa ficava mais largo que a tela (`.fio-area` com `minmax(0, 1fr)`); a conversa rola até o fim quando a foto da última mensagem termina de carregar.
- **3 fontes no texto da foto** (Moderna/Jakarta, Arredondada/Poppins, Cartaz/Bebas Neue) e contorno do texto corrigido: era grosso e semitransparente (virava mancha cinza); agora é fino e opaco.
- **Bug corrigido — mensagem "presa" (nem entregue, nem com erro visível):** se a gravação do resultado da entrega no banco falhasse (SQLite ocupado num pico de mensagens), a mensagem ficava sem `entregueEm` e sem `erroEnvio` — sem selo de falha, sem botão Reenviar, parecendo enviada para sempre. `entrega.service.js` agora insiste mais (4 tentativas, espera crescente) e `conversas.routes.js` tem uma segunda rede de segurança. Também corrigido um vazamento: se o cálculo da conexão (`chaveDaUltimaEntrada`) falhasse, a mensagem ficava travada em "sendo enviada" para sempre (Reenviar nunca mais funcionava para ela). Uma mensagem que já tinha ficado presa no banco do usuário foi corrigida manualmente (autorizado por ele).

### 6. Construtor visual do menu (estilo n8n) — 22/09/2026
- **Formato novo do menu:** grafo no formato do n8n (`{ versao, inicio, nodes, connections, config }`) na coluna `menu_flows.fluxo` (**migration 0014**). O menu antigo (`opcoes` em árvore) é convertido na leitura (`converterMenuAntigo`) e só é substituído quando o usuário salva.
- **Regras num arquivo só:** `api/src/modules/atendimento/fluxo.js` — tipos (JSDoc), limites (5 opções por menu, 10 níveis, 80 passos), `validarFluxo` (erros x avisos), `motivoParaRecusarLigacao`, `organizarFluxo` e o motor `passoDoFluxo`. **Não importa nada**, e a tela importa o MESMO arquivo pelo atalho `@regras-do-fluxo` (alias no `vite.config.js` + `server.fs.allow`). Editor, servidor e prévia usam a mesma regra.
- **Tipos de passo:** `menu` (até 5 opções, uma saída por opção), `mensagem`, `servicos` (lista do catálogo), `atendente` (vai para a fila) e `sofia` (sai do menu e entrega para a IA).
- **BUG ANTIGO CORRIGIDO:** o menu não guardava onde o cliente estava, então "1" dentro de um submenu era lido como a opção 1 do menu principal — submenus nunca funcionaram de verdade. Agora a conversa guarda `menu_estado` (`{ no, pilha, em }`): "0" volta, palavras de saudação voltam ao início, e depois de `expiraMinutos` (padrão 60) vale o início de novo. O simulador devolve o estado para a tela a cada turno.
- **Editor:** `web/src/telas/configuracoes/fluxo/` (React Flow / `@xyflow/react`), em `/configuracoes`. Canvas pontilhado, zoom, minimapa, arrastar da bolinha de uma opção até outro passo (ou soltar no vazio para criar já ligado), menu "⋯" por passo (editar, duplicar, desativar, definir como início, excluir), painel lateral com opções e "leva para", abas Testar/Problemas/Ajustes. O editor antigo (`EditorMenu.jsx`) foi removido.
- Testes: `api/tests/fluxo.test.js` (26). Total **663/664** (a que falha é o teste instável de áudio; sozinho passa).
- **Armadilha nova:** efeito do React não pode devolver Promise — `scrollIntoView` no Chrome novo devolve uma, e um `useEffect(() => fim.scrollIntoView())` derruba a tela inteira. Sempre com chaves.
- **Menu lateral recolhível** (`Layout.jsx`/`Layout.css`): seta "‹" na marca recolhe o menu (sanfona animada) e deixa só uma abinha na borda esquerda, que cresce e acende ao passar o mouse. **Passar o mouse na abinha "espia"**: acende a fileira de ícones (66 px, `--largura-menu-icones`). Recolhido, essa faixa **já fica reservada e vazia** na página — a espiada só a acende, então ela nunca cobre o conteúdo e nada muda de lugar. Some sozinha quando o mouse sai; dá para clicar num ícone e navegar sem abrir. O menu inteiro só abre no clique na seta. A escolha fica no `localStorage` (`layout.menu-recolhido`); recolhido e sem espiar, o `aside` vira `inert` (some do Tab). No celular nada disso vale: continua a gaveta com o ☰.
- **Bug corrigido — o "espiar" fechava de forma inconsistente:** a abinha (`.layout__puxar`) e o `<aside>` eram elementos IRMÃOS que só se tocavam visualmente; como a abinha desliza (da borda até a beirada da fileira), o navegador às vezes perdia o rastro do mouse durante a animação (`mouseenter`/`mouseleave` seguem a árvore do DOM, não a posição na tela) — daí o "às vezes recolhe, às vezes não". Corrigido agrupando os dois num wrapper `.layout__zona-menu { display: contents }` (não gera caixa própria, não muda layout nenhum, só agrupa para o hover virar um evento só, estável em qualquer posição da animação). Testado com 15 hovers seguidos interrompendo a transição no meio: 15/15 fecham certo.
- **Foto do perfil centralizada no modo espiar:** o bloco nome+cargo tinha um `<div className="crescer">` (flex:1) que, mesmo com o texto escondido, continuava ocupando espaço e empurrava a foto para a esquerda. Agora o `.crescer` inteiro some (`.menu__usuario > .crescer`), e o `justify-content: center` já existente finalmente centraliza a foto sozinha.
- **Casca do app não rola mais:** `.layout` tem altura exata da tela com `overflow: hidden` e quem rola é `.conteudo`. Antes a página inteira ganhava uns 16 px de rolagem em telas de altura fixa (a mesa pedia `100vh` e ainda somava o respiro do conteúdo). Telas de altura fixa agora usam `height: 100%` (`.mesa`, `.fluxo`) — **não use `100vh` dentro do conteúdo**. A lista de conversas também ganhou `overflow-x: hidden` (aparecia uma barra horizontal embaixo dela).
- Corrigido: a lista de tipos de passo abria por baixo da borda do canvas em telas menores (só aparecia a tirinha de ícones). Agora ela **se mede** e se encaixa sozinha (`useLayoutEffect` no `SeletorDeNo`) — não há mais chute de tamanho. O painel lateral também encolhe (`clamp(300px, 26vw, 380px)`) e o minimapa some quando o canvas fica estreito (container query).

### 7. Respostas rápidas em cartões coloridos + subchat da Atena — 22/09/2026
- **Cartões coloridos:** cada resposta rápida ganha uma cor estável (6 cores no ciclo, atribuídas pela ORDEM da lista completa do usuário — nunca pela posição filtrada, senão a cor "pularia" enquanto ele digita). Borda esquerda colorida, atalho em selo colorido, ativo (seta do teclado) ganha anel na própria cor.
- **Chips no topo do painel:** "⚡ Respostas rápidas" / "🧠 Falar com Atena" — o item fake "Pedir à Atena" que ficava misturado na lista foi removido; agora é um modo à parte. Digitar "/" no campo sempre volta pra aba de respostas (mesmo se a pessoa estava na da Atena).
- **Subchat da Atena — laranja, tokens `--alerta` do sistema** (não o verde-água que já é a cor da Atena na Central de IA — o usuário pediu laranja especificamente para este subchat): mini-conversa efêmera (não grava nada por conta própria) que chama a MESMA rota `/api/atena/comando` do `/atena <pedido>` já existente — mesmas ferramentas, mesmas travas, e o resultado também fica gravado na conversa como aviso de sistema. Bolha do pedido à direita, resposta da Atena à esquerda com pontinhos "pensando…", erro em vermelho se falhar. `Compositor.jsx` agora recebe `conversationId` como prop.
- **5 respostas de teste criadas no cadastro real do usuário** (`/precos`, `/horario`, `/endereco`, `/pix`, `/obrigado`) via a própria API — o `/teste` que ele já tinha foi mantido.
- **Armadilha:** `curl` do Git Bash no Windows corrompe acento/emoji no corpo da requisição (mismatch de Content-Length). Usar `node --input-type=module -e` com `fetch` para popular dados via API.

### 8. Qualidade do chat a partir dos testes reais (Débora e Lyu) — 23/09/2026
Análise das 2 conversas de teste do banco de dev: agendamento parcial anunciado como sucesso ("quero os 3"), Atena em laço (4 chamadas iguais) virando "a Atena pediu um instante", bastidores vazando ("o sistema indicou…"), data escolhida pela Sofia sem o cliente dizer, cliente irritado sendo interrogado, `**negrito**` e marcador `[AO]` chegando ao cliente.
- **Datas por código, não por prompt** (`api/src/core/datas-naturais.js`): `interpretarData("sexta" | "dia 25" | "25/09" | "depois de amanhã" | "semana que vem"…)` → `{ data, dia: "sexta-feira, 25/09", aviso? }`. TODA ferramenta da Atena que recebe data passa por ele e devolve o `dia` por extenso para a Sofia repassar. Os prompts levam só o dia de hoje (o "amanhã é…" saiu). Não existe ferramenta `interpretar_data` separada de propósito: custaria ~100 tokens em toda chamada para repetir o que as outras já fazem.
- **Vários serviços na mesma visita** (`api/src/modules/agenda/sequencia.js`, função pura com backtracking): um serviço começa quando o anterior termina; mesmo profissional segue atendendo quando puder; folga de limpeza respeitada. `agenda.vagasEmSequencia` (lê a agenda da janela inteira UMA vez) e `agenda.criarSequencia` (**tudo ou nada**, re-checado dentro da transação; pedido repetido devolve `jaExistia`). Ferramentas novas da Atena: `consultar_varios_servicos` (grupo horários) e `agendar_varios_servicos` (grupo criar).
- **Sem data ou dia sem vaga:** `consultar_horarios` e `consultar_varios_servicos` já devolvem `proximaDataComVaga` (até 14 dias) na mesma chamada — sem voltas extras de modelo.
- **Laço de ferramentas** (`ai/agente.js`): uma volta feita só de chamadas repetidas (mesmo nome + argumentos) encerra na hora (`repetiu`); escrita zera a memória de leituras. O retorno ganhou `semResposta` quando o texto é o de reserva. A Atena, nesse caso, devolve um relato montado em código (`relatoSemConclusao`: NÃO FEITO + o que as ferramentas devolveram + "não prometa retorno"); a Sofia, nesse caso, passa o cliente para a fila humana (`respondidoPor: 'fallback_humano'`, motivo `sem_resposta`).
- **Filtro de saída** (`api/src/ai/saida.js`): `**x**`→`*x*`, títulos, links, marcadores soltos; `[XX]` em maiúsculas vira quebra de balão. `vazaBastidores` (Atena, "o sistema", ferramenta, "dados não constam"…) → UMA reescrita curta só com o rascunho; se vazar de novo, tira as frases culpadas. `pareceIrritado` (palavrão, "???") põe um aviso no prompt da Sofia (regra 10: resolver ou transferir, sem interrogatório) — não transfere sozinho.
- **Prompts:** Sofia tem regras novas (só confirmar o FEITO, data como o cliente falou e nunca escolher a data, vários serviços juntos, "ok/obrigado" sem consultar a Atena e sem re-saudar, nunca citar bastidores, reclamação × irritação). Atena responde em linhas FEITO / NÃO FEITO / OPÇÕES / FALTA.
- Descrições de `criar_agendamento` e `mover_etapa_atendimento` enxugadas para compensar os tokens das ferramentas novas. Texto `fila.transferencia` com acento.
- Testes novos: `datas-naturais`, `sequencia`, `saida`, `conversas-reais` (cada falha das conversas reais vira um caso). `ia.test.js`: o teste de laço agora usa argumentos diferentes a cada volta; novo teste da repetição.

### 9. Arquitetura: a Sofia lê direto, a Atena só escreve — 23/09/2026 (aprovado pelo usuário)
- **Antes:** toda consulta de horário era Sofia → modelo da Atena (2–4 chamadas de ~2 mil tokens) → ferramenta. Na conversa real da Débora foram 34 chamadas da Atena para 8 mensagens da cliente.
- **Agora:** a Sofia chama direto `consultar_horarios`, `consultar_varios_servicos` e `consultar_agendamentos_do_cliente` (`LEITURAS_DIRETAS` em `ai/tools/sofia.tools.js`). São as MESMAS ferramentas da Atena, montadas em modo leitura, com as MESMAS permissões por grupo (desligar "horários" na Atena desliga para a Sofia) e o mesmo aviso ao funil. `consultar_atena` ficou para **marcar, remarcar e cancelar** (e dado que as consultas não trazem). A Sofia continua sem nenhuma ferramenta de escrita.
- Atena, regra 5: pedido com serviço, profissional, data e hora → marca DIRETO (a marcação já recusa horário ocupado na transação); só consulta se for recusada. Uma volta a menos por agendamento.
- Sofia `maxVoltas` 3 → 4 (consultar + pedir a marcação + responder); o laço de repetição continua parando na hora.
- Bastidores: `detalhes.consultas` (o que a Sofia consultou direto); o Simulador mostra o bloco "🔎 Consultas diretas da Sofia — sem acionar a Atena" (componente `ConsultaFerramenta`, reaproveitado no trace da Atena).
- Custo: esquema de ferramentas da Sofia ~336 → ~613 tokens por chamada (descrição de `transferir_para_humano` enxugada para compensar). Em troca, consulta de horário deixa de custar 2–4 chamadas da Atena.
- Testes: `atena.test.js` — a Sofia tem as leituras e nenhuma escrita; consultar horário não acorda o modelo da Atena; leituras respeitam as permissões. Suíte: **772/772**.

### 10. Painel acessível pela rede local — 23/09/2026
- **`INICIAR-NA-REDE.bat`**: libera a porta 5173 no firewall do Windows (uma vez, só perfil privado/domínio, pede permissão de admin via UAC) e chama o `INICIAR.bat` com `ACESSO_REDE=1`.
- **`painel.mjs --rede`** (ou `ACESSO_REDE=1`): sobe o Vite com `--host 0.0.0.0`, mostra os endereços da rede (filtra placas virtuais WSL/Hyper-V/VirtualBox — na máquina do usuário o certo é `192.168.15.12`, e o do WSL `192.168.96.1` viria primeiro sem o filtro) e um QR Code no terminal (usa o `qrcode` da API).
- **A API continua em 127.0.0.1**: o celular fala só com as telas, que repassam `/api` (proxy do Vite). Sem CORS, cookie de sessão funciona, e a API não fica exposta. Verificado: pelo IP da rede a página e `/api` respondem; `:3333` pelo IP da rede recusa.
- IP real nas sessões: proxy do Vite com `xfwd: true` + `trustProxy: 'loopback'` em dev (só confia no cabeçalho vindo desta máquina; forjado de fora é ignorado).
- Se não abrir no celular: Wi-Fi marcado como rede **Pública** no Windows (a regra vale só para privada) ou a permissão de admin recusada.

### 11. Encaixe dinâmico de vários serviços (2º teste do Lyu) — 23/09/2026
- **O teste:** a arquitetura do item 9 funcionou (zero chamadas da Atena), mas "quero os três" respondeu "nada em 14 dias" com a agenda de 24–25/09 VAZIA. Causa: o planejador exigia o próximo serviço colado no anterior; a Descoloração do Alexandre tem 5 min de limpeza e o Gin (só ele faz) não podia começar junto. A Sofia ainda inventou um "começar às 11:00" que a consulta não mostrou, e a reescrita anti-bastidores cumprimentou de novo ("Olá!").
- **Decisão:** o usuário sugeriu a Atena (IA) encaixar os horários; ficou como CÓDIGO dentro da ferramenta dela (conta de minutos é onde o modelo erra, e a Atena ociosa é a economia). Explicado ao usuário.
- **`sequencia.js` dinâmico:** espera de até 30 min entre serviços (passos de 5, sempre a menor), outra ordem dos serviços só se a pedida não couber no dia (até 4 serviços; sai `ordemTrocada`), orçamento de 40 mil verificações por dia. `criarSequencia` confere na transação com `permitirOutraOrdem: false`.
- **`consultar_varios_servicos`:** opções trazem `obs` (ordem trocada) e `esperaEntreServicos`; hora pedida que não cabe devolve as 3 opções reais mais próximas dela no mesmo dia; sem vaga, o aviso proíbe oferecer horário fora das opções.
- Verificado com a agenda real (cópia): Descoloração 12:00, Gin 14:35, Limpeza 14:40 na sexta 25/09 — o que o Lyu pediu — e a gravação dos três funcionou (cópia apagada depois).
- Também: filtro desfaz `*(Alexandre: *R$ 550,00*)*`; reescrita não cumprimenta; regra 3 da Sofia: horário de vários serviços só dos que vieram em `opcoes`. Suíte: **779/779**.

### 12. Quadro: cartão pisca quando o cliente espera uma PESSOA + barra discreta — 23/09/2026
- **Regra (`marcarQuemPrecisaDeGente` em `quadro.service.js`):** `precisaDeGente = 'na_fila'` (fila humana, ninguém assumiu) ou `'sem_resposta'` (status `humana` e a última mensagem que não é de sistema é do cliente — `conversasRepo.ultimaDirecaoPorConversa`). Conversa com a Sofia nunca pisca (a IA responde sozinha; alarme falso ensina a equipe a ignorar). Vale também para o cartão da OS ligado à conversa. O quadro já se atualiza em tempo real (`conversa.mudou`).
- **Tela:** `cartao-q--atencao` — pulso laranja (`--alerta`) POR DENTRO do cartão (`::before` + anel inset; o brilho externo era cortado pelo `overflow` da coluna), etiqueta "Na fila"/"Esperando resposta" com ponto piscando, dica no `title`, para de piscar com o mouse em cima, estático com `prefers-reduced-motion`. Verificado no Chrome numa cópia do banco (opacidade do pulso 0.17 ↔ 0.93).
- **Barra horizontal do quadro:** fina e transparente; acende azul só com o mouse em cima. Colunas com barra vertical de 4 px.
- **Testes instáveis de madrugada/noite corrigidos:** `instanteDeHoje()` em `tests/helpers/ambiente.js` (quadro/automação criavam a OS "de hoje" com `Date.now() ± 1–2h`, que depois das 23h caía amanhã). O teste que precisa de OS futura hoje é pulado com motivo nos últimos minutos do dia. Suíte: **782/782** às 23h.

## Pendências / próximos passos

- **Testar de verdade no WhatsApp** as mudanças dos itens 8 e 9 (mesmos roteiros da Débora e do Lyu) e olhar os bastidores no Simulador — conferir se a Sofia oferece 2–3 horários (e não a lista inteira) e se passa a data "como o cliente falou".
- **Métricas de qualidade** na Central de IA: turnos em que a Atena não concluiu, reescritas por vazamento, transferências por `sem_resposta`. Hoje só vão para o log (`log.warn`).

- **Limpeza de contatos de teste — aguardando o usuário LIBERAR.** No banco de dev há 14 registros de teste (7 "Zz …", os 3 manuais Marcos Antunes/Rafael Souza/Joao Pedro e "Simulador (teste)"; 13 já estavam apagados logicamente, só o Simulador aparece na lista) ligados a 10 conversas e 1 agendamento. O sistema de permissões bloqueou a exclusão definitiva; faça só se o usuário autorizar de novo (e faça backup de `api/data/plataforma.db` antes). O Simulador se recria sozinho ao usar o simulador; dá para só esconder da lista de Contatos (origem `simulador`). Não mexer no **Lyu** (número de teste do usuário) nem em Débora/Jesus/Doki Bot sem perguntar.
- **Ofertas antigas sem resposta:** cancelar o agendamento avulso das 10:30 `appt_0mua7l76e00dcxsit`; reatribuir a conversa do "Lyu" `conv_0mua5ya800021gyug` do dono para um atendente. Só com permissão explícita.
- **A verificar pelo usuário:** a chave nova do Gemini ficou salva na aba Cascata? (Na cópia do banco, quem respondeu foi sempre o Groq.) O usuário tinha trocado a chave do Gemini por uma errada só para testar o Groq.
- **Teste real de disparo:** criar uma campanha só com o Lyu e disparar pelo número do usuário, para ver o "digitando…", a barra andando e a resposta sendo contada. Ainda não foi testado envio real pelo WhatsApp (a cópia de verificação não tinha número conectado).
- **Sugestão ao usuário:** colar 2–3 mensagens do jeito dele nos exemplos do Aquiles — é o que mais melhora a qualidade.
- Ideia futura: outros agentes usarem `modeloPreferido`; tamanho/ousadia salvos como padrão do Aquiles.

## Convenções e armadilhas (importante)

- **Fim de linha:** o repositório mistura CRLF e LF. Edições por substituição de texto podem falhar em silêncio se o `\n` não casar com `\r\n`. Confira que a alteração aplicou.
- **Migrations:** `npx drizzle-kit generate --name <nome>`, depois **conferir o SQL** e ajustar `when` em `meta/_journal.json` para valor crescente (o último é `1789980000000`). Coluna `NOT NULL` nova precisa de `DEFAULT` (o drizzle gera sem, e quebra em tabela com linhas). Mudar o DEFAULT de coluna existente obriga o SQLite a reconstruir a tabela — evite.
- **Padrão de código:** comentários em português explicando o **porquê**; camadas rota → service → repo; `tenantId` primeiro parâmetro; nunca vazar chave de API; recursos invisíveis a um atendente respondem 404.
- **Privacidade por atendente:** só o **Dono** vê tudo; atendentes veem o que é seu + fila e vitrine da Sofia. Regras em `api/src/modules/equipe/equipe.config.js`. Rotas de campanha e da Central de IA são `apenas.admin`.
- **Semântica das conversas:** assumir = só atribui; primeira mensagem humana vira `humana`; agendamento feito pela IA atribui a conversa a um atendente mantendo `bot`. IA desligada para o cliente → conversa vai para a fila humana.
- **Foto do WhatsApp** é buscada **depois** de atender o cliente, nunca no meio do fluxo.
- **Testes:** cada arquivo cria dados próprios (telefones/ids próprios); testes não gravam em `data/uploads` (`.env.test` define `PASTA_ARQUIVOS`).
- **Verificação de interface:** testar de verdade no navegador com `playwright-core` + Chrome do sistema (`C:/Program Files/Google/Chrome/Application/chrome.exe`), numa **cópia** do banco (`verificacao.db`) com API em `PORT=3334` e Vite em `VITE_PORT=5174 VITE_API_TARGET=http://127.0.0.1:3334`, para não atrapalhar o servidor do usuário (3333/5173) — e apagar a cópia depois. `playwright-core` não está no projeto: instale numa pasta temporária. Nunca deixar dados de teste no banco de dev dele.
- **Ações arriscadas** (apagar dados, commit, push): confirmar antes. O commit só é feito quando o usuário pede.
- Não use subagentes/workflows a menos que o usuário peça.

## Como o usuário trabalha

O usuário (Bruno, dono do projeto) descreve o que quer em linguagem de negócio, testa o sistema de verdade usando o próprio número de WhatsApp como se fosse cliente ("Lyu") e reporta bugs pelo comportamento (muitas vezes com print). Gosta de entregas completas e verificadas na tela, com explicação clara do que mudou. Quando há decisão de produto ambígua, prefere que você explique e pergunte antes de codar.
