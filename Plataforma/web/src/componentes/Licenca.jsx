import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/autenticacao.jsx';
import { Aviso, Botao } from './ui.jsx';
import { IconeGmail, IconeInstagram, IconeWhatsapp } from './IconesContato.jsx';
import './Licenca.css';

/**
 * Licenca na tela: a guarda (tela de bloqueio), a faixa de aviso e o
 * formulario de ativar serial — que aparece nos dois lugares.
 */

const dataBR = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

/** Contato da Doki Sistemas: renovacao, serial e suporte. */
const CONTATO = {
  whatsapp: { texto: '+55 (92) 9 7400-3611', link: 'https://wa.me/5592974003611' },
  email: { texto: 'dokisistemasinteligentes@gmail.com', link: 'mailto:dokisistemasinteligentes@gmail.com' },
  instagram: { texto: '@doki.tecnologia', link: 'https://instagram.com/doki.tecnologia' }
};

/**
 * Onde falar com o fornecedor. Fica na pagina de Licenca e na tela de
 * bloqueio — e ali que o dono precisa do contato para pedir o serial.
 */
export function ContatoFornecedor({ codigo }) {
  // No WhatsApp, a mensagem ja vai com o codigo da instalacao.
  const texto = codigo ? `Olá! Quero renovar a licença do sistema. Código da instalação: ${codigo}` : 'Olá! Preciso de ajuda com a licença do sistema.';
  const itens = [
    ['whatsapp', 'WhatsApp', `${CONTATO.whatsapp.link}?text=${encodeURIComponent(texto)}`, <IconeWhatsapp tamanho={36} />, 'Resposta mais rápida'],
    ['instagram', 'Instagram', CONTATO.instagram.link, <IconeInstagram tamanho={36} />, 'Novidades e dicas'],
    ['email', 'Gmail', CONTATO.email.link, <IconeGmail tamanho={36} />, 'Para enviar documentos']
  ];
  return (
    <ul className="licenca-contato">
      {itens.map(([chave, rotulo, link, icone, dica]) => (
        <li key={chave}>
          <a href={link} target={chave === 'email' ? undefined : '_blank'} rel="noreferrer" className={`licenca-contato__item licenca-contato__item--${chave}`}>
            <span className="licenca-contato__icone">{icone}</span>
            <span className="licenca-contato__texto">
              <small>
                {rotulo} <span className="licenca-contato__dica">· {dica}</span>
              </small>
              <strong>
                {/* E-mail pode quebrar linha no celular, mas so antes do @. */}
                {chave === 'email' ? CONTATO.email.texto.split('@').map((p, i) => (i ? <span key={i}><wbr />@{p}</span> : p)) : CONTATO[chave].texto}
              </strong>
            </span>
            <span className="licenca-contato__seta" aria-hidden="true">›</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function useLicenca() {
  const { usuario } = useAuth();
  const queryClient = useQueryClient();
  const consulta = useQuery({
    queryKey: ['licenca'],
    queryFn: () => api.get('/api/licenca'),
    enabled: Boolean(usuario),
    refetchInterval: 5 * 60_000
  });

  // Uma chamada qualquer respondeu 402: a trava ligou agora, relê o estado.
  useEffect(() => {
    const aoTravar = () => queryClient.invalidateQueries({ queryKey: ['licenca'] });
    window.addEventListener('licenca-bloqueada', aoTravar);
    return () => window.removeEventListener('licenca-bloqueada', aoTravar);
  }, [queryClient]);

  return consulta.data?.licenca ?? null;
}

/** Colar o serial. Dono e DEV; os outros veem so o recado. */
export function AtivarSerial({ aoAtivar }) {
  const queryClient = useQueryClient();
  const [serial, setSerial] = useState('');
  const ativar = useMutation({
    mutationFn: () => api.post('/api/licenca/ativar', { serial }),
    onSuccess: () => {
      setSerial('');
      // Tudo que falhou com a licenca travada volta a carregar.
      queryClient.invalidateQueries();
      aoAtivar?.();
    }
  });

  return (
    <div className="licenca__ativar">
      <label className="campo" style={{ marginBottom: 0 }}>
        <span className="campo__rotulo">Cole aqui o serial recebido</span>
        <textarea
          className="entrada entrada--area licenca__serial"
          rows={3}
          value={serial}
          placeholder="DOKI-..."
          spellCheck={false}
          onChange={(e) => setSerial(e.target.value)}
        />
      </label>
      {ativar.isError && <Aviso tom="perigo">{ativar.error.message}</Aviso>}
      {ativar.isSuccess && <Aviso tom="sucesso">Licença ativada.</Aviso>}
      <Botao disabled={serial.trim().length < 10} carregando={ativar.isPending} onClick={() => ativar.mutate()}>
        Ativar serial
      </Botao>
    </div>
  );
}

export function CodigoDaInstalacao({ codigo }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <div className="licenca__codigo">
      <span className="texto-fraco">Código desta instalação</span>
      <strong className="mono">{codigo}</strong>
      <button
        type="button"
        className="licenca__copiar"
        onClick={() => {
          navigator.clipboard?.writeText(codigo).then(() => setCopiado(true)).catch(() => {});
          setTimeout(() => setCopiado(false), 2000);
        }}
      >
        {copiado ? 'Copiado!' : 'Copiar'}
      </button>
    </div>
  );
}

const MOTIVO = {
  sem_licenca: 'Este sistema ainda não foi ativado.',
  invalida: 'O serial ativado não é válido para esta instalação.',
  bloqueada: 'A licença venceu e o prazo de tolerância acabou.'
};

/**
 * Envolve o sistema: com a licenca travada, no lugar das telas aparece o
 * bloqueio. O DEV passa direto (e quem destrava e faz backup).
 */
export function GuardaLicenca({ children }) {
  const { usuario, sair, podeAcessar } = useAuth();
  const licenca = useLicenca();

  if (!licenca?.bloqueada || usuario?.cargo === 'dev') return children;

  return (
    <div className="licenca-bloqueio">
      <div className="licenca-bloqueio__caixa">
        <div className="licenca-bloqueio__icone" aria-hidden="true">🔒</div>
        <h1>Sistema bloqueado</h1>
        <p className="licenca-bloqueio__motivo">
          {MOTIVO[licenca.situacao] ?? 'Licença indisponível.'}
          {licenca.situacao === 'bloqueada' && licenca.validoAte && ` Venceu em ${dataBR(licenca.validoAte)}.`}
        </p>
        <p className="texto-suave">
          O atendimento automático pelo WhatsApp também está pausado. As mensagens dos clientes continuam sendo
          guardadas e aparecem assim que o sistema for liberado.
        </p>

        <CodigoDaInstalacao codigo={licenca.codigoInstalacao} />

        {podeAcessar('owner') ? (
          <>
            <p className="texto-suave">
              Envie o código acima ao seu fornecedor para receber o serial e cole-o abaixo.
            </p>
            <AtivarSerial />
          </>
        ) : (
          <Aviso tom="info">Peça ao dono da empresa para renovar a licença.</Aviso>
        )}

        <p className="texto-suave">Fale com a Doki Sistemas:</p>
        <ContatoFornecedor codigo={licenca.codigoInstalacao} />

        <Botao variante="fantasma" onClick={sair}>
          Sair
        </Botao>
      </div>
    </div>
  );
}

/** Faixa no topo das telas enquanto a licenca esta perto de vencer (ou na tolerancia). */
export function FaixaLicenca() {
  const { podeAcessar } = useAuth();
  const licenca = useLicenca();
  if (!licenca || !podeAcessar('admin')) return null;
  if (!['aviso', 'tolerancia'].includes(licenca.situacao)) return null;

  const texto =
    licenca.situacao === 'aviso'
      ? licenca.diasRestantes === 0
        ? 'A licença do sistema vence hoje.'
        : `A licença do sistema vence em ${licenca.diasRestantes} dia${licenca.diasRestantes === 1 ? '' : 's'} (${dataBR(licenca.validoAte)}).`
      : `A licença venceu em ${dataBR(licenca.validoAte)}. O sistema será bloqueado em ${licenca.diasParaTravar} dia${licenca.diasParaTravar === 1 ? '' : 's'}.`;

  return (
    <div className={`licenca-faixa licenca-faixa--${licenca.situacao}`} role="status">
      <span>{texto}</span>
      {podeAcessar('owner') && <Link to="/licenca">Renovar agora</Link>}
    </div>
  );
}
