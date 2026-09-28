import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { settings } from '../../db/schema/ai.js';
import { cifrar, decifrar, sufixoVisivel } from '../../core/crypto.js';

/**
 * Configuracao do Hades — o assistente administrativo do dono.
 *
 * Mora SEPARADA de tudo o que ja funciona: nao e um perfil em
 * `agent_profiles`, nao usa a cascata nem as chaves de `ai_providers`. Uma
 * linha propria em `settings` (chave `hades.config`), com a SUA chave de API
 * (cifrada como as demais). Assim, mexer no Hades nunca muda nada no
 * atendimento dos clientes, e vice-versa.
 */

const CHAVE = 'hades.config';

export const PERSONA_PADRAO = [
  'Você é o Hades, o conselheiro administrativo do dono deste negócio.',
  'Converse de igual para igual, com calma e franqueza: nada de enrolação nem de elogio vazio.',
  'Seu trabalho é ajudar o dono a enxergar o negócio e decidir: aponte o que os números mostram,',
  'o que preocupa, onde há oportunidade e o que fazer primeiro.',
  'Quando sugerir uma promoção, seja concreto: o quê, para quem, em que dias e horários, por quanto',
  'tempo e como medir se funcionou — de preferência atacando os dias e horários fracos.',
  'Traga tendências do ramo quando ajudarem a decidir, sempre dizendo de onde vieram.'
].join(' ');

const PADRAO = {
  ativo: true,
  nome: 'Hades',
  modelo: null,
  temperatura: 0.7,
  pesquisaWeb: true,
  systemPrompt: PERSONA_PADRAO,
  chaveCifrada: null
};

async function ler(tenantId) {
  const linha = await db.query.settings.findFirst({
    where: and(eq(settings.tenantId, tenantId), eq(settings.chave, CHAVE))
  });
  return { ...PADRAO, ...(linha?.valor ?? {}) };
}

async function gravar(tenantId, valor) {
  const existe = await db.query.settings.findFirst({
    where: and(eq(settings.tenantId, tenantId), eq(settings.chave, CHAVE))
  });
  if (existe) {
    await db.update(settings).set({ valor }).where(and(eq(settings.tenantId, tenantId), eq(settings.chave, CHAVE)));
  } else {
    await db.insert(settings).values({ tenantId, chave: CHAVE, valor, descricao: 'Hades (assistente administrativo)' });
  }
}

/** A configuracao como a TELA ve: nunca a chave, so se existe e o final dela. */
export async function configPublica(tenantId) {
  const c = await ler(tenantId);
  const chave = decifrar(c.chaveCifrada);
  return {
    ativo: c.ativo,
    nome: c.nome,
    modelo: c.modelo,
    temperatura: c.temperatura,
    pesquisaWeb: c.pesquisaWeb,
    systemPrompt: c.systemPrompt,
    temChave: Boolean(chave),
    chaveFinal: chave ? sufixoVisivel(chave) : null,
    personaPadrao: PERSONA_PADRAO
  };
}

/** Para uso interno (a conversa): a configuracao com a chave aberta. */
export async function configComChave(tenantId) {
  const c = await ler(tenantId);
  return { ...c, apiKey: decifrar(c.chaveCifrada) };
}

/**
 * Grava so o que veio. `apiKey`: texto = troca a chave; null = remove.
 * Devolve a configuracao publica.
 */
export async function salvarConfig(tenantId, dados) {
  const atual = await ler(tenantId);
  const novo = { ...atual };
  for (const campo of ['ativo', 'nome', 'modelo', 'temperatura', 'pesquisaWeb', 'systemPrompt']) {
    if (dados[campo] !== undefined) novo[campo] = dados[campo];
  }
  if (dados.apiKey !== undefined) novo.chaveCifrada = dados.apiKey ? cifrar(dados.apiKey.trim()) : null;
  await gravar(tenantId, novo);
  return configPublica(tenantId);
}
