import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { AreaTexto, Aviso, Botao, Campo, Entrada } from '../../componentes/ui.jsx';
import { Interruptor } from '../conexoes/Interruptor.jsx';
import { SeletorModelo } from './SeletorModelo.jsx';
import '../Conexoes.css';

/**
 * Aquiles — o agente que escreve as mensagens das campanhas.
 *
 * Tres alavancas contra a mensagem "sem graca":
 *   - o MODELO: campanha e pouca mensagem e muito caprichada, entao vale um
 *     modelo maior so para ele, sem mexer no custo do atendimento;
 *   - os EXEMPLOS: mostrar 2 ou 3 mensagens do jeito da casa ensina mais do
 *     que qualquer adjetivo no prompt;
 *   - a VOZ DA SOFIA: para quem responde a campanha nao estranhar a mudanca de
 *     tom quando a Sofia assume a conversa.
 */

const MAX_EXEMPLOS = 5;
const MAX_CARACTERES = 600;
const NOMES_PROVEDOR = { gemini: 'Gemini', groq: 'Groq', openai: 'ChatGPT', ollama: 'Ollama' };

/** Opcoes do seletor: "automatico" + os modelos ligados de cada provedor pronto. */
function opcoesDeModelo(provedores) {
  const opcoes = [{ valor: '', nome: 'Automático (cascata de IA)', tom: 'neutro', detalhe: '', destaque: false }];

  for (const p of provedores) {
    if (!p.habilitado || (p.precisaChave && !p.temChave)) continue;
    for (const m of p.modelos ?? []) {
      if (m.ativo === false) continue;
      opcoes.push({
        valor: `${p.provedor}:${m.nome}`,
        nome: `${NOMES_PROVEDOR[p.provedor] ?? p.provedor} · ${m.nome}`,
        tom: m.ok === true ? 'sucesso' : m.ok === false ? 'perigo' : 'neutro',
        detalhe: m.ok === true && m.latenciaMs ? `${(m.latenciaMs / 1000).toFixed(1)}s` : m.ok === false ? 'falhou no teste' : '',
        destaque: false
      });
    }
  }
  return opcoes;
}

export function CartaoAquiles({ agente, provedores }) {
  const queryClient = useQueryClient();
  const salvar = useMutation({
    mutationFn: (dados) => api.put('/api/ia/agentes/aquiles', dados),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ia', 'agentes'] })
  });

  // Nasce do servidor e nao e sobrescrito em segundo plano (mesma regra da Sofia).
  const [form, setForm] = useState({
    nome: agente.nome,
    temperatura: agente.temperatura,
    systemPrompt: agente.systemPrompt,
    modeloPreferido: agente.modeloPreferido ?? '',
    exemplos: agente.config?.exemplos?.length ? agente.config.exemplos : [''],
    herdarSofia: Boolean(agente.config?.herdarSofia)
  });

  const opcoes = opcoesDeModelo(provedores);
  const exemplosValidos = form.exemplos.map((e) => e.trim()).filter(Boolean);

  function mudarExemplo(i, texto) {
    setForm((f) => ({ ...f, exemplos: f.exemplos.map((e, j) => (j === i ? texto : e)) }));
  }

  function gravar() {
    salvar.mutate({
      nome: form.nome,
      temperatura: form.temperatura,
      systemPrompt: form.systemPrompt,
      modeloPreferido: form.modeloPreferido || null,
      config: { exemplos: exemplosValidos, herdarSofia: form.herdarSofia }
    });
  }

  return (
    <section className="ci-agente ci-agente--aquiles">
      <header className="ci-agente__topo">
        <span className="ci-agente__avatar" aria-hidden="true">🏹</span>
        <div className="crescer">
          <h3>{agente.nome}</h3>
          <span className="ci-selo ci-selo--aquiles">CAMPANHAS • ESCREVE CADA MENSAGEM DO DISPARO</span>
        </div>
        <label className="ci-interruptor">
          <input
            type="checkbox"
            checked={agente.ativo}
            disabled={salvar.isPending}
            onChange={(e) => salvar.mutate({ ativo: e.target.checked })}
          />
          <span className="ci-interruptor__trilho" aria-hidden="true" />
          <span className="ci-interruptor__texto">{agente.ativo ? 'Ativo' : 'Desligado'}</span>
        </label>
      </header>

      <div className="ci-modelo ci-modelo--aquiles">
        <span aria-hidden="true">✍️</span>
        <div>
          <div>
            Escreve a mensagem pessoal de cada cliente nas <Link to="/campanhas">Campanhas</Link>, a partir do histórico
            de atendimento. Nada sai sem revisão humana.
          </div>
          <div className="texto-fraco">
            Objetivo, tom, tamanho e ousadia são escolhidos em cada campanha. Aqui fica quem ele é.
          </div>
        </div>
      </div>

      {/* Mesmo quadro dos outros agentes, para ficar claro que nao ha o que
          ligar: o Aquiles nao consulta nem altera nada, so escreve o texto. */}
      <fieldset className="ci-permissoes">
        <legend>FERRAMENTAS &amp; PERMISSÕES DO AQUILES (TOOLS)</legend>
        <p className="texto-fraco ci-permissoes__nota">
          Nenhuma. O Aquiles não consulta a agenda nem altera dados: recebe o histórico do cliente já pronto e devolve
          só o texto, que ainda passa pela revisão de uma pessoa.
        </p>
      </fieldset>

      {salvar.isError && <Aviso tom="perigo">{salvar.error.message}</Aviso>}
      {salvar.isSuccess && <Aviso tom="sucesso">Aquiles salvo.</Aviso>}
      {!agente.ativo && <Aviso tom="alerta">Com o Aquiles desligado, as campanhas não conseguem gerar mensagens.</Aviso>}

      <div className="ci-aquiles__colunas">
        <div className="coluna">
          <div className="coluna">
            <Campo rotulo="NOME DO AGENTE">
              <Entrada value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
            </Campo>
            <div className="campo">
              <span className="campo__rotulo">MODELO DE IA</span>
              <SeletorModelo
                rotulo="Modelo de IA do Aquiles"
                valor={form.modeloPreferido}
                opcoes={opcoes}
                aoEscolher={(valor) => setForm({ ...form, modeloPreferido: valor })}
              />
              <span className="campo__dica">
                Um modelo maior escreve melhor. Se ele falhar, a cascata assume como reserva.
              </span>
            </div>
          </div>

          <Campo
            rotulo={`TEMPERATURA / CRIATIVIDADE: ${Number(form.temperatura).toFixed(2)}`}
            dica="Alta de propósito: 200 mensagens parecidas entre si são exatamente o que o WhatsApp reconhece como disparo."
          >
            <input
              type="range"
              className="ci-slider ci-slider--aquiles"
              min="0.3"
              max="1.2"
              step="0.05"
              value={form.temperatura}
              onChange={(e) => setForm({ ...form, temperatura: Number(e.target.value) })}
            />
          </Campo>

          <Interruptor
            rotulo="Falar com a voz da Sofia"
            descricao="O Aquiles adota a personalidade da atendente. Quem responder à campanha não estranha a troca de tom quando a Sofia assume a conversa."
            ligado={form.herdarSofia}
            aoAlternar={(v) => setForm({ ...form, herdarSofia: v })}
          />

          <Campo rotulo="PERSONA & DIRETRIZES" dica="Quem o Aquiles é. As regras de segurança (não inventar, não soar como ficha) são aplicadas sempre.">
            <AreaTexto
              value={form.systemPrompt}
              style={{ minHeight: 140 }}
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            />
          </Campo>
        </div>

        <div className="coluna">
          <div className="campo">
            <span className="campo__rotulo">
              EXEMPLOS DO JEITO DA CASA ({exemplosValidos.length}/{MAX_EXEMPLOS})
            </span>
            <p className="texto-fraco" style={{ margin: 0 }}>
              Cole 2 ou 3 mensagens que você mandaria de verdade. O Aquiles imita o ritmo, as gírias e a energia — nunca o
              conteúdo, nem os nomes.
            </p>
            <div className="ci-exemplos">
              {form.exemplos.map((ex, i) => (
                <div key={i} className="ci-exemplo">
                  <AreaTexto
                    value={ex}
                    maxLength={MAX_CARACTERES}
                    aria-label={`Exemplo ${i + 1}`}
                    placeholder={
                      i === 0
                        ? 'Ex.: Fala, Rafa! Tá sumido, hein 😄 Sábado de manhã tem cadeira livre com o Zé, bora deixar o corte em dia?'
                        : 'Outro exemplo...'
                    }
                    onChange={(e) => mudarExemplo(i, e.target.value)}
                  />
                  <button
                    type="button"
                    className="ci-exemplo__tirar"
                    aria-label={`Tirar exemplo ${i + 1}`}
                    onClick={() =>
                      setForm((f) => ({ ...f, exemplos: f.exemplos.length > 1 ? f.exemplos.filter((_, j) => j !== i) : [''] }))
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            {form.exemplos.length < MAX_EXEMPLOS && (
              <div>
                <Botao
                  tamanho="sm"
                  variante="secundario"
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, exemplos: [...f.exemplos, ''] }))}
                >
                  + Adicionar exemplo
                </Botao>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="linha linha--fim" style={{ marginTop: 'var(--e4)' }}>
        <Botao carregando={salvar.isPending} onClick={gravar} className="ci-botao-aquiles">
          Salvar Aquiles
        </Botao>
      </div>
    </section>
  );
}
