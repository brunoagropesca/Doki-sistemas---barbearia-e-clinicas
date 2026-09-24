import { useRef, useState } from 'react';
import { Aviso, Botao } from '../../componentes/ui.jsx';

/**
 * Campo de foto.
 *
 * O arquivo e lido no NAVEGADOR e enviado como data URL dentro do JSON. O
 * servidor grava em disco e guarda so o caminho. Isso evita multipart no
 * servidor para resolver algo que o navegador ja faz com FileReader.
 *
 * O limite de 3 MB e conferido aqui tambem, e nao so no servidor: avisar antes
 * de subir tres megabytes por uma conexao de celular e mais gentil do que
 * recusar depois.
 */

const LIMITE_BYTES = 3 * 1024 * 1024;
const ACEITOS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function EscolherFoto({ valorAtual, aoEscolher, aoRemover, rotulo = 'Foto' }) {
  const entradaRef = useRef(null);
  const [previa, setPrevia] = useState(null);
  const [erro, setErro] = useState(null);

  const mostrando = previa ?? valorAtual ?? null;

  function ler(arquivo) {
    setErro(null);
    if (!arquivo) return;

    if (!ACEITOS.includes(arquivo.type)) {
      setErro('Use uma imagem PNG, JPG, WEBP ou GIF.');
      return;
    }
    if (arquivo.size > LIMITE_BYTES) {
      setErro(`A imagem tem ${(arquivo.size / 1024 / 1024).toFixed(1)} MB. O limite e 3 MB.`);
      return;
    }

    const leitor = new FileReader();
    leitor.onload = () => {
      setPrevia(leitor.result);
      aoEscolher(leitor.result);
    };
    leitor.onerror = () => setErro('Nao consegui ler este arquivo.');
    leitor.readAsDataURL(arquivo);
  }

  return (
    <div className="foto-campo">
      <div className="foto-campo__previa">
        {mostrando ? (
          <img src={mostrando} alt={rotulo} />
        ) : (
          <span className="texto-fraco" aria-hidden="true">
            sem foto
          </span>
        )}
      </div>

      <div className="coluna" style={{ gap: 'var(--e2)' }}>
        <input
          ref={entradaRef}
          type="file"
          accept={ACEITOS.join(',')}
          style={{ display: 'none' }}
          onChange={(e) => ler(e.target.files?.[0])}
        />
        <div className="linha" style={{ gap: 'var(--e2)' }}>
          <Botao type="button" variante="secundario" tamanho="sm" onClick={() => entradaRef.current?.click()}>
            {mostrando ? 'Trocar foto' : 'Escolher foto'}
          </Botao>
          {mostrando && (
            <Botao
              type="button"
              variante="fantasma"
              tamanho="sm"
              onClick={() => {
                setPrevia(null);
                setErro(null);
                if (entradaRef.current) entradaRef.current.value = '';
                aoRemover?.();
              }}
            >
              Remover
            </Botao>
          )}
        </div>
        <span className="texto-fraco">PNG, JPG, WEBP ou GIF, ate 3 MB.</span>
        {erro && <Aviso tom="perigo">{erro}</Aviso>}
      </div>
    </div>
  );
}
