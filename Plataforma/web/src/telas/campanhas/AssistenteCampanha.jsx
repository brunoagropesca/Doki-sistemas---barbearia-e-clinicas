import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { descartarPublico, lerPublico } from '../../lib/publicoDeCampanha.js';
import { Aviso, Botao, Campo, Cartao, Entrada, Selecao, Status } from '../../componentes/ui.jsx';
import { EtapaContatos } from './EtapaContatos.jsx';
import { EtapaIa, IA_PADRAO } from './EtapaIa.jsx';
import { EtapaMensagens } from './EtapaMensagens.jsx';
import { EtapaEnvio, ENVIO_PADRAO } from './EtapaEnvio.jsx';

/**
 * Assistente de campanha: uma decisao por etapa.
 *
 *   1 Criar -> 2 Contatos -> 3 Configurar IA -> 4 Mensagens -> 5 Enviar
 *
 * Cada "Continuar" grava no servidor. Assim a campanha pode ser montada aos
 * poucos: quem fecha a tela na etapa 3 volta depois e encontra tudo como
 * deixou, pela lista de campanhas ("Continuar").
 *
 * O estado dos formularios mora AQUI, e nao em cada etapa: voltar uma etapa
 * e avancar de novo nao pode apagar o que a pessoa acabou de escrever.
 */

const ETAPAS = ['Criar', 'Contatos', 'Configurar IA', 'Mensagens', 'Enviar'];

/** Ate onde a pessoa pode ir, dado o que ja foi feito. */
function etapaLiberada(c) {
  if (!c) return 0;
  const p = c.progresso ?? {};
  if (c.status === 'pronta') return 4;
  if (c.status === 'gerando' || (p.pendentes ?? 0) + (p.aprovadas ?? 0) > 0) return 3;
  if (c.totalAlvos > 0) return 2;
  return 1;
}

/** Onde reabrir uma campanha que ja existe: na primeira coisa que falta fazer. */
function etapaSugerida(c) {
  if (!c) return 0;
  if (c.status === 'pronta') return 4;
  if (c.status === 'gerando' || c.status === 'revisao') return 3;
  return c.totalAlvos > 0 ? 2 : 1;
}

function Etapas({ atual, liberada, aoIr }) {
  return (
    <ol className="etapas" aria-label="Etapas da campanha">
      {ETAPAS.map((nome, i) => {
        const estado = i < atual ? 'feito' : i === atual ? 'atual' : 'futuro';
        return (
          <li key={nome} className={`etapas__item etapas__item--${estado}`} aria-current={estado === 'atual' ? 'step' : undefined}>
            <button type="button" className="etapas__botao" disabled={i > liberada || i === atual} onClick={() => aoIr(i)}>
              <span className="etapas__bolinha">{estado === 'feito' ? '✓' : i + 1}</span>
              <span>{nome}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function AssistenteCampanha({ campanha }) {
  const navegar = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();

  const [criar, setCriar] = useState({ nome: '', channelInstanceId: '' });
  // Quem veio marcado dos Contatos ja chega como publico.
  const [publico, setPublico] = useState(() => (campanha ? [] : (lerPublico() ?? [])));
  useEffect(() => {
    descartarPublico();
  }, []);
  const [pulados, setPulados] = useState([]);
  const [ia, setIa] = useState({ objetivo: '', iaConfig: IA_PADRAO });
  const [envio, setEnvio] = useState(ENVIO_PADRAO);
  const [erro, setErro] = useState(null);

  /**
   * Preenche os formularios com o que ja esta salvo — uma vez so por
   * campanha. Se rodasse a cada atualizacao (a geracao atualiza a campanha a
   * cada 1,5s), apagaria o que a pessoa esta digitando.
   */
  const carregada = useRef(null);
  useEffect(() => {
    if (!campanha || carregada.current === campanha.id) return;
    const primeiraVez = carregada.current === null;
    carregada.current = campanha.id;

    setCriar({ nome: campanha.nome, channelInstanceId: campanha.channelInstanceId });
    setIa({ objetivo: campanha.objetivo ?? '', iaConfig: { ...IA_PADRAO, ...campanha.iaConfig } });
    setEnvio({
      intervaloMinSegundos: campanha.intervaloMinSegundos,
      intervaloMaxSegundos: campanha.intervaloMaxSegundos,
      limiteDiario: campanha.limiteDiario,
      janelaInicio: campanha.janelaInicio,
      janelaFim: campanha.janelaFim,
      simularDigitacao: campanha.simularDigitacao
    });
    // Campanha recem-criada nesta tela: o publico que ja esta aqui (vindo dos
    // Contatos) vale mais que o do servidor, que ainda esta vazio.
    if (!(primeiraVez && publico.length && campanha.alvos.length === 0)) {
      setPublico(campanha.alvos.map((a) => ({ id: a.leadId, nome: a.nomeCliente, aceitaCampanha: true })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campanha]);

  const liberada = etapaLiberada(campanha);
  const pedida = params.get('etapa');
  const etapa = Math.min(pedida !== null ? Number(pedida) || 0 : etapaSugerida(campanha), liberada);

  function irPara(i) {
    setErro(null);
    const novos = new URLSearchParams(params);
    novos.set('etapa', String(i));
    setParams(novos, { replace: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const canais = useQuery({ queryKey: ['canais'], queryFn: () => api.get('/api/canais') });
  const listaCanais = canais.data?.canais ?? [];
  const canal = listaCanais.find((c) => c.id === criar.channelInstanceId);

  /** Guarda a campanha que o servidor devolveu, sem esperar outra consulta. */
  function guardar(c) {
    queryClient.setQueryData(['campanha', c.id], (antigo) => ({ ...(antigo ?? {}), campanha: c, rodando: c.rodando }));
    queryClient.invalidateQueries({ queryKey: ['campanhas'] });
  }

  const salvar = useMutation({
    mutationFn: async (passo) => {
      if (passo === 0) {
        if (!campanha) return { criada: (await api.post('/api/campanhas', criar)).campanha };
        return { campanha: (await api.patch(`/api/campanhas/${campanha.id}`, criar)).campanha };
      }
      if (passo === 1) {
        const r = await api.put(`/api/campanhas/${campanha.id}/publico`, { leadIds: publico.map((p) => p.id) });
        return { campanha: r.campanha, pulados: r.pulados };
      }
      if (passo === 2) {
        let c = (await api.patch(`/api/campanhas/${campanha.id}`, ia)).campanha;
        // So chama a IA para quem ainda nao tem mensagem. Quem ja tem so e
        // reescrito se a pessoa pedir, na etapa seguinte.
        if (c.progresso.aguardando > 0) c = (await api.post(`/api/campanhas/${campanha.id}/gerar`)).campanha;
        return { campanha: c };
      }
      return {};
    },
    onSuccess: (r, passo) => {
      setErro(null);
      if (r.criada) {
        guardar(r.criada);
        // Mesmo componente, endereco novo: o publico dos Contatos continua aqui.
        navegar(`/campanhas/${r.criada.id}?etapa=1`, { replace: true });
        return;
      }
      if (r.campanha) guardar(r.campanha);
      if (r.pulados) setPulados(r.pulados);
      irPara(passo + 1);
    },
    onError: (err) => setErro(err)
  });

  const disparar = useMutation({
    mutationFn: async (iniciarAgora) => {
      await api.patch(`/api/campanhas/${campanha.id}`, {
        ...envio,
        intervaloMinSegundos: Number(envio.intervaloMinSegundos),
        intervaloMaxSegundos: Number(envio.intervaloMaxSegundos),
        limiteDiario: Number(envio.limiteDiario)
      });
      if (iniciarAgora) await api.post(`/api/campanhas/${campanha.id}/iniciar`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campanhas'] });
      queryClient.invalidateQueries({ queryKey: ['campanha', campanha.id] });
      navegar('/campanhas');
    },
    onError: (err) => setErro(err)
  });

  const p = campanha?.progresso ?? {};
  const podeContinuar = [
    criar.nome.trim().length >= 3 && Boolean(criar.channelInstanceId),
    publico.length > 0,
    ia.objetivo.trim().length > 0,
    campanha?.status === 'pronta',
    true
  ][etapa];

  const infoRodape = [
    null,
    `${publico.length} contato(s) selecionado(s)`,
    campanha ? `${campanha.totalAlvos} mensagem(ns) serão escritas pela IA` : null,
    campanha?.status === 'gerando'
      ? 'A IA ainda está escrevendo…'
      : p.pendentes > 0
        ? `Faltam ${p.pendentes} mensagem(ns) para aprovar`
        : `${p.aprovadas ?? 0} mensagem(ns) aprovada(s)`,
    `${p.aprovadas ?? 0} mensagem(ns) prontas para sair`
  ][etapa];

  const erroMsg = erro?.message;
  const errosCampo = erro?.camposComErro ?? {};

  return (
    <div className="assist">
      <button type="button" className="assist__voltar" onClick={() => navegar('/campanhas')}>
        ← Campanhas
      </button>

      <header className="linha linha--entre">
        <div>
          <h1 style={{ margin: 0 }}>{campanha ? campanha.nome : 'Nova campanha'}</h1>
          <p className="texto-suave" style={{ margin: '4px 0 0' }}>
            Mensagem pessoal para cada cliente, escrita pela IA a partir do histórico de atendimento.
          </p>
        </div>
        {campanha && <Status valor={campanha.status} />}
      </header>

      <Etapas atual={etapa} liberada={liberada} aoIr={irPara} />

      {erroMsg && erro?.codigo !== 'VALIDACAO' && (
        <Aviso tom="perigo" aoFechar={() => setErro(null)}>
          {erroMsg}
        </Aviso>
      )}

      {etapa === 0 && (
        <Cartao titulo="Dê um nome e escolha o número que envia">
          <div className="assist__secao" style={{ maxWidth: 560 }}>
            <Campo rotulo="Nome da campanha" obrigatorio erro={errosCampo.nome} dica="Só a equipe vê. Ex.: Resgate de setembro">
              <Entrada
                autoFocus
                value={criar.nome}
                onChange={(e) => setCriar({ ...criar, nome: e.target.value })}
                placeholder="Resgate de clientes inativos"
              />
            </Campo>
            <Campo rotulo="Enviar pelo número" obrigatorio erro={errosCampo.channelInstanceId}>
              <Selecao
                value={criar.channelInstanceId}
                onChange={(e) => setCriar({ ...criar, channelInstanceId: e.target.value })}
              >
                <option value="">Escolha a conexão de WhatsApp</option>
                {listaCanais.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome}
                    {c.status !== 'conectado' ? ` (${c.status})` : ''}
                  </option>
                ))}
              </Selecao>
            </Campo>
            {canal && canal.status !== 'conectado' && (
              <Aviso tom="alerta">
                Este número está desconectado agora. Dá para montar a campanha, mas o envio só anda quando ele estiver
                conectado.
              </Aviso>
            )}
            {publico.length > 0 && !campanha && (
              <Aviso tom="info">{publico.length} contato(s) trazidos da página de Contatos já estão no público.</Aviso>
            )}
          </div>
        </Cartao>
      )}

      {etapa === 1 && <EtapaContatos publico={publico} setPublico={setPublico} />}

      {etapa === 2 && campanha && (
        <EtapaIa campanha={campanha} ia={ia} setIa={setIa} pulados={pulados} aoFecharPulados={() => setPulados([])} />
      )}

      {etapa === 3 && campanha && <EtapaMensagens campanha={campanha} />}

      {etapa === 4 && campanha && <EtapaEnvio campanha={campanha} envio={envio} setEnvio={setEnvio} canal={canal} />}

      <footer className="assist__rodape">
        <span className="assist__rodape-info">{infoRodape}</span>
        <div className="linha">
          <Botao
            variante="secundario"
            onClick={() => (etapa === 0 ? navegar('/campanhas') : irPara(etapa - 1))}
          >
            {etapa === 0 ? 'Cancelar' : 'Voltar'}
          </Botao>
          {etapa < 4 ? (
            <Botao
              carregando={salvar.isPending}
              disabled={!podeContinuar}
              onClick={() => (etapa === 3 ? irPara(4) : salvar.mutate(etapa))}
            >
              {etapa === 2 && p.aguardando > 0 ? `Gerar ${p.aguardando} mensagem(ns)` : 'Continuar'}
            </Botao>
          ) : (
            <>
              <Botao variante="secundario" carregando={disparar.isPending && !disparar.variables} onClick={() => disparar.mutate(false)}>
                Salvar e enviar depois
              </Botao>
              <Botao carregando={disparar.isPending && disparar.variables} onClick={() => disparar.mutate(true)}>
                Iniciar disparo
              </Botao>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}
