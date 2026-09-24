import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useEmpresa } from '../../lib/empresa.js';
import { useAuth } from '../../lib/autenticacao.jsx';
import { AreaTexto, Aviso, Botao, Campo, Carregando, Entrada, Selecao } from '../../componentes/ui.jsx';
import { EscolherFoto } from '../equipe/EscolherFoto.jsx';

/**
 * Base de conhecimento: tudo que e da EMPRESA — quem ela e, onde fica, como
 * se paga, quando abre, as regras da casa e as perguntas de sempre.
 *
 * E daqui que a Sofia tira essas respostas (o texto ao lado e exatamente o
 * que ela recebe) e daqui sai o nome e o logo do menu lateral.
 *
 * Uma secao por vez, escolhida na lista da esquerda: sao oito assuntos, e
 * empilhados virariam uma pagina de rolar sem fim. O Salvar vale para todas.
 */

const SECOES = [
  { id: 'identidade', titulo: 'Identidade', dica: 'Nome, logo e apresentação' },
  { id: 'endereco', titulo: 'Endereço', dica: 'Onde fica e como chegar' },
  { id: 'contato', titulo: 'Contato', dica: 'Telefone, Instagram, site' },
  { id: 'pagamento', titulo: 'Pagamento', dica: 'Pix e formas aceitas' },
  { id: 'horario', titulo: 'Horário', dica: 'Dias e horas de funcionamento' },
  { id: 'politicas', titulo: 'Regras da casa', dica: 'Atrasos, cancelamentos' },
  { id: 'faq', titulo: 'Perguntas frequentes', dica: 'O que o cliente sempre pergunta' },
  { id: 'extras', titulo: 'Outras informações', dica: 'O que mais a Sofia deve saber' }
];

const DIAS = [
  ['1', 'Segunda'],
  ['2', 'Terça'],
  ['3', 'Quarta'],
  ['4', 'Quinta'],
  ['5', 'Sexta'],
  ['6', 'Sábado'],
  ['0', 'Domingo']
];

const FORMAS = ['Pix', 'Dinheiro', 'Cartão de débito', 'Cartão de crédito', 'Crédito parcelado', 'Vale-presente'];

const TIPOS_PIX = [
  ['cnpj', 'CNPJ'],
  ['cpf', 'CPF'],
  ['telefone', 'Telefone'],
  ['email', 'E-mail'],
  ['aleatoria', 'Chave aleatória']
];

/** A secao ja tem o essencial? (o ✓ na lista da esquerda) */
function preenchida(id, f) {
  switch (id) {
    case 'identidade': return Boolean(f.nome?.trim() && f.sobre?.trim());
    case 'endereco': return Boolean(f.endereco.logradouro?.trim());
    case 'contato': return Object.values(f.contato).some((v) => v?.trim());
    case 'pagamento': return Boolean(f.pagamento.pix.chave?.trim() || f.pagamento.formas.length);
    case 'horario': return Object.keys(f.horario.dias).length > 0;
    case 'politicas': return Boolean(f.politicas?.trim());
    case 'faq': return f.faq.some((q) => q.pergunta?.trim() && q.resposta?.trim());
    case 'extras': return Boolean(f.extras?.trim());
    default: return false;
  }
}

export function BaseConhecimento() {
  const empresa = useEmpresa();
  if (empresa.isLoading) return <Carregando />;
  if (empresa.isError) return <Aviso tom="perigo">{empresa.error.message}</Aviso>;
  // `key`: salvou, o formulario renasce do que o servidor devolveu.
  return <Formulario key={empresa.dataUpdatedAt} inicial={empresa.data} />;
}

function Formulario({ inicial }) {
  const queryClient = useQueryClient();
  const { podeAcessar } = useAuth();
  const [secao, setSecao] = useState('identidade');
  const [f, setF] = useState(() => structuredClone(inicial));
  const [logo, setLogo] = useState(undefined); // undefined = nao mexeu; null = remover
  const [salvo, setSalvo] = useState(false);

  const mudou = logo !== undefined || JSON.stringify(f) !== JSON.stringify(inicial);

  const textoIa = useQuery({ queryKey: ['empresa', 'texto-ia'], queryFn: () => api.get('/api/empresa/texto-ia') });

  const salvar = useMutation({
    mutationFn: () => {
      const { logo: _l, segmento: _s, ...resto } = f;
      return api.put('/api/empresa', {
        ...resto,
        ...(logo ? { logoArquivo: logo } : {}),
        ...(logo === null ? { removerLogo: true } : {})
      });
    },
    onSuccess: (dados) => {
      queryClient.setQueryData(['empresa'], dados);
      queryClient.invalidateQueries({ queryKey: ['empresa', 'texto-ia'] });
      setSalvo(true);
    }
  });

  // Sair com alteracoes nao salvas: o navegador pergunta antes de fechar a aba.
  useEffect(() => {
    if (!mudou) return undefined;
    const antes = (e) => e.preventDefault();
    window.addEventListener('beforeunload', antes);
    return () => window.removeEventListener('beforeunload', antes);
  }, [mudou]);

  const muda = (caminho, valor) =>
    setF((atual) => {
      const copia = structuredClone(atual);
      const partes = caminho.split('.');
      let alvo = copia;
      partes.slice(0, -1).forEach((p) => (alvo = alvo[p]));
      alvo[partes.at(-1)] = valor;
      return copia;
    });

  // Sempre a partir do estado MAIS NOVO: dois toques rapidos em chips
  // diferentes nao podem um apagar o outro.
  const alternarForma = (forma) =>
    setF((atual) => {
      const formas = atual.pagamento.formas;
      const novas = formas.includes(forma) ? formas.filter((x) => x !== forma) : [...formas, forma];
      return { ...atual, pagamento: { ...atual.pagamento, formas: novas } };
    });

  const erros = salvar.error?.camposComErro ?? {};
  const soLeitura = !podeAcessar('admin');

  return (
    <div className="bc">
      <nav className="bc-secoes" aria-label="Seções da base de conhecimento">
        {SECOES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`bc-secao${secao === s.id ? ' bc-secao--ativa' : ''}`}
            aria-current={secao === s.id ? 'true' : undefined}
            onClick={() => setSecao(s.id)}
          >
            <span className={`bc-secao__marca${preenchida(s.id, f) ? ' bc-secao__marca--ok' : ''}`} aria-hidden="true">
              {preenchida(s.id, f) ? '✓' : ''}
            </span>
            <span className="bc-secao__texto">
              <strong>{s.titulo}</strong>
              <small>{s.dica}</small>
            </span>
          </button>
        ))}
      </nav>

      <section className="ci-bloco bc-conteudo" aria-label={SECOES.find((s) => s.id === secao)?.titulo}>
        <fieldset className="bc-campos" disabled={soLeitura}>
          {secao === 'identidade' && (
            <>
              <Titulo t="Identidade" d="O nome e o logo aparecem no menu do sistema. A apresentação ajuda a Sofia a falar da empresa." />
              <EscolherFoto
                valorAtual={logo === null ? null : inicial.logo}
                rotulo="Logo da empresa"
                aoEscolher={(dataUrl) => reduzirLogo(dataUrl).then(setLogo)}
                aoRemover={() => setLogo(null)}
              />
              <Campo rotulo="Nome da empresa" obrigatorio erro={erros.nome}>
                <Entrada value={f.nome} maxLength={80} onChange={(e) => muda('nome', e.target.value)} />
              </Campo>
              <Campo rotulo="Sobre a empresa" dica="Duas ou três frases: especialidade, estilo, desde quando atende.">
                <AreaTexto
                  rows={4}
                  maxLength={600}
                  value={f.sobre}
                  placeholder="Barbearia clássica no centro da cidade desde 2012, especializada em cortes degradê e barba."
                  onChange={(e) => muda('sobre', e.target.value)}
                />
              </Campo>
            </>
          )}

          {secao === 'endereco' && (
            <>
              <Titulo t="Endereço" d="A Sofia manda estes dados quando o cliente pergunta onde fica." />
              <Campo rotulo="Rua e número">
                <Entrada value={f.endereco.logradouro} placeholder="Rua das Flores, 45 — sala 2" onChange={(e) => muda('endereco.logradouro', e.target.value)} />
              </Campo>
              <div className="bc-dupla">
                <Campo rotulo="Bairro">
                  <Entrada value={f.endereco.bairro} onChange={(e) => muda('endereco.bairro', e.target.value)} />
                </Campo>
                <Campo rotulo="Cidade">
                  <Entrada value={f.endereco.cidade} placeholder="Campinas - SP" onChange={(e) => muda('endereco.cidade', e.target.value)} />
                </Campo>
              </div>
              <Campo rotulo="Ponto de referência">
                <Entrada value={f.endereco.referencia} placeholder="Ao lado da padaria, em frente à praça" onChange={(e) => muda('endereco.referencia', e.target.value)} />
              </Campo>
              <Campo rotulo="Link do mapa" dica="No Google Maps: Compartilhar › Copiar link." erro={erros['endereco.mapaUrl']}>
                <Entrada value={f.endereco.mapaUrl} placeholder="https://maps.app.goo.gl/..." onChange={(e) => muda('endereco.mapaUrl', e.target.value)} />
              </Campo>
              <Campo rotulo="Estacionamento">
                <Entrada value={f.endereco.estacionamento} placeholder="Gratuito em frente / conveniado na rua de trás" onChange={(e) => muda('endereco.estacionamento', e.target.value)} />
              </Campo>
            </>
          )}

          {secao === 'contato' && (
            <>
              <Titulo t="Contato" d="Outros jeitos de falar com a empresa." />
              <div className="bc-dupla">
                <Campo rotulo="Telefone fixo">
                  <Entrada value={f.contato.telefone} onChange={(e) => muda('contato.telefone', e.target.value)} />
                </Campo>
                <Campo rotulo="WhatsApp">
                  <Entrada value={f.contato.whatsapp} onChange={(e) => muda('contato.whatsapp', e.target.value)} />
                </Campo>
              </div>
              <div className="bc-dupla">
                <Campo rotulo="Instagram">
                  <Entrada value={f.contato.instagram} placeholder="@barbearia" onChange={(e) => muda('contato.instagram', e.target.value)} />
                </Campo>
                <Campo rotulo="Site">
                  <Entrada value={f.contato.site} onChange={(e) => muda('contato.site', e.target.value)} />
                </Campo>
              </div>
              <Campo rotulo="E-mail" erro={erros['contato.email']}>
                <Entrada type="email" value={f.contato.email} onChange={(e) => muda('contato.email', e.target.value)} />
              </Campo>
            </>
          )}

          {secao === 'pagamento' && (
            <>
              <Titulo t="Pagamento" d="Com o Pix aqui, a Sofia passa a chave certa — sem ninguém digitar na hora." />
              <div className="bc-pix">
                <Campo rotulo="Tipo da chave Pix">
                  <Selecao value={f.pagamento.pix.tipo} onChange={(e) => muda('pagamento.pix.tipo', e.target.value)}>
                    {TIPOS_PIX.map(([v, r]) => (
                      <option key={v} value={v}>
                        {r}
                      </option>
                    ))}
                  </Selecao>
                </Campo>
                <Campo rotulo="Chave Pix">
                  <Entrada value={f.pagamento.pix.chave} onChange={(e) => muda('pagamento.pix.chave', e.target.value)} />
                </Campo>
              </div>
              <div className="bc-dupla">
                <Campo rotulo="Nome do titular" dica="O que aparece para o cliente conferir antes de pagar.">
                  <Entrada value={f.pagamento.pix.titular} onChange={(e) => muda('pagamento.pix.titular', e.target.value)} />
                </Campo>
                <Campo rotulo="Banco">
                  <Entrada value={f.pagamento.pix.banco} onChange={(e) => muda('pagamento.pix.banco', e.target.value)} />
                </Campo>
              </div>
              <Campo rotulo="Formas de pagamento aceitas">
                <div className="bc-chips">
                  {FORMAS.map((forma) => {
                    const ativa = f.pagamento.formas.includes(forma);
                    return (
                      <button
                        key={forma}
                        type="button"
                        aria-pressed={ativa}
                        className={`eq-chip${ativa ? ' eq-chip--ativo' : ''}`}
                        onClick={() => alternarForma(forma)}
                      >
                        {ativa ? '✓ ' : ''}
                        {forma}
                      </button>
                    );
                  })}
                </div>
              </Campo>
              <Campo rotulo="Observação">
                <Entrada value={f.pagamento.observacao} placeholder="Parcelamos em até 2x sem juros acima de R$ 100" onChange={(e) => muda('pagamento.observacao', e.target.value)} />
              </Campo>
            </>
          )}

          {secao === 'horario' && (
            <Horario horario={f.horario} aoMudar={(h) => muda('horario', h)} />
          )}

          {secao === 'politicas' && (
            <>
              <Titulo t="Regras da casa" d="Tolerância de atraso, cancelamento, remarcação, crianças, animais... Uma regra por linha." />
              <AreaTexto
                rows={10}
                maxLength={1500}
                value={f.politicas}
                placeholder={'Tolerância de 10 minutos de atraso.\nCancelamentos com pelo menos 2 horas de antecedência.\nCrianças até 12 anos só acompanhadas.'}
                onChange={(e) => muda('politicas', e.target.value)}
              />
            </>
          )}

          {secao === 'faq' && <Perguntas faq={f.faq} aoMudar={(v) => muda('faq', v)} />}

          {secao === 'extras' && (
            <>
              <Titulo t="Outras informações" d="Qualquer coisa que a Sofia deve saber e não coube acima: promoções fixas, Wi-Fi, acessibilidade, etc." />
              <AreaTexto
                rows={10}
                maxLength={2000}
                value={f.extras}
                placeholder={'Temos Wi-Fi grátis para clientes.\nEspaço acessível para cadeirantes.\nÀs terças, corte + barba com 10% de desconto.'}
                onChange={(e) => muda('extras', e.target.value)}
              />
            </>
          )}
        </fieldset>

        {salvar.isError && salvar.error.codigo !== 'VALIDACAO' && <Aviso tom="perigo">{salvar.error.message}</Aviso>}
        {salvar.isError && salvar.error.codigo === 'VALIDACAO' && (
          <Aviso tom="perigo">Há campos com problema: {Object.values(erros).join(' ')}</Aviso>
        )}

        {!soLeitura && (
          <div className={`cx-salvar${mudou || salvar.isPending ? ' cx-salvar--pendente' : ''}`}>
            <span className="cx-salvo crescer" role="status">
              {mudou ? 'Você tem alterações não salvas.' : salvo ? '✓ Base de conhecimento salva. A Sofia já está usando.' : ''}
            </span>
            {mudou && (
              <>
                <Botao
                  variante="fantasma"
                  tamanho="sm"
                  disabled={salvar.isPending}
                  onClick={() => {
                    setF(structuredClone(inicial));
                    setLogo(undefined);
                  }}
                >
                  Descartar
                </Botao>
                <Botao tamanho="sm" carregando={salvar.isPending} disabled={!f.nome?.trim()} onClick={() => salvar.mutate()}>
                  Salvar
                </Botao>
              </>
            )}
          </div>
        )}
      </section>

      <aside className="ci-bloco bc-previa" aria-label="O que a Sofia sabe">
        <h3 className="bc-previa__titulo">
          <span className="bc-previa__ponto" aria-hidden="true" /> O que a Sofia sabe
        </h3>
        <p className="texto-fraco bc-previa__dica">
          Exatamente o texto que ela recebe em cada conversa. O que estiver vazio ela não sabe — e não inventa.
        </p>
        {textoIa.isLoading ? (
          <Carregando />
        ) : textoIa.data?.texto ? (
          <pre className="bc-previa__texto">{textoIa.data.texto}</pre>
        ) : (
          <p className="bc-previa__vazio">Nada cadastrado ainda. Preencha as seções ao lado e salve.</p>
        )}
        {mudou && <p className="bc-previa__pendente">Atualiza quando você salvar.</p>}
      </aside>
    </div>
  );
}

function Titulo({ t, d }) {
  return (
    <header className="bc-titulo">
      <h2>{t}</h2>
      <p className="texto-fraco">{d}</p>
    </header>
  );
}

function Horario({ horario, aoMudar }) {
  const dias = horario.dias;

  function mudarDia(d, faixa) {
    const novos = { ...dias };
    if (faixa) novos[d] = [faixa];
    else delete novos[d];
    aoMudar({ ...horario, dias: novos });
  }

  // Repete o horario de segunda nos outros dias uteis: o caso mais comum.
  function copiarSegunda() {
    const base = dias[1]?.[0];
    if (!base) return;
    const novos = { ...dias };
    for (const d of ['2', '3', '4', '5']) novos[d] = [{ ...base }];
    aoMudar({ ...horario, dias: novos });
  }

  return (
    <>
      <Titulo t="Horário de funcionamento" d="Quando a empresa abre. (A agenda de cada profissional continua na ficha dele, em Equipe.)" />
      <div className="bc-horario">
        {DIAS.map(([d, nome]) => {
          const faixa = dias[d]?.[0];
          return (
            <div key={d} className={`bc-dia${faixa ? '' : ' bc-dia--fechado'}`}>
              <label className="bc-dia__nome">
                <input
                  type="checkbox"
                  checked={Boolean(faixa)}
                  onChange={(e) => mudarDia(d, e.target.checked ? { inicio: '09:00', fim: '18:00' } : null)}
                />
                {nome}
              </label>
              {faixa ? (
                <span className="bc-dia__horas">
                  <Entrada type="time" value={faixa.inicio} aria-label={`${nome}: abre`} onChange={(e) => mudarDia(d, { ...faixa, inicio: e.target.value })} />
                  <span className="texto-fraco">às</span>
                  <Entrada type="time" value={faixa.fim} aria-label={`${nome}: fecha`} onChange={(e) => mudarDia(d, { ...faixa, fim: e.target.value })} />
                </span>
              ) : (
                <span className="texto-fraco">Fechado</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="linha">
        <Botao variante="fantasma" tamanho="sm" disabled={!dias[1]} onClick={copiarSegunda}>
          Repetir o horário de segunda até sexta
        </Botao>
      </div>
      <Campo rotulo="Feriados e exceções">
        <Entrada
          value={horario.observacao}
          placeholder="Fechado em feriados nacionais. Véspera de Natal até 14h."
          onChange={(e) => aoMudar({ ...horario, observacao: e.target.value })}
        />
      </Campo>
    </>
  );
}

function Perguntas({ faq, aoMudar }) {
  const mudar = (i, campo, valor) => aoMudar(faq.map((q, j) => (j === i ? { ...q, [campo]: valor } : q)));

  return (
    <>
      <Titulo t="Perguntas frequentes" d="Pergunta e a resposta oficial. A Sofia usa a resposta com as palavras dela." />
      {faq.length === 0 && <p className="texto-fraco">Nenhuma pergunta ainda.</p>}
      <ol className="bc-faq">
        {faq.map((q, i) => (
          <li key={i} className="bc-faq__item">
            <span className="bc-faq__num">{i + 1}</span>
            <div className="bc-faq__campos">
              <Entrada value={q.pergunta} maxLength={200} placeholder="Vocês atendem criança?" aria-label={`Pergunta ${i + 1}`} onChange={(e) => mudar(i, 'pergunta', e.target.value)} />
              <AreaTexto rows={2} maxLength={800} value={q.resposta} placeholder="Sim, a partir de 3 anos, com um responsável." aria-label={`Resposta ${i + 1}`} onChange={(e) => mudar(i, 'resposta', e.target.value)} />
            </div>
            <button type="button" className="bc-faq__tirar" aria-label={`Tirar a pergunta ${i + 1}`} onClick={() => aoMudar(faq.filter((_, j) => j !== i))}>
              ×
            </button>
          </li>
        ))}
      </ol>
      <div className="linha">
        <Botao variante="secundario" tamanho="sm" disabled={faq.length >= 30} onClick={() => aoMudar([...faq, { pergunta: '', resposta: '' }])}>
          + Adicionar pergunta
        </Botao>
      </div>
    </>
  );
}

/**
 * Reduz o logo para no maximo 512 px antes de enviar, mantendo a
 * transparencia (sai em PNG). Um logo de 6000 px pesava megabytes em toda
 * tela que mostra o menu — e o menu mostra em 32 px.
 */
function reduzirLogo(dataUrl, maximo = 512) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, maximo / Math.max(img.width, img.height));
      if (escala === 1 && dataUrl.startsWith('data:image/png')) return resolve(dataUrl);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * escala);
      canvas.height = Math.round(img.height * escala);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    // Nao deu para ler no navegador: manda o original (o servidor confere).
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
