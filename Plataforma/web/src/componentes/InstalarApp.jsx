import { useState } from 'react';
import { Botao, Modal } from './ui.jsx';
import { ehSafariDoIos, useAppInstalado } from '../lib/appInstalado.js';
import './InstalarApp.css';

/**
 * "Instalar app": poe o sistema na tela inicial do celular, com icone proprio,
 * abrindo em tela cheia (sem a barra do navegador) — sem loja de aplicativos.
 *
 * `useInstalar()` devolve o que o layout precisa: se vale mostrar a opcao, a
 * acao de instalar e o modal com o passo a passo (quando o navegador nao
 * instala sozinho: iPhone sempre; Android pelo IP da rede, sem HTTPS).
 */

const CHAVE_DISPENSADO = 'app.convite-dispensado';

function lerDispensado() {
  try {
    return localStorage.getItem(CHAVE_DISPENSADO) === '1';
  } catch {
    return false;
  }
}

export function useInstalar() {
  const app = useAppInstalado();
  const [passoAPasso, setPassoAPasso] = useState(false);
  const [dispensado, setDispensado] = useState(lerDispensado);

  async function instalar() {
    // Android com o convite do Chrome: a janela nativa de instalar.
    if (app.podeConvidar) {
      await app.convidar();
      return;
    }
    setPassoAPasso(true);
  }

  function dispensar() {
    setDispensado(true);
    try {
      localStorage.setItem(CHAVE_DISPENSADO, '1');
    } catch {
      // Sem armazenamento: some so nesta visita.
    }
  }

  return {
    disponivel: !app.instalado,
    // A faixa de convite: uma vez, ate a pessoa instalar ou dispensar.
    convidar: !app.instalado && !dispensado,
    instalar,
    dispensar,
    modal: <PassoAPasso aberto={passoAPasso} aoFechar={() => setPassoAPasso(false)} ios={app.ios} />
  };
}

/** Faixa discreta acima da barra de abas, so no celular. */
export function ConviteInstalar({ aoInstalar, aoDispensar }) {
  return (
    <div className="convite-app" role="region" aria-label="Instalar o app">
      <img className="convite-app__icone" src="/icones/icone-192.png" alt="" />
      <div className="crescer">
        <strong>Use como aplicativo</strong>
        <span>Abre em tela cheia, direto da tela inicial.</span>
      </div>
      <Botao tamanho="sm" onClick={aoInstalar}>
        Instalar
      </Botao>
      <button type="button" className="convite-app__fechar" onClick={aoDispensar} aria-label="Agora nao">
        ×
      </button>
    </div>
  );
}

function PassoAPasso({ aberto, aoFechar, ios }) {
  const safari = ehSafariDoIos();

  return (
    <Modal titulo="Instalar o app no celular" aberto={aberto} aoFechar={aoFechar} largura={440}>
      {ios && !safari ? (
        <p className="texto-suave">
          No iPhone, só o <strong>Safari</strong> instala aplicativos da internet. Copie este endereço, abra no Safari
          e toque em <strong>Instalar</strong> de novo.
          <code className="passo-app__endereco">{window.location.origin}</code>
        </p>
      ) : (
        <ol className="passo-app">
          {ios ? (
            <>
              <li>
                Toque em <strong>Compartilhar</strong> <IconeCompartilharIos /> na barra do Safari.
              </li>
              <li>
                Role a lista e toque em <strong>Adicionar à Tela de Início</strong> <span aria-hidden="true">⊞</span>.
              </li>
              <li>
                Toque em <strong>Adicionar</strong>. O ícone aparece na tela inicial — abra por ele.
              </li>
            </>
          ) : (
            <>
              <li>
                Toque no menu <strong>⋮</strong> do navegador (canto de cima).
              </li>
              <li>
                Escolha <strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong>.
              </li>
              <li>Confirme. O ícone aparece na tela inicial — abra por ele.</li>
            </>
          )}
        </ol>
      )}
      <p className="texto-fraco passo-app__nota">
        Você continua entrando com o mesmo usuário e senha. Nada é baixado de loja.
      </p>
    </Modal>
  );
}

/** O quadrado com a seta para cima do Safari — o que a pessoa procura na tela. */
function IconeCompartilharIos() {
  return (
    <svg className="passo-app__icone" viewBox="0 0 24 24" aria-label="(ícone quadrado com seta para cima)">
      <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 11H6v10h12V11h-2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
