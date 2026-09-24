import { useId, useState } from 'react';
import { Botao, Entrada } from '../../componentes/ui.jsx';
import { EstadoSessao } from './EstadoSessao.jsx';
import { NOME_SESSAO_MAX, NOME_SESSAO_MIN, formatarTelefone } from './formatar.js';
import { useCriarSessao } from './hooks.js';

/**
 * Coluna "SESSÕES 1/5": uma linha por conta de WhatsApp.
 *
 * So o perfil tecnico ve "Nova sessão" e a etiqueta dele. Para o dono, a
 * lista e so isso: escolher qual conta operar. Ele nao ve botao desabilitado
 * nem menção a outro perfil; so uma dica para falar com o suporte.
 */
export function ListaSessoes({ canais, limite, selecionada, aoEscolher, ehDev }) {
  return (
    <aside className="cx-sessoes" aria-label="Sessões de WhatsApp">
      <div className="cx-sessoes__topo">
        <span className="cx-sessoes__titulo">Sessões</span>
        <span className="cx-sessoes__contagem" aria-label={`${canais.length} de ${limite} sessões`}>
          {canais.length}/{limite}
        </span>
      </div>

      {canais.length === 0 ? (
        <p className="texto-fraco cx-sessoes__vazio">Nenhuma sessão configurada ainda.</p>
      ) : (
        <ul className="cx-sessoes__lista">
          {canais.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={`cx-sessao ${selecionada === c.chave ? 'cx-sessao--ativa' : ''}`}
                aria-current={selecionada === c.chave ? 'true' : undefined}
                onClick={() => aoEscolher(c.chave)}
              >
                <span className="cx-sessao__chave">{c.chave}</span>
                <span className="cx-sessao__corpo">
                  <span className="cx-sessao__nome">{c.nome}</span>
                  <span className="cx-sessao__numero">{formatarTelefone(c.identificador) || 'Sem número pareado'}</span>
                  <EstadoSessao canal={c} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {ehDev ? (
        <NovaSessao total={canais.length} limite={limite} aoCriada={aoEscolher} />
      ) : (
        <p className="texto-fraco cx-sessoes__dica">Para adicionar ou remover sessões, fale com o suporte técnico.</p>
      )}
    </aside>
  );
}

/** Botao tracejado "+ Nova sessão" que abre um formulario pequeno logo abaixo. */
function NovaSessao({ total, limite, aoCriada }) {
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState('');
  const id = useId();
  const criar = useCriarSessao();

  const limpo = nome.trim();
  const valido = limpo.length >= NOME_SESSAO_MIN && limpo.length <= NOME_SESSAO_MAX;
  const cheio = total >= limite;

  function enviar(e) {
    e.preventDefault();
    if (!valido || criar.isPending) return;
    criar.mutate(limpo, {
      onSuccess: (dados) => {
        setNome('');
        setAberto(false);
        aoCriada(dados.canal.chave);
      }
    });
  }

  return (
    <div className="cx-nova">
      {!aberto ? (
        <button
          type="button"
          className="cx-nova__botao"
          disabled={cheio}
          title={cheio ? `Limite de ${limite} sessões` : undefined}
          onClick={() => setAberto(true)}
        >
          + Nova sessão
        </button>
      ) : (
        <form onSubmit={enviar} className="cx-nova__form">
          <label htmlFor={id} className="campo__rotulo">
            Nome da sessão
          </label>
          <Entrada
            id={id}
            value={nome}
            autoFocus
            maxLength={NOME_SESSAO_MAX}
            placeholder="Ex.: Recepção principal"
            autoComplete="off"
            onChange={(e) => setNome(e.target.value)}
          />
          {criar.isError && (
            <p className="campo__erro" role="alert">
              {criar.error.message}
            </p>
          )}
          <div className="linha">
            <Botao type="submit" tamanho="sm" carregando={criar.isPending} disabled={!valido || criar.isPending}>
              Criar
            </Botao>
            <Botao
              type="button"
              tamanho="sm"
              variante="fantasma"
              onClick={() => {
                setAberto(false);
                setNome('');
                criar.reset();
              }}
            >
              Cancelar
            </Botao>
          </div>
        </form>
      )}
      <span className="cx-tag cx-tag--dev">Dev</span>
    </div>
  );
}
