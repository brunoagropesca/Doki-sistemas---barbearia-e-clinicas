import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Diario permanente das conexoes (data/logs/conexoes.log). Sem ele, a queda
 * da conexao e o reinicio que derrubaram as fotos do Lyu nao deixaram rastro.
 * Pasta temporaria propria: nada escreve em data/logs.
 */

const diario = await import('../src/core/diario.js');

function pasta() {
  return mkdtempSync(join(tmpdir(), 'diario-'));
}

describe('diario das conexoes', () => {
  it('anota uma linha por evento, com a hora, na ordem', async () => {
    const p = pasta();
    try {
      diario.anotar('AVISO t1 W1 [conexao] Conexão caiu (428: Connection Closed).', { pasta: p, forcar: true, agora: new Date('2026-09-27T14:36:00Z') });
      diario.anotar('SUCESSO t1 W1 [conexao] WhatsApp conectado.', { pasta: p, forcar: true, agora: new Date('2026-09-27T14:36:03Z') });
      await diario.aguardarDiario();
      const linhas = readFileSync(join(p, 'conexoes.log'), 'utf8').trim().split('\n');
      assert.deepEqual(linhas, [
        '2026-09-27T14:36:00.000Z AVISO t1 W1 [conexao] Conexão caiu (428: Connection Closed).',
        '2026-09-27T14:36:03.000Z SUCESSO t1 W1 [conexao] WhatsApp conectado.'
      ]);
    } finally {
      rmSync(p, { recursive: true, force: true });
    }
  });

  it('nos testes, sem forcar, nao escreve (o banco de teste mora na mesma pasta data/)', async () => {
    const p = pasta();
    try {
      diario.anotar('nao deveria aparecer', { pasta: p });
      await diario.aguardarDiario();
      assert.throws(() => readFileSync(join(p, 'conexoes.log')));
    } finally {
      rmSync(p, { recursive: true, force: true });
    }
  });

  it('sabe se o processo anterior desligou direito ou terminou de repente', () => {
    const p = pasta();
    try {
      assert.equal(diario.comoTerminouOAnterior({ pasta: p }), null, 'sem diario: nao sabe');
      diario.anotarAgora('SERVIDOR iniciado · pid 1', { pasta: p, forcar: true });
      assert.equal(diario.comoTerminouOAnterior({ pasta: p }), 'abrupto', 'subiu e nunca registrou a descida');
      diario.anotarAgora('SERVIDOR encerrado · SIGINT', { pasta: p, forcar: true });
      assert.equal(diario.comoTerminouOAnterior({ pasta: p }), 'normal');
    } finally {
      rmSync(p, { recursive: true, force: true });
    }
  });

  it('nunca lanca, mesmo sem conseguir escrever', async () => {
    const p = pasta();
    const arquivoNoLugarDaPasta = join(p, 'nao-e-pasta');
    writeFileSync(arquivoNoLugarDaPasta, 'x');
    try {
      diario.anotar('x', { pasta: arquivoNoLugarDaPasta, forcar: true });
      await diario.aguardarDiario();
      diario.anotarAgora('x', { pasta: arquivoNoLugarDaPasta, forcar: true });
    } finally {
      rmSync(p, { recursive: true, force: true });
    }
  });
});
