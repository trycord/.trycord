'use strict';

/**
 * The layout engine.
 *
 * jsdom parses no stylesheet and computes no geometry: the harness can see the
 * DOM but not a single pixel of it, which is why layout faults - a column that
 * does not fit, a dialog that is not centred, a track that swallowed its
 * neighbour - have never been verifiable here. This module closes that gap.
 * It is a real CSS-subset engine, written from the specification algorithms
 * in plain JS, that takes the built stylesheet and a document and answers the
 * question a browser would:
 *
 *     engine.boxOf(element) // { x, y, w, h }
 *
 * What it implements, because the shell and the components need it:
 *
 *   - cascade and specificity (ids, classes, attributes, tags), inline style
 *     winning over the sheet, source order breaking ties;
 *   - @media (min|max-width) gating, the only at-rule conditions that decide
 *     layout;
 *   - custom properties declared on the document element, with var() fallback
 *     chains;
 *   - length arithmetic: px, rem, em, vh/vw/dvh, % anchors, and calc()/min()/
 *     max()/clamp(), so `width: min(var(--inspector-w), calc(100vw - 68px))`
 *     computes instead of passing through as text;
 *   - display: grid, with template areas and `grid-area: name`, px/auto/fr
 *     and minmax(a, b) tracks;
 *   - display: flex, row and column, gap (row-gap/column-gap too),
 *     justify-content (flex-start|center|flex-end|space-between),
 *     align-items (stretch|center|flex-start|flex-end), `flex: n` shorthand;
 *   - ordinary block flow, border-box sizing, per-side borders and padding;
 *   - position: absolute and fixed with resolved insets against the nearest
 *     positioned ancestor (padding box) or the viewport;
 *   - margins, including `margin: 0 auto` centring;
 *   - text as measured boxes (height from resolved font-size and line-height,
 *     width estimated from the character count), because there are no fonts
 *     inside the engine;
 *   - [hidden] and display:none out of flow.
 *
 * Deliberately out of scope: interactive-state rules (:hover and friends),
 * @keyframes, transforms (they move pixels, not the boxes assertions read),
 * float, tables, and :not()/:has()/sibling selectors. A declaration outside
 * the subset is stored but has no geometric effect; a selector outside the
 * subset matches nothing.
 *
 * check-layout.js drives the real mounted shell through this engine at three
 * viewport sizes and asserts the geometry a browser must agree on.
 */

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const ROOT_FONT_PX = 16;

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function parseMediaCondition(prelude) {
  const condition = {};
  const re = /(min|max)-width\s*:\s*([\d.]+)(px|rem|em)?/gi;
  let match;
  while ((match = re.exec(prelude))) {
    const scale = match[3] === 'rem' || match[3] === 'em' ? 16 : 1;
    condition[match[1] + 'W'] = parseFloat(match[2]) * scale;
  }
  return condition;
}

function mediaApplies(condition, viewport) {
  if (!condition) return true;
  if (condition.minW !== undefined && viewport.width < condition.minW - 0.001) return false;
  if (condition.maxW !== undefined && viewport.width > condition.maxW + 0.001) return false;
  return true;
}

function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && ch === separator) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function parseDeclarations(body) {
  const out = {};
  for (const piece of splitTopLevel(body, ';')) {
    const text = piece.trim();
    if (!text) continue;
    const colon = text.indexOf(':');
    if (colon <= 0) continue;
    const name = text.slice(0, colon).trim().toLowerCase();
    const value = text.slice(colon + 1).trim();
    out[name] = value;
    // Side shorthand expansion, in declaration order: a shorthand writes its
    // implicit longhands here, and any later explicit longhand in the same
    // block overwrites them, which is ordinary cascade behaviour.
    const parts = SIDE_SHORTHANDS[name];
    if (parts) expandSides(out, parts, value);
  }
  return out;
}

const SIDE_SHORTHANDS = {
  margin: 'margin',
  padding: 'padding',
  inset: 'inset',
};

function expandSides(out, prefix, value) {
  const sides = splitTopLevel(value, ' ').map((p) => p.trim()).filter((p) => p.length);
  if (!sides.length) return;
  const top = sides[0];
  const right = sides.length > 1 ? sides[1] : top;
  const bottom = sides.length > 2 ? sides[2] : top;
  // Two values mean [vertical, horizontal]: the left side mirrors the right,
  // so `margin: 0 auto` centres, exactly as the sheet intends.
  const left = sides.length > 3 ? sides[3] : right;
  out[prefix + '-top'] = top;
  out[prefix + '-right'] = right;
  out[prefix + '-bottom'] = bottom;
  out[prefix + '-left'] = left;
}

function parseCompound(text) {
  const parts = [];
  const re = /(\*|[a-zA-Z][\w-]*|[.#][\w-]+|::[\w-]+|:[\w-]+|\[[^\]]*\])/g;
  let match;
  while ((match = re.exec(text))) {
    const token = match[1];
    if (token[0] === '.') parts.push({ type: 'class', name: token.slice(1) });
    else if (token[0] === '#') parts.push({ type: 'id', name: token.slice(1) });
    else if (token[0] === '[') {
      const inner = token.slice(1, -1).trim();
      const eq = inner.indexOf('=');
      if (eq === -1) parts.push({ type: 'attr', name: inner });
      else {
        let value = inner.slice(eq + 1).trim();
        if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1);
        parts.push({ type: 'attr', name: inner.slice(0, eq).trim(), value });
      }
    } else if (token[0] === ':') {
      const name = token.replace(/^:+/, '').toLowerCase();
      if (name === 'root') parts.push({ type: 'root' });
      else parts.push({ type: token.startsWith('::') ? 'pseudoelement' : 'pseudo', name });
    } else if (token === '*') parts.push({ type: 'any' });
    else parts.push({ type: 'tag', name: token.toLowerCase() });
  }
  return parts;
}

function parseSelector(selectorText) {
  if (/::|:not\(|:has\(|:is\(|:where\(/i.test(selectorText)) return null;
  const head = selectorText.replace(/\[[^\]]*\]/g, '');
  if (/[+~]/.test(head)) return null;
  const sequence = [];
  for (const chunk of selectorText.split(/\s+/).map((c) => c.trim()).filter(Boolean)) {
    if (chunk === '>') {
      if (!sequence.length) return null;
      sequence[sequence.length - 1].child = true;
      continue;
    }
    const compound = parseCompound(chunk);
    if (!compound.length) return null;
    for (const part of compound) {
      if (part.type === 'pseudo' || part.type === 'pseudoelement') return null;
    }
    sequence.push({ parts: compound, child: false });
  }
  if (!sequence.length) return null;
  return sequence;
}

function specificity(sequence) {
  let ids = 0;
  let classes = 0;
  let tags = 0;
  for (const compound of sequence) {
    for (const part of compound.parts) {
      if (part.type === 'id') ids++;
      else if (part.type === 'class' || part.type === 'attr' || part.type === 'root') classes++;
      else if (part.type === 'tag') tags++;
    }
  }
  return [ids, classes, tags];
}

function parseSheet(cssText) {
  const css = stripComments(cssText);
  const rules = [];
  let order = 0;

  function walkBody(from, condition) {
    let pos = from;
    for (;;) {
      while (pos < css.length && (/\s/.test(css[pos]) || css[pos] === ';')) pos++;
      if (pos >= css.length) return pos;
      if (css[pos] === '}') return pos + 1; // this body ends; the caller continues

      const open = css.indexOf('{', pos);
      if (open === -1) return css.length;
      const prelude = css.slice(pos, open).trim();
      if (!prelude) { pos = open + 1; continue; }

      let depth = 1;
      let end = open + 1;
      while (end < css.length && depth) {
        if (css[end] === '{') depth++;
        else if (css[end] === '}') depth--;
        end++;
      }
      if (depth !== 0) return css.length; // unbalanced: treat the rest as inert
      const body = css.slice(open + 1, end - 1);

      if (prelude.startsWith('@')) {
        const at = prelude.slice(1).trim().toLowerCase();
        if (at.startsWith('media')) {
          pos = walkBody(open + 1, parseMediaCondition(prelude));
          continue;
        }
        if (at.startsWith('supports') || at.startsWith('layer')) {
          pos = walkBody(open + 1, condition);
          continue;
        }
        pos = end; // font-face/keyframes/property/import: no layout effect
        continue;
      }

      const decls = parseDeclarations(body);
      for (const raw of splitTopLevel(prelude, ',')) {
        const selectorText = raw.trim();
        if (!selectorText) continue;
        const sequence = parseSelector(selectorText);
        if (!sequence) continue;
        rules.push({ sequence, spec: specificity(sequence), decls, order: order++, condition });
      }
      pos = end;
    }
  }

  walkBody(0, null);
  return rules;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function substituteVars(value, scope) {
  if (!value || String(value).indexOf('var(') === -1) return value;
  let out = String(value);
  for (let pass = 0; pass < 16; pass++) {
    const next = out.replace(
      /var\(\s*(--[\w-]+)\s*(?:,([^-()]?[^()]*(?:\([^()]*\))[^()]*)*)?\)/g,
      (whole, name, fallback) => {
        void whole;
        const got = scope.has(name) ? scope.get(name) : undefined;
        if (got !== undefined && got !== '') return got;
        if (fallback !== undefined) return String(fallback).trim();
        return '';
      });
    if (next === out) return out;
    out = next;
  }
  return out;
}

function evalLength(value, base) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || text === 'auto' || text === 'none' || text === 'inherit'
    || text === 'initial' || text === 'unset') return null;
  if (/^0$/.test(text)) return 0;
  const plain = /^(-?[\d.]+)(px|rem|em|vh|vw|dvh|%)?$/.exec(text);
  if (plain) return convert(plain[1], plain[2] || '', base || {});
  const fn = /^(calc|min|max|clamp)\((.*)\)$/s.exec(text);
  if (fn) {
    if (fn[1] === 'calc') return evalSum(fn[2], base);
    const args = splitTopLevel(fn[2], ',').map((a) => evalLength(a.trim(), base));
    if (args.some((v) => v === null)) return null;
    if (fn[1] === 'min') return Math.min.apply(null, args);
    if (fn[1] === 'max') return Math.max.apply(null, args);
    return Math.min(Math.max(args[0], args[1]), args[2]);
  }
  return null;

  function evalSum(expr, b) {
    const terms = [];
    const ops = [];
    let part = '';
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if ((ch === '+' || ch === '-') && depth === 0 && part.trim() !== '' && !/\S$/.test(part)) {
        terms.push(part); ops.push(ch); part = '';
      } else part += ch;
    }
    terms.push(part);
    let total = 0;
    for (let i = 0; i < terms.length; i++) {
      const value2 = evalProduct(terms[i].trim(), b);
      if (value2 === null) return null;
      if (i > 0 && ops[i - 1] === '-') total -= value2; else total += value2;
    }
    return total;
  }

  function evalProduct(expr, b) {
    const factors = [];
    const ops = [];
    let part = '';
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if ((ch === '*' || ch === '/') && depth === 0) {
        factors.push(part); ops.push(ch); part = '';
        continue;
      }
      part += ch;
    }
    factors.push(part);
    let value2 = evalLength(factors[0].trim(), b);
    for (let i = 1; i < factors.length; i++) {
      const term = evalLength(factors[i].trim(), b);
      if (value2 === null || term === null) return null;
      value2 = ops[i - 1] === '*' ? value2 * term : value2 / term;
    }
    return value2;
  }

  function convert(number, unit, b) {
    const n = parseFloat(number);
    if (unit === '') return n;
    if (unit === 'px') return n;
    if (unit === 'rem') return n * ROOT_FONT_PX;
    if (unit === 'em') return n * (b.fontSize || ROOT_FONT_PX);
    if (unit === '%') return b.base === undefined ? null : (b.base * n) / 100;
    if (unit === 'vh' || unit === 'dvh') return b.vh === undefined ? null : (b.vh * n) / 100;
    if (unit === 'vw') return b.vw === undefined ? null : (b.vw * n) / 100;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Matching + cascade
// ---------------------------------------------------------------------------

function matchCompound(el, compound) {
  const attrs = attrMap(el);
  const classes = el.classList && el.classList.length ? el.classList : [];
  for (const part of compound.parts) {
    if (part.type === 'any') continue;
    if (part.type === 'class') {
      let found = false;
      for (const name of classes) if (name === part.name) { found = true; break; }
      if (!found) return false;
    } else if (part.type === 'id') { if (el.id !== part.name) return false; }
    else if (part.type === 'tag') { if ((el.tagName || '').toLowerCase() !== part.name) return false; }
    else if (part.type === 'root') { if (el.ownerDocument.documentElement !== el) return false; }
    else if (part.type === 'attr') {
      if (!(part.name in attrs)) return false;
      if (part.value !== undefined && attrs[part.name] !== part.value) return false;
    } else return false;
  }
  return true;
}

function matchSelector(el, sequence) {
  if (!sequence || !matchCompound(el, sequence[sequence.length - 1])) return false;
  let current = el;
  for (let i = sequence.length - 1; i > 0; i--) {
    if (sequence[i].child) {
      current = current.parentElement;
      if (!current || !matchCompound(current, sequence[i - 1])) return false;
    } else {
      let walked = false;
      for (let parent = current.parentElement; parent; parent = parent.parentElement) {
        if (matchCompound(parent, sequence[i - 1])) { current = parent; walked = true; break; }
      }
      if (!walked) return false;
    }
  }
  return true;
}

function attrMap(el) {
  const attrs = {};
  if (el.attributes) for (const attr of el.attributes) attrs[attr.name] = attr.value;
  return attrs;
}

const INLINE_SENTINEL = '\u0000inline';

function computeDeclarations(rules, viewport) {
  return function forElement(el) {
    const candidates = [];
    for (const rule of rules) {
      if (!mediaApplies(rule.condition, viewport)) continue;
      if (matchSelector(el, rule.sequence)) candidates.push(rule);
    }
    candidates.sort((a, b) => {
      for (let i = 0; i < 3; i++) {
        if (a.spec[i] !== b.spec[i]) return a.spec[i] - b.spec[i];
      }
      return a.order - b.order;
    });
    const decls = new Map();
    const inline = el.getAttribute ? el.getAttribute('style') : null;
    if (inline) {
      for (const entry of Object.entries(parseDeclarations(inline))) decls.set(entry[0], entry[1]);
      decls.set(INLINE_SENTINEL, true);
    }
    for (const candidate of candidates) {
      for (const entry of Object.entries(candidate.decls)) {
        if (decls.has(INLINE_SENTINEL) && decls.has(entry[0])) continue;
        // Ascending order: every later candidate is more specific, so it wins.
        decls.set(entry[0], entry[1]);
      }
    }
    return decls;
  };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

const INLINE_TAGS = new Set(['span', 'a', 'strong', 'em', 'code', 'small', 'time', 'label', 'b', 'i', 'kbd', 'img', 'svg', 'picture']);

function createEngine(cssText, doc, width, height) {
  const viewport = { width, height };
  const rules = parseSheet(cssText);
  const forElement = computeDeclarations(rules, viewport);
  const styleCache = new Map();
  const boxes = new Map();

  // -- custom properties: inherited down the tree, the way the cascade does it --
  // A palette may be written inline on .ws (the grip writes --context-w there),
  // so a global lookup would miss the very values the shell sets. Every style
  // looks its var()s up in its own chain: parent chain, overridden by the
  // element's own declarations.
  const scopeCache = new Map();
  const EMPTY_SCOPE = new Map();

  function varsOf(el) {
    let cached = scopeCache.get(el);
    if (cached) return cached;
    const parent = el.parentElement;
    const inherited = parent ? varsOf(parent) : EMPTY_SCOPE;
    // Cascaded declarations for this element, custom properties included, and
    // the inline style winning. forElement already merged them for this
    // viewport, so this is the same lookup the sheet itself makes.
    let cachedRaw = rawCache.get(el);
    if (!cachedRaw) { cachedRaw = forElement(el); rawCache.set(el, cachedRaw); }
    const resolved = new Map(inherited);
    const pre = new Map(inherited);
    for (const [key, value] of cachedRaw) {
      if (key.startsWith('--') && value) {
        // Definitions resolve against the outer chain only, so two custom
        // properties cannot ping-pong each other; a broken chain yields ''.
        resolved.set(key, substituteVars(value, { has: (k) => pre.has(k), get: (k) => pre.get(k) }));
      }
    }
    scopeCache.set(el, resolved);
    return resolved;
  }
  const rawCache = new Map();

  class ElementStyle {
    constructor(el, raw) {
      this.el = el;
      this.raw = raw;
      this.vars = varsOf(el);
    }
    prop(name) {
      return substituteVars(this.raw.get(name) || '', this.vars);
    }
    keyword(name, fallback) {
      const value = this.prop(name).trim();
      return value || fallback;
    }
    display() {
      if (this.el.hidden === true || (this.el.hasAttribute && this.el.hasAttribute('hidden'))) return 'none';
      if (this.raw.has('display')) {
        const declared = this.prop('display').trim();
        return declared || 'none';
      }
      return INLINE_TAGS.has((this.el.tagName || '').toLowerCase()) ? 'inline' : 'block';
    }
    position() {
      return this.keyword('position', 'static');
    }
    px(name, base) {
      return evalLength(this.prop(name), base);
    }
    fontPx() {
      const resolved = evalLength(this.prop('font-size'),
        { fontSize: ROOT_FONT_PX, base: ROOT_FONT_PX, vw: width, vh: height });
      return resolved === null ? ROOT_FONT_PX : resolved;
    }
    lineHeightPx(fontPx) {
      const value = this.prop('line-height').trim();
      if (!value) return fontPx * 1.5;
      // A unitless number is a multiplier of the font size, never a plain px.
      if (/^-?[\d.]+$/.test(value)) {
        const unitless = parseFloat(value);
        return Number.isNaN(unitless) ? fontPx * 1.5 : unitless * fontPx;
      }
      const direct = evalLength(value, { fontSize: fontPx, base: fontPx, vw: width, vh: height });
      return direct === null ? fontPx * 1.5 : direct;
    }
  }

  function styleOf(el) {
    let cached = styleCache.get(el);
    if (!cached) {
      cached = new ElementStyle(el, forElement(el));
      styleCache.set(el, cached);
    }
    return cached;
  }

  /** The layout that governs a box: `contents` behaves as transparent. */
  function layoutDisplayIn(el) {
    const display = styleOf(el).display();
    return display === 'contents' ? (elementChildren(el).length === 1 ? 'contents' : 'block') : display;
  }

  // -- primitives ----------------------------------------------------------------

  function elementChildren(el) {
    const out = [];
    for (const child of el.children || []) out.push(child);
    return out;
  }

  function directText(el) {
    let text = '';
    for (const child of el.childNodes || []) {
      if (child.nodeType === 3) text += child.nodeValue;
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  function textWidth(el, style) {
    return directText(el).length * style.fontPx() * 0.58;
  }

  function textHeight(el, style) {
    return directText(el) ? style.lineHeightPx(style.fontPx()) : 0;
  }

  function bordersAndPad(style, base) {
    return {
      pad: [
        pad('padding-top', 'top'),
        pad('padding-right', 'right'),
        pad('padding-bottom', 'bottom'),
        pad('padding-left', 'left'),
      ],
      border: {
        top: borderSide('top'),
        right: borderSide('right'),
        bottom: borderSide('bottom'),
        left: borderSide('left'),
      },
    };

    function pad(name, side) {
      const value = style.px(name, base);
      if (value !== null) return value;
      // The shorthand maps to top/right/bottom/left in that order.
      const shorthhand = style.prop('padding').trim();
      if (!shorthhand) return 0;
      const parts = splitTopLevel(shorthhand, ' ').map((p) => orZero(evalLength(p.trim(), base)));
      const t = parts[0] || 0;
      const r = parts.length > 1 ? parts[1] : t;
      const b = parts.length > 2 ? parts[2] : t;
      const l = parts.length > 3 ? parts[3] : (parts.length === 3 ? r : t);
      return side === 'top' ? t : side === 'right' ? r : side === 'bottom' ? b : l;
    }

    function borderSide(side) {
      const perSide = evalLength(style.prop('border-' + side), base);
      if (perSide !== null) return perSide;
      const own = style.prop('border-' + side).trim();
      if (own && /^[^;]*\d/.test(own)) {
        const fromOwn = evalLength(own.split(/\s+/)[0], base);
        if (fromOwn !== null) return fromOwn;
      }
      const all = evalLength(style.prop('border-width'), base);
      if (all !== null) return all;
      const shorthand = style.prop('border').trim();
      if (shorthand) {
        const fromShorthand = evalLength(shorthand.split(/\s+/)[0], base);
        if (fromShorthand !== null) return fromShorthand;
      }
      return 0;
    }
  }

  function orZero(v) { return v === null || v === undefined ? 0 : v; }

  /**
   * Resolved insets for a placed element. `inset: 0` is the shorthand the
   * overlays and the scrim actually use; it maps to top/right/bottom/left in
   * that order. Percentages anchor on the box's own axis.
   */
  function insetsOf(style, baseW, baseH) {
    let left = style.px('left', baseW);
    let right = style.px('right', baseW);
    let top = style.px('top', baseH);
    let bottom = style.px('bottom', baseH);
    const shorthand = style.prop('inset').trim();
    if (shorthand && (left === null || right === null || top === null || bottom === null)) {
      const parts = splitTopLevel(shorthand, ' ').map((p) => evalLength(p.trim(), baseW));
      const clean = parts.filter((p) => p !== null).length === parts.length ? parts : null;
      if (clean) {
        const t = clean[0] || 0;
        const r = clean.length > 1 ? clean[1] : t;
        const b = clean.length > 2 ? clean[2] : t;
        const l = clean.length > 3 ? clean[3] : (clean.length === 3 ? r : t);
        if (left === null) left = l;
        if (right === null) right = r;
        if (top === null) top = t;
        if (bottom === null) bottom = b;
      }
    }
    return { left, right, top, bottom };
  }

  function margins(style, base) {
    // Margin `auto` survives as the string 'auto': the flows that understand
    // it (block centring, flex leftover absorption) test for it explicitly,
    // and the numeric-only consumers guard with num().
    const side = (name) => {
      const raw = (style.prop(name) || '').trim();
      if (!raw || raw === 'auto' || raw === 'initial' || raw === 'inherit') {
        return raw === 'auto' ? 'auto' : 0;
      }
      const px = style.px(name, base);
      return px === null ? 0 : px;
    };
    return {
      top: side('margin-top'),
      right: side('margin-right'),
      bottom: side('margin-bottom'),
      left: side('margin-left'),
    };
  }

  const num = (v) => (typeof v === 'number' ? v : 0);

  function fixedWidth(style, base) {
    return style.px('width', base);
  }

  function fixedHeight(style, base) {
    return style.px('height', base);
  }

  /** Content size of a subtree, for auto track/basis sizing. */
  function measure(el, style, hintWidth) {
    if (style.display() === 'none') return { w: 0, h: 0 };
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'svg') return svgSize(el);
    if (tag === 'img') {
      const w = parseFloat(el.getAttribute('width'));
      const h = parseFloat(el.getAttribute('height'));
      return { w: Number.isNaN(w) ? 24 : w, h: Number.isNaN(h) ? 24 : h };
    }
    const base = { base: hintWidth === undefined ? 0 : hintWidth, fontSize: style.fontPx(), vw: width, vh: height };
    const box = bordersAndPad(style, base);
    const padW = box.pad[1] + box.pad[3] + box.border.left + box.border.right;
    const padH = box.pad[0] + box.pad[2] + box.border.top + box.border.bottom;
    const minW = style.px('min-width', base);
    const maxW = style.px('max-width', { ...base, base: hintWidth === undefined ? viewport.width : hintWidth });
    const minH = style.px('min-height', { ...base, base: Infinity });
    const maxH = style.px('max-height', { ...base, base: Infinity });
    const children = inFlowChildren(el);
    const text = directText(el);
    let size;
    if (!children.length && !text && tag !== 'svg' && tag !== 'img') {
      size = {
        w: padW + orZero(fixedWidth(style, { ...base, base: hintWidth === undefined ? viewport.width : hintWidth })),
        h: padH + orZero(fixedHeight(style, { ...base, base: 0 })),
      };
    } else if (!children.length) {
      size = { w: textWidth(el, style) + padW, h: textHeight(el, style) + padH };
    } else {
      const display = style.display();
      const gap = orZero(evalLength(style.prop('gap'), base));
      let w = 0;
      let h = 0;
      let count = 0;
      if (display === 'flex') {
        const column = style.keyword('flex-direction', 'row').startsWith('column');
        for (const child of children) {
          const childStyle = styleOf(child);
          const card = measure(child, childStyle, hintWidth);
          const cm = margins(childStyle, base);
          if (column) { h += card.h + num(cm.top) + num(cm.bottom); w = Math.max(w, card.w + num(cm.left) + num(cm.right)); }
          else { w += card.w + num(cm.left) + num(cm.right); h = Math.max(h, card.h + num(cm.top) + num(cm.bottom)); }
          count++;
        }
      } else {
        for (const child of children) {
          const childStyle = styleOf(child);
          const card = measure(child, childStyle, hintWidth);
          const cm = margins(childStyle, base);
          w = Math.max(w, card.w + num(cm.left) + num(cm.right));
          h += card.h + num(cm.top) + num(cm.bottom);
          count++;
        }
      }
      if (count > 1) { w += gap * (count - 1); h += gap * (count - 1); }
      size = { w: w + padW, h: h + padH };
    }
    if (minW !== null && size.w < minW) size.w = minW;
    if (maxW !== null && size.w > maxW) size.w = maxW;
    if (minH !== null && size.h < minH) size.h = minH;
    if (maxH !== null && size.h > maxH) size.h = maxH;
    return size;
  }

  function inFlowChildren(el) {
    const out = [];
    for (const child of elementChildren(el)) {
      const style = styleOf(child);
      if (style.display() === 'none') continue;
      const position = style.position();
      if (position === 'absolute' || position === 'fixed') continue;
      out.push(child);
    }
    return out;
  }

  function svgSize(el) {
    const w = parseFloat(el.getAttribute && el.getAttribute('width'));
    const h = parseFloat(el.getAttribute && el.getAttribute('height'));
    return { w: Number.isNaN(w) ? 16 : w, h: Number.isNaN(h) ? 16 : h };
  }

  // -- the layout pass -----------------------------------------------------------

  const VIEWPORT = () => ({ box: { x: 0, y: 0, w: width, h: height }, viewport: true, fontSize: ROOT_FONT_PX });
  const viewportBox = { x: 0, y: 0, w: width, h: height };

  /**
   * Containing block of `el`'s children: the padding box when `el` itself is
   * positioned; otherwise the context `el` inherited (unchanged ancestor).
   */
  function childRcs(style, region, box, rcs) {
    if (style.position() !== 'static') {
      return {
        box: {
          x: region.x + box.border.left,
          y: region.y + box.border.top,
          w: Math.max(0, (region.w || 0) - box.border.left - box.border.right),
          h: region.h === undefined || region.h === null ? Infinity : Math.max(0, region.h - box.border.top - box.border.bottom),
        },
        viewport: false,
        fontSize: style.fontPx(),
      };
    }
    return rcs || VIEWPORT();
  }

  function contentBox(style, region, box) {
    return {
      x: region.x + box.border.left + box.pad[3],
      y: region.y + box.border.top + box.pad[0],
      w: Math.max(0, (region.w || 0) - box.border.left - box.border.right - box.pad[1] - box.pad[3]),
      h: region.h === undefined || region.h === null ? Infinity
        : Math.max(0, region.h - box.border.top - box.border.bottom - box.pad[0] - box.pad[2]),
    };
  }

  function layoutElement(el, slot, rcs) {
    const style = styleOf(el);
    if (style.display() === 'none') return null;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'svg') return paintLeafCollection(el, svgSize(el), slot);
    if (tag === 'img') {
      const w = parseFloat(el.getAttribute('width'));
      const h = parseFloat(el.getAttribute('height'));
      return paintLeafCollection(el, { w: Number.isNaN(w) ? 24 : w, h: Number.isNaN(h) ? 24 : h }, slot);
    }

    const rawDisplay = style.display();
    const display = rawDisplay === 'contents' ? 'block' : rawDisplay;
    const position = style.position();
    const selfBoxW = slot.w === undefined ? (rcs ? rcs.box.w : width) : slot.w;
    const selfBase = {
      base: selfBoxW,
      fontSize: rcs ? rcs.fontSize : ROOT_FONT_PX,
      vw: width,
      vh: height,
    };
    const box = bordersAndPad(style, selfBase);
    const region = { node: el, x: slot.x, y: slot.y };

    // -- width -----------------------------------------------------------------
    let w = fixedWidth(style, selfBase);
    if (w === null) {
      if (position === 'absolute' || position === 'fixed') {
        const anchor = position === 'fixed' ? viewportBox : (rcs ? rcs.box : viewportBox);
        const resolved = insetsOf(style, { ...selfBase, base: anchor.w }, { ...selfBase, base: anchor.h });
        if (resolved.left !== null && resolved.right !== null) {
          // The inset pair spans the anchor to the element's border box;
          // its own padding and border live inside that box.
          w = Math.max(0, anchor.w - resolved.left - resolved.right);
        } else {
          w = Math.min(measure(el, style, anchor.w).w, anchor.w);
        }
      } else if (display === 'flex' || display === 'grid' || display === 'block' || INLINE_TAGS.has(tag) === false) {
        w = selfBoxW;
      } else {
        w = Math.min(measure(el, style, selfBoxW).w, selfBoxW);
      }
    }
    // The cascade's own limits are hard bounds on the used box, whatever
    // the flow handed it. Percentages anchor on the containing block.
    const containW = slot.w;
    const selfMaxW = style.px('max-width', { ...selfBase, base: containW });
    if (selfMaxW !== null && w !== null && w > selfMaxW) w = selfMaxW;
    const selfMinW = style.px('min-width', { ...selfBase, base: containW });
    if (selfMinW !== null && w !== null && w < selfMinW) w = selfMinW;
    const minWidth = style.px('min-width', selfBase);
    if (w !== null && minWidth !== null && w < minWidth) w = minWidth;
    const maxWidth = style.px('max-width', { ...selfBase, base: rcs ? rcs.box.w : width });
    if (w !== null && maxWidth !== null && w > maxWidth) w = maxWidth;

    // -- height -----------------------------------------------------------------
    let h = fixedHeight(style, { ...selfBase, base: rcs ? rcs.box.h : height });
    if (h === null && (position === 'absolute' || position === 'fixed')) {
      const anchor = position === 'fixed' ? viewportBox : (rcs ? rcs.box : viewportBox);
      const resolvedH = insetsOf(style, { ...selfBase, base: anchor.w }, { ...selfBase, base: anchor.h });
      if (resolvedH.top !== null && resolvedH.bottom !== null) {
        // Same rule as the width pair: the inset pair spans the border box.
        h = Math.max(0, anchor.h - resolvedH.top - resolvedH.bottom);
      }
    }
    // A slot that arrived with a definite height is a stretch: grid areas and
    // flex stretches hand their cell down, and the item fills it (the browser's
    // default align-self/justify-self behaviour), minus the item's margins.
    // In-flow positioned items (relative) still stretch; out-of-flow do not.
    const mbBefore = margins(style, { ...selfBase, base: selfBoxW });
    if (h === null && slot.h !== undefined && slot.h !== Infinity
      && position !== 'absolute' && position !== 'fixed') {
      h = Math.max(0, slot.h - num(mbBefore.top) - num(mbBefore.bottom));
    }

    // -- margins ---------------------------------------------------------------
    const mb = margins(style, { ...selfBase, base: selfBoxW });
    const mL = style.prop('margin-left').trim() === 'auto' ? 'auto' : mb.left;
    const mR = style.prop('margin-right').trim() === 'auto' ? 'auto' : mb.right;
    const slotW = slot.w === undefined ? selfBoxW : slot.w;
    if (mL === 'auto' && mR === 'auto' && w !== null) {
      region.x = slot.x + Math.max(0, (slotW - w) / 2);
    } else if (mL === 'auto') {
      region.x = slot.x + Math.max(0, slotW - w - orZero(mR));
    } else {
      region.x = slot.x + mL;
    }

    // -- insets for placed elements ---------------------------------------------
    if (position === 'fixed' || position === 'absolute') {
      const anchor = position === 'fixed' ? viewportBox : (rcs ? rcs.box : viewportBox);
      const absBase = { ...selfBase, base: anchor.w };
      const absBaseH = { ...selfBase, base: anchor.h };
      const resolvedX = insetsOf(style, absBase, absBaseH);
      if (resolvedX.left !== null) region.x = anchor.x + resolvedX.left;
      else if (resolvedX.right !== null) region.x = anchor.x + anchor.w - resolvedX.right - (w === null ? 0 : w);
      else region.x = anchor.x + (anchor.w - (w === null ? 0 : w));
      if (resolvedX.top !== null) region.y = anchor.y + resolvedX.top;
      else if (resolvedX.bottom !== null) region.y = anchor.y + anchor.h - resolvedX.bottom - (h === null ? 0 : h);
    } else {
      region.y = slot.y + mb.top;
    }

    region.w = w;
    region.h = h;

    // -- children ----------------------------------------------------------------
    const kids = [];
    const placedKids = [];
    for (const child of elementChildren(el)) {
      const childStyle = styleOf(child);
      if (childStyle.display() === 'none') continue;
      if (childStyle.position() === 'absolute' || childStyle.position() === 'fixed') {
        placedKids.push({ child, childStyle, fixed: childStyle.position() === 'fixed' });
      } else kids.push(child);
    }
    const text = directText(el);
    if (!kids.length && !text) {
      region.h = h === null ? box.pad[0] + box.pad[2] + box.border.top + box.border.bottom : h;
      region.w = w === null ? 0 : w;
      boxOfSet(el, region, display);
      paintPlaced(placedKids, style, region, box, rcs);
      return { x: region.x, y: region.y, w: region.w, h: region.h };
    }

    const inner = contentBox(style, region, box);
    const savedContext = currentRcs;
    currentRcs = childRcs(style, region, box, rcs);
    let flow;
    try {
      if (display === 'flex') flow = layoutFlex(el, style, kids, inner, selfBase);
      else if (display === 'grid') flow = layoutGrid(el, style, kids, inner, selfBase);
      else flow = layoutBlock(el, style, kids, inner, selfBase);
    } finally {
      currentRcs = savedContext;
    }

    if (h === null) region.h = flow.h + box.pad[0] + box.pad[2] + box.border.top + box.border.bottom;
    region.w = w === null ? Math.max(flow.w + box.pad[1] + box.pad[3] + box.border.left + box.border.right, 0) : w;
    boxOfSet(el, region, display);

    // Out-of-flow children anchor to the nearest positioned ancestor.
    paintPlaced(placedKids, style, region, box, rcs);
    return { x: region.x, y: region.y, w: region.w, h: region.h };
  }

  function paintLeafCollection(el, size, slot) {
    const region = {
      node: el,
      x: slot.x === undefined ? 0 : slot.x,
      y: slot.y === undefined ? 0 : slot.y,
      w: size.w,
      h: size.h,
    };
    boxOfSet(el, region, 'leaf');
    return { x: region.x, y: region.y, w: region.w, h: region.h };
  }

  function paintPlaced(placedKids, selfStyle, region, box, rcs) {
    if (!placedKids.length) return;
    const context = childRcs(selfStyle, region, box, rcs);
    for (const placed of placedKids) {
      const anchor = placed.fixed ? viewportBox : (context.viewport ? viewportBox : context.box);
      if (placed.fixed) {
        layoutElement(placed.child, { x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h }, VIEWPORT());
      } else if (context.viewport) {
        layoutElement(placed.child, { x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h }, VIEWPORT());
      } else {
        layoutElement(placed.child, { x: context.box.x, y: context.box.y, w: context.box.w, h: context.box.h === Infinity ? undefined : context.box.h }, context);
      }
    }
  }

  function boxOfSet(el, region, display) {
    boxes.set(el, {
      node: el,
      x: region.x,
      y: region.y,
      w: region.w === null || region.w === undefined ? 0 : region.w,
      h: region.h === null || region.h === undefined ? 0 : region.h,
      display,
    });
  }

  // -- block flow -----------------------------------------------------------------

  function layoutBlock(el, style, kids, inner, base) {
    void el;
    let y = inner.y;
    let widest = 0;
    for (const child of kids) {
      const childStyle = styleOf(child);
      if (childStyle.display() === 'none') continue;
      const childBase = { base: inner.w, fontSize: style.fontPx(), vw: width, vh: height };
      const childWidthRaw = childStyle.px('width', childBase);
      const cm = margins(childStyle, childBase);
      const mL = childStyle.prop('margin-left').trim() === 'auto' ? 'auto' : cm.left;
      const mR = childStyle.prop('margin-right').trim() === 'auto' ? 'auto' : cm.right;
      let slotW;
      if (childWidthRaw !== null) slotW = childWidthRaw;
      // Auto margins on both sides of an auto width still means a block
      // stretching to its container; the width limit then decides the
      // centered leftover, which is the palette dialog's exact pattern.
      else if (mL === 'auto' && mR === 'auto') slotW = inner.w;
      else slotW = Math.max(0, inner.w - (mL === 'auto' ? 0 : mL) - (mR === 'auto' ? 0 : mR));
      // max-width clamps the used width before auto margins centre it, which
      // is what makes `max-width: 580px; margin: 0 auto` a centred dialog.
      const childMax = childStyle.px('max-width', { ...childBase, base: inner.w });
      if (childMax !== null && slotW > childMax) slotW = childMax;
      const region = layoutElement(child, {
        x: inner.x + (mL === 'auto' ? 0 : mL),
        y,
        w: slotW,
      }, currentRcs);
      if (region) {
        y = region.y + region.h + num(cm.bottom);
        widest = Math.max(widest, region.w + num(mL) + num(mR));
      }
    }
    return { h: y - inner.y, w: Math.max(inner.w, widest) };
  }

  // currentRcs is the containing-block context the children of the element
  // being flowed lay against; layoutElement sets and restores it around each
  // flow function.
  let currentRcs = null;

  // -- flex ---------------------------------------------------------------------

  function layoutFlex(el, style, kids, inner, base) {
    const column = style.keyword('flex-direction', 'row').startsWith('column');
    const align = style.keyword('align-items', 'stretch');
    const justify = style.keyword('justify-content', 'flex-start');
    const gapValue = style.prop('gap');
    const rowGap = orZero(evalLength(style.prop('row-gap'), base) !== null ? evalLength(style.prop('row-gap'), base) : evalLength(gapValue, base));
    const columnGap = orZero(evalLength(style.prop('column-gap'), base) !== null ? evalLength(style.prop('column-gap'), base) : evalLength(gapValue, base));
    const gapMain = column ? rowGap : columnGap;
    const main = column ? inner.h : inner.w;
    const cross = column ? inner.w : inner.h;
    const definiteMain = main === Infinity ? null : main;

    const items = [];
    let fixedMain = 0;
    let growTotal = 0;
    let shrinkWeights = 0;
    for (const child of kids) {
      const childStyle = styleOf(child);
      const childBase = { ...base, base: inner.w };
      const measured = measure(child, childStyle, inner.w);
      const cm = margins(childStyle, childBase);
      const flexText = childStyle.prop('flex').trim();
      let grow = 0;
      let shrink = 1;
      let basis = null;
      if (flexText && flexText !== 'auto') {
        const parts = splitTopLevel(flexText, ' ').map((p) => p.trim());
        if (parts[0] && /^\d/.test(parts[0])) grow = parseFloat(parts[0]) || 0;
        if (parts[1] && /^\d/.test(parts[1])) shrink = parseFloat(parts[1]);
        else if (parts[1]) shrink = parts[1] === '0' ? 0 : 1;
        const basisText = parts[2] !== undefined ? parts[2] : (parts[1] !== undefined && !/^(auto|none|initial|\d)/.test(parts[1]) && /(%|px|rem|em|vh|vw)/.test(parts[1]) ? parts[1] : undefined);
        if (basisText !== undefined && basisText !== 'auto') basis = evalLength(basisText, childBase);
      }
      const along = basis !== null ? basis : (column
        ? childStyle.px('height', { ...childBase, base: definitive(rowBase2()) })
        : childStyle.px('width', { ...childBase, base: inner.w }));
      const item = {
        el: child,
        style: childStyle,
        grow,
        shrink,
        basis: along !== null ? along : (column ? measured.h : measured.w),
        cross: column
          ? (childStyle.px('width', childBase) !== null ? childStyle.px('width', childBase) : measured.w)
          : (childStyle.px('height', childBase) !== null ? childStyle.px('height', childBase) : measured.h),
        marginStart: column ? cm.top : cm.left,
        marginEnd: column ? cm.bottom : cm.right,
      };
      items.push(item);
      fixedMain += item.basis + num(item.marginStart) + num(item.marginEnd);
      growTotal += item.grow;
      shrinkWeights += item.shrink * item.basis;
    }

    function definitive(v) { return v === Infinity ? viewport.height : v; }
    function rowBase2() { return column ? inner.h : inner.w; }

    const gapTotal = gapMain * Math.max(0, items.length - 1);
    // The cross size of an auto-sized container is what its items demand, not
    // the infinite slot it was handed.
    let crossResolved = cross;
    if (!Number.isFinite(cross)) {
      crossResolved = 0;
      for (const item of items) {
        crossResolved = Math.max(crossResolved, (item.cross === null ? 0 : item.cross) + num(item.marginStart) + num(item.marginEnd));
      }
    }
    let cursor = column ? inner.y : inner.x;
    const definiteFree = definiteMain !== null ? (definiteMain - fixedMain - gapTotal) : null;
    if (definiteFree !== null && definiteFree > 0) {
      if (justify === 'center') cursor += definiteFree / 2;
      else if (justify === 'flex-end' || justify === 'end') cursor += definiteFree;
    }
    const between = (definiteFree !== null && justify === 'space-between' && items.length > 1 && definiteFree > 0)
      ? definiteFree / (items.length - 1)
      : gapMain;

    const distributed = items.map((item) => {
      let size = item.basis;
      if (definiteFree !== null) {
        if (definiteFree > 0 && item.grow > 0 && growTotal > 0) size += definiteFree * (item.grow / growTotal);
        else if (definiteFree < 0 && item.shrink > 0 && shrinkWeights > 0) size += definiteFree * ((item.shrink * item.basis) / shrinkWeights);
      }
      const min = column
        ? item.style.px('min-height', { ...base, base: Infinity })
        : item.style.px('min-width', { ...base, base: Infinity });
      if (min !== null && size < min) size = min;
      return size;
    });

    // Auto margins on the main axis absorb the leftover space, evenly among
    // the autos in source order - the stage head's `margin-left: auto`
    // pattern, which pushes the action cluster to the far end.
    let autosMain = 0;
    for (const item of items) {
      if (item.marginStart === 'auto') autosMain++;
      if (item.marginEnd === 'auto') autosMain++;
    }
    const autoShare = autosMain && definiteFree !== null && definiteFree > 0
      ? definiteFree / autosMain
      : 0;
    for (const item of items) {
      item.startEff = item.marginStart === 'auto' ? autoShare : item.marginStart;
      item.endEff = item.marginEnd === 'auto' ? autoShare : item.marginEnd;
    }

    let cursorRun = cursor;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const size = distributed[i];
      const startMain = cursorRun + item.startEff;
      // A declared percentage on the cross axis resolves against the
      // container's inner cross, never against an indefinite slot: this is
      // what keeps `width: 100%` honest for children of a flex column.
      const defCrossRaw = column
        ? item.style.px('width', { ...base, base: inner.w })
        : item.style.px('height', { ...base, base: inner.h });
      const defCross = defCrossRaw !== null && Number.isFinite(defCrossRaw) ? defCrossRaw : null;
      let crossSize;
      if (defCross !== null) crossSize = defCross;
      else if (align === 'stretch') crossSize = crossResolved;
      else crossSize = Math.min(item.cross, crossResolved);
      const offset = (avail, size2) => {
        if (align === 'center') return Math.max(0, (avail - size2) / 2);
        if (align === 'flex-end' || align === 'end') return Math.max(0, avail - size2);
        return 0;
      };
      const slot = column
        ? {
          x: inner.x + offset(crossResolved, crossSize),
          y: startMain,
          w: crossSize,
          h: size,
        }
        : {
          x: startMain,
          y: inner.y + offset(crossResolved, crossSize),
          w: size,
          h: crossSize,
        };
      const region = layoutElement(item.el, slot, currentRcs);
      cursorRun = startMain + size + item.endEff + between;
      void region;
    }
    const flowSize = cursorRun - cursor - between;
    return {
      h: column ? flowSize : crossResolved,
      w: column ? crossResolved : Math.max(flowSize, 0),
    };
  }

  // -- grid ---------------------------------------------------------------------

  function parseTracks(value, base) {
    if (!value || /^(none|\s*)$/.test(value.trim())) return [];
    return splitTopLevel(value, ' ').map((token) => {
      const t = token.trim();
      const flex = /^([\d.]+)fr$/.exec(t);
      if (flex) return { min: 0, flexible: parseFloat(flex[1]) };
      const mm = /^minmax\(([^,]+),([^)]+)\)$/i.exec(t);
      if (mm) {
        const minimum = evalLength(mm[1].trim(), base);
        const maximumText = mm[2].trim();
        const maxFlex = /^([\d.]+)fr$/.exec(maximumText);
        if (maxFlex) return { min: minimum === null ? 0 : minimum, flexible: parseFloat(maxFlex[1]) };
        const maximum = evalLength(maximumText, base);
        return { min: minimum === null ? 0 : minimum, max: maximum === null ? Infinity : maximum };
      }
      const fixed = evalLength(t, base);
      if (fixed === null) return { min: 0, max: Infinity, auto: true };
      return { min: fixed, max: fixed };
    });
  }

  function parseAreas(style) {
    const text = style.keyword('grid-template-areas', 'none');
    if (!text || text === 'none') return { map: new Map(), rows: 0, cols: 0 };
    const map = new Map();
    let rows = 0;
    let cols = 0;
    (text.match(/"[^"]*"/g) || []).forEach((rowString, row) => {
      const names = rowString.slice(1, -1).trim().split(/\s+/).filter(Boolean);
      if (!names.length) return;
      rows = Math.max(rows, row + 1);
      cols = Math.max(cols, names.length);
      names.forEach((name, col) => {
        if (name === '.') return;
        const area = map.get(name);
        if (area) { area.r1 = Math.max(area.r1, row); area.c1 = Math.max(area.c1, col); }
        else map.set(name, { r0: row, r1: row, c0: col, c1: col });
      });
    });
    return { map, rows, cols };
  }

  function layoutGrid(el, style, kids, inner, base) {
    const colBase = { ...base, base: inner.w };
    const rowBase = { ...base, base: inner.h === Infinity ? viewport.height : inner.h };
    const colGapRaw = evalLength(style.prop('column-gap'), colBase);
    const rowGapRaw = evalLength(style.prop('row-gap'), rowBase);
    const gapRaw = evalLength(style.prop('gap'), colBase);
    const colGap = orZero(colGapRaw !== null ? colGapRaw : gapRaw);
    const rowGap = orZero(rowGapRaw !== null ? rowGapRaw : gapRaw);
    const columnsDef = parseTracks(style.keyword('grid-template-columns', 'none'), colBase);
    const rowsDef = parseTracks(style.keyword('grid-template-rows', 'none'), rowBase);
    const areas = parseAreas(style);

    const items = [];
    for (const child of kids) {
      const childStyle = styleOf(child);
      const area = childStyle.keyword('grid-area', '').trim();
      const named = area ? areas.map.get(area.split(/\s+/)[0]) || null : null;
      items.push({ el: child, style: childStyle, cell: named ? { ...named } : null });
    }

    // Auto tracks take the largest demanded size of the items whose cell covers
    // the track. A spanning item only counts when it spans no *flexible* track
    // in this axis: a track beside an fr share never has to grow for it, since
    // the fr track absorbs what remains.
    const autoColSize = (index) => {
      let size = 0;
      for (const item of items) {
        if (!item.cell || index < item.cell.c0 || index > item.cell.c1) continue;
        if (item.cell.c1 > item.cell.c0) {
          let spansFlexible = false;
          for (let c = item.cell.c0; c <= item.cell.c1; c++) {
            if (columnsDef[c] && columnsDef[c].flexible !== undefined) spansFlexible = true;
          }
          if (spansFlexible) continue;
        }
        const def = item.style.px('width', { ...colBase, fontSize: style.fontPx() });
        size = Math.max(size, def !== null ? def : measure(item.el, item.style, inner.w).w);
      }
      return size;
    };
    const autoRowSize = (index) => {
      let size = 0;
      for (const item of items) {
        if (!item.cell || index < item.cell.r0 || index > item.cell.r1) continue;
        if (item.cell.r1 > item.cell.r0) {
          let spansFlexible = false;
          for (let r = item.cell.r0; r <= item.cell.r1; r++) {
            if (rowsDef[r] && rowsDef[r].flexible !== undefined) spansFlexible = true;
          }
          if (spansFlexible) continue;
        }
        const def = item.style.px('height', { ...rowBase, fontSize: style.fontPx() });
        size = Math.max(size, def !== null ? def : measure(item.el, item.style, inner.w).h);
      }
      return size;
    };

    function trackSizes(definitions, gap, definite, autoOf) {
      const n = definitions.length;
      const sizes = new Array(n).fill(0);
      let flexible = 0;
      let used = 0;
      for (let i = 0; i < n; i++) {
        const track = definitions[i];
        if (track.flexible !== undefined) { flexible += track.flexible; continue; }
        const size = Math.min(track.auto ? autoOf(i) : track.min, track.max === undefined ? Infinity : track.max);
        sizes[i] = size;
        used += size;
      }
      if (definite !== null && definite !== undefined && flexible > 0) {
        const share = Math.max(0, definite - gap * Math.max(0, n - 1) - used) / flexible;
        for (let i = 0; i < n; i++) {
          if (definitions[i].flexible !== undefined) {
            sizes[i] = Math.max(definitions[i].min || 0, share * definitions[i].flexible);
            used += sizes[i];
          }
        }
      }
      return { sizes, natural: used + gap * Math.max(0, n - 1) };
    }

    // Auto placement first, so every implicit row knows its item before the
    // rows are measured; then each implicit row sizes to its own item.
    let implicitIndex = rowsDef.length;
    for (const item of items) {
      if (!item.cell) {
        item.cell = { r0: implicitIndex, r1: implicitIndex, c0: 0, c1: Math.max(0, columnsDef.length - 1) };
        implicitIndex++;
      }
    }
    const explicitRows = trackSizes(rowsDef, rowGap, inner.h === Infinity ? null : inner.h, autoRowSize);
    const rowList = explicitRows.sizes.slice();
    for (let r = rowList.length; r < implicitIndex; r++) rowList.push(autoRowSize(r));

    const columns = trackSizes(columnsDef, colGap, inner.w === Infinity ? null : inner.w, autoColSize);
    if (!columns.sizes.length) {
      // No column template: a single fill column.
      columns.sizes = [inner.w === Infinity ? viewport.width : inner.w];
    }

    for (const item of items) {
      const cell = item.cell;
      const c0 = Math.min(cell.c0, columns.sizes.length - 1);
      const r0 = Math.min(cell.r0, rowList.length - 1);
      const c1 = Math.min(cell.c1, columns.sizes.length - 1);
      const r1 = Math.min(cell.r1, rowList.length - 1);
      let x = inner.x;
      for (let c = 0; c < c0; c++) x += columns.sizes[c] + colGap;
      let w = columns.sizes[c0];
      for (let c = c0 + 1; c <= c1; c++) w += colGap + columns.sizes[c];
      let y = inner.y;
      for (let r = 0; r < r0; r++) y += rowList[r] + rowGap;
      let h = rowList[r0] || 0;
      for (let r = r0 + 1; r <= r1; r++) h += rowGap + (rowList[r] || 0);
      layoutElement(item.el, { x, y, w: w > 0 ? w : undefined, h: h > 0 ? h : undefined }, currentRcs);
    }

    let colsTotal = colGap * Math.max(0, columns.sizes.length - 1);
    for (const size of columns.sizes) colsTotal += size;
    let rowsTotal = rowGap * Math.max(0, rowList.length - 1);
    for (const size of rowList) rowsTotal += size;
    return { h: rowsTotal, w: colsTotal };
  }

  // -- the driver ------------------------------------------------------------------

  function paint() {
    boxes.clear();
    const body = doc.body;
    if (!body) return boxes;
    layoutElement(body, { x: 0, y: 0, w: width, h: height }, VIEWPORT());
    return boxes;
  }

  function boxOf(el) {
    return boxes.get(el) || null;
  }

  function visit(selectorText) {
    const sequence = parseSelector(selectorText);
    const out = [];
    for (const [node] of boxes) {
      if (matchSelector(node, sequence)) out.push(node);
    }
    return out;
  }

  return {
    rules,
    viewport,
    varsOf,
    styleOf,
    boxOf,
    visit,
    paint,
    evalLength,
    substituteVars: (text) => substituteVars(text, varsOf(doc.documentElement)),
  };
}

module.exports = { createEngine, parseSheet, parseSelector, evalLength, substituteVars };
