import { z } from 'zod';
import { apenas } from '../../http/plugins/autenticacao.js';
import * as service from './empresa.service.js';

/**
 * Perfil e base de conhecimento da empresa.
 *
 * Ler e de todo mundo que entra no sistema (o menu mostra o nome e o logo);
 * mudar e de dono e gerente — e o que a IA fala para o cliente.
 */

const texto = (max) => z.string().trim().max(max);
const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora no formato 09:00.');

const baseSchema = z
  .object({
    nome: z.string().trim().min(2, 'Informe o nome da empresa.').max(80),
    logoArquivo: z.string().max(8_000_000).optional(),
    removerLogo: z.boolean().optional(),
    sobre: texto(600),
    endereco: z.object({
      logradouro: texto(160),
      bairro: texto(80),
      cidade: texto(80),
      referencia: texto(160),
      mapaUrl: z.union([z.literal(''), z.string().trim().url('Link do mapa inválido.').max(500)]),
      estacionamento: texto(160)
    }),
    contato: z.object({
      telefone: texto(30),
      whatsapp: texto(30),
      instagram: texto(60),
      site: texto(160),
      email: z.union([z.literal(''), z.string().trim().email('E-mail inválido.').max(120)])
    }),
    pagamento: z.object({
      pix: z.object({
        tipo: z.enum(['cpf', 'cnpj', 'telefone', 'email', 'aleatoria']),
        chave: texto(120),
        titular: texto(120),
        banco: texto(60)
      }),
      formas: z.array(texto(40)).max(12),
      observacao: texto(300)
    }),
    horario: z.object({
      // Chave = dia da semana (0 = domingo). Dia que nao vem = fechado.
      dias: z.record(z.string().regex(/^[0-6]$/, 'Dia da semana invalido.'), z.array(z.object({ inicio: hora, fim: hora })).max(3)),
      observacao: texto(300)
    }),
    politicas: texto(1500),
    faq: z.array(z.object({ pergunta: texto(200), resposta: texto(800) })).max(30),
    extras: texto(2000)
  })
  .partial()
  .strict();

export async function rotasEmpresa(app) {
  /** GET /api/empresa — nome, logo e a base de conhecimento. */
  app.get('/api/empresa', { config: apenas.atendente }, async (req) => {
    return { empresa: await service.obter(req.tenantId) };
  });

  /** PUT /api/empresa — atualiza o que vier (o resto fica como esta). */
  app.put('/api/empresa', { config: apenas.admin, bodyLimit: 10 * 1024 * 1024 }, async (req) => {
    const dados = baseSchema.parse(req.body);
    return { empresa: await service.salvar(req.tenantId, dados, req.usuario) };
  });

  /** GET /api/empresa/texto-ia — exatamente o que a Sofia recebe (previa na tela). */
  app.get('/api/empresa/texto-ia', { config: apenas.admin }, async (req) => {
    return { texto: await service.baseParaIa(req.tenantId) };
  });
}
