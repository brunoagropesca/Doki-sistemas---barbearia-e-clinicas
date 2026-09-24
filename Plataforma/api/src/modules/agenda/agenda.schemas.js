import { z } from 'zod';
import { STATUS_AGENDAMENTO } from '../../db/schema/scheduling.js';

/** Data no calendario local da empresa. */
export const dataSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato AAAA-MM-DD.');

/** Hora no relogio local da empresa. */
export const horaSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use o formato HH:MM (24 horas).');

const itemChecklist = z.object({
  texto: z.string().trim().min(1).max(200),
  feito: z.boolean().default(false)
});

export const listarAgendaSchema = z.object({
  data: dataSchema.optional(),
  dataFim: dataSchema.optional(),
  professionalId: z.string().optional(),
  leadId: z.string().optional(),
  status: z
    .union([z.enum(STATUS_AGENDAMENTO), z.array(z.enum(STATUS_AGENDAMENTO))])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  incluirArquivados: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional()
});

export const horariosLivresSchema = z.object({
  data: dataSchema,
  professionalId: z.string().min(1, 'Escolha o profissional.'),
  serviceId: z.string().min(1, 'Escolha o servico.'),
  antecedenciaMinutos: z.coerce.number().int().nonnegative().max(10080).default(0)
});

export const criarAgendamentoSchema = z.object({
  leadId: z.string().min(1, 'Escolha o cliente.'),
  serviceId: z.string().min(1, 'Escolha o servico.'),
  professionalId: z.string().min(1, 'Escolha o profissional.'),
  data: dataSchema,
  hora: horaSchema,
  status: z.enum(['pendente', 'confirmado']).default('confirmado'),
  precoCentavos: z.number().int().nonnegative().optional(),
  descontoCentavos: z.number().int().nonnegative().default(0),
  observacoes: z.string().max(2000).optional(),
  checklist: z.array(itemChecklist).max(50).optional(),
  /** Sessao de atendimento (conversa) de onde a OS nasceu. */
  conversationId: z.string().optional(),
  /** Encaixe manual: permite marcar fora do expediente (nunca sobre outro cliente). */
  encaixe: z.boolean().default(false),
  /** Lancamento retroativo: registrar um atendimento que ja aconteceu. */
  permitirPassado: z.boolean().default(false)
});

export const remarcarSchema = z
  .object({
    data: dataSchema.optional(),
    hora: horaSchema.optional(),
    professionalId: z.string().optional()
  })
  .refine((d) => d.data || d.hora || d.professionalId, 'Informe o que mudou: data, hora ou profissional.');

export const mudarStatusSchema = z.object({
  status: z.enum(STATUS_AGENDAMENTO),
  motivo: z.string().max(500).optional()
});

export const atualizarDetalhesSchema = z
  .object({
    observacoes: z.string().max(2000).optional(),
    checklist: z.array(itemChecklist).max(50).optional(),
    precoCentavos: z.number().int().nonnegative().optional(),
    descontoCentavos: z.number().int().nonnegative().optional()
  })
  .refine((d) => Object.keys(d).length > 0, 'Envie pelo menos um campo.');

export const arquivarSchema = z.object({
  desfazer: z.boolean().default(false)
});

export const metricasSchema = z.object({
  data: dataSchema.optional(),
  dataFim: dataSchema.optional()
});
