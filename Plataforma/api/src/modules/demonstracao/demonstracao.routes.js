import { count } from 'drizzle-orm';
import { apenas } from '../../http/plugins/autenticacao.js';
import { dbReal } from '../../db/client.js';
import * as s from '../../db/schema/index.js';
import { RegraDeNegocio } from '../../core/errors.js';
import { comContexto } from '../../core/logger.js';
import { registrarAuditoria } from '../auditoria/auditoria.service.js';
import { abrir, apagarArquivo, COOKIE_DEMONSTRACAO, espelharUsuario, existe, fechar, tamanhoEmBytes } from './demonstracao.js';
import { gerarDemonstracao } from './gerador.js';

const log = comContexto({ modulo: 'demonstracao' });

/**
 * Banco de demonstracao — so o perfil DEV. `bancoReal`: estas rotas mexem no
 * ARQUIVO da demonstracao e nunca rodam "dentro" dele.
 */

const ROTA = { ...apenas.dev, bancoReal: true };

/** A geracao roda em segundo plano; a tela acompanha por aqui. */
export const geracao = { rodando: false, etapa: null, pct: 0, erro: null, terminouEm: null };

async function resumo() {
  if (!existe() || geracao.rodando) return null;
  const { db } = await abrir();
  const contar = async (t) => Number((await db.select({ n: count() }).from(t))[0]?.n ?? 0);
  const [tenant] = await db.select({ nome: s.tenants.nome, criadoEm: s.tenants.createdAt }).from(s.tenants).limit(1);
  if (!tenant) return null;
  return {
    empresa: tenant.nome,
    geradoEm: tenant.criadoEm,
    profissionais: await contar(s.professionals),
    equipe: await contar(s.users),
    servicos: await contar(s.services),
    produtos: await contar(s.products),
    clientes: await contar(s.leads),
    conversas: await contar(s.conversations),
    mensagens: await contar(s.messages),
    agendamentos: await contar(s.appointments),
    vendas: await contar(s.productSales),
    campanhas: await contar(s.campaigns)
  };
}

const opcoesCookie = { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 };

export async function rotasDemonstracao(app) {
  app.get('/api/dev/demonstracao', { config: ROTA }, async (req) => ({
    existe: existe(),
    tamanhoBytes: existe() ? tamanhoEmBytes() : 0,
    ativo: req.cookies?.[COOKIE_DEMONSTRACAO] === '1' && existe(),
    geracao,
    resumo: await resumo()
  }));

  /** Gera (ou gera de novo, do zero) — responde na hora; o progresso vem pelo GET. */
  app.post('/api/dev/demonstracao/gerar', { config: ROTA }, async (req, res) => {
    if (geracao.rodando) throw new RegraDeNegocio('A demonstração já está sendo gerada.');
    Object.assign(geracao, { rodando: true, etapa: 'Preparando', pct: 1, erro: null, terminouEm: null });
    const tenantOrigem = req.tenantId;
    const quem = req.usuario;

    // Fora da resposta: gerar leva alguns segundos e a tela mostra o avanco.
    setImmediate(async () => {
      try {
        await apagarArquivo();
        const { db } = await abrir();
        const r = await gerarDemonstracao({
          destino: db,
          origem: dbReal,
          tenantOrigem,
          progresso: (etapa, pct) => Object.assign(geracao, { etapa, pct })
        });
        // Reabre: a conexao guarda o id da empresa ficticia, que so agora existe.
        fechar();
        await abrir();
        log.info({ contagem: r.contagem }, 'Demonstracao gerada');
        await registrarAuditoria({ tenantId: tenantOrigem, usuario: quem, acao: 'demonstracao.gerar', entidade: 'demonstracao', dados: r.contagem });
      } catch (err) {
        log.error({ err }, 'Falha ao gerar a demonstracao');
        geracao.erro = String(err?.message ?? err).slice(0, 300);
      } finally {
        Object.assign(geracao, { rodando: false, terminouEm: new Date() });
      }
    });

    res.status(202);
    return { geracao };
  });

  /** Liga a demonstracao NESTE navegador. */
  app.post('/api/dev/demonstracao/entrar', { config: ROTA }, async (req, res) => {
    if (geracao.rodando) throw new RegraDeNegocio('Espere a demonstração terminar de ser gerada.');
    if (!existe()) throw new RegraDeNegocio('Gere o banco de demonstração primeiro.');
    await espelharUsuario(req.usuario);
    res.setCookie(COOKIE_DEMONSTRACAO, '1', opcoesCookie);
    return { ativo: true };
  });

  /** Volta para o banco de verdade. Funciona de dentro da demonstracao. */
  app.post('/api/dev/demonstracao/sair', { config: ROTA }, async (req, res) => {
    res.clearCookie(COOKIE_DEMONSTRACAO, { path: '/' });
    return { ativo: false };
  });

  /** Apaga o arquivo da demonstracao do disco. */
  app.delete('/api/dev/demonstracao', { config: ROTA }, async (req, res) => {
    if (geracao.rodando) throw new RegraDeNegocio('Espere a geração terminar para excluir.');
    const liberados = existe() ? await apagarArquivo() : 0;
    res.clearCookie(COOKIE_DEMONSTRACAO, { path: '/' });
    await registrarAuditoria({ tenantId: req.tenantId, usuario: req.usuario, acao: 'demonstracao.excluir', entidade: 'demonstracao', dados: { liberados } });
    return { liberados };
  });
}
