import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarAppDeTeste } from './helpers/ambiente.js';
import { conversar, dividirEmBaloes } from '../src/ai/agente.js';
import { gerar } from '../src/ai/cascade.js';
import { definirFerramenta, executarFerramenta, zodParaJsonSchema } from '../src/ai/tools/registry.js';
import { ErroDeProvedor, erroEDoModelo, pareceIncompleta } from '../src/ai/providers/base.js';
import { groq } from '../src/ai/providers/openai-compat.js';

/**
 * Testes do motor de IA.
 *
 * Nenhum deles chama uma API de verdade. Provedores sao substituidos por
 * dublês que respondem o que o teste mandar — inclusive falhando de propósito.
 *
 * Sem isso, testar a cascata exigiria uma chave paga, conexao com a internet
 * e uma forma de fazer o Google devolver erro 429 sob demanda. Era por isso
 * que a cascata do sistema antigo nunca teve teste nenhum.
 */

let app;
let tenantId;

/** Provedor de mentira: responde, ou falha, conforme o roteiro. */
function provedorFalso(nome, roteiro) {
  let chamada = 0;
  const impl = {
    nome,
    async gerar({ modelo }) {
      const passo = roteiro[Math.min(chamada++, roteiro.length - 1)];
      if (passo.erro) {
        throw new ErroDeProvedor(passo.erro, {
          provedor: nome,
          modelo,
          reTentavel: passo.reTentavel ?? true,
          status: passo.status,
          doModelo: passo.doModelo ?? false
        });
      }
      return {
        texto: passo.texto ?? '',
        chamadasDeFerramenta: passo.ferramentas ?? [],
        motivoParada: passo.motivoParada ?? 'normal',
        tokens: { entrada: 10, saida: 20 },
        // Ecoa o modelo que a cascata pediu, como um provedor real faz.
        modelo
      };
    },
    get chamadas() {
      return chamada;
    }
  };
  return { impl, apiKey: 'falsa', modelos: [`${nome}-modelo`] };
}

before(async () => {
  const criado = await criarAppDeTeste();
  app = criado.app;
  tenantId = criado.tenant.id ?? criado.tenant;

  const { db } = await import('../src/db/client.js');
  const { tenants } = await import('../src/db/schema/index.js');
  const [t] = await db.select().from(tenants);
  tenantId = t.id;
});

after(async () => {
  await app?.close();
});

describe('cascata de provedores', () => {
  it('usa o primeiro provedor quando ele responde', async () => {
    const primario = provedorFalso('gemini', [{ texto: 'Ola! Como posso ajudar?' }]);
    const reserva = provedorFalso('groq', [{ texto: 'nao deveria ser usado' }]);

    const r = await gerar({
      tenantId,
      mensagens: [{ papel: 'user', conteudo: 'oi' }],
      provedores: [primario, reserva]
    });

    assert.equal(r.texto, 'Ola! Como posso ajudar?');
    assert.equal(r.provedor, 'gemini');
    assert.equal(reserva.impl.chamadas, 0, 'o reserva nao pode ser acionado a toa');
  });

  it('cai para o reserva quando o primario estoura a cota', async () => {
    const primario = provedorFalso('gemini', [{ erro: 'HTTP 429: cota excedida', status: 429, reTentavel: true }]);
    const reserva = provedorFalso('groq', [{ texto: 'Resposta do reserva' }]);

    const r = await gerar({
      tenantId,
      mensagens: [{ papel: 'user', conteudo: 'oi' }],
      provedores: [primario, reserva]
    });

    assert.equal(r.texto, 'Resposta do reserva');
    assert.equal(r.provedor, 'groq');
    assert.equal(r.tentativas.length, 1, 'a tentativa que falhou precisa ficar registrada');
  });

  /**
   * Chave invalida vai falhar igual em todos os modelos daquele provedor.
   * Insistir so gasta tempo com o cliente esperando.
   */
  it('desiste do provedor inteiro quando o erro e estrutural', async () => {
    const primario = {
      ...provedorFalso('gemini', [{ erro: 'HTTP 401: chave invalida', status: 401, reTentavel: false }]),
      modelos: ['modelo-a', 'modelo-b', 'modelo-c']
    };
    const reserva = provedorFalso('groq', [{ texto: 'ok' }]);

    const r = await gerar({
      tenantId,
      mensagens: [{ papel: 'user', conteudo: 'oi' }],
      provedores: [primario, reserva]
    });

    assert.equal(r.provedor, 'groq');
    assert.equal(r.tentativas.length, 1, 'nao pode tentar os 3 modelos com uma chave invalida');
  });

  it('modelo aposentado (404) nao derruba o provedor: tenta o proximo modelo', async () => {
    const primario = {
      ...provedorFalso('groq', [
        { erro: 'HTTP 404: model_not_found', status: 404, reTentavel: false, doModelo: true },
        { texto: 'Respondeu no modelo vivo' }
      ]),
      modelos: ['aposentado', 'vivo']
    };

    const r = await gerar({ tenantId, mensagens: [{ papel: 'user', conteudo: 'oi' }], provedores: [primario] });

    assert.equal(r.texto, 'Respondeu no modelo vivo');
    assert.equal(r.modelo, 'vivo');
  });

  it('reconhece erro que e so do modelo', () => {
    assert.equal(erroEDoModelo(404, ''), true);
    assert.equal(erroEDoModelo(400, '{"code":"model_decommissioned","message":"decommissioned"}'), true);
    assert.equal(erroEDoModelo(401, 'invalid api key'), false);
    assert.equal(erroEDoModelo(429, 'rate limit'), false);
  });

  it('Groq lista so modelos de conversa', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: ['openai/gpt-oss-120b', 'whisper-large-v3', 'canopylabs/orpheus-v1-english', 'meta-llama/llama-guard-4', 'qwen/qwen3.8-27b'].map((id) => ({ id, active: true }))
        }),
        { status: 200 }
      );
    try {
      const lista = await groq.listarModelos({ apiKey: 'k' });
      assert.deepEqual(lista.map((m) => m.nome), ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
    } finally {
      globalThis.fetch = original;
    }
    globalThis.fetch = async () => new Response('x', { status: 401 });
    try {
      assert.equal(await groq.listarModelos({ apiKey: 'k' }), null, 'falha ao consultar = null, nao lista vazia');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('tenta o proximo modelo do mesmo provedor quando a falha e passageira', async () => {
    const primario = {
      ...provedorFalso('gemini', [
        { erro: 'HTTP 503: indisponivel', status: 503 },
        { texto: 'Respondeu no segundo modelo' }
      ]),
      modelos: ['modelo-a', 'modelo-b']
    };

    const r = await gerar({
      tenantId,
      mensagens: [{ papel: 'user', conteudo: 'oi' }],
      provedores: [primario]
    });

    assert.equal(r.texto, 'Respondeu no segundo modelo');
    assert.equal(r.modelo, 'modelo-b');
  });

  /**
   * O sistema antigo, quando tudo falhava, mandava ao cliente um texto fixo
   * de saudacao — que podia cair no meio de uma negociacao de horario.
   */
  it('levanta erro quando tudo falha, em vez de fingir que respondeu', async () => {
    const a = provedorFalso('gemini', [{ erro: 'fora do ar' }]);
    const b = provedorFalso('groq', [{ erro: 'fora do ar' }]);

    await assert.rejects(
      () => gerar({ tenantId, mensagens: [{ papel: 'user', conteudo: 'oi' }], provedores: [a, b] }),
      (err) => {
        assert.equal(err.code, 'SERVICO_INDISPONIVEL');
        assert.ok(!/assistente virtual/i.test(err.message), 'nao pode devolver saudacao generica');
        return true;
      }
    );
  });

  /**
   * Bug real: numa conversa com uma cliente, a Sofia respondeu "C" a um
   * "Somente obrigado" e "Sem" ao "Somente" seguinte.
   *
   * O modelo (qwen3 no Groq) emitiu um fim-de-texto espurio depois de dois
   * tokens e o provedor relatou parada NORMAL — nao havia bandeira nenhuma
   * para conferir. A cascata achou que tinha dado certo e o pedaco foi
   * entregue no WhatsApp da cliente.
   */
  it('recusa o pedaco de frase e tenta de novo, em vez de entregar "C" ao cliente', async () => {
    const provedor = provedorFalso('groq', [{ texto: 'C' }, { texto: 'De nada, Débora! Até breve. 😊' }]);

    const r = await gerar({
      tenantId,
      mensagens: [{ papel: 'user', conteudo: 'Somente obrigado' }],
      provedores: [provedor],
      exigirRespostaCompleta: true
    });

    assert.equal(r.texto, 'De nada, Débora! Até breve. 😊');
    assert.equal(r.modelo, 'groq-modelo', 'a segunda chance e do MESMO modelo, o que a empresa escolheu');
    assert.equal(r.tentativas.length, 1, 'o pedaco descartado precisa ficar registrado');
  });

  it('insistindo o pedaco, desce para o proximo modelo', async () => {
    const provedor = {
      ...provedorFalso('groq', [
        { texto: 'C' },
        { texto: 'Sem' },
        { texto: 'Claro, tudo certo por aqui! 👍' }
      ]),
      modelos: ['qwen', 'reserva']
    };

    const r = await gerar({
      tenantId,
      mensagens: [{ papel: 'user', conteudo: 'oi' }],
      provedores: [provedor],
      exigirRespostaCompleta: true
    });

    assert.equal(r.texto, 'Claro, tudo certo por aqui! 👍');
    assert.equal(r.modelo, 'reserva');
  });

  /** Texto cortado no teto de tokens vale como falha em qualquer tamanho. */
  it('recusa a resposta cortada no limite de tokens', async () => {
    const provedor = provedorFalso('groq', [
      { texto: 'Seu horario esta confirmado para amanha as', motivoParada: 'limite' },
      { texto: 'Seu horário está confirmado para amanhã às 10:00. ✅' }
    ]);

    const r = await gerar({
      tenantId,
      mensagens: [{ papel: 'user', conteudo: 'confirma?' }],
      provedores: [provedor],
      exigirRespostaCompleta: true
    });

    assert.equal(r.texto, 'Seu horário está confirmado para amanhã às 10:00. ✅');
  });

  /**
   * Varias chamadas internas pedem UMA palavra de proposito: classificar a
   * resposta de uma campanha ("RECUSA") ou testar se o modelo responde
   * ("funcionando"). Ligar a recusa para todo mundo quebraria as duas.
   */
  it('sem exigirRespostaCompleta, a resposta de uma palavra continua valendo', async () => {
    const provedor = provedorFalso('groq', [{ texto: 'RECUSA' }]);

    const r = await gerar({
      tenantId,
      mensagens: [{ papel: 'user', conteudo: 'classifique' }],
      provedores: [provedor]
    });

    assert.equal(r.texto, 'RECUSA');
    assert.equal(provedor.impl.chamadas, 1, 'nao pode gastar uma chamada extra a toa');
  });

  /** Ferramenta pedida costuma vir com texto vazio ou curto — e isso e normal. */
  it('nao confunde chamada de ferramenta com resposta truncada', async () => {
    const provedor = provedorFalso('groq', [
      { texto: '', ferramentas: [{ nome: 'consultar_atena', argumentos: {} }] }
    ]);

    const r = await gerar({
      tenantId,
      mensagens: [{ papel: 'user', conteudo: 'tem horario amanha?' }],
      provedores: [provedor],
      exigirRespostaCompleta: true
    });

    assert.equal(r.chamadasDeFerramenta.length, 1);
    assert.equal(provedor.impl.chamadas, 1);
  });

  it('avisa quando nao ha provedor configurado', async () => {
    await assert.rejects(
      () => gerar({ tenantId, mensagens: [{ papel: 'user', conteudo: 'oi' }], provedores: [] }),
      /Nenhum provedor de IA configurado/
    );
  });

  it('registra cada chamada para dar visibilidade de custo', async () => {
    const { db } = await import('../src/db/client.js');
    const { aiCalls } = await import('../src/db/schema/index.js');

    const antes = (await db.select().from(aiCalls)).length;

    await gerar({
      tenantId,
      origem: 'teste',
      mensagens: [{ papel: 'user', conteudo: 'oi' }],
      provedores: [provedorFalso('gemini', [{ texto: 'ok' }])]
    });

    const depois = await db.select().from(aiCalls);
    assert.equal(depois.length, antes + 1);

    const registro = depois.at(-1);
    assert.equal(registro.sucesso, true);
    assert.equal(registro.origem, 'teste');
    assert.equal(registro.tokensEntrada, 10);
    assert.equal(registro.tokensSaida, 20);
  });
});

/**
 * A regra que separa "resposta curta" de "pedaco de resposta".
 *
 * Os exemplos que PASSAM sao mensagens reais que a Sofia mandou e estavam
 * certas; os que falham sao os pedacos reais que chegaram a clientes. Uma
 * regra que reprovasse "Oi, Débora! 😊" custaria uma chamada extra em toda
 * saudacao.
 */
describe('resposta cortada no meio', () => {
  it('deixa passar a resposta curta que fecha a frase', () => {
    for (const texto of [
      'Oi, Débora! 😊',
      'Oi Doki, tudo bem? 😊',
      'Combinado, Débora! ✂️',
      'Claro, Débora! 📍',
      'Estamos te esperando! 💈',
      'Oi, Lyu! 😊 Tudo bem?',
      'Tudo certo!',
      'De nada, Débora! Fico à disposição e até a próxima.'
    ]) {
      assert.equal(pareceIncompleta(texto, 'normal'), false, texto);
    }
  });

  it('pega o pedaco que parou no meio', () => {
    for (const texto of ['C', 'Sem', 'Claro, Déb', 'Perfeito, vou ver', 'Claro,']) {
      assert.equal(pareceIncompleta(texto, 'normal'), true, texto);
    }
  });

  it('texto cortado no teto de tokens vale em qualquer tamanho', () => {
    const longo = 'Seu horário está confirmado para amanhã às dez da manhã com o Carlos e';
    assert.equal(pareceIncompleta(longo, 'normal'), false);
    assert.equal(pareceIncompleta(longo, 'limite'), true);
  });

  /** Vazio ja e tratado por `exigirConteudo`, antes de chegar aqui. */
  it('nao opina sobre texto vazio', () => {
    assert.equal(pareceIncompleta('', 'normal'), false);
    assert.equal(pareceIncompleta(null, 'normal'), false);
  });
});

describe('ferramentas', () => {
  const ferramentaTeste = definirFerramenta({
    nome: 'somar',
    descricao: 'Soma dois numeros.',
    argumentos: z.object({
      a: z.number().describe('primeiro'),
      b: z.number().describe('segundo'),
      rotulo: z.string().optional()
    }),
    async executar({ a, b }) {
      return { resultado: a + b };
    }
  });

  it('converte o schema Zod para o formato dos provedores', () => {
    const js = zodParaJsonSchema(ferramentaTeste.argumentos);

    assert.equal(js.type, 'object');
    assert.equal(js.properties.a.type, 'number');
    assert.equal(js.properties.rotulo.type, 'string');
    assert.deepEqual(js.required.sort(), ['a', 'b'], 'o campo opcional nao pode ser obrigatorio');
  });

  it('executa com argumentos validos', async () => {
    const r = await executarFerramenta([ferramentaTeste], { nome: 'somar', argumentos: { a: 2, b: 3 } }, {});
    assert.deepEqual(r, { resultado: 5 });
  });

  /**
   * Os argumentos vem de um modelo de linguagem. Tratamos como entrada de
   * usuario: validamos antes de executar.
   */
  it('recusa argumentos invalidos sem quebrar', async () => {
    const r = await executarFerramenta([ferramentaTeste], { nome: 'somar', argumentos: { a: 'dois', b: 3 } }, {});
    assert.ok(r.erro);
    assert.match(r.erro, /Argumentos invalidos/);
  });

  it('nao quebra quando o modelo inventa uma ferramenta', async () => {
    const r = await executarFerramenta([ferramentaTeste], { nome: 'ferramenta_inventada', argumentos: {} }, {});
    assert.match(r.erro, /nao existe/);
  });

  /**
   * Uma ferramenta que estoura nao pode derrubar o atendimento inteiro, e a
   * mensagem tecnica nao pode vazar para o cliente.
   */
  it('transforma excecao da ferramenta em resultado de erro', async () => {
    const quebrada = definirFerramenta({
      nome: 'quebrada',
      descricao: 'Sempre falha.',
      argumentos: z.object({}),
      async executar() {
        throw new Error('SQLITE_ERROR: no such column: preco_secreto');
      }
    });

    const r = await executarFerramenta([quebrada], { nome: 'quebrada', argumentos: {} }, {});

    assert.ok(r.erro);
    assert.ok(!r.erro.includes('SQLITE'), 'detalhe tecnico nao pode chegar ao cliente');
  });
});

describe('laco de conversa com ferramentas', () => {
  const ferramentas = [
    definirFerramenta({
      nome: 'consultar_preco',
      descricao: 'Consulta o preco de um servico.',
      argumentos: z.object({ servico: z.string() }),
      async executar({ servico }) {
        return { servico, preco: 'R$ 45,00' };
      }
    })
  ];

  it('executa a ferramenta e volta ao modelo com o resultado', async () => {
    const provedor = provedorFalso('gemini', [
      { ferramentas: [{ nome: 'consultar_preco', argumentos: { servico: 'corte' } }] },
      { texto: 'O corte sai por *R$ 45,00*!' }
    ]);

    const r = await conversar({
      tenantId,
      systemPrompt: 'Voce e a Sofia.',
      mensagens: [{ papel: 'user', conteudo: 'quanto custa o corte?' }],
      ferramentas,
      provedores: [provedor]
    });

    assert.equal(r.texto, 'O corte sai por *R$ 45,00*!');
    assert.equal(r.voltas, 2);
    assert.equal(r.ferramentasUsadas.length, 1);
    assert.equal(r.ferramentasUsadas[0].resultado.preco, 'R$ 45,00');
  });

  /**
   * Modelo entra em loop: consulta, nao gosta, consulta de novo. Sem teto,
   * uma conversa consome a cota da empresa inteira.
   */
  it('para no limite de voltas quando o modelo entra em loop', async () => {
    // Cada volta com um argumento DIFERENTE: nao e repeticao, entao so o teto segura.
    const emLoop = provedorFalso('gemini', ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => ({
      ferramentas: [{ nome: 'consultar_preco', argumentos: { servico: s } }]
    })));

    const r = await conversar({
      tenantId,
      mensagens: [{ papel: 'user', conteudo: 'oi' }],
      ferramentas,
      provedores: [emLoop]
    });

    assert.equal(r.limiteAtingido, true);
    assert.equal(r.voltas, 5);
    assert.equal(r.semResposta, true, 'quem chama precisa saber que o texto e de reserva');
    assert.ok(r.texto.length > 0, 'mesmo no limite, precisa sair algo dizivel ao cliente');
  });

  /**
   * Visto num teste real: a Atena repetiu a MESMA consulta quatro vezes ate o
   * limite. O resultado nao muda — so a conta. A repeticao encerra o laco.
   */
  it('para na hora quando o modelo repete a mesma chamada', async () => {
    const emLoop = provedorFalso('gemini', [
      { ferramentas: [{ nome: 'consultar_preco', argumentos: { servico: 'corte' } }] }
    ]);

    const r = await conversar({
      tenantId,
      mensagens: [{ papel: 'user', conteudo: 'oi' }],
      ferramentas,
      provedores: [emLoop]
    });

    assert.equal(r.limiteAtingido, true);
    assert.equal(r.repetiu, true);
    assert.equal(r.voltas, 2, 'a segunda volta (repetida) encerra; nao gasta as outras tres');
    assert.equal(r.ferramentasUsadas.length, 1, 'a repeticao nem chega a executar');
    assert.equal(emLoop.impl.chamadas, 2);
  });

  it('interrompe na hora quando a ferramenta pede transferencia humana', async () => {
    const pedeHumano = [
      definirFerramenta({
        nome: 'transferir_para_humano',
        descricao: 'Passa para atendente.',
        argumentos: z.object({ motivo: z.string() }),
        async executar({ motivo }, contexto) {
          contexto.transferirParaHumano = { solicitado: true, motivo };
          return { sucesso: true };
        }
      })
    ];

    const provedor = provedorFalso('gemini', [
      { ferramentas: [{ nome: 'transferir_para_humano', argumentos: { motivo: 'cliente irritado' } }] },
      { texto: 'nao deveria chegar aqui' }
    ]);

    const contexto = {};
    const r = await conversar({
      tenantId,
      mensagens: [{ papel: 'user', conteudo: 'quero falar com gente!' }],
      ferramentas: pedeHumano,
      contexto,
      provedores: [provedor]
    });

    assert.equal(r.voltas, 1, 'nao faz sentido continuar conversando com o modelo');
    assert.equal(contexto.transferirParaHumano.solicitado, true);
    assert.equal(contexto.transferirParaHumano.motivo, 'cliente irritado');
  });
});

describe('divisao em baloes', () => {
  it('respeita as marcacoes do modelo', () => {
    const baloes = dividirEmBaloes('Oi, tudo bem?[BALAO]O corte sai R$ 45,00.[BALAO]Quer marcar?');
    assert.deepEqual(baloes, ['Oi, tudo bem?', 'O corte sai R$ 45,00.', 'Quer marcar?']);
  });

  it('mensagem curta continua em um balao so', () => {
    assert.deepEqual(dividirEmBaloes('Oi! Tudo bem?'), ['Oi! Tudo bem?']);
  });

  it('nunca passa de 3 baloes', () => {
    const texto = ['um', 'dois', 'tres', 'quatro', 'cinco'].map((t) => `[BALAO]${t}`).join('');
    const baloes = dividirEmBaloes(texto);

    assert.equal(baloes.length, 3);
    assert.match(baloes[2], /tres[\s\S]*quatro[\s\S]*cinco/, 'o excedente se junta no ultimo');
  });

  it('divide texto longo por paragrafo', () => {
    const longo = `${'a'.repeat(200)}\n\n${'b'.repeat(200)}`;
    assert.equal(dividirEmBaloes(longo).length, 2);
  });

  it('texto vazio nao gera balao', () => {
    assert.deepEqual(dividirEmBaloes(''), []);
    assert.deepEqual(dividirEmBaloes('   '), []);
    assert.deepEqual(dividirEmBaloes(null), []);
  });
});
