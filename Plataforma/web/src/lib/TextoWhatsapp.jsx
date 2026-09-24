/**
 * Renderiza a formatacao do WhatsApp: *negrito*, _italico_ e ~riscado~.
 *
 * As respostas do sistema usam essa marcacao (`*R$ 45,00*`) porque e o que o
 * WhatsApp do cliente vai exibir formatado. Nas nossas telas, sem isto, quem
 * atende veria os asteriscos crus e nao saberia como a mensagem chega la.
 *
 * Feito com elementos React (e nao com HTML injetado): o texto vem de clientes,
 * e injetar HTML de terceiros na pagina seria abrir uma porta para XSS.
 *
 * Como no proprio WhatsApp, a marcacao so vale quando encostada em espaco ou
 * pontuacao: `listar_servicos_agora` nao vira italico no meio.
 */

const MARCAS = /((?<![\w*])\*[^*\n]+\*(?![\w*])|(?<![\w_])_[^_\n]+_(?![\w_])|(?<![\w~])~[^~\n]+~(?![\w~]))/g;

export function TextoWhatsapp({ texto }) {
  const partes = String(texto ?? '').split(MARCAS);

  return partes.map((parte, i) => {
    if (parte.length > 2) {
      const miolo = parte.slice(1, -1);
      if (parte.startsWith('*') && parte.endsWith('*')) return <strong key={i}>{miolo}</strong>;
      if (parte.startsWith('_') && parte.endsWith('_')) return <em key={i}>{miolo}</em>;
      if (parte.startsWith('~') && parte.endsWith('~')) return <s key={i}>{miolo}</s>;
    }
    return parte;
  });
}
