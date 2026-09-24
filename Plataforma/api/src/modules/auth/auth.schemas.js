import { z } from 'zod';
import { CARGOS_VISIVEIS } from '../../db/schema/auth.js';

/**
 * Contratos de entrada das rotas de autenticacao.
 *
 * Validacao acontece na FRONTEIRA: nada entra no sistema sem passar por aqui.
 * Do servico pra dentro, todo dado ja pode ser considerado confiavel — o que
 * elimina a checagem defensiva repetida em cada funcao.
 */

export const senhaSchema = z
  .string()
  .min(8, 'A senha precisa ter pelo menos 8 caracteres.')
  .max(200, 'Senha longa demais.')
  // Limite do scrypt: senhas gigantes viram ataque de negacao de servico,
  // porque cada tentativa consome CPU e memoria do servidor.
  .refine((s) => Buffer.byteLength(s) <= 400, 'Senha longa demais.');

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'O usuario precisa ter pelo menos 3 caracteres.')
  .max(50)
  .regex(/^[a-z0-9._-]+$/, 'Use apenas letras, numeros, ponto, hifen e underline.');

export const loginSchema = z.object({
  username: usernameSchema,
  senha: z.string().min(1, 'Informe a senha.'),
  /** Opcional enquanto houver uma empresa so. */
  empresa: z.string().trim().toLowerCase().optional()
});

export const trocarSenhaSchema = z
  .object({
    senhaAtual: z.string().min(1, 'Informe a senha atual.'),
    novaSenha: senhaSchema
  })
  .refine((d) => d.senhaAtual !== d.novaSenha, {
    message: 'A nova senha precisa ser diferente da atual.',
    path: ['novaSenha']
  });

export const criarUsuarioSchema = z.object({
  username: usernameSchema,
  senha: senhaSchema,
  nome: z.string().trim().min(2, 'Informe o nome completo.').max(120),
  // So os cargos visiveis: o `dev` nao e oferecido, e a mensagem de erro de
  // validacao (que lista as opcoes validas) nao pode revelar que ele existe.
  cargo: z.enum(CARGOS_VISIVEIS).default('atendente'),
  email: z.email('E-mail invalido.').optional().or(z.literal('')),
  telefone: z.string().trim().max(30).optional()
});

/**
 * Edicao de um funcionario pela gerencia. Tudo opcional: vai so o que mudou.
 * `novaSenha` e o "esqueci minha senha" resolvido pelo gerente.
 */
export const editarUsuarioSchema = z
  .object({
    username: usernameSchema.optional(),
    nome: z.string().trim().min(2, 'Informe o nome completo.').max(120).optional(),
    cargo: z.enum(CARGOS_VISIVEIS).optional(),
    email: z.email('E-mail invalido.').optional().or(z.literal('')),
    telefone: z.string().trim().max(30).optional(),
    capacidadeSimultanea: z.number().int().min(1, 'Minimo de 1 conversa.').max(50, 'Maximo de 50 conversas.').optional(),
    ativo: z.boolean().optional(),
    novaSenha: senhaSchema.optional().or(z.literal(''))
  })
  .refine((d) => Object.keys(d).length > 0, 'Envie pelo menos um campo.');

/** O recado que aparece por cima de tudo na tela do atendente. */
export const avisoSchema = z.object({
  mensagem: z.string().trim().min(1, 'Escreva o aviso.').max(500, 'O aviso pode ter ate 500 caracteres.')
});

export const presencaSchema = z.object({
  statusPresenca: z.enum(['online', 'ausente', 'offline'])
});

/** Foto do perfil: uma imagem em data URL, ou `remover: true`. */
export const fotoSchema = z
  .object({
    foto: z.string().startsWith('data:', 'Envie a imagem como data URL.').max(4_500_000).optional(),
    remover: z.boolean().optional()
  })
  .refine((d) => d.foto || d.remover, 'Envie a foto ou peca para remover.');
