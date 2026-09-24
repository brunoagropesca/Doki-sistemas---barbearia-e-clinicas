import { z } from 'zod';
import { comContexto } from '../../core/logger.js';

const log = comContexto({ modulo: 'ia-ferramentas' });

/**
 * Ferramentas que a IA pode acionar.
 *
 * ISTO SUBSTITUI A "BIBLIOTECARIA ATENA" DO SISTEMA ANTIGO.
 *
 * La, a consulta ao banco era decidida por uma cadeia de `if` sobre palavras
 * soltas na mensagem:
 *
 *     if (msg.includes('preco') || msg.includes('quanto') || msg.includes('corte'))
 *
 * Isso falhava dos dois lados. "Quanto tempo voces ficam abertos?" disparava
 * a consulta de precos por causa do "quanto". "Quero dar um trato no visual"
 * nao disparava nada, porque nenhuma palavra da lista aparecia. E a mesma
 * lista estava duplicada em dois arquivos, com conteudos diferentes.
 *
 * Aqui quem decide qual ferramenta usar e o modelo, que entende a frase
 * inteira. Cada ferramenta declara o que faz e quais argumentos aceita; os
 * argumentos sao validados com Zod antes de executar.
 *
 * O ponto importante: a EXECUCAO continua deterministica. O modelo escolhe
 * "consultar_horarios" e com quais parametros — mas quem responde qual
 * horario esta livre e o banco, pelo mesmo calculo que a tela usa. O modelo
 * nunca inventa preco nem horario porque nunca e ele quem os produz.
 */

/** Converte um schema Zod na descricao que os provedores entendem. */
export function zodParaJsonSchema(schema) {
  const forma = schema._def?.shape ?? schema.shape;
  if (!forma) return { type: 'object', properties: {} };

  const properties = {};
  const required = [];

  for (const [nome, campo] of Object.entries(typeof forma === 'function' ? forma() : forma)) {
    const { json, obrigatorio } = descreverCampo(campo);
    properties[nome] = json;
    if (obrigatorio) required.push(nome);
  }

  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function descreverCampo(campo) {
  let atual = campo;
  let obrigatorio = true;
  let descricao = atual.description;

  // Desembrulha optional/default/nullable ate achar o tipo de verdade.
  for (let i = 0; i < 10; i++) {
    const tipo = atual._def?.typeName ?? atual._def?.type;
    if (tipo === 'ZodOptional' || tipo === 'optional' || tipo === 'ZodDefault' || tipo === 'default' || tipo === 'ZodNullable' || tipo === 'nullable') {
      obrigatorio = false;
      atual = atual._def.innerType ?? atual._def.type;
      descricao = descricao ?? atual?.description;
    } else {
      break;
    }
  }

  const tipo = atual?._def?.typeName ?? atual?._def?.type;
  const base = descricao ? { description: descricao } : {};

  switch (tipo) {
    case 'ZodString':
    case 'string':
      return { json: { type: 'string', ...base }, obrigatorio };
    case 'ZodNumber':
    case 'number':
      return { json: { type: 'number', ...base }, obrigatorio };
    case 'ZodBoolean':
    case 'boolean':
      return { json: { type: 'boolean', ...base }, obrigatorio };
    case 'ZodEnum':
    case 'enum': {
      const valores = atual._def.values ?? atual._def.entries;
      return { json: { type: 'string', enum: Array.isArray(valores) ? valores : Object.values(valores ?? {}), ...base }, obrigatorio };
    }
    case 'ZodArray':
    case 'array':
      return { json: { type: 'array', items: { type: 'string' }, ...base }, obrigatorio };
    default:
      return { json: { type: 'string', ...base }, obrigatorio };
  }
}

/**
 * Cria uma ferramenta.
 *
 * @param {object} def
 * @param {string} def.nome        como o modelo a chama
 * @param {string} def.descricao   o que ela faz — e o que o modelo le pra decidir
 * @param {z.ZodObject} def.argumentos
 * @param {(args, contexto) => Promise<any>} def.executar
 * @param {boolean} [def.escrita]  true quando ela MUDA dados
 */
export function definirFerramenta({ nome, descricao, argumentos, executar, escrita = false }) {
  return {
    nome,
    descricao,
    escrita,
    argumentos,
    parametros: zodParaJsonSchema(argumentos),
    executar
  };
}

/**
 * Executa uma ferramenta pedida pelo modelo.
 *
 * Nunca lanca: uma falha vira um resultado de erro que volta para o modelo,
 * que entao explica a situacao ao cliente com as proprias palavras. Se
 * lancasse, o atendimento inteiro morreria porque uma consulta deu errado.
 */
export async function executarFerramenta(ferramentas, chamada, contexto) {
  const ferramenta = ferramentas.find((f) => f.nome === chamada.nome);

  if (!ferramenta) {
    log.warn({ nome: chamada.nome }, 'Modelo pediu uma ferramenta que nao existe');
    return { erro: `A ferramenta "${chamada.nome}" nao existe.` };
  }

  // Os argumentos vem de um modelo de linguagem — tratamos como entrada de
  // usuario, nao como dado confiavel.
  const validacao = ferramenta.argumentos.safeParse(chamada.argumentos ?? {});
  if (!validacao.success) {
    const problemas = validacao.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`);
    log.warn({ nome: chamada.nome, problemas }, 'Modelo chamou ferramenta com argumentos invalidos');
    return { erro: `Argumentos invalidos: ${problemas.join('; ')}` };
  }

  try {
    const resultado = await ferramenta.executar(validacao.data, contexto);
    log.debug({ nome: chamada.nome }, 'Ferramenta executada');
    return resultado;
  } catch (err) {
    log.error({ err, nome: chamada.nome }, 'Ferramenta falhou');
    // A mensagem tecnica NAO volta pro modelo (e daí para o cliente).
    return { erro: err.esperado ? err.message : 'Nao consegui consultar essa informacao agora.' };
  }
}
