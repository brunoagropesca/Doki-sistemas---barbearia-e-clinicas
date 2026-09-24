import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/autenticacao.jsx';
import { Aviso, Botao } from './ui.jsx';
import './Licenca.css';

/**
 * Licenca na tela: a guarda (tela de bloqueio), a faixa de aviso e o
 * formulario de ativar serial — que aparece nos dois lugares.
 */

const dataBR = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

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
