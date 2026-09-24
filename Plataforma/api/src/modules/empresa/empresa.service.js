import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tenants } from '../../db/schema/tenants.js';
import { settings } from '../../db/schema/ai.js';
import { NaoEncontrado } from '../../core/errors.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import { apagarImagem, salvarImagem } from '../equipe/arquivos.js';

/**
 * Base de conhecimento da empresa: quem ela e, onde fica, como se paga, quando
 * abre, as regras da casa e as perguntas que o cliente sempre faz.
 *
 * E a fonte UNICA dessas informacoes: a Sofia le daqui (vai no prompt, ver
 * `textoParaIa`), o menu lateral mostra o nome e o logo daqui. Antes o
 * endereco ou o Pix so existiam na cabeca da recepcao — e a IA, sem saber,
 * transferia o cliente ou (pior) inventava.
 *
 * O nome mora na tabela da empresa (todo o sistema ja le de la); o resto e um
 * documento so, na tabela `settings` — sem migracao a cada campo novo.
 */

const CHAVE = 'empresa.base_conhecimento';

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const ORDEM_DIAS = [1, 2, 3, 4, 5, 6, 0];

const TIPO_PIX = { cpf: 'CPF', cnpj: 'CNPJ', telefone: 'Telefone', email: 'E-mail', aleatoria: 'Chave aleatória' };

/** O documento vazio: todos os campos existem, a tela nunca le `undefined`. */
export const BASE_VAZIA = Object.freeze({
  logo: null,
  sobre: '',
  endereco: { logradouro: '', bairro: '', cidade: '', referencia: '', mapaUrl: '', estacionamento: '' },
  contato: { telefone: '', whatsapp: '', instagram: '', site: '', email: '' },
  pagamento: { pix: { tipo: 'cnpj', chave: '', titular: '', banco: '' }, formas: [], observacao: '' },
  horario: { dias: {}, observacao: '' },
  politicas: '',
  faq: [],
  extras: ''
});

function mesclar(salvo) {
  const b = salvo ?? {};
  return {
    ...BASE_VAZIA,
    ...b,
    endereco: { ...BASE_VAZIA.endereco, ...b.endereco },
    contato: { ...BASE_VAZIA.contato, ...b.contato },
    pagamento: {
      ...BASE_VAZIA.pagamento,
      ...b.pagamento,
      pix: { ...BASE_VAZIA.pagamento.pix, ...b.pagamento?.pix },
      formas: b.pagamento?.formas ?? []
    },
    horario: { ...BASE_VAZIA.horario, ...b.horario, dias: b.horario?.dias ?? {} },
    faq: b.faq ?? []
  };
}

async function lerBase(tenantId) {
  const linha = await db.query.settings.findFirst({
    where: and(eq(settings.tenantId, tenantId), eq(settings.chave, CHAVE))
  });
  return mesclar(linha?.valor);
}

async function gravarBase(tenantId, valor) {
  const existe = await db.query.settings.findFirst({
    where: and(eq(settings.tenantId, tenantId), eq(settings.chave, CHAVE))
  });
  if (existe) {
    await db.update(settings).set({ valor }).where(and(eq(settings.tenantId, tenantId), eq(settings.chave, CHAVE)));
  } else {
    await db.insert(settings).values({ tenantId, chave: CHAVE, valor, descricao: 'Base de conhecimento da empresa' });
  }
}

/** A empresa como a tela e a IA enxergam: nome, segmento e a base inteira. */
export async function obter(tenantId) {
  const [tenant, base] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) }),
    lerBase(tenantId)
  ]);
  if (!tenant) throw new NaoEncontrado('Empresa nao encontrada.');
  return { nome: tenant.nome, segmento: tenant.segmento, ...base };
}

/**
 * Salva o que veio (so os campos enviados mudam).
 * `logoArquivo`: data URL de uma imagem nova; `removerLogo`: volta ao icone padrao.
 */
export async function salvar(tenantId, dados, usuario) {
  const atual = await obter(tenantId);
  const { nome, logoArquivo, removerLogo, ...resto } = dados;

  let logo = atual.logo;
  if (logoArquivo) {
    logo = await salvarImagem(logoArquivo, 'logo');
    if (atual.logo) await apagarImagem(atual.logo);
  } else if (removerLogo) {
    if (atual.logo) await apagarImagem(atual.logo);
    logo = null;
  }

  const { nome: _n, segmento: _s, ...baseAtual } = atual;
  const nova = mesclar({ ...baseAtual, ...resto, logo });
  await gravarBase(tenantId, nova);

  if (nome && nome !== atual.nome) {
    await db.update(tenants).set({ nome }).where(eq(tenants.id, tenantId));
  }

  await registrarAuditoria({
    tenantId,
    usuario,
    acao: 'empresa.base_conhecimento',
    entidade: 'empresa',
    entidadeId: tenantId,
    dados: { campos: Object.keys(dados) }
  });

  return obter(tenantId);
}

// ============================================================================
// O TEXTO QUE VAI PARA A IA
// ============================================================================

function horarioEmTexto(horario) {
  const dias = horario?.dias ?? {};
  const linhas = ORDEM_DIAS.map((d) => {
    const faixas = dias[d] ?? [];
    return `${DIAS[d]}: ${faixas.length ? faixas.map((f) => `${f.inicio} às ${f.fim}`).join(' e ') : 'fechado'}`;
  });
  return Object.keys(dias).length ? linhas : [];
}

/**
 * A base em texto corrido, pronta para o prompt da Sofia. So entra o que foi
 * preenchido: linha vazia no prompt e token pago a toa — e a IA poderia ler
 * "Pix: " como "a empresa nao tem Pix".
 *
 * @returns {string} vazio quando nada foi preenchido
 */
export function textoParaIa(empresa) {
  const b = mesclar(empresa);
  const l = [];
  const add = (rotulo, valor) => valor?.toString().trim() && l.push(`- ${rotulo}: ${valor.toString().trim()}`);

  add('Sobre a empresa', b.sobre);

  const e = b.endereco;
  const endereco = [e.logradouro, e.bairro, e.cidade].map((x) => x?.trim()).filter(Boolean).join(', ');
  add('Endereço', endereco);
  add('Ponto de referência', e.referencia);
  add('Link do mapa', e.mapaUrl);
  add('Estacionamento', e.estacionamento);

  const c = b.contato;
  add('Telefone', c.telefone);
  add('WhatsApp', c.whatsapp);
  add('Instagram', c.instagram);
  add('Site', c.site);
  add('E-mail', c.email);

  const horas = horarioEmTexto(b.horario);
  if (horas.length) l.push('- Horário de funcionamento:', ...horas.map((h) => `  ${h}`));
  add('Sobre o horário', b.horario.observacao);

  const pix = b.pagamento.pix;
  if (pix.chave?.trim()) {
    const extra = [pix.titular && `em nome de ${pix.titular}`, pix.banco && `banco ${pix.banco}`].filter(Boolean).join(', ');
    add('Pix', `${TIPO_PIX[pix.tipo] ?? 'Chave'} ${pix.chave.trim()}${extra ? ` (${extra})` : ''}`);
  }
  if (b.pagamento.formas.length) add('Formas de pagamento', b.pagamento.formas.join(', '));
  add('Sobre pagamento', b.pagamento.observacao);

  add('Regras da casa (atrasos, cancelamentos etc.)', b.politicas);

  const faq = b.faq.filter((f) => f.pergunta?.trim() && f.resposta?.trim());
  if (faq.length) {
    l.push('- Perguntas frequentes:');
    for (const f of faq) l.push(`  P: ${f.pergunta.trim()}`, `  R: ${f.resposta.trim()}`);
  }

  add('Outras informações', b.extras);
  return l.join('\n');
}

/** Atalho do atendimento: o texto da base desta empresa (vazio se nada preenchido). */
export async function baseParaIa(tenantId) {
  return textoParaIa(await lerBase(tenantId));
}
