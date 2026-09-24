import { useId } from 'react';

/**
 * Interruptor liga/desliga.
 *
 * E um <button role="switch">, nao um checkbox enfeitado: leitor de tela
 * anuncia "interruptor, ligado" e o Espaco/Enter funcionam de graca. O rotulo
 * e um <label> de verdade, entao clicar no texto tambem liga e desliga.
 *
 * Enquanto salva (`ocupado`) o interruptor fica desabilitado, mas com
 * `aria-disabled` e nao com o atributo `disabled`: um botao que vira
 * `disabled` no meio do uso faz o navegador jogar o foco fora, e quem navega
 * pelo teclado teria de recomecar a tabulacao do inicio da pagina.
 */
export function Interruptor({ rotulo, descricao, ligado, ocupado = false, erro, aoAlternar }) {
  const id = useId();
  const idDescricao = `${id}-descricao`;
  const idErro = `${id}-erro`;
  const ativo = Boolean(ligado);

  function alternar() {
    // Clique durante o salvamento e ignorado: evita duas gravacoes seguidas.
    if (ocupado) return;
    aoAlternar(!ativo);
  }

  const descritoPor = [descricao ? idDescricao : null, erro ? idErro : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="cx-interruptor">
      <div className="cx-interruptor__linha">
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={ativo}
          aria-disabled={ocupado || undefined}
          aria-describedby={descritoPor}
          className={`cx-trilho ${ativo ? 'cx-trilho--ligado' : ''}`}
          onClick={alternar}
        >
          <span className="cx-trilho__bola" aria-hidden="true" />
        </button>

        <label htmlFor={id} className="cx-interruptor__rotulo">
          {rotulo}
        </label>

        {/* O estado por extenso fica visivel para quem nao percebe a cor; o leitor de tela ja tem aria-checked. */}
        <span className="cx-interruptor__estado" aria-hidden="true">
          {ocupado ? 'Salvando…' : ativo ? 'Ligado' : 'Desligado'}
        </span>
      </div>

      {descricao && (
        <p id={idDescricao} className="cx-interruptor__descricao">
          {descricao}
        </p>
      )}

      {erro && (
        <p id={idErro} className="cx-interruptor__erro" role="alert">
          {erro}
        </p>
      )}
    </div>
  );
}
