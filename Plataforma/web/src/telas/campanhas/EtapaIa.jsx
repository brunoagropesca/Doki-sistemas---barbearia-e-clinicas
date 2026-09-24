import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { AreaTexto, Aviso, Botao, Campo, Cartao, Entrada } from '../../componentes/ui.jsx';
import { Interruptor } from '../conexoes/Interruptor.jsx';
import '../Conexoes.css';

/**
 * Etapa 3 — o que a IA deve dizer, e como.
 *
 * O objetivo e o "prompt" do dono: o que ele quer que a mensagem consiga.
 * O resto sao ajustes de estilo. A IA junta os dois com o historico de cada
 * cliente (atendimentos, resumos, ultimas mensagens) e escreve uma mensagem
 * diferente para cada um.
 *
 * O teste ao lado escreve para clientes de verdade do publico, sem gravar
 * nada — calibrar aqui custa 3 chamadas de IA; descobrir o problema depois
 * de gerar 300 custa 300.
 */

export const IA_PADRAO = {
  tom: 'amigavel',
  tamanho: 'curta',
  ousadia: 'equilibrada',
  emojis: true,
  usarHistorico: true,
  assinatura: '',
  evitar: ''
};

const EXEMPLOS = [
  {
    rotulo: 'Resgatar quem sumiu',
    texto:
      'Trazer de volta clientes que não aparecem há um tempo. Lembrar do último serviço com naturalidade e convidar para marcar um horário esta semana, sem parecer promoção.'
  },
  {
    rotulo: 'Avisar uma novidade',
    texto: 'Contar que temos um serviço novo (descreva aqui) e perguntar se o cliente gostaria de experimentar.'
  },
  {
    rotulo: 'Lembrar do retorno',
    texto:
      'Lembrar que já está na hora de fazer a manutenção do último serviço e oferecer ajuda para encontrar um horário.'
  },
  {
    rotulo: 'Pedir opinião',
    texto: 'Agradecer pela última visita e perguntar, de forma leve, o que o cliente achou do atendimento.'
  }
];

const TONS = [
  ['amigavel', 'Amigável'],
  ['profissional', 'Profissional'],
  ['descontraido', 'Descontraído']
];

const TAMANHOS = [
  ['curta', 'Curta (1–2 frases)'],
  ['media', 'Média (2–4 frases)'],
  ['longa', 'Longa (4–6 frases)']
];

const OUSADIAS = [
  ['contida', 'Contida'],
  ['equilibrada', 'Equilibrada'],
  ['ousada', 'Ousada']
];

const DICA_OUSADIA = {
  contida: 'Discreta e educada, sem brincadeira. Boa para avisos e clientes mais formais.',
  equilibrada: 'Natural, com um toque de personalidade.',
  ousada: 'Brinca, usa gíria leve, abre com algo inesperado. Mais variedade entre as mensagens.'
};

const NOMES_PROVEDOR = { gemini: 'Gemini', groq: 'Groq', openai: 'ChatGPT', ollama: 'Ollama' };

/** "groq:qwen/qwen3.8-27b" -> "Groq · qwen/qwen3.8-27b" */
function nomeDoModelo(valor) {
  if (!valor) return 'Automático (cascata de IA)';
  const i = valor.indexOf(':');
  return `${NOMES_PROVEDOR[valor.slice(0, i)] ?? valor.slice(0, i)} · ${valor.slice(i + 1)}`;
}

/**
 * Quem vai escrever: o Aquiles, com o modelo e os ajustes dele.
 * Responde de antemao a pergunta "e a IA mesmo? qual?".
 */
function QuemEscreve() {
  const agentes = useQuery({ queryKey: ['ia', 'agentes'], queryFn: () => api.get('/api/ia/agentes') });
  const aquiles = agentes.data?.agentes?.find((a) => a.chave === 'aquiles');
  if (!aquiles) return null;

  const exemplos = aquiles.config?.exemplos?.length ?? 0;
  const detalhes = [
    nomeDoModelo(aquiles.modeloPreferido),
    aquiles.config?.herdarSofia ? 'voz da Sofia' : null,
    exemplos ? `${exemplos} exemplo(s) de estilo` : 'sem exemplos de estilo'
  ].filter(Boolean);

  return (
    <Aviso tom={aquiles.ativo ? 'info' : 'perigo'} titulo={aquiles.ativo ? `Quem escreve: ${aquiles.nome}` : 'O Aquiles está desligado'}>
      {aquiles.ativo ? detalhes.join(' · ') : 'Sem ele as mensagens não podem ser geradas.'}{' '}
      <Link to="/ia?aba=personas">Configurar o Aquiles</Link>
      {aquiles.ativo && !exemplos && ' — colar 2 ou 3 mensagens do jeito da casa deixa o texto bem mais natural.'}
    </Aviso>
  );
}

/**
 * Rotulo + controle, com a mesma cara do `Campo` — mas sem ser <label>. O
 * `Campo` e um <label>, e um <label> em volta de botoes transforma o clique no
 * texto do rotulo num clique no primeiro botao.
 */
export function Grupo({ rotulo, children }) {
  return (
    <div className="campo">
      <span className="campo__rotulo">{rotulo}</span>
      {children}
    </div>
  );
}

function Segmentos({ opcoes, valor, aoMudar, rotulo }) {
  return (
    <div className="segmentos" role="radiogroup" aria-label={rotulo}>
      {opcoes.map(([v, texto]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={valor === v}
          className={`segmento ${valor === v ? 'segmento--ativo' : ''}`}
          onClick={() => aoMudar(v)}
        >
          {texto}
        </button>
      ))}
    </div>
  );
}

export function EtapaIa({ campanha, ia, setIa, pulados, aoFecharPulados }) {
  const cfg = ia.iaConfig;
  const mudarCfg = (campo, valor) => setIa((atual) => ({ ...atual, iaConfig: { ...atual.iaConfig, [campo]: valor } }));

  const previa = useMutation({
    mutationFn: () =>
      api.post(`/api/campanhas/${campanha.id}/previa`, { quantidade: 3, objetivo: ia.objetivo, iaConfig: ia.iaConfig })
  });
  const amostras = previa.data?.amostras ?? [];
  const iaFalhou = amostras.length > 0 && amostras.every((a) => a.reserva);

  return (
    <div className="coluna">
      <QuemEscreve />
      {pulados.length > 0 && (
        <Aviso tom="alerta" titulo={`${pulados.length} contato(s) ficaram de fora`} aoFechar={aoFecharPulados}>
          {pulados
            .slice(0, 6)
            .map((p) => `${p.nome} (${p.motivo.toLowerCase()})`)
            .join(' · ')}
          {pulados.length > 6 ? ` · e mais ${pulados.length - 6}` : ''}
        </Aviso>
      )}

      <div className="assist__duas">
        <Cartao titulo="O que a mensagem deve conseguir">
          <div className="assist__secao">
            <Campo
              rotulo="Objetivo da campanha"
              obrigatorio
              dica="Escreva como explicaria para alguém da equipe. A IA junta isto com o histórico de cada cliente."
            >
              <AreaTexto
                value={ia.objetivo}
                onChange={(e) => setIa({ ...ia, objetivo: e.target.value })}
                rows={5}
                placeholder="Ex.: Trazer de volta quem não vem há mais de 60 dias. Temos horários livres nas terças e quartas; convide sem parecer promoção."
              />
            </Campo>
            <div className="exemplos">
              {EXEMPLOS.map((ex) => (
                <button key={ex.rotulo} type="button" className="filtro-chip" onClick={() => setIa({ ...ia, objetivo: ex.texto })}>
                  {ex.rotulo}
                </button>
              ))}
            </div>

            <Grupo rotulo="Tom">
              <Segmentos rotulo="Tom da mensagem" opcoes={TONS} valor={cfg.tom} aoMudar={(v) => mudarCfg('tom', v)} />
            </Grupo>
            <Grupo rotulo="Tamanho">
              <Segmentos rotulo="Tamanho da mensagem" opcoes={TAMANHOS} valor={cfg.tamanho} aoMudar={(v) => mudarCfg('tamanho', v)} />
            </Grupo>
            <Grupo rotulo="Ousadia">
              <Segmentos rotulo="Ousadia da mensagem" opcoes={OUSADIAS} valor={cfg.ousadia} aoMudar={(v) => mudarCfg('ousadia', v)} />
              <span className="campo__dica">{DICA_OUSADIA[cfg.ousadia] ?? DICA_OUSADIA.equilibrada}</span>
            </Grupo>

            <Interruptor
              rotulo="Usar o histórico de atendimento"
              descricao="A IA lê os atendimentos, resumos, anotações da equipe e as últimas mensagens de cada cliente. Desligado, ela só sabe o nome."
              ligado={cfg.usarHistorico}
              aoAlternar={(v) => mudarCfg('usarHistorico', v)}
            />
            <Interruptor
              rotulo="Pode usar emoji"
              descricao="Um no máximo (até dois na ousadia alta), e só quando ficar natural."
              ligado={cfg.emojis}
              aoAlternar={(v) => mudarCfg('emojis', v)}
            />

            <div className="grade">
              <Campo rotulo="Assinar como (opcional)" dica="Ex.: Bruno. A mensagem soa como vinda de uma pessoa.">
                <Entrada value={cfg.assinatura} maxLength={80} onChange={(e) => mudarCfg('assinatura', e.target.value)} placeholder="Bruno" />
              </Campo>
            </div>
            <Campo rotulo="O que a IA deve evitar (opcional)">
              <AreaTexto
                value={cfg.evitar}
                maxLength={500}
                rows={2}
                onChange={(e) => mudarCfg('evitar', e.target.value)}
                placeholder="Ex.: não falar de preço; não mencionar a unidade do centro"
              />
            </Campo>
          </div>
        </Cartao>

        <Cartao titulo="Teste antes de gerar">
          <div className="assist__secao">
            <p className="assist__ajuda">
              A IA escreve para 3 clientes sorteados do público, com a configuração ao lado. Nada é salvo nem enviado.
            </p>
            <Botao variante="secundario" carregando={previa.isPending} disabled={!ia.objetivo.trim()} onClick={() => previa.mutate()}>
              {amostras.length ? 'Testar de novo' : 'Testar com 3 clientes'}
            </Botao>

            {previa.isError && <Aviso tom="perigo">{previa.error.message}</Aviso>}
            {iaFalhou && (
              <Aviso tom="alerta">
                A IA não respondeu e o teste mostrou o texto genérico de reserva. Confira as chaves em Inteligência Artificial →
                Cascata antes de gerar.
              </Aviso>
            )}

            <div className="previas">
              {amostras.map((a) => (
                <div key={a.leadId} className="previa">
                  <span className="previa__nome">
                    Para {a.nome}
                    {a.autor ? ` · escrita por ${a.autor}` : ''}
                  </span>
                  <div className="balao">{a.mensagem}</div>
                  <details className="contexto-ia">
                    <summary>O que a IA leu deste cliente</summary>
                    <ul>
                      {a.contexto.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  </details>
                </div>
              ))}
            </div>
          </div>
        </Cartao>
      </div>
    </div>
  );
}
