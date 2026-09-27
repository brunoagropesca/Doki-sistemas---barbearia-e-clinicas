import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProvedorAuth } from './lib/autenticacao.jsx';
import { ProvedorTextos } from './lib/textos.jsx';
import { App } from './App.jsx';
import { registrarServiceWorker } from './lib/appInstalado.js';
// Antes de desenhar: aplica o modo de visualizacao escolhido (sem piscar).
import './lib/tema.js';
import './estilos/global.css';
// Por ultimo: os ajustes de celular valem por cima de qualquer tela.
import './estilos/celular.css';

// App instalado no celular (PWA). Ver lib/appInstalado.js e public/sw.js.
registrarServiceWorker();

/**
 * Ponto de entrada da interface.
 *
 * O React Query cuida de buscar, guardar em cache e revalidar os dados do
 * servidor. Sem ele, cada tela reimplementaria "carregando / erro / recarregar"
 * na mao — que e exatamente como `livechat.js` do sistema antigo chegou a
 * 97 KB num arquivo so.
 */
const clienteQuery = new QueryClient({
  defaultOptions: {
    queries: {
      // Dados considerados frescos por 30s: trocar de aba e voltar nao
      // dispara uma enxurrada de requisicoes.
      staleTime: 30_000,
      // Erro de permissao ou "nao encontrado" nao melhora tentando de novo.
      retry: (tentativas, erro) => {
        if ([400, 401, 403, 404, 422].includes(erro?.status)) return false;
        return tentativas < 2;
      },
      refetchOnWindowFocus: true
    },
    mutations: {
      retry: false
    }
  }
});

createRoot(document.getElementById('raiz')).render(
  <StrictMode>
    <QueryClientProvider client={clienteQuery}>
      <BrowserRouter>
        <ProvedorAuth>
          {/* Dentro do auth: os textos trocados dependem da empresa de quem entrou. */}
          <ProvedorTextos>
            <App />
          </ProvedorTextos>
        </ProvedorAuth>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
