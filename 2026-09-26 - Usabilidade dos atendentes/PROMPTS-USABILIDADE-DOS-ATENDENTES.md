# Prompts — usabilidade dos atendentes (validados)

Data: 26/09/2026. Base: `main` em `f1034e8` ("Assinatura do atendente").

Cada correção foi **aplicada numa cópia isolada do sistema**, testada com o cenário que reproduzia o bug (duas atendentes ao mesmo tempo, dono acompanhando, cliente voltando a escrever etc.) e depois com a **suíte completa**. As 12 juntas: **920 de 920 testes passando** e o painel compilando (`vite build`). As telas foram conferidas no navegador (Playwright) com duas atendentes logadas.

O arquivo `prototipos-usabilidade-atendentes.diff`, nesta mesma pasta, tem o código exato que foi testado — serve de referência se algum prompt sair diferente.

## Como usar

- **Um prompt por vez, na ordem.** Os prompts 3, 7 e 8 mexem na mesma tela (`Conversas.jsx`); os 6, 7 e 9 no mesmo arquivo do servidor (`conversas.service.js`).
- **Espere terminar e confira antes do próximo.** Cada prompt termina pedindo a suíte completa.
- **Commits:** nenhum prompt faz commit; faça você, ou peça, depois de conferir.
- **Prompt 0:** cole uma vez no começo de cada sessão.
- **Duas decisões de produto estão marcadas com ⚖️** (prompts 4 e 10). O prompt vem com o valor que eu recomendo; troque se preferir.

## Resumo dos 12 problemas

| # | Problema | Gravidade |
|---|---|---|
| 1 | Atendente "distribui" conversa de outra pessoa e ainda vê o telefone do cliente | Alta (privacidade) |
| 2 | `/atena` funciona em conversa de outro atendente | Alta (privacidade) |
| 3 | Outra pessoa assume a conversa: o texto que eu escrevia some e aparece "Conversa nao encontrado." | Alta |
| 4 | Quem fecha o navegador sem clicar em "Sair" fica "online" para sempre e recebe clientes | Alta |
| 5 | O dono abre a conversa para acompanhar e zera as não lidas da atendente | Média |
| 6 | Transferência não avisa quem recebeu | Média |
| 7 | "Finalizar" sem confirmação, e a tela trava 6–10 s esperando a IA escrever o resumo | Média |
| 8 | "Reabrir" mostra "Ja existe um registro com esses dados." | Média |
| 9 | Aviso urgente fica preso na tela depois que a conversa foi finalizada | Média |
| 10 | Recepcionista não vê a agenda do dia (a privacidade das conversas esconde a agenda) | Média |
| 11 | Resposta rápida com `{nome}` sai "Bom dia, Contato!" | Baixa |
| 12 | Mensagens de erro sem acento e com gênero errado | Baixa |

---

## Prompt 0 — preparação

```
Leia o Plataforma/CONTINUAR-SESSAO.md inteiro antes de mexer em qualquer coisa. Responda em português.
Rode a suíte da API (cd Plataforma/api && npm test) e me diga quantos passam ANTES de mudar algo.
Regras desta sessão:
- mudança mínima, no padrão do projeto (comentários em português explicando o PORQUÊ);
- confira que cada edição aplicou (o repositório mistura CRLF e LF);
- teste novo usa dados próprios;
- teste que depende do expediente usa abrirACasa() (tests/helpers/ambiente.js), a menos que o teste seja
  SOBRE horário — a suíte roda a qualquer hora, e a barbearia de exemplo fecha à noite e de manhã cedo.
Ao terminar: suíte COMPLETA, resultado e explicação do que mudou. Não faça commit sem eu pedir.
```

---

## Prompt 1 — "Distribuir" sem checar quem pede (vaza o telefone do cliente)

```
BUG (reproduzido): a rota POST /api/conversas/:id/distribuir (conversas.routes.js) chama
service.distribuir(tenantId, id, { forcar: true }) sem olhar quem está pedindo. Com a privacidade ligada,
a atendente Camila chamou a rota com o id de uma conversa que é da Bia (que ela nem enxerga): a conversa
foi tirada da Bia e a resposta trouxe nome e telefone do cliente.

SOLUÇÃO (validada):
1. conversas.service.js — nova função exportada distribuirManual(tenantId, id, usuario):
   - linha = await garantirVisivel(tenantId, await repo.buscarPorId(tenantId, id), usuario)
     (fora do escopo → 404, como nas outras rotas);
   - se linha.conversa.assignedUserId existe e !(await veTudo(tenantId, usuario)) →
     throw new SemPermissao('Só a gerência redistribui uma conversa que já tem responsável.');
   - r = await distribuir(tenantId, id, { forcar: true });
   - devolve { atribuida, motivo, atendente: {id, nome} | null } e SÓ inclui
     conversa: await obter(tenantId, id, usuario) se ela continua visível para quem pediu
     (não foi para ninguém, foi para ele mesmo, ou ele vê tudo). Assim a resposta não carrega o
     telefone de um cliente que foi para outra pessoa.
2. conversas.routes.js: a rota passa a chamar service.distribuirManual(req.tenantId, req.params.id, req.usuario).
3. Não mexa em distribuir() — ela é usada pela IA e pelas rotinas, sem usuário.

TESTES: adicione em conversas (ou equipe) um teste com privacidade ligada:
- atendente distribui conversa de outra → 404 (não enxerga) ou 403 (enxerga, mas tem dono);
- atendente distribui conversa da FILA (sem dono) → 200 (caso normal continua funcionando);
- dono redistribui conversa com responsável → 200.
Rode a suíte COMPLETA.
```

**Verificado:** conversa da Bia pela Camila → 404, nada muda; da fila → 200; dono → 200.

---

## Prompt 2 — `/atena` em conversa de outro atendente

```
BUG (reproduzido): automacao/comando.js (executarComando) busca a conversa com
conversas.obter(tenantId, conversationId) SEM o usuário. Resultado: um atendente manda "/atena remarca
para sábado" numa conversa que é de outra pessoa (ou que ele nem vê) e a Atena executa.

SOLUÇÃO (validada), em automacao/comando.js:
- const conversa = await conversas.obter(tenantId, conversationId, usuario);
  (com o usuário, conversa fora do escopo vira 404, igual às outras rotas)
- if (!(await conversas.podeAgir(tenantId, conversa, usuario)))
    throw new SemPermissao('Esta conversa está com outro atendente.');
- importe SemPermissao de '../core/errors.js' (junto com os que já estão lá).
Confira que podeAgir está exportada em conversas.service.js (ela já é usada pelas rotas de responder).

TESTES: /atena na conversa de outra atendente → 403 (ou 404 com privacidade); na própria → 200.
Rode a suíte COMPLETA.
```

**Verificado:** conversa de outra → recusado; na própria → HTTP 200 e a Atena responde normalmente.

---

## Prompt 3 — O texto que eu escrevia some quando outra pessoa assume a conversa

```
BUG (reproduzido no navegador com duas atendentes): a Camila está digitando uma resposta; a Bia assume a
conversa. Na próxima atualização a tela da Camila troca tudo por um aviso vermelho
"Conversa nao encontrado." — e o texto que ela digitava é perdido. O mesmo acontece se a página recarrega.

SOLUÇÃO (validada), só no painel (Plataforma/web/src/telas/Conversas.jsx + Conversas.css):
1. Rascunho por conversa guardado no navegador:
   - acima de function Fio: chaveRascunho = (id) => `rascunho:${id}`; lerRascunho(id) e
     gravarRascunho(id, texto) usando localStorage DENTRO de try/catch (em aba anônima pode falhar;
     aí o rascunho vale só enquanto a tela estiver aberta). Texto vazio → removeItem.
   - no Fio: const [texto, setTextoBruto] = useState(() => lerRascunho(conversationId));
     e um setTexto que aceita valor ou função, grava o rascunho e chama setTextoBruto.
     Assim todo o código que já chama setTexto continua igual, e o setTexto('') depois de enviar a
     mensagem já limpa o rascunho.
2. Quando dados.isError e dados.error.status === 404: em vez do aviso vermelho, mostrar
   <div className="fio fio--indisponivel"> com:
   - Aviso tom "info": "Esta conversa não está mais com você — outra pessoa assumiu ou ela foi transferida."
   - se houver texto: "O que você tinha escrito:" + <blockquote> com o texto + botão
     "Copiar texto" (navigator.clipboard?.writeText(texto));
   - botão "Voltar para a lista" (aoVoltar).
   Outros erros continuam no aviso vermelho com a mensagem do servidor.
3. CSS: .fio--indisponivel (coluna, gap var(--e3), padding var(--e4)) e
   .fio__rascunho-perdido blockquote (borda esquerda var(--primaria), fundo var(--superficie),
   white-space: pre-wrap).

Confira em web: npx vite build. Rode também a suíte da API (não deve mudar nada).
```

**Verificado no navegador:** a tela da Camila mostrou a explicação, o texto "Oi Helena! O degradê custa R$ 55 e tenho horário amanhã às", "Copiar texto" e "Voltar para a lista".

---

## Prompt 4 — Quem fecha o navegador continua "online" para sempre ⚖️

```
BUG (reproduzido): só o botão "Sair" põe a pessoa offline. Quem fecha o navegador às 18h continua
"online" e a distribuição entrega a ela o cliente que pede uma pessoa às 8h da manhã seguinte — o cliente
fica esperando alguém que não está lá.

SOLUÇÃO (validada): presença = painel aberto. O painel já mantém a conexão de tempo real /api/eventos.
1. Novo arquivo api/src/modules/equipe/presenca.js:
   - export const AUSENTE_APOS_MS = 5 * 60_000;
   - contador de conexões por usuário (Map), timers por usuário (Map) e um Set tiradosPeloSistema;
   - painelAberto(tenantId, userId): soma 1 conexão, cancela o timer; se o usuário está em
     tiradosPeloSistema, remove e volta ele de 'ausente' para 'online';
   - painelFechado(tenantId, userId, { aposMs = AUSENTE_APOS_MS } = {}): tira 1 conexão; se ainda há
     outras abas, para aí. Na última, agenda um timer (com unref) que, se ninguém reabriu, muda
     'online' → 'ausente' e põe o usuário em tiradosPeloSistema;
   - marcarAusentesSemPainel(): quem está 'online' no banco e sem conexão vira 'ausente' (para quando o
     servidor reinicia);
   - a troca de status é CONDICIONAL: UPDATE ... WHERE id = ? AND statusPresenca = <de>. Assim, quem
     escolheu "ausente" ou "pausa" na mão nunca é mexido — e não volta sozinho para online.
     Quando muda, loga e emite EVENTOS.CONVERSA para o painel atualizar;
   - _zerarPresenca() para os testes.
2. automacao/automacao.routes.js, na rota SSE /api/eventos: depois de conexoes.add(raw) chamar
   painelAberto(req.tenantId, req.usuario.id). A função limpar() ganha uma trava (let limpo = false;
   if (limpo) return; limpo = true;) porque ela é chamada por mais de um evento de fechamento, e chama
   painelFechado(req.tenantId, req.usuario.id).
3. main.js: logo depois de "const pararRotinas = iniciarRotinas({ enviar: enviarMensagem });"
   setTimeout(() => marcarAusentesSemPainel().catch(() => {}), AUSENTE_APOS_MS).unref?.();
   ATENÇÃO: procure essa linha exata; não invente outra âncora.

TESTES novos (use aposMs pequeno, ex. 200 ms, e chame _zerarPresenca() no início):
- 2 abas abertas, fecha 1 → continua online; fecha a última → ausente depois do prazo;
- reabre → online;
- escolheu 'ausente' na mão, fecha e reabre → continua ausente.
Rode a suíte COMPLETA.
```

**Verificado:** fechou 1 de 2 abas → online; fechou a última → ausente; cliente pediu pessoa → foi para a fila (não para quem saiu); reabriu → online; "ausente" escolhido na mão foi respeitado.

⚖️ **Decisão:** 5 minutos sem painel aberto. Menos que isso, uma queda de internet rápida tira a pessoa da distribuição; mais que isso, o cliente pode cair com quem já foi embora.

---

## Prompt 5 — O dono abre a conversa e zera as não lidas da atendente

```
BUG (reproduzido): marcarLida (conversas.service.js) zera naoLidas para qualquer um que abra a conversa.
O dono abre para acompanhar, o contador da atendente vai a zero e ela nunca fica sabendo que o cliente
escreveu.

SOLUÇÃO (validada), em marcarLida:
- const linha = await garantirVisivel(...);
- const dono = linha.conversa.assignedUserId;
- if (dono && dono !== usuario?.id) return { ok: true, acompanhando: true };
- senão zera como hoje.
Conversa sem responsável (fila, IA) continua sendo zerada por quem abrir.

TESTES: cliente manda 2 mensagens para a conversa da atendente; o dono chama /lida → continua 2; a
própria atendente chama /lida → 0. Rode a suíte COMPLETA.
```

**Verificado:** dono abriu → continuou 2 não lidas; a atendente abriu → 0.

---

## Prompt 6 — Transferência não avisa quem recebe

```
BUG (reproduzido): transferir (conversas.service.js) muda o responsável mas não cria nenhuma notificação.
A conversa aparece em silêncio na lista de quem recebeu. E os avisos antigos dessa conversa (para quem
estava antes) continuam na tela.

SOLUÇÃO (validada):
- no import de '../notificacoes/notificacoes.repo.js' acrescente criar as criarNotificacoes (ao lado do
  fecharDaConversa as fecharNotificacoes que já existe);
- em transferir, antes do "return obter(tenantId, id)" final:
    await fecharNotificacoes(tenantId, id);
    await criarNotificacoes(tenantId, {
      userIds: [destino.id],
      conversationId: id,
      leadNome: linha.leadNome,
      motivo: `Transferida por ${usuario.nome ?? 'um colega'}${motivo ? `: ${motivo}` : ''}`,
      urgente: false
    });
  Confira os nomes das variáveis que a função já usa (destino, linha, motivo) e ajuste se forem outros.

TESTES: transfere com motivo → quem recebe tem 1 notificação aberta com "Transferida por <nome>: <motivo>";
quem transferiu não tem aviso aberto da conversa. Rode a suíte COMPLETA.
```

**Verificado:** quem recebeu ganhou 1 aviso com o nome de quem passou e o motivo.

---

## Prompt 7 — "Finalizar" sem confirmação e a tela travada esperando a IA

```
BUG (reproduzido): o botão "Finalizar" encerra com um clique (sem confirmação, e fica ao lado de outros
botões) e o servidor ESPERA a IA escrever o resumo antes de responder: 6 a 10 s de tela parada.

SOLUÇÃO (validada) — servidor, conversas.service.js, função finalizar:
1. Troque o bloco "if (!resumoFinal && (await atenaPermite(tenantId, 'resumo'))) { ... }" (que gera o
   resumo esperando a IA) por:
     const resumoPelaIa = !resumoFinal && (await atenaPermite(tenantId, 'resumo'));
   e remova a variável resumoDaIa (troque por resumoPelaIa no log.info 'Conversa finalizada').
2. Depois de gravar a conversa como finalizada (e das OS), se resumoPelaIa:
     agendarResumo(tenantId, id, linha.leadNome, opcoes.provedores ?? null);
   (sem await — roda em segundo plano).
3. Nova função (não exportada) agendarResumo, que:
   - busca as últimas 40 mensagens, chama gerarResumoFinal como o bloco antigo fazia;
   - relê a conversa: se nesse meio tempo alguém gravou um resumo, NÃO sobrescreve;
   - grava conversa.resumo e chama agenda.anexarResumoNasOs(tenantId, id, texto);
   - nunca lança (try/catch com log.warn): falhar só significa ficar sem resumo, como antes.
   Guarde a promessa num Set resumosEmAndamento e exporte
     export function aguardarResumos() { return Promise.all([...resumosEmAndamento]); }
4. agenda.service.js: nova export anexarResumoNasOs(tenantId, conversationId, texto) — para cada OS de
   repo.vinculadasAConversa que ainda não tem resumoAtendimento, grava { resumoAtendimento: texto,
   resumoEm: new Date() }.

Painel, Conversas.jsx:
5. importe Modal de '../componentes/ui.jsx'. O botão "Finalizar" abre um Modal "Finalizar atendimento"
   (estados confirmandoFim e resumoFim) com o texto "O atendimento sai da sua lista. Se o cliente escrever
   de novo, uma conversa nova começa.", um textarea opcional "Resumo (opcional)" (placeholder: "Em branco,
   a Atena escreve o resumo em segundo plano.") e os botões Cancelar / Finalizar. Finalizar chama
   acao.mutate({ rota: 'finalizar', corpo: resumo ? { resumo } : {} }) e fecha o modal no onSuccess.

ARMADILHA: o teste "a Atena escreve o resumo quando ninguem escreveu" (tests/automacao.test.js, bloco
'resumo automatico ao finalizar') vai falhar, porque o resumo agora chega DEPOIS da resposta. Corrija o
helper do bloco: logo depois de "await conv.finalizar(...)" acrescente "await conv.aguardarResumos();".
Não mude o que o teste confere.

TESTES: finalizar sem resumo responde rápido e o resumo aparece depois (aguardarResumos); com resumo
digitado, a IA não sobrescreve. Rode a suíte COMPLETA e o npx vite build do painel.
```

**Verificado:** com a IA levando 3 s, o clique respondeu em **0,0 s** e o resumo apareceu em seguida; resumo digitado não foi sobrescrito. No navegador, o clique abriu a confirmação e finalizou com o resumo digitado.

---

## Prompt 8 — "Reabrir" mostra "Ja existe um registro com esses dados."

```
BUG (reproduzido): a conversa foi finalizada, o cliente voltou a escrever (abriu uma conversa NOVA no
mesmo número) e a atendente clica "Reabrir" na antiga. O banco recusa (índice de "uma conversa aberta
por cliente") e aparece "Ja existe um registro com esses dados." — ela não entende o que houve.

SOLUÇÃO (validada):
1. conversas.service.js, em reabrir, depois da checagem "Esta conversa nao esta finalizada.":
     const atual = await repo.buscarAbertaDoLead(tenantId, linha.conversa.leadId, linha.conversa.channelInstanceId);
     if (atual) throw new Conflito('Este cliente já voltou a escrever e tem uma conversa aberta. Continue por ela.',
       { conversaAtualId: atual.id });
   (Conflito já aceita detalhes como 2º argumento; confira que está importado. Confira também o nome da
   função do repo que busca a conversa aberta do cliente — use a que o gateway já usa.)
2. Conversas.jsx: no aviso de erro de acao, se acao.error.detalhes?.conversaAtualId existir, mostrar ao
   lado da mensagem um botão "Abrir a conversa atual" que navega para /conversas?id=<conversaAtualId>
   (useNavigate do react-router-dom).

TESTES: finaliza, o mesmo cliente escreve de novo, reabrir a antiga → 409 com a mensagem nova e
detalhes.conversaAtualId = id da nova. Rode a suíte COMPLETA e o npx vite build.
```

**Verificado:** 409 com a mensagem clara e o id certo; no navegador o botão "Abrir a conversa atual" levou para a conversa nova.

---

## Prompt 9 — Aviso urgente preso na tela depois que a conversa acabou

```
BUG (reproduzido): cliente frustrado gera um aviso urgente. A conversa é finalizada (ou devolvida para a
IA) e o aviso continua na tela; "Atender" dá erro 422 e só então some.

SOLUÇÃO (validada), conversas.service.js (o import fecharDaConversa as fecharNotificacoes já existe):
- em finalizar, antes do log.info 'Conversa finalizada': await fecharNotificacoes(tenantId, id);
- em devolverParaIa, depois do repo.atualizar e antes do return: await fecharNotificacoes(tenantId, id);
(A transferência já foi tratada no prompt 6.)

TESTES: conversa com notificação urgente aberta → finalizar → nenhuma notificação aberta dessa conversa.
Idem para devolver para a IA. Rode a suíte COMPLETA.
```

**Verificado:** depois de finalizar, 0 avisos abertos da conversa.

---

## Prompt 10 — A recepcionista não vê a agenda do dia ⚖️

```
BUG (reproduzido): com a privacidade das conversas ligada, a agenda usa o mesmo recorte (escopoDe). A
recepcionista, que organiza os horários, viu 0 de 3 agendamentos do dia.

SOLUÇÃO (validada) — uma opção nova, DESLIGADA por padrão (nada muda para quem já usa):
1. equipe.config.js:
   - no objeto de padrões: agendaCompletaParaEquipe: false
   - no mapa de chaves: agendaCompletaParaEquipe: 'agenda_completa_equipe'
   - nova export escopoDaAgenda(tenantId, usuario): se a opção está ligada → { tudo: true };
     senão → escopoDe(tenantId, usuario).
2. equipe.routes.js: no configuracaoSchema, agendaCompletaParaEquipe: z.boolean().optional()
3. agenda.service.js: importe escopoDaAgenda e use em listar (repo.listar) e em garantirVisivel.
   NÃO troque nas métricas/faturamento: o dinheiro continua no recorte de cada um.
4. Equipe.jsx: um Cartao "Agenda" (antes do bloco da assinatura) com checkbox
   "Toda a equipe vê a agenda completa" e a explicação "Para quem organiza a recepção. As conversas
   continuam com a regra acima, e o faturamento continua visível só para quem já via."
   onChange → salvar.mutate({ agendaCompletaParaEquipe: e.target.checked }); disabled se !podeEditar.

TESTES: 3 horários de outro profissional; atendente vê 0 com a opção desligada e 3 com ela ligada; o
faturamento da atendente não muda. Rode a suíte COMPLETA e o npx vite build.
```

**Verificado:** desligada → 0 de 3; ligada → 3 de 3; faturamento continuou no recorte dela; o interruptor aparece na tela de Equipe.

⚖️ **Decisão:** deixei **desligado por padrão** para não mudar o que ninguém vê sem o dono decidir. Se toda barbearia sua tem recepção, pode inverter o padrão.

---

## Prompt 11 — `{nome}` vira "Bom dia, Contato!"

```
BUG (reproduzido): cliente sem nome salvo aparece como "Contato WhatsApp". A resposta rápida
"Bom dia, {nome}!" sai "Bom dia, Contato!".

SOLUÇÃO (validada), web/src/telas/conversas/Compositor.jsx:
- primeiroNome(nome): se vazio ou se começa com contato/cliente/lead (regex /^(contato|cliente|lead)\b/i)
  → ''; senão o primeiro nome como hoje.
- a troca de {nome} passa a ser .replace(/,?\s*\{nome\}/gi, (trecho) => nome ? trecho.replace(/\{nome\}/i, nome) : '')
  — sem nome de verdade some o {nome} E a vírgula antes dele: "Bom dia!".
  (Substitui o fallback atual 'tudo bem'.)

Confira: "Bom dia, {nome}!" com "Contato WhatsApp" → "Bom dia!"; com "Helena Castro" → "Bom dia, Helena!".
npx vite build.
```

**Verificado:** os dois casos acima deram o resultado esperado.

---

## Prompt 12 — Mensagens de erro sem acento e com gênero errado

```
BUG (reproduzido): a atendente lê "Conversa nao encontrado." e "Ja existe um registro com esses dados.".

SOLUÇÃO (validada):
1. core/errors.js, classe NaoEncontrado:
   - o gênero vem da PRIMEIRA palavra do recurso (assim "Mensagem da campanha" sai no feminino). Set
     FEMININOS = Conversa, Mensagem, Notificacao, Campanha, Conexao, Sessao, Resposta, Etiqueta, Empresa,
     Licenca, Ordem, Categoria, Venda, Funcao. Compare sem acento (normalize('NFD') + tirar os acentos),
     porque há chamadas com "Resposta rápida" já acentuado;
   - acentua o nome: Notificação, Conexão, Sessão, Licença, Função, Usuário, Serviço/serviço, rápida;
   - mensagem: `${nome} não encontrad${feminino ? 'a' : 'o'}.`
2. empresa/empresa.service.js passa a mensagem inteira: new NaoEncontrado('Empresa nao encontrada.'),
   que viraria "Empresa nao encontrada. não encontrado.". Troque por new NaoEncontrado('Empresa').
3. http/plugins/erros.js: 'Já existe um registro com esses dados.'
Antes de fechar, faça grep por "new NaoEncontrado(" e imprima a mensagem de CADA recurso usado
(um script de 5 linhas basta) para conferir gênero e acento.

ARMADILHA: procure nos testes (grep -rn "nao encontrad\|Ja existe" tests/) algum que confira o texto
antigo e atualize só o texto esperado. Na validação nenhum conferia, mas confira.
Rode a suíte COMPLETA.
```

**Verificado:** conferi os 21 recursos usados no sistema, um por um — "Conversa não encontrada.", "Mensagem da campanha não encontrada.", "Resposta rápida não encontrada.", "Serviço não encontrado.", "Empresa não encontrada." etc. — e "Já existe um registro com esses dados.".

---

## Validado em conjunto

- **API:** 920 de 920 testes passando com as 12 correções juntas (a única mudança em teste é a linha `await conv.aguardarResumos();` do prompt 7).
- **Painel:** `npx vite build` sem erro.
- **Navegador (duas atendentes ao mesmo tempo):** prompts 3, 7, 8 e 10 conferidos na tela.
- **Casos normais continuam iguais:** distribuir conversa da fila, `/atena` na própria conversa, a própria atendente abrindo e zerando as não lidas, login deixando online.

## O que ficou de fora de propósito

- **Tempo de presença configurável na tela** (prompt 4): hoje é uma constante. Dá para virar opção da Equipe depois, se 5 minutos não servir para alguma unidade.
- **Aviso na tela quando alguém assume a conversa que estou vendo** (prompt 3): o rascunho já não se perde; o aviso em tempo real seria um passo a mais (evento SSE específico), não um conserto.
