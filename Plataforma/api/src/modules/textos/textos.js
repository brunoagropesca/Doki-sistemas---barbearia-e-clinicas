import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { settings } from '../../db/schema/ai.js';
import { tenants } from '../../db/schema/tenants.js';
import { NaoEncontrado, RegraDeNegocio } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';

const log = comContexto({ modulo: 'textos' });

/**
 * Textos do sistema editaveis pelo perfil DEV.
 *
 * Duas familias, guardadas juntas por empresa:
 *
 *   INTERFACE — qualquer texto que aparece na tela (titulo, menu, botao,
 *   dica, erro). A chave e o PROPRIO TEXTO ORIGINAL: `{ "Salvar": "Gravar" }`.
 *   Assim nao foi preciso mexer nas dezenas de telas — a tela troca o texto
 *   na hora de mostrar (ver `web/src/lib/textos.jsx`). Consequencia pensada:
 *   um texto repetido ("Cancelar") muda em todos os lugares onde aparece.
 *
 *   MENSAGENS — o que o sistema manda sozinho para o CLIENTE no WhatsApp.
 *   Essas nao passam pela tela, entao tem chave propria e texto padrao aqui.
 *
 * So o que foi alterado e guardado: apagar a troca volta ao original.
 */

export const MENSAGENS = [
  {
    chave: 'fila.ia_desligada',
    titulo: 'IA desligada: cliente vai para um atendente',
    padrao: 'Vou chamar um de nossos atendentes pra te ajudar. Um instante! 🙏',
    quando: 'A Sofia está desligada e o cliente escreveu algo que o menu não resolve.'
  },
  {
    chave: 'fila.transferencia',
    titulo: 'Sofia passou o cliente para um atendente',
    padrao: 'Já estou chamando um atendente pra você. Um instante! 🙏',
    quando: 'A Sofia decidiu transferir e não escreveu uma despedida própria.'
  },
  {
    chave: 'fila.ia_falhou',
    titulo: 'IA fora do ar: cliente vai para um atendente',
    padrao: 'Deixa eu chamar um de nossos atendentes pra te ajudar melhor. Um instante! 🙏',
    quando: 'Nenhum provedor de IA respondeu (cota, internet, chave inválida).'
  },
  {
    chave: 'fila.midia_recebida',
    titulo: 'Cliente mandou foto, vídeo ou documento sem texto',
    padrao: 'Recebi! Vou passar para alguém da equipe conferir e já te respondem por aqui. 😊',
    quando: 'Foto, vídeo ou documento (ex.: comprovante de PIX) sem legenda: a IA não vê o arquivo, então vai para um atendente.'
  },
  {
    // {nome} = primeiro nome; {itens} = "Corte Social às 10:00 com Carlos; Barba às 10:30 com Carlos".
    chave: 'lembrete.vespera',
    titulo: 'Lembrete do horário (véspera)',
    padrao: 'Oi, {nome}! Passando para lembrar do seu horário amanhã: {itens}. Se precisar remarcar, é só responder aqui. 😊',
    quando: 'Enviado na véspera, no horário configurado, se o lembrete estiver ligado. {itens} vira "Corte Social às 14:00 com Carlos".'
  },
  {
    // "Um instante" as 23h e uma promessa que ninguem cumpre. {abertura} e
    // trocado no codigo (atendimento.service › avisoDeTransferencia).
    chave: 'fila.fora_do_horario',
    titulo: 'Cliente pediu uma pessoa com a casa fechada',
    padrao: 'Anotei tudo! Nossa equipe está fora do horário agora e volta {abertura}. Assim que abrir, alguém te responde por aqui. 😊',
    quando: 'Transferência para atendente fora do expediente. {abertura} vira, por exemplo, "amanhã às 09:00".'
  }
];

const CHAVE_CONFIG = 'dev.textos';
const CHAVES_MENSAGEM = new Map(MENSAGENS.map((m) => [m.chave, m]));

/** Limites: o mapa vai inteiro para cada tela que abre, entao nao pode crescer sem fim. */
const MAX_TEXTOS = 3000;
const MAX_TAMANHO = 1000;

const cache = new Map(); // tenantId -> { em, valor: { interface, mensagens } }
const VALIDADE_MS = 30_000; // mudanca feita por outro processo vale em ate 30s

async function ler(tenantId) {
  const guardado = cache.get(tenantId);
  if (guardado && Date.now() - guardado.em < VALIDADE_MS) return guardado.valor;
  const linha = await db.query.settings.findFirst({
    where: and(eq(settings.tenantId, tenantId), eq(settings.chave, CHAVE_CONFIG))
  });
  const v = linha?.valor && typeof linha.valor === 'object' ? linha.valor : {};
  const valor = { interface: v.interface ?? {}, mensagens: v.mensagens ?? {} };
  cache.set(tenantId, { em: Date.now(), valor });
  return valor;
}

async function gravar(tenantId, valor) {
  const existe = await db.query.settings.findFirst({
    where: and(eq(settings.tenantId, tenantId), eq(settings.chave, CHAVE_CONFIG))
  });
  if (existe) {
    await db
      .update(settings)
      .set({ valor })
      .where(and(eq(settings.tenantId, tenantId), eq(settings.chave, CHAVE_CONFIG)));
  } else {
    await db.insert(settings).values({
      tenantId,
      chave: CHAVE_CONFIG,
      valor,
      descricao: 'Textos do sistema alterados pelo perfil DEV'
    });
  }
  cache.set(tenantId, { em: Date.now(), valor });
}

/** Espacos extras nao fazem parte da identidade do texto: "  Salvar " e "Salvar". */
const normalizar = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** As trocas de interface, para a tela aplicar. */
export async function trocasDaInterface(tenantId) {
  return (await ler(tenantId)).interface;
}

/**
 * Trocas da tela de login, antes de saber quem esta entrando. Com uma empresa
 * so (o caso de hoje), sao as dela; com varias, a tela de login fica no
 * original — nao ha como saber de qual empresa mostrar.
 */
export async function trocasPublicas() {
  const ativas = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.ativo, true)).limit(2);
  if (ativas.length !== 1) return {};
  return trocasDaInterface(ativas[0].id);
}

/** Texto de uma mensagem automatica ao cliente: o alterado pelo DEV, ou o padrao. */
export async function mensagemAoCliente(tenantId, chave) {
  const def = CHAVES_MENSAGEM.get(chave);
  if (!def) throw new Error(`Mensagem automatica desconhecida: ${chave}`);
  try {
    return (await ler(tenantId)).mensagens[chave] || def.padrao;
  } catch (err) {
    // Sem conseguir ler, o cliente recebe o padrao: nunca fica sem resposta.
    log.warn({ err, tenantId, chave }, 'Falha ao ler mensagem personalizada; usando a padrao');
    return def.padrao;
  }
}

/** Tudo para a pagina DEV. */
export async function listarTextos(tenantId) {
  const v = await ler(tenantId);
  return {
    interface: Object.entries(v.interface)
      .map(([original, novo]) => ({ original, novo }))
      .sort((a, b) => a.original.localeCompare(b.original, 'pt-BR')),
    mensagens: MENSAGENS.map((m) => ({ ...m, texto: v.mensagens[m.chave] ?? null })),
    limites: { maxTextos: MAX_TEXTOS, maxTamanho: MAX_TAMANHO }
  };
}

/** Troca (ou, com `novo` vazio/igual ao original, desfaz) um texto de interface. */
export async function trocarTextoDaInterface(tenantId, { original, novo }) {
  const chave = normalizar(original);
  const valor = normalizar(novo);
  if (!chave) throw new RegraDeNegocio('Informe o texto original.');
  if (chave.length > MAX_TAMANHO || valor.length > MAX_TAMANHO) {
    throw new RegraDeNegocio(`Texto longo demais (maximo ${MAX_TAMANHO} caracteres).`);
  }

  const atual = await ler(tenantId);
  const interfaceNova = { ...atual.interface };

  if (!valor || valor === chave) {
    delete interfaceNova[chave];
  } else {
    // Troca em cadeia (A -> B e B -> C) faria o texto "andar" a cada vez que
    // a tela redesenha. O novo texto nao pode ser o original de outra troca.
    if (Object.hasOwn(interfaceNova, valor)) {
      throw new RegraDeNegocio(`"${valor}" ja e um texto que foi trocado por outro. Escolha um texto diferente.`);
    }
    if (!Object.hasOwn(interfaceNova, chave) && Object.keys(interfaceNova).length >= MAX_TEXTOS) {
      throw new RegraDeNegocio(`Limite de ${MAX_TEXTOS} textos alterados atingido.`);
    }
    interfaceNova[chave] = valor;
  }

  await gravar(tenantId, { ...atual, interface: interfaceNova });
  return listarTextos(tenantId);
}

/** Altera (ou, com texto vazio, volta ao padrao) uma mensagem automatica ao cliente. */
export async function trocarMensagem(tenantId, chave, texto) {
  if (!CHAVES_MENSAGEM.has(chave)) throw new NaoEncontrado('Mensagem');
  const valor = String(texto ?? '').trim();
  if (valor.length > MAX_TAMANHO) throw new RegraDeNegocio(`Mensagem longa demais (maximo ${MAX_TAMANHO} caracteres).`);

  const atual = await ler(tenantId);
  const mensagens = { ...atual.mensagens };
  if (!valor || valor === CHAVES_MENSAGEM.get(chave).padrao) delete mensagens[chave];
  else mensagens[chave] = valor;

  await gravar(tenantId, { ...atual, mensagens });
  return listarTextos(tenantId);
}

/** Desfaz TODAS as trocas de interface de uma vez (as mensagens ficam). */
export async function restaurarInterface(tenantId) {
  const atual = await ler(tenantId);
  await gravar(tenantId, { ...atual, interface: {} });
  return listarTextos(tenantId);
}
