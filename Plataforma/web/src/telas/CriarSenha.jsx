import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/autenticacao.jsx';
import { Aviso, Botao, Campo, Entrada } from '../componentes/ui.jsx';
import logoDoki from '../assets/doki-logo.png';
import './Login.css';

/**
 * Primeiro acesso com senha PROVISORIA (definida por outra pessoa: instalacao,
 * gerencia, acesso do profissional). E a UNICA tela para quem esta assim — a
 * API tambem recusa o resto (SENHA_PROVISORIA) — porque quem conhece a senha
 * provisoria nao pode continuar entrando como esta pessoa.
 *
 * Trocar a senha derruba todas as sessoes (inclusive esta): a pessoa volta ao
 * login e entra com a senha nova.
 */
export function CriarSenha() {
  const { usuario, sair } = useAuth();
  const navegar = useNavigate();
  const [form, setForm] = useState({ senhaAtual: '', novaSenha: '', confirmar: '' });
  const [erro, setErro] = useState(null);
  const [camposComErro, setCamposComErro] = useState({});
  const [enviando, setEnviando] = useState(false);

  async function aoEnviar(e) {
    e.preventDefault();
    setErro(null);
    setCamposComErro({});
    if (form.novaSenha !== form.confirmar) {
      setCamposComErro({ confirmar: 'A confirmação não bate com a nova senha.' });
      return;
    }
    setEnviando(true);
    try {
      await api.post('/api/auth/trocar-senha', { senhaAtual: form.senhaAtual, novaSenha: form.novaSenha });
      // A sessao ja caiu no servidor: volta ao login com o recado.
      navegar('/entrar', { replace: true, state: { aviso: 'Senha criada. Entre de novo com a senha nova.' } });
      await sair();
    } catch (err) {
      setErro(err.camposComErro ? null : err.message);
      setCamposComErro(err.camposComErro ?? {});
      setEnviando(false);
    }
  }

  const mudar = (campo) => (e) => setForm({ ...form, [campo]: e.target.value });

  return (
    <div className="login login--parada">
      <div className="login__palco">
        <div className="login__cena">
          <form className="login__cartao" onSubmit={aoEnviar}>
            <div className="login__marca">
              <img className="login__logo" src={logoDoki} alt="" draggable={false} />
              <div className="login__nome">
                <h1>Crie sua senha</h1>
                <span>{usuario?.nome}</span>
              </div>
            </div>

            <p className="login__sub">
              Você entrou com uma senha provisória, definida por outra pessoa. Para continuar, crie uma senha que só você
              conheça.
            </p>

            {erro && <Aviso tom="perigo">{erro}</Aviso>}

            <Campo rotulo="Senha provisória (a que você usou agora)" obrigatorio erro={camposComErro.senhaAtual}>
              <Entrada type="password" value={form.senhaAtual} onChange={mudar('senhaAtual')} autoComplete="current-password" autoFocus required />
            </Campo>
            <Campo rotulo="Nova senha" obrigatorio dica="Pelo menos 8 caracteres." erro={camposComErro.novaSenha}>
              <Entrada type="password" value={form.novaSenha} onChange={mudar('novaSenha')} autoComplete="new-password" required />
            </Campo>
            <Campo rotulo="Confirme a nova senha" obrigatorio erro={camposComErro.confirmar}>
              <Entrada type="password" value={form.confirmar} onChange={mudar('confirmar')} autoComplete="new-password" required />
            </Campo>

            <Botao type="submit" tamanho="lg" carregando={enviando} style={{ width: '100%' }}>
              Criar senha
            </Botao>
            <Botao variante="fantasma" type="button" onClick={sair} style={{ width: '100%' }}>
              Sair
            </Botao>
          </form>
        </div>
      </div>
    </div>
  );
}
