# Plataforma de Atendimento

Sistema de CRM, agenda e atendimento por WhatsApp com IA, para clínicas, barbearias e salões.

Reescrita do sistema anterior (`New system test/Sistema`), com foco em **escalar sem reescrever de novo**.

---

## Como rodar

Você precisa do **Node.js 22 ou mais novo** ([nodejs.org](https://nodejs.org)).

Abra **dois terminais**.

**Terminal 1 — a API:**
```bash
cd api
npm install
copy .env.example .env    # no Mac/Linux: cp .env.example .env
npm run db:seed           # cria o banco e uma empresa de demonstração
npm run dev               # API em http://localhost:3333
```

**Terminal 2 — as telas:**
```bash
cd web
npm install
npm run dev               # abra http://localhost:5173
```

Acessos criados pelo seed:

| Usuário    | Senha        | Cargo     | O que enxerga                              |
| ---------- | ------------ | --------- | ------------------------------------------ |
| `dono`     | `trocar@123` | owner     | Tudo, incluindo campanhas e configurações  |
| `recepcao` | `trocar@123` | atendente | Conversas, agenda, contatos, catálogo      |

> Troque essas senhas antes de colocar no ar.

**O perfil DEV (o seu, de desenvolvedor).** Existe um terceiro cargo, `dev`, que **não aparece em lugar nenhum** do sistema: não está em nenhuma lista, não pode ser criado pela tela nem pela API, e as rotas que só ele usa respondem "não existe" para todo mundo. Ele serve para configurar a plataforma; a primeira coisa que só ele faz é **adicionar e remover as sessões de WhatsApp**. Para criá-lo, dê duplo clique em **`CRIAR-DEV.bat`** — ele pergunta o login, o nome e a senha (a senha não aparece na tela). Depois é só entrar pela tela normal de login.

O DEV é **temporário**: (1) só entra enquanto o `CRIAR-DEV.bat` estiver na pasta da Plataforma — o arquivo é a chave, e apagá-lo derruba até quem já está dentro; (2) ao clicar em **Sair**, o usuário DEV é apagado do banco, como se nunca tivesse existido — para configurar de novo, rode o `.bat` outra vez; (3) se o navegador for fechado sem "Sair", ele é apagado no próximo início do sistema (depois de um dia).

### Comandos

| Comando              | O que faz                                                 |
| -------------------- | --------------------------------------------------------- |
| `npm run dev`        | Sobe e reinicia sozinho quando você salva um arquivo       |
| `npm test`           | Roda os testes automatizados (num banco separado)          |
| `npm run db:migrate` | Aplica mudanças de estrutura do banco                      |
| `npm run db:seed`    | Popula com a empresa de demonstração                       |
| `npm run db:check`   | Diagnostica o banco: schema, chaves estrangeiras, órfãos   |
| `npm run usuario:dev`| Cria (ou troca a senha do) usuário DEV — o `CRIAR-DEV.bat` faz o mesmo |
| `npm run build`      | (em `web/`) Gera a versão de produção das telas            |

---

## Como o projeto está organizado

```
Plataforma/
├── api/                        Backend (Node.js + Fastify)
│   ├── src/
│   │   ├── config/             O ÚNICO lugar que lê variáveis de ambiente
│   │   ├── core/               Peças de base: dinheiro, datas, telefone, criptografia
│   │   ├── db/
│   │   │   ├── schema/         Definição das 24 tabelas
│   │   │   └── migrations/     SQL gerado, versionado junto com o código
│   │   ├── http/plugins/       Autenticação e tratamento de erros
│   │   ├── ai/                 Motor de IA: provedores, cascata, ferramentas
│   │   ├── channels/           Gateway de mensagens + adaptador do WhatsApp
│   │   ├── modules/            Um módulo por assunto do negócio
│   │   │   ├── auth/  leads/  agenda/  catalogo/
│   │   │   ├── conversas/  atendimento/  campanhas/
│   │   │   └── ia/  canais/  auditoria/
│   │   ├── app.js              Monta o servidor
│   │   └── main.js             Liga o servidor
│   └── tests/                  324 testes
└── web/                        Frontend (React + Vite)
    └── src/
        ├── componentes/        Peças reutilizáveis da interface
        ├── telas/              Uma por página
        ├── lib/                Cliente da API e autenticação
        └── estilos/            Tokens visuais (cores, espaçamento)
```

### As três camadas de um módulo

Cada módulo tem os mesmos quatro arquivos, com papéis que não se misturam:

| Arquivo        | Responsabilidade                        | O que **não** pode ter               |
| -------------- | --------------------------------------- | ------------------------------------ |
| `*.routes.js`  | Recebe o HTTP, valida, devolve resposta  | Regra de negócio, SQL                |
| `*.service.js` | Decide. É onde mora a regra do negócio   | `req`/`res`, SQL                     |
| `*.repo.js`    | Conversa com o banco                     | Decisão de negócio                   |
| `*.schemas.js` | Define o formato aceito na entrada       | Qualquer outra coisa                 |

Por que isso importa: no sistema antigo, `db.mjs` tinha **4.200 linhas** misturando SQL e regra de negócio, e `server.mjs` tinha **2.030 linhas** de `if` em sequência. Testar uma regra exigia subir o servidor inteiro.

**Adicionar um módulo novo:** crie a pasta com os quatro arquivos e registre uma linha em `src/app.js`. Nenhum arquivo existente cresce.

---

## Decisões de arquitetura (e o porquê de cada uma)

### 1. `tenant_id` em todas as tabelas, desde o primeiro dia
Hoje existe uma empresa só e essa coluna parece inútil. Mas ela é o que permite atender a segunda barbearia sem reescrever cada consulta. Adicionar depois custaria uma reescrita; pagar agora custa quase nada.

### 2. Toda rota é protegida por padrão
Um hook exige login em **todas** as requisições. Rota pública precisa declarar `{ config: apenas.publico }`.

No sistema antigo era o contrário: cada rota decidia sozinha, e **70 de ~80 rotas não checavam nada** — incluindo listar clientes, apagar clientes em lote e ler a chave da API do Gemini. Proteger por rota falha porque depende de lembrar, para sempre. Agora, esquecer resulta numa rota protegida demais — que aparece no primeiro teste.

### 3. Tempo é número; fuso é dado da empresa
No banco, tempo é milissegundos desde 1970 (UTC). Para saber "que dia é hoje", é obrigatório passar o fuso da empresa.

O sistema antigo usava `toISOString()`, que é UTC. Às 21h de São Paulo já é o dia seguinte em UTC — e o sistema agendava clientes no dia errado. Há um teste que reproduz o bug antigo e trava o comportamento correto.

### 4. Dinheiro é inteiro de centavos
`R$ 45,00` é `4500`. Em JavaScript, `0.1 + 0.2` dá `0.30000000000000004`.

### 5. Horário livre é conta, não lista fixa
`modules/agenda/disponibilidade.js` calcula a partir de: jornada do profissional + duração do serviço + folga de limpeza + agendamentos + bloqueios.

O sistema antigo tinha `['09:00','10:00',...]` escrito no código — em **dois** arquivos, com valores **diferentes**. Oferecia 17:00 para um serviço de 70 min num profissional que sai às 18:00, e horário de domingo para quem não trabalha domingo.

### 6. Senha com `scrypt`, chave de API cifrada
Senhas usam `scrypt` com sal aleatório por usuário. O sistema antigo usava SHA-256 com sal fixo no código — SHA-256 foi feito para ser rápido, que é exatamente o defeito.

Chaves de API ficam cifradas no banco (AES-256-GCM). A **listagem nunca traz a chave**, só os 4 últimos caracteres. Para ver a chave inteira existe o "olho" na tela, que busca por uma rota própria (`GET /api/ia/provedores/:provedor/chave`) e só funciona para o **dono** (cargo `owner`); cada visualização vai para a auditoria (sem a chave) e a resposta sai com `Cache-Control: no-store`. Para liberar também ao gerente, troque `apenas.owner` por `apenas.admin` nessa rota.

No sistema antigo, `GET /api/ai/status` devolvia a chave inteira, em texto puro, para qualquer pessoa, sem exigir login.

### 6b. Os modelos do Gemini são testados sozinhos
Ao iniciar a API (e ao salvar uma chave nova) todos os modelos do Gemini são buscados e testados em segundo plano. O sistema separa os melhores para WhatsApp: **passou no teste + é modelo de texto**, estáveis antes de "preview", depois os mais rápidos, no máximo 8. Esses ficam ligados, o mais rápido vira o primário, e a tela mostra tudo em verde/vermelho.

O que a pessoa liga, desliga ou escolhe como primário **nunca é desfeito** por um teste novo. Se todos os modelos falharem (Google fora do ar, cota zerada), nada é desligado: uma oscilação não pode tirar o Gemini do ar.

Ao iniciar, só retesta se o último teste tiver mais de `IA_TESTE_VALIDADE_HORAS` (padrão 6) — senão o `npm run dev`, que reinicia a cada arquivo salvo, dispararia dezenas de chamadas ao Google. `IA_TESTE_AUTOMATICO=false` desliga; `GEMINI_BASE_URL` aponta para um proxy.

### 7. Dois agentes de IA: Sofia conversa, Atena mexe nos dados
**Sofia** é a frente: fala com o cliente no WhatsApp, cuida do tom. Ela **não acessa o banco**. Para qualquer coisa sobre serviços, preços, horários ou agendamentos, ela faz um pedido em linguagem natural à **Atena**.

**Atena** é uma agente de IA de verdade (outra chamada de modelo, com prompt, temperatura e ferramentas próprias): raciocina sobre o pedido, consulta o banco, e **cria, remarca, cancela e exclui** agendamentos (as OS). Devolve um relato factual para a Sofia repassar.

Por que dois e não um só: a Sofia pode ser calorosa e criativa sem contaminar a precisão de quem mexe em agenda e dinheiro; cada uma tem permissões e custo separados (a aba Métricas mostra quanto cada uma gasta).

**A IA nunca inventa preço nem horário:** quem escolhe *qual* ferramenta usar é o modelo, mas quem produz o dado é o banco, pelo mesmo código que a tela usa. A regra "não marcar por cima de outro cliente" vale para a Atena porque é literalmente a mesma função.

**Travas de uma IA que escreve no banco** (`src/ai/tools/atena.tools.js`):
- **Escopo:** só alcança agendamentos do cliente da conversa, mesmo que o modelo conheça o id de outro.
- **Não apaga histórico:** agendamento concluído, em andamento ou com falta não é excluído por ela (já é faturamento).
- **Sem preço nem desconto:** a ferramenta de edição só aceita observação.
- **Teto de 5 alterações por pedido**, contra um modelo em laço.
- **Permissões por grupo** ligáveis na tela; toda ação entra na auditoria como "Atena (IA)".
- O simulador começa em **somente leitura**.

A "Bibliotecária Atena" do sistema antigo era uma cadeia de `if` sobre palavras soltas: *"quanto tempo vocês ficam abertos?"* disparava a consulta de preços por causa do "quanto", e *"quero dar um trato no visual"* não disparava nada.

### 8. Quando a IA falha, o cliente fala com gente
Se nenhum provedor responder, a conversa vai para a fila humana. O sistema antigo mandava uma saudação genérica fingindo sucesso — que podia cair no meio de uma negociação de horário.

### 9. Escrita no banco é serializada
O SQLite aceita um escritor por vez. Uma rajada de mensagens fazia a segunda transação falhar com `database is locked`. Agora as transações entram numa fila no processo: troca-se "falhar" por "esperar um instante".

### 10. Nada é apagado de verdade
Exclusão marca `deleted_at`. Um cliente removido por engano volta; o faturamento do mês passado continua batendo.

### 11. Conexões de WhatsApp: quem faz o quê
Até **5 contas** de WhatsApp (Baileys), chaves `W1` a `W5`. A divisão é proposital, porque cada conta tem custo e risco (número banido, limite do contrato):

| Ação                                                        | DEV | dono / gerente | atendente |
| ----------------------------------------------------------- | :-: | :------------: | :-------: |
| Adicionar, remover, renomear, ativar/desativar sessão        |  ✔  |       —        |     —     |
| Conectar (ler o QR Code), desconectar, sair da conta         |  ✔  |       ✔        |     —     |
| Ajustar preferências da conta (ver abaixo) e o console       |  ✔  |       ✔        |     —     |
| Ver a lista de sessões e o estado (sem o QR Code)            |  ✔  |       ✔        |     ✔     |

Para quem não é DEV, as rotas de adicionar/remover respondem **404 idêntico ao de uma rota que não existe** (um 403 confirmaria que há um cargo acima). O nome do DEV também não aparece no console de conexões.

Preferências de cada conta (valem na hora, sem reconectar): **recusar chamadas de voz/vídeo automaticamente** (e avisar o cliente por texto, no máximo uma vez a cada 10 minutos por pessoa), **marcar mensagens como lidas** e **IA ligada/desligada** naquele número.

O **console de conexões em tempo real** mostra o que acontece em cada conta (QR gerado, conectou, caiu e quando tenta de novo, ligação recusada, resposta que não saiu). Fica em memória — é um painel de diagnóstico, não um histórico; e nunca mostra telefone inteiro nem o conteúdo das mensagens dos clientes.

**Reconexão.** Quedas de rede reconectam com intervalo crescente (2s, 4s, 8s… até 1 min). Algumas situações **não** reconectam de propósito, porque insistir só piora: sessão encerrada pelo celular, conta aberta em outro lugar (os dois se derrubariam para sempre), conta recusada pelo WhatsApp e QR Code que ninguém leu.

**Uma conversa por número.** O mesmo cliente pode escrever para dois números da empresa (W1 e W2): são **duas conversas**, cada uma respondida pelo seu número (o índice único é por cliente + conexão). Na mesa de conversas há um **filtro por canal** — ícone + chave de cada conexão — que só aparece quando há algo **conectado** (vale também para Telegram e outros canais quando existirem); cada conversa mostra de qual conexão veio. Conversas antigas, sem número gravado, são adotadas pela primeira mensagem nova.

### 12. A resposta do atendente é enviada de verdade — ou avisa que falhou
A mesa de atendimento grava a resposta **e** tenta entregá-la pelo WhatsApp. Se o número estiver desconectado, a mensagem continua salva, aparece marcada como **não entregue** com o motivo, e há um botão **Reenviar** (duplo clique não manda duas vezes). Antes disso a resposta só era gravada: o atendente via a mensagem na tela e o cliente nunca a recebia.

### 13. O recado de voz do cliente vira texto
Áudio é como boa parte dos clientes escreve. O arquivo é baixado, guardado ao lado das fotos e **transcrito**; a transcrição entra como o texto da mensagem, então a previsualização na lista, a busca e — o que importa — o histórico que vai para a Sofia funcionam sem nenhum remendo. Antes disso o áudio era descartado: o cliente falava sozinho.

A transcrição tem cascata própria (`src/ai/transcricao.js`), separada da cascata de conversa porque é outra rota e outro formato: **Groq Whisper** primeiro (modelo feito para isso, rápido e bom em português) e **Gemini** como reserva (multimodal). Usa as mesmas chaves já cadastradas na tela de Cascata — quem tem um dos dois ligado já tem transcrição.

**Quando ninguém consegue transcrever**, vale a mesma regra do item 8: a conversa vai para a **fila humana**. A IA responderia no escuro, porque ela não ouve o arquivo. O áudio fica guardado e toca no livechat, então quem assumir só precisa apertar o play.

No livechat o balão vira um **player próprio** (não o `<audio controls>` do navegador, que muda de cara em cada um e some no fundo escuro), e a transcrição fica atrás de um **"Ver transcrição"** — a um clique de distância, sem transformar o fio da conversa num muro de texto.

**O atendente também grava e manda áudio** (o microfone ao lado do campo de texto). O navegador grava em `webm/opus`; o WhatsApp só desenha a bolha de voz de verdade (a onda sonora) para `ogg/opus`. Como os dois carregam o **mesmo codec** (Opus), a conversão é um **remux** — trocar o "envelope" do arquivo, não recodificar — e por isso é quase instantânea e sem perda (`src/core/audio.js`, com `ffmpeg-static`: o binário vem empacotado no `npm install`, não precisa instalar nada à parte). O áudio enviado passa pela mesma cascata de transcrição do recebido, pelo mesmo motivo: quem reabrir a conversa depois lê o que foi dito sem precisar ouvir tudo de novo.

---

## Estado atual

| Área                                    | Situação |
| --------------------------------------- | -------- |
| Configuração, logs, erros               | pronto   |
| Banco: 24 tabelas, migrations           | pronto   |
| Núcleo: dinheiro, data, telefone, cripto | pronto  |
| Autenticação, sessões, permissões       | pronto   |
| CRM de contatos e funil                 | pronto   |
| Agenda e cálculo de disponibilidade     | pronto   |
| Catálogo: serviços, produtos, estoque   | pronto   |
| Conversas e mesa de atendimento         | pronto   |
| Motor de IA (cascata + Sofia e Atena)   | pronto — falta validar com um modelo real |
| Central de IA (4 abas + simulador)      | pronto   |
| Canal WhatsApp (Baileys, até 5 contas)  | pronto — recebe texto e áudio (transcrito); testado com um WhatsApp simulado; **falta testar com um número real** |
| Campanhas de disparo                    | pronto   |
| Frontend React                          | pronto   |

**412 testes automatizados**, todos passando. Nenhum deles chama um modelo de IA de verdade: usam um provedor de mentira que segue um roteiro, e o resto (ferramentas, banco, travas) roda de verdade. A cadeia Sofia → Atena → banco também foi exercitada pela interface, com um servidor de IA simulado — **mas nunca contra o Gemini real**. O primeiro teste com chave real deve ser feito no simulador, em modo somente leitura.

### O que ainda não existe

- Canais Telegram e Instagram Direct (a página de Conexões já tem as abas, marcadas "em breve"; falta o adaptador)
- Relatórios e exportação
- Edição do menu do WhatsApp pela tela (a API já aceita; falta o editor visual)
- Escolher um modelo específico por agente (hoje ambos usam a cascata automática)

---

## Antes de colocar no ar

- [ ] Instalar o **Git** e versionar (o `.gitignore` já está pronto)
- [ ] Trocar `APP_SECRET` no `.env` por um valor real  
      `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- [ ] Trocar as senhas de demonstração
- [ ] Manter o projeto **fora** de pastas sincronizadas (Google Drive, OneDrive) — o `npm install` falha e o banco pode corromper
- [ ] Fazer backup do arquivo `api/data/plataforma.db`
- [ ] Conectar um número de WhatsApp de teste antes de usar o número principal
