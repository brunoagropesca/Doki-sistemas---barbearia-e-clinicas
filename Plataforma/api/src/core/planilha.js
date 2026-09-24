import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Planilha do Excel (.xlsx) sem dependencia nenhuma.
 *
 * Um .xlsx e um ZIP com alguns XMLs dentro. Montamos os XMLs a mao (so o que
 * o Excel, o Google Planilhas e o LibreOffice exigem) e o ZIP com o zlib do
 * proprio Node. Uma biblioteca de planilha inteira para exportar tabelas seria
 * peso morto na instalacao.
 *
 * Uso:
 *   gerarXlsx([{
 *     nome: 'Servicos',
 *     antes: ['Periodo: 01/09/2026 a 24/09/2026'],   // linhas de texto acima da tabela (opcional)
 *     colunas: [{ titulo: 'Servico', largura: 30 }, { titulo: 'Faturamento', formato: 'reais' }],
 *     linhas: [['Corte', 1234.5]]
 *   }])  ->  Buffer
 *
 * Formatos: 'texto' (padrao), 'inteiro', 'decimal', 'reais' (valor em reais),
 * 'porcento' (0 a 100, como o dashboard usa), 'data' ('AAAA-MM-DD').
 * Uma celula pode trazer o proprio formato: { v: 12.5, formato: 'reais' }
 * (coluna que mistura dinheiro, quantidade e taxa, como um resumo).
 */

// Indice de cada formato em <cellXfs> de styles.xml (a ordem la embaixo).
const ESTILO = { texto: 0, cabecalho: 1, inteiro: 2, reais: 3, decimal: 4, porcento: 5, data: 6, titulo: 7 };

// Caracteres que o XML nao aceita nem escapados (controle, exceto tab e quebras).
// eslint-disable-next-line no-control-regex
const INVALIDOS_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

const xml = (s) =>
  String(s)
    .replace(INVALIDOS_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 0 -> A, 25 -> Z, 26 -> AA. */
function letra(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Data do Excel: dias desde 30/12/1899 (o "bug de 1900" do Lotus ja embutido). */
function serialDeData(iso) {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms / 86_400_000 + 25_569;
}

/** Nome de aba valido: ate 31 caracteres, sem : \ / ? * [ ], sem repetir. */
function nomesDeAba(abas) {
  const usados = new Set();
  return abas.map((a) => {
    const base = String(a.nome).replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Planilha';
    let nome = base;
    for (let i = 2; usados.has(nome.toLowerCase()); i++) nome = `${base.slice(0, 28)} ${i}`;
    usados.add(nome.toLowerCase());
    return nome;
  });
}

const valorDe = (x) => (x !== null && typeof x === 'object' ? x.v : x);

function celula(ref, bruto, formatoDaColuna, estiloForcado) {
  const valor = valorDe(bruto);
  const formato = (bruto !== null && typeof bruto === 'object' && bruto.formato) || formatoDaColuna;
  if (valor === null || valor === undefined || valor === '') return '';
  if (formato === 'data') {
    const serial = serialDeData(valor);
    if (serial !== null) return `<c r="${ref}" s="${ESTILO.data}"><v>${serial}</v></c>`;
  }
  if (typeof valor === 'number' && Number.isFinite(valor) && formato && formato !== 'texto') {
    const v = formato === 'porcento' ? valor / 100 : valor;
    return `<c r="${ref}" s="${ESTILO[formato] ?? 0}"><v>${v}</v></c>`;
  }
  const s = estiloForcado ?? ESTILO.texto;
  return `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t xml:space="preserve">${xml(valor)}</t></is></c>`;
}

function xmlDaAba({ antes = [], colunas, linhas }) {
  const partes = [];
  let r = 0;

  // Linhas de contexto acima da tabela (a 1a em destaque).
  antes.forEach((texto, i) => {
    r++;
    partes.push(`<row r="${r}">${celula(`A${r}`, texto, 'texto', i === 0 ? ESTILO.titulo : ESTILO.texto)}</row>`);
  });
  if (antes.length) r++; // uma linha em branco antes da tabela

  const linhaCabecalho = ++r;
  partes.push(`<row r="${r}">${colunas.map((c, i) => celula(`${letra(i)}${r}`, c.titulo, 'texto', ESTILO.cabecalho)).join('')}</row>`);
  for (const linha of linhas) {
    r++;
    partes.push(`<row r="${r}">${colunas.map((c, i) => celula(`${letra(i)}${r}`, linha[i], c.formato)).join('')}</row>`);
  }

  const ultimaColuna = letra(Math.max(0, colunas.length - 1));
  const larguras = colunas
    .map((c, i) => {
      // Sem largura dada: pelo maior texto da coluna (entre 10 e 50).
      const maior = Math.max(String(c.titulo).length, ...linhas.map((l) => String(valorDe(l[i]) ?? '').length));
      const w = c.largura ?? Math.min(50, Math.max(10, maior + 2));
      return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
    })
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    // Cabecalho da tabela congelado: rola os dados, o titulo das colunas fica.
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${linhaCabecalho}" topLeftCell="A${linhaCabecalho + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${larguras}</cols>` +
    `<sheetData>${partes.join('')}</sheetData>` +
    (linhas.length ? `<autoFilter ref="A${linhaCabecalho}:${ultimaColuna}${r}"/>` : '') +
    '</worksheet>'
  );
}

const ESTILOS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="4">' +
  '<numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00"/>' +
  '<numFmt numFmtId="165" formatCode="#,##0.0"/>' +
  '<numFmt numFmtId="166" formatCode="0.0%"/>' +
  '<numFmt numFmtId="167" formatCode="dd/mm/yyyy"/>' +
  '</numFmts>' +
  '<fonts count="3">' +
  '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="13"/><name val="Calibri"/><family val="2"/></font>' +
  '</fonts>' +
  '<fills count="3">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF1C4FD8"/><bgColor indexed="64"/></patternFill></fill>' +
  '</fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="8">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // texto
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' + // cabecalho
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // inteiro
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // reais
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // decimal
  '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // porcento
  '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // data
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' + // titulo
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** As abas -> Buffer do .xlsx. */
export function gerarXlsx(abas) {
  const nomes = nomesDeAba(abas);
  const arquivos = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        abas.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>'
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'
    ],
    [
      'xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${nomes.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
        // O filtro de cada aba precisa deste nome definido para o Excel nao "reparar" o arquivo.
        `<definedNames>${abas
          .map((a, i) => {
            if (!a.linhas.length) return '';
            const cab = (a.antes?.length ? a.antes.length + 1 : 0) + 1;
            const fim = cab + a.linhas.length;
            const nome = `'${nomes[i].replace(/'/g, "''")}'`;
            return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xml(`${nome}!$A$${cab}:$${letra(a.colunas.length - 1)}$${fim}`)}</definedName>`;
          })
          .join('')}</definedNames>` +
        '</workbook>'
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        abas.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${abas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>'
    ],
    ['xl/styles.xml', ESTILOS],
    ...abas.map((a, i) => [`xl/worksheets/sheet${i + 1}.xml`, xmlDaAba(a)])
  ];
  return zip(arquivos.map(([nome, conteudo]) => [nome, Buffer.from(conteudo, 'utf8')]));
}

// ─── ZIP (o minimo do formato: arquivos comprimidos + diretorio central) ────

function zip(arquivos) {
  const agora = new Date();
  const hora = (agora.getHours() << 11) | (agora.getMinutes() << 5) | Math.floor(agora.getSeconds() / 2);
  const data = ((agora.getFullYear() - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate();

  const locais = [];
  const centrais = [];
  let deslocamento = 0;
  for (const [nome, dados] of arquivos) {
    const nomeBuf = Buffer.from(nome, 'utf8');
    const comprimido = deflateRawSync(dados);
    const crc = crc32(dados) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versao minima
    local.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(data, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nomeBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locais.push(local, nomeBuf, comprimido);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(data, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(dados.length, 24);
    central.writeUInt16LE(nomeBuf.length, 28);
    central.writeUInt32LE(deslocamento, 42);
    centrais.push(central, nomeBuf);

    deslocamento += local.length + nomeBuf.length + comprimido.length;
  }

  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...locais, diretorio, fim]);
}
