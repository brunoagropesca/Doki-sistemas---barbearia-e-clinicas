import { and, eq, ne } from 'drizzle-orm';
import * as s from '../../db/schema/index.js';
import { ID } from '../../core/ids.js';
import { gerarHashSenha } from '../../core/crypto.js';
import { FUSO_PADRAO } from '../../core/datetime.js';

/**
 * Gera a empresa de DEMONSTRACAO: 3 meses de movimento de um salao/barbearia
 * com 20 profissionais, 5 atendentes, 40 servicos e 110 produtos — e muitos
 * casos diferentes (conversas com a IA, na fila, com atendente, reclamacao,
 * menu; faltas, cancelamentos, remarcacoes; campanhas em varios estados;
 * estoque zerado e abaixo do minimo...). Tudo para mostrar TODAS as funcoes.
 *
 * Insere direto nas tabelas, em lotes, dentro de uma transacao: pelos
 * servicos do sistema levaria muitos minutos e dispararia efeitos (WhatsApp,
 * IA) que aqui nao podem acontecer.
 *
 * Deterministico (semente fixa): gerar de novo produz a mesma empresa, o que
 * ajuda a ensaiar uma apresentacao.
 *
 * @param {object} p
 * @param {import('drizzle-orm/libsql').LibSQLDatabase} p.destino   banco de demonstracao (vazio, migrado)
 * @param {import('drizzle-orm/libsql').LibSQLDatabase} p.origem    banco real (so para COPIAR configuracao de IA e menu)
 * @param {string} p.tenantOrigem
 * @param {(etapa:string, pct:number) => void} [p.progresso]
 */
export async function gerarDemonstracao({ destino, origem, tenantOrigem, progresso = () => {} }) {
  let semente = 20260924;
  const rnd = () => (semente = (semente * 16807) % 2147483647) / 2147483647;
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const um = (lista) => lista[Math.floor(rnd() * lista.length)];
  const chance = (p) => rnd() < p;
  const pesado = (pares) => {
    const total = pares.reduce((t, [, p]) => t + p, 0);
    let r = rnd() * total;
    for (const [v, p] of pares) if ((r -= p) <= 0) return v;
    return pares[0][0];
  };

  const MIN = 60_000;
  const HORA = 3_600_000;
  const DIA = 86_400_000;
  const agora = Date.now();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_PADRAO });
  const dataLocal = (ms) => fmt.format(new Date(ms));
  // Instante de uma data local + hora (Sao Paulo = UTC-3, sem horario de verao).
  const instante = (data, h, m = 0) => {
    const [a, mes, d] = data.split('-').map(Number);
    return new Date(Date.UTC(a, mes - 1, d, h + 3, m));
  };
  const diaSemana = (data) => new Date(`${data}T12:00:00Z`).getUTCDay();
  const somaDias = (data, n) => dataLocal(Date.parse(`${data}T15:00:00Z`) + n * DIA);
  const hoje = dataLocal(agora);

  const T = ID.tenant();
  const linhas = {}; // nome da tabela -> linhas (inseridas em lote no fim)
  const add = (tabela, linha) => (linhas[tabela] ??= []).push(linha);

  // ==========================================================================
  // EMPRESA, EQUIPE DO SISTEMA, CONEXOES
  // ==========================================================================
  progresso('Empresa e equipe', 3);
  add('tenants', { id: T, nome: 'Estilo & Arte (Demonstração)', slug: 'demonstracao', segmento: 'barbearia', fusoHorario: FUSO_PADRAO });

  const senha = await gerarHashSenha('demo@1234');
  const usuario = (nome, username, cargo, extra = {}) => {
    const u = { id: ID.usuario(), tenantId: T, nome, username, cargo, passwordHash: senha, statusPresenca: 'offline', capacidadeSimultanea: 6, ativo: true, ...extra };
    add('users', u);
    return u;
  };
  const dono = usuario('Rodrigo Andrade', 'dono', 'owner', { statusPresenca: 'online', email: 'rodrigo@estiloearte.com.br' });
  const gerente = usuario('Paula Mendes', 'paula', 'admin', { statusPresenca: 'online' });
  const atendentes = [
    usuario('Beatriz Lima', 'beatriz', 'atendente', { statusPresenca: 'online', capacidadeSimultanea: 6 }),
    usuario('Camila Rocha', 'camila', 'atendente', { statusPresenca: 'online', capacidadeSimultanea: 5 }),
    usuario('Diego Martins', 'diego', 'atendente', { statusPresenca: 'ausente', capacidadeSimultanea: 4 }),
    usuario('Larissa Souza', 'larissa', 'atendente', { statusPresenca: 'online', capacidadeSimultanea: 6 }),
    usuario('Thiago Alves', 'thiago', 'atendente', { statusPresenca: 'offline', capacidadeSimultanea: 5 })
  ];
  const equipeSistema = [dono, gerente, ...atendentes];

  const W1 = { id: ID.canal(), tenantId: T, canal: 'whatsapp', chave: 'W1', nome: 'Recepção', status: 'conectado', identificador: '5511987650001', nomePerfil: 'Estilo & Arte', ativo: true };
  const W2 = { id: ID.canal(), tenantId: T, canal: 'whatsapp', chave: 'W2', nome: 'Unidade Centro', status: 'conectado', identificador: '5511987650002', nomePerfil: 'Estilo & Arte Centro', ativo: true };
  add('channelInstances', W1);
  add('channelInstances', W2);

  for (const [i, a] of atendentes.entries()) {
    const respostas = [
      ['ola', '{saudacao}, {nome}! Aqui é {atendente}, da Estilo & Arte. Como posso te ajudar? 😊'],
      ['horarios', 'Nosso horário: segunda a sexta das 9h às 20h e sábado das 8h às 17h.'],
      ['pix', 'Nosso Pix é o CNPJ 12.345.678/0001-90 (Estilo & Arte LTDA). Pode mandar o comprovante por aqui!'],
      ['obrigado', 'Imagina, {nome}! Qualquer coisa é só chamar. Até logo! 💈']
    ];
    for (const [atalho, texto] of respostas.slice(0, 3 + (i % 2))) {
      add('quickReplies', { id: ID.respostaRapida(), tenantId: T, userId: a.id, atalho, texto });
    }
  }

  // ==========================================================================
  // CATALOGO: 40 SERVICOS E 110 PRODUTOS
  // ==========================================================================
  progresso('Catálogo', 8);
  const SERVICOS = [
    // [categoria, nome, preco, minutos]
    ['Cabelo', 'Corte Social', 45, 30], ['Cabelo', 'Corte Degradê', 55, 40], ['Cabelo', 'Corte Tesoura', 60, 45],
    ['Cabelo', 'Corte Navalhado', 65, 45], ['Cabelo', 'Corte Feminino Curto', 80, 45], ['Cabelo', 'Corte Feminino Longo', 110, 60],
    ['Cabelo', 'Escova Simples', 50, 40], ['Cabelo', 'Escova Modelada', 70, 50], ['Cabelo', 'Pezinho', 20, 15],
    ['Barba', 'Barba Tradicional', 35, 30], ['Barba', 'Barba Terapia', 45, 40], ['Barba', 'Barba Desenhada', 40, 30],
    ['Barba', 'Pigmentação de Barba', 60, 40],
    ['Combo', 'Corte + Barba', 85, 70], ['Combo', 'Corte + Barba + Sobrancelha', 100, 80], ['Combo', 'Dia do Noivo', 280, 180],
    ['Química', 'Luzes', 250, 150], ['Química', 'Coloração', 150, 90], ['Química', 'Progressiva', 280, 180],
    ['Química', 'Platinado', 320, 200], ['Química', 'Selagem', 180, 120], ['Química', 'Botox Capilar', 160, 90],
    ['Unhas', 'Manicure', 35, 40], ['Unhas', 'Pedicure', 40, 45], ['Unhas', 'Pé e Mão', 70, 80],
    ['Unhas', 'Esmaltação em Gel', 80, 60], ['Unhas', 'Alongamento de Unhas', 180, 120],
    ['Estética', 'Limpeza de Pele', 140, 60], ['Estética', 'Peeling', 180, 60], ['Estética', 'Depilação Facial', 40, 20],
    ['Estética', 'Massagem Relaxante', 150, 60],
    ['Sobrancelha', 'Design de Sobrancelha', 45, 30], ['Sobrancelha', 'Design com Henna', 60, 40], ['Sobrancelha', 'Micropigmentação', 450, 120],
    ['Infantil', 'Corte Infantil', 40, 30], ['Infantil', 'Corte Infantil + Desenho', 50, 40],
    ['Tratamento', 'Hidratação', 90, 45], ['Tratamento', 'Cauterização', 140, 60], ['Tratamento', 'Cronograma Capilar (sessão)', 120, 60],
    ['Spa', 'Spa dos Pés', 90, 50]
  ];
  const servicos = SERVICOS.map(([categoria, nome, preco, duracao]) => {
    const sv = { id: ID.servico(), tenantId: T, nome, categoria, precoCentavos: preco * 100, duracaoMinutos: duracao, descricao: '', ativo: true };
    add('services', sv);
    return sv;
  });
  const porCategoria = (...cats) => servicos.filter((x) => cats.includes(x.categoria));

  const PRODUTOS_BASE = {
    'Cabelo': ['Shampoo Anticaspa', 'Shampoo Hidratante', 'Condicionador Nutritivo', 'Máscara de Hidratação', 'Leave-in Protetor', 'Óleo Reparador de Pontas', 'Shampoo Matizador', 'Tônico Antiqueda', 'Sérum Antifrizz', 'Ampola de Reconstrução'],
    'Finalização': ['Pomada Modeladora Matte', 'Pomada Brilho Molhado', 'Cera Modeladora', 'Gel Fixação Forte', 'Spray Fixador', 'Pó Texturizador', 'Mousse Modelador', 'Creme para Pentear'],
    'Barba': ['Óleo para Barba', 'Balm para Barba', 'Shampoo para Barba', 'Cera para Bigode', 'Tônico de Crescimento', 'Pente de Madeira para Barba', 'Escova de Javali'],
    'Pele': ['Hidratante Facial', 'Protetor Solar FPS 50', 'Sabonete Facial Carvão', 'Esfoliante Facial', 'Pós-barba Calmante', 'Máscara Argila Verde'],
    'Unhas': ['Esmalte Vermelho Clássico', 'Esmalte Nude', 'Base Fortalecedora', 'Óleo de Cutícula', 'Top Coat Brilho', 'Removedor sem Acetona'],
    'Acessórios': ['Pente Carbono', 'Escova Raquete', 'Touca de Cetim', 'Prendedor de Cabelo', 'Kit Viagem'],
    'Perfumaria': ['Perfume Masculino Amadeirado', 'Perfume Feminino Floral', 'Body Splash', 'Desodorante Natural']
  };
  const VARIANTES = ['100ml', '250ml', '500ml', 'Kit'];
  const produtos = [];
  for (const [categoria, nomes] of Object.entries(PRODUTOS_BASE)) {
    for (const nome of nomes) {
      const variantes = categoria === 'Acessórios' || categoria === 'Perfumaria' ? [''] : VARIANTES.slice(0, int(2, 3));
      for (const v of variantes) {
        if (produtos.length >= 112) break;
        const preco = int(18, 140) * 100 + pesado([[0, 3], [90, 2], [50, 1]]);
        const estoqueMinimo = int(3, 8);
        const estoque = pesado([[int(10, 45), 8], [int(1, estoqueMinimo), 2], [0, 1]]);
        const pr = {
          id: ID.produto(),
          tenantId: T,
          nome: v ? `${nome} ${v}` : nome,
          categoria,
          sku: `EA-${String(produtos.length + 1).padStart(4, '0')}`,
          precoCentavos: preco,
          custoCentavos: Math.round(preco * (0.4 + rnd() * 0.2)),
          estoque,
          estoqueMinimo,
          ativo: !chance(0.04),
          descricao: ''
        };
        produtos.push(pr);
        add('products', pr);
        add('stockMovements', { id: ID.produto().replace('prod', 'mov'), tenantId: T, productId: pr.id, tipo: 'entrada', quantidade: estoque + int(8, 30), estoqueResultante: estoque + int(8, 30), motivo: 'Estoque inicial', createdAt: new Date(agora - 95 * DIA) });
      }
    }
  }

  // ==========================================================================
  // 20 PROFISSIONAIS
  // ==========================================================================
  progresso('Profissionais', 12);
  const J = (dias, inicio, fim) => Object.fromEntries(dias.map((d) => [d, [{ inicio, fim }]]));
  const JORNADAS = [
    { ...J([1, 2, 3, 4, 5], '09:00', '18:00'), ...J([6], '08:00', '14:00') },
    { ...J([2, 3, 4, 5], '10:00', '20:00'), ...J([6], '08:00', '17:00') },
    { ...J([1, 3, 5], '13:00', '21:00'), ...J([6], '09:00', '17:00') },
    { ...J([2, 4, 6], '09:00', '19:00') },
    { ...J([1, 2, 3, 4, 5, 6], '09:00', '17:00') }
  ];
  const PROFS = [
    ['Carlos Mendes', 'Barbeiro', ['Cabelo', 'Barba', 'Combo', 'Infantil']],
    ['Rafael Lima', 'Barbeiro', ['Cabelo', 'Barba', 'Combo']],
    ['André Souza', 'Barbeiro', ['Cabelo', 'Barba', 'Combo', 'Infantil']],
    ['Bruno Ferreira', 'Barbeiro', ['Cabelo', 'Barba', 'Combo']],
    ['Lucas Oliveira', 'Barbeiro', ['Cabelo', 'Barba']],
    ['Mateus Costa', 'Barbeiro', ['Cabelo', 'Barba', 'Combo', 'Infantil']],
    ['Julia Rocha', 'Cabeleireira', ['Cabelo', 'Tratamento', 'Química']],
    ['Fernanda Dias', 'Cabeleireira', ['Cabelo', 'Tratamento', 'Química']],
    ['Mariana Castro', 'Colorista', ['Química', 'Tratamento']],
    ['Aline Martins', 'Cabeleireira', ['Cabelo', 'Tratamento', 'Infantil']],
    ['Patrícia Gomes', 'Manicure', ['Unhas', 'Spa']],
    ['Renata Alves', 'Manicure', ['Unhas', 'Spa']],
    ['Vanessa Ribeiro', 'Manicure', ['Unhas']],
    ['Tatiane Nunes', 'Esteticista', ['Estética', 'Sobrancelha']],
    ['Gabriela Pinto', 'Esteticista', ['Estética', 'Spa']],
    ['Débora Freitas', 'Designer de Sobrancelha', ['Sobrancelha']],
    ['Ricardo Moura', 'Barbeiro', ['Cabelo', 'Barba', 'Combo']],
    ['Felipe Araújo', 'Barbeiro', ['Cabelo', 'Barba']],
    ['Camila Teixeira', 'Terapeuta Capilar', ['Tratamento', 'Química']],
    ['Sônia Barros', 'Cabeleireira', ['Cabelo', 'Química']]
  ];
  const CORES = ['#1856FF', '#07CA6B', '#E89558', '#EA2143', '#38BDF8', '#A78BFA', '#F472B6', '#FBBF24'];
  const profissionais = PROFS.map(([nome, funcao, cats], i) => {
    const p = {
      id: ID.profissional(),
      tenantId: T,
      nome,
      funcao,
      cor: CORES[i % CORES.length],
      telefone: `55119${String(81000000 + i * 7331).slice(-8)}`,
      jornada: { dias: JORNADAS[i % JORNADAS.length], intervaloMinutos: 30 },
      ativo: i !== 19, // uma profissional que saiu (aparece nos inativos e no historico)
      observacoes: '',
      // Dois barbeiros tambem usam o sistema.
      userId: i === 0 ? gerente.id : null,
      servicosCats: cats
    };
    const { servicosCats: _c, ...linhaProf } = p;
    add('professionals', linhaProf);
    for (const sv of porCategoria(...cats)) {
      const proprio = chance(0.15);
      add('professionalServices', {
        tenantId: T,
        professionalId: p.id,
        serviceId: sv.id,
        precoCentavos: proprio ? sv.precoCentavos + int(1, 3) * 500 : null,
        duracaoMinutos: null
      });
    }
    return p;
  });
  // Ferias de uma manicure e almoco estendido de um barbeiro.
  add('scheduleBlocks', { id: ID.agendamento().replace('appt', 'blk'), tenantId: T, professionalId: profissionais[11].id, motivo: 'Férias', inicioEm: instante(somaDias(hoje, 3), 0), fimEm: instante(somaDias(hoje, 12), 23) });
  add('scheduleBlocks', { id: ID.agendamento().replace('appt', 'blk'), tenantId: T, professionalId: profissionais[2].id, motivo: 'Consulta médica', inicioEm: instante(somaDias(hoje, 1), 14), fimEm: instante(somaDias(hoje, 1), 16) });

  // ==========================================================================
  // CLIENTES
  // ==========================================================================
  progresso('Clientes', 16);
  const NOMES_M = ['Lucas', 'Pedro', 'Gabriel', 'Mateus', 'João', 'Rafael', 'Bruno', 'Thiago', 'Felipe', 'André', 'Diego', 'Vinícius', 'Caio', 'Renato', 'Igor', 'Marcelo', 'Eduardo', 'Henrique', 'Leonardo', 'Gustavo', 'Daniel', 'Rodrigo', 'Fábio', 'Samuel', 'Otávio'];
  const NOMES_F = ['Ana', 'Beatriz', 'Carla', 'Daniela', 'Eduarda', 'Fernanda', 'Gabriela', 'Helena', 'Isabela', 'Juliana', 'Karina', 'Larissa', 'Mariana', 'Natália', 'Olívia', 'Paula', 'Rafaela', 'Sabrina', 'Tatiana', 'Vitória'];
  const SOBRENOMES = ['Silva', 'Souza', 'Costa', 'Santos', 'Oliveira', 'Pereira', 'Almeida', 'Ferreira', 'Ribeiro', 'Carvalho', 'Gomes', 'Martins', 'Araújo', 'Barbosa', 'Rocha', 'Dias', 'Nunes', 'Moreira', 'Teixeira', 'Cardoso'];
  const TAGS = ['vip', 'alergia', 'indicação', 'fiel', 'infantil', 'noivo', 'pontual', 'prefere tarde'];
  const OBS = ['Alérgico a produto com álcool.', 'Prefere o Carlos.', 'Gosta do degradê bem baixo.', 'Sempre traz o filho junto.', 'Paga no Pix.', 'Não gosta de conversar durante o corte.', 'Cliente desde a inauguração.', ''];
  const clientes = [];
  // ~2.400 clientes para ~2.300 atendimentos por mes: cada um volta a cada
  // 3-5 semanas, como numa barbearia de verdade (com 460, o "top cliente"
  // aparecia 16 vezes em 30 dias).
  for (let i = 0; i < 2400; i++) {
    const fem = chance(0.4);
    const nome = `${um(fem ? NOMES_F : NOMES_M)} ${um(SOBRENOMES)}`;
    const criado = agora - (chance(0.55) ? int(95, 400) : int(0, 94)) * DIA - int(0, 20) * HORA;
    const c = {
      id: ID.lead(),
      tenantId: T,
      nome,
      telefone: `55119${String(60000000 + i * 104729).slice(-8)}`,
      origem: pesado([['whatsapp', 8], ['manual', 2], ['campanha', 1], ['indicacao', 1]]),
      tags: chance(0.35) ? [...new Set([um(TAGS), ...(chance(0.3) ? [um(TAGS)] : [])])] : [],
      observacoes: chance(0.25) ? um(OBS) : '',
      aceitaCampanha: !chance(0.06),
      iaAtiva: !chance(0.04),
      humor: chance(0.4) ? pesado([['satisfeito', 6], ['neutro', 3], ['duvida', 1], ['frustrado', 1]]) : null,
      createdAt: new Date(criado),
      ultimoContatoEm: new Date(Math.min(agora, criado + int(0, 60) * DIA)),
      // Ritmo de volta: fieis voltam a cada 2-4 semanas; os demais, raramente.
      fiel: chance(0.3),
      // Parte dos fieis some no ultimo mes e meio: alimenta "clientes em risco".
      sumiu: chance(0.08),
      fem
    };
    clientes.push(c);
  }
  for (const { fiel: _f, fem: _m, sumiu: _s, ...c } of clientes) add('leads', c);
  // Por ordem de cadastro: a agenda so atende quem ja existe naquele dia.
  const porCadastro = [...clientes].sort((a, b) => a.createdAt - b.createdAt);
  const INICIO_JANELA = agora - 95 * DIA;

  // ==========================================================================
  // AGENDA: 90 DIAS PASSADOS + 14 FUTUROS (agendamentos e historico)
  // ==========================================================================
  progresso('Agenda de 3 meses', 22);
  const PESO_DIA = [0, 0.75, 0.8, 0.9, 1, 1.25, 1.45];
  const MOTIVOS = ['Imprevisto no trabalho', 'Remarcou para outro dia', 'Ficou doente', 'Chuva forte', 'Problema com o carro', 'Viagem de última hora'];
  const visitas = new Map();
  // Agendamentos marcados pela Sofia, por dia em que foram marcados: cada
  // conversa "agendou" do historico fica ligada a um deles.
  const marcadosPelaIa = new Map();
  let contAtend = 0;
  const existentes = [];
  const fieisExistentes = [];
  let ponteiro = 0;

  for (let d = -90; d <= 14; d++) {
    const data = somaDias(hoje, d);
    const dow = diaSemana(data);
    const fimDoDiaMs = instante(data, 23, 59).getTime();
    while (ponteiro < porCadastro.length && porCadastro[ponteiro].createdAt.getTime() <= fimDoDiaMs) {
      const c = porCadastro[ponteiro++];
      existentes.push(c);
      if (c.fiel) fieisExistentes.push(c);
    }
    if (dow === 0) continue;
    const futuro = d > 0;
    const crescimento = 1 + (d + 90) / 260;
    for (const prof of profissionais) {
      if (!prof.ativo && d > -20) continue;
      const faixa = prof.jornada.dias[dow]?.[0];
      if (!faixa) continue;
      const [hi] = faixa.inicio.split(':').map(Number);
      const [hf] = faixa.fim.split(':').map(Number);
      // Ocupacao de 45-85% (mais cheio sexta/sabado); futuro vai esvaziando.
      const lotacao = Math.min(0.92, 0.45 * PESO_DIA[dow] * crescimento * (futuro ? Math.max(0.15, 1 - d / 12) : 1));
      let minuto = hi * 60 + int(0, 1) * 30;
      while (minuto < hf * 60 - 30) {
        const opcoes = servicos.filter((sv) => prof.servicosCats.includes(sv.categoria));
        const sv = pesado(opcoes.map((x) => [x, x.precoCentavos < 10000 ? 5 : 1]));
        if (!chance(lotacao)) {
          minuto += 30;
          continue;
        }
        if (minuto + sv.duracaoMinutos > hf * 60) break;
        let cliente = chance(0.45) && fieisExistentes.length ? um(fieisExistentes) : um(existentes);
        for (let tenta = 0; cliente.sumiu && d > -50 && tenta < 5; tenta++) cliente = um(existentes);
        const ini = instante(data, Math.floor(minuto / 60), minuto % 60);
        const fim = new Date(ini.getTime() + sv.duracaoMinutos * MIN);
        const ehHoje = d === 0;
        const passou = fim.getTime() < agora;
        let status;
        if (futuro || (ehHoje && !passou)) {
          status = ehHoje && ini.getTime() < agora ? 'em_andamento' : pesado([['confirmado', 3], ['pendente', 2]]);
        } else {
          status = pesado([['concluido', 90], ['faltou', 4], ['cancelado', 6]]);
        }
        const desconto = status === 'concluido' && chance(0.07) ? int(1, 3) * 500 : 0;
        const origemAg = pesado([['humano', 30], ['ia', 8], ['cliente', 12]]);
        const criadoEm = new Date(ini.getTime() - int(2, 120) * HORA);
        const ap = {
          id: ID.agendamento(),
          tenantId: T,
          leadId: cliente.id,
          serviceId: sv.id,
          professionalId: prof.id,
          inicioEm: ini,
          fimEm: fim,
          status,
          precoCentavos: sv.precoCentavos,
          descontoCentavos: desconto,
          criadoPor: origemAg,
          responsavelUserId: origemAg === 'humano' ? um(atendentes).id : null,
          confirmadoEm: status !== 'pendente' ? new Date(criadoEm.getTime() + HORA) : null,
          concluidoEm: status === 'concluido' ? fim : null,
          canceladoEm: status === 'cancelado' ? new Date(ini.getTime() - int(1, 30) * HORA) : null,
          motivoCancelamento: status === 'cancelado' ? um(MOTIVOS) : null,
          observacoes: chance(0.05) ? 'Cliente pediu para usar produto sem perfume.' : '',
          createdAt: criadoEm
        };
        add('appointments', ap);
        if (origemAg === 'ia' && criadoEm.getTime() < agora) {
          const dia = dataLocal(criadoEm.getTime());
          if (!marcadosPelaIa.has(dia)) marcadosPelaIa.set(dia, []);
          marcadosPelaIa.get(dia).push({ ap, sv, prof, dow, minuto });
        }

        if (['concluido', 'faltou', 'cancelado'].includes(status)) {
          const anteriores = visitas.get(cliente.id) ?? 0;
          if (status === 'concluido') visitas.set(cliente.id, anteriores + 1);
          const valor = status === 'concluido' ? sv.precoCentavos - desconto : 0;
          add('serviceHistory', {
            id: ID.historico(),
            tenantId: T,
            appointmentId: ap.id,
            resultado: status,
            professionalId: prof.id,
            professionalNome: prof.nome,
            serviceId: sv.id,
            serviceNome: sv.nome,
            serviceCategoria: sv.categoria,
            leadId: cliente.id,
            clienteNovo: status === 'concluido' && anteriores === 0 && cliente.createdAt.getTime() >= INICIO_JANELA,
            precoCentavos: sv.precoCentavos,
            descontoCentavos: desconto,
            valorCentavos: valor,
            precoTabelaCentavos: sv.precoCentavos,
            duracaoMinutos: sv.duracaoMinutos,
            inicioEm: ini,
            encerradoEm: fim,
            dataLocal: data,
            diaSemana: dow,
            horaLocal: Math.floor(minuto / 60),
            antecedenciaHoras: Math.round((ini.getTime() - criadoEm.getTime()) / HORA),
            origem: origemAg,
            responsavelUserId: ap.responsavelUserId,
            humor: chance(0.3) ? pesado([['satisfeito', 7], ['neutro', 2], ['frustrado', 1]]) : null,
            motivoCancelamento: ap.motivoCancelamento
          });
          contAtend++;

          // Venda no balcao depois de ~1 em 5 atendimentos.
          if (status === 'concluido' && chance(0.2)) {
            const pr = um(produtos.filter((x) => x.ativo));
            const qtd = pesado([[1, 7], [2, 2], [3, 1]]);
            const vendaId = ID.venda();
            add('productSales', {
              id: vendaId,
              tenantId: T,
              leadId: cliente.id,
              productId: pr.id,
              appointmentId: ap.id,
              quantidade: qtd,
              precoUnitarioCentavos: pr.precoCentavos,
              totalCentavos: pr.precoCentavos * qtd,
              vendidoPorUserId: um(atendentes).id,
              vendidoEm: new Date(fim.getTime() + int(1, 10) * MIN)
            });
            add('stockMovements', { id: ID.produto().replace('prod', 'mov'), tenantId: T, productId: pr.id, tipo: 'venda', quantidade: -qtd, estoqueResultante: pr.estoque, motivo: 'Venda no balcão', referenciaId: vendaId, createdAt: new Date(fim.getTime() + 5 * MIN) });
          }
        }
        minuto += sv.duracaoMinutos + (chance(0.3) ? 30 : 0);
      }
    }
  }
  // Algumas perdas e reposicoes de estoque.
  for (const pr of produtos.slice(0, 18)) {
    add('stockMovements', { id: ID.produto().replace('prod', 'mov'), tenantId: T, productId: pr.id, tipo: chance(0.5) ? 'perda' : 'entrada', quantidade: chance(0.5) ? -int(1, 3) : int(6, 24), estoqueResultante: pr.estoque, motivo: chance(0.5) ? 'Embalagem danificada' : 'Reposição do fornecedor', createdAt: new Date(agora - int(1, 80) * DIA) });
  }

  // ==========================================================================
  // CONVERSAS DO WHATSAPP (historico + as abertas agora na mesa)
  // ==========================================================================
  progresso('Conversas do WhatsApp', 45);
  const primeiroNome = (c) => c.nome.split(' ')[0];
  const ROTEIROS = [
    {
      chave: 'agendou_ia',
      peso: 6,
      resumo: (c, x) => `${primeiroNome(c)} pediu um horário para ${x.servico}. A Sofia ofereceu opções e marcou ${x.dia} às ${x.hora} com ${x.prof}.`,
      msgs: (c, x) => [
        ['lead', `Oi, boa tarde! Queria marcar ${x.servico.toLowerCase()} pra ${x.dia}`],
        ['ia', `Oi, ${primeiroNome(c)}! 😊 Claro! ${x.dia[0].toUpperCase() + x.dia.slice(1)} tenho *${x.hora}* com ${x.prof} ou *${x.hora2}* com ${x.prof2}. Qual fica melhor?`],
        ['lead', `${x.hora} pode ser`],
        ['ia', `Prontinho! ✅ ${x.servico} marcado para ${x.dia} às *${x.hora}* com ${x.prof}. Te espero!`],
        ['lead', 'Valeu! 👍']
      ]
    },
    {
      chave: 'preco',
      peso: 4,
      resumo: (c, x) => `Perguntou o preço de ${x.servico} (${x.preco}). Não marcou horário.`,
      msgs: (c, x) => [
        ['lead', `Quanto tá ${x.servico.toLowerCase()}?`],
        ['ia', `${x.servico} sai por *${x.preco}* e leva uns ${x.minutos} minutos. Quer que eu veja um horário pra você?`],
        ['lead', 'Vou ver minha agenda e te falo']
      ]
    },
    {
      chave: 'menu',
      peso: 3,
      resumo: (c) => `${primeiroNome(c)} navegou pelo menu e consultou o horário de funcionamento.`,
      msgs: () => [
        ['lead', 'oi'],
        ['menu', 'Olá! 👋 Seja bem-vindo(a) à *Estilo & Arte*! ✂️\n\n1️⃣ *Agendar um horário*\n2️⃣ *Serviços e preços*\n3️⃣ *Meu agendamento*\n4️⃣ *Endereço e informações*\n5️⃣ *Falar com um atendente*\n\n_Digite o número da opção desejada._'],
        ['lead', '4'],
        ['menu', 'ℹ️ *Informações da barbearia*\n\n1️⃣ *Endereço e como chegar*\n2️⃣ *Horário de funcionamento*\n3️⃣ *Formas de pagamento*\n0️⃣ *Voltar*'],
        ['lead', '2'],
        ['menu', '🕐 *Horário de funcionamento*\n\nSegunda a sexta: 9h às 20h\nSábado: 8h às 17h\nDomingo: fechado']
      ]
    },
    {
      chave: 'reclamacao',
      peso: 1,
      humano: true,
      humor: 'frustrado',
      resumo: (c, x) => `Reclamou do ${x.servico.toLowerCase()} feito com ${x.prof}. ${x.atendente} ofereceu um retoque sem custo e o cliente aceitou.`,
      msgs: (c, x) => [
        ['lead', `O ${x.servico.toLowerCase()} de ontem ficou torto do lado esquerdo 😕`],
        ['ia', 'Poxa, sinto muito por isso! 😔 Me conta: foi com qual profissional?'],
        ['lead', `Com ${x.prof}`],
        ['ia', 'Entendi. Vou passar agora para alguém da equipe resolver isso com você.'],
        ['sistema', 'Conversa encaminhada para a fila — cliente frustrado.'],
        ['humano', `Oi, ${primeiroNome(c)}, aqui é ${x.atendente}. Pode vir hoje às 17h que ${x.prof} ajeita sem custo nenhum, tudo bem?`],
        ['lead', 'Pode ser, obrigado pela atenção']
      ]
    },
    {
      chave: 'remarcar',
      peso: 2,
      resumo: (c, x) => `Pediu para remarcar o horário. A Sofia moveu para ${x.dia} às ${x.hora}.`,
      msgs: (c, x) => [
        ['lead', 'Oi! Vou precisar remarcar meu horário, surgiu um imprevisto'],
        ['ia', `Sem problemas, ${primeiroNome(c)}! Tenho ${x.dia} às *${x.hora}* ou *${x.hora2}*. Qual prefere?`],
        ['lead', x.hora],
        ['ia', `Feito! 🔄 Seu horário agora é ${x.dia} às *${x.hora}*.`]
      ]
    },
    {
      chave: 'pix',
      peso: 2,
      resumo: () => 'Perguntou a chave Pix e o endereço. Respondido com a base de conhecimento.',
      msgs: () => [
        ['lead', 'Qual o pix de vocês? E o endereço?'],
        ['ia', 'Nosso Pix é o CNPJ *12.345.678/0001-90* (Estilo & Arte LTDA) 😉\n\n📍 Rua das Palmeiras, 210 — Centro, ao lado da padaria Pão Quente.'],
        ['lead', 'Perfeito, obrigado!']
      ]
    },
    {
      chave: 'pediu_pessoa',
      peso: 2,
      humano: true,
      resumo: (c, x) => `Pediu para falar com uma pessoa sobre ${x.servico.toLowerCase()}. ${x.atendente} tirou as dúvidas e passou o valor.`,
      msgs: (c, x) => [
        ['lead', 'Quero falar com uma pessoa'],
        ['ia', 'Claro! Já chamo alguém da equipe. 🙏'],
        ['humano', `Oi, ${primeiroNome(c)}! Aqui é ${x.atendente}. Em que posso ajudar?`],
        ['lead', `Vocês fazem ${x.servico.toLowerCase()}? Quanto fica?`],
        ['humano', `Fazemos sim! Sai por ${x.preco}. Quer que eu reserve um horário?`],
        ['lead', 'Quero sim, sexta à tarde']
      ]
    },
    {
      chave: 'produto',
      peso: 1,
      resumo: (c, x) => `Perguntou sobre ${x.produto}. Separado para retirar na loja.`,
      msgs: (c, x) => [
        ['lead', `Vocês vendem ${x.produto.toLowerCase()}?`],
        ['ia', `Temos sim: *${x.produto}* por ${x.precoProduto}. Quer que eu separe um pra você retirar?`],
        ['lead', 'Separa sim, passo amanhã']
      ]
    },
    {
      chave: 'cancelou',
      peso: 1,
      resumo: () => 'Cancelou o horário por imprevisto. A Sofia ofereceu remarcar e o cliente disse que volta a chamar.',
      msgs: (c) => [
        ['lead', 'Preciso cancelar meu horário de amanhã'],
        ['ia', `Que pena, ${primeiroNome(c)}! 😕 Quer remarcar para outro dia sem custo?`],
        ['lead', 'Agora não, depois te chamo'],
        ['ia', 'Combinado! Cancelado. Quando quiser é só chamar. 💈']
      ]
    }
  ];

  const DIAS_TEXTO = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const horaTexto = () => `${int(9, 18)}h${pesado([['', 3], ['30', 2]])}`;
  const reais = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const detalhes = () => {
    const sv = um(servicos);
    const pr = um(produtos);
    return {
      servico: sv.nome,
      preco: reais(sv.precoCentavos),
      minutos: sv.duracaoMinutos,
      dia: um(DIAS_TEXTO.slice(1)),
      hora: horaTexto(),
      hora2: horaTexto(),
      prof: um(profissionais).nome.split(' ')[0],
      prof2: um(profissionais).nome.split(' ')[0],
      atendente: um(atendentes).nome.split(' ')[0],
      produto: pr.nome,
      precoProduto: reais(pr.precoCentavos)
    };
  };

  const abertosPorLead = new Set();
  function conversa({ cliente, roteiro, inicio, status, atendente, canal = W1, etapa = 'novo', naoLidas = 0, cortar = null, fixos = null }) {
    const x = { ...detalhes(), ...fixos };
    if (atendente) x.atendente = atendente.nome.split(' ')[0];
    let msgs = roteiro.msgs(cliente, x);
    if (cortar) msgs = msgs.slice(0, cortar);
    const id = ID.conversa();
    let t = inicio;
    let cli = 0;
    let ia = 0;
    let hum = 0;
    let primeira = null;
    for (const [autor, texto] of msgs) {
      t += (autor === 'lead' ? int(20, 180) : autor === 'humano' ? int(40, 400) : int(3, 12)) * 1000;
      if (autor === 'lead') cli++;
      else if (autor === 'humano') hum++;
      else if (autor === 'ia' || autor === 'menu') ia++;
      if (autor !== 'lead' && autor !== 'sistema' && primeira === null) primeira = Math.round((t - inicio) / 1000);
      add('messages', {
        id: ID.mensagem(),
        tenantId: T,
        conversationId: id,
        direcao: autor === 'lead' ? 'entrada' : 'saida',
        autorTipo: autor,
        autorUserId: autor === 'humano' ? atendente?.id ?? null : null,
        tipo: 'texto',
        conteudo: texto,
        entregueEm: autor === 'lead' ? null : new Date(t + 1000),
        createdAt: new Date(t)
      });
    }
    const ultima = msgs.at(-1);
    add('conversations', {
      id,
      tenantId: T,
      leadId: cliente.id,
      channelInstanceId: canal.id,
      canal: 'whatsapp',
      status,
      assignedUserId: atendente?.id ?? null,
      assumidaEm: atendente ? new Date(inicio + 2 * MIN) : null,
      ultimaMensagemPreview: ultima[1].slice(0, 120),
      ultimaMensagemEm: new Date(t),
      naoLidas,
      primeiraRespostaSegundos: primeira,
      totalMensagensCliente: cli,
      totalMensagensIa: ia,
      totalMensagensHumano: hum,
      etapaAtendimento: etapa,
      humor: roteiro.humor ?? (chance(0.5) ? pesado([['satisfeito', 6], ['neutro', 3], ['duvida', 2]]) : null),
      humorResumo: roteiro.humor === 'frustrado' ? 'Cliente insatisfeito com o resultado do serviço.' : null,
      anotacoesHumanas: atendente && chance(0.3) ? 'Cliente prefere ser atendido à tarde.' : '',
      resumo: status === 'finalizada' ? roteiro.resumo(cliente, x) : null,
      finalizadaEm: status === 'finalizada' ? new Date(t + int(5, 60) * MIN) : null,
      createdAt: new Date(inicio)
    });
    // Uso da IA por mensagem que ela respondeu.
    for (let k = 0; k < ia + (roteiro.chave === 'agendou_ia' ? 2 : 0); k++) {
      const ok = chance(0.97);
      add('aiCalls', {
        id: ID.mensagem().replace('msg', 'aic'),
        tenantId: T,
        origem: 'atendimento',
        agentKey: k > ia - 1 ? 'atena' : 'atendente',
        ...pesado([
          [{ provedor: 'gemini', modelo: 'gemini-2.5-flash' }, 7],
          [{ provedor: 'groq', modelo: 'llama-3.3-70b-versatile' }, 3]
        ]),
        sucesso: ok,
        latenciaMs: int(600, 3200),
        tokensEntrada: int(1400, 2600),
        tokensSaida: int(60, 260),
        erro: ok ? null : 'Tempo esgotado',
        conversationId: id,
        createdAt: new Date(inicio + k * 20_000)
      });
    }
    return id;
  }

  // Historico: ~30 conversas por dia util nos ultimos 90 dias. Quem conversa
  // ja e cliente cadastrado naquele dia.
  const hh = (minuto) => `${Math.floor(minuto / 60)}h${minuto % 60 ? String(minuto % 60).padStart(2, '0') : ''}`;
  for (let d = -90; d <= -1; d++) {
    const data = somaDias(hoje, d);
    const dow = diaSemana(data);
    const fimDoDiaMs = instante(data, 23, 59).getTime();
    const cadastrados = existentes.filter((c) => c.createdAt.getTime() <= fimDoDiaMs);
    const n = Math.round((dow === 0 ? 6 : 20 + PESO_DIA[dow] * 10) * (1 + (d + 90) / 300));
    const doDia = marcadosPelaIa.get(data) ?? [];
    for (let k = 0; k < n; k++) {
      const roteiro = pesado(ROTEIROS.map((r) => [r, r.peso]));
      const h = pesado([[8, 1], [9, 2], [10, 3], [11, 3], [12, 4], [13, 3], [14, 3], [15, 3], [16, 3], [17, 4], [18, 5], [19, 5], [20, 4], [21, 3], [22, 2], [23, 1]]);
      // "Agendou pela IA": a conversa e a do agendamento que a Sofia marcou —
      // mesmo cliente, servico, profissional e horario, e o agendamento aponta
      // para ela (e o que alimenta "conversas que viraram agendamento").
      const marcado = roteiro.chave === 'agendou_ia' ? doDia.pop() : null;
      if (marcado) {
        const { ap, sv, prof, dow: diaAg, minuto } = marcado;
        const id = conversa({
          cliente: clientes.find((c) => c.id === ap.leadId),
          roteiro,
          inicio: ap.createdAt.getTime() - int(2, 8) * MIN,
          status: 'finalizada',
          canal: chance(0.8) ? W1 : W2,
          fixos: { servico: sv.nome, prof: prof.nome.split(' ')[0], dia: DIAS_TEXTO[diaAg], hora: hh(minuto) }
        });
        ap.conversationId = id;
        continue;
      }
      conversa({
        cliente: um(cadastrados),
        roteiro,
        inicio: instante(data, h, int(0, 59)).getTime(),
        status: 'finalizada',
        atendente: roteiro.humano ? um(atendentes) : null,
        canal: chance(0.8) ? W1 : W2
      });
    }
  }

  // Mesa de hoje: conversas ABERTAS em todos os estados.
  progresso('Mesa de atendimento de hoje', 62);
  const livres = clientes.filter((c) => !abertosPorLead.has(c.id));
  const pegar = () => {
    const c = livres.splice(int(0, livres.length - 1), 1)[0];
    abertosPorLead.add(c.id);
    return c;
  };
  const conversasAbertas = [];
  const recente = (maxMin) => agora - int(2, maxMin) * MIN;
  // Com a Sofia (bot), no meio do papo.
  for (let k = 0; k < 14; k++) {
    const roteiro = um(ROTEIROS.filter((r) => !r.humano));
    conversasAbertas.push({ id: conversa({ cliente: pegar(), roteiro, inicio: recente(240), status: 'bot', etapa: pesado([['novo', 2], ['entendendo', 3], ['orcamento', 2], ['aguardando', 1]]), naoLidas: 0, cortar: int(2, 4) }), status: 'bot' });
  }
  // Na fila, esperando uma pessoa (algumas com cliente frustrado).
  for (let k = 0; k < 7; k++) {
    const roteiro = k < 3 ? ROTEIROS.find((r) => r.chave === 'reclamacao') : ROTEIROS.find((r) => r.chave === 'pediu_pessoa');
    const cliente = pegar();
    const id = conversa({ cliente, roteiro, inicio: recente(45), status: 'na_fila', etapa: 'entendendo', naoLidas: int(1, 4), cortar: k < 3 ? 5 : 2 });
    conversasAbertas.push({ id, status: 'na_fila' });
    for (const a of atendentes.filter((x) => x.statusPresenca !== 'offline')) {
      add('teamNotifications', { id: ID.notificacao(), tenantId: T, userId: a.id, conversationId: id, leadNome: cliente.nome, motivo: k < 3 ? 'Cliente frustrado: reclamação sobre serviço' : 'Cliente pediu para falar com uma pessoa', urgente: k < 3 });
    }
  }
  // Com atendente: cada um dos 5 com algumas conversas.
  for (const [i, a] of atendentes.entries()) {
    const quantas = [4, 3, 2, 4, 1][i];
    for (let k = 0; k < quantas; k++) {
      const roteiro = ROTEIROS.find((r) => r.chave === 'pediu_pessoa');
      conversasAbertas.push({ id: conversa({ cliente: pegar(), roteiro, inicio: recente(180), status: 'humana', atendente: a, etapa: pesado([['entendendo', 2], ['orcamento', 3], ['aguardando', 2]]), naoLidas: chance(0.5) ? int(1, 3) : 0, canal: chance(0.7) ? W1 : W2 }), status: 'humana' });
    }
  }

  // ==========================================================================
  // CAMPANHAS (varios estados)
  // ==========================================================================
  progresso('Campanhas', 74);
  const campanha = (nome, status, objetivo, alvosN, iniciadaHaDias, opcoes = {}) => {
    const id = ID.campanha();
    const escolhidos = clientes.filter((c) => c.aceitaCampanha).slice(opcoes.desde ?? 0, (opcoes.desde ?? 0) + alvosN);
    let enviadas = 0;
    let respostas = 0;
    for (const c of escolhidos) {
      const enviado = ['concluida', 'pausada'].includes(status) && (status === 'concluida' || chance(0.6));
      const respondeu = enviado && chance(0.3);
      const st = respondeu ? 'respondeu' : enviado ? 'enviada' : status === 'revisao' ? pesado([['aprovada', 2], ['pendente', 3]]) : status === 'pausada' ? 'aprovada' : 'aguardando';
      if (enviado) enviadas++;
      if (respondeu) respostas++;
      add('campaignTargets', {
        id: ID.alvo(),
        tenantId: T,
        campaignId: id,
        leadId: c.id,
        telefone: c.telefone,
        nomeCliente: c.nome,
        mensagem: status === 'rascunho' ? '' : `Oi, ${primeiroNome(c)}! ${opcoes.texto ?? 'Faz tempo que você não aparece por aqui — que tal renovar o visual essa semana?'} 💈`,
        status: st,
        enviadoEm: enviado ? new Date(agora - int(0, Math.max(1, iniciadaHaDias)) * DIA) : null,
        respondidoEm: respondeu ? new Date(agora - int(0, Math.max(1, iniciadaHaDias - 1)) * DIA) : null,
        respostaTexto: respondeu ? um(['Opa, quero sim! Tem horário sábado?', 'Obrigado, semana que vem eu passo', 'Não tenho interesse', 'Quanto tá o corte?']) : null,
        classificacao: respondeu ? pesado([['interessado', 5], ['neutro', 3], ['recusa', 1]]) : null
      });
    }
    add('campaigns', {
      id,
      tenantId: T,
      nome,
      objetivo,
      status,
      channelInstanceId: W1.id,
      totalAlvos: escolhidos.length,
      totalEnviadas: enviadas,
      totalRespostas: respostas,
      criadoPorUserId: dono.id,
      iniciadaEm: iniciadaHaDias ? new Date(agora - iniciadaHaDias * DIA) : null,
      concluidaEm: status === 'concluida' ? new Date(agora - Math.max(0, iniciadaHaDias - 2) * DIA) : null,
      esperaMotivo: status === 'pausada' ? 'Pausada por Rodrigo Andrade' : null
    });
  };
  campanha('Volta que a gente sente sua falta', 'concluida', 'Trazer de volta quem não aparece há mais de 45 dias.', 120, 40);
  campanha('Dia dos Pais — Corte + Barba', 'concluida', 'Promoção de Dia dos Pais: Corte + Barba com 15% de desconto.', 90, 25, { desde: 120, texto: 'Dia dos Pais chegando: Corte + Barba com 15% de desconto!' });
  campanha('Aniversariantes de setembro', 'pausada', 'Parabenizar e oferecer uma hidratação cortesia.', 60, 3, { desde: 210 });
  campanha('Lançamento: Spa dos Pés', 'revisao', 'Apresentar o novo Spa dos Pés para clientes de manicure.', 45, 0, { desde: 270 });
  campanha('Black Friday (rascunho)', 'rascunho', 'Descontos em produtos na Black Friday.', 0, 0);

  // ==========================================================================
  // REGISTROS INTERNOS E CONFIGURACAO
  // ==========================================================================
  progresso('Configurações', 80);
  const acoes = ['agendamento.criar', 'agendamento.cancelar', 'produto.venda', 'conversa.transferir', 'profissional.atualizar', 'campanha.iniciar', 'usuario.criar'];
  for (let k = 0; k < 160; k++) {
    const u = um(equipeSistema);
    add('auditLogs', { id: ID.auditoria(), tenantId: T, userId: u.id, userNome: u.nome, acao: um(acoes), entidade: 'sistema', dados: {}, createdAt: new Date(agora - int(0, 90) * DIA - int(0, 23) * HORA) });
  }
  add('teamAlerts', { id: ID.aviso(), tenantId: T, userId: atendentes[1].id, deUserId: dono.id, deNome: dono.nome, mensagem: 'Camila, lembra de confirmar os horários de amanhã antes das 18h. Obrigado!' });

  // Base de conhecimento da empresa de demonstracao.
  add('settings', {
    tenantId: T,
    chave: 'empresa.base_conhecimento',
    descricao: 'Base de conhecimento da empresa',
    valor: {
      logo: null,
      sobre: 'Barbearia e salão no centro da cidade desde 2014. Especialistas em degradê, barba e coloração, com espaço de estética e manicure.',
      endereco: { logradouro: 'Rua das Palmeiras, 210', bairro: 'Centro', cidade: 'Campinas - SP', referencia: 'Ao lado da padaria Pão Quente', mapaUrl: '', estacionamento: 'Estacionamento conveniado na rua de trás (1h grátis).' },
      contato: { telefone: '(19) 3232-1000', whatsapp: '(11) 98765-0001', instagram: '@estiloearte', site: 'estiloearte.com.br', email: 'contato@estiloearte.com.br' },
      pagamento: { pix: { tipo: 'cnpj', chave: '12.345.678/0001-90', titular: 'Estilo & Arte LTDA', banco: 'Nubank' }, formas: ['Pix', 'Dinheiro', 'Cartão de débito', 'Cartão de crédito', 'Crédito parcelado'], observacao: 'Parcelamos em até 3x sem juros acima de R$ 150.' },
      horario: { dias: { 1: [{ inicio: '09:00', fim: '20:00' }], 2: [{ inicio: '09:00', fim: '20:00' }], 3: [{ inicio: '09:00', fim: '20:00' }], 4: [{ inicio: '09:00', fim: '20:00' }], 5: [{ inicio: '09:00', fim: '20:00' }], 6: [{ inicio: '08:00', fim: '17:00' }] }, observacao: 'Fechado em feriados nacionais.' },
      politicas: 'Tolerância de 10 minutos de atraso.\nCancelamentos com pelo menos 2 horas de antecedência.\nCrianças até 12 anos acompanhadas de um responsável.',
      faq: [
        { pergunta: 'Vocês atendem criança?', resposta: 'Sim, a partir de 3 anos, com um responsável. Temos cadeirinha e desenho no corte.' },
        { pergunta: 'Precisa agendar?', resposta: 'Recomendamos agendar, mas atendemos encaixe quando há horário livre.' },
        { pergunta: 'Tem Wi-Fi?', resposta: 'Sim, a senha fica no balcão.' }
      ],
      extras: 'Às terças, Corte + Barba com 10% de desconto.'
    }
  });

  // Configuracao de IA, menu e modo de atendimento: copiadas da empresa real,
  // para a demonstracao responder como o sistema de verdade.
  const [menuReal, agentesReais, provedoresReais, ajustesReais] = await Promise.all([
    origem.select().from(s.menuFlows).where(and(eq(s.menuFlows.tenantId, tenantOrigem), eq(s.menuFlows.ativo, true))),
    origem.select().from(s.agentProfiles).where(eq(s.agentProfiles.tenantId, tenantOrigem)),
    origem.select().from(s.aiProviders).where(eq(s.aiProviders.tenantId, tenantOrigem)),
    origem.select().from(s.settings).where(and(eq(s.settings.tenantId, tenantOrigem), ne(s.settings.chave, 'empresa.base_conhecimento')))
  ]);
  for (const m of menuReal) add('menuFlows', { ...m, id: ID.menu(), tenantId: T });
  for (const a of agentesReais) add('agentProfiles', { ...a, id: ID.agente(), tenantId: T });
  for (const pv of provedoresReais) add('aiProviders', { ...pv, id: ID.provedorIa(), tenantId: T });
  for (const st of ajustesReais) add('settings', { ...st, tenantId: T });

  // ==========================================================================
  // GRAVACAO EM LOTES
  // ==========================================================================
  const ORDEM = [
    'tenants', 'users', 'channelInstances', 'quickReplies', 'services', 'products', 'professionals', 'professionalServices',
    'scheduleBlocks', 'leads', 'stockMovements', 'conversations', 'messages', 'appointments', 'serviceHistory', 'productSales',
    'teamNotifications', 'campaigns', 'campaignTargets', 'aiCalls', 'auditLogs', 'teamAlerts', 'settings', 'menuFlows',
    'agentProfiles', 'aiProviders'
  ];
  const total = ORDEM.reduce((t, n) => t + (linhas[n]?.length ?? 0), 0);
  let feitas = 0;
  await destino.transaction(async (tx) => {
    for (const nome of ORDEM) {
      const lista = linhas[nome] ?? [];
      const porLote = Math.max(20, Math.floor(8000 / Math.max(1, Object.keys(lista[0] ?? { a: 1 }).length)));
      for (let i = 0; i < lista.length; i += porLote) {
        await tx.insert(s[nome]).values(lista.slice(i, i + porLote));
        feitas += Math.min(porLote, lista.length - i);
        progresso(`Gravando ${nome}`, 82 + Math.round((feitas / total) * 17));
      }
    }
  });

  progresso('Pronto', 100);
  return {
    tenantId: T,
    contagem: Object.fromEntries(ORDEM.map((n) => [n, linhas[n]?.length ?? 0])),
    atendimentos: contAtend
  };
}
