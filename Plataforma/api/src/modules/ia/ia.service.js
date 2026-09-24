import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, count, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { env } from '../../config/env.js';
import { agentProfiles, aiCalls, aiProviders } from '../../db/schema/ai.js';
import { appointments } from '../../db/schema/scheduling.js';
import { leads, professionals } from '../../db/schema/crm.js';
import { products, services } from '../../db/schema/catalog.js';
import { campaigns } from '../../db/schema/campaigns.js';
import { conversations, messages } from '../../db/schema/conversations.js';
import { ID } from '../../core/ids.js';
import { cifrar, decifrar, sufixoVisivel } from '../../core/crypto.js';
import { Conflito, NaoEncontrado, RegraDeNegocio } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import { PROVEDORES, gerar } from '../../ai/cascade.js';
import { gemini } from '../../ai/providers/gemini.js';
import { AGENTES_PADRAO, CHAVES_GRUPOS_ATENA, GRUPOS_ATENA, LIMITES_EXEMPLOS, TONS } from '../../ai/agentes-padrao.js';
import { classificarModelo, nomeAmigavel, ordenarParaExibicao, selecionarMelhores } from '../../ai/catalogo-modelos.js';

const log = comContexto({ modulo: 'ia-config' });

/**
 * Configuracao dos provedores de IA e dos perfis de agente.
 *
 * A regra mais importante deste arquivo esta em `apresentarProvedor`:
 * a chave de API NUNCA sai daqui.
 *
 * No sistema antigo, `GET /api/ai/status` chamava `getProviderConfigs()`, que
 * espalhava a linha inteira do banco com `...p` — incluindo `api_key` em texto
 * puro. E a rota nao exigia login. Qualquer um na rede levava a chave do
 * Gemini da empresa e podia gastar a cota dela a vontade.
 */

/** O que pode ser mostrado na tela. Lista de PERMITIDOS, nao de proibidos. */
function apresentarProvedor(p) {
  return {
    id: p.id,
    provedor: p.provedor,
    habilitado: p.habilitado,
    prioridade: p.prioridade,
    baseUrl: p.baseUrl,
    modeloPadrao: p.modeloPadrao,
    modeloManual: p.modeloManual,
    // Ja na ordem de exibicao: aprovados e ligados primeiro. A regra mora so
    // aqui; a tela nao a repete.
    modelos: ordenarParaExibicao(p.modelos ?? []),
    testadoEm: p.testadoEm?.getTime() ?? null,

    // A pessoa precisa saber SE ha chave e QUAL e (pra conferir que trocou),
    // sem que a chave saia do servidor. Quatro caracteres bastam.
    temChave: Boolean(p.apiKeyCifrada),
    chaveSufixo: p.apiKeySufixo ? `••••${p.apiKeySufixo}` : null,

    precisaChave: PROVEDORES[p.provedor]?.precisaChave !== false
  };
}

export async function listarProvedores(tenantId) {
  const linhas = await db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.tenantId, tenantId))
    .orderBy(aiProviders.prioridade);

  // Mostra tambem os provedores ainda nao configurados, para a tela oferecer
  // "adicionar" sem precisar saber quais existem.
  const configurados = new Set(linhas.map((l) => l.provedor));
  const disponiveis = Object.keys(PROVEDORES)
    .filter((nome) => !configurados.has(nome))
    .map((nome) => ({
      provedor: nome,
      habilitado: false,
      configurado: false,
      precisaChave: PROVEDORES[nome].precisaChave !== false,
      modelosSugeridos: PROVEDORES[nome].modelosPadrao ?? []
    }));

  return {
    provedores: linhas.map((p) => ({
      ...apresentarProvedor(p),
      configurado: true,
      // Presente so enquanto um teste em lote esta rodando (ou acabou de rodar).
      testeModelos: progressoDoTeste(tenantId, p.provedor)
    })),
    disponiveis
  };
}

/**
 * Salva a configuracao de um provedor.
 *
 * A chave chega em texto e sai cifrada para o banco. Se o campo vier vazio,
 * a chave atual e MANTIDA — isso permite a tela mandar o formulario inteiro
 * sem precisar reenviar a chave que o usuario nao digitou de novo (e que ela
 * nem recebeu, justamente porque nunca sai do servidor).
 */
export async function salvarProvedor(tenantId, provedor, dados, { usuario } = {}) {
  if (!PROVEDORES[provedor]) {
    throw new RegraDeNegocio(`Provedor "${provedor}" nao e suportado.`);
  }

  const existente = await db.query.aiProviders.findFirst({
    where: and(eq(aiProviders.tenantId, tenantId), eq(aiProviders.provedor, provedor))
  });

  const campos = {
    habilitado: dados.habilitado ?? existente?.habilitado ?? false,
    prioridade: dados.prioridade ?? existente?.prioridade ?? 100,
    baseUrl: dados.baseUrl ?? existente?.baseUrl ?? null,
    modeloPadrao: dados.modeloPadrao ?? existente?.modeloPadrao ?? null
  };

  if (dados.apiKey) {
    campos.apiKeyCifrada = cifrar(dados.apiKey);
    campos.apiKeySufixo = sufixoVisivel(dados.apiKey);
  }

  // Escolher o modelo primario e uma decisao da pessoa: passa a valer sobre a
  // escolha automatica. E o modelo escolhido LIGA junto — a cascata ignora
  // modelo desligado, e um primario que a cascata ignora seria uma escolha
  // que nao faz nada.
  let modelosAtualizados;
  if (dados.modeloPadrao) {
    campos.modeloManual = true;
    modelosAtualizados = (existente?.modelos ?? []).map((m) =>
      m.nome === dados.modeloPadrao ? { ...m, ativo: true, manual: true } : m
    );
    campos.modelos = modelosAtualizados;
  }

  // Nao deixa habilitar um provedor que exige chave sem ter chave: melhor
  // avisar agora do que a cascata pular ele silenciosamente na hora do aperto.
  const teraChave = campos.apiKeyCifrada ?? existente?.apiKeyCifrada;
  if (campos.habilitado && PROVEDORES[provedor].precisaChave !== false && !teraChave) {
    throw new RegraDeNegocio(`Informe a chave de API antes de habilitar o ${provedor}.`);
  }

  if (existente) {
    await db.update(aiProviders).set(campos).where(eq(aiProviders.id, existente.id));
  } else {
    await db.insert(aiProviders).values({ id: ID.provedorIa(), tenantId, provedor, ...campos });
  }

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'ia.provedor.salvar',
    entidade: 'ai_provider',
    entidadeId: provedor,
    // A chave nao entra na auditoria — nem cifrada.
    dados: { depois: { habilitado: campos.habilitado, prioridade: campos.prioridade, trocouChave: Boolean(dados.apiKey) } }
  });

  log.info({ tenantId, provedor, trocouChave: Boolean(dados.apiKey) }, 'Provedor de IA configurado');

  // Chave nova do Gemini: descobre e testa os modelos sozinho, em segundo
  // plano. E o que evita a tela de "0 modelos" logo depois de colar a chave.
  if (dados.apiKey && PROVEDORES[provedor].listarModelos && env.IA_TESTE_AUTOMATICO) {
    testarAutomaticamente(tenantId, provedor).catch(() => {});
  }

  const atualizado = await db.query.aiProviders.findFirst({
    where: and(eq(aiProviders.tenantId, tenantId), eq(aiProviders.provedor, provedor))
  });

  return apresentarProvedor(atualizado);
}

export async function removerProvedor(tenantId, provedor, { usuario } = {}) {
  const existente = await db.query.aiProviders.findFirst({
    where: and(eq(aiProviders.tenantId, tenantId), eq(aiProviders.provedor, provedor))
  });
  if (!existente) throw new NaoEncontrado('Provedor');

  await db.delete(aiProviders).where(eq(aiProviders.id, existente.id));

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'ia.provedor.remover',
    entidade: 'ai_provider',
    entidadeId: provedor
  });

  return { ok: true };
}

/**
 * Testa a conexao com um provedor, fazendo uma chamada real e curta.
 *
 * "Salvei a chave" e diferente de "a chave funciona". Sem este botao, o
 * primeiro cliente do dia e quem descobre que a chave expirou.
 */
export async function testarProvedor(tenantId, provedor) {
  const linha = await db.query.aiProviders.findFirst({
    where: and(eq(aiProviders.tenantId, tenantId), eq(aiProviders.provedor, provedor))
  });
  if (!linha) throw new NaoEncontrado('Provedor');

  const impl = PROVEDORES[provedor];
  const apiKey = linha.apiKeyCifrada ? decifrar(linha.apiKeyCifrada) : null;

  if (impl.precisaChave !== false && !apiKey) {
    return { ok: false, erro: 'Nenhuma chave cadastrada para este provedor.' };
  }

  const modelo = linha.modeloPadrao || impl.modelosPadrao?.[0];
  const inicio = Date.now();

  try {
    const r = await impl.gerar({
      apiKey,
      baseUrl: linha.baseUrl,
      modelo,
      systemPrompt: 'Responda com uma unica palavra.',
      mensagens: [{ papel: 'user', conteudo: 'Diga: funcionando' }],
      temperatura: 0,
      // 200 e nao 20: os modelos Gemini 2.5 "pensam" antes de responder, e o
      // pensamento conta no limite de saida. Com 20 tokens o modelo gasta tudo
      // pensando e devolve texto vazio — o teste marcaria como FALHA um modelo
      // que funciona perfeitamente.
      maxTokens: 200,
      timeoutMs: 15_000
    });

    await db
      .update(aiProviders)
      .set({ testadoEm: new Date() })
      .where(eq(aiProviders.id, linha.id));

    return { ok: true, modelo, latenciaMs: Date.now() - inicio, resposta: r.texto.slice(0, 100) };
  } catch (err) {
    log.warn({ provedor, erro: err.message }, 'Teste de provedor falhou');
    return { ok: false, modelo, latenciaMs: Date.now() - inicio, erro: err.message };
  }
}

/**
 * Descobre quais modelos a chave do Gemini consegue usar e atualiza o catalogo.
 *
 * O que ja existia no catalogo (resultado de teste, se a pessoa ligou ou
 * desligou) e PRESERVADO. Modelos novos entram DESLIGADOS: so passam a valer
 * depois de testados, quando a selecao automatica escolhe os melhores.
 *
 * Se a consulta ao Google falhar, o catalogo salvo fica como esta. Nunca
 * apagamos 41 modelos testados porque a internet piscou.
 *
 * @param {object} [opts]
 * @param {Function} [opts.listar] substitui a consulta real, nos testes
 */
export async function descobrirModelos(tenantId, provedor, { listar } = {}) {
  const linha = await db.query.aiProviders.findFirst({
    where: and(eq(aiProviders.tenantId, tenantId), eq(aiProviders.provedor, provedor))
  });
  if (!linha) throw new NaoEncontrado('Provedor');

  const atuais = linha.modelos ?? [];

  const impl = PROVEDORES[provedor];
  const listador = listar ?? impl?.listarModelos?.bind(impl);
  if (!listador) return { modelos: atuais };

  const apiKey = linha.apiKeyCifrada ? decifrar(linha.apiKeyCifrada) : null;
  if (!apiKey && impl.precisaChave !== false) return { modelos: atuais, aviso: `Cadastre a chave de API do ${provedor}.` };

  const encontrados = await listador({ apiKey, baseUrl: linha.baseUrl });

  if (encontrados === null) {
    return { modelos: atuais, aviso: 'Não consegui consultar o Google agora. O catálogo salvo foi mantido.' };
  }

  const porNome = new Map(atuais.map((m) => [m.nome, m]));

  const modelos = encontrados.map((m) => {
    const antigo = porNome.get(m.nome);
    return {
      // Novo: desligado ate ser testado. Conhecido: mantem tudo o que tinha.
      ativo: false,
      manual: false,
      ...antigo,
      nome: m.nome,
      nomeExibicao: m.nomeExibicao ?? antigo?.nomeExibicao ?? nomeAmigavel(m.nome),
      limiteEntrada: m.limiteEntrada ?? antigo?.limiteEntrada ?? null,
      limiteSaida: m.limiteSaida ?? antigo?.limiteSaida ?? null,
      categoria: classificarModelo({ nome: m.nome, nomeExibicao: m.nomeExibicao })
    };
  });

  await db.update(aiProviders).set({ modelos }).where(eq(aiProviders.id, linha.id));

  return { modelos };
}

/**
 * Liga/desliga um modelo. E uma decisao da pessoa, entao fica marcada como
 * `manual`: a selecao automatica dos proximos testes nao a desfaz.
 */
export async function alternarModelo(tenantId, provedor, nomeModelo, ativo) {
  const linha = await db.query.aiProviders.findFirst({
    where: and(eq(aiProviders.tenantId, tenantId), eq(aiProviders.provedor, provedor))
  });
  if (!linha) throw new NaoEncontrado('Provedor');

  const atuais = linha.modelos ?? [];
  const existe = atuais.some((m) => m.nome === nomeModelo);

  const modelos = existe
    ? atuais.map((m) => (m.nome === nomeModelo ? { ...m, ativo, manual: true } : m))
    : [...atuais, { nome: nomeModelo, nomeExibicao: nomeAmigavel(nomeModelo), categoria: 'texto', ativo, manual: true }];

  await db.update(aiProviders).set({ modelos }).where(eq(aiProviders.id, linha.id));
  return { modelos };
}

/**
 * Acoes em massa do catalogo ("Ativar Aprovados", "Desativar Reprovados").
 *
 * Quem passou no teste liga; quem falhou desliga. Nao mexe em modelo que nao
 * foi testado — sem resultado nao ha o que basear a decisao.
 */
export async function acaoEmLoteModelos(tenantId, provedor, acao) {
  const linha = await db.query.aiProviders.findFirst({
    where: and(eq(aiProviders.tenantId, tenantId), eq(aiProviders.provedor, provedor))
  });
  if (!linha) throw new NaoEncontrado('Provedor');

  const regras = {
    ativar_aprovados: { alvo: (m) => m.ok === true, ativo: true },
    desativar_reprovados: { alvo: (m) => m.ok === false, ativo: false }
  };
  const regra = regras[acao];
  if (!regra) throw new RegraDeNegocio(`Ação em lote desconhecida: ${acao}.`);

  let alterados = 0;
  const modelos = (linha.modelos ?? []).map((m) => {
    if (!regra.alvo(m) || m.ativo === regra.ativo) return m;
    alterados += 1;
    return { ...m, ativo: regra.ativo, manual: true };
  });

  await db.update(aiProviders).set({ modelos }).where(eq(aiProviders.id, linha.id));
  return { modelos, alterados };
}

// ============================================================================
// TESTE EM LOTE DOS MODELOS
// ============================================================================

/**
 * Testes em andamento, por empresa+provedor.
 *
 * Fica em memoria: e progresso de uma tarefa que dura minutos, sem valor
 * depois de terminada — o RESULTADO e que vai para o banco.
 */
const testesEmAndamento = new Map();

const chaveDoTeste = (tenantId, provedor) => `${tenantId}:${provedor}`;

/** O que a tela mostra enquanto o teste roda ("Testando 12 de 41..."). */
export function progressoDoTeste(tenantId, provedor) {
  const t = testesEmAndamento.get(chaveDoTeste(tenantId, provedor));
  return t ? { rodando: t.rodando, feitos: t.feitos, total: t.total } : null;
}

/**
 * Testa cada modelo ativo do provedor, com uma chamada real e curta.
 *
 * Existe porque a lista de modelos que a API do Google devolve inclui coisas
 * que a chave nao consegue usar (cota zerada, modelo em previa fechada,
 * modelo que so gera imagem). Sem testar, a cascata gastaria a espera de cada
 * um deles — com o cliente esperando — para descobrir isso sozinha.
 *
 * Roda em SEGUNDO PLANO: com 41 modelos e ate 1 minuto cada, a requisicao
 * HTTP nao pode ficar pendurada. Devolve na hora; a tela acompanha pelo
 * progresso.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]    limite por modelo (padrao: 1 minuto)
 * @param {number} [opts.concorrencia] quantos modelos testar ao mesmo tempo
 * @param {object} [opts.impl]         implementacao do provedor, para os testes
 * @returns {Promise<{ iniciado: true, total: number, concluido: Promise<void> }>}
 */
export async function iniciarTesteDeModelos(
  tenantId,
  provedor,
  { timeoutMs = 60_000, concorrencia = 4, impl, listar } = {}
) {
  const chave = chaveDoTeste(tenantId, provedor);
  if (testesEmAndamento.get(chave)?.rodando) {
    throw new Conflito('Já existe um teste de modelos em andamento para este provedor.');
  }

  let linha = await db.query.aiProviders.findFirst({
    where: and(eq(aiProviders.tenantId, tenantId), eq(aiProviders.provedor, provedor))
  });
  if (!linha) throw new NaoEncontrado('Provedor');

  const implementacao = impl ?? PROVEDORES[provedor];
  const apiKey = linha.apiKeyCifrada ? decifrar(linha.apiKeyCifrada) : null;

  if (implementacao.precisaChave !== false && !apiKey) {
    throw new RegraDeNegocio('Cadastre a chave de API antes de testar os modelos.');
  }

  // Atualiza o catalogo antes de testar: modelos novos do Google entram
  // sozinhos. Gemini consulta a API; os demais usam os modelos sugeridos.
  if (implementacao.listarModelos || listar) {
    await descobrirModelos(tenantId, provedor, { listar });
  }
  linha = await db.query.aiProviders.findFirst({ where: eq(aiProviders.id, linha.id) });
  if (!(linha.modelos ?? []).length) {
    const sugeridos = (implementacao.modelosPadrao ?? []).map((nome) => ({ nome, nomeExibicao: nome, categoria: 'texto', ativo: true }));
    await db.update(aiProviders).set({ modelos: sugeridos }).where(eq(aiProviders.id, linha.id));
  }
  linha = await db.query.aiProviders.findFirst({ where: eq(aiProviders.id, linha.id) });

  // Testa TODOS, inclusive os desligados. E o teste que diz quais valem a
  // pena ligar; testar so os ja ligados nunca descobriria um modelo melhor.
  const alvos = (linha.modelos ?? []).map((m) => m.nome);
  if (alvos.length === 0) {
    throw new RegraDeNegocio('Nenhum modelo no catálogo para testar. Confira a chave de API.');
  }

  const estado = { rodando: true, feitos: 0, total: alvos.length };
  testesEmAndamento.set(chave, estado);

  const resultados = new Map();

  async function testarUm(nome) {
    const inicio = Date.now();
    try {
      await implementacao.gerar({
        apiKey,
        baseUrl: linha.baseUrl,
        modelo: nome,
        systemPrompt: 'Responda com uma unica palavra.',
        mensagens: [{ papel: 'user', conteudo: 'Diga: funcionando' }],
        temperatura: 0,
        maxTokens: 200,
        timeoutMs
      });
      resultados.set(nome, { ok: true, latenciaMs: Date.now() - inicio, erro: null });
    } catch (err) {
      resultados.set(nome, {
        ok: false,
        latenciaMs: Date.now() - inicio,
        erro: String(err.message ?? err).slice(0, 200)
      });
    } finally {
      estado.feitos += 1;
    }
  }

  const concluido = (async () => {
    try {
      // Fila simples com N trabalhadores: testa `concorrencia` modelos por
      // vez. Um por vez levaria dezenas de minutos; todos de uma vez estouraria
      // o limite de requisicoes por minuto do proprio provedor.
      const fila = [...alvos];
      const trabalhadores = Array.from({ length: Math.min(concorrencia, fila.length) }, async () => {
        while (fila.length > 0) await testarUm(fila.shift());
      });
      await Promise.all(trabalhadores);

      // Relê a linha: a pessoa pode ter ligado/desligado modelos durante o
      // teste, e sobrescrever com a copia antiga desfaria isso.
      const atual = await db.query.aiProviders.findFirst({ where: eq(aiProviders.id, linha.id) });
      const agora = Date.now();
      let modelos = (atual?.modelos ?? []).map((m) =>
        resultados.has(m.nome) ? { ...m, ...resultados.get(m.nome), testadoEm: agora } : m
      );

      const alteracoes = { testadoEm: new Date() };
      let melhor = null;

      // Escolhe os melhores para atender no WhatsApp: liga os recomendados e
      // desliga o resto (respeitando o que a pessoa fez a mao). Modelos de
      // outros provedores nao passam por isso: nao tem catalogo de dezenas.
      if (provedor === 'gemini') {
        const selecao = selecionarMelhores(modelos);
        modelos = selecao.modelos;
        melhor = selecao.melhor;

        // O primario tambem e automatico — ate a pessoa escolher o dela.
        if (melhor && !atual.modeloManual) alteracoes.modeloPadrao = melhor;
      }
      else {
        // Demais provedores: liga quem passou, desliga quem falhou (salvo o que
        // a pessoa decidiu a mao) e o mais rapido vira o primario automatico.
        modelos = modelos.map((m) => (m.manual || m.ok === undefined ? m : { ...m, ativo: m.ok === true }));
        melhor = modelos.filter((m) => m.ok === true).sort((a, b) => a.latenciaMs - b.latenciaMs)[0]?.nome ?? null;
        if (melhor && !atual.modeloManual) alteracoes.modeloPadrao = melhor;
      }
      alteracoes.modelos = modelos;

      await db.update(aiProviders).set(alteracoes).where(eq(aiProviders.id, linha.id));

      const aprovados = [...resultados.values()].filter((r) => r.ok).length;
      log.info(
        { tenantId, provedor, testados: alvos.length, aprovados, recomendados: modelos.filter((m) => m.recomendado).length, melhor },
        'Teste de modelos concluído'
      );
    } catch (err) {
      log.error({ err, tenantId, provedor }, 'Teste de modelos falhou');
    } finally {
      estado.rodando = false;
    }
  })();

  return { iniciado: true, total: alvos.length, concluido };
}

/**
 * Testa sozinho, sem quem chamou precisar tratar erro.
 *
 * Um teste automatico que falha (chave invalida, sem internet, Google fora)
 * nao pode derrubar o boot nem estourar uma requisicao de "salvar chave".
 * Devolve `{ concluido }` (a promessa de conclusao), ou `null` se nem chegou
 * a iniciar.
 *
 * A promessa vai DENTRO de um objeto de proposito: uma funcao `async` que faz
 * `return promessa` espera a promessa terminar antes de devolver. Aqui isso
 * bloquearia quem chamou ate o teste inteiro acabar (dezenas de segundos) —
 * e no boot, testaria uma empresa de cada vez em vez de todas em paralelo.
 */
export async function testarAutomaticamente(tenantId, provedor, opts = {}) {
  try {
    const { concluido } = await iniciarTesteDeModelos(tenantId, provedor, opts);
    return { concluido };
  } catch (err) {
    log.warn({ tenantId, provedor, motivo: err.message }, 'Teste automático de modelos não iniciou');
    return null;
  }
}

/**
 * Ao iniciar o sistema: testa os modelos do Gemini de cada empresa cujo
 * ultimo teste ja venceu.
 *
 * A validade (IA_TESTE_VALIDADE_HORAS) existe por causa do `npm run dev`, que
 * reinicia o servidor a cada arquivo salvo: sem ela, cada Ctrl+S dispararia
 * dezenas de chamadas ao Google. Em producao, que reinicia raramente, o
 * teste roda a cada partida.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.ativo]          liga/desliga (padrao: IA_TESTE_AUTOMATICO)
 * @param {number}  [opts.validadeHoras]  validade do ultimo teste (padrao: IA_TESTE_VALIDADE_HORAS)
 * @returns {Promise<{ iniciados: number, concluido: Promise<unknown> }>}
 */
export async function testarModelosNoBoot({
  ativo = env.IA_TESTE_AUTOMATICO,
  validadeHoras = env.IA_TESTE_VALIDADE_HORAS,
  ...opts
} = {}) {
  if (!ativo) return { iniciados: 0, concluido: Promise.resolve() };

  const linhas = await db
    .select()
    .from(aiProviders)
    .where(and(inArray(aiProviders.provedor, ['gemini', 'groq']), eq(aiProviders.habilitado, true)));

  const validadeMs = validadeHoras * 3_600_000;
  const esperas = [];

  for (const linha of linhas) {
    if (!linha.apiKeyCifrada) continue;

    const idade = Date.now() - (linha.testadoEm?.getTime() ?? 0);
    if (idade < validadeMs) {
      log.info({ tenantId: linha.tenantId, idadeHoras: Math.round(idade / 3_600_000) }, 'Teste de modelos ainda válido; não repetido');
      continue;
    }

    const teste = await testarAutomaticamente(linha.tenantId, linha.provedor, opts);
    if (teste) esperas.push(teste.concluido);
  }

  return { iniciados: esperas.length, concluido: Promise.all(esperas) };
}

/**
 * Devolve a chave de API em texto, para o botao do "olho" na tela.
 *
 * E a UNICA rota que faz isso, e de proposito nao esta na listagem: a chave
 * so sai quando alguem clica para ve-la. Cada visualizacao fica registrada
 * na auditoria (sem a chave), entao da para saber quem olhou e quando.
 */
export async function revelarChave(tenantId, provedor, { usuario } = {}) {
  const linha = await db.query.aiProviders.findFirst({
    where: and(eq(aiProviders.tenantId, tenantId), eq(aiProviders.provedor, provedor))
  });
  if (!linha) throw new NaoEncontrado('Provedor');

  const chave = linha.apiKeyCifrada ? decifrar(linha.apiKeyCifrada) : null;

  if (!chave) {
    throw new RegraDeNegocio(
      linha.apiKeyCifrada
        ? 'Não foi possível ler a chave salva (o segredo do servidor mudou). Cadastre a chave de novo.'
        : 'Nenhuma chave cadastrada para este provedor.'
    );
  }

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'ia.chave.revelar',
    entidade: 'ai_provider',
    entidadeId: provedor
  });

  log.info({ tenantId, provedor, porUserId: usuario?.id }, 'Chave de API revelada na tela');
  return { chave };
}

// ============================================================================
// PERFIS DE AGENTE
// ============================================================================

function apresentarAgente(a) {
  return {
    id: a.id,
    chave: a.chave,
    nome: a.nome,
    avatar: a.avatar,
    systemPrompt: a.systemPrompt,
    tom: a.tom,
    // O banco guarda milesimos (inteiro) para evitar erro de ponto flutuante;
    // a tela trabalha com o decimal de sempre.
    temperatura: a.temperaturaMilesimos / 1000,
    modeloPreferido: a.modeloPreferido,
    maxTokens: a.maxTokens,
    ferramentas: a.ferramentas ?? [],
    // O que ainda nao foi salvo vem do padrao de fabrica do agente.
    config: { ...(AGENTES_PADRAO[a.chave]?.config ?? {}), ...(a.config ?? {}) },
    ativo: a.ativo
  };
}

/** O agente como se nunca tivesse sido editado: os valores de fabrica. */
function agentePadrao(chave) {
  const p = AGENTES_PADRAO[chave];
  if (!p) return null;
  return {
    id: null,
    chave,
    nome: p.nome,
    avatar: p.avatar,
    systemPrompt: p.systemPrompt,
    tom: p.tom,
    temperatura: p.temperaturaMilesimos / 1000,
    modeloPreferido: null,
    maxTokens: p.maxTokens,
    ferramentas: p.ferramentas,
    config: { ...(p.config ?? {}) },
    ativo: true,
    padrao: true
  };
}

/**
 * Lista os agentes, completando com os valores de fabrica o que ainda nao foi salvo.
 *
 * Um banco criado antes da Atena virar agente de IA nao tem a linha dela.
 * Em vez de exigir uma migracao de dados (ou de escrever no banco so porque
 * alguem abriu a tela), a listagem mescla: o que existe vem do banco, o que
 * falta vem do padrao. A linha so passa a existir quando alguem salva.
 */
export async function listarAgentes(tenantId) {
  const linhas = await db.query.agentProfiles.findMany({
    where: eq(agentProfiles.tenantId, tenantId)
  });

  const salvos = new Map(linhas.map((l) => [l.chave, apresentarAgente(l)]));

  // Os agentes conhecidos vem primeiro, na ordem certa (frente, depois bastidores).
  const conhecidos = Object.keys(AGENTES_PADRAO).map((chave) => salvos.get(chave) ?? agentePadrao(chave));
  const outros = [...salvos.values()].filter((a) => !AGENTES_PADRAO[a.chave]);

  return [...conhecidos, ...outros];
}

/** Catalogo do que a Atena pode fazer, para a tela montar os checkboxes. */
export function gruposDaAtena() {
  return Object.entries(GRUPOS_ATENA).map(([chave, g]) => ({
    chave,
    rotulo: g.rotulo,
    descricao: g.descricao
  }));
}

export function tonsDisponiveis() {
  return Object.entries(TONS).map(([chave, rotulo]) => ({ chave, rotulo }));
}

export async function obterAgente(tenantId, chave) {
  const linha = await db.query.agentProfiles.findFirst({
    where: and(eq(agentProfiles.tenantId, tenantId), eq(agentProfiles.chave, chave))
  });
  if (!linha) return agentePadrao(chave);

  const agente = apresentarAgente(linha);

  // Uma linha criada so para ligar/desligar (ou por versao antiga) pode ter o
  // texto em branco. Instrucao vazia nao e "sem instrucao": e uma IA sem rumo.
  if (!agente.systemPrompt?.trim() && AGENTES_PADRAO[chave]) {
    agente.systemPrompt = AGENTES_PADRAO[chave].systemPrompt;
  }
  return agente;
}

export async function salvarAgente(tenantId, chave, dados, { usuario } = {}) {
  const existente = await db.query.agentProfiles.findFirst({
    where: and(eq(agentProfiles.tenantId, tenantId), eq(agentProfiles.chave, chave))
  });

  // A Atena so aceita permissoes que existem. Um nome digitado errado viraria
  // uma permissao que nao faz nada — e a empresa acharia que desligou algo.
  if (chave === 'atena' && dados.ferramentas !== undefined) {
    const invalidas = dados.ferramentas.filter((f) => !CHAVES_GRUPOS_ATENA.includes(f));
    if (invalidas.length > 0) {
      throw new RegraDeNegocio(
        `Permissão desconhecida: ${invalidas.join(', ')}. As válidas são: ${CHAVES_GRUPOS_ATENA.join(', ')}.`
      );
    }
  }

  /**
   * Modelo preferido: "provedor:modelo" (ex.: "groq:qwen/qwen3.8-27b").
   * O provedor vai junto porque o mesmo nome de modelo pode existir em dois
   * lugares, e a cascata precisa saber com que chave chamar.
   */
  if (dados.modeloPreferido) {
    const [provedor] = dados.modeloPreferido.split(':');
    if (!PROVEDORES[provedor] || !dados.modeloPreferido.slice(provedor.length + 1)) {
      throw new RegraDeNegocio('Modelo preferido invalido. Use o formato "provedor:modelo".');
    }
  }

  const campos = {};
  if (dados.config !== undefined) {
    const exemplos = (dados.config.exemplos ?? [])
      .map((e) => String(e).trim())
      .filter(Boolean);
    if (exemplos.length > LIMITES_EXEMPLOS.quantidade) {
      throw new RegraDeNegocio(`No maximo ${LIMITES_EXEMPLOS.quantidade} exemplos de estilo.`);
    }
    if (exemplos.some((e) => e.length > LIMITES_EXEMPLOS.caracteres)) {
      throw new RegraDeNegocio(`Cada exemplo pode ter ate ${LIMITES_EXEMPLOS.caracteres} caracteres.`);
    }
    campos.config = { ...(existente?.config ?? AGENTES_PADRAO[chave]?.config ?? {}), ...dados.config, exemplos };
  }
  if (dados.nome !== undefined) campos.nome = dados.nome;
  if (dados.avatar !== undefined) campos.avatar = dados.avatar;
  if (dados.systemPrompt !== undefined) campos.systemPrompt = dados.systemPrompt;
  if (dados.tom !== undefined) campos.tom = dados.tom;
  if (dados.temperatura !== undefined) campos.temperaturaMilesimos = Math.round(dados.temperatura * 1000);
  if (dados.modeloPreferido !== undefined) campos.modeloPreferido = dados.modeloPreferido;
  if (dados.maxTokens !== undefined) campos.maxTokens = dados.maxTokens;
  if (dados.ferramentas !== undefined) campos.ferramentas = dados.ferramentas;
  if (dados.ativo !== undefined) campos.ativo = dados.ativo;

  if (existente) {
    await db.update(agentProfiles).set(campos).where(eq(agentProfiles.id, existente.id));
  } else {
    // Primeira vez que este agente e salvo: parte dos valores de fabrica e
    // sobrescreve so o que veio. Sem isso, clicar em "Desativar" na Atena
    // criaria uma linha sem instrucoes e sem nenhuma permissao — e ao
    // reativar, ela estaria lobotomizada.
    const base = AGENTES_PADRAO[chave] ?? {};
    await db.insert(agentProfiles).values({
      id: ID.agente(),
      tenantId,
      chave,
      nome: base.nome ?? chave,
      avatar: base.avatar,
      systemPrompt: base.systemPrompt ?? '',
      tom: base.tom ?? 'acolhedor',
      temperaturaMilesimos: base.temperaturaMilesimos ?? 700,
      maxTokens: base.maxTokens ?? 800,
      ferramentas: base.ferramentas ?? [],
      config: base.config ?? {},
      ...campos
    });
  }

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'ia.agente.salvar',
    entidade: 'agent_profile',
    entidadeId: chave,
    dados: { depois: campos }
  });

  return obterAgente(tenantId, chave);
}

// ============================================================================
// USO E CUSTO
// ============================================================================

/**
 * Quanto a IA foi usada nos ultimos dias.
 *
 * O sistema antigo nao tinha nada disso: o unico jeito de saber o consumo era
 * abrir o painel do Google, e o unico jeito de saber que o provedor principal
 * estava falhando era ler o terminal na hora exata.
 */
export async function uso(tenantId, { dias = 7 } = {}) {
  const desde = new Date(Date.now() - dias * 86_400_000);

  const [resumo] = await db
    .select({
      total: sql`COUNT(*)`.as('total'),
      sucessos: sql`COALESCE(SUM(CASE WHEN ${aiCalls.sucesso} = 1 THEN 1 ELSE 0 END), 0)`.as('sucessos'),
      falhas: sql`COALESCE(SUM(CASE WHEN ${aiCalls.sucesso} = 0 THEN 1 ELSE 0 END), 0)`.as('falhas'),
      tokensEntrada: sql`COALESCE(SUM(${aiCalls.tokensEntrada}), 0)`.as('tokens_entrada'),
      tokensSaida: sql`COALESCE(SUM(${aiCalls.tokensSaida}), 0)`.as('tokens_saida'),
      latenciaMedia: sql`COALESCE(CAST(AVG(${aiCalls.latenciaMs}) AS INTEGER), 0)`.as('latencia_media')
    })
    .from(aiCalls)
    .where(and(eq(aiCalls.tenantId, tenantId), gte(aiCalls.createdAt, desde)));

  const porProvedor = await db
    .select({
      provedor: aiCalls.provedor,
      modelo: aiCalls.modelo,
      chamadas: sql`COUNT(*)`.as('chamadas'),
      tokens: sql`COALESCE(SUM(${aiCalls.tokensEntrada} + ${aiCalls.tokensSaida}), 0)`.as('tokens')
    })
    .from(aiCalls)
    .where(and(eq(aiCalls.tenantId, tenantId), gte(aiCalls.createdAt, desde), eq(aiCalls.sucesso, true)))
    .groupBy(aiCalls.provedor, aiCalls.modelo)
    .orderBy(desc(sql`COUNT(*)`));

  // Por agente: separa o custo da Sofia (conversa) do da Atena (dados e agenda).
  // Sem isso, "a IA gastou X" nao diz qual das duas esta pesando na conta.
  const porAgente = await db
    .select({
      origem: aiCalls.origem,
      agente: aiCalls.agentKey,
      chamadas: sql`COUNT(*)`.as('chamadas'),
      falhas: sql`COALESCE(SUM(CASE WHEN ${aiCalls.sucesso} = 0 THEN 1 ELSE 0 END), 0)`.as('falhas'),
      tokens: sql`COALESCE(SUM(${aiCalls.tokensEntrada} + ${aiCalls.tokensSaida}), 0)`.as('tokens'),
      latenciaMedia: sql`COALESCE(CAST(AVG(${aiCalls.latenciaMs}) AS INTEGER), 0)`.as('latencia_media')
    })
    .from(aiCalls)
    .where(and(eq(aiCalls.tenantId, tenantId), gte(aiCalls.createdAt, desde)))
    .groupBy(aiCalls.origem, aiCalls.agentKey)
    .orderBy(desc(sql`COUNT(*)`));

  const num = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, Number(v) || 0]));

  return {
    periodoDias: dias,
    ...num(resumo),
    porProvedor: porProvedor.map((p) => ({ ...p, chamadas: Number(p.chamadas), tokens: Number(p.tokens) })),
    porAgente: porAgente.map((a) => ({
      origem: a.origem,
      agente: a.agente,
      chamadas: Number(a.chamadas),
      falhas: Number(a.falhas),
      tokens: Number(a.tokens),
      latenciaMedia: Number(a.latenciaMedia)
    }))
  };
}

/**
 * Quanto ha em cada tabela principal e o tamanho do arquivo do banco.
 *
 * E a aba "Metricas & Banco de Dados": a pessoa quer saber, num relance, se
 * o sistema esta crescendo como esperado e se o arquivo ja passou de algum
 * tamanho que mereca atencao (ou backup).
 */
export async function estatisticasDoBanco(tenantId) {
  const tabelas = [
    ['Contatos', leads],
    ['Agendamentos', appointments],
    ['Conversas', conversations],
    ['Mensagens', messages],
    ['Serviços', services],
    ['Profissionais', professionals],
    ['Produtos', products],
    ['Campanhas', campaigns],
    ['Chamadas de IA', aiCalls]
  ];

  const linhas = await Promise.all(
    tabelas.map(async ([rotulo, tabela]) => {
      // Tabelas com exclusao logica contam so o que esta ativo: os registros
      // na lixeira ainda ocupam espaco, mas nao sao "os seus dados".
      const filtro = tabela.deletedAt
        ? and(eq(tabela.tenantId, tenantId), isNull(tabela.deletedAt))
        : eq(tabela.tenantId, tenantId);

      const [r] = await db.select({ n: count() }).from(tabela).where(filtro);
      return { rotulo, registros: Number(r?.n) || 0 };
    })
  );

  let arquivo = null;
  if (env.DATABASE_URL.startsWith('file:')) {
    try {
      arquivo = { tamanhoBytes: statSync(resolve(env.DATABASE_URL.slice('file:'.length))).size };
    } catch {
      arquivo = null;
    }
  }

  return { tabelas: linhas, arquivo, motor: 'SQLite' };
}

/** Conversa avulsa com a IA, para testar prompt na tela de configuracao. */
export async function experimentar(tenantId, { mensagem, systemPrompt, temperatura = 0.7 }) {
  const r = await gerar({
    tenantId,
    origem: 'teste',
    systemPrompt,
    mensagens: [{ papel: 'user', conteudo: mensagem }],
    temperatura
  });

  return {
    texto: r.texto,
    provedor: r.provedor,
    modelo: r.modelo,
    latenciaMs: r.latenciaMs,
    tentativasAntes: r.tentativas?.length ?? 0
  };
}
