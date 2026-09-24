import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatarParaWhatsapp, pareceIrritado, tirarFrasesDeBastidores, vazaBastidores } from '../src/ai/saida.js';
import { dividirEmBaloes } from '../src/ai/agente.js';

/**
 * O ultimo filtro antes do WhatsApp. Cada caso aqui chegou de verdade a um
 * cliente nos testes de conversa.
 */

describe('formatacao para o WhatsApp', () => {
  it('**negrito** do Markdown vira *negrito* do WhatsApp', () => {
    assert.equal(
      formatarParaWhatsapp('Seu horário para **Descoloração** às **15:30** (*R$ 550,00*)'),
      'Seu horário para *Descoloração* às *15:30* (*R$ 550,00*)'
    );
  });

  it('titulo, link e item com asterisco', () => {
    assert.equal(formatarParaWhatsapp('## Serviços\n- Corte'), '*Serviços*\n- Corte');
    assert.equal(formatarParaWhatsapp('[Mapa](https://maps.app/x)'), 'Mapa: https://maps.app/x');
    assert.equal(formatarParaWhatsapp('* Corte\n* Barba'), '• Corte\n• Barba');
  });

  it('negrito em volta de parentese com negrito dentro (teste real do Lyu)', () => {
    assert.equal(
      formatarParaWhatsapp('- *Descoloração:* *R$ 500,00* (180 min) *(Alexandre: *R$ 550,00*)*'),
      '- *Descoloração:* *R$ 500,00* (180 min) (Alexandre: *R$ 550,00*)'
    );
  });

  it('*negrito* certo e texto comum passam intactos', () => {
    const certo = 'O corte sai por *R$ 45,00*! _Até já_ 😉';
    assert.equal(formatarParaWhatsapp(certo), certo);
  });

  it('marcadores internos que sobraram somem', () => {
    assert.equal(formatarParaWhatsapp('Oi [BALAO] tudo bem'), 'Oi tudo bem');
    assert.equal(formatarParaWhatsapp('[Consultando: consultar_atena] Oi'), 'Oi');
  });

  it('marcador de balao pela metade ("amanh[AO]mas") vira quebra de balao', () => {
    const baloes = dividirEmBaloes('Consegui ver os horários para amanh[AO]mas a limpeza não tem vaga.');
    assert.equal(baloes.length, 2);
    assert.ok(!baloes.join(' ').includes('['));
  });

  it('colchete com minusculas no meio do texto continua texto', () => {
    assert.deepEqual(dividirEmBaloes('Horários [manhã]: 09:00.'), ['Horários [manhã]: 09:00.']);
  });
});

describe('bastidores', () => {
  it('reconhece as frases dos testes reais', () => {
    assert.ok(vazaBastidores('A Atena pediu um instante para eu verificar.'));
    assert.ok(vazaBastidores('o sistema indicou que os dados não constam ou são inválidos'));
    assert.ok(vazaBastidores('não está com os serviços cadastrados certinho aqui no sistema'));
    assert.ok(vazaBastidores('vou usar a ferramenta'));
    assert.ok(vazaBastidores('chamei consultar_horarios'));
  });

  it('nao acusa texto normal de atendimento', () => {
    assert.equal(vazaBastidores('Oi, Débora! Temos horário na sexta às *15:30*. Posso marcar?'), null);
    assert.equal(vazaBastidores('Atendemos de segunda a sábado.'), null);
  });

  it('ultimo recurso: tira so as frases culpadas', () => {
    assert.equal(
      tirarFrasesDeBastidores('Seu horário está marcado. O sistema indicou que os outros dados não constam. Até sexta!'),
      'Seu horário está marcado. Até sexta!'
    );
    assert.equal(tirarFrasesDeBastidores('A Atena caiu.'), 'A Atena caiu.', 'sem nada que sobre, fica o original');
  });
});

describe('cliente irritado', () => {
  it('reconhece o que o cliente real escreveu', () => {
    assert.ok(pareceIrritado('Qual é a data aí que os três estão aí pra fazer esse trabalho, porra?'));
    assert.ok(pareceIrritado('que palhaçada'));
    assert.ok(pareceIrritado('e aí???'));
  });

  it('nao dispara em conversa normal', () => {
    assert.ok(!pareceIrritado('Quero agendar um corte pra sexta'));
    assert.ok(!pareceIrritado('Obrigado lindo'));
    assert.ok(!pareceIrritado('Tem horário?'));
  });
});
