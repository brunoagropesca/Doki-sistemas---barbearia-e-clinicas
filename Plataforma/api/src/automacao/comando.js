import { NaoEncontrado, RegraDeNegocio, SemPermissao } from '../core/errors.js';
import { FUSO_PADRAO } from '../core/datetime.js';
import { consultarAtena } from '../ai/atena.js';
import { fala } from '../core/painel.js';
import * as agendaRepo from '../modules/agenda/agenda.repo.js';
import * as conversas from '../modules/conversas/conversas.service.js';
import { obterAgente } from '../modules/ia/ia.service.js';
import { funcaoLigada } from '../modules/funcoes/funcoes.js';

/**
 * Comando direto a Atena.
 *
 * Ate aqui a Atena so acordava quando a Sofia perguntava. Este e o caminho para
 * o ATENDENTE acorda-la: "remarca esse cliente para sexta as 15h", "cancela o
 * horario dele", "quanto ele ja gastou?". Digitado no chat como `/atena ...`.
 *
 * Nada aqui e um atalho paralelo: o pedido entra pelo mesmo `consultarAtena`
 * da Sofia, com as mesmas ferramentas e as mesmas travas — escopo no cliente
 * da conversa, teto de escritas, permissoes configuradas na Central de IA. O
 * que a empresa desligou para a Atena continua desligado, mesmo para o dono.
 *
 * O resultado fica registrado NA CONVERSA como aviso de sistema, para o proximo
 * atendente saber que aquilo foi feito e por quem. O cliente nunca ve: a
 * mensagem e so de sistema e nao e enviada ao canal.
 */

const LIMITE = 500;

/**
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} p.conversationId
 * @param {string} p.comando
 * @param {{nome: string}} p.usuario quem digitou
 * @param {object[]} [p.provedores] injetado nos testes
 */
export async function executarComando({ tenantId, conversationId, comando, usuario, provedores = null }) {
  const pedido = String(comando ?? '').trim();
  if (!pedido) throw new RegraDeNegocio('Diga o que a Atena deve fazer. Ex: /atena remarcar para sexta às 15h');
  if (pedido.length > LIMITE) throw new RegraDeNegocio(`Comando longo demais (máximo ${LIMITE} caracteres).`);

  // Com o usuario: conversa fora do escopo dele vira 404, como nas outras
  // rotas. Sem isto um atendente mandava "/atena remarca para sabado" numa
  // conversa de outra pessoa (ou que ele nem ve) e a Atena executava.
  const conversa = await conversas.obter(tenantId, conversationId, usuario);
  if (!conversa) throw new NaoEncontrado('Conversa');
  // Enxergar nao basta: agir e so na propria, na sem dono, ou para quem
  // acompanha a equipe inteira — a mesma regra de responder.
  if (!(await conversas.podeAgir(tenantId, conversa, usuario))) {
    throw new SemPermissao('Esta conversa está com outro atendente.');
  }
  if (conversa.status === 'finalizada') {
    throw new RegraDeNegocio('Esta conversa foi finalizada. Reabra para dar comandos à Atena.');
  }

  if (!(await funcaoLigada(tenantId, 'agente_atena'))) {
    throw new RegraDeNegocio('A Atena está desligada neste sistema.');
  }

  const atena = await obterAgente(tenantId, 'atena');
  if (atena.ativo === false) {
    throw new RegraDeNegocio('A Atena está desativada. Ative na Central de IA para usar comandos.');
  }

  const tenant = await agendaRepo.buscarTenant(tenantId);

  fala('humano', 'atena', pedido, usuario?.nome ? `comando de ${usuario.nome}` : 'comando direto');

  const { resposta, trace } = await consultarAtena({
    tenantId,
    // Quem manda e um atendente: deixamos claro no pedido para ela nao
    // confundir com o cliente falando.
    pedido: `Comando do atendente ${usuario?.nome ?? ''} sobre este cliente: ${pedido}`,
    leadId: conversa.leadId,
    leadNome: conversa.leadNome,
    fuso: tenant?.fusoHorario || FUSO_PADRAO,
    nomeEmpresa: tenant?.nome ?? 'nossa empresa',
    conversationId,
    permitirEscrita: true,
    provedores
  });

  const texto = String(resposta ?? '').trim() || 'A Atena não devolveu uma resposta.';
  fala('atena', 'humano', texto);

  await conversas.registrarEnviada(tenantId, conversationId, {
    conteudo: `Atena, a pedido de ${usuario?.nome ?? 'um atendente'} (“${pedido}”):\n${texto}`,
    autorTipo: 'sistema',
    metadados: { atena: true, comando: pedido, ferramentas: trace.ferramentas.map((f) => f.nome) }
  });

  return {
    resposta: texto,
    ferramentas: trace.ferramentas.map((f) => ({ nome: f.nome, ok: !f.resultado?.erro })),
    escritas: trace.escritas ?? 0
  };
}
