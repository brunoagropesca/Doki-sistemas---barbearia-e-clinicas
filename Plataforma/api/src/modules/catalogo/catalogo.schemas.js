import { z } from 'zod';

/**
 * Valor monetario vindo da tela.
 *
 * Aceita tanto o inteiro de centavos (4500) quanto o que a pessoa digitou
 * ("45,90", "R$ 45,90") — e devolve SEMPRE centavos inteiros. A conversao
 * acontece aqui, na fronteira, para que do servico pra dentro nunca exista
 * duvida sobre a unidade.
 */
const centavosSchema = z.union([
  z.number().int().nonnegative(),
  z.string().transform((v, ctx) => {
    try {
      // Import estatico causaria ciclo; a funcao e pequena e pura.
      const limpo = v.trim().replace(/R\$\s*/i, '').replace(/\s/g, '');
      const normalizado =
        limpo.includes(',') && limpo.includes('.') ? limpo.replace(/\./g, '').replace(',', '.')
        : limpo.includes(',') ? limpo.replace(',', '.')
        : limpo;
      const n = Number(normalizado);
      if (!Number.isFinite(n) || n < 0) throw new Error();
      return Math.round(n * 100);
    } catch {
      ctx.addIssue({ code: 'custom', message: `Valor monetario invalido: "${v}".` });
      return z.NEVER;
    }
  })
]);

const vinculoProfissional = z.object({
  professionalId: z.string().min(1),
  /** Nulo/ausente = usa o valor padrao do servico. */
  precoCentavos: centavosSchema.nullish(),
  duracaoMinutos: z.number().int().min(5).max(600).nullish()
});

// --- Servicos ---

export const criarServicoSchema = z.object({
  nome: z.string().trim().min(2, 'Informe o nome do servico.').max(120),
  descricao: z.string().max(1000).optional(),
  categoria: z.string().trim().max(60).default('Geral'),
  duracaoMinutos: z.number().int().min(5, 'A duracao minima e 5 minutos.').max(600),
  intervaloAposMinutos: z.number().int().min(0).max(120).default(0),
  precoCentavos: centavosSchema,
  ativo: z.boolean().default(true),
  profissionais: z.array(vinculoProfissional).max(50).optional()
});

export const atualizarServicoSchema = criarServicoSchema
  .partial()
  .refine((d) => Object.keys(d).length > 0, 'Envie pelo menos um campo.');

export const listarServicosSchema = z.object({
  busca: z.string().trim().max(120).optional(),
  categoria: z.string().trim().max(60).optional(),
  incluirInativos: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
});

// --- Produtos ---

export const criarProdutoSchema = z.object({
  nome: z.string().trim().min(2, 'Informe o nome do produto.').max(120),
  descricao: z.string().max(1000).optional(),
  categoria: z.string().trim().max(60).default('Geral'),
  sku: z.string().trim().max(60).optional(),
  precoCentavos: centavosSchema,
  custoCentavos: centavosSchema.default(0),
  estoque: z.number().int().nonnegative().default(0),
  estoqueMinimo: z.number().int().nonnegative().default(0),
  /** Foto em data URL; o servidor grava o arquivo e guarda so o caminho. */
  foto: z.string().startsWith('data:', 'Envie a imagem como data URL.').max(4_500_000).optional(),
  ativo: z.boolean().default(true)
});

export const atualizarProdutoSchema = criarProdutoSchema
  .partial()
  .extend({ removerFoto: z.boolean().optional() })
  .refine((d) => Object.keys(d).length > 0, 'Envie pelo menos um campo.');

export const listarProdutosSchema = z.object({
  busca: z.string().trim().max(120).optional(),
  categoria: z.string().trim().max(60).optional(),
  incluirInativos: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  apenasEstoqueBaixo: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
});

export const ajustarEstoqueSchema = z.object({
  tipo: z.enum(['entrada', 'saida', 'ajuste', 'perda']),
  quantidade: z.number().int().refine((n) => n !== 0, 'A quantidade nao pode ser zero.'),
  /** Obrigatorio: ajuste sem motivo e caixa sem comprovante. */
  motivo: z.string().trim().min(3, 'Explique o motivo do ajuste.').max(200)
});

export const venderProdutoSchema = z.object({
  productId: z.string().min(1, 'Escolha o produto.'),
  quantidade: z.number().int().positive('A quantidade precisa ser maior que zero.').max(1000),
  leadId: z.string().optional(),
  appointmentId: z.string().optional()
});
