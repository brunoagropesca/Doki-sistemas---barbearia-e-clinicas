# Qual a dificuldade de adaptar o sistema para uma clínica de dentista?

Análise feita em cima do código atual (`main`), medindo o quanto o sistema está preso a "barbearia" e o que uma clínica odontológica precisaria que ainda não existe. Este documento é o diagnóstico; o roteiro de execução (fases, prompts) está em `ADAPTACAO-PARA-CLINICAS.md`, nesta mesma pasta.

---

**Resposta curta: dificuldade média.** A base do sistema (WhatsApp, Sofia/Atena, agenda, lembrete de véspera, fila, campanhas, painel) é genérica e funciona para uma clínica odontológica hoje, só configurando. O que falta são algumas coisas típicas de clínica que uma barbearia não precisa.

Chequei no código atual (`main`): quase todo "barbearia" que aparece está em comentário, texto de exemplo ou dado de demonstração, não na lógica. O cadastro da empresa já tem um campo de segmento que aceita "clínica", mas hoje ele não muda nenhum comportamento.

## 1. Só configuração, sem código (1–2 dias)
- **Catálogo** vira procedimentos (avaliação, limpeza, restauração, clareamento…), com duração e preço.
- **Profissionais** viram dentistas, cada um com jornada e os procedimentos que faz. A duração pode ser diferente por dentista, e isso já funciona.
- **Base de conhecimento:** endereço, convênios aceitos (em texto), formas de pagamento, regras da casa.
- **Prompt da Sofia:** o texto de fábrica fala em "clínica/barbearia premium" e dá para editar na tela.
- **Vocabulário da tela:** a página "Textos do sistema" (perfil DEV) já troca qualquer palavra da interface, por exemplo "Cliente" → "Paciente", sem mexer em código.
- **Lembrete de véspera e confirmação:** já existem. É o recurso que mais reduz falta em consultório.

## 2. Ajustes pequenos de código (alguns dias)
- **"Preço sob avaliação" / "a partir de":** hoje todo serviço exige preço fixo, e a Sofia é proibida de falar preço que não está no catálogo. Em odontologia boa parte dos procedimentos só tem preço depois da avaliação. Falta uma marcação no serviço e uma regra da Sofia ("isso é definido na avaliação; quer marcar?").
- **Urgência:** "estou com dor", "inchou", "quebrou o dente" precisam de prioridade: encaixe no dia ou alerta imediato à equipe. Hoje a Sofia trata como qualquer pedido.
- **Usar o segmento "clínica" para ajustar o padrão automaticamente:** vocabulário, textos de exemplo e prompt. Assim o mesmo sistema atende os dois ramos, sem criar uma cópia separada.
- **Esconder Produtos/Estoque:** consultório gasta material, não vende produto. Hoje essa tela não tem interruptor para desligar.

## 3. Funcionalidades novas (algumas semanas)
- **Dependentes:** a mãe marca para os três filhos pelo mesmo WhatsApp. Hoje cada telefone é **um** cadastro (é regra do banco), então os filhos não teriam ficha própria. É a mudança estrutural mais importante.
- **Plano de tratamento e retorno:** canal em 3 sessões, ortodontia mensal, limpeza a cada 6 meses. A agenda de hoje só conhece visitas avulsas (ou vários serviços na mesma visita). Falta:
  - sequência de consultas ligadas ao mesmo tratamento;
  - lembrete de retorno por procedimento. As campanhas cobrem parte disso.
- **Convênios:** cadastro do plano do paciente, procedimentos cobertos e preço por convênio. Hoje não existe nada disso.
- **Consultório/cadeira como recurso:** se dois dentistas dividem uma cadeira, a agenda precisa controlar a sala, não só o profissional.

## 4. Atenção: saúde e regras do CFO (decidir antes de construir)
- **Prontuário, anamnese e odontograma:** eu **não** recomendo construir. É documento legal da profissão, com guarda longa e exigências próprias. O melhor é integrar com um sistema odontológico que a clínica já use e manter este focado em atendimento e agenda.
- **LGPD:** informação de saúde é dado sensível. As conversas passam por provedores de IA (Gemini, Groq), alguns fora do Brasil. Isso pede base legal e consentimento claros, e cuidado com o que a Sofia guarda nos resumos.
- **Publicidade:** o conselho de odontologia tem regras sobre anunciar preço e promoção. O Aquiles (campanhas) precisaria de travas específicas.

Nos pontos 4, vale confirmar com um advogado ou com o CFO antes de vender para clínicas.

## Estimativa, em ordem de grandeza
| Entrega | Esforço |
|---|---|
| Uma clínica pequena usando amanhã (itens 1 e 2) | ~1 semana |
| Versão boa para vender a clínicas (+ dependentes, preço sob avaliação, urgência, retorno) | +2–3 semanas |
| Completa (+ convênios, planos de tratamento, salas) | +3–4 semanas |
