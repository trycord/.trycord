// What a user may put in a custom stylesheet. Pure: text in, verdict out.

const PROTECTED_IDS = new Set([
  'app',
  'mobile-tab-navigation',
  'app-rail', 'identity-region', 'global-navigation',
  'community-navigation', 'place-navigation', 'trycord-main', 'context-header',
  'context-title', 'view-root', 'member-sidebar', 'modal-root', 'popover-root',
  'toast-root', 'connection-status',
]);

const PROTECTED_CLASSES = new Set([
  'app-rail', 'app-rail__items', 'rail-identity', 'rail-global-nav',
    'rail-community', 'rail-nav', 'rail-mark',
  'context-sidebar', 'main-content',
  'context-header', 'chat-environment', 'view-root',
  'member-sidebar', 'shell',
  'row', 'row--nav', 'row--dm', 'row--member', 'row--channel',
  'channel-category', 'place-header',
  'place-menu', 'place-actions', 'community-actions',
  'member-group', 'msg', 'msg-actions', 'composer',
  'auth-wrap', 'card', 'card--auth', 'form-error', 'form-success', 'btn',
  'auth-page', 'auth-background', 'auth-card', 'auth-main', 'auth-secondary',
  'auth-title', 'auth-lede', 'auth-footer', 'auth-brand',
  'popover', 'pop-item', 'toast', 'connection-status',
  'settings-nav', 'theme-chip', 'status-chip',
  'mobile-tab-navigation',
]);

// Layout/behavior properties are never allowed in custom CSS. Visual-only.
const FORBIDDEN_PROPS = new Set([
  'display', 'position', 'float', 'clear', 'visibility', 'overflow', 'overflow-x',
  'overflow-y', 'clip', 'clip-path', 'width', 'height', 'min-width', 'min-height',
  'max-width', 'max-height', 'margin', 'margin-top', 'margin-right', 'margin-bottom',
  'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom',
  'padding-left', 'gap', 'row-gap', 'column-gap', 'inset', 'top', 'right', 'bottom',
  'left', 'z-index', 'flex', 'flex-basis', 'flex-direction', 'flex-flow', 'flex-grow',
  'flex-shrink', 'flex-wrap', 'grid', 'grid-area', 'grid-auto-columns',
  'grid-auto-flow', 'grid-auto-rows', 'grid-column', 'grid-column-end',
  'grid-column-start', 'grid-row', 'grid-row-end', 'grid-row-start', 'grid-template',
  'grid-template-areas', 'grid-template-columns', 'grid-template-rows',
  'align-content', 'align-items', 'align-self', 'justify-content', 'justify-items',
  'justify-self', 'place-content', 'place-items', 'place-self', 'order',
  'transform', 'translate', 'rotate', 'scale', 'perspective', 'filter',
  'backdrop-filter', 'opacity', 'mix-blend-mode', 'cursor', 'pointer-events',
  'animation', 'animation-name', 'transition', 'transition-property', 'content',
  'counter-increment', 'counter-reset', 'list-style', 'appearance', 'resize',
  'user-select', 'caret-color', 'scroll-behavior', 'overscroll-behavior',
]);

const VISUAL_PROPS = new Set([
  'color', 'background-color', 'background-image', 'background',
  'border', 'border-color', 'border-width', 'border-style', 'border-radius',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius',
  'border-bottom-right-radius', 'outline-color', 'box-shadow', 'text-shadow',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'letter-spacing', 'line-height', 'text-transform', 'text-decoration',
  'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness',
  'accent-color', 'scrollbar-color',
]);

const PROTECTED_SAFE_PROPS = new Set([
  'color', 'background-color', 'background-image', 'background',
  'border-color', 'outline-color', 'box-shadow', 'text-shadow',
  'font-family', 'font-size', 'font-weight', 'font-style',
  'letter-spacing', 'line-height', 'text-transform',
  'text-decoration-color', 'accent-color',
]);

function stripCssComments(css) {
  return String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function splitTopLevelRules(css) {
  const rules = [];
  let i = 0, n = css.length;
  const skipWs = () => { while (i < n && /\s/.test(css[i])) i++; };
  while (i < n) {
    skipWs();
    if (i >= n) break;
    if (css[i] === '@') {
      const semi = css.indexOf(';', i);
      const brace = css.indexOf('{', i);
      throw new Error('At-rules are not allowed in custom CSS (found `' + css.slice(i, Math.min(i + 24)) + '`).');
    }
    let sel = '', quote = null, depthParen = 0;
    while (i < n) {
      const c = css[i];
      if (quote) { sel += c; if (c === quote) quote = null; i++; continue; }
      if (c === '"' || c === "'") { quote = c; sel += c; i++; continue; }
      if (c === '(') depthParen++;
      if (c === ')') depthParen = Math.max(0, depthParen - 1);
      if (c === '{' && depthParen === 0) break;
      if ((c === ';' || c === '}') && depthParen === 0) throw new Error('Unexpected `' + c + '` before a rule block.');
      sel += c; i++;
    }
    if (i >= n || css[i] !== '{') throw new Error('Missing `{` for selector `' + sel.trim().slice(0, 60) + '`.');
    i++;
    let body = '', bquote = null, bdepth = 0;
    while (i < n) {
      const c = css[i];
      if (bquote) { body += c; if (c === bquote) bquote = null; i++; continue; }
      if (c === '"' || c === "'") { bquote = c; body += c; i++; continue; }
      if (c === '{') throw new Error('Nested blocks are not allowed in custom CSS.');
      if (c === '}') { i++; break; }
      body += c; i++;
    }
    rules.push({ selector: sel.trim(), body });
  }
  return rules;
}

function splitDeclarations(body) {
  const out = [];
  let cur = '', quote = null, depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ';' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function selectorTokens(selector) {
  const ids = new Set(), classes = new Set();
  const clean = String(selector || '').replace(/\[[^\]]*\]/g, '');
  let m;
  const idRe = /#([\w-]+)/g, classRe = /\.([\w-]+)/g;
  while ((m = idRe.exec(clean))) ids.add(m[1]);
  while ((m = classRe.exec(clean))) classes.add(m[1]);
  return { ids, classes };
}

export function validateCustomCss(css) {
  const errors = [];
  const text = String(css || '');
  if (!text.trim()) return { ok: true, errors };
  if (text.length > CUSTOM_CSS_LIMIT) {
    return { ok: false, errors: ['Custom CSS exceeds the ' + CUSTOM_CSS_LIMIT + '-character limit.'] };
  }
  let rules;
  try {
    rules = splitTopLevelRules(stripCssComments(text));
  } catch (e) {
    return { ok: false, errors: [e && e.message ? e.message : 'Custom CSS could not be parsed.'] };
  }
  if (rules.length > CUSTOM_CSS_RULE_LIMIT) {
    return { ok: false, errors: ['Custom CSS exceeds the ' + CUSTOM_CSS_RULE_LIMIT + '-rule limit.'] };
  }
  rules.forEach((rule, ri) => {
    const label = 'Rule ' + (ri + 1);
    if (!rule.selector) { errors.push(label + ': missing selector.'); return; }
    if (rule.selector === '*') { errors.push(label + ': the universal selector is not allowed.'); return; }
    const selectors = rule.selector.split(',').map((s) => s.trim()).filter(Boolean);
    if (!selectors.length) { errors.push(label + ': missing selector.'); return; }
    if (selectors.length > 10) { errors.push(label + ': too many selectors (max 10).'); return; }
    let isProtected = false, isRootScope = false;
    for (const sel of selectors) {
      const low = sel.toLowerCase();
      if (/^:root$/.test(sel) || /^html(\[.+\])?$/.test(sel)) isRootScope = true;
      const { ids, classes } = selectorTokens(sel);
      for (const id of ids) if (PROTECTED_IDS.has(id)) isProtected = true;
      for (const cls of classes) if (PROTECTED_CLASSES.has(cls)) isProtected = true;
    }
    const decls = splitDeclarations(rule.body).map((d) => d.trim()).filter(Boolean);
    if (!decls.length) { errors.push(label + ': no declarations.'); return; }
    if (decls.length > 60) { errors.push(label + ': too many declarations (max 60).'); return; }
    decls.forEach((decl) => {
      const colon = decl.indexOf(':');
      if (colon < 1) { errors.push(label + ': malformed declaration `' + decl.slice(0, 40) + '`.'); return; }
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = decl.slice(colon + 1).trim();
      if (!prop || !value) { errors.push(label + ': malformed declaration.'); return; }
      if (prop[0] === '*' || /[<>]/.test(prop)) { errors.push(label + ': invalid property `' + prop + '`.'); return; }
      if (prop.startsWith('--')) {
        if (!isRootScope && !/^[a-z0-9-]+$/.test(prop.slice(2))) { errors.push(label + ': invalid custom property `' + prop + '`.'); }
        return;
      }
      const lowVal = value.toLowerCase();
      if (lowVal.includes('!important') || lowVal.includes('url(') || lowVal.includes('expression(') ||
          lowVal.includes('javascript:') || /[<>]/.test(value) || value.includes('@')) {
        errors.push(label + ': forbidden value in `' + prop + '` (no !important, urls, scripts, or markup).');
        return;
      }
      if (FORBIDDEN_PROPS.has(prop)) {
        errors.push(label + ': `' + prop + '` is structural and cannot be customized.');
        return;
      }
      const allowed = isProtected ? PROTECTED_SAFE_PROPS : VISUAL_PROPS;
      if (!allowed.has(prop)) {
        errors.push(label + ': `' + prop + '` is not in the safe visual subset' + (isProtected ? ' for protected UI' : '') + '.');
      }
    });
  });
  return { ok: !errors.length, errors };
}
