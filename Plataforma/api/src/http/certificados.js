import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, createPrivateKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

/**
 * Certificados HTTPS da LOJA, feitos aqui mesmo (sem dependencia nova).
 *
 * O Node gera chaves e assina, mas nao tem API para MONTAR um certificado
 * X.509. Montamos em DER (ASN.1) a mao — sao poucas estruturas fixas — e
 * conferimos o resultado com o proprio Node (X509Certificate) e com um
 * handshake TLS de verdade nos testes.
 *
 * Duas pecas:
 *   AUTORIDADE — gerada uma vez por instalacao; e ela que cada aparelho
 *   instala ("confiar nesta loja"). 10 anos.
 *   SERVIDOR — o certificado que a API apresenta, assinado pela autoridade,
 *   valido para localhost, 127.0.0.1, o nome do computador e os IPs locais.
 *   396 dias (+1 de folga no inicio = 397; o iPhone recusa mais de 398) e refeito sozinho quando o IP
 *   muda ou faltam menos de 30 dias — os aparelhos nao percebem, porque
 *   confiam na autoridade, nao no certificado.
 *
 * SEGURANCA: a autoridade tem "name constraints" — so pode assinar para
 * localhost, o nome deste computador e IPs de rede LOCAL (10/8, 172.16/12,
 * 192.168/16, 127/8). Um celular que confia nela nao passa a confiar num
 * certificado falso de banco ou do Google feito com a chave dela, caso a chave
 * vaze. A chave fica so em api/data/https (fora do git e fora dos aparelhos).
 */

const DIA = 86_400_000;
export const VALIDADE_AUTORIDADE_DIAS = 3650;
export const VALIDADE_SERVIDOR_DIAS = 396;
export const RENOVAR_SE_FALTAREM_DIAS = 30;
const REDES_LOCAIS = [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16]
];

// ─── DER (ASN.1) minimo ──────────────────────────────────────────────────

function tamanho(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...partes) => {
  const conteudo = Buffer.concat(partes);
  return Buffer.concat([Buffer.from([tag]), tamanho(conteudo.length), conteudo]);
};
const seq = (...p) => tlv(0x30, ...p);
const conjunto = (...p) => tlv(0x31, ...p);
const octetos = (b) => tlv(0x04, b);
const booleano = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const bits = (b, sobra = 0) => tlv(0x03, Buffer.from([sobra]), b);
const explicito = (n, conteudo) => tlv(0xa0 + n, conteudo);
const utf8 = (s) => tlv(0x0c, Buffer.from(String(s), 'utf8'));

function inteiro(bytes) {
  let b = Buffer.from(bytes);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); // sempre positivo
  return tlv(0x02, b);
}

function oid(texto) {
  const p = texto.split('.').map(Number);
  const bytes = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) {
    const pedacos = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) pedacos.unshift((v & 0x7f) | 0x80);
    bytes.push(...pedacos);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime ate 2049; GeneralizedTime depois (regra do X.509). */
function tempo(data) {
  const d = new Date(data);
  const dois = (n) => String(n).padStart(2, '0');
  const resto = `${dois(d.getUTCMonth() + 1)}${dois(d.getUTCDate())}${dois(d.getUTCHours())}${dois(d.getUTCMinutes())}${dois(d.getUTCSeconds())}Z`;
  return d.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${String(d.getUTCFullYear()).slice(2)}${resto}`))
    : tlv(0x18, Buffer.from(`${d.getUTCFullYear()}${resto}`));
}

const ipEmBytes = (ip) => Buffer.from(ip.split('.').map(Number));
const mascara = (bitsDaRede) => Buffer.from([0, 1, 2, 3].map((i) => (0xff << (8 - Math.min(8, Math.max(0, bitsDaRede - 8 * i)))) & 0xff));

/**
 * O IP esta numa rede LOCAL (as que a autoridade pode assinar)? IP de fora
 * (VPN, internet) no certificado faria o aparelho recusar o certificado
 * INTEIRO por causa das name constraints — entao ele simplesmente nao entra.
 */
export function ipDeRedeLocal(ip) {
  if (isIP(ip) !== 4) return false;
  const n = ipEmBytes(ip).readUInt32BE(0);
  return REDES_LOCAIS.some(([rede, tam]) => {
    const m = tam === 0 ? 0 : (0xffffffff << (32 - tam)) >>> 0;
    return (n & m) >>> 0 === (ipEmBytes(rede).readUInt32BE(0) & m) >>> 0;
  });
}

const nome = (comum) => seq(conjunto(seq(oid('2.5.4.3'), utf8(comum))), conjunto(seq(oid('2.5.4.10'), utf8('Plataforma de Atendimento'))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const extensao = (id, critica, valor) => seq(oid(id), ...(critica ? [booleano(true)] : []), octetos(valor));

/** Identificador da chave: SHA-1 dos bits da chave publica (o costume do X.509). */
function idDaChave(spkiDer) {
  const x = new X509ChaveSpki(spkiDer);
  return createHash('sha1').update(x.bitsDaChave).digest();
}

/** Le o BIT STRING da chave publica dentro do SubjectPublicKeyInfo (DER). */
class X509ChaveSpki {
  constructor(der) {
    // SEQUENCE { SEQUENCE algId, BIT STRING chave } — pula o algId e o byte de "bits sobrando".
    let i = 0;
    const lerTamanho = () => {
      let n = der[i++];
      if (n & 0x80) {
        let qtd = n & 0x7f;
        n = 0;
        while (qtd--) n = n * 256 + der[i++];
      }
      return n;
    };
    i++; // 0x30
    lerTamanho();
    i++; // 0x30 algId
    i += lerTamanho();
    i++; // 0x03
    const n = lerTamanho();
    this.bitsDaChave = der.subarray(i + 1, i + n);
  }
}

function montar({ assunto, emissor, spki, chaveDoEmissor, idDoEmissor, dias, extensoes }) {
  const agora = Date.now();
  const numero = randomBytes(16);
  numero[0] &= 0x7f;
  const tbs = seq(
    explicito(0, inteiro([2])), // X.509 v3
    inteiro(numero),
    ECDSA_SHA256,
    emissor,
    seq(tempo(agora - DIA), tempo(agora + dias * DIA)), // um dia antes: relogio do celular adiantado
    assunto,
    spki,
    explicito(
      3,
      seq(
        ...extensoes,
        extensao('2.5.29.14', false, octetos(idDaChave(spki))),
        extensao('2.5.29.35', false, seq(tlv(0x80, idDoEmissor ?? idDaChave(spki))))
      )
    )
  );
  const assinatura = sign('sha256', tbs, chaveDoEmissor); // ECDSA em DER, como o X.509 pede
  return seq(tbs, ECDSA_SHA256, bits(assinatura));
}

const pem = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
const parDeChaves = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

/** Nomes que a autoridade pode assinar: localhost e o nome deste computador. */
export function nomesPermitidos(computador) {
  const c = String(computador).toLowerCase();
  return [...new Set(['localhost', c, `${c}.local`])];
}

/**
 * A autoridade desta instalacao.
 * @param {{ computador: string }} p
 * @returns {{ chave: string, cert: string, der: Buffer }}
 */
export function gerarAutoridade({ computador }) {
  const { privateKey, publicKey } = parDeChaves();
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const assunto = nome(`Plataforma - ${computador} (autoridade local)`);
  const permitidos = explicito(
    0,
    Buffer.concat([
      ...nomesPermitidos(computador).map((n) => seq(tlv(0x82, Buffer.from(n, 'ascii')))),
      ...REDES_LOCAIS.map(([rede, tam]) => seq(tlv(0x87, Buffer.concat([ipEmBytes(rede), mascara(tam)]))))
    ])
  );
  const der = montar({
    assunto,
    emissor: assunto,
    spki,
    chaveDoEmissor: privateKey,
    dias: VALIDADE_AUTORIDADE_DIAS,
    extensoes: [
      extensao('2.5.29.19', true, seq(booleano(true), inteiro([0]))), // e autoridade; nao cria outras
      extensao('2.5.29.15', true, bits(Buffer.from([0x86]), 1)), // assinar certificados e listas + assinatura
      extensao('2.5.29.30', true, seq(permitidos)) // name constraints (ver o topo)
    ]
  });
  return { chave: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem(der), der };
}

/**
 * O certificado do servidor, assinado pela autoridade.
 * @param {{ chave: string, cert: string }} autoridade
 * @param {{ computador: string, ips: string[] }} p
 */
export function gerarCertificadoServidor(autoridade, { computador, ips }) {
  const { privateKey, publicKey } = parDeChaves();
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const ca = new X509Certificate(autoridade.cert);
  const spkiDaAutoridade = ca.publicKey.export({ type: 'spki', format: 'der' });
  const ipv4 = [...new Set(['127.0.0.1', ...ips])].filter(ipDeRedeLocal);

  const der = montar({
    assunto: nome(computador),
    emissor: nomeDaAutoridade(ca),
    spki,
    chaveDoEmissor: createPrivateKey(autoridade.chave),
    idDoEmissor: idDaChave(spkiDaAutoridade),
    dias: VALIDADE_SERVIDOR_DIAS,
    extensoes: [
      extensao('2.5.29.19', true, seq()), // nao e autoridade
      extensao('2.5.29.15', true, bits(Buffer.from([0x80]), 7)), // so assinatura digital (ECDSA)
      extensao('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // servidor TLS
      extensao(
        '2.5.29.17',
        false,
        seq(...nomesPermitidos(computador).map((n) => tlv(0x82, Buffer.from(n, 'ascii'))), ...ipv4.map((ip) => tlv(0x87, ipEmBytes(ip))))
      )
    ]
  });
  return { chave: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem(der) };
}

/**
 * O "emissor" do servidor tem de ser, BYTE A BYTE, o "assunto" da autoridade.
 * Como a autoridade foi montada aqui, o assunto dela e o nome que `nome()` gera
 * com o CN dela — reconstruido a partir do texto que o Node le.
 */
function nomeDaAutoridade(ca) {
  const cn = /CN=([^\n]+)/.exec(ca.subject)?.[1];
  return nome(cn);
}

// ─── Em disco: api/data/https ─────────────────────────────────────────────

const ARQUIVOS = {
  chaveAutoridade: 'autoridade.key.pem',
  autoridade: 'autoridade.crt.pem',
  autoridadeDer: 'autoridade.crt',
  chaveServidor: 'servidor.key.pem',
  servidor: 'servidor.crt.pem'
};

/** O certificado atual do servidor ainda serve para estes nomes/IPs, esta assinado por esta autoridade e nao esta perto de vencer? */
function servidorEmDia(certPem, autoridadePem, { computador, ips }) {
  try {
    const cert = new X509Certificate(certPem);
    const ca = new X509Certificate(autoridadePem);
    if (!cert.checkIssued(ca) || !cert.verify(ca.publicKey)) return false;
    if (Date.parse(cert.validTo) - Date.now() < RENOVAR_SE_FALTAREM_DIAS * DIA) return false;
    const san = cert.subjectAltName ?? '';
    const precisa = [
      ...nomesPermitidos(computador).map((n) => `DNS:${n}`),
      ...['127.0.0.1', ...ips].filter(ipDeRedeLocal).map((ip) => `IP Address:${ip}`)
    ];
    return precisa.every((item) => san.split(', ').includes(item));
  } catch {
    return false;
  }
}

/** A autoridade atual ainda cobre o nome deste computador (as "name constraints")? */
function autoridadeServe(autoridadePem, computador) {
  try {
    const ca = new X509Certificate(autoridadePem);
    return ca.ca && ca.subject.includes(`Plataforma - ${computador} (autoridade local)`) && Date.parse(ca.validTo) > Date.now() + 90 * DIA;
  } catch {
    return false;
  }
}

/**
 * Garante os certificados em `pasta` e devolve o que a API precisa.
 *
 * A autoridade so e refeita se nao existir, estiver para vencer ou o nome do
 * computador mudar (as name constraints dela citam o nome) — nesse caso os
 * aparelhos precisam instalar de novo (`autoridadeNova: true`). O certificado
 * do servidor e refeito sempre que os IPs mudam; ninguem precisa fazer nada.
 *
 * @param {{ pasta: string, computador: string, ips: string[] }} p
 */
export function prepararCertificados({ pasta, computador, ips }) {
  mkdirSync(pasta, { recursive: true });
  const caminho = (k) => join(pasta, ARQUIVOS[k]);
  const ler = (k) => (existsSync(caminho(k)) ? readFileSync(caminho(k), 'utf8') : null);

  let autoridade = { chave: ler('chaveAutoridade'), cert: ler('autoridade') };
  let autoridadeNova = false;
  if (!autoridade.chave || !autoridade.cert || !autoridadeServe(autoridade.cert, computador)) {
    autoridade = gerarAutoridade({ computador });
    writeFileSync(caminho('chaveAutoridade'), autoridade.chave, { mode: 0o600 });
    writeFileSync(caminho('autoridade'), autoridade.cert);
    writeFileSync(caminho('autoridadeDer'), autoridade.der);
    autoridadeNova = true;
  }
  if (!existsSync(caminho('autoridadeDer'))) writeFileSync(caminho('autoridadeDer'), new X509Certificate(autoridade.cert).raw);

  let servidor = { chave: ler('chaveServidor'), cert: ler('servidor') };
  let servidorNovo = false;
  if (!servidor.chave || !servidor.cert || !servidorEmDia(servidor.cert, autoridade.cert, { computador, ips })) {
    servidor = gerarCertificadoServidor(autoridade, { computador, ips });
    writeFileSync(caminho('chaveServidor'), servidor.chave, { mode: 0o600 });
    writeFileSync(caminho('servidor'), servidor.cert);
    servidorNovo = true;
  }

  return {
    chave: servidor.chave,
    cert: servidor.cert,
    autoridadePem: autoridade.cert,
    autoridadeDer: readFileSync(caminho('autoridadeDer')),
    autoridadeNova,
    servidorNovo
  };
}
