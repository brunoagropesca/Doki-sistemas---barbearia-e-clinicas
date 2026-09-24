import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useIsFetching } from '@tanstack/react-query';
import { useAuth } from '../lib/autenticacao.jsx';
import { Aviso, Botao, Carregando, Vazio } from '../componentes/ui.jsx';
import { Console } from './conexoes/Console.jsx';
import { ListaSessoes } from './conexoes/ListaSessoes.jsx';
import { PainelSessao } from './conexoes/PainelSessao.jsx';
import { CHAVE_CANAIS, useCanais } from './conexoes/hooks.js';
import { formatarTelefone } from './conexoes/formatar.js';
import './Conexoes.css';

/**
 * Central de Conexões & Canais Omnichannel.
 *
 * Hoje so o WhatsApp (Baileys, ate 5 contas) esta pronto; Telegram e Instagram
 * Direct aparecem como "em breve". Dono e gerente conectam, desconectam e
 * ajustam a conta que ja existe; adicionar e remover contas e do perfil
 * tecnico (o servidor garante; a tela so mostra ou esconde os botoes).
 */

const ABAS = [
  { chave: 'whatsapp', rotulo: 'WhatsApp (QR Code & Instância)' },
  { chave: 'telegram', rotulo: 'Telegram (Bot Token)' },
  { chave: 'instagram', rotulo: 'Instagram Direct (Meta API)' },
  { chave: 'console', rotulo: 'Console de Conexões em Tempo Real' }
];

export function Conexoes() {
  const { usuario } = useAuth();
  const ehDev = usuario?.cargo === 'dev';

  const [params, setParams] = useSearchParams();
  const abaPedida = params.get('aba');
  const aba = ABAS.some((a) => a.chave === abaPedida) ? abaPedida : 'whatsapp';

  const canais = useCanais();
  const atualizando = useIsFetching({ queryKey: CHAVE_CANAIS }) > 0;

  const lista = canais.data?.canais ?? [];
  const limite = canais.data?.limite ?? 5;

  const [escolhida, setEscolhida] = useState(null);
  // A escolhida some (removida) ou ainda nao existe: cai na primeira.
  const selecionada = lista.find((c) => c.chave === escolhida) ?? lista[0] ?? null;

  function irParaAba(chave) {
    const novos = new URLSearchParams(params);
    novos.set('aba', chave);
    setParams(novos, { replace: true });
  }

  return (
    <div className="cx-pagina">
      <header className="cx-topo">
        <span className="cx-topo__icone" aria-hidden="true">
          🔌
        </span>
        <div className="crescer">
          <h1>Central de Conexões &amp; Canais Omnichannel</h1>
          <p className="texto-fraco">Gerenciamento de instâncias e pareamentos de WhatsApp, Telegram e Instagram Direct.</p>
        </div>
        <span className={`cx-motor ${canais.isError ? 'cx-motor--fora' : ''}`} role="status">
          <span className="cx-ponto cx-ponto--pulsando-lento" aria-hidden="true" />
          {canais.isError ? 'Motor sem resposta' : 'Motor omnichannel online'}
        </span>
        <Botao
          type="button"
          variante="secundario"
          tamanho="sm"
          carregando={atualizando}
          onClick={() => canais.refetch()}
        >
          Atualizar
        </Botao>
      </header>

      <ResumoCanais lista={lista} selecionada={selecionada} aoGerenciar={() => irParaAba('whatsapp')} />

      <Abas aba={aba} aoTrocar={irParaAba} />

      <div role="tabpanel" id={`cx-painel-${aba}`} aria-labelledby={`cx-aba-${aba}`} tabIndex={-1}>
        {canais.isLoading && <Carregando texto="Carregando conexões..." />}
        {canais.isError && <Aviso tom="perigo">{canais.error.message}</Aviso>}

        {canais.isSuccess && aba === 'whatsapp' && (
          <div className="cx-whatsapp">
            <ListaSessoes canais={lista} limite={limite} selecionada={selecionada?.chave} aoEscolher={setEscolhida} ehDev={ehDev} />
            <div className="cx-whatsapp__principal">
              {selecionada ? (
                <PainelSessao
                  key={selecionada.chave}
                  canal={selecionada}
                  ehDev={ehDev}
                  aoRemovida={() => setEscolhida(null)}
                />
              ) : (
                <Vazio
                  titulo="Nenhuma sessão configurada"
                  descricao={
                    ehDev
                      ? 'Use “+ Nova sessão” na lista ao lado para adicionar a primeira conta de WhatsApp.'
                      : 'Fale com o suporte técnico para configurar o primeiro número de WhatsApp.'
                  }
                />
              )}
            </div>
          </div>
        )}

        {aba === 'telegram' && (
          <Vazio titulo="Telegram — em breve" descricao="A conexão por Bot Token ainda está em desenvolvimento. O WhatsApp já está pronto para uso." />
        )}
        {aba === 'instagram' && (
          <Vazio titulo="Instagram Direct — em breve" descricao="A conexão pela API da Meta ainda está em desenvolvimento. O WhatsApp já está pronto para uso." />
        )}

        {canais.isSuccess && aba === 'console' && <Console canais={lista} />}
      </div>
    </div>
  );
}

/** Tres cartoes-resumo do topo. So o do WhatsApp tem dados e acao. */
function ResumoCanais({ lista, selecionada, aoGerenciar }) {
  const conectada = lista.find((c) => c.status === 'conectado');
  const numero = conectada ? formatarTelefone(conectada.identificador) : '';
  const conectadas = lista.filter((c) => c.status === 'conectado').length;
  const iaLigada = lista.some((c) => c.iaHabilitada);

  return (
    <div className="cx-resumo">
      <article className="cx-canal cx-canal--whatsapp">
        <header className="cx-canal__topo">
          <span className="cx-canal__icone" aria-hidden="true">
            💬
          </span>
          <div className="crescer">
            <h2>WhatsApp</h2>
            <p className="texto-fraco">Frontline principal</p>
          </div>
          <span className={`cx-tag ${conectadas ? 'cx-tag--ok' : 'cx-tag--fora'}`}>
            {conectadas ? `${conectadas} conectada${conectadas > 1 ? 's' : ''}` : 'Desconectado'}
          </span>
        </header>
        <dl className="cx-canal__dados">
          <div>
            <dt>Número pareado</dt>
            <dd>{numero || 'Nenhum'}</dd>
          </div>
          <div>
            <dt>Instância</dt>
            <dd className="mono">{selecionada?.nome ?? 'Não configurada'}</dd>
          </div>
          <div>
            <dt>Atendimento IA</dt>
            <dd>{lista.length === 0 ? '—' : iaLigada ? 'Sofia ativa' : 'Desligado'}</dd>
          </div>
        </dl>
        <Botao type="button" onClick={aoGerenciar}>
          Gerenciar pareamento
        </Botao>
      </article>

      <CanalEmBreve icone="✈️" nome="Telegram" apoio="Bot Father API" />
      <CanalEmBreve icone="📷" nome="Instagram Direct" apoio="Meta Graph API" />
    </div>
  );
}

function CanalEmBreve({ icone, nome, apoio }) {
  return (
    <article className="cx-canal cx-canal--embreve" aria-label={`${nome} — em breve`}>
      <header className="cx-canal__topo">
        <span className="cx-canal__icone" aria-hidden="true">
          {icone}
        </span>
        <div className="crescer">
          <h2>{nome}</h2>
          <p className="texto-fraco">{apoio}</p>
        </div>
        <span className="cx-tag">Em breve</span>
      </header>
      <p className="texto-fraco">Este canal ainda está em desenvolvimento.</p>
    </article>
  );
}

/**
 * Abas com o padrao de teclado do WAI-ARIA: setas movem, Home/End vao aos
 * extremos e so a aba ativa entra na ordem do Tab.
 */
function Abas({ aba, aoTrocar }) {
  const refs = useRef({});
  const [foco, setFoco] = useState(null);

  useEffect(() => {
    if (foco) refs.current[foco]?.focus();
  }, [foco]);

  function aoTeclar(e, indice) {
    let alvo = null;
    if (e.key === 'ArrowRight') alvo = (indice + 1) % ABAS.length;
    else if (e.key === 'ArrowLeft') alvo = (indice - 1 + ABAS.length) % ABAS.length;
    else if (e.key === 'Home') alvo = 0;
    else if (e.key === 'End') alvo = ABAS.length - 1;
    if (alvo === null) return;
    e.preventDefault();
    aoTrocar(ABAS[alvo].chave);
    setFoco(ABAS[alvo].chave);
  }

  return (
    <div className="cx-abas" role="tablist" aria-label="Canais e console">
      {ABAS.map((a, i) => (
        <button
          key={a.chave}
          ref={(el) => (refs.current[a.chave] = el)}
          id={`cx-aba-${a.chave}`}
          type="button"
          role="tab"
          aria-selected={aba === a.chave}
          aria-controls={`cx-painel-${a.chave}`}
          tabIndex={aba === a.chave ? 0 : -1}
          className={`cx-aba ${aba === a.chave ? 'cx-aba--ativa' : ''}`}
          onClick={() => aoTrocar(a.chave)}
          onKeyDown={(e) => aoTeclar(e, i)}
        >
          {a.rotulo}
        </button>
      ))}
    </div>
  );
}
