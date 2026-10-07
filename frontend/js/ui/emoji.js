import { el, clear, qs } from './dom.js';
import { closeContextMenu } from './menus.js';

// The emoji picker and the table it picks from.
// 
// NAME_OF is built once from EMOJI_NAMES rather than searched per keystroke, which is
// the only reason this stays responsive with a few hundred entries.

const EMOJI_CATEGORIES = [
  {
    id: 'faces', label: 'Smileys', emoji: ('😀 😁 😂 🤣 😊 😄 😍 🥰 😘 😗 😙 😚 🙂 🙃 😉 😌 😔 🥺 😢 😭 😤 😠 😡 🤬 '
      + '🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫣 🤭 🫢 🫡 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 '
      + '❓ ❗ 😇 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 ☠️ 👽 👾 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾 🥳 😎 😕 🙃'),
  },
  {
    id: 'people', label: 'People', emoji: ('👋 🤚 🖐 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 '
      + '🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦿 🦵 🦶 👂 🦻 👃 🧠 🫀 🫁 🦷 🦴 👀 👁 👅 👄 💋 🩸'),
  },
  {
    id: 'nature', label: 'Nature', emoji: ('🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🐣 🐥 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🪱 🐛 🦋 🐌 🐞 🐜 🪰 🪲 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🐋 '
      + '🦈 🐊 🐅 🐆 🦓 🦍 🦧 🐘 🦛 🦏 🐪 🐫 🦒 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🦮 🐈 🐓 🦃 🦤 🦚 🦜 🦢 🕊 🐇 🦝 🦨 🦡 🦫 🦦 🦥 🐁 🐀 🐿 🦔 🌵 🎄 🌲 🌳 🌴 🪵 🌱 🌿 ☘️ 🍀 🎍 🎋 🍃 🍂 🍁 🍄 🌾 💐 🌷 🌹 🥀 🌺 🌸 🌼 🌻'),
  },
  {
    id: 'food', label: 'Food', emoji: ('🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🫑 🌽 🥕 🫒 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🫓 🥙 🧆 🌮 🌯 🥗 🥘 🫕 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍙 🍚 🍘 🍥 🥠 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 🫖 ☕ 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾 🧊'),
  },
  {
    id: 'activity', label: 'Activity', emoji: ('⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🪃 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🪂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏌️ 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🏵️ 🎗️ 🎫 🎟️ 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩 🎆 🎇 🎊 🎉 🎈 🎁 🔔'),
  },
  {
    id: 'travel', label: 'Travel', emoji: ('🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🦯 🦽 🦼 🛴 🚲 🛵 🏍️ 🛺 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🛰️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ 🪝 ⛽ 🚧 🚦 🚥 🗺️ 🗿 🗽 🗼 🏰 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🛖 🏠 🏡 🏘️ 🏚️ 🏗️ 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🕍 🛕 🕋 🌁 🌃 🏙️ 🌄 🌅 🌆 🌇 🌉 ♨️ 🎑 🏞️ 🌠 🎇 🎆 🌌'),
  },
  {
    id: 'objects', label: 'Objects', emoji: ('⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📀 📼 📷 📸 📹 🎥 📽️ 📞 ☎️ 📟 📠 📺 📻 🎙️ ⏱ ⏲ ⏰ 🕰️ ⌛ ⏳ 📡 🔋 🔌 💡 🔦 🕯️ 🪔 🧯 🛢️ 💸 💵 💴 💶 💷 🪙 💰 💳 💎 ⚖️ 🪜 🧰 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ 🪦 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳️ 🩹 🩺 💊 💉 🧬 🦠 🧫 🧪 🌡️ 🧹 🪠 🧺 🧻 🚽 🚰 🚿 🛁 🛀 🧼 🪥 🪒 🧽 🪣 🧴 🛎️ 🔑 🗝️ 🚪 🪑 🛋️ 🛏️ 🖼️ 🛍️ 🛒 🎁 🎈 🎏 🎀 🎊 🎉 🪄 🪅 🎎 🏮 🎐 🧧 ✉️ 📩 📨 📧 💌 📥 📤 📦 🏷️ 📪 📫 📬 📭 📮 📯 📜 📃 📄 📑 🧾 📊 📈 📉 🗒️ 🗓️ 📆 📅 🗑️ 📇 🗃️ 🗳️ 🗄️ 📋 📁 📂 🗂️ 🗞️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇️ 📐 📏 🧮 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓'),
  },
  {
    id: 'symbols', label: 'Symbols', emoji: ('♥ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉️ ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚 🈸 🈺 🈷️ ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕ 🛑 ⛔ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈯 💹 ❇️ ✳️ ❎ 🌐 💠 Ⓜ️ 🌀 💤 💬 🗯️ ♠️ ♣️ ♥️ ♦️ ♟️ 🃏 🎴 🀄 🕐 ⭐ 🌟 ✨ 🔥 ⚡ 💥 💫'),
  },
];

// works in English. Deliberately partial: it covers the common ones, and
const EMOJI_NAMES = {
  grin: '😀', smile: '😄', joy: '😂', rofl: '🤣', blush: '😊', heart_eyes: '😍',
  thinking: '🤔', neutral: '😐', rolling_eyes: '🙄', sleep: '😴', scream: '😱',
  sob: '😭', rage: '😡', party: '🥳', fire: '🔥', tada: '🎉', sparkles: '✨',
  ok: '👌', thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎',
  clap: '👏', pray: '🙏', muscle: '💪', wave: '👋', heart: '♥', broken_heart: '💔',
  hundred: '💯', star: '⭐', zap: '⚡', boom: '💥', eyes: '👀', see_no_evil: '🙈',
  skull: '💀', ghost: '👻', robot: '🤖', poop: '💩', clown: '🤡',
  pizza: '🍕', beer: '🍺', coffee: '☕', cake: '🎂', cookie: '🍪',
  rocket: '🚀', game: '🎮', guitar: '🎸', soccer: '⚽', basketball: '🏀',
  trophy: '🏆', bug: '🐛', cat: '🐱', dog: '🐶', fox: '🦊',
  white_check_mark: '✅', x: '❌', warning: '⚠️', question: '❓', exclamation: '❗',
  bulb: '💡', lock: '🔒', key: '🔑', hammer: '🔨', wrench: '🔧',
  bell: '🔔', link: '🔗', memo: '📝', book: '📚', calendar: '📅',
};

const NAME_OF = (() => {
  const byChar = new Map();
  for (const [name, ch] of Object.entries(EMOJI_NAMES)) byChar.set(ch, name.replace(/_/g, ' '));
  return (e) => byChar.get(e) || e;
})();

export function showEmojiPicker(anchor, onPick) {
  closeContextMenu();
  const root = qs('#popover-root') || document.body;
  const pop = el('div', { class: 'popover emoji-picker', role: 'dialog', 'aria-label': 'Choose an emoji' });

  const search = el('input', {
    class: 'emoji-search', type: 'search', placeholder: 'Search emoji…',
    'aria-label': 'Search emoji', autocomplete: 'off', spellcheck: 'false',
  });
  const results = el('div', { class: 'emoji-results' });
  pop.appendChild(search);
  pop.appendChild(results);

  const flat = [];
  for (const cat of EMOJI_CATEGORIES) {
    for (const e of new Set(cat.emoji.split(' '))) flat.push({ e, name: NAME_OF(e) });
  }

  const cell = (e, name) => {
    const b = el('button', { class: 'emoji-cell', type: 'button', title: name || e, 'aria-label': name || e }, e);
    b.addEventListener('click', () => {
      closeContextMenu();
      if (onPick) onPick(e);
    });
    return b;
  };

  const paintGroups = () => {
    clear(results);
    for (const cat of EMOJI_CATEGORIES) {
      const list = [...new Set(cat.emoji.split(' '))];
      if (!list.length) continue;
      const sec = el('section', { class: 'emoji-group' });
      sec.appendChild(el('div', { class: 'emoji-group__label' }, cat.label));
      const grid = el('div', { class: 'emoji-grid' });
      for (const e of list) grid.appendChild(cell(e, NAME_OF(e)));
      sec.appendChild(grid);
      results.appendChild(sec);
    }
  };

  const paintSearch = (q) => {
    clear(results);
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) { paintGroups(); return; }
    const hits = flat.filter((x) => x.name.toLowerCase().includes(needle) || x.e === needle);
    if (!hits.length) {
      results.appendChild(el('div', { class: 'emoji-empty' }, 'No emoji match "' + String(q).trim() + '"'));
      return;
    }
    const grid = el('div', { class: 'emoji-grid' });
    for (const x of hits) grid.appendChild(cell(x.e, x.name));
    results.appendChild(grid);
  };

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => paintSearch(search.value), 60);
  });

  results.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'];
    if (!keys.includes(e.key)) return;
    const cells = [...results.querySelectorAll('.emoji-cell')];
    if (!cells.length) return;
    const at = cells.indexOf(document.activeElement);
    e.preventDefault();
    const perRow = Math.max(1, Math.round(cells[0].parentElement.clientWidth / (cells[0].offsetWidth || 1)));
    let next = at;
    if (e.key === 'ArrowRight') next = at + 1;
    else if (e.key === 'ArrowLeft') next = at - 1;
    else if (e.key === 'ArrowDown') next = at + perRow;
    else next = at - perRow;
    if (next < 0) next = 0;
    if (next >= cells.length) next = cells.length - 1;
    cells[next].focus();
  });

  paintGroups();
  root.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = Math.min(Math.max(8, r.left), Math.max(8, innerWidth - pr.width - 8));
  let top = r.top - pr.height - 8;
  if (top < 8) top = Math.min(innerHeight - pr.height - 8, r.bottom + 8);
  pop.style.left = left + 'px';
  pop.style.top = Math.max(8, top) + 'px';
  const onKey = (e) => {
    if (e.key === 'Escape') { closeContextMenu(); return; }
    if (e.target === search || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1) {
      search.value += e.key;
      paintSearch(search.value);
      search.focus();
    }
  };
  const onDown = (e) => { if (!pop.contains(e.target)) closeContextMenu(); };
  const onScroll = () => closeContextMenu();
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
  }, 0);
  pop._ctxCleanup = () => {
    clearTimeout(timer);
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
  };
  return { pop, hide: closeContextMenu };
}
