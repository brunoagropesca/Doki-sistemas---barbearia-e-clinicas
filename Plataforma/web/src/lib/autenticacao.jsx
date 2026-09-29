import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, quandoPerderSessao } from './api.js';

/**
 * Estado de quem esta logado.
 *
 * Fica num contexto porque praticamente toda tela precisa saber o cargo do
 * usuario para decidir o que mostrar. Passar isso de componente em componente
 * seria ruido em cada assinatura.
 *
 * A fonte da verdade e SEMPRE o servidor: ao carregar, perguntamos
 * `/api/auth/eu`. Guardar o usuario no navegador e confiar nele seria
 * ingenuidade — qualquer pessoa edita o armazenamento local e se promove a
 * dono da empresa. Aqui isso nao adiantaria nada: quem decide permissao e a
 * API, a cada requisicao.
 */

const ContextoAuth = createContext(null);

/** Hierarquia de cargos, espelhando a do servidor. */
const NIVEL = { profissional: 5, atendente: 10, admin: 20, owner: 30, dev: 100 };

export function ProvedorAuth({ children }) {
  const [usuario, setUsuario] = useState(null);
  const [carregando, setCarregando] = useState(true);

  const carregarUsuario = useCallback(async () => {
    try {
      const { usuario: u } = await api.get('/api/auth/eu');
      setUsuario(u);
    } catch {
      // 401 aqui e o caso normal de quem ainda nao entrou.
      setUsuario(null);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregarUsuario();
  }, [carregarUsuario]);

  // Qualquer 401 vindo de qualquer tela derruba a sessao aqui, num lugar so.
  useEffect(() => quandoPerderSessao(() => setUsuario(null)), []);

  const entrar = useCallback(async (username, senha) => {
    const { usuario: u } = await api.post('/api/auth/login', { username, senha });
    setUsuario(u);
    return u;
  }, []);

  const sair = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      // Mesmo que o servidor falhe, tiramos a pessoa da tela.
      setUsuario(null);
    }
  }, []);

  const valor = useMemo(
    () => ({
      usuario,
      carregando,
      entrar,
      sair,
      recarregar: carregarUsuario,
      /** O cargo do usuario alcanca o nivel exigido? */
      podeAcessar: (cargoMinimo) => (NIVEL[usuario?.cargo] ?? 0) >= (NIVEL[cargoMinimo] ?? Infinity)
    }),
    [usuario, carregando, entrar, sair, carregarUsuario]
  );

  return <ContextoAuth.Provider value={valor}>{children}</ContextoAuth.Provider>;
}

export function useAuth() {
  const ctx = useContext(ContextoAuth);
  if (!ctx) throw new Error('useAuth precisa estar dentro de <ProvedorAuth>.');
  return ctx;
}
