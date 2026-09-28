import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Arquivos orfaos: o que esta em uploads e nada no banco cita.
 *
 * Pastas TEMPORARIAS do sistema (a de uploads e lida no import do modulo de
 * arquivos, por isso e trocada antes dos imports dinamicos). Nomes proprios
 * ("orf-...") e cliente com telefone proprio.
 */

const raiz = mkdtempSync(join(tmpdir(), 'orfaos-'));
const uploads = join(raiz, 'uploads');
const backupsDir = join(raiz, 'backups');
mkdirSync(uploads, { recursive: true });
process.env.PASTA_ARQUIVOS = uploads;

let app;
let env;
let db;
let s;
let tenantId;
let o; // modulo de orfaos

const DOIS_DIAS = 2 * 24 * 3_600_000;
const existe = (nome) => existsSync(join(uploads, nome));
/** Grava um arquivo com a data de modificacao `idadeMs` atras. */
function gravar(nome, idadeMs = DOIS_DIAS) {
  const caminho = join(uploads, nome);
  writeFileSync(caminho, `conteudo de ${nome}`);
  const quando = new Date(Date.now() - idadeMs);
  utimesSync(caminho, quando, quando);
}

before(async () => {
  ({ env } = await import('../src/config/env.js'));
  env.BACKUP_DIR = backupsDir;
  const { criarAppDeTeste } = await import('./helpers/ambiente.js');
  ({ app } = await criarAppDeTeste());
  ({ db } = await import('../src/db/client.js'));
  s = await import('../src/db/schema/index.js');
  [{ id: tenantId }] = await db.select().from(s.tenants);
  o = await import('../src/modules/dados/orfaos.js');
});

after(async () => {
  await app?.close();
  // No Windows o libsql solta o arquivo do banco so depois do GC: se a pasta
  // temporaria ainda estiver presa, fica para o sistema limpar (e do temp).
  try {
    rmSync(raiz, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* pasta temporaria do sistema */
  }
});

describe('o que sai e o que fica', () => {
  it('citado fica; orfao antigo sai; orfao recente fica; citado so num JSON de settings fica', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const lead = await leads.encontrarOuCriarPorTelefone(tenantId, '5592900066001', 'Cliente Orfaos');
    const { eq } = await import('drizzle-orm');
    await db.update(s.leads).set({ fotoUrl: '/api/arquivos/orf-lead.jpg' }).where(eq(s.leads.id, lead.id));
    await db.insert(s.settings).values({ tenantId, chave: 'orf.teste', valor: { logo: '/api/arquivos/orf-logo.png' } });

    gravar('orf-lead.jpg');
    gravar('orf-logo.png');
    gravar('orf-velho.ogg');
    gravar('orf-novo.ogg', 60_000); // gravado ha 1 minuto: pode estar em andamento

    // O cofre dos backups nunca e tocado.
    mkdirSync(join(backupsDir, '_midia'), { recursive: true });
    writeFileSync(join(backupsDir, '_midia', 'orf-velho.ogg'), 'copia do backup');

    const r = await o.limparOrfaos();
    assert.deepEqual(r.nomes, ['orf-velho.ogg']);
    assert.ok(existe('orf-lead.jpg'), 'citado numa coluna');
    assert.ok(existe('orf-logo.png'), 'citado so num JSON de settings');
    assert.ok(existe('orf-novo.ogg'), 'recente: carencia de 24 h');
    assert.ok(!existe('orf-velho.ogg'));
    assert.ok(existsSync(join(backupsDir, '_midia', 'orf-velho.ogg')), 'cofre intacto');
  });

  it('acha citacao em qualquer coluna de texto (metadados de mensagem, por exemplo)', async () => {
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const leads = await import('../src/modules/leads/leads.service.js');
    const lead = await leads.encontrarOuCriarPorTelefone(tenantId, '5592900066002', 'Cliente Orfaos 2');
    const conversationId = await conversas.encontrarOuAbrir(tenantId, { leadId: lead.id });
    const repo = await import('../src/modules/conversas/conversas.repo.js');
    await repo.registrarMensagem(tenantId, conversationId, {
      direcao: 'entrada',
      autorTipo: 'lead',
      tipo: 'texto',
      conteudo: 'oi',
      metadados: { anexoAntigo: '/api/arquivos/orf-meta.pdf' }
    });
    gravar('orf-meta.pdf');
    await o.limparOrfaos();
    assert.ok(existe('orf-meta.pdf'));
  });
});

describe('limpeza semanal', () => {
  it('a primeira vez so marca a data; a limpeza de verdade vem 7 dias depois', async () => {
    gravar('orf-semanal.ogg');
    const agora = Date.now();
    assert.equal(await o.limparOrfaosSeForHora({ agora }), null, '1a vez: so marca');
    assert.ok(existe('orf-semanal.ogg'), 'nada apagado de surpresa');
    assert.equal(await o.limparOrfaosSeForHora({ agora: agora + 3 * 24 * 3_600_000 }), null, 'antes de 7 dias');

    let registrado = null;
    const r = await o.limparOrfaosSeForHora({
      agora: agora + 8 * 24 * 3_600_000,
      aoLimpar: async (x) => {
        registrado = x;
      }
    });
    assert.ok(r.nomes.includes('orf-semanal.ogg'));
    assert.ok(!existe('orf-semanal.ogg'));
    assert.equal(registrado.apagados, r.apagados, 'avisa para a auditoria');
    const estado = JSON.parse(readFileSync(join(raiz, 'limpeza-orfaos.json'), 'utf8'));
    assert.equal(estado.apagados, r.apagados);
  });
});

describe('"Apagar dados" leva os arquivos junto', () => {
  it('a foto do cliente e o audio da conversa saem na hora (sem carencia); o resto fica; o backup os guardou', async () => {
    const leads = await import('../src/modules/leads/leads.service.js');
    const conversas = await import('../src/modules/conversas/conversas.service.js');
    const repo = await import('../src/modules/conversas/conversas.repo.js');
    const { eq } = await import('drizzle-orm');

    const lead = await leads.encontrarOuCriarPorTelefone(tenantId, '5592900066003', 'Cliente Apagado');
    await db.update(s.leads).set({ fotoUrl: '/api/arquivos/orf-apagar-foto.jpg' }).where(eq(s.leads.id, lead.id));
    const conversationId = await conversas.encontrarOuAbrir(tenantId, { leadId: lead.id });
    await repo.registrarMensagem(tenantId, conversationId, {
      direcao: 'entrada',
      autorTipo: 'lead',
      tipo: 'audio',
      conteudo: 'oi',
      midiaUrl: '/api/arquivos/orf-apagar-audio.ogg'
    });
    gravar('orf-apagar-foto.jpg', 0); // recem-criados: mesmo assim saem
    gravar('orf-apagar-audio.ogg', 0);
    gravar('orf-alheio.png', 0); // orfao recente que NAO era deste apagar: fica

    const { apagarDados } = await import('../src/modules/dados/apagar.js');
    const r = await apagarDados(tenantId, ['atendimento']);

    assert.ok(!existe('orf-apagar-foto.jpg'));
    assert.ok(!existe('orf-apagar-audio.ogg'));
    assert.ok(existe('orf-alheio.png'), 'so sai o que perdeu o registro neste apagar');
    assert.ok(existe('orf-logo.png'), 'citado em settings, que nao e apagado');
    assert.ok(r.apagados.arquivos >= 2);

    const cofre = join(backupsDir, '_midia');
    assert.ok(existsSync(join(cofre, 'orf-apagar-foto.jpg')), 'o backup de antes guardou a foto');
    assert.ok(existsSync(join(cofre, 'orf-apagar-audio.ogg')));
  });
});
