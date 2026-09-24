import fp from 'fastify-plugin';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { apenas } from '../http/plugins/autenticacao.js';
import { registrarAuditoria } from '../modules/auditoria/auditoria.service.js';
import { ativarSerial, estadoDaLicenca, licencaBloqueada } from './licenca.js';

/**
 * O que continua funcionando com a licenca travada: entrar e sair, ver a
 * propria licenca e ativar um serial novo, e os textos da tela (a tela de
 * bloqueio tambem e traduzida). Todo o resto responde 402.
 */
const LIBERADAS = ['/api/auth/', '/api/licenca', '/api/textos'];

/**
 * Trava global: registrada DEPOIS do plugin de autenticacao, entao ja sabe
 * quem esta pedindo. O DEV passa sempre — e ele quem destrava e faz backup.
 */
async function trava(app) {
  app.addHook('onRequest', async (req) => {
    const rota = req.routeOptions?.url;
    if (!rota || !rota.startsWith('/api/')) return;
    if (LIBERADAS.some((l) => rota.startsWith(l))) return;
    if (req.usuario?.cargo === 'dev') return;
    if (!licencaBloqueada()) return;
    throw new AppError('Licenca do sistema vencida ou ausente. Fale com o fornecedor para renovar.', {
      status: 402,
      code: 'LICENCA_BLOQUEADA'
    });
  });
}
export const pluginTravaDeLicenca = fp(trava, { name: 'trava-licenca', dependencies: ['autenticacao'] });

const ativarSchema = z.object({ serial: z.string().trim().min(10, 'Cole o serial inteiro.').max(2000) });

export async function rotasLicenca(app) {
  /** GET /api/licenca — situacao, validade e o codigo desta instalacao. */
  app.get('/api/licenca', { config: apenas.atendente }, async () => ({ licenca: estadoDaLicenca() }));

  /** POST /api/licenca/ativar — cola o serial (renovacao do mes ou permanente). Dono ou DEV. */
  app.post('/api/licenca/ativar', { config: apenas.owner }, async (req) => {
    const { serial } = ativarSchema.parse(req.body);
    const licenca = ativarSerial(serial, { por: req.usuario.nome });
    await registrarAuditoria({
      tenantId: req.tenantId,
      usuario: req.usuario,
      acao: 'licenca.ativar',
      entidade: 'licenca',
      dados: { tipo: licenca.tipo, validoAte: licenca.validoAte }
    });
    return { licenca };
  });
}
