// Building blocks. Everything else in the interface is made of these, so they are the
// only part with no opinion about what anything is for.
export function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const FORM_CONTROLS = ['input', 'select', 'textarea'];

let autoId = 0;

function associateLabels(node) {
  for (const label of node.querySelectorAll('label:not([for])')) {
    const siblings = label.parentElement ? Array.from(label.parentElement.children) : [];
    const at = siblings.indexOf(label);
    const control = siblings
      .slice(at + 1)
      .find((sib) => FORM_CONTROLS.includes(sib.tagName.toLowerCase()));
    if (!control) continue;
    if (!control.id) control.id = 'f-' + (++autoId);
    label.setAttribute('for', control.id);
  }
}

// One icon set, drawn rather than typed.
//
// The UI used to reach for Unicode pictographs - a smiling face for Friends, a
// club suit for Alerts, an envelope for DMs. They render differently on every
// platform, some are emoji and get the coloured treatment, and none of them line
// up with the stroke weight of the type beside them. That inconsistency is most
// of what makes an interface read as assembled rather than designed.
//
// These are inline SVG on a 24-grid with a 1.7 stroke, so they inherit
// currentColor, scale with font-size, and match each other. `icon()` returns an
// element rather than a string so it can be dropped straight into el().
export const ICON_PATHS = {
  home: 'M3 10.6 12 3.5l9 7.1V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  chevron: 'M6.5 9.5 12 15l5.5-5.5',
  'bell-off': 'M9.4 5.2A5 5 0 0 1 17 9.5c0 4 1.5 5.5 1.5 5.5H8M6.2 6.8 4 15h3M10.3 19a2 2 0 0 0 3.4 0M3 3l18 18',
  plus: 'M12 5v14M5 12h14',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 14.5a4.5 4.5 0 0 0 7 0',
  circle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  paperclip: 'M20 11.5 12.2 19.3a4.5 4.5 0 0 1-6.4-6.4l8-8a3 3 0 0 1 4.3 4.3l-8 8a1.5 1.5 0 0 1-2.1-2.1l7.3-7.3',
  mail: 'M3 6.5h18v11H3zM3 7l9 6.5L21 7',
  users: 'M16 20v-1.6a3.4 3.4 0 0 0-3.4-3.4H6.4A3.4 3.4 0 0 0 3 18.4V20M9.5 11.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5M21 20v-1.6a3.4 3.4 0 0 0-2.6-3.3M15.5 5.2a3.25 3.25 0 0 1 0 6.1',
  bell: 'M18 8.5a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5M13.7 20a2 2 0 0 1-3.4 0',
  search: 'M11 18.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15M20.5 20.5l-4.4-4.4',
  menu: 'M3.5 6.5h17M3.5 12h17M3.5 17.5h17',
  hash: 'M9 3.5 7 20.5M17 3.5l-2 17M3.5 8.5h17M3 15.5h17',
  gear: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1',
  pin: 'M9 3.5h6l-.7 5.2 3.2 3.3H6.5l3.2-3.3zM12 12v8.5',
  pencil: 'M16.5 4.5l3 3M4 20l.9-3.8L15.6 5.5a1.6 1.6 0 0 1 2.3 0l.6.6a1.6 1.6 0 0 1 0 2.3L7.8 19.1z',
  close: 'M6 6l12 12M18 6L6 18',
  more: 'M12 6.5h.01M12 12h.01M12 17.5h.01',
  chevronDown: 'M6 9.5l6 6 6-6',
  chevronRight: 'M9.5 6l6 6-6 6',
  flag: 'M5 21V4.5M5 5h11l-1.8 3.5L16 12H5',
  star: 'M12 3.5l2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.4 2.8 1-6L3.3 9.9l6-.9z',
  check: 'M4.5 12.5l5 5 10-11',
  warn: 'M12 4 2.8 20h18.4zM12 10v4.2M12 17.2h.01',
  shield: 'M12 3.2 19 6v6.2c0 4.3-2.9 7.4-7 8.6-4.1-1.2-7-4.3-7-8.6V6z',
  upload: 'M12 16V4.5M7.5 9 12 4.5 16.5 9M4 15.5v3A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-3',
  download: 'M12 4v11.5M7.5 11l4.5 4.5 4.5-4.5M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2',
  trash: 'M4.5 6.5h15M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7M6.5 6.5 7.4 20a1.3 1.3 0 0 0 1.3 1.2h6.6a1.3 1.3 0 0 0 1.3-1.2l.9-13.5',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M5.6 5.6l12.8 12.8',
  mute: 'M11 5.5 6.8 9H3.5v6h3.3L11 18.5zM15.5 9.5l5 5M20.5 9.5l-5 5',
  volume: 'M11 5.5 6.8 9H3.5v6h3.3L11 18.5zM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12',
  layers: 'M12 3 3 7.5l9 4.5 9-4.5zM3 12.5l9 4.5 9-4.5M3 17l9 4.5 9-4.5',
  list: 'M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3.2 9.5h17.6M3.2 14.5h17.6M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18',
  logout: 'M15 8V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h8a1.5 1.5 0 0 0 1.5-1.5V16M10 12h10M17 8.5l3.5 3.5-3.5 3.5',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M15.5 8.5l-2 5-5 2 2-5z',
  image: 'M4.5 4.5h15v15h-15zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M4.5 16.5l4.5-4.5 3.5 3.5 3-3 4 4',
  document: 'M6 3.5h7l5 5v12H6zM13 3.5v5h5M9 13h6M9 16.5h6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5.2l3.2 2',
  inbox: 'M3.5 13.5h4l1.5 3h6l1.5-3h4M3.5 13.5 6 5h12l2.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19z',
};

export function icon(name, opts = {}) {
  const d = ICON_PATHS[name];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', opts.weight || '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (opts.size) { svg.setAttribute('width', opts.size); svg.setAttribute('height', opts.size); }
  // A passed class is added to the base one, never swapped for it. An svg with a
  // viewBox and no box grows to whatever its container offers, and .ui-icon is
  // the only thing giving one a size - drop it and a small glyph becomes a
  // full-width block. SVGElement.className is read-only in WebKit, hence
  // setAttribute.
  if (opts.class) svg.setAttribute('class', 'ui-icon ' + opts.class);
  else svg.setAttribute('class', 'ui-icon');
  for (const seg of (d || ICON_PATHS.inbox).split(' M').map((p, i) => (i ? 'M' + p : p))) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', seg);
    svg.appendChild(path);
  }
  return svg;
}

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (v === true) node.setAttribute(k, '');
      else if (k in node && k !== 'value' && k !== 'type') { try { node[k] = v; } catch { node.setAttribute(k, v); } }
      else node.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  if (node.querySelector('label')) associateLabels(node);
  return node;
}

// Clear a container without losing where the reader was. Used by the settings tabs,
// which rebuild themselves in place after an action rather than re-rendering the
// page - a list that jumps back to the top after every accept is disorienting.
//
// This lived in account/notifications.js, which is how account/privacy.js came
// to call it across a tab boundary without importing it.
export function clearAndRebuild(container) {
  const scrollTop = container.scrollTop;
  clear(container);
  return Object.assign(container, { scrollTop });
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

// Focus, without making it a problem when we cannot.
//
// The node is usually something the reader has just interacted with, which means it
// can already be gone: a popup closed, a re-render replaced it, a route change
// dismissed the dialog underneath the caret. Focusing a detached node throws in some
// engines. The only thing lost by not focusing is where the caret was, which is not
// worth an exception over - the alternative is every close handler being wrapped.
export function focusQuietly(node, opts) {
  if (!node || typeof node.focus !== 'function') return;
  try {
    node.focus(opts);
  } catch {
    // Detached, or an engine that objects. Moving on.
  }
}
