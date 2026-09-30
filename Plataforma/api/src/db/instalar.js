import { randomInt } from 'node:crypto';
import { db } from './client.js';
import * as s from './schema/index.js';
import { ID } from '../core/ids.js';
import { gerarHashSenha } from '../core/crypto.js';
import { logger } from '../core/logger.js';
import { AGENTES_PADRAO } from '../ai/agentes-padrao.js';
import { usernameSchema } from '../modules/auth/auth.schemas.js';

/**
 * Instalacao de VERDADE: a empresa do cliente, o login do dono e a
 * configuracao de fabrica — e nada mais.
 *
 * Nada de clientes, profissionais, servicos, produtos ou numero de WhatsApp de
 * exemplo: numa loja real, cliente ficticio com celular valido recebe a
 * campanha de "todos os clientes", e a Sofia ofereceria profissionais que nao
 * existem. O exemplo completo continua no `db/seed.js`, para desenvolvimento
 * e para os testes.
 *
 * A linha de comando (o que o INICIAR.bat chama) fica em `db/instalar-cli.js`.
 */

/**
 * O que toda empresa nova recebe, na instalacao e no seed de exemplo: os
 * agentes de IA e os ajustes iniciais. O menu do WhatsApp nao entra — sem
 * menu gravado, o sistema usa o de fabrica (atendimento.service.js).
 */
export async function configuracaoDeFabrica(tenantId, banco = db) {
  // Os valores vem de um lugar so, para a instalacao e a tela de configuracao
  // nunca discordarem sobre qual e o "padrao de fabrica".
  await banco.insert(s.agentProfiles).values(
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

  await banco.insert(s.settings).values(
    [
      { chave: 'modo_atendimento', valor: 'hibrido', descricao: 'hibrido | menu | ia' },
      { chave: 'janela_contexto_mensagens', valor: 8, descricao: 'Quantas mensagens a IA lembra' },
      { chave: 'agrupamento_segundos', valor: 8, descricao: 'Espera antes de responder mensagens picotadas' }
    ].map((c) => ({ tenantId, ...c }))
  );
}

/** "Barbearia São João & Cia" -> "barbearia-sao-joao-cia". */
export function slugDe(nome) {
  const slug = String(nome ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'empresa';
}

/**
 * Senha inicial: 12 caracteres sem os que se confundem ao ler e copiar a mao
 * (0/O, 1/l/I). Ela nasce PROVISORIA: o dono cria a propria no primeiro acesso.
 */
export function senhaInicial() {
  const letras = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 12 }, () => letras[randomInt(letras.length)]).join('');
}

/**
 * Cria a empresa e o dono. Se ja existe alguma empresa, nao faz nada (rodar
 * de novo nunca duplica): devolve `{ criado: false }`.
 *
 * @param {object} p
 * @param {string} p.empresa   nome da empresa
 * @param {string} [p.dono]    login do dono (padrao "dono")
 * @param {string} [p.nomeDono]
 * @param {string} [p.senha]   so para testes; o normal e sortear
 */
export async function instalar({ empresa, dono = 'dono', nomeDono, senha = senhaInicial() }) {
  const existente = await db.query.tenants.findFirst();
  if (existente) return { criado: false, tenant: existente };

  const nome = String(empresa ?? '').trim();
  if (nome.length < 2) throw new Error('Informe o nome da empresa.');
  const username = usernameSchema.parse(dono);

  const tenantId = ID.tenant();
  const passwordHash = await gerarHashSenha(senha);

  await db.transaction(async (tx) => {
    await tx.insert(s.tenants).values({
      id: tenantId,
      nome,
      slug: slugDe(nome),
      segmento: 'barbearia',
      fusoHorario: 'America/Sao_Paulo'
    });
    await tx.insert(s.users).values({
      id: ID.usuario(),
      tenantId,
      username,
      nome: String(nomeDono ?? '').trim() || 'Dono',
      cargo: 'owner',
      passwordHash,
      // Quem instalou viu a senha: o dono cria a propria no primeiro acesso.
      senhaProvisoria: true,
      statusPresenca: 'offline'
    });
    await configuracaoDeFabrica(tenantId, tx);
  });

  logger.info({ tenantId, empresa: nome }, 'Instalacao criada');
  return { criado: true, tenant: { id: tenantId, nome, slug: slugDe(nome) }, username, senha };
}
