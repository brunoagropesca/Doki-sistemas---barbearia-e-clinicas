import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Aviso, Botao, Carregando, Entrada } from '../componentes/ui.jsx';
import { Icone } from '../componentes/Icone.jsx';
import { BarraParte, BarrasH, ColunasEmpilhadas, Legenda, Medidor, duracao, numero, porcento, reais, reaisCurto } from './dashboard/Graficos.jsx';
import { MapaCalor } from './dashboard/MapaCalor.jsx';
import './dashboard/Dashboard.css';

/**
 * Dashboard do dono: tudo que o sistema registra, num lugar so.
 *
 * Um filtro de periodo no topo vale para a pagina inteira (todos os numeros
 * batem entre si). Cada numero principal vem comparado com o periodo anterior
 * de mesmo tamanho. O detalhe fica em abas — sao sete assuntos, e empilhados
 * virariam uma pagina de rolar sem fim.
 */

const PERIODOS = [
  { chave: '7', rotulo: '7 dias', dias: 7 },
  { chave: '30', rotulo: '30 dias', dias: 30 },
  { chave: '90', rotulo: '90 dias', dias: 90 },
  { chave: '365', rotulo: '12 meses', dias: 365 },
  { chave: 'mes', rotulo: 'Este mês' }
];

const ABAS = [
  { id: 'geral', rotulo: 'Visão geral' },
  { id: 'horarios', rotulo: 'Horários' },
  { id: 'servicos', rotulo: 'Serviços e equipe' },
  { id: 'produtos', rotulo: 'Produtos' },
  { id: 'clientes', rotulo: 'Clientes' },
  { id: 'atendimento', rotulo: 'WhatsApp e agenda' },
  { id: 'campanhas', rotulo: 'Campanhas e IA' }
];

const S1 = 'var(--gr-s1)';
const S2 = 'var(--gr-s2)';
const S3 = 'var(--gr-s3)';
const S4 = 'var(--gr-s4)';
const S5 = 'var(--gr-s5)';

const ORIGEM_AGENDA = { humano: 'Equipe', ia: 'Sofia (IA)', cliente: 'Cliente', sistema: 'Sistema' };
/** Cor presa a QUEM marcou, nunca a posicao no ranking: trocar de periodo nao repinta. */
const COR_ORIGEM_AGENDA = { ia: S1, humano: S3, cliente: S4, sistema: S5 };
const STATUS_CONVERSA = { bot: 'Com a IA', na_fila: 'Na fila', humana: 'Com atendente', finalizada: 'Finalizadas' };
/** Humor sempre do melhor para o pior, em qualquer lista. */
const ORDEM_HUMOR = ['satisfeito', 'neutro', 'duvida', 'frustrado'];
const porHumor = (lista) => [...lista].sort((a, b) => ORDEM_HUMOR.indexOf(a.humor) - ORDEM_HUMOR.indexOf(b.humor));
const HUMOR = { satisfeito: '😊 Satisfeito', neutro: '😐 Neutro', duvida: '🤔 Em dúvida', frustrado: '😠 Frustrado' };
const ORIGEM_CONTATO = { whatsapp: 'WhatsApp', manual: 'Cadastro manual', campanha: 'Campanha', importacao: 'Importação' };

const hojeLocal = () => new Date().toLocaleDateString('sv-SE');
const MAX_DIAS = 400;
const diasEntre = (a, b) => Math.round(Math.abs(Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000) + 1;

export function Dashboard() {
  const [params, setParams] = useSearchParams();
  const aba = ABAS.some((a) => a.id === params.get('aba')) ? params.get('aba') : 'geral';
  // "custom" sem data no endereco (link cortado) volta para o padrao.
  const periodo = params.get('periodo') === 'custom' && !params.get('de') ? '30' : params.get('periodo') ?? '30';
  const [de, setDe] = useState(params.get('de') ?? '');
  const [ate, setAte] = useState(params.get('ate') ?? '');

  const consulta =
    periodo === 'custom'
      ? { de: params.get('de'), ate: params.get('ate') || hojeLocal() }
      : periodo === 'mes'
        ? { de: `${hojeLocal().slice(0, 8)}01`, ate: hojeLocal() }
        : { dias: PERIODOS.find((p) => p.chave === periodo)?.dias ?? 30 };

  const dados = useQuery({
    queryKey: ['analises', consulta],
    queryFn: () => api.get('/api/analises', consulta),
    // Trocar de periodo mantem o desenho anterior (esmaecido) ate chegar o novo.
    placeholderData: keepPreviousData
  });

  function ir(novos) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(novos)) (v ? p.set(k, v) : p.delete(k));
    setParams(p, { replace: true });
  }

  const d = dados.data;

  // Exportar leva exatamente o periodo da tela (os mesmos filtros da consulta).
  const [exportando, setExportando] = useState(false);
  const [erroExportar, setErroExportar] = useState(null);
  async function exportar() {
    setExportando(true);
    setErroExportar(null);
    try {
      await api.baixar('/api/analises/exportar', consulta, 'dashboard.xlsx');
    } catch (err) {
      setErroExportar(err.message);
    } finally {
      setExportando(false);
    }
  }

  // Os campos de data mostram SEMPRE o periodo da tela: escolher "7 dias"
  // atualiza as datas, e da para partir delas para um periodo proprio.
  const periodoDe = d?.periodo.de;
  const periodoAte = d?.periodo.ate;
  useEffect(() => {
    if (periodoDe && periodoAte) {
      setDe(periodoDe);
      setAte(periodoAte);
    }
  }, [periodoDe, periodoAte]);

  const longoDemais = Boolean(de && ate) && diasEntre(de, ate) > MAX_DIAS;
  const mudou = de !== periodoDe || (ate || hojeLocal()) !== periodoAte;

  function aplicar(e) {
    e.preventDefault();
    if (!de || longoDemais) return;
    // Sem "ate", vai ate hoje; datas invertidas sao trocadas de lugar.
    let [a, b] = [de, ate || hojeLocal()];
    if (a > b) [a, b] = [b, a];
    ir({ periodo: 'custom', de: a, ate: b });
  }

  return (
    <div className="coluna dash">
      <header className="dash-topo linha">
        <div>
          <h1>Dashboard</h1>
          <p className="texto-suave">
            {d
              ? `${dataBR(d.periodo.de)} a ${dataBR(d.periodo.ate)} · ${
                  d.periodo.anterior.completo
                    ? `comparado com ${dataBR(d.periodo.anterior.de)} a ${dataBR(d.periodo.anterior.ate)}`
                    : d.periodo.inicioDosDados
                      ? `sem comparação: os registros começam em ${dataBR(d.periodo.inicioDosDados)}`
                      : 'sem comparação: ainda não há registros anteriores'
                }`
              : 'Tudo o que acontece no seu negócio.'}
          </p>
        </div>
        <Botao
          variante="secundario"
          className="dash-exportar"
          carregando={exportando}
          disabled={!d}
          onClick={exportar}
          title="Baixa uma planilha do Excel com os números do período escolhido"
        >
          <Icone nome="planilha" /> Exportar Excel
        </Botao>
      </header>
      {erroExportar && (
        <Aviso tom="perigo" aoFechar={() => setErroExportar(null)}>
          {erroExportar}
        </Aviso>
      )}

      {/* Um filtro so, acima de tudo: todos os numeros da pagina seguem ele. */}
      <div className="dash-filtros">
        <div className="eq-chips" role="group" aria-label="Período">
          {PERIODOS.map((p) => (
            <button
              key={p.chave}
              type="button"
              aria-pressed={periodo === p.chave}
              className={`eq-chip${periodo === p.chave ? ' eq-chip--ativo' : ''}`}
              onClick={() => ir({ periodo: p.chave === '30' ? null : p.chave, de: null, ate: null })}
            >
              {p.rotulo}
            </button>
          ))}
        </div>
        <form className={`dash-datas${periodo === 'custom' ? ' dash-datas--ativo' : ''}`} onSubmit={aplicar}>
          <Entrada type="date" value={de} max={hojeLocal()} aria-label="De" onChange={(e) => setDe(e.target.value)} />
          <span className="texto-fraco">até</span>
          <Entrada type="date" value={ate} max={hojeLocal()} aria-label="Até" onChange={(e) => setAte(e.target.value)} />
          <button
            type="submit"
            className={`eq-chip${mudou && de && !longoDemais ? ' eq-chip--ativo' : ''}`}
            disabled={!de || longoDemais || !mudou}
          >
            Aplicar
          </button>
          {longoDemais && <span className="dash-datas__erro">Escolha até {MAX_DIAS} dias.</span>}
        </form>
      </div>

      {dados.isError && <Aviso tom="perigo">{dados.error.message}</Aviso>}
      {dados.isLoading || !d ? (
        <Carregando texto="Montando o dashboard..." />
      ) : (
        <div className={`dash-corpo${dados.isFetching ? ' dash-corpo--atualizando' : ''}`}>
          <Resumo r={d.resumo} a={d.resumoAnterior} semBase={!d.periodo.anterior.completo} />

          <nav className="dash-abas" role="tablist" aria-label="Assunto">
            {ABAS.map((a) => (
              <button
                key={a.id}
                type="button"
                role="tab"
                aria-selected={aba === a.id}
                className={`dash-aba${aba === a.id ? ' dash-aba--ativa' : ''}`}
                onClick={() => ir({ aba: a.id === 'geral' ? null : a.id })}
              >
                {a.rotulo}
              </button>
            ))}
          </nav>

          <div role="tabpanel">
            {aba === 'geral' && <VisaoGeral d={d} />}
            {aba === 'horarios' && <Horarios d={d} />}
            {aba === 'servicos' && <ServicosEquipe d={d} />}
            {aba === 'produtos' && <Produtos d={d} />}
            {aba === 'clientes' && <Clientes d={d} />}
            {aba === 'atendimento' && <Atendimento d={d} />}
            {aba === 'campanhas' && <CampanhasIa d={d} />}
          </div>
        </div>
      )}
    </div>
  );
}

const dataBR = (iso) => iso.split('-').reverse().join('/');
/** 131,7 — horas com virgula decimal. */
const horas = (n) => (n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

// ─── Numeros principais ────────────────────────────────────────────────────

function Resumo({ r, a, semBase }) {
  return (
    <section className="dash-kpis" aria-label="Números principais">
      <Kpi semBase={semBase} destaque rotulo="Faturamento" valor={reais(r.faturamentoCentavos)} atual={r.faturamentoCentavos} anterior={a.faturamentoCentavos}
        detalhe={`${reaisCurto(r.servicosCentavos)} serviços · ${reaisCurto(r.produtosCentavos)} produtos`} />
      <Kpi semBase={semBase} rotulo="Atendimentos" valor={numero(r.atendimentos)} atual={r.atendimentos} anterior={a.atendimentos} detalhe={`${horas(r.horasTrabalhadas)} h de serviço`} />
      <Kpi semBase={semBase} rotulo="Ticket médio" valor={reais(r.ticketMedioCentavos)} atual={r.ticketMedioCentavos} anterior={a.ticketMedioCentavos} detalhe="por atendimento" />
      <Kpi semBase={semBase} rotulo="Clientes atendidos" valor={numero(r.clientesAtendidos)} atual={r.clientesAtendidos} anterior={a.clientesAtendidos} detalhe={`${r.clientesNovos} na 1ª visita`} />
      <Kpi semBase={semBase} rotulo="Novos contatos" valor={numero(r.novosContatos)} atual={r.novosContatos} anterior={a.novosContatos} detalhe={`${numero(r.conversas)} conversas`} />
      <Kpi semBase={semBase} rotulo="Produtos vendidos" valor={numero(r.itensVendidos)} atual={r.itensVendidos} anterior={a.itensVendidos} detalhe={reais(r.produtosCentavos)} />
      <Kpi semBase={semBase} rotulo="Faltas" valor={`${porcento(r.taxaFalta)}`} atual={r.taxaFalta} anterior={a.taxaFalta} menorEMelhor pontos
        detalhe={`${r.faltas} faltas · ${r.cancelados} cancelados`} />
      <Kpi semBase={semBase} rotulo="Descontos dados" valor={reais(r.descontosCentavos)} atual={r.descontosCentavos} anterior={a.descontosCentavos} menorEMelhor detalhe="nos serviços" />
    </section>
  );
}

/**
 * Bloco de numero: rotulo, valor, variacao contra o periodo anterior (seta +
 * texto, nunca so a cor) e um detalhe. `menorEMelhor`: falta subir e ruim.
 */
function Kpi({ rotulo, valor, atual, anterior, detalhe, destaque, menorEMelhor, pontos, semBase }) {
  let variacao = null;
  // O periodo anterior e de antes do sistema ter dados: qualquer porcentagem
  // seria enganosa ("+7.000%"). Diz isso em vez de calcular.
  if (semBase) variacao = { texto: 'sem base', tom: 'neutro', seta: '' };
  else if (anterior > 0 || atual > 0) {
    const diff = pontos ? atual - anterior : anterior > 0 ? ((atual - anterior) / anterior) * 100 : null;
    if (diff === null) variacao = { texto: 'novo', tom: 'neutro', seta: '' };
    else if (Math.abs(diff) < 0.5) variacao = { texto: 'estável', tom: 'neutro', seta: '→' };
    else {
      const subiu = diff > 0;
      const bom = menorEMelhor ? !subiu : subiu;
      const n = Math.abs(diff).toLocaleString('pt-BR', { maximumFractionDigits: Math.abs(diff) < 10 ? 1 : 0 });
      variacao = { texto: pontos ? `${n} p.p.` : `${porcento(n)}`, tom: bom ? 'bom' : 'ruim', seta: subiu ? '▲' : '▼' };
    }
  }
  return (
    <div className={`kpi${destaque ? ' kpi--destaque' : ''}`}>
      <span className="kpi__rotulo">{rotulo}</span>
      <strong className="kpi__valor">{valor}</strong>
      <span className="kpi__rodape">
        {variacao && (
          <span
            className={`kpi__var kpi__var--${variacao.tom}`}
            title={semBase ? 'O período anterior é de antes dos primeiros registros do sistema' : 'Comparado com o período anterior'}
          >
            {variacao.seta} {variacao.texto}
          </span>
        )}
        {detalhe && <span className="kpi__detalhe">{detalhe}</span>}
      </span>
    </div>
  );
}

// ─── Cartao de secao ───────────────────────────────────────────────────────

function Bloco({ titulo, sub, acao, children, largo }) {
  return (
    <section className={`dash-bloco${largo ? ' dash-bloco--largo' : ''}`}>
      <header className="dash-bloco__topo">
        <div>
          <h2>{titulo}</h2>
          {sub && <p className="texto-fraco">{sub}</p>}
        </div>
        {acao}
      </header>
      {children}
    </section>
  );
}

/**
 * Ate 5 fatias com cor propria; da 6a em diante tudo vira "Outras" (cinza).
 * Sem isso, as 5 maiores apareciam como se fossem 100% do total.
 */
function partesComOutras(lista, valor, rotulo) {
  const cores = [S1, S2, S3, S4, S5];
  if (lista.length <= cores.length) return lista.map((x, i) => ({ rotulo: rotulo(x), valor: valor(x), cor: cores[i] }));
  const principais = lista.slice(0, cores.length - 1);
  const resto = lista.slice(cores.length - 1);
  return [
    ...principais.map((x, i) => ({ rotulo: rotulo(x), valor: valor(x), cor: cores[i] })),
    { rotulo: `Outras (${resto.length})`, valor: resto.reduce((s, x) => s + valor(x), 0), cor: 'var(--gr-outros)' }
  ];
}

function Mini({ rotulo, valor, detalhe }) {
  return (
    <div className="dash-mini">
      <span>{rotulo}</span>
      <strong>{valor}</strong>
      {detalhe && <small>{detalhe}</small>}
    </div>
  );
}

// ─── Abas ──────────────────────────────────────────────────────────────────

const rotuloBalde = (granularidade) => (b) => {
  const [, m, dia] = b.inicio.split('-');
  if (granularidade === 'mes') return new Date(`${b.inicio}T12:00:00`).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
  return `${dia}/${m}`;
};
const diaMes = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const rotuloBaldeLongo = (granularidade) => (b) => {
  const data = new Date(`${b.inicio}T12:00:00`);
  // Semana/mes cortado pelo periodo: a dica diz quais dias entraram.
  const so = b.parcial ? ` · só ${b.dias} dia${b.dias === 1 ? '' : 's'} no período` : '';
  if (granularidade === 'mes') {
    const mes = data.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    return b.parcial ? `${mes} (${diaMes(b.inicio)} a ${diaMes(b.fim)})${so}` : mes;
  }
  if (granularidade === 'semana') return `${diaMes(b.inicio)} a ${diaMes(b.fim)}${so}`;
  return data.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'short' });
};

function VisaoGeral({ d }) {
  const g = d.periodo.granularidade;
  const top = d.servicos.slice(0, 5);
  const temIncompleto = d.serie.some((b) => b.parcial);
  return (
    <div className="dash-grade">
      <Bloco
        largo
        titulo="Faturamento no tempo"
        sub={`Por ${g === 'dia' ? 'dia' : g === 'semana' ? 'semana' : 'mês'}: serviços concluídos e produtos vendidos${
          temIncompleto ? `. Colunas claras: ${g === 'semana' ? 'semana' : 'mês'} só em parte dentro do período` : ''
        }`}
        acao={<Legenda itens={[{ rotulo: 'Serviços', cor: S1 }, { rotulo: 'Produtos', cor: S2 }]} />}
      >
        <ColunasEmpilhadas
          dados={d.serie}
          series={[
            { chave: 'servicosCentavos', rotulo: 'serviços', cor: S1 },
            { chave: 'produtosCentavos', rotulo: 'produtos', cor: S2 }
          ]}
          rotuloX={rotuloBalde(g)}
          rotuloLongo={rotuloBaldeLongo(g)}
          incompleto={(b) => b.parcial}
          formatar={reais}
          formatarEixo={reaisCurto}
        />
      </Bloco>

      <Bloco largo titulo="Mapa de calor da semana" sub="Quando o movimento acontece. Detalhes na aba Horários.">
        <MapaCalor calor={d.calor} />
      </Bloco>

      <div className="dash-trio">
      <Bloco titulo="Serviços que mais faturam" sub="Top 5 no período">
        <BarrasH itens={top} valor={(s) => s.faturamentoCentavos} rotulo={(s) => s.nome} formatar={reaisCurto} detalhe={(s) => `${s.quantidade}x`} />
      </Bloco>

      <Bloco titulo="Profissionais" sub="Faturamento no período">
        <BarrasH
          itens={d.profissionais.filter((p) => p.atendimentos > 0).slice(0, 6)}
          valor={(p) => p.faturamentoCentavos}
          rotulo={(p) => p.nome}
          formatar={reaisCurto}
          detalhe={(p) => `${porcento(p.ocupacao)} ocupado`}
        />
      </Bloco>

      <Bloco titulo="De onde vem o dinheiro">
        <BarraParte
          formatar={reais}
          partes={[
            { rotulo: 'Serviços', valor: d.resumo.servicosCentavos, cor: S1 },
            { rotulo: 'Produtos', valor: d.resumo.produtosCentavos, cor: S2 }
          ]}
        />
        <div className="dash-minis">
          <Mini rotulo="Próximos 7 dias" valor={reais(d.agenda.receitaPrevista7DiasCentavos)} detalhe={`${d.agenda.proximos7Dias} horários marcados`} />
          <Mini rotulo="Lucro em produtos" valor={reais(d.produtos.lucroCentavos)} detalhe="preço − custo cadastrado" />
        </div>
      </Bloco>
      </div>
    </div>
  );
}

function Horarios({ d }) {
  return (
    <div className="dash-grade">
      <Bloco largo titulo="Mapa de calor" sub="Dia da semana × hora. Passe o mouse numa célula para ver o número exato.">
        <MapaCalor calor={d.calor} detalhado />
      </Bloco>
      <Bloco titulo="Movimento por dia da semana" sub="Atendimentos concluídos">
        <BarrasH
          itens={[1, 2, 3, 4, 5, 6, 0].map((dia) => ({ dia, v: d.calor.porDiaSemana.atendimentos[dia] }))}
          valor={(x) => x.v}
          rotulo={(x) => ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'][x.dia]}
          formatar={numero}
          detalhe={(x) => reaisCurto(d.calor.porDiaSemana.faturamento[x.dia])}
        />
      </Bloco>
      <Bloco titulo="Quando os clientes escrevem" sub="Mensagens recebidas no WhatsApp, por hora">
        {d.calor.porHora.mensagens.some((v) => v > 0) ? (
          <ColunasEmpilhadas
            altura={200}
            dados={d.calor.porHora.mensagens.map((v, h) => ({ h, v }))}
            series={[{ chave: 'v', rotulo: 'mensagens', cor: S1 }]}
            rotuloX={(x) => `${String(x.h).padStart(2, '0')}h`}
            rotuloLongo={(x) => `${String(x.h).padStart(2, '0')}h às ${String(x.h + 1).padStart(2, '0')}h`}
            formatar={numero}
            formatarEixo={numero}
          />
        ) : (
          <p className="gr-vazio">Nenhuma mensagem de cliente no período.</p>
        )}
      </Bloco>
    </div>
  );
}

function ServicosEquipe({ d }) {
  return (
    <div className="dash-grade">
      <Bloco largo titulo="Serviços" sub="Ranking por faturamento no período">
        {d.servicos.length === 0 ? (
          <p className="gr-vazio">Nenhum atendimento concluído no período.</p>
        ) : (
          <div className="dash-tabela">
            <table>
              <thead>
                <tr>
                  <th>Serviço</th>
                  <th>Categoria</th>
                  <th className="num">Vezes</th>
                  <th className="num">Faturamento</th>
                  <th>Participação</th>
                  <th className="num">Ticket médio</th>
                  <th className="num">Descontos</th>
                  <th className="num">Duração média</th>
                  <th className="num">Faltas</th>
                </tr>
              </thead>
              <tbody>
                {d.servicos.map((s) => (
                  <tr key={s.nome}>
                    <td><strong>{s.nome}</strong></td>
                    <td className="texto-suave">{s.categoria}</td>
                    <td className="num">{numero(s.quantidade)}</td>
                    <td className="num">{reais(s.faturamentoCentavos)}</td>
                    <td><span className="dash-part"><span style={{ width: `${s.participacao}%` }} /></span> {porcento(s.participacao)}</td>
                    <td className="num">{reais(s.ticketMedioCentavos)}</td>
                    <td className="num">{reais(s.descontosCentavos)}</td>
                    <td className="num">{s.duracaoMediaMin} min</td>
                    <td className="num">{s.faltas}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Bloco>

      <Bloco largo titulo="Profissionais" sub="Ocupação = horas de serviço ÷ horas da jornada cadastrada no período">
        <div className="dash-tabela">
          <table>
            <thead>
              <tr>
                <th>Profissional</th>
                <th className="num">Atendimentos</th>
                <th className="num">Faturamento</th>
                <th className="num">Ticket médio</th>
                <th className="num">Clientes</th>
                <th className="num">1ª visita</th>
                <th>Ocupação</th>
                <th className="num">Faltas</th>
                <th className="num">Cancel.</th>
              </tr>
            </thead>
            <tbody>
              {d.profissionais.map((p) => (
                <tr key={p.id} className={p.ativo ? '' : 'dash-inativo'}>
                  <td>
                    <span className="dash-pessoa">
                      <span className="dash-pessoa__cor" style={{ background: p.cor }} aria-hidden="true" />
                      <strong>{p.nome}</strong>
                    </span>
                  </td>
                  <td className="num">{numero(p.atendimentos)}</td>
                  <td className="num">{reais(p.faturamentoCentavos)}</td>
                  <td className="num">{reais(p.ticketMedioCentavos)}</td>
                  <td className="num">{p.clientes}</td>
                  <td className="num">{p.clientesNovos}</td>
                  <td>
                    <span className="dash-ocupacao">
                      <Medidor valor={p.ocupacao} rotulo={`${horas(p.horasTrabalhadas)} h de ${horas(p.horasDisponiveis)} h`} />
                      <span>{porcento(p.ocupacao)}</span>
                      <small>{horas(p.horasTrabalhadas)}/{horas(p.horasDisponiveis)} h</small>
                    </span>
                  </td>
                  <td className="num">{p.faltas}</td>
                  <td className="num">{p.cancelados}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Bloco>

      <Bloco titulo="Categorias" sub="Parte do faturamento de serviços">
        <BarraParte
          formatar={reais}
          partes={partesComOutras(d.categorias, (c) => c.faturamentoCentavos, (c) => c.nome)}
        />
      </Bloco>
      <Bloco titulo="Faltas e cancelamentos">
        <div className="dash-minis">
          <Mini rotulo="Taxa de faltas" valor={`${porcento(d.resumo.taxaFalta)}`} detalhe={`${d.resumo.faltas} no período`} />
          <Mini rotulo="Taxa de cancelamento" valor={`${porcento(d.resumo.taxaCancelamento)}`} detalhe={`${d.resumo.cancelados} no período`} />
        </div>
        <h3 className="dash-sub">Motivos de cancelamento</h3>
        <BarrasH itens={d.agenda.motivosCancelamento} valor={(m) => m.total} rotulo={(m) => m.motivo} formatar={numero} vazio="Nenhum motivo registrado." />
      </Bloco>
    </div>
  );
}

function Produtos({ d }) {
  const p = d.produtos;
  const alerta = p.lista.filter((x) => x.abaixoDoMinimo);
  return (
    <div className="dash-grade">
      <Bloco largo titulo="Resumo de produtos">
        <div className="dash-minis dash-minis--linha">
          <Mini rotulo="Faturamento" valor={reais(d.resumo.produtosCentavos)} detalhe={`${numero(d.resumo.itensVendidos)} itens vendidos`} />
          <Mini rotulo="Lucro bruto" valor={reais(p.lucroCentavos)} detalhe="preço − custo" />
          <Mini rotulo="Em estoque (venda)" valor={reais(p.estoque.valorVendaCentavos)} detalhe={`${numero(p.estoque.itens)} itens`} />
          <Mini rotulo="Em estoque (custo)" valor={reais(p.estoque.valorCustoCentavos)} detalhe="dinheiro parado" />
          <Mini rotulo="Abaixo do mínimo" valor={numero(p.estoque.abaixoDoMinimo)} detalhe={`${p.estoque.semEstoque} zerados`} />
        </div>
      </Bloco>

      <Bloco largo titulo="Produtos" sub="Vendas no período e situação do estoque">
        <div className="dash-tabela">
          <table>
            <thead>
              <tr>
                <th>Produto</th>
                <th className="num">Vendidos</th>
                <th className="num">Faturamento</th>
                <th className="num">Lucro</th>
                <th className="num">Margem</th>
                <th className="num">Perdas</th>
                <th className="num">Estoque</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {p.lista.map((x) => (
                <tr key={x.id} className={x.ativo ? '' : 'dash-inativo'}>
                  <td>
                    <strong>{x.nome}</strong>
                    <div className="texto-fraco">{x.categoria}</div>
                  </td>
                  <td className="num">{numero(x.vendidos)}</td>
                  <td className="num">{reais(x.faturamentoCentavos)}</td>
                  <td className="num">{reais(x.lucroCentavos)}</td>
                  <td className="num">{x.faturamentoCentavos ? `${porcento(x.margem)}` : '—'}</td>
                  <td className="num">{x.perdas || '—'}</td>
                  <td className="num">
                    {x.estoque} <small className="texto-fraco">/ mín. {x.estoqueMinimo}</small>
                  </td>
                  <td>
                    {!x.ativo ? (
                      <span className="dash-status">Inativo</span>
                    ) : x.estoque <= 0 ? (
                      <span className="dash-status dash-status--critico">✕ Zerado</span>
                    ) : x.abaixoDoMinimo ? (
                      <span className="dash-status dash-status--alerta">▲ Repor</span>
                    ) : (
                      <span className="dash-status dash-status--ok">✓ Ok</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Bloco>

      <Bloco titulo="Mais vendidos" sub="Em faturamento">
        <BarrasH itens={p.lista.filter((x) => x.vendidos > 0).slice(0, 8)} valor={(x) => x.faturamentoCentavos} rotulo={(x) => x.nome} formatar={reaisCurto} detalhe={(x) => `${x.vendidos} un.`} cor={S2} />
      </Bloco>
      <Bloco titulo="Quem vendeu" sub="Vendas no balcão por pessoa">
        <BarrasH itens={p.vendedores} valor={(v) => v.faturamentoCentavos} rotulo={(v) => v.nome} formatar={reaisCurto} detalhe={(v) => `${v.itens} itens`} cor={S2} />
      </Bloco>
      {alerta.length > 0 && (
        <Bloco titulo="Para repor" sub="No mínimo ou abaixo dele">
          <ul className="dash-lista">
            {alerta.map((x) => (
              <li key={x.id}>
                <span className="crescer">{x.nome}</span>
                <span className="dash-status dash-status--alerta">
                  ▲ {x.estoque} de mín. {x.estoqueMinimo}
                </span>
              </li>
            ))}
          </ul>
          <Link className="dash-link" to="/catalogo">Abrir o catálogo →</Link>
        </Bloco>
      )}
    </div>
  );
}

function Clientes({ d }) {
  const c = d.clientes;
  return (
    <div className="dash-grade">
      <Bloco largo titulo="Base de clientes">
        <div className="dash-minis dash-minis--linha">
          <Mini rotulo="Na base" valor={numero(c.base)} detalhe="contatos cadastrados" />
          <Mini rotulo="Novos contatos" valor={numero(c.novosContatos)} detalhe="entraram no período" />
          <Mini rotulo="Atendidos" valor={numero(c.atendidos)} detalhe={`${c.primeiraVisita} na 1ª visita`} />
          <Mini rotulo="Voltam a cada" valor={c.frequenciaRetornoDias != null ? `${c.frequenciaRetornoDias} dias` : '—'} detalhe="média entre visitas" />
          <Mini rotulo="Em risco" valor={numero(c.emRisco)} detalhe="fiéis sem vir há 45+ dias" />
        </div>
      </Bloco>

      <Bloco titulo="Quem mais gastou" sub="Serviços + produtos no período">
        {c.top.length === 0 ? (
          <p className="gr-vazio">Nenhum cliente atendido no período.</p>
        ) : (
          <ol className="dash-lista dash-lista--num">
            {c.top.map((x) => (
              <li key={x.id}>
                <Link to={`/contatos/${x.id}`} className="crescer">{x.nome}</Link>
                <small className="texto-fraco">{x.visitas} visita{x.visitas === 1 ? '' : 's'}</small>
                <strong>{reais(x.gastoCentavos)}</strong>
              </li>
            ))}
          </ol>
        )}
      </Bloco>

      <Bloco titulo="Clientes em risco" sub="Vieram 2+ vezes e sumiram há mais de 45 dias — vale uma campanha">
        {c.risco.length === 0 ? (
          <p className="gr-vazio">Ninguém em risco. 👏</p>
        ) : (
          <ul className="dash-lista">
            {c.risco.map((x) => (
              <li key={x.id}>
                <Link to={`/contatos/${x.id}`} className="crescer">{x.nome}</Link>
                <small className="texto-fraco">{x.visitas} visitas · {reaisCurto(x.gastoTotalCentavos)}</small>
                <span className="dash-status dash-status--alerta">{x.diasSemVir} dias</span>
              </li>
            ))}
          </ul>
        )}
      </Bloco>

      <Bloco titulo="Primeira visita × retorno" sub="Clientes atendidos no período">
        <BarraParte
          partes={[
            { rotulo: 'Voltaram', valor: c.recorrentes, cor: S1 },
            { rotulo: 'Primeira visita', valor: c.primeiraVisita, cor: S3 }
          ]}
        />
      </Bloco>
      <Bloco titulo="De onde vieram os novos contatos">
        <BarrasH itens={c.porOrigem} valor={(x) => x.total} rotulo={(x) => ORIGEM_CONTATO[x.origem] ?? x.origem} formatar={numero} />
      </Bloco>
      <Bloco titulo="Humor nos atendimentos" sub="Lido pela Sofia nas conversas">
        <BarrasH itens={porHumor(c.humor)} valor={(x) => x.total} rotulo={(x) => HUMOR[x.humor] ?? x.humor} formatar={numero} vazio="Sem leitura de humor no período." />
      </Bloco>
    </div>
  );
}

function Atendimento({ d }) {
  const at = d.atendimento;
  const ag = d.agenda;
  return (
    <div className="dash-grade">
      <Bloco largo titulo="WhatsApp">
        <div className="dash-minis dash-minis--linha">
          <Mini rotulo="Conversas" valor={numero(at.conversas)} detalhe={`${at.abertasAgora} ainda abertas`} />
          <Mini rotulo="1ª resposta" valor={duracao(at.primeiraRespostaMediaSeg)} detalhe="tempo médio" />
          <Mini rotulo="Resolvidas só pela IA" valor={`${porcento(at.taxaResolucaoIa)}`} detalhe={`${at.resolvidasSoPelaIa} sem ninguém da equipe`} />
          <Mini rotulo="Viraram agendamento" valor={`${porcento(at.conversao)}`} detalhe="das conversas do período" />
          <Mini rotulo="Passaram por pessoa" valor={numero(at.passaramPorPessoa)} detalhe="atendente assumiu" />
        </div>
      </Bloco>

      <Bloco titulo="Quem respondeu as mensagens">
        <BarraParte
          partes={[
            { rotulo: 'Sofia (IA)', valor: at.mensagens.ia, cor: S1 },
            { rotulo: 'Equipe', valor: at.mensagens.equipe, cor: S3 }
          ]}
        />
        <p className="texto-fraco dash-nota">{numero(at.mensagens.clientes)} mensagens recebidas de clientes.</p>
      </Bloco>
      <Bloco titulo="Situação das conversas">
        <BarrasH itens={at.porStatus} valor={(x) => x.total} rotulo={(x) => STATUS_CONVERSA[x.status] ?? x.status} formatar={numero} />
      </Bloco>

      <Bloco largo titulo="Atendentes" sub="Conversas que cada um assumiu no período">
        {at.porAtendente.length === 0 ? (
          <p className="gr-vazio">Nenhuma conversa assumida por atendente no período.</p>
        ) : (
          <div className="dash-tabela">
            <table>
              <thead>
                <tr>
                  <th>Atendente</th>
                  <th className="num">Conversas</th>
                  <th className="num">Finalizadas</th>
                  <th className="num">Mensagens enviadas</th>
                  <th className="num">1ª resposta média</th>
                </tr>
              </thead>
              <tbody>
                {at.porAtendente.map((x) => (
                  <tr key={x.nome}>
                    <td><strong>{x.nome}</strong></td>
                    <td className="num">{x.conversas}</td>
                    <td className="num">{x.finalizadas}</td>
                    <td className="num">{x.mensagens}</td>
                    <td className="num">{duracao(x.primeiraRespostaMediaSeg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Bloco>

      <Bloco titulo="Agenda" sub="Horários marcados no período (pela data em que foram marcados)">
        <div className="dash-minis">
          <Mini rotulo="Marcados" valor={numero(ag.marcados)} detalhe={`${ag.viaConversa} vieram de conversa`} />
          <Mini rotulo="Antecedência média" valor={ag.antecedenciaMediaHoras != null ? (ag.antecedenciaMediaHoras >= 48 ? `${Math.round(ag.antecedenciaMediaHoras / 24)} dias` : `${ag.antecedenciaMediaHoras} h`) : '—'} detalhe="entre marcar e acontecer" />
        </div>
        <h3 className="dash-sub">Quem marcou</h3>
        <BarraParte partes={ag.porOrigem.map((o) => ({ rotulo: ORIGEM_AGENDA[o.origem] ?? o.origem, valor: o.total, cor: COR_ORIGEM_AGENDA[o.origem] ?? 'var(--gr-outros)' }))} />
      </Bloco>
      <Bloco titulo="Humor nas conversas">
        <BarrasH itens={porHumor(at.humor)} valor={(x) => x.total} rotulo={(x) => HUMOR[x.humor] ?? x.humor} formatar={numero} vazio="Sem leitura de humor no período." />
      </Bloco>
    </div>
  );
}

function CampanhasIa({ d }) {
  const c = d.campanhas;
  const ia = d.ia;
  return (
    <div className="dash-grade">
      <Bloco largo titulo="Campanhas" sub="Mensagens enviadas no período">
        <div className="dash-minis dash-minis--linha">
          <Mini rotulo="Enviadas" valor={numero(c.enviadas)} />
          <Mini rotulo="Responderam" valor={`${porcento(c.taxaResposta)}`} detalhe={`${numero(c.respostas)} respostas`} />
          <Mini rotulo="Interessados" valor={numero(c.interessados)} />
          <Mini rotulo="Pediram para sair" valor={numero(c.recusas)} />
        </div>
        {c.lista.length > 0 && (
          <div className="dash-tabela">
            <table>
              <thead>
                <tr>
                  <th>Campanha</th>
                  <th className="num">Enviadas</th>
                  <th className="num">Respostas</th>
                  <th className="num">Taxa</th>
                  <th className="num">Interessados</th>
                  <th className="num">Recusas</th>
                </tr>
              </thead>
              <tbody>
                {c.lista.map((x) => (
                  <tr key={x.nome}>
                    <td><strong>{x.nome}</strong></td>
                    <td className="num">{x.enviadas}</td>
                    <td className="num">{x.respostas}</td>
                    <td className="num">{porcento(x.taxaResposta)}</td>
                    <td className="num">{x.interessados}</td>
                    <td className="num">{x.recusas}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Bloco>

      <Bloco largo titulo="Inteligência Artificial" sub="Chamadas aos modelos no período">
        <div className="dash-minis dash-minis--linha">
          <Mini rotulo="Chamadas" valor={numero(ia.chamadas)} detalhe={`${ia.falhas} falharam`} />
          <Mini rotulo="Sucesso" valor={`${porcento(ia.taxaSucesso)}`} />
          <Mini rotulo="Tokens" valor={numero(ia.tokensEntrada + ia.tokensSaida)} detalhe={`${numero(ia.tokensEntrada)} entrada · ${numero(ia.tokensSaida)} saída`} />
          <Mini rotulo="Tempo de resposta" valor={ia.latenciaMediaMs != null ? `${(ia.latenciaMediaMs / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s` : '—'} detalhe="média" />
        </div>
      </Bloco>
      <Bloco titulo="Por modelo">
        <BarrasH itens={ia.porModelo} valor={(x) => x.chamadas} rotulo={(x) => x.modelo} formatar={numero} detalhe={(x) => `${x.falhas} falhas`} vazio="Nenhuma chamada de IA no período." />
      </Bloco>
      <Bloco titulo="Por agente">
        <BarrasH itens={ia.porAgente} valor={(x) => x.chamadas} rotulo={(x) => ({ atendente: 'Sofia', atena: 'Atena', aquiles: 'Aquiles' })[x.agente] ?? x.agente} formatar={numero} vazio="Nenhuma chamada de IA no período." />
      </Bloco>
    </div>
  );
}
