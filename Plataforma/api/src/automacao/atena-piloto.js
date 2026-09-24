import { EVENTOS, ouvir } from '../core/eventos.js';
import { aoExecutarFerramenta } from './funil.js';

/**
 * O piloto automatico da Atena.
 *
 * A Atena e o cerebro do sistema: alem de responder quando a Sofia pergunta,
 * ela precisa REAGIR ao que acontece, sem ninguem chamar. Este e o lugar onde
 * ela se inscreve nos eventos.
 *
 * O desenho tem uma fronteira clara, e ela e proposital:
 *
 *   - Decisoes que exigem entender linguagem (interpretar um pedido, escolher
 *     entre duas opcoes) ficam com o MODELO, atras das ferramentas.
 *   - Consequencias mecanicas de um fato (a Atena consultou horarios => o
 *     cliente esta em "orcamento") ficam no CODIGO, aqui. Custam zero token e
 *     nao esquecem.
 *
 * Toda reacao daqui pergunta `atenaPermite(...)` antes de agir. Quem manda no
 * que a Atena pode fazer sozinha e a tela de permissoes dela, sempre.
 *
 * Idempotente: instalar duas vezes nao duplica reacoes (o app e criado varias
 * vezes nos testes).
 */

let instalado = false;

export function instalarAtenaPiloto() {
  if (instalado) return;
  instalado = true;

  // A cada fato que a Atena produz, o funil decide se o cartao anda.
  ouvir(EVENTOS.ATENA_FERRAMENTA, aoExecutarFerramenta);
}
