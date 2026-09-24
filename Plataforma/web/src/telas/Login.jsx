import { useState } from 'react';
import { useAuth } from '../lib/autenticacao.jsx';
import { Aviso, Botao, Campo, Entrada } from '../componentes/ui.jsx';
import './Login.css';

export function Login() {
  const { entrar } = useAuth();
  const [username, setUsername] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState(null);
  const [enviando, setEnviando] = useState(false);

  async function aoEnviar(e) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      await entrar(username, senha);
      // Nao navegamos daqui: o App redireciona sozinho ao ver o usuario.
    } catch (err) {
      setErro(err.message);
      // Limpa so a senha. Apagar o usuario tambem obrigaria a redigitar
      // tudo por um erro de digitacao numa tecla.
      setSenha('');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="login">
      <form className="login__cartao" onSubmit={aoEnviar}>
        <div className="login__marca">
          <span className="login__logo" aria-hidden="true">◆</span>
          <h1>Plataforma de Atendimento</h1>
        </div>

        <p className="login__sub">Entre para acessar a mesa de atendimento.</p>

        {erro && <Aviso tom="perigo">{erro}</Aviso>}

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

        <Botao type="submit" tamanho="lg" carregando={enviando} style={{ width: '100%' }}>
          {enviando ? 'Entrando...' : 'Entrar'}
        </Botao>
      </form>
    </div>
  );
}
