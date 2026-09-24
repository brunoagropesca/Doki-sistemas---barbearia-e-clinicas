import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/autenticacao.jsx';
import { AreaTexto, Aviso, Botao, Campo, Cartao, Entrada, Etiqueta, Modal, Vazio } from '../componentes/ui.jsx';
import { Avatar } from './conversas/PerfilAtendente.jsx';
import { preencherVariaveis } from './conversas/Compositor.jsx';
import './Perfil.css';

/**
 * Meu perfil: o que cada pessoa ajusta em si mesma — foto, dados de contato,
 * status, senha e as proprias respostas rapidas do livechat.
 *
 * Cargo e usuario de login aparecem, mas nao se editam aqui: sao decisao de
 * quem administra a equipe.
 */

const ROTULO_CARGO = { owner: 'Dono', admin: 'Administrador', atendente: 'Atendente', dev: 'Desenvolvedor' };

const PRESENCAS = [
  { chave: 'online', rotulo: 'Online', dica: 'Recebe conversas novas' },
  { chave: 'ausente', rotulo: 'Ausente', dica: 'Pausa curta' },
  { chave: 'offline', rotulo: 'Offline', dica: 'Não recebe nada' }
];

const FORMATOS_FOTO = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function Perfil() {
  const { usuario } = useAuth();
  const { hash } = useLocation();

  // "/perfil#respostas" (link do livechat) rola direto para as respostas.
  useEffect(() => {
    if (!hash) return;
    const alvo = document.getElementById(hash.slice(1));
    alvo?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hash]);

  if (!usuario) return null;

  return (
    <div className="coluna perfil-pagina">
      <header>
        <h1>Meu perfil</h1>
        <p className="texto-suave">Seus dados, sua foto, seu status e as suas respostas rápidas do atendimento.</p>
      </header>

      <div className="perfil-pagina__grade">
        <div className="coluna">
          <Identidade usuario={usuario} />
          <Senha />
        </div>
        <div className="coluna">
          <MeusDados usuario={usuario} />
          <RespostasRapidas usuario={usuario} />
        </div>
      </div>
    </div>
  );
}

function Identidade({ usuario }) {
  const { recarregar } = useAuth();
  const [erro, setErro] = useState(null);
  const arquivoRef = useRef(null);

  const foto = useMutation({
    mutationFn: (corpo) => api.put('/api/auth/foto', corpo),
    onSuccess: () => {
      setErro(null);
      recarregar();
    },
    onError: (e) => setErro(e.message)
  });

  const presenca = useMutation({
    mutationFn: (statusPresenca) => api.patch('/api/auth/presenca', { statusPresenca }),
    onSuccess: () => recarregar()
  });

  function escolher(arquivo) {
    setErro(null);
    if (!arquivo) return;
    if (!FORMATOS_FOTO.includes(arquivo.type)) return setErro('Use uma imagem PNG, JPG, WEBP ou GIF.');
    if (arquivo.size > 3 * 1024 * 1024) return setErro('A imagem passa de 3 MB.');
    const leitor = new FileReader();
    leitor.onload = () => foto.mutate({ foto: leitor.result });
    leitor.onerror = () => setErro('Não consegui ler este arquivo.');
    leitor.readAsDataURL(arquivo);
  }

  return (
    <Cartao>
      <div className="identidade">
        <button
          type="button"
          className="identidade__foto"
          onClick={() => arquivoRef.current?.click()}
          disabled={foto.isPending}
          title="Trocar foto"
        >
          <Avatar usuario={usuario} tamanho={112} presenca />
          <span className="identidade__trocar">{foto.isPending ? 'Enviando…' : 'Trocar foto'}</span>
        </button>
        <input
          ref={arquivoRef}
          type="file"
          accept={FORMATOS_FOTO.join(',')}
          hidden
          onChange={(e) => {
            escolher(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        <strong className="identidade__nome">{usuario.nome}</strong>
        <div className="linha" style={{ justifyContent: 'center', gap: 'var(--e2)' }}>
          <Etiqueta tom="primario">{ROTULO_CARGO[usuario.cargo] ?? usuario.cargo}</Etiqueta>
          <span className="texto-fraco">@{usuario.username}</span>
        </div>

        {usuario.avatar && (
          <Botao variante="fantasma" tamanho="sm" onClick={() => foto.mutate({ remover: true })} disabled={foto.isPending}>
            Remover foto
          </Botao>
        )}
        {erro && <Aviso tom="perigo">{erro}</Aviso>}

        <div className="identidade__status">
          <span className="campo__rotulo">Meu status</span>
          <div className="identidade__presencas" role="group" aria-label="Meu status">
            {PRESENCAS.map((p) => (
              <button
                key={p.chave}
                type="button"
                className={`perfil__presenca perfil__presenca--${p.chave}${
                  usuario.statusPresenca === p.chave ? ' perfil__presenca--ativa' : ''
                }`}
                aria-pressed={usuario.statusPresenca === p.chave}
                title={p.dica}
                disabled={presenca.isPending}
                onClick={() => presenca.mutate(p.chave)}
              >
                {p.rotulo}
              </button>
            ))}
          </div>
          <span className="campo__dica">
            {PRESENCAS.find((p) => p.chave === usuario.statusPresenca)?.dica ?? ''}
          </span>
        </div>
      </div>
    </Cartao>
  );
}

function MeusDados({ usuario }) {
  const { recarregar } = useAuth();
  const [form, setForm] = useState({ nome: usuario.nome ?? '', email: usuario.email ?? '', telefone: usuario.telefone ?? '' });
  const [salvo, setSalvo] = useState(false);

  const salvar = useMutation({
    mutationFn: () => api.patch('/api/perfil', form),
    onSuccess: () => {
      setSalvo(true);
      recarregar();
    }
  });

  const campos = salvar.error?.camposComErro ?? {};
  const mudou =
    form.nome !== (usuario.nome ?? '') || form.email !== (usuario.email ?? '') || form.telefone !== (usuario.telefone ?? '');
  const mudar = (chave) => (e) => {
    setSalvo(false);
    setForm((f) => ({ ...f, [chave]: e.target.value }));
  };

  return (
    <Cartao titulo="Meus dados">
      <form
        className="coluna"
        onSubmit={(e) => {
          e.preventDefault();
          salvar.mutate();
        }}
      >
        <Campo rotulo="Nome" obrigatorio erro={campos.nome} dica="É o nome que aparece para a equipe nas conversas.">
          <Entrada value={form.nome} onChange={mudar('nome')} maxLength={120} required />
        </Campo>
        <div className="perfil-pagina__dupla">
          <Campo rotulo="E-mail" erro={campos.email}>
            <Entrada type="email" value={form.email} onChange={mudar('email')} placeholder="voce@exemplo.com" />
          </Campo>
          <Campo rotulo="Telefone" erro={campos.telefone}>
            <Entrada value={form.telefone} onChange={mudar('telefone')} placeholder="(11) 99999-0000" maxLength={30} />
          </Campo>
        </div>
        <Campo rotulo="Usuário de login" dica="Só quem administra a equipe pode trocar.">
          <Entrada value={usuario.username} disabled />
        </Campo>

        {salvar.isError && !Object.keys(campos).length && <Aviso tom="perigo">{salvar.error.message}</Aviso>}
        {salvo && !mudou && <Aviso tom="sucesso">Dados salvos.</Aviso>}

        <div className="linha linha--fim">
          <Botao type="submit" carregando={salvar.isPending} disabled={!mudou || salvar.isPending}>
            Salvar alterações
          </Botao>
        </div>
      </form>
    </Cartao>
  );
}

function Senha() {
  const { recarregar } = useAuth();
  const [form, setForm] = useState({ senhaAtual: '', novaSenha: '', confirmar: '' });
  const [erroLocal, setErroLocal] = useState(null);

  const trocar = useMutation({
    mutationFn: () => api.post('/api/auth/trocar-senha', { senhaAtual: form.senhaAtual, novaSenha: form.novaSenha }),
    // Todas as sessoes caem ao trocar a senha, inclusive esta: a tela volta ao
    // login depois de mostrar o aviso por um instante.
    onSuccess: () => setTimeout(() => recarregar(), 1800)
  });

  const campos = trocar.error?.camposComErro ?? {};

  function enviar(e) {
    e.preventDefault();
    setErroLocal(null);
    if (form.novaSenha !== form.confirmar) {
      setErroLocal('A confirmação não bate com a nova senha.');
      return;
    }
    trocar.mutate();
  }

  const mudar = (chave) => (e) => setForm((f) => ({ ...f, [chave]: e.target.value }));

  return (
    <Cartao titulo="Senha">
      {trocar.isSuccess ? (
        <Aviso tom="sucesso" titulo="Senha alterada">
          Por segurança, todas as sessões foram encerradas. Entre de novo com a nova senha.
        </Aviso>
      ) : (
        <form className="coluna" onSubmit={enviar}>
          <Campo rotulo="Senha atual" erro={campos.senhaAtual}>
            <Entrada type="password" autoComplete="current-password" value={form.senhaAtual} onChange={mudar('senhaAtual')} required />
          </Campo>
          <Campo rotulo="Nova senha" erro={campos.novaSenha} dica="Pelo menos 8 caracteres.">
            <Entrada type="password" autoComplete="new-password" value={form.novaSenha} onChange={mudar('novaSenha')} minLength={8} required />
          </Campo>
          <Campo rotulo="Confirmar nova senha" erro={erroLocal}>
            <Entrada type="password" autoComplete="new-password" value={form.confirmar} onChange={mudar('confirmar')} required />
          </Campo>
          {trocar.isError && !Object.keys(campos).length && <Aviso tom="perigo">{trocar.error.message}</Aviso>}
          <p className="campo__dica">Ao trocar a senha, você sai de todos os aparelhos em que estiver conectado.</p>
          <div className="linha linha--fim">
            <Botao type="submit" variante="secundario" carregando={trocar.isPending}>
              Trocar senha
            </Botao>
          </div>
        </form>
      )}
    </Cartao>
  );
}

const VARIAVEIS = [
  { chave: '{saudacao}', dica: 'Bom dia / Boa tarde / Boa noite, conforme a hora' },
  { chave: '{nome}', dica: 'Primeiro nome do cliente' },
  { chave: '{atendente}', dica: 'Seu primeiro nome' }
];

function RespostasRapidas({ usuario }) {
  const queryClient = useQueryClient();
  const [editando, setEditando] = useState(null); // resposta, ou {} para nova
  const [apagando, setApagando] = useState(null);

  const lista = useQuery({
    queryKey: ['respostas-rapidas'],
    queryFn: () => api.get('/api/perfil/respostas-rapidas')
  });
  const respostas = lista.data?.respostas ?? [];

  const apagar = useMutation({
    mutationFn: (id) => api.delete(`/api/perfil/respostas-rapidas/${id}`),
    onSuccess: () => {
      setApagando(null);
      queryClient.invalidateQueries({ queryKey: ['respostas-rapidas'] });
    }
  });

  return (
    <section id="respostas">
      <Cartao
        titulo="Respostas rápidas"
        acao={
          <Botao tamanho="sm" onClick={() => setEditando({})}>
            + Nova resposta
          </Botao>
        }
      >
        <p className="texto-suave perfil-pagina__explica">
          No chat, digite <code>/</code> seguido do atalho (ex.: <code>/ola</code>) ou clique no ⚡ para escolher. Elas são
          só suas — cada atendente tem as próprias.
        </p>

        {lista.isLoading ? null : respostas.length === 0 ? (
          <Vazio
            titulo="Nenhuma resposta rápida ainda"
            descricao="Cadastre os textos que você manda toda hora: boas-vindas, preços, endereço, formas de pagamento."
            acao={<Botao variante="secundario" onClick={() => setEditando({})}>Criar a primeira</Botao>}
          />
        ) : (
          <ul className="respostas-lista">
            {respostas.map((r) => (
              <li key={r.id} className="respostas-lista__item">
                <code className="respostas-lista__atalho">/{r.atalho}</code>
                <p className="respostas-lista__texto">{r.texto}</p>
                <div className="respostas-lista__acoes">
                  <Botao variante="fantasma" tamanho="sm" onClick={() => setEditando(r)}>
                    Editar
                  </Botao>
                  <Botao variante="fantasma" tamanho="sm" onClick={() => setApagando(r)}>
                    Apagar
                  </Botao>
                </div>
              </li>
            ))}
          </ul>
        )}
        {lista.isError && <Aviso tom="perigo">{lista.error.message}</Aviso>}
      </Cartao>

      {editando && (
        <EditarResposta
          resposta={editando}
          usuario={usuario}
          aoFechar={() => setEditando(null)}
          aoSalvar={() => {
            setEditando(null);
            queryClient.invalidateQueries({ queryKey: ['respostas-rapidas'] });
          }}
        />
      )}

      <Modal
        titulo="Apagar resposta rápida"
        aberto={Boolean(apagando)}
        aoFechar={() => setApagando(null)}
        largura={420}
        rodape={
          <>
            <Botao variante="fantasma" onClick={() => setApagando(null)}>
              Cancelar
            </Botao>
            <Botao variante="perigo" carregando={apagar.isPending} onClick={() => apagar.mutate(apagando.id)}>
              Apagar
            </Botao>
          </>
        }
      >
        <p>
          Apagar a resposta <code>/{apagando?.atalho}</code>? Ela some da sua lista no chat.
        </p>
        {apagar.isError && <Aviso tom="perigo">{apagar.error.message}</Aviso>}
      </Modal>
    </section>
  );
}

function EditarResposta({ resposta, usuario, aoFechar, aoSalvar }) {
  const nova = !resposta.id;
  const [atalho, setAtalho] = useState(resposta.atalho ?? '');
  const [texto, setTexto] = useState(resposta.texto ?? '');
  const textoRef = useRef(null);

  const salvar = useMutation({
    mutationFn: () =>
      nova
        ? api.post('/api/perfil/respostas-rapidas', { atalho, texto })
        : api.put(`/api/perfil/respostas-rapidas/${resposta.id}`, { atalho, texto }),
    onSuccess: aoSalvar
  });
  const campos = salvar.error?.camposComErro ?? {};

  function inserir(variavel) {
    const c = textoRef.current;
    const inicio = c?.selectionStart ?? texto.length;
    const fim = c?.selectionEnd ?? texto.length;
    const novo = texto.slice(0, inicio) + variavel + texto.slice(fim);
    setTexto(novo);
    requestAnimationFrame(() => {
      c?.focus();
      c?.setSelectionRange(inicio + variavel.length, inicio + variavel.length);
    });
  }

  return (
    <Modal
      titulo={nova ? 'Nova resposta rápida' : `Editar /${resposta.atalho}`}
      aberto
      aoFechar={aoFechar}
      largura={560}
      rodape={
        <>
          <Botao variante="fantasma" onClick={aoFechar}>
            Cancelar
          </Botao>
          <Botao
            carregando={salvar.isPending}
            disabled={!atalho.trim() || !texto.trim()}
            onClick={() => salvar.mutate()}
          >
            Salvar
          </Botao>
        </>
      }
    >
      <div className="coluna">
        <Campo rotulo="Atalho" obrigatorio erro={campos.atalho} dica="Uma palavra só, sem acento. É o que você digita depois da barra.">
          <div className="atalho-campo">
            <span aria-hidden="true">/</span>
            <Entrada
              value={atalho}
              onChange={(e) => setAtalho(e.target.value.replace(/\s/g, '').toLowerCase())}
              placeholder="ola"
              maxLength={30}
              autoFocus
            />
          </div>
        </Campo>
        <Campo rotulo="Texto" obrigatorio erro={campos.texto}>
          <AreaTexto
            ref={textoRef}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            rows={5}
            maxLength={4096}
            placeholder="{saudacao}, {nome}! Aqui é {atendente}, da barbearia. Como posso ajudar?"
          />
        </Campo>
        <div className="variaveis">
          <span className="campo__dica">Inserir:</span>
          {VARIAVEIS.map((v) => (
            <button key={v.chave} type="button" className="variaveis__chip" title={v.dica} onClick={() => inserir(v.chave)}>
              {v.chave}
            </button>
          ))}
        </div>
        {texto.trim() && (
          <div className="previa-resposta">
            <span className="campo__rotulo">Como o cliente “Maria Souza” vai receber</span>
            <div className="previa-resposta__balao">
              {preencherVariaveis(texto, { cliente: 'Maria Souza', atendente: usuario.nome })}
            </div>
          </div>
        )}
        {salvar.isError && !Object.keys(campos).length && <Aviso tom="perigo">{salvar.error.message}</Aviso>}
      </div>
    </Modal>
  );
}
