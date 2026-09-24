/**
 * Erros da aplicacao.
 *
 * Por que isso existe:
 * no sistema antigo, cada rota fazia `try/catch` e devolvia `{ success:false, error: err.message }`
 * com status 400 pra tudo — inclusive pra "nao encontrado" e "sem permissao".
 * O front nao tinha como distinguir "voce errou o formulario" de "o servidor caiu",
 * e mensagens internas (nome de coluna, SQL) vazavam pro cliente.
 *
 * Aqui cada erro esperado tem um tipo, um status HTTP e um codigo estavel.
 * Qualquer erro que NAO seja um AppError e tratado como bug: vira 500 e a
 * mensagem real so aparece no log do servidor, nunca na resposta.
 */

export class AppError extends Error {
  /**
   * @param {string} message Mensagem segura para mostrar ao usuario final.
   * @param {object} [opts]
   * @param {number} [opts.status] Codigo HTTP.
   * @param {string} [opts.code] Codigo estavel para o front reagir (ex: 'NAO_ENCONTRADO').
   * @param {unknown} [opts.details] Detalhes estruturados (ex: erros de campo).
   * @param {Error}  [opts.cause] Erro original, para o log.
   */
  constructor(message, { status = 500, code = 'ERRO_INTERNO', details, cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    /** Marca que este erro foi previsto — pode ser mostrado ao usuario. */
    this.esperado = true;
  }
}

/** 400 — os dados enviados nao passaram na validacao. */
export class ErroDeValidacao extends AppError {
  constructor(message = 'Dados invalidos.', details) {
    super(message, { status: 400, code: 'VALIDACAO', details });
  }
}

/** 401 — nao esta logado, ou o token expirou. */
export class NaoAutenticado extends AppError {
  constructor(message = 'Voce precisa entrar no sistema para continuar.') {
    super(message, { status: 401, code: 'NAO_AUTENTICADO' });
  }
}

/** 403 — esta logado, mas o cargo dele nao permite essa acao. */
export class SemPermissao extends AppError {
  constructor(message = 'Seu perfil nao tem permissao para esta acao.') {
    super(message, { status: 403, code: 'SEM_PERMISSAO' });
  }
}

/** 404 — o registro nao existe, ou nao pertence a esta empresa. */
export class NaoEncontrado extends AppError {
  constructor(recurso = 'Registro') {
    super(`${recurso} nao encontrado.`, { status: 404, code: 'NAO_ENCONTRADO' });
  }
}

/** 409 — conflito com o estado atual (ex: telefone ja cadastrado, horario ocupado). */
export class Conflito extends AppError {
  constructor(message = 'Esta operacao conflita com um registro existente.', details) {
    super(message, { status: 409, code: 'CONFLITO', details });
  }
}

/** 422 — os dados sao validos, mas a regra de negocio proibe. */
export class RegraDeNegocio extends AppError {
  constructor(message, details) {
    super(message, { status: 422, code: 'REGRA_DE_NEGOCIO', details });
  }
}

/** 429 — chamou demais, rapido demais. */
export class LimiteExcedido extends AppError {
  constructor(message = 'Muitas requisicoes. Tente novamente em instantes.') {
    super(message, { status: 429, code: 'LIMITE_EXCEDIDO' });
  }
}

/** 502 — um servico externo (IA, WhatsApp) falhou. */
export class ServicoIndisponivel extends AppError {
  constructor(message = 'Servico externo indisponivel no momento.', details) {
    super(message, { status: 502, code: 'SERVICO_INDISPONIVEL', details });
  }
}

/**
 * Procura um texto na mensagem do erro E em toda a cadeia de causas.
 *
 * Isto existe por uma pegadinha concreta: o Drizzle embrulha os erros do
 * banco. Quando o SQLite recusa uma insercao duplicada, `err.message` vira
 * `"Failed query: insert into leads..."` — e a mensagem que realmente
 * interessa, `"UNIQUE constraint failed: leads.tenant_id, leads.telefone"`,
 * fica escondida em `err.cause`.
 *
 * Quem procurasse so em `err.message` nunca encontraria, e o erro cairia como
 * falha interna 500 em vez de conflito 409.
 */
export function erroContem(erro, texto) {
  let atual = erro;
  for (let i = 0; i < 5 && atual; i++) {
    if (String(atual.message ?? '').includes(texto)) return true;
    atual = atual.cause;
  }
  return false;
}

/** O banco recusou por violar uma restricao de unicidade? */
export function ehViolacaoDeUnicidade(erro) {
  return erroContem(erro, 'UNIQUE constraint failed');
}

/** O banco recusou por chave estrangeira invalida? */
export function ehViolacaoDeChaveEstrangeira(erro) {
  return erroContem(erro, 'FOREIGN KEY constraint failed');
}

/**
 * Converte um erro do Zod no nosso formato de erro de validacao,
 * com a lista de campos que falharam.
 */
export function deZodError(zodError, message = 'Dados invalidos.') {
  const campos = zodError.issues.map((i) => ({
    campo: i.path.join('.') || '(raiz)',
    mensagem: i.message,
    tipo: i.code
  }));
  return new ErroDeValidacao(message, { campos });
}
