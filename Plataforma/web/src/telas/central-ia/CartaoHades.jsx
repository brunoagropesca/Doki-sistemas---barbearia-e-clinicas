import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { AreaTexto, Aviso, Botao, Campo, Entrada, Selecao } from '../../componentes/ui.jsx';

/**
 * Hades — o assistente administrativo do dono (botao flutuante no canto).
 *
 * Fica A PARTE do resto: chave de API propria do Gemini, modelo proprio, sem
 * cascata. Nada daqui muda o atendimento dos clientes. So o dono e o DEV veem
 * este cartao; o DEV pode desligar o Hades inteiro em Funcoes do sistema.
 */
export function CartaoHades({ config }) {
  const queryClient = useQueryClient();
  const atualizar = () => queryClient.invalidateQueries({ queryKey: ['hades', 'config'] });
  const salvar = useMutation({ mutationFn: (dados) => api.put('/api/hades/config', dados), onSuccess: atualizar });
  const testar = useMutation({ mutationFn: () => api.post('/api/hades/testar', {}) });

  // Nasce do servidor e nao e sobrescrito em segundo plano (mesma regra dos outros).
  const [form, setForm] = useState({
    nome: config.nome,
    temperatura: config.temperatura,
    systemPrompt: config.systemPrompt,
    pesquisaWeb: config.pesquisaWeb,
    modelo: config.modelo ?? ''
  });
  const [chave, setChave] = useState('');

  const modelos = useQuery({
    queryKey: ['hades', 'modelos', config.chaveFinal],
    queryFn: () => api.get('/api/hades/modelos'),
    enabled: config.temChave,
    staleTime: 10 * 60_000,
    retry: false
  });

  function gravar() {
    salvar.mutate({
      nome: form.nome,
      temperatura: form.temperatura,
      systemPrompt: form.systemPrompt,
      pesquisaWeb: form.pesquisaWeb,
      modelo: form.modelo || null
    });
  }

  function gravarChave() {
    salvar.mutate({ apiKey: chave.trim() }, { onSuccess: () => { setChave(''); testar.reset(); } });
  }

  return (
    <section className="ci-agente ci-agente--hades">
      <header className="ci-agente__topo">
        <span className="ci-agente__avatar" aria-hidden="true">🔥</span>
        <div className="crescer">
          <h3>{config.nome}</h3>
          <span className="ci-selo ci-selo--hades">ASSISTENTE DO DONO • NEGÓCIO E MERCADO</span>
        </div>
        <label className="ci-interruptor">
          <input
            type="checkbox"
            checked={config.ativo}
            disabled={salvar.isPending}
            onChange={(e) => salvar.mutate({ ativo: e.target.checked })}
          />
          <span className="ci-interruptor__trilho" aria-hidden="true" />
          <span className="ci-interruptor__texto">{config.ativo ? 'Ativo' : 'Desligado'}</span>
        </label>
      </header>

      <div className="ci-modelo ci-modelo--hades">
        <span aria-hidden="true">🗝️</span>
        <div>
          <div>
            Conversa com você pelo <strong>botão flutuante</strong> no canto inferior direito: lê os números do negócio,
            pesquisa tendências do ramo na internet e sugere promoções e rumos.
          </div>
          <div className="texto-fraco">
            Separado do atendimento: chave e modelo próprios, sem cascata. Só você (e o DEV) vê o Hades.
          </div>
        </div>
      </div>

      {salvar.isError && <Aviso tom="perigo">{salvar.error.message}</Aviso>}
      {salvar.isSuccess && !salvar.variables?.apiKey && <Aviso tom="sucesso">{config.nome} salvo.</Aviso>}
      {!config.ativo && <Aviso tom="alerta">Com o {config.nome} desligado, o botão flutuante some.</Aviso>}

      {/* A conexao propria: a chave nunca volta do servidor, so o final dela. */}
      <fieldset className="ci-permissoes">
        <legend>CONEXÃO PRÓPRIA DO {config.nome.toUpperCase()} (GEMINI)</legend>
        <div className="ci-hades__chave">
          <Campo
            rotulo="CHAVE DE API DO GOOGLE GEMINI"
            dica={
              config.temChave
                ? `Chave salva, terminando em …${config.chaveFinal}. Cole outra para trocar.`
                : 'Crie grátis em aistudio.google.com (Get API key). Use uma chave só do Hades.'
            }
          >
            <Entrada
              type="password"
              autoComplete="off"
              value={chave}
              placeholder={config.temChave ? `•••• •••• ${config.chaveFinal}` : 'AIza…'}
              onChange={(e) => setChave(e.target.value)}
            />
          </Campo>
          <div className="linha">
            <Botao tamanho="sm" disabled={chave.trim().length < 10} carregando={salvar.isPending && salvar.variables?.apiKey !== undefined} onClick={gravarChave}>
              {config.temChave ? 'Trocar chave' : 'Salvar chave'}
            </Botao>
            {config.temChave && (
              <>
                <Botao tamanho="sm" variante="secundario" carregando={testar.isPending} onClick={() => testar.mutate()}>
                  Testar conexão
                </Botao>
                <Botao
                  tamanho="sm"
                  variante="fantasma"
                  onClick={() => window.confirm(`Remover a chave do ${config.nome}? Ele para de responder até colar outra.`) && salvar.mutate({ apiKey: null })}
                >
                  Remover
                </Botao>
              </>
            )}
          </div>
          {testar.isSuccess && (
            <Aviso tom="sucesso">
              Conectado: {testar.data.modelo.replace('models/', '')} respondeu em {(testar.data.latenciaMs / 1000).toFixed(1)} s.
            </Aviso>
          )}
          {testar.isError && <Aviso tom="perigo">{testar.error.message}</Aviso>}
        </div>

        <Campo
          rotulo="MODELO"
          dica={modelos.isError ? modelos.error.message : 'Automático: o "flash" mais novo que a chave enxerga — rápido e bom de conversa.'}
        >
          <Selecao value={form.modelo} disabled={!config.temChave} onChange={(e) => setForm({ ...form, modelo: e.target.value })}>
            <option value="">
              Automático{modelos.data?.sugerido ? ` (${modelos.data.sugerido.replace('models/', '')})` : ''}
            </option>
            {(modelos.data?.modelos ?? []).map((m) => (
              <option key={m.nome} value={m.nome}>
                {m.nomeExibicao ?? m.nome.replace('models/', '')}
              </option>
            ))}
            {form.modelo && !(modelos.data?.modelos ?? []).some((m) => m.nome === form.modelo) && (
              <option value={form.modelo}>{form.modelo.replace('models/', '')}</option>
            )}
          </Selecao>
        </Campo>
      </fieldset>

      <fieldset className="ci-permissoes">
        <legend>FERRAMENTAS &amp; PERMISSÕES DO {config.nome.toUpperCase()} (TOOLS)</legend>
        <div className="ci-permissoes__grade">
          <label className="ci-permissao ci-permissao--fixa" title="Os mesmos números do Dashboard, dos últimos 30 dias e do ano.">
            <input type="checkbox" checked disabled readOnly />
            <span>
              LER OS NÚMEROS DO NEGÓCIO <small className="ci-permissao__sempre">SEMPRE</small>
            </span>
          </label>
          <label className="ci-permissao" title="Tendências do ramo, datas comemorativas, preços e novidades — sempre com as fontes.">
            <input type="checkbox" checked={form.pesquisaWeb} onChange={(e) => setForm({ ...form, pesquisaWeb: e.target.checked })} />
            <span>PESQUISAR NA INTERNET (GOOGLE)</span>
          </label>
        </div>
        <p className="texto-fraco ci-permissoes__nota">
          Só aconselha: não marca, não cancela e não manda mensagem para ninguém.
        </p>
      </fieldset>

      <div className="ci-duas">
        <Campo rotulo="NOME">
          <Entrada value={form.nome} maxLength={40} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
        </Campo>
        <Campo rotulo={`TEMPERATURA / CRIATIVIDADE: ${Number(form.temperatura).toFixed(1)}`}>
          <input
            type="range"
            className="ci-slider ci-slider--hades"
            min="0"
            max="1.2"
            step="0.1"
            value={form.temperatura}
            onChange={(e) => setForm({ ...form, temperatura: Number(e.target.value) })}
          />
        </Campo>
      </div>

      <Campo
        rotulo="PERSONA & DIRETRIZES"
        dica="Quem ele é e como conversa. As regras fixas (não inventar números, citar as fontes, só aconselhar) valem sempre."
      >
        <AreaTexto value={form.systemPrompt} style={{ minHeight: 130 }} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })} />
      </Campo>

      <div className="linha linha--entre" style={{ marginTop: 'var(--e2)' }}>
        <Botao
          variante="fantasma"
          tamanho="sm"
          type="button"
          disabled={form.systemPrompt === config.personaPadrao}
          onClick={() => setForm({ ...form, systemPrompt: config.personaPadrao })}
        >
          Restaurar persona padrão
        </Botao>
        <Botao carregando={salvar.isPending && salvar.variables?.apiKey === undefined} onClick={gravar} className="ci-botao-hades">
          Salvar {config.nome}
        </Botao>
      </div>
    </section>
  );
}
