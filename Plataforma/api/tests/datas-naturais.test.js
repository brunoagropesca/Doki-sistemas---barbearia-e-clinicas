import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { interpretarData, rotuloDaData } from '../src/core/datas-naturais.js';

/**
 * O "script" de datas da Atena.
 *
 * Nasceu de um teste real: "quero agendar pra sexta" deixou a Atena em laco,
 * porque as ferramentas so aceitavam AAAA-MM-DD. Hoje fixo (quarta, 23/09/2026)
 * para cada caso ter uma resposta exata.
 */

const HOJE = '2026-09-23'; // quarta-feira
const ler = (expr, hoje = HOJE) => interpretarData(expr, { hoje });

describe('datas como o cliente fala', () => {
  it('dia da semana vira a proxima ocorrencia, com o dia por extenso', () => {
    assert.deepEqual(ler('sexta'), { data: '2026-09-25', dia: 'sexta-feira, 25/09' });
    assert.equal(ler('Sexta-feira').data, '2026-09-25');
    assert.equal(ler('sábado').data, '2026-09-26');
    assert.equal(ler('segunda').data, '2026-09-28');
    assert.equal(ler('domingo').data, '2026-09-27');
  });

  it('o dia da semana de hoje e hoje', () => {
    assert.equal(ler('quarta').data, HOJE);
    assert.match(ler('quarta').dia, /^hoje, quarta-feira/);
  });

  it('"que vem" / "proxima" nunca e hoje e avisa da ambiguidade', () => {
    const r = ler('quarta que vem');
    assert.equal(r.data, '2026-09-30');
    assert.match(r.aviso, /confirme com o cliente/);
    assert.match(ler('próxima sexta').aviso, /02\/10/, 'o aviso mostra a outra possibilidade');
  });

  it('hoje, amanha e depois de amanha', () => {
    assert.equal(ler('hoje').data, HOJE);
    assert.equal(ler('').data, HOJE, 'sem data = hoje, como antes');
    assert.equal(ler('amanhã').data, '2026-09-24');
    assert.equal(ler('amanha').data, '2026-09-24');
    assert.match(ler('amanhã').dia, /^amanhã, quinta-feira, 24\/09$/);
    assert.equal(ler('depois de amanhã').data, '2026-09-25');
    assert.equal(ler('hoje à tarde').data, HOJE);
  });

  it('dia do mes: este mes, ou o proximo se ja passou', () => {
    assert.equal(ler('dia 25').data, '2026-09-25');
    assert.equal(ler('25').data, '2026-09-25');
    assert.equal(ler('dia 5').data, '2026-10-05');
    assert.equal(ler('dia 31').data, '2026-10-31', 'setembro nao tem 31: vai para outubro');
  });

  it('dia e mes, com ou sem ano', () => {
    assert.equal(ler('25/09').data, '2026-09-25');
    assert.equal(ler('3/10').data, '2026-10-03');
    assert.equal(ler('10/01').data, '2027-01-10', 'data ja passada neste ano = ano que vem');
    assert.equal(ler('25/12/2026').data, '2026-12-25');
    assert.equal(ler('25 de dezembro').data, '2026-12-25');
    assert.equal(ler('2026-09-30').data, '2026-09-30');
  });

  it('dia da semana e numero que nao batem: fica o numero, com aviso', () => {
    const r = ler('sexta dia 26');
    assert.equal(r.data, '2026-09-26');
    assert.match(r.aviso, /sábado, não sexta-feira/);
  });

  it('prazos e expressoes vagas', () => {
    assert.equal(ler('daqui a 3 dias').data, '2026-09-26');
    assert.equal(ler('em duas semanas').data, '2026-10-07');
    assert.equal(ler('fim de semana').data, '2026-09-26');
    const semana = ler('semana que vem');
    assert.equal(semana.data, '2026-09-28');
    assert.match(semana.aviso, /Pergunte ao cliente/);
  });

  it('o que nao e data vira erro legivel, nunca uma data chutada', () => {
    assert.ok(ler('xpto').erro);
    assert.ok(ler('posso ter horario').erro, '"ter" (verbo) nao e terca-feira');
    assert.ok(ler('15.30').erro, 'hora com ponto nao e 15 de marco... nem dia 15/30');
    assert.ok(ler('2026-02-30').erro);
  });

  it('virada de ano e de mes', () => {
    assert.equal(ler('dia 2', '2026-12-28').data, '2027-01-02');
    assert.equal(ler('segunda', '2026-12-31').data, '2027-01-04');
  });

  it('rotulo por extenso', () => {
    assert.equal(rotuloDaData('2026-09-27', HOJE), 'domingo, 27/09');
    assert.equal(rotuloDaData(HOJE, HOJE), 'hoje, quarta-feira, 23/09');
  });
});
