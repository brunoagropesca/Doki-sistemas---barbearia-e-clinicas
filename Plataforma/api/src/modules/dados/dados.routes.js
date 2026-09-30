import { z } from 'zod';
import { apenas } from '../../http/plugins/autenticacao.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import { ultimaRestauracao } from '../../db/restauracao.js';
import {
  agendarRestauracao,
  apagarBackup,
  arquivoDoBackup,
  cancelarRestauracao,
  criarBackup,
  listarBackups,
  restauracaoPendente,
  resumoDoCofre
} from './backups.js';
import { apagarDados, GRUPOS } from './apagar.js';
import { clientesDeExemploAntigos } from './exemplo-antigo.js';

const criarSchema = z.object({ incluirArquivos: z.boolean().default(true) });

const apagarSchema = z.object({
  grupos: z.array(z.string()).min(1, 'Escolha pelo menos um grupo de dados.'),
  // Digitar a palavra e a trava contra o clique distraido: o botao sozinho
  // nao apaga nada.
  confirmacao: z.literal('APAGAR', { error: 'Digite APAGAR para confirmar.' })
});

/**
 * Sempre no banco de VERDADE, mesmo com a demonstracao ligada no navegador:
 * backup, restauracao e limpeza falam do arquivo da empresa.
 */
const SO_REAL = { ...apenas.dev, bancoReal: true };

/** Backups e limpeza de dados: so o perfil DEV (as rotas nao existem para os outros). */
export async function rotasDados(app) {
  app.get('/api/dev/backups', { config: SO_REAL }, async () => ({
    // Instalacao antiga com os clientes de exemplo do seed velho (so aviso).
    clientesDeExemplo: await clientesDeExemploAntigos(),
    backups: listarBackups(),
    // As fotos e audios de TODOS os backups, uma copia so de cada.
    cofre: resumoDoCofre(),
    restauracaoPendente: restauracaoPendente(),
    ultimaRestauracao: ultimaRestauracao(),
    grupos: GRUPOS
  }));

  app.post('/api/dev/backups', { config: SO_REAL }, async (req, res) => {
    const { incluirArquivos } = criarSchema.parse(req.body ?? {});
    const backup = await criarBackup({ motivo: 'manual', incluirArquivos, por: req.usuario.nome });
    res.status(201);
    return { backup };
  });

  app.get('/api/dev/backups/:id/baixar', { config: SO_REAL }, async (req, res) => {
    const { stream, tamanho, nome } = arquivoDoBackup(req.params.id);
    res.header('content-type', 'application/octet-stream');
    res.header('content-disposition', `attachment; filename="${nome}"`);
    // Backup compactado e descompactado no caminho: o tamanho final so se sabe no fim.
    if (tamanho != null) res.header('content-length', String(tamanho));
    return stream;
  });

  app.delete('/api/dev/backups/:id', { config: SO_REAL }, async (req) => apagarBackup(req.params.id));

  /** Agenda a restauracao para o proximo inicio do sistema. */
  app.post('/api/dev/backups/:id/restaurar', { config: SO_REAL }, async (req) => {
    const pedido = await agendarRestauracao(req.params.id, { por: req.usuario.nome });
    await registrarAuditoria({
      tenantId: req.tenantId,
      usuario: req.usuario,
      acao: 'backup.agendar_restauracao',
      entidade: 'backup',
      entidadeId: req.params.id
    });
    return { restauracaoPendente: pedido };
  });

  app.delete('/api/dev/backups-restauracao', { config: SO_REAL }, async () => cancelarRestauracao());

  /** Apaga grupos de dados da empresa (com backup automatico antes). */
  app.post('/api/dev/dados/apagar', { config: SO_REAL }, async (req) => {
    const { grupos } = apagarSchema.parse(req.body);
    const resultado = await apagarDados(req.tenantId, grupos, { usuario: req.usuario });
    // Registrado DEPOIS de apagar: se "registros" estava na lista, esta linha
    // e a primeira da auditoria nova — e diz o que aconteceu com a antiga.
    await registrarAuditoria({
      tenantId: req.tenantId,
      usuario: req.usuario,
      acao: 'dados.apagar',
      entidade: 'dados',
      dados: { grupos, backup: resultado.backup, apagados: resultado.apagados }
    });
    return resultado;
  });
}
