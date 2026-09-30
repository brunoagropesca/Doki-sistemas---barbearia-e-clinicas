import { createServer as criarServidorHttp } from 'node:http';
import { createServer as criarServidorTcp } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * HTTPS na rede da loja, NA MESMA PORTA do HTTP (5173).
 *
 * As pessoas ja salvaram http://IP:5173. Com o HTTPS numa porta so dele, esse
 * endereco daria erro de conexao; aqui ele REDIRECIONA para https://IP:5173.
 * O truque: olhamos o primeiro byte de cada conexao — 0x16 e o inicio de um
 * handshake TLS (vai para o servidor HTTPS do Fastify); qualquer outra coisa e
 * HTTP puro (vai para um servidor HTTP minimo, que redireciona).
 *
 * Fica em HTTP (sem redirecionar):
 *   - este proprio computador (localhost): o trafego nao passa pelo Wi-Fi, o
 *     navegador ja trata localhost como seguro, e o computador da loja nao
 *     precisa instalar a autoridade;
 *   - /instalar-certificado: e por onde o celular BAIXA a autoridade — antes
 *     de instala-la, o HTTPS ainda da aviso.
 */

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const CAMINHO_INSTALAR = '/instalar-certificado';

/** Enderecos IPv4 desta maquina na rede (sem placas virtuais: WSL, Hyper-V, VirtualBox...). */
export function ipsDaRede() {
  const virtual = /vethernet|virtualbox|vmware|wsl|hyper-v|loopback|bluetooth|tailscale|zerotier/i;
  const lista = [];
  for (const [nome, ifaces] of Object.entries(networkInterfaces())) {
    if (virtual.test(nome)) continue;
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) lista.push(i.address);
    }
  }
  return lista;
}

/**
 * Poe o app (criado com `https`) para escutar HTTP e HTTPS na mesma porta.
 * Devolve `fechar()`: chame antes do `app.close()` no desligamento.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {{ port: number, host: string, isentarLocal?: boolean }} p
 */
export async function escutarComHttps(app, { port, host, isentarLocal = true }) {
  await app.ready();
  // O pipeline inteiro do Fastify (hooks, rotas, erros), reaproveitado pelo lado HTTP.
  const tratar = app.server.listeners('request')[0];

  const http1 = criarServidorHttp((req, res) => {
    const caminho = (req.url ?? '/').split('?')[0];
    const local = isentarLocal && LOCAL.has(req.socket.remoteAddress);
    if (local || caminho === CAMINHO_INSTALAR || caminho.startsWith(`${CAMINHO_INSTALAR}/`)) return tratar(req, res);
    const destino = req.headers.host || `localhost:${port}`;
    res.writeHead(308, { location: `https://${destino}${req.url ?? '/'}`, 'cache-control': 'no-store' });
    res.end();
  });

  const porta = criarServidorTcp((socket) => {
    socket.on('error', () => {});
    // Quem conecta e nao manda nada nao segura a conexao para sempre.
    socket.setTimeout(15_000, () => socket.destroy());
    socket.once('data', (primeiro) => {
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(primeiro);
      (primeiro[0] === 0x16 ? app.server : http1).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });

  await new Promise((pronto, falhou) => {
    porta.once('error', falhou);
    porta.listen(port, host, pronto);
  });

  return {
    porta: porta.address().port,
    fechar: () =>
      new Promise((pronto) => {
        http1.closeAllConnections?.();
        http1.close();
        porta.close(() => pronto());
      })
  };
}

/**
 * A pagina de instalacao e o arquivo da autoridade. Publicos, e servidos
 * tambem em HTTP (ver acima). A pagina nao carrega nada de fora: e aberta
 * justamente quando o aparelho ainda nao confia no HTTPS.
 */
export async function rotasCertificado(app, { autoridadeDer }) {
  const ROTA = { config: { publico: true, bancoReal: true } };

  app.get(`${CAMINHO_INSTALAR}/autoridade.crt`, ROTA, async (_req, res) => {
    res.header('content-type', 'application/x-x509-ca-cert');
    res.header('content-disposition', 'attachment; filename="plataforma-autoridade.crt"');
    res.header('cache-control', 'no-store');
    return autoridadeDer;
  });

  app.get(CAMINHO_INSTALAR, ROTA, async (req, res) => {
    // O Host vem de quem pede: escapado antes de entrar no HTML.
    const sistema = escaparHtml(`https://${req.headers.host ?? req.hostname}/`);
    res.header('content-type', 'text/html; charset=utf-8');
    res.header('cache-control', 'no-store');
    return paginaDeInstalacao(sistema);
  });
}

const escaparHtml = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function paginaDeInstalacao(sistema) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Instalar o certificado da loja</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b1026; color: #e8ecf8; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  h2 { font-size: 17px; margin: 28px 0 8px; }
  p, li { color: #c3cadf; }
  ol { padding-left: 20px; }
  li { margin: 6px 0; }
  .botao { display: block; text-align: center; padding: 14px 16px; border-radius: 12px; background: #1856ff; color: #fff; font-weight: 700; text-decoration: none; margin: 16px 0; }
  .botao--secundario { background: transparent; border: 1px solid #3a4468; color: #e8ecf8; }
  .caixa { border: 1px solid #2a3356; border-radius: 12px; padding: 12px 16px; background: #111735; }
  b { color: #fff; }
</style>
</head>
<body>
<main>
  <h1>Conexão segura com a loja</h1>
  <p>Para usar o sistema por este aparelho com a conexão protegida, instale <b>uma vez</b> o certificado da loja.
     Ele vale só para os endereços desta rede — não dá acesso a nada do seu aparelho.</p>

  <a class="botao" href="${CAMINHO_INSTALAR}/autoridade.crt">1. Baixar o certificado</a>

  <h2>iPhone / iPad</h2>
  <div class="caixa"><ol>
    <li>Abra esta página no <b>Safari</b> e toque em <b>Baixar o certificado</b> → <b>Permitir</b>.</li>
    <li>Vá em <b>Ajustes</b> → <b>Perfil Transferido</b> (no topo) → <b>Instalar</b> e confirme com o código do aparelho.</li>
    <li>Depois: <b>Ajustes → Geral → Sobre → Ajustes de Confiança de Certificados</b> e <b>ligue</b> a chave do certificado "Plataforma".</li>
  </ol></div>

  <h2>Android</h2>
  <div class="caixa"><ol>
    <li>Toque em <b>Baixar o certificado</b> (no Chrome).</li>
    <li>Vá em <b>Configurações → Segurança</b> (ou "Segurança e privacidade") → <b>Mais configurações de segurança</b> →
        <b>Criptografia e credenciais</b> → <b>Instalar um certificado</b> → <b>Certificado de CA</b>.</li>
    <li>Toque em <b>Instalar assim mesmo</b> e escolha o arquivo <b>plataforma-autoridade.crt</b> em Downloads.</li>
  </ol>
  <p>Os nomes dos menus mudam um pouco conforme a marca do celular. Se não achar, busque "certificado" nas Configurações.</p></div>

  <h2>Computador Windows</h2>
  <div class="caixa"><ol>
    <li>Clique em <b>Baixar o certificado</b> e abra o arquivo baixado.</li>
    <li><b>Instalar Certificado…</b> → <b>Usuário Atual</b> → <b>Colocar todos os certificados no repositório a seguir</b> →
        <b>Procurar</b> → <b>Autoridades de Certificação Raiz Confiáveis</b> → <b>Concluir</b> → <b>Sim</b>.</li>
    <li>Feche e abra o navegador.</li>
  </ol></div>

  <a class="botao" href="${sistema}">2. Já instalei — abrir o sistema</a>
  <p>Se o navegador ainda avisar que a conexão não é segura, o certificado não foi instalado (ou, no iPhone, falta ligar a
     confiança no passo 3).</p>
</main>
</body>
</html>`;
}
