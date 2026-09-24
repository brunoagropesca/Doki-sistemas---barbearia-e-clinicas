import { useState } from 'react';

/**
 * Painel de emojis do livechat, no jeito do WhatsApp: abas por categoria,
 * "Recentes" primeiro, e fica aberto enquanto se escolhe varios.
 *
 * Lista propria em vez de biblioteca: o atendimento usa um punhado de emojis,
 * e uma biblioteca completa pesaria mais que a tela de conversas inteira.
 */

const CATEGORIAS = [
  {
    chave: 'rostos',
    icone: '😀',
    rotulo: 'Rostos',
    emojis: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👻 💀 🤖 😺 😸 😹 😻'.split(' ')
  },
  {
    chave: 'gestos',
    icone: '👍',
    rotulo: 'Gestos e pessoas',
    emojis: '👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 👏 🙌 👐 🤲 💪 ✍️ 💅 🤳 👀 👁️ 👄 🧠 🙋 🙋‍♂️ 🙋‍♀️ 🙆 🙅 🤷 🤷‍♂️ 🤷‍♀️ 🤦 💁 🙇 💇 💇‍♂️ 💇‍♀️ 💆 💆‍♂️ 🧔 👨 👩 🧑 👦 👧 👶 👴 👵 🕺 💃 🏃 🚶'.split(' ')
  },
  {
    chave: 'coracoes',
    icone: '❤️',
    rotulo: 'Corações',
    emojis: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💋 💌 🫶 😍 🥰 😘 💐 🌹 🌷 🌸'.split(' ')
  },
  {
    chave: 'objetos',
    icone: '✂️',
    rotulo: 'Barbearia e objetos',
    emojis: '✂️ 💈 🪒 🧴 🧼 🪮 💇 💇‍♂️ 💅 💄 🪞 🛁 🚿 💆 🧖 💎 👑 🎩 🧢 👔 👕 👖 👟 👞 🕶️ ⌚ 📱 💻 📞 ☎️ 📷 📸 🎥 📅 📆 🗓️ ⏰ ⏱️ ⌛ ⏳ 📍 🗺️ 🏠 🏪 🚗 🏍️ 🚕 🚌 💳 💵 💰 🧾 🎁 🎉 🎊 🎈 🏆 🥇 🔑 🔒 📌 📎 📝 📄 📋 📦 ✉️ 📩 🔔 💡 🔥 ⭐ 🌟 ✨ ⚡'.split(' ')
  },
  {
    chave: 'natureza',
    icone: '☕',
    rotulo: 'Natureza e comida',
    emojis: '☀️ 🌤️ ⛅ 🌧️ ⛈️ 🌈 ❄️ 🌙 🌎 🌊 🌳 🌴 🌵 🍀 🍁 🌻 🌼 🐶 🐱 🐭 🐰 🦊 🐻 🐼 🦁 🐯 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦋 🐝 ☕ 🍵 🥤 🍺 🍻 🥂 🍷 🍹 🍕 🍔 🍟 🌭 🥪 🌮 🍝 🍣 🍰 🎂 🍩 🍪 🍫 🍿 🍎 🍓 🍉 🍌 🥑'.split(' ')
  },
  {
    chave: 'simbolos',
    icone: '✅',
    rotulo: 'Símbolos',
    emojis: '✅ ☑️ ✔️ ❌ ❎ ⭕ 🚫 ⛔ ⚠️ ❗ ❓ ‼️ ⁉️ 💯 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟩 🟦 ▶️ ⏸️ ⏹️ 🔁 🔄 ➡️ ⬅️ ⬆️ ⬇️ ↩️ 🔝 🆕 🆗 🆓 🔟 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 💲 💱 ™️ ©️ ®️ 🔞 📢 📣 💬 💭 🗯️ 🕐 🕒 🕕 🕘'.split(' ')
  }
];

const CHAVE_RECENTES = 'livechat.emojis-recentes';
const MAX_RECENTES = 24;

function lerRecentes() {
  try {
    const lista = JSON.parse(localStorage.getItem(CHAVE_RECENTES) ?? '[]');
    return Array.isArray(lista) ? lista.slice(0, MAX_RECENTES) : [];
  } catch {
    return [];
  }
}

function guardarRecentes(lista) {
  try {
    localStorage.setItem(CHAVE_RECENTES, JSON.stringify(lista));
  } catch {
    // Navegador sem armazenamento (aba anonima): so perde a lista de recentes.
  }
}

/**
 * @param {object} p
 * @param {(emoji: string) => void} p.aoEscolher
 */
export function SeletorEmoji({ aoEscolher }) {
  const [recentes, setRecentes] = useState(lerRecentes);
  const [aba, setAba] = useState(() => (lerRecentes().length > 0 ? 'recentes' : 'rostos'));

  const abas = [
    ...(recentes.length > 0 ? [{ chave: 'recentes', icone: '🕘', rotulo: 'Recentes', emojis: recentes }] : []),
    ...CATEGORIAS
  ];
  const atual = abas.find((a) => a.chave === aba) ?? abas[0];

  function escolher(emoji) {
    aoEscolher(emoji);
    const nova = [emoji, ...recentes.filter((e) => e !== emoji)].slice(0, MAX_RECENTES);
    setRecentes(nova);
    guardarRecentes(nova);
  }

  return (
    <div className="emojis" role="dialog" aria-label="Emojis">
      <div className="emojis__abas" role="tablist">
        {abas.map((a) => (
          <button
            key={a.chave}
            type="button"
            role="tab"
            aria-selected={a.chave === atual.chave}
            className={`emojis__aba${a.chave === atual.chave ? ' emojis__aba--ativa' : ''}`}
            onClick={() => setAba(a.chave)}
            title={a.rotulo}
          >
            <span aria-hidden="true">{a.icone}</span>
          </button>
        ))}
      </div>
      <div className="emojis__titulo">{atual.rotulo}</div>
      <div className="emojis__grade">
        {atual.emojis.map((e) => (
          <button key={e} type="button" className="emojis__item" onClick={() => escolher(e)} aria-label={e}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
