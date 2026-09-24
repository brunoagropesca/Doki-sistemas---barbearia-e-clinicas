import { z } from 'zod';

/** Dados que a propria pessoa pode mudar. Cargo e usuario de login ficam com o admin. */
export const atualizarPerfilSchema = z
  .object({
    nome: z.string().trim().min(2, 'Informe o nome completo.').max(120).optional(),
    email: z.email('E-mail invalido.').optional().or(z.literal('')),
    telefone: z.string().trim().max(30).optional()
  })
  .refine((d) => Object.keys(d).length > 0, 'Nada para atualizar.');

/**
 * O atalho e digitado no meio de uma conversa: so o que cabe numa palavra.
 * A barra do comeco e tirada — muita gente vai cadastrar "/ola" em vez de "ola".
 */
const atalhoSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/^\/+/, ''))
  .pipe(
    z
      .string()
      .min(1, 'Informe o atalho.')
      .max(30, 'Atalho longo demais (até 30 caracteres).')
      .regex(/^[a-z0-9_-]+$/, 'Use só letras sem acento, números, hífen e underline.')
      // "/atena" ja e o comando da Atena no livechat: um atalho com esse nome
      // nunca seria alcancado.
      .refine((s) => s !== 'atena', 'O atalho "atena" é reservado para o comando da Atena.')
  );

export const respostaRapidaSchema = z.object({
  atalho: atalhoSchema,
  texto: z
    .string()
    .trim()
    .min(1, 'Escreva o texto da resposta.')
    .max(4096, 'Texto longo demais para WhatsApp (limite de 4096 caracteres).')
});
