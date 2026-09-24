import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planejarSequencia } from '../src/modules/agenda/sequencia.js';
import { instanteDeLocal } from '../src/core/datetime.js';

/**
 * Varios servicos na mesma visita, em sequencia — a conta pura.
 *
 * No teste real "quero os 3" virou um agendamento so e dois recusados. Aqui
 * provamos que a conta encaixa um depois do outro, respeita agenda, folga e
 * profissional, e que nao inventa encaixe quando nao existe.
 */

const FUSO = 'America/Sao_Paulo';
const DATA = '2030-01-07'; // uma segunda-feira no futuro: nada de "horario que ja passou"
const AGORA = instanteDeLocal('2030-01-01', '00:00', FUSO);

const jornada = (inicio = '09:00', fim = '18:00') => ({ dias: { 1: [{ inicio, fim }] }, intervaloMinutos: 30 });
const as = (hora) => instanteDeLocal(DATA, hora, FUSO);

const prof = (id, extra = {}) => ({
  id,
  nome: id,
  jornada: jornada(),
  duracaoMinutos: 30,
  precoCentavos: 1000,
  ocupados: [],
  bloqueios: [],
  ...extra
});
const etapa = (nome, candidatos, folgaMinutos = 0) => ({ servico: { id: nome, nome, folgaMinutos }, candidatos });

const planejar = (etapas, extra = {}) =>
  planejarSequencia({ data: DATA, fuso: FUSO, etapas, agora: AGORA, maxOpcoes: 100, ...extra });

describe('planejar servicos em sequencia', () => {
  it('o segundo comeca quando o primeiro termina, com o mesmo profissional', () => {
    const carlos = prof('Carlos');
    const r = planejar([etapa('Corte', [carlos]), etapa('Barba', [carlos])], { horaDesejada: '09:00' });

    assert.equal(r.opcoes.length, 1);
    const [o] = r.opcoes;
    assert.deepEqual(o.itens.map((i) => [i.servico, i.hora, i.termina]), [['Corte', '09:00', '09:30'], ['Barba', '09:30', '10:00']]);
    assert.equal(o.totalCentavos, 2000);
  });

  /**
   * O caso do Lyu: agenda vazia, mas a consulta dizia "nada em 14 dias". A
   * Descoloracao tem 5 min de limpeza; o Gin (so o Alexandre faz) nao podia
   * comecar colado. Agora espera os 5 min.
   */
  it('a folga do profissional vira uma espera curta, nao um "nao cabe"', () => {
    const alexandre = prof('Alexandre');
    const abestalhada = prof('Abestalhada');
    const r = planejar(
      [
        etapa('Descoloração', [{ ...alexandre, duracaoMinutos: 150 }], 5),
        etapa('Gin', [{ ...alexandre, duracaoMinutos: 5 }]),
        etapa('Limpeza', [{ ...abestalhada, duracaoMinutos: 15 }], 5)
      ],
      { horaDesejada: '12:00' }
    );

    assert.equal(r.opcoes.length, 1);
    assert.deepEqual(
      r.opcoes[0].itens.map((i) => [i.servico, i.hora]),
      [['Descoloração', '12:00'], ['Gin', '14:35'], ['Limpeza', '14:40']]
    );
    assert.equal(r.opcoes[0].esperaMinutos, 5);
  });

  it('sem precisar esperar, nao espera: outro profissional livre na hora entra colado', () => {
    const carlos = prof('Carlos');
    const julia = prof('Julia');
    const r = planejar([etapa('Degrade', [carlos], 10), etapa('Barba', [carlos, julia])], { horaDesejada: '09:00' });
    assert.equal(r.opcoes[0].itens[1].profissional, 'Julia');
    assert.equal(r.opcoes[0].itens[1].hora, '09:30');
    assert.equal(r.opcoes[0].esperaMinutos, undefined);
  });

  it('espera no maximo 30 minutos: mais que isso nao e a mesma visita', () => {
    const carlos = prof('Carlos');
    const pedido = [etapa('Degrade', [carlos], 45), etapa('Barba', [carlos])];
    const r = planejar(pedido, { horaDesejada: '09:00', permitirOutraOrdem: false });
    assert.equal(r.opcoes.length, 0, 'a barba so poderia comecar 45 min depois');

    const r2 = planejar(pedido, { horaDesejada: '09:00', esperaMaxMinutos: 60, permitirOutraOrdem: false });
    assert.equal(r2.opcoes[0].itens[1].hora, '10:15', 'com um limite maior, cabe');

    // E o que o planejador faz de verdade: a barba primeiro (sem limpeza
    // depois) e o degrade em seguida — sem espera nenhuma.
    const r3 = planejar(pedido, { horaDesejada: '09:00' });
    assert.equal(r3.opcoes[0].ordemTrocada, true);
    assert.deepEqual(r3.opcoes[0].itens.map((i) => [i.servico, i.hora]), [['Barba', '09:00'], ['Degrade', '09:30']]);
  });

  it('pula para outro profissional quando quem atendeu esta ocupado', () => {
    const carlos = prof('Carlos', { ocupados: [{ inicio: as('09:30'), fim: as('10:00') }] });
    const julia = prof('Julia');
    const r = planejar([etapa('Corte', [carlos]), etapa('Barba', [carlos, julia])], { horaDesejada: '09:00' });

    assert.deepEqual(r.opcoes[0].itens.map((i) => i.profissional), ['Carlos', 'Julia']);
  });

  it('volta atras (backtracking) quando o primeiro encaixe impede o ultimo', () => {
    // C so o Carlos faz, e ele esta ocupado das 10:00 as 11:00. Se o Carlos
    // fizer B (com 60 min de limpeza), C nao cabe nem esperando 30 min.
    // A resposta certa e a Julia fazer B.
    const carlos = prof('Carlos', { ocupados: [{ inicio: as('10:00'), fim: as('11:00') }] });
    const julia = prof('Julia');
    const r = planejar(
      [etapa('A', [carlos]), etapa('B', [carlos, julia], 60), etapa('C', [carlos])],
      { horaDesejada: '11:00' }
    );
    assert.deepEqual(r.opcoes[0].itens.map((i) => i.profissional), ['Carlos', 'Julia', 'Carlos']);
    assert.deepEqual(r.opcoes[0].itens.map((i) => i.hora), ['11:00', '11:30', '12:00']);
  });

  it('se a ordem pedida nao cabe no dia, tenta outra — e avisa', () => {
    // A Abestalhada so trabalha das 09:00 as 10:00. Descoloracao primeiro
    // (09:00-11:30) deixa a limpeza para depois do expediente dela.
    const alexandre = prof('Alexandre', { duracaoMinutos: 150 });
    const abestalhada = prof('Abestalhada', { jornada: jornada('09:00', '10:00'), duracaoMinutos: 15 });
    const r = planejar([etapa('Descoloração', [alexandre]), etapa('Limpeza', [abestalhada])]);

    assert.ok(r.opcoes.length > 0);
    const [o] = r.opcoes;
    assert.equal(o.ordemTrocada, true);
    assert.deepEqual(o.itens.map((i) => [i.servico, i.hora]), [['Limpeza', '09:00'], ['Descoloração', '09:15']]);
  });

  it('a ordem pedida tem prioridade: se ela cabe, nada e trocado', () => {
    const carlos = prof('Carlos');
    const r = planejar([etapa('Corte', [carlos]), etapa('Barba', [carlos])]);
    assert.ok(r.opcoes.every((o) => !o.ordemTrocada && o.itens[0].servico === 'Corte'));
  });

  it('dentro da transacao a ordem nao muda (permitirOutraOrdem: false)', () => {
    const alexandre = prof('Alexandre', { duracaoMinutos: 150 });
    const abestalhada = prof('Abestalhada', { jornada: jornada('09:00', '10:00'), duracaoMinutos: 15 });
    const r = planejar([etapa('Descoloração', [alexandre]), etapa('Limpeza', [abestalhada])], { permitirOutraOrdem: false });
    assert.equal(r.total, 0);
  });

  it('nao encaixa fora do expediente', () => {
    const carlos = prof('Carlos', { jornada: jornada('09:00', '10:00') });
    const r = planejar([etapa('Corte', [carlos]), etapa('Barba', [carlos])]);
    assert.deepEqual(r.opcoes.map((o) => o.hora), ['09:00'], 'as 09:30 a barba terminaria as 10:30, depois do expediente');
  });

  it('dia sem expediente ou etapa sem ninguem: nenhuma opcao, sem erro', () => {
    const carlos = prof('Carlos', { jornada: { dias: {}, intervaloMinutos: 30 } });
    assert.equal(planejar([etapa('Corte', [carlos]), etapa('Barba', [carlos])]).total, 0);
    assert.equal(planejar([etapa('Corte', [prof('Carlos')]), etapa('Barba', [])]).total, 0);
  });

  it('opcoes demais sao espalhadas pelo dia (manha e tarde), com o total real', () => {
    const carlos = prof('Carlos');
    const r = planejar([etapa('Corte', [carlos]), etapa('Barba', [carlos])], { maxOpcoes: 4 });
    assert.equal(r.opcoes.length, 4);
    assert.ok(r.total > 4);
    assert.equal(r.opcoes[0].hora, '09:00');
    assert.equal(r.opcoes.at(-1).hora, '17:00', 'a ultima que cabe inteira antes das 18:00');
  });
});
