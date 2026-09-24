import { useEffect, useId, useRef } from 'react';
import { Botao } from '../../componentes/ui.jsx';

/**
 * Confirmacao dentro da propria pagina, para acoes que nao tem volta
 * ("Sair da conta", "Remover sessao").
 *
 * Nao usamos window.confirm porque ele e feio, some do tema e nao da para
 * explicar direito o que vai acontecer. Nao usamos um modal porque seria
 * preciso prender o foco dentro dele; aqui a confirmacao aparece junto do
 * botao que a abriu, e o resto da tela continua ao alcance.
 *
 * Acessibilidade:
 *  - role="alertdialog" com titulo e descricao ligados por id;
 *  - o foco vai para "Cancelar" ao abrir (a opcao segura);
 *  - Esc cancela.
 *
 * Quem usa este componente mostra o erro da API no proprio cartao, acima.
 */
export function Confirmacao({ titulo, children, rotuloConfirmar, aoConfirmar, aoCancelar, carregando = false }) {
  const idTitulo = useId();
  const idDescricao = useId();
  const caixaRef = useRef(null);

  useEffect(() => {
    caixaRef.current?.querySelector('[data-cancelar]')?.focus();
  }, []);

  function aoTeclar(e) {
    // Durante o envio nao deixa cancelar: a acao ja esta a caminho.
    if (e.key === 'Escape' && !carregando) {
      e.stopPropagation();
      aoCancelar();
    }
  }

  return (
    <div
      ref={caixaRef}
      className="cx-confirmacao"
      role="alertdialog"
      aria-labelledby={idTitulo}
      aria-describedby={idDescricao}
      onKeyDown={aoTeclar}
    >
      <h3 id={idTitulo} className="cx-confirmacao__titulo">
        {titulo}
      </h3>
      <div id={idDescricao} className="cx-confirmacao__texto">
        {children}
      </div>

      <div className="linha">
        <Botao type="button" variante="perigo" tamanho="sm" carregando={carregando} disabled={carregando} onClick={aoConfirmar}>
          {rotuloConfirmar}
        </Botao>
        <Botao type="button" variante="secundario" tamanho="sm" disabled={carregando} onClick={aoCancelar} data-cancelar="">
          Cancelar
        </Botao>
      </div>
    </div>
  );
}
