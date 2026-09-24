import { z } from 'zod';
import { apenas } from '../../http/plugins/autenticacao.js';
import { relatorio } from './analises.service.js';
import { planilhaDoDashboard } from './exportar.js';

/**
 * Dashboard do dono. So o dono (e o DEV) ve: faturamento, desempenho de cada
 * profissional e custo da IA nao sao assunto do balcao.
 */

// Formato E data que existe: "2026-02-31" passa na regex, mas nao no calendario.
const data = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD.')
  .refine((s) => {
    const d = new Date(`${s}T12:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Essa data não existe no calendário.');
const filtrosSchema = z.object({
  de: data.optional(),
  ate: data.optional(),
  dias: z.coerce.number().int().min(1).max(400).optional()
});

export async function rotasAnalises(app) {
  /** GET /api/analises?dias=30  ou  ?de=2026-09-01&ate=2026-09-30 */
  app.get('/api/analises', { config: apenas.owner }, async (req) => {
    return relatorio(req.tenantId, filtrosSchema.parse(req.query ?? {}));
  });

  /** GET /api/analises/exportar?(mesmos filtros) -> planilha do Excel (.xlsx). */
  app.get('/api/analises/exportar', { config: apenas.owner }, async (req, res) => {
    const { buffer, nomeArquivo } = await planilhaDoDashboard(req.tenantId, filtrosSchema.parse(req.query ?? {}));
    res.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.header('content-disposition', `attachment; filename="${nomeArquivo}"`);
    res.header('cache-control', 'no-store');
    return res.send(buffer);
  });
}
