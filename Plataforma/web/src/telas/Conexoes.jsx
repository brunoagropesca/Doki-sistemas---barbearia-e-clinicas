import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useIsFetching } from '@tanstack/react-query';
import { useAuth } from '../lib/autenticacao.jsx';
import { Aviso, Botao, Carregando, Vazio } from '../componentes/ui.jsx';
import { Console } from './conexoes/Console.jsx';
import { ListaSessoes } from './conexoes/ListaSessoes.jsx';
import { PainelSessao } from './conexoes/PainelSessao.jsx';
import { CHAVE_CANAIS, useCanais } from './conexoes/hooks.js';
import './Conexoes.css';

/**
 * Conexões: os numeros de WhatsApp da empresa.
 *
 * Hoje so o WhatsApp (Baileys, ate 5 contas) esta pronto; Telegram e Instagram
 * Direct aparecem so como uma etiqueta "em breve" — antes cada um ganhava um
 * cartao E uma aba vazios, um terco da tela sem nada para fazer. Dono e
 * gerente conectam, desconectam e ajustam a conta que ja existe; adicionar e
 * remover contas e do perfil tecnico (o servidor garante; a tela so mostra ou
 * esconde os botoes).
 *
 * Cada informacao aparece UMA vez: o estado, o nome e o numero da conta ficam
 * no cartao de conexao dela (antes se repetiam no resumo, na lista e no painel).
 */

const ABAS = [
  { chave: 'whatsapp', rotulo: 'WhatsApp' },
  { chave: 'console', rotulo: 'Registro em tempo real' }
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
        <div className="crescer">
          <h1>Conexões</h1>
          <p className="texto-fraco">Os números de WhatsApp em que a Sofia e a equipe atendem.</p>
        </div>
        <span className={`cx-motor ${canais.isError ? 'cx-motor--fora' : ''}`} role="status">
          <span className="cx-ponto cx-ponto--pulsando-lento" aria-hidden="true" />
          {canais.isError ? 'Servidor sem resposta' : 'Servidor no ar'}
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

      <div className="cx-barra">
        <Abas aba={aba} aoTrocar={irParaAba} />
        <span className="cx-embreve" title="Estes canais ainda estão em desenvolvimento">
          Em breve: <span aria-hidden="true">✈️</span> Telegram · <span aria-hidden="true">📷</span> Instagram Direct
        </span>
      </div>

      <div role="tabpanel" id={`cx-painel-${aba}`} aria-labelledby={`cx-aba-${aba}`} tabIndex={-1}>
        {canais.isLoading && <Carregando texto="Carregando conexões..." />}
        {canais.isError && <Aviso tom="perigo">{canais.error.message}</Aviso>}

        {canais.isSuccess && aba === 'whatsapp' && (
          <div className="cx-whatsapp">
            {/* Com um numero so, a faixa repetia o cartao logo abaixo. O perfil
                tecnico sempre ve: e dela que sai o "+ Nova sessão". */}
            {(lista.length > 1 || ehDev) && (
              <ListaSessoes canais={lista} limite={limite} selecionada={selecionada?.chave} aoEscolher={setEscolhida} ehDev={ehDev} />
            )}
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
                  titulo="Nenhum número configurado"
                  descricao={
                    ehDev
                      ? 'Use “+ Nova sessão” aqui em cima para adicionar o primeiro número de WhatsApp.'
                      : 'Fale com o suporte técnico para configurar o primeiro número de WhatsApp.'
                  }
                />
              )}
            </div>
          </div>
        )}

        {canais.isSuccess && aba === 'console' && <Console canais={lista} />}
      </div>
    </div>
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
