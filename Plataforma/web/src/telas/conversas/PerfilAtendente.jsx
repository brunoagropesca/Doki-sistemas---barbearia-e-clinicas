import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/autenticacao.jsx';
import { Aviso } from '../../componentes/ui.jsx';

/**
 * O perfil de quem esta atendendo, no topo da mesa.
 *
 * E o ponto de entrada de tudo que e "meu": os atendimentos que finalizei, os
 * horarios que preciso acompanhar, e o estado em que estou para a equipe
 * (online, ausente, offline). Esse ultimo nao e enfeite: a distribuicao
 * automatica so entrega conversa a quem esta online, e ate aqui nao havia
 * nenhum lugar na tela para alguem se colocar assim.
 */

const LIMITE_FOTO = 3 * 1024 * 1024;
const FORMATOS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const PRESENCAS = [
  { chave: 'online', rotulo: 'Online', dica: 'Recebe conversas novas' },
  { chave: 'ausente', rotulo: 'Ausente', dica: 'Pausa curta' },
  { chave: 'offline', rotulo: 'Offline', dica: 'Não recebe nada' }
];

const ROTULO_CARGO = { owner: 'Dono', admin: 'Administrador', atendente: 'Atendente', dev: 'Desenvolvedor' };

/** Foto, ou a inicial do nome quando ainda nao ha foto. */
export function Avatar({ usuario, tamanho = 40, presenca = false }) {
  const inicial = (usuario?.nome ?? '?').trim().slice(0, 1).toUpperCase();

  return (
    <span className="avatar" style={{ width: tamanho, height: tamanho, fontSize: tamanho * 0.42 }}>
      {usuario?.avatar ? <img src={usuario.avatar} alt="" /> : <span aria-hidden="true">{inicial}</span>}
      {presenca && <span className={`avatar__presenca avatar__presenca--${usuario?.statusPresenca ?? 'offline'}`} />}
    </span>
  );
}

/**
 * @param {object} p
 * @param {'finalizados'|'agendamentos'|null} p.vista   o que esta aberto na area principal
 * @param {(vista: string|null) => void} p.aoEscolher
 */
export function PerfilAtendente({ vista, aoEscolher }) {
  const { usuario, recarregar } = useAuth();
  const [aberto, setAberto] = useState(false);
  const [erro, setErro] = useState(null);
  const raizRef = useRef(null);
  const arquivoRef = useRef(null);

  // Fecha ao clicar fora ou apertar Esc: um menu que so fecha no proprio botao
  // fica preso por cima da lista.
  useEffect(() => {
    if (!aberto) return undefined;
    const fora = (e) => {
      if (!raizRef.current?.contains(e.target)) setAberto(false);
    };
    const esc = (e) => e.key === 'Escape' && setAberto(false);
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', fora);
      document.removeEventListener('keydown', esc);
    };
  }, [aberto]);

  // Quantos horarios estao por acontecer: o numero que faz o atendente abrir a lista.
  const agendamentos = useQuery({
    queryKey: ['agenda', 'atendente', usuario?.id],
    queryFn: () => api.get('/api/agenda/atendente'),
    enabled: Boolean(usuario)
  });
  const totalAgendamentos = agendamentos.data?.agendamentos?.length ?? 0;

  const mudarPresenca = useMutation({
    mutationFn: (statusPresenca) => api.patch('/api/auth/presenca', { statusPresenca }),
    onSuccess: () => recarregar()
  });

  const mudarFoto = useMutation({
    mutationFn: (corpo) => api.put('/api/auth/foto', corpo),
    onSuccess: () => {
      setErro(null);
      recarregar();
    },
    onError: (e) => setErro(e.message)
  });

  function escolherArquivo(arquivo) {
    setErro(null);
    if (!arquivo) return;
    if (!FORMATOS.includes(arquivo.type)) return setErro('Use uma imagem PNG, JPG, WEBP ou GIF.');
    if (arquivo.size > LIMITE_FOTO) return setErro('A imagem passa de 3 MB.');

    const leitor = new FileReader();
    leitor.onload = () => mudarFoto.mutate({ foto: leitor.result });
    leitor.onerror = () => setErro('Não consegui ler este arquivo.');
    leitor.readAsDataURL(arquivo);
  }

  if (!usuario) return null;

  const presenca = PRESENCAS.find((p) => p.chave === usuario.statusPresenca) ?? PRESENCAS[2];
  const escolher = (v) => {
    aoEscolher(v);
    setAberto(false);
  };

  return (
    <div className="perfil" ref={raizRef}>
      <button
        type="button"
        className="perfil__botao"
        aria-haspopup="menu"
        aria-expanded={aberto}
        onClick={() => setAberto((a) => !a)}
      >
        <Avatar usuario={usuario} tamanho={40} presenca />
        <span className="perfil__nome">
          <strong>{usuario.nome}</strong>
          <span className="texto-fraco">
            {ROTULO_CARGO[usuario.cargo] ?? usuario.cargo} · {presenca.rotulo.toLowerCase()}
          </span>
        </span>
        {totalAgendamentos > 0 && vista !== 'agendamentos' && (
          <span className="perfil__contador" title="Horários que você acompanha">
            {totalAgendamentos}
          </span>
        )}
        <span className="perfil__seta" aria-hidden="true">
          {aberto ? '▴' : '▾'}
        </span>
      </button>

      {aberto && (
        <div className="perfil__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className={`perfil__item${!vista ? ' perfil__item--ativo' : ''}`}
            onClick={() => escolher(null)}
          >
            Conversas
          </button>
          <button
            type="button"
            role="menuitem"
            className={`perfil__item${vista === 'finalizados' ? ' perfil__item--ativo' : ''}`}
            onClick={() => escolher('finalizados')}
          >
            Atendimentos finalizados
          </button>
          <button
            type="button"
            role="menuitem"
            className={`perfil__item${vista === 'agendamentos' ? ' perfil__item--ativo' : ''}`}
            onClick={() => escolher('agendamentos')}
          >
            <span>Agendamentos</span>
            {totalAgendamentos > 0 && <span className="perfil__contador">{totalAgendamentos}</span>}
          </button>
          <Link to="/perfil" role="menuitem" className="perfil__item">
            Meu perfil e respostas rápidas
          </Link>

          <div className="perfil__grupo">Meu status</div>
          <div className="perfil__presencas" role="group" aria-label="Meu status">
            {PRESENCAS.map((p) => (
              <button
                key={p.chave}
                type="button"
                className={`perfil__presenca perfil__presenca--${p.chave}${
                  usuario.statusPresenca === p.chave ? ' perfil__presenca--ativa' : ''
                }`}
                aria-pressed={usuario.statusPresenca === p.chave}
                title={p.dica}
                disabled={mudarPresenca.isPending}
                onClick={() => mudarPresenca.mutate(p.chave)}
              >
                {p.rotulo}
              </button>
            ))}
          </div>

          <div className="perfil__grupo">Foto</div>
          <input
            ref={arquivoRef}
            type="file"
            accept={FORMATOS.join(',')}
            style={{ display: 'none' }}
            onChange={(e) => {
              escolherArquivo(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <div className="linha" style={{ gap: 'var(--e1)', padding: '0 var(--e2) var(--e2)' }}>
            <button
              type="button"
              className="perfil__pequeno"
              disabled={mudarFoto.isPending}
              onClick={() => arquivoRef.current?.click()}
            >
              {usuario.avatar ? 'Trocar foto' : 'Adicionar foto'}
            </button>
            {usuario.avatar && (
              <button
                type="button"
                className="perfil__pequeno"
                disabled={mudarFoto.isPending}
                onClick={() => mudarFoto.mutate({ remover: true })}
              >
                Remover
              </button>
            )}
          </div>
          {erro && (
            <div style={{ padding: '0 var(--e2) var(--e2)' }}>
              <Aviso tom="perigo">{erro}</Aviso>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
