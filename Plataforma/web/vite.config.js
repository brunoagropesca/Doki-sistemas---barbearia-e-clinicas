import { fileURLToPath } from 'node:url';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * As regras do menu (validacao, limites e o motor que anda pelo fluxo) moram
 * na API e sao importadas AQUI tambem — um arquivo so, sem copia: o editor
 * aceita exatamente o que o servidor aceita, e a previa responde igual ao
 * WhatsApp. O arquivo nao importa nada, entao roda no navegador sem ajuste.
 */
const REGRAS_DO_FLUXO = fileURLToPath(new URL('../api/src/modules/atendimento/fluxo.js', import.meta.url));

/**
 * Configuracao do Vite.
 *
 * O `proxy` e o detalhe que evita uma classe inteira de dor de cabeca: em
 * desenvolvimento, a tela roda na porta 5173 e a API na 3333. Sem o proxy,
 * o navegador trataria as chamadas como "outro site" (CORS) e, pior, nao
 * enviaria o cookie de sessao.
 *
 * Com o proxy, o front chama `/api/...` no proprio endereco e o Vite
 * repassa para a API — tudo parece a mesma origem. E o codigo fica igual ao
 * de producao, onde as duas coisas sao servidas do mesmo lugar.
 *
 * As duas variaveis existem so para rodar uma SEGUNDA copia ao lado da que voce
 * usa (testes no navegador, por exemplo) sem encostar nas portas 5173/3333.
 * Sem elas, o comportamento e o de sempre.
 */
const PORTA_DAS_TELAS = Number(process.env.VITE_PORT) || 5173;
const ENDERECO_DA_API = process.env.VITE_API_TARGET || 'http://127.0.0.1:3333';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@regras-do-fluxo': REGRAS_DO_FLUXO }
  },
  server: {
    port: PORTA_DAS_TELAS,
    // Por padrao o Vite so serve arquivos de dentro de `web/`.
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), REGRAS_DO_FLUXO] },
    proxy: {
      '/api': {
        target: ENDERECO_DA_API,
        changeOrigin: true,
        // Repassa o IP de quem esta no navegador (X-Forwarded-For). Com o
        // acesso pela rede (INICIAR-NA-REDE.bat), sem isto toda sessao
        // apareceria como 127.0.0.1 — o proprio Vite.
        xfwd: true
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
});
