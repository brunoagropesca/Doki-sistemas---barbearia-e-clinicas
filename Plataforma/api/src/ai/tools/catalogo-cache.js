import { RegraDeNegocio } from '../../core/errors.js';
import * as catalogo from '../../modules/catalogo/catalogo.service.js';

/**
 * Catalogo em memoria para a IA.
 *
 * Duas dores que ele resolve, ambas de tokens:
 *
 * 1. Cada consulta ao catalogo era uma ida ao banco E uma volta do modelo. E o
 *    catalogo muda poucas vezes por semana, mas era relido a cada mensagem.
 *
 * 2. O modelo so consegue chamar `consultar_horarios` depois de ler os IDS dos
 *    servicos e profissionais — o que obrigava uma volta inteira (com todo o
 *    contexto reenviado) so para descobrir `svc_0mu7syjacrzl8qm84`. Resolvendo
 *    NOMES aqui, o modelo chama direto com "Corte Social" e "Carlos".
 *
 * O cache vale 60 s e e derrubado na hora quando alguem edita servico ou
 * profissional (`invalidarCatalogo`), entao nao ha janela em que a IA cite um
 * preco antigo depois de a empresa ter mudado a tabela.
 */

const VALIDADE_MS = 60_000;
const cache = new Map(); // tenantId -> { em, lista }

/** Tira acento e caixa: "Degradê" casa com "degrade". */
export function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
}

export function invalidarCatalogo(tenantId) {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

/** Servicos ativos, cada um com seus profissionais (e valores proprios). */
export async function catalogoDaEmpresa(tenantId) {
  const guardado = cache.get(tenantId);
  if (guardado && Date.now() - guardado.em < VALIDADE_MS) return guardado.lista;

  const lista = await catalogo.listarServicos(tenantId, {});
  cache.set(tenantId, { em: Date.now(), lista });
  return lista;
}

const ehId = (ref, prefixo) => String(ref).startsWith(`${prefixo}_`);

/**
 * Acha um servico por id OU por nome.
 *
 * Nome ambiguo nao e adivinhado: "corte" casa com tres servicos, e escolher um
 * seria marcar o servico errado para o cliente. Devolvemos as opcoes para o
 * modelo perguntar.
 */
export async function resolverServico(tenantId, ref) {
  const lista = await catalogoDaEmpresa(tenantId);
  const texto = String(ref ?? '').trim();
  if (!texto) throw new RegraDeNegocio('Informe o serviço.');

  if (ehId(texto, 'svc')) {
    const porId = lista.find((s) => s.id === texto);
    if (porId) return porId;
  }

  const alvo = normalizar(texto);
  const exato = lista.filter((s) => normalizar(s.nome) === alvo);
  if (exato.length === 1) return exato[0];

  const parecidos = lista.filter((s) => normalizar(s.nome).includes(alvo));
  if (parecidos.length === 1) return parecidos[0];

  if (parecidos.length > 1) {
    throw new RegraDeNegocio(
      `"${texto}" pode ser: ${parecidos.map((s) => s.nome).join(', ')}. Pergunte ao cliente qual deles.`
    );
  }
  throw new RegraDeNegocio(
    `Não encontrei o serviço "${texto}". Os serviços são: ${lista.map((s) => s.nome).join(', ')}.`
  );
}

/**
 * Acha um profissional entre os que fazem o servico, por id OU por nome.
 * Procurar so entre quem faz o servico evita o erro "Fulano nao executa isto"
 * depois de a IA ja ter prometido o horario.
 */
export function resolverProfissional(servico, ref) {
  const texto = String(ref ?? '').trim();
  const doServico = servico.profissionais ?? [];

  if (ehId(texto, 'prof')) {
    const porId = doServico.find((p) => p.id === texto);
    if (porId) return porId;
  }

  const alvo = normalizar(texto);
  const parecidos = doServico.filter((p) => normalizar(p.nome).includes(alvo));
  if (parecidos.length === 1) return parecidos[0];

  if (parecidos.length > 1) {
    throw new RegraDeNegocio(
      `"${texto}" pode ser: ${parecidos.map((p) => p.nome).join(', ')}. Pergunte ao cliente qual deles.`
    );
  }
  throw new RegraDeNegocio(
    `Ninguém chamado "${texto}" faz ${servico.nome}. Quem faz: ${doServico.map((p) => p.nome).join(', ') || 'ninguém'}.`
  );
}

/**
 * Resumo do catalogo em poucas linhas, para o prompt da Sofia.
 *
 * Com os precos ja no prompt, "quanto custa um corte?" nao precisa acordar a
 * Atena: a resposta que custava uma chamada inteira (2 mil tokens) vira ~150 no
 * prompt. Devolve null para catalogo grande — passado disso, o resumo custaria
 * mais do que as consultas que ele evita.
 */
export async function resumoDoCatalogo(tenantId, { maxServicos = 25 } = {}) {
  const lista = await catalogoDaEmpresa(tenantId);
  if (lista.length === 0 || lista.length > maxServicos) return null;

  return lista
    .map((s) => {
      const profs = (s.profissionais ?? [])
        .map((p) => (p.precoProprio ? `${p.nome} ${p.precoFormatado}` : p.nome))
        .join(', ');
      return `- ${s.nome}: ${s.precoFormatado}, ${s.duracaoMinutos} min${profs ? ` (${profs})` : ''}`;
    })
    .join('\n');
}
