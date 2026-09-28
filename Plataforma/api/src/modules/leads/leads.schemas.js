import { z } from 'zod';

/** Etiqueta: curta, sem aspas (que quebrariam a busca no JSON). */
const tagSchema = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[^"']+$/, 'A etiqueta nao pode conter aspas.');

export const criarLeadSchema = z.object({
  nome: z.string().trim().min(2, 'Informe o nome do contato.').max(120),
  telefone: z.string().trim().min(8, 'Informe o telefone.'),
  email: z.email('E-mail invalido.').optional().or(z.literal('')),
  endereco: z.string().trim().max(200).optional(),
  observacoes: z.string().max(5000).optional(),
  tags: z.array(tagSchema).max(20).optional(),
  responsavelId: z.string().optional(),
  origem: z.string().max(40).optional(),
  aceitaCampanha: z.boolean().optional(),
  iaAtiva: z.boolean().optional()
});

/** Na atualizacao, todo campo e opcional — mas pelo menos um precisa vir. */
export const atualizarLeadSchema = criarLeadSchema
  .partial()
  .refine((d) => Object.keys(d).length > 0, 'Envie pelo menos um campo para atualizar.');

export const listarLeadsSchema = z.object({
  busca: z.string().trim().max(120).optional(),
  tag: tagSchema.optional(),
  responsavelId: z.string().optional(),
  diasInativo: z.coerce.number().int().positive().max(3650).optional(),
  gastoMinimoCentavos: z.coerce.number().int().nonnegative().optional(),

  /**
   * Filtros que olham o HISTORICO, nao o cadastro.
   *
   * Sao eles que respondem as perguntas que valem para campanha: quem chegou
   * esta semana, quem nunca marcou nada, quem some, quem falta. Sem eles a
   * pessoa teria que exportar a lista e filtrar na planilha.
   */
  novosDias: z.coerce.number().int().positive().max(365).optional(),
  semAgendamento: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  minimoConcluidos: z.coerce.number().int().positive().max(1000).optional(),
  comFaltas: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  iaAtiva: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  aceitaCampanha: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  ordem: z.enum(['recentes', 'nome']).default('recentes')
});

export const acaoEmLoteSchema = z
  .object({
    ids: z.array(z.string()).min(1, 'Selecione pelo menos um contato.').max(500),
    adicionarTag: tagSchema.optional(),
    removerTag: tagSchema.optional(),
    aceitaCampanha: z.boolean().optional(),
    iaAtiva: z.boolean().optional()
  })
  .refine(
    (d) =>
      d.adicionarTag ||
      d.removerTag ||
      d.aceitaCampanha !== undefined ||
      d.iaAtiva !== undefined,
    'Escolha o que fazer com os contatos selecionados.'
  );

/**
 * Correcao da memoria da Sofia pela ficha do contato. As listas vem inteiras
 * (a tela edita e apaga item a item); `esquecer` sao fatos de agenda que o
 * atendente mandou a Sofia deixar de lado.
 */
const itemDeMemoria = z.string().trim().min(1).max(80);
export const corrigirMemoriaSchema = z.object({
  preferencias: z.array(itemDeMemoria).max(5).optional(),
  observacoes: z.array(itemDeMemoria).max(3).optional(),
  esquecer: z.array(z.enum(['servicoFrequente', 'profissionalPreferido', 'ultimaVisita'])).max(3).default([])
});
