import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cifrar, conferirSenha, decifrar, gerarHashSenha, gerarTokenSessao, hashToken } from '../src/core/crypto.js';
import { dataNoFuso, fimDoDia, inicioDoDia, instanteDeLocal, somarDias, formatarBR } from '../src/core/datetime.js';
import { formatarTelefone, normalizarTelefone, variantesDeBusca } from '../src/core/phone.js';
import { formatarBRL, paraCentavos, somarCentavos } from '../src/core/money.js';
import { novoId } from '../src/core/ids.js';

describe('crypto — senhas', () => {
  it('aceita a senha correta e recusa a errada', async () => {
    const hash = await gerarHashSenha('senha-bem-longa-123');
    assert.equal(await conferirSenha('senha-bem-longa-123', hash), true);
    assert.equal(await conferirSenha('senha-bem-longa-124', hash), false);
  });

  it('gera hashes diferentes para a mesma senha (sal aleatorio por usuario)', async () => {
    const a = await gerarHashSenha('mesma-senha-aqui');
    const b = await gerarHashSenha('mesma-senha-aqui');
    assert.notEqual(a, b, 'dois usuarios com a mesma senha nao podem ter o mesmo hash');
    // Mesmo sendo diferentes, ambos conferem.
    assert.equal(await conferirSenha('mesma-senha-aqui', a), true);
    assert.equal(await conferirSenha('mesma-senha-aqui', b), true);
  });

  it('nunca guarda a senha em texto puro', async () => {
    const hash = await gerarHashSenha('minha-senha-secreta');
    assert.ok(!hash.includes('minha-senha-secreta'));
  });

  it('recusa senha curta demais', async () => {
    await assert.rejects(() => gerarHashSenha('1234'));
  });

  it('nao quebra com hash corrompido', async () => {
    assert.equal(await conferirSenha('qualquer', 'lixo-que-nao-e-hash'), false);
    assert.equal(await conferirSenha('qualquer', null), false);
  });
});

describe('crypto — tokens de sessao', () => {
  it('o que vai pro banco nao serve pra entrar', () => {
    const { token, tokenHash } = gerarTokenSessao();
    assert.notEqual(token, tokenHash);
    assert.equal(hashToken(token), tokenHash);
  });

  it('nao repete tokens', () => {
    const vistos = new Set();
    for (let i = 0; i < 500; i++) vistos.add(gerarTokenSessao().token);
    assert.equal(vistos.size, 500);
  });
});

describe('crypto — cofre de chaves de API', () => {
  it('cifra e decifra de volta', () => {
    const chave = 'AIzaSyD-exemplo-de-chave-do-gemini-123';
    const cofre = cifrar(chave);
    assert.notEqual(cofre, chave);
    assert.ok(!cofre.includes('AIzaSy'));
    assert.equal(decifrar(cofre), chave);
  });

  it('detecta adulteracao em vez de devolver lixo', () => {
    const cofre = cifrar('segredo-importante');
    const adulterado = `${cofre.slice(0, -4)}XXXX`;
    assert.equal(decifrar(adulterado), null);
  });

  it('o mesmo segredo cifrado duas vezes gera textos diferentes', () => {
    assert.notEqual(cifrar('igual'), cifrar('igual'));
  });
});

describe('datetime — o bug de fuso do sistema antigo', () => {
  it('as 21h de Sao Paulo ainda e o MESMO dia (o sistema antigo pulava pro seguinte)', () => {
    // 2026-09-19 21:30 em Sao Paulo = 2026-09-20 00:30 em UTC.
    const instante = instanteDeLocal('2026-09-19', '21:30', 'America/Sao_Paulo');

    // Era exatamente isto que o codigo antigo fazia — e por isso errava:
    const jeitoAntigo = new Date(instante).toISOString().slice(0, 10);
    assert.equal(jeitoAntigo, '2026-09-20', 'confirma que o jeito antigo realmente pula o dia');

    // O jeito correto, perguntando no fuso da empresa:
    assert.equal(dataNoFuso(instante, 'America/Sao_Paulo'), '2026-09-19');
  });

  it('converte hora local em instante UTC corretamente', () => {
    const instante = instanteDeLocal('2026-09-19', '14:00', 'America/Sao_Paulo');
    // Sao Paulo esta em UTC-3 nessa data, entao 14:00 local = 17:00 UTC.
    assert.equal(new Date(instante).toISOString(), '2026-09-19T17:00:00.000Z');
  });

  it('respeita fusos diferentes na mesma instalacao', () => {
    const sp = instanteDeLocal('2026-09-19', '14:00', 'America/Sao_Paulo');
    const manaus = instanteDeLocal('2026-09-19', '14:00', 'America/Manaus');
    // Manaus e UTC-4: as 14h de la acontecem uma hora DEPOIS das 14h de SP.
    assert.equal(manaus - sp, 3_600_000);
  });

  it('inicio e fim do dia cercam exatamente 24 horas', () => {
    const ini = inicioDoDia('2026-09-19', 'America/Sao_Paulo');
    const fim = fimDoDia('2026-09-19', 'America/Sao_Paulo');
    assert.equal(fim - ini, 86_400_000);
    assert.equal(dataNoFuso(ini, 'America/Sao_Paulo'), '2026-09-19');
    // O fim e o primeiro instante do dia seguinte (limite exclusivo).
    assert.equal(dataNoFuso(fim, 'America/Sao_Paulo'), '2026-09-20');
  });

  it('soma dias atravessando virada de mes e ano', () => {
    assert.equal(somarDias('2026-09-30', 1), '2026-10-01');
    assert.equal(somarDias('2026-12-31', 1), '2027-01-01');
    assert.equal(somarDias('2026-03-01', -1), '2026-02-28');
    assert.equal(somarDias('2028-03-01', -1), '2028-02-29'); // ano bissexto
  });

  it('formata para leitura brasileira', () => {
    const instante = instanteDeLocal('2026-09-19', '14:30', 'America/Sao_Paulo');
    assert.equal(formatarBR(instante, 'America/Sao_Paulo'), '19/09/2026 14:30');
  });

  it('recusa data mal formada em vez de inventar um valor', () => {
    assert.throws(() => instanteDeLocal('19/09/2026', '14:00'));
    assert.throws(() => instanteDeLocal('2026-09-19', '25:00'));
  });
});

describe('phone — o mesmo cliente nao pode virar tres cadastros', () => {
  it('normaliza todos os formatos para a mesma forma canonica', () => {
    const esperado = '5511999887766';
    for (const entrada of [
      '5511999887766',
      '+55 (11) 99988-7766',
      '(11) 99988-7766',
      '11999887766',
      '11 99988 7766',
      '5511999887766@s.whatsapp.net',
      '011999887766'
    ]) {
      assert.equal(normalizarTelefone(entrada), esperado, `falhou para: ${entrada}`);
    }
  });

  it('encontra o cliente cadastrado sem o nono digito', () => {
    const variantes = variantesDeBusca('5511999887766');
    assert.ok(variantes.includes('5511999887766'));
    assert.ok(variantes.includes('551199887766'), 'precisa achar quem foi cadastrado sem o 9');
  });

  it('recusa numero invalido', () => {
    assert.throws(() => normalizarTelefone('123'));
    assert.throws(() => normalizarTelefone('5500999887766')); // DDD 00 nao existe
    assert.equal(normalizarTelefone('123', { estrito: false }), null);
  });

  it('formata para leitura', () => {
    assert.equal(formatarTelefone('5511999887766'), '+55 (11) 99988-7766');
  });
});

describe('money — centavos inteiros', () => {
  it('interpreta o que o usuario digita', () => {
    assert.equal(paraCentavos('45,90'), 4590);
    assert.equal(paraCentavos('R$ 45,90'), 4590);
    assert.equal(paraCentavos('1.234,56'), 123456);
    assert.equal(paraCentavos('45'), 4500);
    assert.equal(paraCentavos(45.9), 4590);
  });

  it('soma sem o erro de ponto flutuante', () => {
    // Em decimal, 0.1 + 0.2 daria 0.30000000000000004.
    assert.equal(somarCentavos(10, 20), 30);
    const cem = Array(100).fill(1099); // R$ 10,99 cem vezes
    assert.equal(somarCentavos(cem), 109900);
  });

  it('formata em real', () => {
    assert.equal(formatarBRL(4500).replace(/ /g, ' '), 'R$ 45,00');
  });
});

describe('ids', () => {
  it('sao ordenaveis por data de criacao', async () => {
    const a = novoId('lead');
    await new Promise((r) => setTimeout(r, 2));
    const b = novoId('lead');
    assert.ok(a < b, 'ids criados depois devem ordenar depois');
  });

  it('carregam o prefixo do tipo', () => {
    assert.ok(novoId('appt').startsWith('appt_'));
  });

  it('nao colidem', () => {
    const vistos = new Set();
    for (let i = 0; i < 5000; i++) vistos.add(novoId('lead'));
    assert.equal(vistos.size, 5000);
  });

  it('recusa prefixo invalido', () => {
    assert.throws(() => novoId('MAIUSCULO'));
    assert.throws(() => novoId(''));
  });
});
