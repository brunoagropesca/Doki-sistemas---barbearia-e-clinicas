# Prompts — pronto para produção

Data: 30/09/2026. Base: `main` em `7b909f1`.

**Estes prompts ainda NÃO foram validados.** Eles saem da auditoria de segurança, configuração e instalação
feita em 30/09/2026 (resumo abaixo). O motor da IA, o de campanhas e o adaptador do WhatsApp **não** foram
revisados linha por linha; só pelos testes automatizados (1054 passando).

## Como usar

- **Um prompt por vez, na ordem.** 1 → 4 são os bloqueadores (sem eles, não instale em cliente nenhum);
  5 → 9 podem ir depois de um piloto controlado; 10 fecha com o roteiro de instalação.
- **O 5 vem antes do 6:** o HTTPS é ligado no servidor que o prompt 5 cria.
- **Espere terminar e confira antes do próximo.** Cada prompt termina pedindo a suíte completa.
- **Commits:** nenhum prompt faz commit; faça você, ou peça, depois de conferir.
- **Prompt 0:** cole uma vez no começo de cada sessão.
- **Decisões de produto marcadas com ⚖️.** O prompt vem com um valor escolhido; troque se quiser outro.

## O que a auditoria encontrou

| # | Problema | Onde | Gravidade |
|---|---|---|---|
| 1 | Toda instalação usa o **mesmo `APP_SECRET`, público** (o do `.env.example`). Ele cifra as chaves de IA no banco: quem tem uma cópia do banco (inclusive o backup no pendrive/nuvem) abre as chaves | `INICIAR.bat` copia o `.env.example`; `config/env.js` só barra o padrão com `NODE_ENV=production`, e a instalação roda como `development` | **Bloqueador** |
| 2 | Senhas padrão (`dono`/`recepcao` com `trocar@123`) que **nada obriga a trocar**; com o INICIAR-NA-REDE, qualquer um no Wi-Fi entra como dono | `db/seed.js` | **Bloqueador** |
| 3 | **Sem limite de tentativas de login**; e como o servidor calcula no máximo 2 senhas por vez, uma enxurrada de tentativas trava o login de todos | `modules/auth/auth.service.js` (`login`), `core/crypto.js` | **Bloqueador** |
| 4 | Instalação real nasce como "Barbearia Demonstracao", com **3 clientes fictícios com celulares de SP válidos** (campanha para "todos" mandaria mensagem para desconhecidos), profissionais e serviços de exemplo | `db/seed.js` (`leadsDemo`) | **Bloqueador** |
| 5 | Roda **em modo desenvolvimento** na loja: telas pelo servidor de dev do Vite (aberto na rede), API com `--watch`, e erro 500 devolve o *stack trace* | `painel.mjs`, `http/plugins/erros.js` | Alta |
| 6 | **Sem HTTPS**: senhas e conversas abertas no Wi-Fi; o celular não instala o app (PWA exige HTTPS) | toda a instalação | Alta |
| 7 | **Anexos de clientes públicos** para quem tem o link (`/api/arquivos`, sem login). Nome aleatório, mas numa clínica é dado sensível (LGPD) | `modules/equipe/equipe.routes.js` | Média |
| 8 | O perfil DEV destrava pela simples presença do `CRIAR-DEV.bat`, que **vai junto com o código** para o cliente | `config/env.js` (`DEV_ARQUIVO_CHAVE`) | Média |
| 9 | WhatsApp por **biblioteca não oficial em versão RC** (`@whiskeysockets/baileys ^7.0.0-rc14`, com `^`: pode atualizar sozinha numa instalação nova) | `api/package.json` | Média (negócio) |

O que está bom (não mexer): autenticação por lista de permitidos, permissões checadas no servidor, separação
por empresa, SQL sempre parametrizado, `caminhoDe` barra leitura fora da pasta, nenhum segredo no git,
chave privada da licença fora do projeto, backup diário + restauração agendada, `npm audit` limpo (API e telas).

---

## Prompt 0 — preparação

```
Leia o Plataforma/CONTINUAR-SESSAO.md inteiro antes de mexer em qualquer coisa. Responda em português.
Rode a suíte da API (cd Plataforma/api && npm test) e me diga quantos passam ANTES de mudar algo.
Rode também o build das telas (cd Plataforma/web && npx vite build).
Regras desta sessão:
- mudança mínima, no padrão do projeto (comentários em português explicando o PORQUÊ; camadas
  rota → service → repo; tenantId primeiro);
- confira que cada edição aplicou (o repositório mistura CRLF e LF);
- .bat sem acentos (o Windows exibe errado), como os que já existem;
- teste novo usa dados próprios e pastas TEMPORÁRIAS; NUNCA mexa em Plataforma/api/data nem no
  Plataforma/api/.env reais para testar;
- tudo que mudar a instalação tem de funcionar TAMBÉM numa instalação que já existe (atualização),
  não só numa máquina nova.
Ao terminar: suíte COMPLETA, build das telas, resultado e explicação do que mudou. Não faça commit sem eu pedir.
```

---

## Prompt 1 — Segredo próprio em cada instalação

```
PROBLEMA: o INICIAR.bat cria o api/.env copiando o .env.example, então TODA instalação fica com
APP_SECRET=dev-secret-trocar-em-producao-1234567890. Esse segredo deriva a chave AES que cifra as chaves de IA
(core/crypto.js, chaveDoCofre: sha256(APP_SECRET + ':cofre-v1')) e assina o cookie. Como o valor é público (está
no git), qualquer cópia do banco — inclusive o backup que vai para pendrive/nuvem (copia-externa.js) — abre as
chaves do Gemini/Groq/Hades. A proteção de config/env.js só vale com NODE_ENV=production, e a instalação roda
como development.

SOLUÇÃO:
1. Script api/src/db/preparar-env.js (npm run env:preparar), chamado pelo INICIAR.bat NO LUGAR do "copy":
   - sem .env: copia o .env.example e troca o APP_SECRET por 64 caracteres hex aleatórios (crypto.randomBytes);
   - com .env e APP_SECRET ainda no valor padrão: gera um novo E RECIFRA o que foi cifrado com o antigo
     (passo 2) ANTES de gravar o .env novo. Se a recifragem falhar, NÃO troca o .env (senão as chaves se perdem);
   - com .env e segredo próprio: não faz nada.
   Escreva o .env preservando as outras linhas e comentários; mude só a linha APP_SECRET.
2. Recifragem: tudo que usa cifrar()/decifrar() — ai_providers.api_key_cifrada e a chave do Hades
   (settings, ver modules/hades/hades.config.js). Procure com grep "cifrar(" se há mais algum. Decifra com o
   segredo antigo e cifra com o novo, numa transação. Faça backup (criarBackup, motivo novo
   'antes_de_trocar_segredo') antes. O banco de demonstração (…-demonstracao.db) pode ser só apagado.
3. config/env.js: fora dos testes (NODE_ENV=test), recuse subir com o APP_SECRET padrão EM QUALQUER
   ambiente, com mensagem clara ("rode o INICIAR.bat, que gera o segredo"). Os testes continuam usando o
   .env.test.
4. Sessões: trocar o segredo pode invalidar cookies assinados; tudo bem (todos entram de novo), mas confira
   que o login volta a funcionar.

TESTES (pasta temporária com um .env e um banco próprios):
- sem .env → cria com segredo aleatório de 64 hex, e rodar de novo não troca;
- .env com o segredo padrão + provedor de IA com chave cifrada → depois do script, a chave decifra com o
  segredo NOVO e é igual à original;
- falha simulada na recifragem → .env continua como estava;
- env.js recusa o segredo padrão com NODE_ENV=development e aceita com NODE_ENV=test.
Me diga também como fica a atualização de uma instalação que já existe (o que o dono vai ver).
```

---

## Prompt 2 — Troca de senha obrigatória no primeiro acesso

```
PROBLEMA: db/seed.js cria dono/recepcao com a senha trocar@123 e nada obriga a trocar. Com o INICIAR-NA-REDE,
qualquer pessoa no Wi-Fi entra como dono. O mesmo vale para senha definida por outra pessoa (gerente
redefinindo a senha de um atendente em Equipe, ou criando o acesso do profissional).

⚖️ Regra: a pessoa troca a senha no primeiro login sempre que a senha foi definida por OUTRA pessoa
(seed, cadastro pela gerência, "redefinir senha", acesso do profissional). Trocar a própria senha libera.

SOLUÇÃO:
1. Coluna users.senha_provisoria (boolean, padrão false) — migration nova só adicionando a coluna. Marque true
   em: seed, criarUsuario, editarUsuario com novaSenha (quando o solicitante não é a própria pessoa),
   definirAcesso do profissional (equipe.service.js). Instalações existentes: marque true para quem ainda
   tem o hash da senha trocar@123 (confira com conferirSenha no boot/migração, uma vez só).
2. usuarioPublico devolve senhaProvisoria. Com ela true, o plugin de autenticação só deixa passar
   /api/auth/eu, /api/auth/trocar-senha, /api/auth/logout e /api/textos (403 com código SENHA_PROVISORIA
   no resto). Mesmo esquema de lista de permitidos do cargo profissional.
3. trocarSenha: zera senha_provisoria e recusa nova senha igual a trocar@123.
4. Tela: com usuario.senhaProvisoria, App.jsx mostra SÓ uma tela "Crie sua senha" (senha atual + nova +
   confirmar), antes de Layout e antes de MeuDia (vale para o profissional também). Ao salvar, o servidor
   derruba as sessões (já faz); leve a pessoa de volta ao login com aviso "Senha criada, entre de novo".
5. A mensagem do seed ("TROQUE ESSAS SENHAS") pode sair: agora o sistema obriga.

TESTES:
- login com senha provisória → /api/auth/eu 200 com senhaProvisoria true; /api/agenda 403 SENHA_PROVISORIA;
- depois de trocar → tudo liberado e senhaProvisoria false;
- gerente redefine a senha de um atendente → atendente cai na troca obrigatória;
- a pessoa trocando a própria senha em Meu perfil NÃO fica provisória;
- acesso do profissional criado pela ficha → provisória; o profissional troca e vê o Meu dia.
Ajuste os testes existentes que fazem login com trocar@123 (o helper entrar() pode trocar a senha na primeira
vez, ou o seed dos testes cria sem provisória — escolha o que mexer menos e explique).
```

---

## Prompt 3 — Limite de tentativas de login

```
PROBLEMA: login() (modules/auth/auth.service.js) não limita tentativas: dá para testar senhas sem parar pela
rede. E como core/crypto.js deixa só 2 scrypt ao mesmo tempo, uma enxurrada de tentativas enfileira todo mundo
e o login dos funcionários trava.

⚖️ Regra: 5 erros seguidos no mesmo USUÁRIO → esse usuário fica bloqueado por 15 min (conta a partir do último
erro). 20 erros do mesmo IP em 15 min → o IP é bloqueado por 15 min. Acerto zera o contador do usuário.

SOLUÇÃO:
1. Contadores em memória (Map com expiração; é uma máquina só e reiniciar zerar é aceitável). Um módulo
   pequeno, ex. modules/auth/tentativas.js, com funções puras testáveis (registrarErro, registrarAcerto,
   bloqueio(chave) → ms restantes).
2. A checagem acontece ANTES do scrypt (é isso que protege a fila). Bloqueado → erro 429 com código
   MUITAS_TENTATIVAS e mensagem "Muitas tentativas. Tente de novo em X minutos." — a mesma para usuário que
   existe e que não existe (não pode revelar quais logins existem). Use a classe de erro 429 que já existe
   em core/errors.js.
3. Contar erro também para usuário inexistente (senão o atacante descobre quem existe pelo bloqueio).
4. Registre na auditoria/log o bloqueio (usuário, IP), sem a senha.
5. Tela de login: mostre a mensagem do 429 como aviso, sem limpar o usuário digitado.
6. O IP vem de req.ip (trustProxy já configurado para o proxy local). Confira que o INICIAR-NA-REDE registra o
   IP do aparelho, e não 127.0.0.1 — senão o bloqueio por IP pegaria todo mundo junto.

TESTES (tempo controlável: injete o relógio no módulo, sem esperar 15 min):
- 5 senhas erradas → 6ª tentativa, mesmo com a senha CERTA, dá 429;
- passados 15 min → entra;
- acerto na 4ª zera o contador;
- usuário inexistente também bloqueia, e a resposta é igual à do existente;
- 20 erros de um IP em usuários variados → IP bloqueado;
- bloqueado não chega a rodar scrypt (espione conferirSenha ou meça _picoScrypt).
```

---

## Prompt 4 — Instalação real começa limpa

```
PROBLEMA: na primeira execução o INICIAR.bat roda npm run db:seed, que cria a empresa "Barbearia
Demonstracao" com 3 clientes fictícios com celulares de SP válidos (11988776655, 11977665544, 11966554433),
2 profissionais, serviços, produtos e um canal. Numa loja real, uma campanha para "todos os clientes"
mandaria mensagem para desconhecidos, e a Sofia ofereceria profissionais que não existem.

⚖️ Regra: instalação real nasce com a empresa, o dono e as configurações de fábrica (agentes de IA, menu,
ajustes) — SEM clientes, profissionais, serviços, produtos nem canais de exemplo. O nome da empresa e o login
do dono são definidos na instalação.

SOLUÇÃO:
1. Separe o seed em dois: instalar() (empresa + dono + configuração de fábrica) e o seed de EXEMPLO
   (profissionais, serviços, produtos, clientes, canal), que continua existindo para desenvolvimento e para os
   testes. Não quebre os testes: criarAppDeTeste continua semeando o exemplo completo.
2. npm run db:instalar (novo) pergunta no terminal: nome da empresa, usuário do dono (padrão "dono") e nome
   dele. A senha inicial é gerada aleatória (12 caracteres legíveis), mostrada UMA vez no terminal, e fica
   como senha provisória (prompt 2) — o dono troca no primeiro acesso.
   O slug vem do nome (sem acento, minúsculo). Sem terminal interativo, aceite argumentos (--empresa, --dono).
3. INICIAR.bat: sem banco → chama db:instalar (não mais db:seed). Mostre a senha gerada numa caixa visível e
   peça para anotar antes de continuar (pause).
4. Os clientes de exemplo, onde continuarem existindo (dev/testes), passam a usar números impossíveis
   (DDD 10, prefixo 55109…), como a exportação da demonstração já faz (modules/demonstracao/exportar.js).
5. Instalação que JÁ existe: não mexa nos dados. Só no boot, se ainda houver os 3 clientes de exemplo com
   aqueles telefones exatos e sem nenhuma conversa, mostre um aviso no painel do DEV (não apague sozinho).

TESTES:
- instalar() num banco vazio → 1 empresa, 1 dono (senha provisória), agentes e menu de fábrica; 0 clientes,
  0 profissionais, 0 serviços, 0 canais;
- rodar instalar() de novo não duplica nada;
- a suíte inteira continua passando com o seed de exemplo.
Depois, apague uma cópia TEMPORÁRIA da pasta data e simule a primeira execução do INICIAR.bat de ponta a
ponta (sem tocar na data real), e me mostre o que o dono vê.
```

---

## Prompt 5 — Rodar em modo de produção na loja

```
PROBLEMA: na máquina do cliente o painel.mjs sobe a API com --watch (reinicia se qualquer arquivo mudar) e as
telas pelo SERVIDOR DE DESENVOLVIMENTO do Vite — no INICIAR-NA-REDE aberto para a rede (--host 0.0.0.0),
servindo o código-fonte e o HMR. E com NODE_ENV=development o erro 500 devolve o stack trace ao navegador
(http/plugins/erros.js).

SOLUÇÃO:
1. A API passa a servir as telas compiladas: @fastify/static com Plataforma/web/dist na raiz, e fallback para
   index.html em qualquer GET que não seja /api/* nem arquivo existente (o React Router cuida da rota).
   Cabeçalhos: assets com hash → cache de 1 ano; index.html e sw.js → no-cache.
   Confira o service worker (web/public/sw.js) e o manifest com o novo endereço.
2. Modo "loja" (INICIAR.bat): roda npx vite build quando o dist não existe ou está mais velho que o código
   (compare datas), e sobe SÓ a API, sem --watch, com NODE_ENV=production, na porta das telas.
   ⚖️ Porta: a API passa a atender na 5173 (é o endereço que as pessoas já usam/salvaram); 3333 sai de uso na loja.
3. Acesso pela rede (INICIAR-NA-REDE): HOST=0.0.0.0 só neste modo; no INICIAR normal continua 127.0.0.1.
   Ajuste a regra de firewall se a porta mudar.
4. Modo desenvolvimento (quem programa) continua como hoje: um comando/flag separado
   (ex. node painel.mjs --dev, ou DESENVOLVER.bat) com Vite dev + --watch. O painel colorido continua nos dois.
5. NODE_ENV=production liga coisas que hoje dependem dele: confira uma por uma (grep isProd/isDev/NODE_ENV) —
   cookie secure (só com HTTPS: até o prompt 6 precisa continuar false, senão ninguém loga pelo IP),
   trustProxy, CORS (mesma origem agora), logs em JSON, a trava de APP_SECRET (prompt 1), stack trace fora
   da resposta. Documente cada uma no CONTINUAR-SESSAO.md.
6. O religamento automático do painel.mjs (MAX_RELIGACOES) continua valendo sem o --watch.

TESTES:
- rota de teste: GET / e GET /agenda devolvem o index.html; GET /api/xyz inexistente continua 404 JSON;
  GET de um asset devolve o arquivo com cache longo;
- em produção, erro 500 NÃO tem debug/stack no corpo;
- suíte completa + build.
Depois suba em modo loja numa porta alternativa (sem derrubar o que estiver rodando), abra pelo navegador,
faça login, abra agenda e conversas, e me confirme que não há requisição para o Vite.
```

---

## Prompt 6 — HTTPS na rede da loja

```
PROBLEMA: sem HTTPS, senhas, cookies e conversas trafegam abertos no Wi-Fi, e o celular não instala o app
(PWA e service worker exigem HTTPS fora do localhost) — o login do profissional no celular é o caso mais
afetado.

⚖️ Solução escolhida: certificado próprio da instalação (uma autoridade local gerada na primeira execução),
com instrução para instalar essa autoridade uma vez em cada aparelho. Alternativa descartada por agora: túnel
(Cloudflare Tunnel) com domínio — dá HTTPS de verdade e acesso de fora da loja, mas exige conta e domínio.

SOLUÇÃO:
1. Na primeira execução do modo rede, gere (node:crypto / sem dependência nova se possível; se precisar, uma
   biblioteca pequena e bem mantida, justificando) uma autoridade local e um certificado do servidor válido
   para localhost, 127.0.0.1, o nome do computador e os IPs locais atuais. Guarde em api/data/https/
   (fora do git). Regenere o certificado do servidor quando o IP mudar; a autoridade fica.
2. A API (modo loja do prompt 5) atende em HTTPS. Mantenha HTTP só para redirecionar para HTTPS e para servir
   o arquivo da autoridade (/instalar-certificado) com uma página simples explicando como instalar no
   Android, iPhone e Windows.
3. Com HTTPS: cookie secure = true, HSTS curto (1 dia) para não travar ninguém se precisar voltar atrás.
4. INICIAR-NA-REDE mostra o endereço https://IP:porta e o endereço da página de instalação.
5. O modo desenvolvimento continua em HTTP.

TESTES:
- certificado gerado contém os IPs/nomes certos e é assinado pela autoridade;
- rodar de novo não troca a autoridade;
- HTTP redireciona para HTTPS (menos /instalar-certificado);
- cookie de sessão sai com Secure em HTTPS.
Depois me passe o passo a passo para eu testar no meu celular.
```

---

## Prompt 7 — Anexos só para quem está logado

```
PROBLEMA: GET /api/arquivos/:nome (modules/equipe/equipe.routes.js) é público. Estão lá fotos de clientes,
áudios recebidos e documentos (PDFs) que os clientes mandam no WhatsApp — numa clínica, dado de saúde (LGPD).
O nome é um UUID (não dá para adivinhar), mas um link copiado/encaminhado abre para qualquer um.
O comentário da rota diz que <img>/<audio> "não mandam cabeçalho de autenticação": é verdade para o
Authorization, mas o COOKIE de sessão (httpOnly, sameSite=lax) vai junto em requisição da mesma origem —
então dá para exigir login sem quebrar as telas.

SOLUÇÃO:
1. A rota passa a exigir sessão (apenas.profissional: qualquer cargo logado, inclusive o profissional, que vê
   a foto no Meu dia). Sem sessão → 404 (não 401: não confirma que o arquivo existe).
2. Empresa: descubra se o arquivo é da empresa de quem pede. Hoje o nome não diz. Opção: tabela/índice
   leve de arquivos (nome → tenantId, gravado em salvarImagem/salvarAnexo/áudio), com migração que preenche
   a partir das colunas que citam /api/arquivos/ (o orfaos.js já sabe varrer isso). Arquivo sem dono conhecido
   → só o dono/dev.
3. Cache: troque "public, max-age=1 ano" por "private, max-age=1 ano" (não pode ficar em cache compartilhado).
4. Confira tudo que usa essas URLs sem ser o navegador logado: envio de mídia pelo WhatsApp (Baileys lê do
   disco? confirme), Hades/IA, exportação de relatório, e-mails, página pública se houver. Nada pode quebrar.
5. Service worker (sw.js): não pode guardar esses arquivos num cache acessível sem login; confira.

TESTES:
- sem login → 404; logado da mesma empresa → 200 com o conteúdo; logado de OUTRA empresa → 404;
- profissional logado vê a própria foto;
- faixa (Range) de áudio continua funcionando;
- a migração associa os arquivos existentes à empresa certa.
```

---

## Prompt 8 — Chave do perfil DEV fora do código

```
PROBLEMA: o perfil DEV destrava enquanto existir o arquivo CRIAR-DEV.bat na pasta (config/env.js,
DEV_ARQUIVO_CHAVE). Esse .bat está no git e vai junto com o código para o cliente — então, em toda instalação,
basta rodar o .bat (ele cria o usuário) para ter o cargo mais poderoso, que vê todas as empresas e o banco
de demonstração.

⚖️ Regra: a chave passa a ser um arquivo SECRETO que só o fornecedor tem (ex.: dev.chave, com conteúdo
aleatório), fora do git. O CRIAR-DEV.bat continua no código, mas sem a chave não faz nada.

SOLUÇÃO:
1. A chave: o arquivo DEV_ARQUIVO_CHAVE passa a precisar de um CONTEÚDO que confere com um hash guardado no
   código (ou na chave pública da licença, que já existe em licenca/chave-publica.js — prefira reaproveitar:
   o conteúdo é um token assinado pela chave privada do fornecedor, com validade de ex. 24 h).
   GERAR-SERIAL.bat (que já roda só na máquina do fornecedor) ganha a opção de gerar essa chave.
2. devLiberado() (auth.service.js) confere a assinatura e a validade, não só a existência. Chave vencida
   derruba o DEV na próxima requisição, como hoje ao apagar o arquivo.
3. CRIAR-DEV.bat: sem chave válida, avisa e não cria o usuário. Com chave, igual a hoje.
4. .gitignore: o arquivo da chave.
5. INICIAR.bat: se encontrar uma chave, avise no painel que o modo DEV está liberado nesta máquina (para
   ninguém esquecer a chave no cliente).

TESTES:
- sem arquivo → DEV não entra; arquivo com conteúdo qualquer → não entra; chave assinada válida → entra;
  chave vencida → não entra e quem estava dentro cai;
- o que já é testado sobre o DEV (invisível, 404 para os outros) continua passando.
```

---

## Prompt 9 — WhatsApp: versão travada e alerta quando cai

```
PROBLEMA: o WhatsApp usa @whiskeysockets/baileys ^7.0.0-rc14 — biblioteca NÃO oficial, em versão release
candidate, e com "^": uma instalação nova pode baixar outra RC com mudança de comportamento. Não dá para
eliminar o risco (o WhatsApp pode banir o número ou mudar o protocolo), mas dá para (a) não mudar de versão
sem querer e (b) avisar o dono na hora quando o número cair.

SOLUÇÃO:
1. Versão exata no package.json (sem ^/~) da que está instalada e testada hoje (confira em
   node_modules/@whiskeysockets/baileys/package.json). O package-lock.json já vai no git; confirme que o
   INICIAR.bat instala a partir dele (npm ci quando o lock existe, em vez de npm install).
2. Alerta de número caído: quando uma conexão sai de "conectado" e não volta sozinha em ⚖️ 5 minutos (ou cai
   por logout/ban, que não volta), mostre um aviso URGENTE para o dono e os administradores (use o mesmo
   mecanismo de aviso por cima de tudo que já existe, ou as notificações), com o nome do número e o que fazer.
   Uma vez por queda, não a cada tentativa.
3. Na tela de Conexões, mostre desde quando o número está desconectado.
4. Escreva no CONTINUAR-SESSAO.md (seção de riscos) o que é o Baileys, o risco de banimento e boas práticas
   (não disparar campanha grande em número novo, respeitar os intervalos já configurados).

TESTES (adaptador simulado, sem WhatsApp de verdade):
- queda com volta em menos de 5 min → sem alerta;
- queda sem volta em 5 min → 1 alerta para dono/admins, não para atendentes;
- logout → alerta imediato;
- reconectar fecha o alerta.
```

---

## Prompt 10 — Roteiro de instalação e revisão final

```
Com os prompts 1 a 9 aplicados, escreva Plataforma/INSTALACAO.md: o passo a passo para instalar num cliente
novo e para ATUALIZAR um cliente existente, na linguagem de quem instala (não de quem programa).
Inclua: requisitos (Windows, Node LTS), primeira execução, anotar a senha do dono, instalar o certificado nos
aparelhos, conectar o WhatsApp, cadastrar chaves de IA, conferir o backup externo, NÃO levar a chave do DEV,
e o que fazer se o número cair.
Depois faça uma revisão final: rode a suíte e o build, suba o sistema em modo loja numa pasta de dados
TEMPORÁRIA simulando um cliente novo, e percorra: primeiro acesso do dono (troca de senha), cadastro de um
profissional com acesso à agenda, login do profissional, marcar um horário, e um login errado 6 vezes.
Me entregue a lista do que funcionou e do que não funcionou, sem corrigir nada que não esteja nos prompts.
```
