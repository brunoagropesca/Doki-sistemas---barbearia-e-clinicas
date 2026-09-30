import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../lib/autenticacao.jsx';
import { Aviso, Botao, Campo, Entrada } from '../componentes/ui.jsx';
import { SeletorIdioma } from '../componentes/SeletorIdioma.jsx';
import logoDoki from '../assets/doki-logo.png';
import './Login.css';

/*
 * A tela "se forma" em 3D uma vez: o piso de grade se desdobra, algumas telhas
 * de vidro voam do fundo e encaixam no lugar do cartao, o cartao funde por
 * cima e os campos sobem em cascata. Depois disso NADA fica animando.
 *
 * O botao no canto inferior direito desliga a animacao (a escolha fica salva
 * neste navegador). Quem pediu ao sistema para reduzir movimento ja comeca
 * com ela desligada.
 */

const COLUNAS = 4;
const LINHAS = 3;
/* Depois disto (ms) a montagem acabou e as telhas saem do DOM. */
const MONTAGEM_MS = 2000;
const CHAVE_PREFERENCIA = 'login:animacao';

/* Sorteio com semente fixa: a montagem e sempre a mesma coreografia, e o
   render continua puro (sem Math.random). */
function sorteador(semente) {
  let s = semente;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TELHAS = (() => {
  const r = sorteador(2809);
  const centrada = (n) => (r() - 0.5) * n;
  return Array.from({ length: COLUNAS * LINHAS }, () => ({
    '--dx': `${centrada(900).toFixed(0)}px`,
    '--dy': `${centrada(640).toFixed(0)}px`,
    '--dz': `${(-300 - r() * 700).toFixed(0)}px`,
    '--rx': `${centrada(220).toFixed(0)}deg`,
    '--ry': `${centrada(220).toFixed(0)}deg`,
    '--d': `${(r() * 0.35).toFixed(2)}s`
  }));
})();

function animacaoLigadaDeInicio() {
  try {
    const salva = localStorage.getItem(CHAVE_PREFERENCIA);
    if (salva) return salva === 'ligada';
  } catch {
    // Navegador sem acesso ao armazenamento: segue o padrao.
  }
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function Login() {
  const { entrar } = useAuth();
  // Recado de quem acabou de criar a senha (CriarSenha) e voltou para entrar de novo.
  const recado = useLocation().state?.aviso;
  const [username, setUsername] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState(null);
  const [enviando, setEnviando] = useState(false);

  const [animar, setAnimar] = useState(animacaoLigadaDeInicio);
  const [montando, setMontando] = useState(animar);
  // Muda ao religar a animacao: remonta a cena para ela tocar de novo.
  const [rodada, setRodada] = useState(0);
  const cartao = useRef(null);

  useEffect(() => {
    if (!montando) return undefined;
    const t = setTimeout(() => setMontando(false), MONTAGEM_MS);
    return () => clearTimeout(t);
  }, [montando, rodada]);

  function alternarAnimacao() {
    const ligar = !animar;
    setAnimar(ligar);
    setMontando(ligar);
    if (ligar) setRodada((n) => n + 1);
    try {
      localStorage.setItem(CHAVE_PREFERENCIA, ligar ? 'ligada' : 'desligada');
    } catch {
      // Sem armazenamento: vale so para esta visita.
    }
  }

  // Senha errada: o cartao "nega" balancando de leve.
  function tremer() {
    if (!animar) return;
    cartao.current?.animate(
      [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-10px)', offset: 0.25 },
        { transform: 'translateX(8px)', offset: 0.5 },
        { transform: 'translateX(-4px)', offset: 0.75 },
        { transform: 'translateX(0)' }
      ],
      { duration: 400, easing: 'ease-out' }
    );
  }

  async function aoEnviar(e) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      await entrar(username, senha);
      // Nao navegamos daqui: o App redireciona sozinho ao ver o usuario.
    } catch (err) {
      // 429 = muitas tentativas: nao e "senha errada", e um aviso de espera
      // (o usuario digitado fica, so a senha e limpa).
      setErro({ texto: err.message, tom: err.status === 429 ? 'alerta' : 'perigo' });
      tremer();
      // Limpa so a senha. Apagar o usuario tambem obrigaria a redigitar
      // tudo por um erro de digitacao numa tecla.
      setSenha('');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className={`login${animar ? '' : ' login--parada'}`} key={rodada}>
      {/* ── Fundo: piso em perspectiva e paineis do sistema ── */}
      <div className="login__fundo" aria-hidden="true">
        <div className="login__piso" />

        <div className="login__vidro login__vidro--a">
          <div className="lv-linha"><i className="lv-avatar" /><span><b /><b /></span></div>
          <div className="lv-linha"><i className="lv-avatar" /><span><b /><b /></span></div>
          <div className="lv-linha"><i className="lv-avatar" /><span><b /><b /></span></div>
        </div>
        <div className="login__vidro login__vidro--b">
          <div className="lv-balao lv-balao--in"><b /><b /></div>
          <div className="lv-balao lv-balao--out"><b /></div>
          <div className="lv-balao lv-balao--in"><b /></div>
        </div>
        <div className="login__vidro login__vidro--c">
          <div className="lv-barras"><i /><i /><i /><i /><i /><i /></div>
        </div>
      </div>

      {/* ── Cena: o cartao ── */}
      <div className="login__palco">
        <div className="login__cena">
          <span className="login__canto login__canto--tl" aria-hidden="true" />
          <span className="login__canto login__canto--tr" aria-hidden="true" />
          <span className="login__canto login__canto--bl" aria-hidden="true" />
          <span className="login__canto login__canto--br" aria-hidden="true" />

          {animar && montando && (
            <div className="login__telhas" aria-hidden="true">
              {TELHAS.map((estilo, i) => (
                <i key={i} className="login__telha" style={estilo} />
              ))}
            </div>
          )}

          <form className="login__cartao" ref={cartao} onSubmit={aoEnviar}>
            <div className="login__marca login__item" style={{ '--i': 0 }}>
              <img className="login__logo" src={logoDoki} alt="" draggable={false} />
              <div className="login__nome">
                <h1>Doki Tecnologia</h1>
                <span>Plataforma de Atendimento</span>
              </div>
            </div>

            <p className="login__sub login__item" style={{ '--i': 1 }}>
              Entre para acessar a mesa de atendimento.
            </p>

            {recado && !erro && <Aviso tom="sucesso">{recado}</Aviso>}
            {erro && <Aviso tom={erro.tom}>{erro.texto}</Aviso>}

            <div className="login__item" style={{ '--i': 2 }}>
              <Campo rotulo="Usuario" obrigatorio>
                <Entrada
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
                  required
                  placeholder="seu.usuario"
                />
              </Campo>
            </div>

            <div className="login__item" style={{ '--i': 3 }}>
              <Campo rotulo="Senha" obrigatorio>
                <Entrada
                  type="password"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  autoComplete="current-password"
                  required
                  placeholder="••••••••"
                />
              </Campo>
            </div>

            <div className="login__item" style={{ '--i': 4 }}>
              <Botao type="submit" tamanho="lg" carregando={enviando} style={{ width: '100%' }}>
                {enviando ? 'Entrando...' : 'Entrar'}
              </Botao>
            </div>
          </form>
        </div>
      </div>

      {/* Idioma antes de entrar: quem nao le portugues precisa achar o seu aqui. */}
      <SeletorIdioma className="login__idioma" />

      <button type="button" className="login__alternar" onClick={alternarAnimacao} aria-pressed={!animar}>
        {animar ? 'Desligar animação' : 'Ligar animação'}
      </button>
    </div>
  );
}
