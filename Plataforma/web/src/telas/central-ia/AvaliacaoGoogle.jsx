import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { AreaTexto, Aviso, Botao, Campo, Entrada, Modal } from '../../componentes/ui.jsx';

/**
 * Funcao da Sofia: pedir avaliacao no Google ao finalizar o atendimento.
 *
 * Liga e desliga na hora (como o "Ativo" do agente) — nao depende do "Salvar
 * Atendente". Ligada, aparece a engrenagem com o link e a mensagem base. O
 * envio em si fica na API (automacao/avaliacaoGoogle.js): 1º balao escrito
 * pela IA a partir da conversa, 2º so o link; cliente frustrado nao recebe.
 */

const MENSAGEM_PADRAO =
  'Obrigado pela preferência! Se puder, deixe sua avaliação no Google — leva 1 minutinho e ajuda muito a gente a crescer.';

function linkValido(link) {
  try {
    const u = new URL(link.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && Boolean(u.hostname);
  } catch {
    return false;
  }
}

export function AvaliacaoGoogle({ agente }) {
  const atual = {
    ativo: Boolean(agente.config?.avaliacaoGoogle?.ativo),
    link: agente.config?.avaliacaoGoogle?.link ?? '',
    mensagem: agente.config?.avaliacaoGoogle?.mensagem ?? ''
  };
  const [aberto, setAberto] = useState(false);
  const [form, setForm] = useState(atual);

  const queryClient = useQueryClient();
  const salvar = useMutation({
    mutationFn: (avaliacaoGoogle) => api.put('/api/ia/agentes/atendente', { config: { avaliacaoGoogle } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ia', 'agentes'] })
  });

  function abrir() {
    setForm(atual);
    salvar.reset();
    setAberto(true);
  }

  const linkTorto = form.link.trim() !== '' && !linkValido(form.link);

  return (
    <fieldset className="ci-permissoes">
      <legend>AUTOMAÇÕES DA SOFIA</legend>
      <div className="ci-automacao">
        <label className="ci-permissao crescer" title="Ao finalizar o atendimento, a Sofia agradece e pede a avaliação no Google.">
          <input
            type="checkbox"
            checked={atual.ativo}
            disabled={salvar.isPending}
            onChange={(e) => salvar.mutate({ ...atual, ativo: e.target.checked })}
          />
          <span>
            AVALIAÇÃO DO GOOGLE
            <small className="ci-automacao__descricao">
              Ao finalizar, a Sofia agradece e manda o link da avaliação. Cliente frustrado não recebe.
            </small>
            {atual.ativo && !linkValido(atual.link) && (
              <small className="ci-permissao__aviso">Falta o link da avaliação: configure na engrenagem.</small>
            )}
          </span>
        </label>
        {atual.ativo && (
          <button
            type="button"
            className="ci-engrenagem"
            onClick={abrir}
            aria-label="Configurar avaliação do Google"
            title="Configurar avaliação do Google"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </button>
        )}
      </div>
      {salvar.isError && !aberto && <Aviso tom="perigo">{salvar.error.message}</Aviso>}

      <Modal
        titulo="Avaliação do Google"
        aberto={aberto}
        aoFechar={() => setAberto(false)}
        largura={560}
        rodape={
          <>
            <Botao variante="secundario" onClick={() => setAberto(false)}>
              Cancelar
            </Botao>
            <Botao
              carregando={salvar.isPending}
              disabled={linkTorto}
              onClick={() => salvar.mutate({ ...form, ativo: atual.ativo }, { onSuccess: () => setAberto(false) })}
            >
              Salvar
            </Botao>
          </>
        }
      >
        <div className="coluna">
          <Campo
            rotulo="LINK DA AVALIAÇÃO"
            obrigatorio
            erro={linkTorto ? 'Cole o endereço completo, começando com https://' : undefined}
            dica="No Perfil da Empresa no Google: “Pedir avaliações” → copiar o link."
          >
            <Entrada
              value={form.link}
              placeholder="https://g.page/r/.../review"
              onChange={(e) => setForm({ ...form, link: e.target.value })}
            />
          </Campo>
          <Campo
            rotulo="MENSAGEM AUTOMÁTICA"
            dica="É a base: a Sofia adapta à conversa (nome do cliente, serviço feito) com a IA. Sem IA no ar, vai exatamente este texto."
          >
            <AreaTexto
              value={form.mensagem}
              maxLength={600}
              placeholder={MENSAGEM_PADRAO}
              style={{ minHeight: 90 }}
              onChange={(e) => setForm({ ...form, mensagem: e.target.value })}
            />
          </Campo>

          <div className="ci-avaliacao__previa" aria-label="Como chega ao cliente">
            <span className="campo__rotulo">COMO CHEGA AO CLIENTE</span>
            <div className="ci-avaliacao__balao">{form.mensagem.trim() || MENSAGEM_PADRAO}</div>
            <div className="ci-avaliacao__balao ci-avaliacao__balao--link">
              {form.link.trim() || 'https://g.page/r/.../review'}
            </div>
          </div>

          <p className="texto-fraco ci-avaliacao__regras">
            Não recebe: cliente frustrado; quem faltou ou cancelou; conversa encerrada por inatividade. Cada
            atendimento pede no máximo uma vez.
          </p>
          {salvar.isError && <Aviso tom="perigo">{salvar.error.message}</Aviso>}
        </div>
      </Modal>
    </fieldset>
  );
}
