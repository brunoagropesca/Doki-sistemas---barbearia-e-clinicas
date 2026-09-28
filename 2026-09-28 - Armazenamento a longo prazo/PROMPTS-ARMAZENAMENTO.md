# Prompts — armazenamento a longo prazo

Data: 28/09/2026. Base: `main` em `1d9d3c5`.

**Estes prompts ainda NÃO foram validados** (diferente dos de usabilidade). Eles saem de uma análise medida no
banco e nas pastas reais (`Plataforma/api/data`), descrita abaixo. Cada prompt pede a suíte antes e depois; confira
um por um.

## Como usar

- **Um prompt por vez, na ordem.** 1 → 3 não mudam nada no atendimento (só disco); 4 → 6 mexem no que é gravado;
  7 → 9 são funções novas.
- **Espere terminar e confira antes do próximo.** Cada prompt termina pedindo a suíte completa.
- **Commits:** nenhum prompt faz commit; faça você, ou peça, depois de conferir.
- **Prompt 0:** cole uma vez no começo de cada sessão.
- **Decisões de produto marcadas com ⚖️.** O prompt vem com o valor combinado; troque se mudar de ideia.

## Decisões já tomadas

- **Mídia antiga — 1 ano por ANO CHEIO** (não 365 dias): facilita os relatórios, que são por ano.
  ⚖️ Regra escrita nos prompts: a mídia criada em qualquer dia do ano **A** fica guardada até **31/12 do ano A+1**
  e sai no dia **01/01 do ano A+2**. Exemplo: tudo de 2026 (de janeiro a dezembro) fica até 31/12/2027 e sai em
  01/01/2028. Assim cada ano fica inteiro por um ano completo depois de fechado.
  A transcrição dos áudios e o texto das conversas **ficam para sempre** — sai só o arquivo.
- **O dono tem acesso às funções de backup** (hoje só o perfil DEV tem). "Apagar dados" continua só do DEV.

## O que a análise encontrou (medido em 28/09/2026)

| # | Problema | Onde | Gravidade |
|---|---|---|---|
| 1 | Cada backup diário copia **toda** a pasta de mídia; guardando 14, cada foto/áudio ocupa até **15×** o espaço (hoje: 8,4 MB de backup para 1,9 MB de mídia) | `modules/dados/backups.js` (`cpSync` em `criarBackup`) | **Alta** |
| 2 | Backup no **mesmo disco** do sistema: HD que morre leva original e cópia | `data/backups` | **Alta** |
| 3 | Arquivos **órfãos** nunca saem: "Apagar dados" parcial remove o cliente e deixa a foto (3 fotos idênticas sem dono hoje). Também é ponto de LGPD | `data/uploads` | Média |
| 4 | Cada balão da Sofia grava o **rastro completo** da resposta (consultas, Atena) — média 452 bytes, 6× o texto, repetido em cada balão da mesma resposta | `channels/gateway.js` (`registrarEnviada`, `metadados: { ...resposta.detalhes }`) | Média |
| 5 | Registros sem prazo: `ai_calls` (1 por chamada de IA), `audit_logs`, notificações fechadas | várias tabelas | Média |
| 6 | O arquivo do banco **nunca encolhe** (sem `auto_vacuum`, sem manutenção) | `db/client.js` | Baixa |
| 7 | Áudio do atendente guardado a 128 kbps (4 s = 69 KB); o do WhatsApp usa ~32 kbps (4× menor) | `core/audio.js` | Baixa |
| 8 | A Sofia **não lembra do cliente** entre conversas: lê só as 8 últimas mensagens da conversa atual | `atendimento.service.js` (`historicoParaIa`) | Média (qualidade) |

Não é problema: as chaves do WhatsApp (812 arquivos em `data/whatsapp`) não crescem — o Baileys mantém ~812.
Sessões já são limpas no boot.

**Projeção** (barbearia com ~60 conversas/dia, 30 áudios e 10 fotos): hoje, em 1 ano, ~150 MB de banco,
~1 GB de mídia e **~14 GB de backups**. Com os prompts: ~60 MB, ~400 MB e ~1 GB.

---

## Prompt 0 — preparação

```
Leia o Plataforma/CONTINUAR-SESSAO.md inteiro antes de mexer em qualquer coisa. Responda em português.
Rode a suíte da API (cd Plataforma/api && npm test) e me diga quantos passam ANTES de mudar algo.
Regras desta sessão:
- mudança mínima, no padrão do projeto (comentários em português explicando o PORQUÊ; camadas
  rota → service → repo; tenantId primeiro);
- confira que cada edição aplicou (o repositório mistura CRLF e LF);
- teste novo usa dados próprios (telefones/ids próprios) e pastas TEMPORÁRIAS para arquivos
  (nunca a pasta data/ real);
- NUNCA apague nada em Plataforma/api/data para testar: use uma cópia isolada;
- migrations: npx drizzle-kit generate --name X, confira que o SQL só ADICIONA e que o "when" do journal cresce.
Ao terminar: suíte COMPLETA, resultado e explicação do que mudou. Não faça commit sem eu pedir.
```

---

## Prompt 1 — Backup incremental: a mídia é copiada UMA vez

```
PROBLEMA (medido): criarBackup (modules/dados/backups.js) faz cpSync da pasta de uploads INTEIRA em cada
backup. Com MANTER_AUTOMATICOS = 14, cada foto/áudio existe até 15 vezes no disco. Hoje: 8,4 MB de backups para
1,9 MB de mídia; numa barbearia movimentada seriam ~14 GB em um ano.

POR QUE DÁ PARA NÃO COPIAR: os arquivos de upload nunca mudam depois de gravados (o nome tem UUID; trocar foto
gera arquivo novo). Então basta UMA cópia de cada arquivo.

SOLUÇÃO:
1. Cofre de mídia: data/backups/_midia/ (uma pasta só, compartilhada por todos os backups). No backup, copie para
   o cofre só os arquivos que ainda NÃO estão lá (mesmo nome e mesmo tamanho = já existe).
2. Cada backup grava midia.json: a lista de arquivos (nome, tamanho) que existiam naquele momento. É o que a
   restauração usa para saber o que devolver.
3. banco.db compactado: depois do VACUUM INTO, gere banco.db.gz (zlib gzip, stream) e apague o .db. SQLite
   compacta bem (~70-80%).
4. Restauração (db/restauracao.js, aplicarRestauracaoPendente): se o backup tem midia.json, copia do cofre para
   uploads SÓ os arquivos da lista que faltam; se é backup ANTIGO (tem a pasta arquivos/), continua como hoje.
   Se é banco.db.gz, descompacta antes de trocar o banco. Os backups antigos têm de continuar restaurando.
5. Limpeza do cofre: quando um backup é apagado (limparAutomaticosAntigos ou apagarBackup), apague do cofre os
   arquivos que nenhum midia.json restante cita E que não estão mais em uploads.
6. Migração única, no boot: se existirem backups antigos com arquivos/, mova para o cofre o que ainda não está
   lá e gere o midia.json deles (sem perder nada). Log com quanto espaço foi liberado.
7. listarBackups/apresentar: o tamanho de cada backup passa a ser banco + o que só ele referencia; mostre também
   o tamanho total do cofre.
8. arquivoDoBackup (download): continua entregando o banco (descompactado na hora, ou o .gz com nome .db.gz).

TESTES (pastas temporárias, nunca data/ real):
- 3 backups seguidos com os mesmos arquivos → cada arquivo aparece UMA vez no cofre;
- restaurar um backup novo devolve exatamente os arquivos da lista dele;
- backup no formato antigo (com arquivos/) continua restaurando;
- apagar um backup não remove do cofre arquivo que outro backup ainda cita;
- banco.db.gz restaura íntegro (conte as linhas de uma tabela antes e depois).
Rode a suíte COMPLETA e me diga quanto espaço os backups ocupariam no data/ real (só leitura, sem mexer).
```

---

## Prompt 2 — Limpeza de arquivos órfãos

```
PROBLEMA (medido): em data/uploads há 3 fotos idênticas (mesmo md5) que nenhum cliente usa: "Apagar dados"
parcial remove o cadastro e deixa o arquivo. Arquivo órfão ocupa disco, entra no backup e, se é de um cliente
que pediu exclusão, é problema de LGPD.

SOLUÇÃO:
1. Novo módulo (ex.: modules/dados/orfaos.js) que lista os arquivos de data/uploads e os REFERENCIADOS no banco:
   procure '/api/arquivos/' em todas as colunas que guardam caminho — messages.midia_url, leads.foto_url,
   products.foto_url, professionals.foto_url, users.avatar, agent_profiles.avatar — e nos JSON (settings,
   ex.: logo em empresa.base_conhecimento; metadados de mensagens). Faça um grep no src para não esquecer nenhuma.
2. Órfão = arquivo que nada referencia E foi modificado há mais de 24 h (carência: nunca apagar um upload que
   está sendo gravado agora).
3. Rotina semanal (junto das rotinas de automacao/rotinas.js, fora do bloqueio de licença, como o backup) que
   apaga os órfãos e registra quantos e quanto espaço liberou (log + auditoria).
4. apagar.js ("Apagar dados"): ao apagar um grupo, rode a limpeza de órfãos logo em seguida (sem carência para os
   arquivos daquele grupo).
5. Exclusão de cliente (LGPD): quando um lead é excluído, as mídias das conversas dele saem junto. Confira o que o
   sistema já faz na exclusão e complete.
6. Segurança: o cofre de backups (_midia) NÃO é tocado por esta rotina — backup existe para ter o que já saiu.

TESTES (pasta temporária): arquivo referenciado fica; órfão antigo sai; órfão recém-criado (< 24 h) fica;
arquivo citado só num JSON de settings fica.
Rode a suíte COMPLETA.
```

---

## Prompt 3 — Manutenção do SQLite (o banco volta a encolher)

```
PROBLEMA: o banco não tem auto_vacuum nem manutenção. Depois de apagar dados (ou das limpezas dos prompts
seguintes), o arquivo não diminui; o WAL pode crescer entre checkpoints.

SOLUÇÃO (db/client.js e rotinas):
1. auto_vacuum = INCREMENTAL. Em banco existente isso só vale depois de um VACUUM completo: no boot, se
   PRAGMA auto_vacuum ainda for 0 (NONE), rode PRAGMA auto_vacuum = INCREMENTAL + VACUUM uma única vez
   (antes de abrir a porta HTTP; logue o tempo e o tamanho antes/depois).
2. Diariamente (logo depois do backup automático): PRAGMA optimize e PRAGMA wal_checkpoint(TRUNCATE).
3. Semanalmente (junto da limpeza de órfãos): PRAGMA incremental_vacuum.
4. Nada disso pode travar o atendimento: rode fora do horário de pico quando der (use o mesmo horário de
   fechamento do dia da Atena) e nunca em paralelo com o backup.

TESTES: num banco temporário, insira e apague linhas e confirme que depois do incremental_vacuum o
freelist_count cai e o arquivo encolhe.
Rode a suíte COMPLETA.
```

---

## Prompt 4 — Rastro da IA enxuto

```
PROBLEMA (medido): channels/gateway.js grava em CADA balão da Sofia metadados: { ...resposta.detalhes, balao,
totalBaloes } — o rastro inteiro (consultas com resultados, Atena, ferramentas). Média 452 bytes por mensagem da
IA (6× o texto), máximo 2,4 KB, e repetido em todos os balões da mesma resposta.

SOLUÇÃO:
1. O rastro completo vai só no PRIMEIRO balão; os seguintes gravam só { balao, totalBaloes } e o que a tela usa
   (confira no web/src quem lê metadados de mensagem: Conversas.jsx, livechat, Central de IA — o Simulador lê a
   resposta ao vivo, não o banco).
2. Rastro antigo: rotina semanal que, em mensagens da IA com mais de 90 dias, troca o rastro por um resumo
   ({ provedor, modelo, ferramentas: [nomes], voltas }) — os resultados das consultas saem. Serve para depurar o
   que acabou de acontecer; depois de 3 meses só pesa.
3. Não mexa nos metadados de mensagens de cliente e de atendente (canal, duração do áudio, anexo, transcrição).

TESTES: resposta com 3 balões grava o rastro só no primeiro; mensagem da IA com 100 dias fica só com o resumo;
uma de 10 dias fica intacta.
Rode a suíte COMPLETA e me diga quanto os metadados das mensagens da IA ocupam antes e depois no banco de teste.
```

---

## Prompt 5 — Prazo de validade dos registros

```
PROBLEMA: estas tabelas só crescem: ai_calls (uma linha por chamada de IA — a maior em volume), audit_logs e
notificações da equipe já fechadas.

SOLUÇÃO:
1. ai_calls: detalhe de 90 dias. Antes de apagar, some por MÊS (tenant, mês, origem, provedor, modelo, chamadas,
   sucesso, falhas, tokens de entrada e saída, latência média) numa tabela nova de totais (migration, só ADD).
   Tudo que hoje mostra custo/uso de IA (Central de IA, dashboard) passa a somar detalhe recente + totais antigos,
   para os números de meses e ANOS antigos continuarem certos — relatório é por ano.
2. audit_logs: 2 anos, contados por ANO CHEIO (o ano de 2026 inteiro fica até 31/12/2028).
3. Notificações fechadas: 30 dias.
4. Tudo na rotina semanal; cada limpeza registra quantas linhas saíram.

TESTES: chamadas de IA de 100 dias viram totais e os números do mês continuam iguais antes e depois; auditoria de
2025 fica e de 2023 sai (em 2026); notificação aberta nunca sai.
Rode a suíte COMPLETA.
```

---

## Prompt 6 — Áudio do atendente em 32 kbps

```
PROBLEMA (medido): core/audio.js faz remux (-c:a copy) do webm/opus do navegador, que grava a ~128 kbps: 4 s de
fala = 69 KB. O áudio do WhatsApp usa ~32 kbps mono (7 s = 17 KB).

SOLUÇÃO: paraOggOpus passa a RECODIFICAR sempre para opus mono 32 kbps 48 kHz (o mesmo que hoje é o plano B do
Safari). Custo medido da recodificação: ~0,2 s por áudio curto. Mantenha o timeout e o teste de 30 conversões
simultâneas (nenhuma cortada nem com falha).

TESTES: o arquivo convertido de um webm de 5 s fica pelo menos 3× menor que o de antes e continua ogg/opus
(OggS + OpusHead); conversões simultâneas continuam inteiras.
Rode a suíte COMPLETA.
```

---

## Prompt 7 — Backups e armazenamento para o DONO

```
DECISÃO: o dono passa a ter as funções de backup. Hoje estão só em /dev/dados (rotas /api/dev/backups, perfil
DEV). "Apagar dados" continua exclusivo do DEV.

SOLUÇÃO:
1. Rotas novas /api/backups com apenas.owner (bancoReal: true, como as do DEV), reaproveitando o MESMO service de
   modules/dados/backups.js: listar, criar agora, baixar, agendar restauração, cancelar restauração e apagar
   backup MANUAL (automático sai sozinho pela regra dos 14). As rotas /api/dev/backups continuam como estão.
2. Restaurar é perigoso: exija digitar RESTAURAR (como o APAGAR do DEV) e explique na tela que o sistema volta
   para aquele dia no próximo início e que o estado de agora vira um backup de segurança.
3. Cópia fora do computador: configuração "pasta de cópia externa" (um caminho: pendrive, pasta do OneDrive ou do
   Google Drive). Depois de cada backup, copie para lá o banco e as mídias novas do cofre (incremental, igual ao
   Prompt 1). Se a pasta não existir (pendrive fora), avise na tela e no painel sem falhar o backup. Botão
   "testar pasta".
4. Armazenamento: o uso do disco por categoria (banco, mídia por ano, backups, cofre, WhatsApp) e a data do último
   backup e da última cópia externa. Aviso em destaque se a última cópia externa tiver mais de 7 dias.
5. Tela: uma página nova do dono (ex.: Configurações > Backups, ou /backups no menu SISTEMA), no padrão visual das
   páginas já redesenhadas. Auditoria de cada ação (quem criou, baixou, restaurou).

TESTES: atendente e admin recebem 403 nas rotas novas; dono cria, lista e baixa; restaurar sem a palavra → 400;
cópia externa para pasta temporária copia só o que falta; pasta inexistente não quebra o backup.
Rode a suíte COMPLETA, faça o build da web e confira a página numa cópia isolada.
```

---

## Prompt 8 — Mídia antiga por ano cheio

```
DECISÃO ⚖️: mídia fica 1 ano por ANO CHEIO. A mídia criada em qualquer dia do ano A fica até 31/12 do ano A+1 e
sai em 01/01 do ano A+2. Exemplo: tudo de 2026 fica até 31/12/2027 e sai em 01/01/2028. Motivo: os relatórios são
por ano; cada ano precisa estar inteiro enquanto é consultado.

O QUE SAI: só o ARQUIVO (áudio, foto, vídeo, documento) das mensagens. Fica para sempre: a mensagem, a
transcrição do áudio, a legenda e o nome do arquivo. Fotos de cadastro (clientes, produtos, profissionais, logo)
NÃO entram nesta regra — são dados vivos, não conversa.

SOLUÇÃO:
1. Rotina anual (roda no primeiro início a partir de 01/01; se o sistema estava desligado na virada, roda no
   próximo início): pega as mensagens de mídia do ano A (A = ano atual − 2).
2. Antes de apagar, gera o PACOTE DO ANO: data/arquivo-morto/midia-A.zip com os arquivos e um indice.csv
   (data, cliente, telefone mascarado, conversa, tipo, nome do arquivo, transcrição) — o relatório do ano.
   O dono baixa pela página de backups (Prompt 7). O pacote fica 90 dias e então sai (avisos na página a partir de
   60 dias).
3. Em cada mensagem: metadados.arquivada = true e metadados.arquivadaEm; o arquivo sai de uploads (e do cofre de
   backups quando nenhum backup restante o citar).
4. Livechat: mensagem arquivada mostra "Áudio de <ano> arquivado" (com a transcrição) ou "Foto de <ano>
   arquivada" em vez do player quebrado.
5. Aviso antecipado: a partir de 01/12, a página de backups avisa quantos arquivos e quantos MB do ano A sairão na
   virada, com o botão para baixar o pacote antes.
6. Deixe o número de anos numa constante (ANOS_DE_MIDIA = 1) com comentário explicando a regra do ano cheio.

TESTES (datas simuladas, pasta temporária):
- em 31/12/2027, mídia de 2026 ainda existe;
- em 01/01/2028, mídia de 2026 vira pacote + arquivada, e a de 2027 fica;
- a transcrição continua na mensagem;
- rodar duas vezes não gera pacote duplicado nem erro;
- sistema desligado na virada: roda no próximo início.
Rode a suíte COMPLETA.
```

---

## Prompt 9 — Memória da Sofia: a ficha do cliente

```
PROBLEMA: a Sofia lê só as 8 últimas mensagens da conversa ATUAL (historicoParaIa). Quando o cliente volta semanas
depois (conversa nova), ela não sabe o serviço de sempre, o profissional preferido nem a última visita — embora o
sistema já gere o resumo final de cada atendimento (gerarResumoFinal) e tenha o histórico de serviços.

SOLUÇÃO — memória DESTILADA, não histórico cru (o prompt não pode voltar a crescer):
1. Ficha por cliente (ex.: leads.memoria JSON, migration só ADD): serviço mais pedido, profissional preferido,
   última visita (data e serviço), preferências ditas pelo cliente ("prefere de manhã", "alérgico a X") e
   observações curtas. Limite de ~100 tokens quando vira texto.
2. Atualizada AO FINALIZAR a conversa, junto do resumo final: os campos de agenda saem do banco (appointments /
   service_history, sem IA); as preferências saem de UMA chamada curta de IA sobre o resumo, que só acrescenta
   fato novo e nunca inventa (se não houver nada novo, não muda).
3. No prompt da Sofia, bloco curto "O QUE VOCÊ JÁ SABE DESTE CLIENTE" (só quando existe ficha), com a regra de
   usar com naturalidade e nunca expor como "consta no sistema". Os preços continuam só do catálogo (a trava de
   preço não muda).
4. Na ficha do contato (web), uma seção "O que a Sofia lembra", com botão para o atendente corrigir ou apagar cada
   item (e respeitando a privacidade da equipe).
5. LGPD: a exclusão do cliente apaga a ficha.

TESTES: cliente com 2 cortes com o Carlos → ficha diz corte e Carlos; a ficha entra no prompt da conversa
seguinte; cliente novo não tem bloco; apagar um item pela tela tira do prompt; o texto da ficha nunca passa do
limite.
Rode a suíte COMPLETA e me mostre o prompt de uma conversa de cliente que voltou.
```
