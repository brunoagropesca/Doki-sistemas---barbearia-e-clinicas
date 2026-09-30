import { pathToFileURL } from 'node:url';
import { SENHA_DE_FABRICA } from '../modules/auth/auth.schemas.js';
import { eq } from 'drizzle-orm';
import { db, fecharBanco, inicializarBanco } from './client.js';
import { rodarMigrations } from './migrate.js';
import * as s from './schema/index.js';
import { ID } from '../core/ids.js';
import { gerarHashSenha } from '../core/crypto.js';
import { normalizarTelefone } from '../core/phone.js';
import { logger } from '../core/logger.js';
import { AGENTES_PADRAO } from '../ai/agentes-padrao.js';

/**
 * Popula o banco com uma empresa de demonstracao.
 *
 * Roda quantas vezes quiser: se a empresa de exemplo ja existir, o seed nao
 * faz nada. Isso importa porque ele e chamado em ambiente de desenvolvimento
 * com frequencia, e duplicar dado a cada execucao criaria uma bagunca.
 */

const SLUG_DEMO = 'barbearia-demo';

/**
 * Senha inicial dos dois acessos. E publica, entao nasce PROVISORIA: no
 * primeiro login a pessoa so consegue criar a propria senha (ver o plugin de
 * autenticacao) — ninguem continua entrando com ela.
 */
const SENHA_PADRAO = SENHA_DE_FABRICA;

export async function semear({ forcar = false } = {}) {
  const existente = await db.query.tenants.findFirst({ where: eq(s.tenants.slug, SLUG_DEMO) });

  if (existente && !forcar) {
    logger.info({ tenantId: existente.id }, 'Empresa de demonstracao ja existe; seed ignorado.');
    return existente;
  }

  const tenantId = ID.tenant();
  const agora = new Date();

  await db.insert(s.tenants).values({
    id: tenantId,
    nome: 'Barbearia Demonstracao',
    slug: SLUG_DEMO,
    segmento: 'barbearia',
    fusoHorario: 'America/Sao_Paulo',
    emailContato: 'contato@barbeariademo.com.br'
  });

  // --- Usuarios ---
  const hash = await gerarHashSenha(SENHA_PADRAO);
  const idDono = ID.usuario();
  const idAtendente = ID.usuario();

  await db.insert(s.users).values([
    {
      id: idDono,
      tenantId,
      username: 'dono',
      nome: 'Ze da Barbearia',
      cargo: 'owner',
      passwordHash: hash,
      senhaProvisoria: true,
      statusPresenca: 'offline'
    },
    {
      id: idAtendente,
      tenantId,
      username: 'recepcao',
      nome: 'Beatriz Lima',
      cargo: 'atendente',
      passwordHash: hash,
      senhaProvisoria: true,
      statusPresenca: 'online',
      capacidadeSimultanea: 6
    }
  ]);

  // --- Profissionais ---
  const idCarlos = ID.profissional();
  const idJulia = ID.profissional();

  await db.insert(s.professionals).values([
    {
      id: idCarlos,
      tenantId,
      nome: 'Carlos Mendes',
      funcao: 'Barbeiro',
      cor: '#3b82f6',
      jornada: {
        dias: {
          1: [{ inicio: '09:00', fim: '18:00' }],
          2: [{ inicio: '09:00', fim: '18:00' }],
          3: [{ inicio: '09:00', fim: '18:00' }],
          4: [{ inicio: '09:00', fim: '20:00' }],
          5: [{ inicio: '09:00', fim: '20:00' }],
          6: [{ inicio: '08:00', fim: '16:00' }]
        },
        intervaloMinutos: 30
      }
    },
    {
      id: idJulia,
      tenantId,
      nome: 'Julia Rocha',
      funcao: 'Barbeira',
      cor: '#ec4899',
      jornada: {
        dias: {
          2: [{ inicio: '10:00', fim: '19:00' }],
          3: [{ inicio: '10:00', fim: '19:00' }],
          4: [{ inicio: '10:00', fim: '19:00' }],
          5: [{ inicio: '10:00', fim: '19:00' }],
          6: [{ inicio: '09:00', fim: '15:00' }]
        },
        intervaloMinutos: 30
      }
    }
  ]);

  // --- Servicos ---
  const servicos = [
    { nome: 'Corte Degrade', duracaoMinutos: 40, precoCentavos: 5500, categoria: 'Cabelo', intervaloAposMinutos: 5 },
    { nome: 'Corte Social', duracaoMinutos: 30, precoCentavos: 4500, categoria: 'Cabelo' },
    { nome: 'Barba Terapia', duracaoMinutos: 30, precoCentavos: 4000, categoria: 'Barba' },
    { nome: 'Corte + Barba', duracaoMinutos: 70, precoCentavos: 8500, categoria: 'Combo', intervaloAposMinutos: 10 },
    { nome: 'Pezinho', duracaoMinutos: 15, precoCentavos: 2000, categoria: 'Cabelo' }
  ].map((sv) => ({ id: ID.servico(), tenantId, descricao: '', ...sv }));

  await db.insert(s.services).values(servicos);

  // Carlos faz tudo; Julia faz os de cabelo, cobrando um pouco mais no degrade.
  await db.insert(s.professionalServices).values([
    ...servicos.map((sv) => ({ tenantId, professionalId: idCarlos, serviceId: sv.id })),
    ...servicos
      .filter((sv) => sv.categoria === 'Cabelo')
      .map((sv) => ({
        tenantId,
        professionalId: idJulia,
        serviceId: sv.id,
        precoCentavos: sv.nome === 'Corte Degrade' ? 6500 : null
      }))
  ]);

  // --- Produtos ---
  await db.insert(s.products).values(
    [
      { nome: 'Pomada Modeladora', precoCentavos: 4500, custoCentavos: 2200, estoque: 24, estoqueMinimo: 5 },
      { nome: 'Shampoo Anticaspa', precoCentavos: 3800, custoCentavos: 1900, estoque: 12, estoqueMinimo: 4 },
      { nome: 'Oleo para Barba', precoCentavos: 5200, custoCentavos: 2600, estoque: 3, estoqueMinimo: 5 }
    ].map((p) => ({ id: ID.produto(), tenantId, descricao: '', categoria: 'Cuidados', ...p }))
  );

  // --- Leads de exemplo ---
  const leadsDemo = [
    { nome: 'Marcos Antunes', telefone: '11988776655', observacoes: 'Prefere corte na tesoura.' },
    { nome: 'Rafael Souza', telefone: '11977665544', observacoes: '' },
    { nome: 'Joao Pedro', telefone: '11966554433', observacoes: 'Alergico a produto com alcool.' }
  ].map((l) => ({
    id: ID.lead(),
    tenantId,
    telefone: normalizarTelefone(l.telefone),
    nome: l.nome,
    observacoes: l.observacoes,
    tags: [],
    origem: 'manual',
    ultimoContatoEm: agora
  }));

  await db.insert(s.leads).values(leadsDemo);

  // --- Canal de WhatsApp (ainda desconectado) ---
  await db.insert(s.channelInstances).values({
    id: ID.canal(),
    tenantId,
    canal: 'whatsapp',
    chave: 'W1',
    nome: 'WhatsApp da Recepcao',
    status: 'desconectado'
  });

  // --- Agentes de IA: Sofia (frente) e Atena (dados e agenda) ---
  // Os valores vem de um lugar so, para o seed e a tela de configuracao
  // nunca discordarem sobre qual e o "padrao de fabrica".
  await db.insert(s.agentProfiles).values(
    Object.entries(AGENTES_PADRAO).map(([chave, a]) => ({
      id: ID.agente(),
      tenantId,
      chave,
      nome: a.nome,
      avatar: a.avatar,
      tom: a.tom,
      temperaturaMilesimos: a.temperaturaMilesimos,
      maxTokens: a.maxTokens,
      systemPrompt: a.systemPrompt,
      ferramentas: a.ferramentas
    }))
  );

  // --- Configuracoes iniciais ---
  await db.insert(s.settings).values(
    [
      { chave: 'modo_atendimento', valor: 'hibrido', descricao: 'hibrido | menu | ia' },
      { chave: 'janela_contexto_mensagens', valor: 8, descricao: 'Quantas mensagens a IA lembra' },
      { chave: 'agrupamento_segundos', valor: 8, descricao: 'Espera antes de responder mensagens picotadas' }
    ].map((c) => ({ tenantId, ...c }))
  );

  logger.info(
    { tenantId, usuarios: 2, servicos: servicos.length, leads: leadsDemo.length },
    'Empresa de demonstracao criada'
  );

  return { id: tenantId, slug: SLUG_DEMO };
}

// Compara pelo endereco que o proprio Node gera: montar a URL na mao quebrava
// em pasta com espaco no nome (o Node escreve %20) e o script nao rodava.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await rodarMigrations();
    await inicializarBanco();
    const tenant = await semear({ forcar: process.argv.includes('--forcar') });

    console.log(`
Empresa de demonstracao pronta.

  Empresa:  ${tenant.slug ?? SLUG_DEMO}
  Acesso 1: dono      / ${SENHA_PADRAO}   (cargo: owner)
  Acesso 2: recepcao  / ${SENHA_PADRAO}   (cargo: atendente)

No primeiro acesso cada um cria a propria senha (o sistema obriga).
`);
  } catch (err) {
    console.error('Falha ao semear:', err);
    process.exitCode = 1;
  } finally {
    fecharBanco();
  }
}
