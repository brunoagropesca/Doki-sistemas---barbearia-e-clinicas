import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/autenticacao.jsx';
import { Carregando } from './componentes/ui.jsx';
import { Layout } from './componentes/Layout.jsx';
import { Login } from './telas/Login.jsx';
import { Painel } from './telas/Painel.jsx';
import { Dashboard } from './telas/Dashboard.jsx';
import { Conversas } from './telas/Conversas.jsx';
import { Contatos } from './telas/Contatos.jsx';
import { FichaContato } from './telas/contatos/FichaContato.jsx';
import { Agenda } from './telas/Agenda.jsx';
import { Quadro } from './telas/Quadro.jsx';
import { Equipe } from './telas/Equipe.jsx';
import { Catalogo } from './telas/Catalogo.jsx';
import { Backups } from './telas/Backups.jsx';
import { Campanhas } from './telas/Campanhas.jsx';
import { PaginaCampanha } from './telas/campanhas/PaginaCampanha.jsx';
import { Configuracoes } from './telas/Configuracoes.jsx';
import { Conexoes } from './telas/Conexoes.jsx';
import { CentralIa } from './telas/CentralIa.jsx';
import { Perfil } from './telas/Perfil.jsx';
import { FuncoesDev } from './telas/FuncoesDev.jsx';
import { TextosDev } from './telas/TextosDev.jsx';
import { DadosDev } from './telas/DadosDev.jsx';
import { LicencaPagina } from './telas/LicencaPagina.jsx';
import { GuardaLicenca } from './componentes/Licenca.jsx';
import { ExigeFuncao } from './lib/funcoes.jsx';

/**
 * Rotas da aplicacao.
 *
 * `cargoMinimo` esconde o que a pessoa nao pode usar. E importante entender
 * que isso e CONVENIENCIA, nao seguranca: quem souber a URL chega na tela
 * de qualquer jeito. A protecao real esta na API, que recusa a requisicao —
 * e e por isso que ela e obrigatoria la, e opcional aqui.
 */
function Protegida({ cargoMinimo = 'atendente', children }) {
  const { usuario, carregando, podeAcessar } = useAuth();

  if (carregando) return <Carregando texto="Verificando acesso..." />;
  if (!usuario) return <Navigate to="/entrar" replace />;

  if (!podeAcessar(cargoMinimo)) {
    return (
      <div style={{ padding: 'var(--e6)' }}>
        <h1>Sem permissao</h1>
        <p className="texto-suave" style={{ marginTop: 'var(--e2)' }}>
          Seu perfil ({usuario.cargo}) nao tem acesso a esta area. Fale com o responsavel pela empresa.
        </p>
      </div>
    );
  }

  return children;
}

export function App() {
  const { usuario, carregando } = useAuth();

  if (carregando) return <Carregando texto="Carregando..." />;

  return (
    <Routes>
      <Route path="/entrar" element={usuario ? <Navigate to="/" replace /> : <Login />} />

      <Route
        element={
          <Protegida>
            {/* Licenca travada: no lugar do sistema, a tela de bloqueio (o DEV passa). */}
            <GuardaLicenca>
              <Layout />
            </GuardaLicenca>
          </Protegida>
        }
      >
        <Route path="/" element={<Painel />} />
        <Route
          path="/quadro"
          element={
            <ExigeFuncao chave="quadro">
              <Quadro />
            </ExigeFuncao>
          }
        />
        <Route
          path="/equipe"
          element={
            <Protegida cargoMinimo="admin">
              <Equipe />
            </Protegida>
          }
        />
        <Route path="/conversas" element={<Conversas />} />
        <Route path="/conversas/:id" element={<Conversas />} />
        <Route path="/contatos" element={<Contatos />} />
        <Route path="/contatos/:id" element={<FichaContato />} />
        <Route path="/agenda" element={<Agenda />} />
        <Route path="/catalogo" element={<Catalogo />} />
        <Route path="/perfil" element={<Perfil />} />

        <Route
          path="/campanhas"
          element={
            <Protegida cargoMinimo="admin">
              <ExigeFuncao chave="campanhas">
                <Campanhas />
              </ExigeFuncao>
            </Protegida>
          }
        />
        {/* "/campanhas/nova" cai aqui tambem (id = "nova"): assim, ao salvar a
            primeira etapa, a tela troca de endereco sem perder o que ja foi
            preenchido nas outras. */}
        <Route
          path="/campanhas/:id"
          element={
            <Protegida cargoMinimo="admin">
              <ExigeFuncao chave="campanhas">
                <PaginaCampanha />
              </ExigeFuncao>
            </Protegida>
          }
        />
        <Route
          path="/dashboard"
          element={
            <Protegida cargoMinimo="owner">
              <Dashboard />
            </Protegida>
          }
        />
        <Route
          path="/ia"
          element={
            <Protegida cargoMinimo="admin">
              <CentralIa />
            </Protegida>
          }
        />
        <Route
          path="/conexoes"
          element={
            <Protegida cargoMinimo="admin">
              <Conexoes />
            </Protegida>
          }
        />
        <Route
          path="/configuracoes"
          element={
            <Protegida cargoMinimo="admin">
              <Configuracoes />
            </Protegida>
          }
        />
        {/* So o DEV: para os outros, a pagina nem aparece no menu (e a API nega). */}
        <Route
          path="/dev"
          element={
            <Protegida cargoMinimo="dev">
              <FuncoesDev />
            </Protegida>
          }
        />
        <Route
          path="/dev/textos"
          element={
            <Protegida cargoMinimo="dev">
              <TextosDev />
            </Protegida>
          }
        />
        <Route
          path="/dev/dados"
          element={
            <Protegida cargoMinimo="dev">
              <DadosDev />
            </Protegida>
          }
        />
        <Route
          path="/backups"
          element={
            <Protegida cargoMinimo="owner">
              <Backups />
            </Protegida>
          }
        />
        <Route
          path="/licenca"
          element={
            <Protegida cargoMinimo="owner">
              <LicencaPagina />
            </Protegida>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
