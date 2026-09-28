import { z } from 'zod';
import { apenas } from '../../http/plugins/autenticacao.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import { ultimaRestauracao } from '../../db/restauracao.js';
import {
  agendarRestauracao,
  apagarBackupManual,
  arquivoDoBackup,
  cancelarRestauracao,
  criarBackup,
  listarBackups,
  restauracaoPendente,
  resumoDoCofre
} from './backups.js';
import { copiarParaExterna, definirPasta, lerCopiaExterna, testarPasta } from './copia-externa.js';
import { usoDoDisco } from './armazenamento.js';

/**
 * Backups e armazenamento — a pagina do DONO.
 *
 * Antes so o perfil DEV fazia backup e restaurava (/api/dev/backups, que
 * continua igual). O dono e quem perde se o computador morrer: ele precisa
 * ver o ultimo backup, fazer um agora, baixar, restaurar e mandar uma copia
 * para fora do computador. "Apagar dados" continua so do DEV.
 *
 * Sempre no banco REAL (como as do DEV): backup e restauracao falam do arquivo
 * da empresa, mesmo com a demonstracao ligada no navegador.
 */
const DONO = { ...apenas.owner, bancoReal: true };

const criarSchema = z.object({ incluirArquivos: z.boolean().default(true) });
// Digitar a palavra e a trava contra o clique distraido: restaurar volta o
// sistema inteiro para outro dia.
const restaurarSchema = z.object({
  confirmacao: z.literal('RESTAURAR', { error: 'Digite RESTAURAR para confirmar.' })
});
const pastaSchema = z.object({ pasta: z.string().trim().max(500).nullable() });

const auditar = (req, acao, entidadeId = null, dados = {}) =>
  registrarAuditoria({ tenantId: req.tenantId, usuario: req.usuario, acao, entidade: 'backup', entidadeId, dados });

function panorama() {
  const backups = listarBackups();
  return {
    backups,
    cofre: resumoDoCofre(),
    restauracaoPendente: restauracaoPendente(),
    ultimaRestauracao: ultimaRestauracao(),
    armazenamento: usoDoDisco({ ultimoBackupEm: backups[0]?.criadoEm ?? null })
  };
}

export async function rotasBackupsDoDono(app) {
  app.get('/api/backups', { config: DONO }, async () => panorama());

  app.post('/api/backups', { config: DONO }, async (req, res) => {
    const { incluirArquivos } = criarSchema.parse(req.body ?? {});
    const backup = await criarBackup({ motivo: 'manual', incluirArquivos, por: req.usuario.nome });
    await auditar(req, 'backup.criar', backup.id, { incluirArquivos });
    res.status(201);
    return { backup };
  });

  app.get('/api/backups/:id/baixar', { config: DONO }, async (req, res) => {
    const { stream, tamanho, nome } = arquivoDoBackup(req.params.id);
    await auditar(req, 'backup.baixar', req.params.id);
    res.header('content-type', 'application/octet-stream');
    res.header('content-disposition', `attachment; filename="${nome}"`);
    if (tamanho != null) res.header('content-length', String(tamanho));
    return stream;
  });

  app.delete('/api/backups/:id', { config: DONO }, async (req) => {
    const r = apagarBackupManual(req.params.id);
    await auditar(req, 'backup.apagar', req.params.id);
    return r;
  });

  /** Agenda a restauracao para o proximo inicio (o estado de agora vira um backup de seguranca). */
  app.post('/api/backups/:id/restaurar', { config: DONO }, async (req) => {
    restaurarSchema.parse(req.body ?? {});
    const pedido = await agendarRestauracao(req.params.id, { por: req.usuario.nome });
    await auditar(req, 'backup.agendar_restauracao', req.params.id, { backupDeSeguranca: pedido.backupDeSeguranca });
    return { restauracaoPendente: pedido };
  });

  app.delete('/api/backups-restauracao', { config: DONO }, async (req) => {
    const r = cancelarRestauracao();
    await auditar(req, 'backup.cancelar_restauracao');
    return r;
  });

  // --- Copia fora do computador ---

  app.get('/api/backups/copia-externa', { config: DONO }, async () => ({ copiaExterna: lerCopiaExterna() }));

  app.put('/api/backups/copia-externa', { config: DONO }, async (req) => {
    const { pasta } = pastaSchema.parse(req.body ?? {});
    const copiaExterna = definirPasta(pasta);
    await auditar(req, 'backup.copia_externa_pasta', null, { pasta: copiaExterna.pasta });
    return { copiaExterna };
  });

  /** So confere a pasta (nao grava nada alem do arquivo de teste, que e apagado). */
  app.post('/api/backups/copia-externa/testar', { config: DONO }, async (req) => {
    const { pasta } = pastaSchema.parse(req.body ?? {});
    return testarPasta(pasta);
  });

  /** Copia agora (sem esperar o proximo backup). */
  app.post('/api/backups/copia-externa/agora', { config: DONO }, async (req) => {
    const r = copiarParaExterna();
    await auditar(req, 'backup.copia_externa', null, { ok: r.ok, erro: r.erro ?? null, bytes: r.bytesCopiados ?? 0 });
    return { resultado: r, copiaExterna: lerCopiaExterna() };
  });
}
