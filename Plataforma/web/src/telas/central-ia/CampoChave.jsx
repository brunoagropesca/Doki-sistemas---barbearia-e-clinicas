import { useState } from 'react';
import { api } from '../../lib/api.js';
import { Campo, Entrada } from '../../componentes/ui.jsx';

/**
 * Atributos que pedem ao navegador e aos gerenciadores de senha (Chrome, Edge,
 * 1Password, LastPass, Bitwarden) para NAO preencherem o campo. Nenhum deles
 * sozinho e garantido — o Chrome, por exemplo, ignora `autocomplete="off"` em
 * alguns casos —, por isso vao todos juntos. Vale para qualquer campo da aba
 * Cascata que possa ser confundido com login (chaves, URL, busca).
 *
 * O `name` NAO entra aqui de proposito: cada campo precisa de um `name` proprio
 * e sem palavras como user, login, senha, password ou email, que fazem o
 * navegador achar que e um formulario de entrada.
 */
export const SEM_AUTOFILL = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other'
};

/**
 * Este navegador sabe esconder o texto de um campo comum com CSS?
 *
 * Perguntamos UMA vez, quando o arquivo carrega (nao a cada renderizacao). E o
 * mesmo teste do `@supports (-webkit-text-security: disc)` do CSS, so que
 * feito em JavaScript, porque aqui o resultado decide o `type` do campo — e o
 * tipo so pode mudar por prop, nao por CSS.
 *   - Chrome, Edge, Safari: sim -> campo de texto mascarado por CSS.
 *   - Firefox (sem suporte): nao -> volta a usar type="password", que mascara
 *     sozinho, com autoComplete="new-password" para ele nao oferecer a senha salva.
 */
const MASCARA_POR_CSS =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  (CSS.supports('-webkit-text-security', 'disc') || CSS.supports('text-security', 'disc'));

/**
 * Campo de chave de API com o "olho".
 *
 * A chave vive cifrada no servidor e a listagem NUNCA a traz. O olho e o unico
 * caminho: ao clicar para ver, a tela busca a chave (so o dono pode, e a
 * consulta fica na auditoria). Clicar de novo esconde.
 *
 * POR QUE NAO type="password": o gerenciador de senhas do navegador entende
 * "campo de senha = preencher a senha salva" e ainda joga o LOGIN do usuario no
 * campo de texto anterior, colando login e senha da pessoa dentro das chaves de
 * API. Sem nenhum campo de senha na tela, ele nao tem o que preencher. Por isso
 * o campo e sempre type="text" e a MASCARA e so visual (CSS `text-security`,
 * classe ci-chave__campo--escondido). Por ser mascara visual, o texto real fica
 * no campo; a chave so chega la quando o dono clica no olho (ou digita/cola ela
 * mesmo), como sempre foi, e enquanto escondida o campo bloqueia copiar/recortar/
 * arrastar, para a chave nao sair em texto claro pela area de transferencia.
 * Nao criamos <form> em volta: form + campo de chave e exatamente o padrao que
 * dispara o autofill.
 *
 * Estados:
 *   - escondida: mostra bolinhas (mascara do CSS, ou o campo de senha do Firefox)
 *   - visivel:   mostra a chave em texto
 * O que a pessoa digita ou o que o olho revelou fica em `valor`; so e enviado
 * para salvar se for DIFERENTE da chave que ja esta guardada — reenviar a
 * mesma chave seria trabalho a toa (e dispararia um novo teste de modelos).
 */
export function CampoChave({ rotulo, temChave, sufixo, exemplo, podeVer, provedor, valor, aoMudar, aoRevelar }) {
  const [visivel, setVisivel] = useState(false);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState(null);

  // Campo vazio (ex.: acabou de salvar) nao tem o que mostrar. Volta a esconder,
  // senao a proxima chave colada apareceria em claro sem ninguem clicar no olho.
  if (visivel && !valor) setVisivel(false);

  async function alternarOlho() {
    setErro(null);

    if (visivel) {
      setVisivel(false);
      return;
    }

    // Ja tem texto na tela (digitado agora ou revelado antes): so mostra.
    if (valor) {
      setVisivel(true);
      return;
    }

    // Campo vazio e ja existe chave salva: busca no servidor.
    if (temChave) {
      setBuscando(true);
      try {
        const { chave } = await api.get(`/api/ia/provedores/${provedor}/chave`);
        aoRevelar(chave);
        setVisivel(true);
      } catch (err) {
        setErro(err.message);
      } finally {
        setBuscando(false);
      }
    }
  }

  // O olho so aparece quando ha algo para ver: uma chave salva, ou texto digitado.
  const temAlgoParaVer = temChave || Boolean(valor);
  const bloqueado = temChave && !valor && !podeVer;

  const escondida = !visivel;
  // Firefox: sem mascara por CSS, o campo escondido tem de ser de senha de verdade.
  const senhaDoNavegador = escondida && !MASCARA_POR_CSS;

  // Escondida, a chave nao sai do campo nem por copiar, recortar ou arrastar o texto
  // (o campo de senha nativo ja bloqueia isso; o campo de texto mascarado nao).
  const bloquearSeEscondida = (e) => {
    if (escondida) e.preventDefault();
  };

  return (
    <Campo
      rotulo={rotulo}
      erro={erro}
      dica={temChave ? `Cadastrada e cifrada no servidor: ••••${sufixo ?? ''}` : 'Nenhuma chave cadastrada.'}
    >
      <div className="ci-chave">
        <Entrada
          {...SEM_AUTOFILL}
          // Nome unico e neutro (nada de user/login/senha/password/email).
          name={`chave-api-${provedor}`}
          type={senhaDoNavegador ? 'password' : 'text'}
          // Depois do espalhamento acima: no Firefox o autoComplete muda para "new-password".
          autoComplete={senhaDoNavegador ? 'new-password' : 'off'}
          // O Entrada JUNTA estas classes com a `entrada` (nao a substitui): o campo
          // continua com a largura e o visual base dos outros campos.
          className={`mono ci-chave__campo ${escondida ? 'ci-chave__campo--escondido' : ''}`}
          placeholder={temChave ? `••••••••••••••••••••${sufixo ?? ''}` : exemplo}
          value={valor}
          onChange={(e) => aoMudar(e.target.value)}
          onCopy={bloquearSeEscondida}
          onCut={bloquearSeEscondida}
          onDragStart={bloquearSeEscondida}
        />

        {temAlgoParaVer && (
          <button
            type="button"
            className="ci-olho"
            onClick={alternarOlho}
            disabled={buscando || bloqueado}
            aria-label={visivel ? 'Esconder a chave' : 'Mostrar a chave'}
            aria-pressed={visivel}
            title={
              bloqueado
                ? 'Só o dono da empresa pode ver a chave salva'
                : visivel
                  ? 'Esconder a chave'
                  : 'Mostrar a chave'
            }
          >
            {buscando ? <span className="botao__girando" aria-hidden="true" /> : <IconeOlho cortado={visivel} />}
          </button>
        )}
      </div>
    </Campo>
  );
}

/** Olho aberto (chave escondida: clique para ver) ou riscado (chave visivel: clique para esconder). */
function IconeOlho({ cortado }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
      {cortado && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}
