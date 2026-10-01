# Instalação na loja do cliente

Passo a passo para **instalar num cliente novo** e para **atualizar um cliente que já usa** o sistema.
Escrito para quem instala: não precisa saber programar, só seguir na ordem.

> Tempo estimado de uma instalação nova: **40 a 60 minutos** (a maior parte é esperar downloads e ler QR Codes).

---

## 1. Antes de sair para o cliente

### O que levar
- A pasta **`Plataforma`** (pendrive ou download), **sem** estas pastas/arquivos dentro dela:
  - `api/data` (é o banco de dados — o do cliente nasce lá),
  - `api/.env` (configuração desta máquina; o cliente ganha a dele),
  - `api/node_modules` e `web/node_modules` (são baixadas na hora),
  - `web/dist` (é gerada na hora).
- O **`CRIAR-DEV.bat`** vai junto (está na pasta), mas **só é usado durante a instalação e é apagado no fim** (passo 3.5).
- Seu computador ou celular com o **`GERAR-SERIAL.bat`** à mão, para gerar a licença do cliente (passo 3.4).

### O que NUNCA deixar no cliente
- **`CRIAR-DEV.bat`** — enquanto ele estiver na pasta, qualquer pessoa com acesso ao computador consegue criar um acesso de
  desenvolvedor (o perfil mais poderoso do sistema). **Apague no fim da instalação.**
- **`GERAR-SERIAL.bat`** e a pasta **`.doki-licencas`** — são do fornecedor. Sem a chave privada eles não funcionam, mas
  não há motivo para ficarem lá: **apague** o `GERAR-SERIAL.bat` da pasta do cliente.

---

## 2. Requisitos do computador da loja

- **Windows 10 ou 11.**
- **Node.js versão 22 ou mais nova (LTS)** — baixe em <https://nodejs.org> e instale com tudo no padrão.
  Para conferir: abra o "Prompt de Comando" e digite `node -v` (deve aparecer `v22...` ou maior).
- **Internet** na primeira instalação (downloads) e no dia a dia (WhatsApp e IA).
- O computador fica **ligado no horário da loja**: é ele que atende o WhatsApp.
- Para usar pelo **celular / outros computadores**: todos no **mesmo Wi-Fi**, e o Wi-Fi marcado como rede **Privada**
  no Windows (Configurações → Rede e Internet → Wi-Fi → a rede → "Rede privada").

---

## 3. Instalação num cliente novo

### 3.1 Copiar a pasta
Copie a pasta `Plataforma` para um lugar fixo do computador — por exemplo `C:\Plataforma`.
Evite a Área de Trabalho e pastas sincronizadas (OneDrive): sincronizar o banco em uso corrompe os dados.

### 3.2 Primeira execução
1. Dê dois cliques em **`INICIAR-NA-REDE.bat`** (se a loja vai usar celular ou outros computadores) ou em
   **`INICIAR.bat`** (só este computador).
   - No INICIAR-NA-REDE, o Windows pede permissão de administrador uma vez (para liberar a porta no firewall): clique em **Sim**.
2. A primeira vez demora alguns minutos: ele instala as dependências e prepara as telas. Espere.
3. Ele pergunta:
   - **Nome da empresa** — como o cliente quer que apareça (ex.: *Barbearia do Zé*);
   - **Usuário do dono** — aperte ENTER para usar `dono`, ou digite outro;
   - **Nome do dono** — o nome da pessoa.
4. Aparece uma caixa com a **senha inicial** do dono:

   ```
   INSTALACAO PRONTA: Barbearia do Zé
   Usuario do dono:  dono
   Senha inicial:    p6nTCfS6MYXT
   ANOTE AGORA. Esta senha aparece so esta vez.
   ```

   **Anote a senha (ou tire uma foto da tela)** antes de apertar ENTER. Ela aparece **só esta vez**.
5. O sistema sobe e o navegador abre sozinho em `http://localhost:5173`.
   **Não feche a janela preta**: ela é o sistema funcionando. Para desligar, use Ctrl+C nela (ou o `PARAR.bat`).

### 3.3 Primeiro acesso do dono
1. Entre com o usuário e a **senha inicial** anotada.
2. O sistema pede para **criar uma senha nova** (obrigatório — a inicial foi vista por quem instalou).
   O dono escolhe e digita **ele mesmo**. Mínimo 8 caracteres.
3. Volte ao login e entre com a senha nova.

### 3.4 Licença
1. Sem licença, o sistema mostra a tela de licença com o **código da instalação**.
2. No seu computador, rode o **`GERAR-SERIAL.bat`**, informe o código, o nome do cliente e a validade.
3. Cole o serial gerado na tela de licença do cliente (menu **Licença**, logado como dono) e clique em ativar.

### 3.5 WhatsApp (precisa do perfil DEV, só durante a instalação)
Criar o número no sistema é coisa do perfil DEV (a loja só conecta e desconecta depois).
1. Na pasta `Plataforma`, dê dois cliques em **`CRIAR-DEV.bat`** e crie um login e uma senha de DEV.
2. No navegador, **saia** do dono e entre com o login de DEV.
3. Vá em **Conexões** → **+ Nova sessão** → dê um nome ao número (ex.: "Recepção").
4. Clique em **Conectar número**. Aparece um QR Code.
5. No **celular do WhatsApp da loja**: WhatsApp → Configurações → **Aparelhos conectados** → **Conectar um aparelho** →
   aponte para o QR Code. Em alguns segundos aparece "Conectado".
6. Clique em **Sair** no perfil DEV (ele é apagado do sistema ao sair).
7. **Apague o arquivo `CRIAR-DEV.bat`** da pasta do cliente. Apague também o **`GERAR-SERIAL.bat`**.

> Combine com o cliente: o número precisa ser usado com calma no começo. **Número novo não pode disparar campanha
> grande** — o WhatsApp bane números que parecem robô. Comece com conversas normais por alguns dias.

### 3.6 Chaves de IA (atendimento automático)
1. Logado como dono, vá em **Inteligência Artificial → Cascata e provedores**.
2. Cole a chave do **Gemini** (Google AI Studio) e, se houver, a do **Groq**. Clique em **Testar** em cada uma.
3. Em **Agentes**, confira se a **Sofia** está ligada e ajuste o jeito de falar com o cliente.
4. Em **Base de conhecimento**, preencha endereço, horário, formas de pagamento e regras da casa — é o que a Sofia usa para responder.

### 3.7 Equipe e catálogo
1. **Catálogo**: cadastre os serviços (com preço e duração) e os produtos.
2. **Equipe → Profissionais**: cadastre cada profissional, a jornada e os serviços que ele faz.
   - Para o profissional ver a **própria agenda** no celular: na ficha dele, **Acesso à agenda → Criar acesso**.
     Passe a ele o usuário e a senha; no primeiro acesso ele cria a dele.
3. **Equipe → Atendentes**: cadastre quem atende no sistema (recepção). No primeiro acesso cada um cria a própria senha.

### 3.8 Certificado nos aparelhos (só no INICIAR-NA-REDE)
Pela rede, o sistema usa conexão segura (HTTPS). **Cada celular/computador** precisa instalar o certificado da loja **uma vez**:
1. Na janela preta aparece um **QR Code** e o endereço `http://<ip-do-computador>:5173/instalar-certificado`.
2. No aparelho, abra esse endereço (ou aponte a câmera para o QR) e siga a página — ela explica para **iPhone**, **Android** e **Windows**.
   - **iPhone**: depois de instalar o perfil, falta **Ajustes → Geral → Sobre → Ajustes de Confiança de Certificados** e **ligar** a chave "Plataforma".
3. Toque em **"Já instalei — abrir o sistema"**: deve abrir com o cadeado, sem aviso.
4. Para virar "app": no Android, menu do Chrome → **Instalar app**; no iPhone, Compartilhar → **Adicionar à Tela de Início**.

O computador da loja (o que roda o sistema) **não precisa** instalar o certificado.

### 3.9 Backup fora do computador
O sistema faz backup sozinho todo dia, **no mesmo computador** — se o HD estragar, vai junto. Configure a cópia externa:
1. Conecte um **pendrive/HD externo** que fique sempre ligado, ou use uma pasta sincronizada com a nuvem
   (Google Drive / OneDrive **para o backup**, não para a pasta do sistema).
2. Logado como dono: **Backups → Cópia externa** → informe a pasta → **Salvar** → **Copiar agora**.
3. Confira que apareceu a mensagem "Cópia externa feita." e que os arquivos estão na pasta.

### 3.10 Conferência final (antes de ir embora)
- [ ] O dono entrou com a **senha dele** (não a inicial).
- [ ] Licença ativa.
- [ ] WhatsApp **conectado**; mande um "oi" de outro celular e veja a mensagem chegar em **Conversas**.
- [ ] A Sofia respondeu (se a IA foi configurada).
- [ ] Um celular da loja abriu o sistema **com cadeado** (se usa pela rede).
- [ ] Cópia externa feita.
- [ ] **`CRIAR-DEV.bat` e `GERAR-SERIAL.bat` apagados** da pasta do cliente.
- [ ] Ensinou o dono a ligar o sistema (dois cliques no INICIAR) e a **não fechar a janela preta**.

---

## 4. Atualizar um cliente que já usa

1. Peça para ninguém usar o sistema por alguns minutos e **desligue** (Ctrl+C na janela preta, ou `PARAR.bat`).
2. Por segurança, logado como dono: **Backups → Fazer backup agora** (antes de desligar), ou copie a pasta `api/data` para outro lugar.
3. Copie a versão nova **por cima** da pasta do cliente, **sem apagar nem substituir**:
   - `api/data` (os dados do cliente),
   - `api/.env` (a configuração dele).
4. Se a versão nova trouxer o `CRIAR-DEV.bat` / `GERAR-SERIAL.bat`, apague-os de novo depois.
5. Dê dois cliques no **INICIAR** (ou INICIAR-NA-REDE) de sempre. Ele, sozinho:
   - instala as dependências novas, se houver;
   - aplica as mudanças no banco;
   - recompila as telas.
6. Entre e confira: conversas, agenda e WhatsApp conectado.

**Primeira atualização depois de 30/09/2026** (versão "pronto para produção") — o que muda para o cliente:
- Aparece uma linha "Segredo da instalação trocado" e é feito um backup — normal, só na primeira vez.
- Quem ainda usava a senha `trocar@123` vai ter de **criar uma senha nova** no próximo acesso.
- Pelo celular, o endereço passa a ser **https://** e cada aparelho instala o certificado uma vez (passo 3.8).
- Para programar/testar nesta máquina use o **`DESENVOLVER.bat`** (o INICIAR agora é o modo loja).

---

## 5. Se o número do WhatsApp cair

O sistema avisa: o **dono e os administradores** recebem um **aviso urgente na tela** quando o número cai e não volta
em 5 minutos (ou na hora, se o WhatsApp encerrou a sessão). Em **Conexões** aparece "Fora do ar desde …".

O que fazer:
1. Confira se o **computador está com internet**.
2. Em **Conexões**, clique em **Conectar número**.
   - Se voltar sozinho (sem QR Code): pronto.
   - Se aparecer um **QR Code**: o WhatsApp encerrou a sessão. Leia de novo pelo celular
     (WhatsApp → Aparelhos conectados → Conectar um aparelho).
3. Se aparecer **"Esta conta foi aberta em outro computador ou sistema"**: o número está conectado em outro lugar
   (outro computador com o sistema, ou outro programa). Desconecte de lá e clique em Conectar aqui.
4. Se aparecer **"O WhatsApp recusou esta conta"**: o número pode ter sido **restringido/banido** pelo WhatsApp.
   Abra o WhatsApp no celular e veja a mensagem dele. Enquanto isso, **pare as campanhas**.
5. O celular do número precisa abrir o WhatsApp de vez em quando: aparelho esquecido por muitos dias tem a sessão encerrada.

---

## 6. Problemas comuns

| O que aparece | O que fazer |
|---|---|
| "O Node.js não foi encontrado" | Instale o Node.js (passo 2) e abra o INICIAR de novo. |
| "Falha ao instalar as dependências" | Confira a internet e rode o INICIAR de novo. |
| "O APP_SECRET ainda é o de fábrica" | Rode o **INICIAR.bat** (ele gera o segredo). Não rode `npm run dev` direto. |
| O celular não abre o endereço | Mesmo Wi-Fi? Wi-Fi como rede **Privada**? Aceitou a permissão de firewall do INICIAR-NA-REDE? |
| O celular abre, mas diz "conexão não segura" | Falta instalar o certificado (passo 3.8) — no iPhone, falta ligar a confiança. |
| "Muitas tentativas. Tente de novo em X minutos." | Senha errada várias vezes: espere o tempo indicado. |
| Esqueceu a senha | Outra pessoa da gerência (dono/admin) redefine em **Equipe**; a pessoa cria uma nova no próximo acesso. |
| Sistema travado para todos com aviso de licença | A licença venceu: gere um serial novo (passo 3.4). |
