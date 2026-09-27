import { z } from 'zod';
import { ETAPAS_ATENDIMENTO } from '../../db/schema/conversations.js';

export const listarConversasSchema = z.object({
  filtro: z.enum(['ativas', 'todos', 'humano', 'fila', 'sofia', 'minhas', 'bot', 'finalizadas']).default('ativas'),
  busca: z.string().trim().max(120).optional(),
  canal: z.enum(['whatsapp', 'telegram', 'instagram', 'web']).optional(),
  instancia: z.string().trim().max(40).optional(),
  /** Dia (AAAA-MM-DD, no fuso da empresa) em que a conversa foi finalizada. */
  dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato AAAA-MM-DD.').optional(),
  /** So as conversas deste atendente. */
  atendenteId: z.string().trim().max(60).optional(),
  limite: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional()
});

export const listarMensagensSchema = z.object({
  limite: z.coerce.number().int().min(1).max(200).default(100),
  antesDe: z.string().optional()
});

export const responderSchema = z
  .object({
    conteudo: z
      .string()
      .trim()
      // O WhatsApp corta mensagem muito longa; avisar aqui e melhor do que
      // descobrir que o cliente recebeu o texto pela metade.
      .max(4096, 'Mensagem longa demais para WhatsApp (limite de 4096 caracteres).')
      .optional(),
    /**
     * Audio gravado no navegador, como data URL — mesma convencao de
     * `salvarImagem`: o FileReader do navegador ja resolve a codificacao,
     * entao nao ha motivo para trazer multipart so para isto.
     */
    // Mesmo teto de `fotoSchema` (equipe.routes.js): o corpo da requisicao tem
    // limite de 5 MB (app.js); isto deixa folga para o resto do JSON.
    audio: z.string().startsWith('data:', 'Envie o audio como data URL.').max(4_500_000).optional(),
    duracaoSegundos: z.number().positive().max(600).optional(),
    /**
     * Foto, video ou documento. O `conteudo`, se vier junto, vira a legenda —
     * como no proprio WhatsApp. 16 MB de arquivo dao ~21,4 MB em base64.
     */
    anexo: z
      .object({
        dataUrl: z.string().startsWith('data:', 'Envie o arquivo como data URL.').max(22_500_000, 'Arquivo muito grande. O limite é 16 MB.'),
        nome: z.string().max(255).optional()
      })
      .optional()
  })
  // Audio vai sozinho; anexo pode levar legenda; texto puro precisa de texto.
  .refine(
    (d) => {
      const temTexto = Boolean(d.conteudo?.length);
      if (d.audio) return !temTexto && !d.anexo;
      if (d.anexo) return true;
      return temTexto;
    },
    { message: 'Envie um texto, um audio OU um anexo (com legenda opcional).' }
  );

export const transferirSchema = z.object({
  paraUserId: z.string().min(1, 'Escolha o atendente de destino.'),
  motivo: z.string().trim().max(300).optional()
});

export const finalizarSchema = z.object({
  resumo: z.string().trim().max(2000).optional()
});

export const anotacoesSchema = z.object({
  texto: z.string().max(4000, 'Anotacao longa demais.').default('')
});

export const moverEtapaSchema = z.object({
  etapa: z.enum(ETAPAS_ATENDIMENTO)
});

export const metricasConversasSchema = z.object({
  dias: z.coerce.number().int().min(1).max(365).default(7)
});

export const abrirConversaSchema = z.object({
  leadId: z.string().min(1, 'Informe o cliente.'),
  canal: z.string().trim().max(30).default('whatsapp'),
  // false = so procura a conversa aberta; sem ela, devolve `conversa: null`
  // (a tela pergunta antes de iniciar um atendimento novo).
  criar: z.boolean().default(true)
});
