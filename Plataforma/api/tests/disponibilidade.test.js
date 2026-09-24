import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calcularHorariosLivres, expedienteDoDia, podeAgendar, sobrepoe } from '../src/modules/agenda/disponibilidade.js';
import { instanteDeLocal } from '../src/core/datetime.js';

/**
 * Testes do calculo de agenda.
 *
 * Cada caso aqui corresponde a um erro que o sistema antigo cometia com a
 * lista de horarios fixa no codigo.
 */

const FUSO = 'America/Sao_Paulo';

// Sabado curto de proposito, pra testar que o dia da semana importa.
const JORNADA = {
  dias: {
    1: [{ inicio: '09:00', fim: '18:00' }],
    2: [{ inicio: '09:00', fim: '18:00' }],
    3: [{ inicio: '09:00', fim: '12:00' }, { inicio: '14:00', fim: '18:00' }], // almoco
    4: [{ inicio: '09:00', fim: '18:00' }],
    5: [{ inicio: '09:00', fim: '18:00' }],
    6: [{ inicio: '09:00', fim: '13:00' }]
  },
  intervaloMinutos: 30
};

// 2026-09-21 e uma segunda; 22 terca; 23 quarta; 26 sabado; 27 domingo.
const SEGUNDA = '2026-09-21';
const QUARTA = '2026-09-23';
const SABADO = '2026-09-26';
const DOMINGO = '2026-09-27';

const hhmm = (lista) => lista.map((h) => h.hora);
const emUmaSemana = instanteDeLocal('2026-09-20', '00:00', FUSO); // "agora" fixo, antes dos testes

describe('expediente', () => {
  it('domingo sem configuracao significa fechado, nao aberto', () => {
    assert.deepEqual(expedienteDoDia(JORNADA, DOMINGO, FUSO), []);
  });

  it('respeita o intervalo de almoco como duas faixas', () => {
    const faixas = expedienteDoDia(JORNADA, QUARTA, FUSO);
    assert.equal(faixas.length, 2);
  });
});

describe('horarios livres', () => {
  it('nao oferece horario em dia que o profissional nao trabalha', () => {
    const livres = calcularHorariosLivres({
      data: DOMINGO,
      fuso: FUSO,
      jornada: JORNADA,
      duracaoMinutos: 30,
      agora: emUmaSemana
    });
    assert.deepEqual(livres, [], 'o sistema antigo oferecia 09:00 ate domingo');
  });

  it('o ULTIMO horario cabe inteiro dentro do expediente', () => {
    // Servico de 60 min, expediente ate 18:00 -> o ultimo inicio possivel e 17:00.
    const livres = calcularHorariosLivres({
      data: SEGUNDA,
      fuso: FUSO,
      jornada: JORNADA,
      duracaoMinutos: 60,
      agora: emUmaSemana
    });

    const horas = hhmm(livres);
    assert.equal(horas.at(-1), '17:00');
    assert.ok(!horas.includes('17:30'), 'um servico de 60 min nao cabe iniciando 17:30');
  });

  it('servico longo reduz a oferta (o bug do 17:00 para 70 minutos)', () => {
    const livres = calcularHorariosLivres({
      data: SEGUNDA,
      fuso: FUSO,
      jornada: JORNADA,
      duracaoMinutos: 70, // "Corte + Barba"
      agora: emUmaSemana
    });

    const horas = hhmm(livres);
    // 16:50 seria o ultimo instante exato; com passo de 30 min, 16:30 e o ultimo.
    assert.equal(horas.at(-1), '16:30');
    assert.ok(!horas.includes('17:00'), 'o sistema antigo ofereceria 17:00 e estouraria o expediente');
  });

  it('nao oferece horario dentro do almoco', () => {
    const livres = calcularHorariosLivres({
      data: QUARTA,
      fuso: FUSO,
      jornada: JORNADA,
      duracaoMinutos: 30,
      agora: emUmaSemana
    });

    const horas = hhmm(livres);
    assert.ok(horas.includes('11:30'));
    assert.ok(!horas.includes('12:00'), 'almoco nao pode virar horario disponivel');
    assert.ok(!horas.includes('13:30'));
    assert.ok(horas.includes('14:00'));
  });

  it('remove horarios ja ocupados', () => {
    const ocupado = {
      inicio: instanteDeLocal(SEGUNDA, '10:00', FUSO),
      fim: instanteDeLocal(SEGUNDA, '11:00', FUSO)
    };

    const livres = calcularHorariosLivres({
      data: SEGUNDA,
      fuso: FUSO,
      jornada: JORNADA,
      duracaoMinutos: 30,
      ocupados: [ocupado],
      agora: emUmaSemana
    });

    const horas = hhmm(livres);
    assert.ok(!horas.includes('10:00'));
    assert.ok(!horas.includes('10:30'));
    assert.ok(horas.includes('09:30'));
    assert.ok(horas.includes('11:00'));
  });

  it('a folga pos-atendimento bloqueia o horario seguinte', () => {
    const ocupado = {
      inicio: instanteDeLocal(SEGUNDA, '10:00', FUSO),
      fim: instanteDeLocal(SEGUNDA, '10:30', FUSO)
    };

    // Servico de 30 min com 15 min de limpeza: quem comecar 09:30 termina
    // 10:00 e ocupa ate 10:15 — entao 09:30 conflita com o das 10:00.
    const livres = calcularHorariosLivres({
      data: SEGUNDA,
      fuso: FUSO,
      jornada: JORNADA,
      duracaoMinutos: 30,
      folgaMinutos: 15,
      ocupados: [ocupado],
      agora: emUmaSemana
    });

    const horas = hhmm(livres);
    assert.ok(!horas.includes('09:30'), 'a folga precisa caber antes do proximo cliente');
    assert.ok(horas.includes('09:00'));
  });

  it('respeita bloqueios de agenda (ferias, feriado)', () => {
    const bloqueio = {
      inicio: instanteDeLocal(SEGUNDA, '09:00', FUSO),
      fim: instanteDeLocal(SEGUNDA, '12:00', FUSO)
    };

    const horas = hhmm(
      calcularHorariosLivres({
        data: SEGUNDA,
        fuso: FUSO,
        jornada: JORNADA,
        duracaoMinutos: 30,
        bloqueios: [bloqueio],
        agora: emUmaSemana
      })
    );

    assert.ok(!horas.includes('09:00'));
    assert.ok(!horas.includes('11:30'));
    assert.ok(horas.includes('12:00'));
  });

  it('nao oferece horario que ja passou', () => {
    const agoraMeioDia = instanteDeLocal(SEGUNDA, '12:00', FUSO);

    const horas = hhmm(
      calcularHorariosLivres({
        data: SEGUNDA,
        fuso: FUSO,
        jornada: JORNADA,
        duracaoMinutos: 30,
        agora: agoraMeioDia
      })
    );

    assert.ok(!horas.includes('09:00'), 'nao da pra agendar no passado');
    assert.ok(horas.includes('12:00'));
  });

  it('respeita a antecedencia minima', () => {
    const agoraMeioDia = instanteDeLocal(SEGUNDA, '12:00', FUSO);

    const horas = hhmm(
      calcularHorariosLivres({
        data: SEGUNDA,
        fuso: FUSO,
        jornada: JORNADA,
        duracaoMinutos: 30,
        agora: agoraMeioDia,
        antecedenciaMinutos: 60 // cliente precisa marcar com 1h de antecedencia
      })
    );

    assert.ok(!horas.includes('12:00'));
    assert.ok(!horas.includes('12:30'));
    assert.ok(horas.includes('13:00'));
  });

  it('sabado usa o expediente curto', () => {
    const horas = hhmm(
      calcularHorariosLivres({
        data: SABADO,
        fuso: FUSO,
        jornada: JORNADA,
        duracaoMinutos: 30,
        agora: emUmaSemana
      })
    );

    assert.equal(horas[0], '09:00');
    assert.equal(horas.at(-1), '12:30', 'sabado fecha as 13:00');
  });
});

describe('podeAgendar — a checagem final antes de gravar', () => {
  const inicio = instanteDeLocal(SEGUNDA, '10:00', FUSO);
  const fim = instanteDeLocal(SEGUNDA, '10:30', FUSO);

  it('aceita horario valido e livre', () => {
    const r = podeAgendar({ inicio, fim, data: SEGUNDA, fuso: FUSO, jornada: JORNADA });
    assert.equal(r.ok, true);
  });

  it('recusa quando ja existe agendamento (corrida entre dois atendentes)', () => {
    const r = podeAgendar({
      inicio,
      fim,
      data: SEGUNDA,
      fuso: FUSO,
      jornada: JORNADA,
      ocupados: [{ inicio: instanteDeLocal(SEGUNDA, '10:15', FUSO), fim: instanteDeLocal(SEGUNDA, '11:00', FUSO) }]
    });

    assert.equal(r.ok, false);
    assert.match(r.motivo, /agendamento/i);
  });

  it('recusa fora do expediente', () => {
    const r = podeAgendar({
      inicio: instanteDeLocal(SEGUNDA, '20:00', FUSO),
      fim: instanteDeLocal(SEGUNDA, '20:30', FUSO),
      data: SEGUNDA,
      fuso: FUSO,
      jornada: JORNADA
    });

    assert.equal(r.ok, false);
    assert.match(r.motivo, /expediente/i);
  });

  it('permite encaixe manual fora do expediente, mas nunca sobre outro cliente', () => {
    const forcado = {
      inicio: instanteDeLocal(SEGUNDA, '20:00', FUSO),
      fim: instanteDeLocal(SEGUNDA, '20:30', FUSO),
      data: SEGUNDA,
      fuso: FUSO,
      jornada: JORNADA,
      permitirForaDoExpediente: true
    };

    assert.equal(podeAgendar(forcado).ok, true);

    const comConflito = podeAgendar({
      ...forcado,
      ocupados: [{ inicio: forcado.inicio, fim: forcado.fim }]
    });
    assert.equal(comConflito.ok, false, 'encaixe nao pode atropelar cliente ja marcado');
  });

  it('recusa horario invertido', () => {
    const r = podeAgendar({ inicio: fim, fim: inicio, data: SEGUNDA, fuso: FUSO, jornada: JORNADA });
    assert.equal(r.ok, false);
  });
});

describe('sobreposicao', () => {
  it('encostar nao e sobrepor', () => {
    // Um termina 10:00, o outro comeca 10:00 — cabem os dois.
    assert.equal(sobrepoe({ inicio: 0, fim: 100 }, { inicio: 100, fim: 200 }), false);
  });

  it('detecta sobreposicao parcial e total', () => {
    assert.equal(sobrepoe({ inicio: 0, fim: 100 }, { inicio: 50, fim: 150 }), true);
    assert.equal(sobrepoe({ inicio: 0, fim: 100 }, { inicio: 25, fim: 75 }), true);
  });
});
