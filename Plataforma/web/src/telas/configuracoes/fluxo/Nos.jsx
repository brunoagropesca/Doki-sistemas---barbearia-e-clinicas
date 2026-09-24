import { createContext, memo, useContext, useEffect, useRef, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { LIMITES, TIPOS_NO } from '@regras-do-fluxo';
import { ENTRADA, SAIDA_UNICA, VISUAL } from './conversao.js';

/**
 * Os nos do canvas.
 *
 * Os dados do no (`data`) sao SO o que vai para o servidor. O resto — se e o
 * inicio, que problemas tem, as acoes do menu "⋯" — chega pelo contexto do
 * editor: assim nada de estado de tela vaza para o JSON salvo.
 */
export const ContextoEditor = createContext(null);

function useEditor() {
  return useContext(ContextoEditor);
}

/** Cabecalho comum: icone, nome, selos e o menu de acoes. */
function Cabecalho({ id, tipo, data }) {
  const ed = useEditor();
  const [aberto, setAberto] = useState(false);
  const raiz = useRef(null);
  const ehInicio = ed.inicio === id;

  useEffect(() => {
    if (!aberto) return undefined;
    const fora = (e) => !raiz.current?.contains(e.target) && setAberto(false);
    document.addEventListener('pointerdown', fora);
    return () => document.removeEventListener('pointerdown', fora);
  }, [aberto]);

  const acao = (fn) => (e) => {
    e.stopPropagation();
    setAberto(false);
    fn();
  };

  return (
    <header className="no__cab">
      <span className="no__icone" style={{ '--cor-no': VISUAL[tipo].cor }} aria-hidden="true">
        {VISUAL[tipo].icone}
      </span>
      <span className="no__titulo">
        <strong title={data.title}>{data.title || TIPOS_NO[tipo].rotulo}</strong>
        <small>{TIPOS_NO[tipo].rotulo}</small>
      </span>
      {ehInicio && <span className="no__selo no__selo--inicio">Início</span>}
      {data.disabled && <span className="no__selo">Desativado</span>}

      <div className="no__acoes nodrag" ref={raiz}>
        <button
          type="button"
          className="no__mais"
          aria-label="Ações do passo"
          aria-haspopup="menu"
          aria-expanded={aberto}
          onClick={(e) => {
            e.stopPropagation();
            setAberto((a) => !a);
          }}
        >
          ⋯
        </button>
        {aberto && (
          <div className="no__menu" role="menu">
            <button type="button" role="menuitem" onClick={acao(() => ed.editar(id))}>Editar</button>
            <button type="button" role="menuitem" onClick={acao(() => ed.duplicar(id))}>Duplicar</button>
            <button type="button" role="menuitem" onClick={acao(() => ed.alternarDesativado(id))}>
              {data.disabled ? 'Ativar' : 'Desativar'}
            </button>
            {tipo === 'menu' && !ehInicio && (
              <button type="button" role="menuitem" onClick={acao(() => ed.definirInicio(id))}>Definir como início</button>
            )}
            <button type="button" role="menuitem" className="no__menu-perigo" onClick={acao(() => ed.excluir(id))}>
              Excluir
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

function Problemas({ id }) {
  const { problemasPorNo } = useEditor();
  const p = problemasPorNo.get(id);
  if (!p) return null;
  const lista = [...p.erros, ...p.avisos];
  return (
    <div className={`no__problemas${p.erros.length ? ' no__problemas--erro' : ''}`} title={lista.map((x) => x.mensagem).join('\n')}>
      <span aria-hidden="true">{p.erros.length ? '⛔' : '⚠'}</span>
      <span>{lista[0].mensagem}</span>
      {lista.length > 1 && <span className="no__problemas-mais">+{lista.length - 1}</span>}
    </div>
  );
}

function classes(id, data, selected, ed) {
  const p = ed.problemasPorNo.get(id);
  return [
    'no',
    selected && 'no--selecionado',
    data.disabled && 'no--desativado',
    ed.inicio === id && 'no--inicio',
    p?.erros.length ? 'no--erro' : p?.avisos.length ? 'no--aviso' : null
  ]
    .filter(Boolean)
    .join(' ');
}

/** Entrada: todo passo recebe no maximo UMA seta por opcao, mas pode receber varias opcoes. */
function Entrada() {
  return <Handle type="target" position={Position.Left} id={ENTRADA} className="no__entrada" />;
}

export const NoMenu = memo(function NoMenu({ id, data, selected }) {
  const ed = useEditor();
  const atualizarInternos = useUpdateNodeInternals();
  const opcoes = data.options ?? [];
  const chaveDasOpcoes = opcoes.map((o) => o.id).join('|');

  // Os handles de saida mudam de lugar quando uma opcao entra, sai ou troca de
  // ordem: o React Flow precisa remedir, senao as linhas saem do lugar errado.
  useEffect(() => {
    atualizarInternos(id);
  }, [id, chaveDasOpcoes, atualizarInternos]);

  return (
    <div className={classes(id, data, selected, ed)} style={{ '--cor-no': VISUAL.menu.cor }} onDoubleClick={() => ed.editar(id)}>
      <Entrada />
      <Cabecalho id={id} tipo="menu" data={data} />
      <p className="no__mensagem">{data.message || <em>Sem mensagem</em>}</p>

      <ol className="no__opcoes">
        {opcoes.map((op, i) => (
          <li key={op.id} className="no__opcao">
            <span className="no__opcao-num">{i + 1}</span>
            <span className="no__opcao-rotulo">{op.label || <em>sem texto</em>}</span>
            <Handle
              type="source"
              position={Position.Right}
              id={op.id}
              className={`no__saida${ed.handlesLigados.has(`${id}|${op.id}`) ? ' no__saida--ligada' : ''}`}
              title="Arraste para ligar esta opção a um passo"
            />
          </li>
        ))}
      </ol>

      {opcoes.length < LIMITES.opcoes && (
        <button
          type="button"
          className="no__adicionar nodrag"
          onClick={(e) => {
            e.stopPropagation();
            ed.adicionarOpcao(id);
          }}
        >
          + Adicionar opção
        </button>
      )}
      <Problemas id={id} />
    </div>
  );
});

export const NoAcao = memo(function NoAcao({ id, type, data, selected }) {
  const ed = useEditor();
  const temSaida = TIPOS_NO[type].saidas === 1;
  const texto =
    data.message ||
    (type === 'servicos'
      ? 'Lista os serviços e preços do catálogo.'
      : type === 'atendente'
        ? 'Chama um atendente (mensagem padrão).'
        : type === 'sofia'
          ? 'A Sofia assume a conversa (mensagem padrão).'
          : null);

  return (
    <div className={classes(id, data, selected, ed)} style={{ '--cor-no': VISUAL[type].cor }} onDoubleClick={() => ed.editar(id)}>
      <Entrada />
      <Cabecalho id={id} tipo={type} data={data} />
      <p className="no__mensagem">{texto ?? <em>Sem mensagem</em>}</p>

      {temSaida ? (
        <div className="no__opcao no__opcao--seguir">
          <span className="no__opcao-rotulo">Em seguida</span>
          <Handle
            type="source"
            position={Position.Right}
            id={SAIDA_UNICA}
            className={`no__saida${ed.handlesLigados.has(`${id}|${SAIDA_UNICA}`) ? ' no__saida--ligada' : ''}`}
            title="Opcional: ligue ao próximo passo"
          />
        </div>
      ) : (
        <div className="no__fim">Fim do menu</div>
      )}
      <Problemas id={id} />
    </div>
  );
});

export const TIPOS_DE_NO_REACT_FLOW = {
  menu: NoMenu,
  mensagem: NoAcao,
  servicos: NoAcao,
  atendente: NoAcao,
  sofia: NoAcao
};
