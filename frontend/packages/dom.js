// Element construction.
//
// One `el` and one `svgEl`, because building a tree with createElement /
// setAttribute / appendChild by hand makes every view twice as long and hides
// its structure. Children may be nodes, strings, arrays or null, so a view can
// inline a conditional without a guard at each one.
//
// "Null means absent" is the rule of this module, and the DOM does not share
// it: `replaceChildren(null)` and `append(null)` put the text "null" on the
// screen. So a page that renders a conditional - a banner, a button that is
// only there sometimes, a fact that is only there for some people - printed
// the word "null" where a person expected nothing.
//
// Rather than guard three hundred call sites, the rule is put where the
// methods are: the DOM is told what null means here, once, and every view
// that uses it is right by construction. The house rule and the platform
// finally agree.

const SVG_NS = 'http://www.w3.org/2000/svg';

// What a nullish child means: nothing.
//
// The DOM's own methods turn a null into the text "null", so a view that
// renders a conditional with one of them prints the word where a person
// expected nothing. The methods are told what null means, once, so that
// every view is right by construction rather than by remembering.
function withoutNulls(children) {
  const out = [];
  for (const child of children) {
    if (child === null || child === undefined) continue;
    out.push(child);
  }
  return out;
}

function patchChildMethods() {
  const proto = (typeof Node !== 'undefined' && Node.prototype) || null;
  if (!proto || proto.__trycordChildRules) return;
  for (const name of ['replaceChildren', 'append', 'prepend']) {
    const native = proto[name];
    if (typeof native !== 'function') continue;
    proto[name] = function (...children) {
      return native.apply(this, withoutNulls(children));
    };
  }
  proto.__trycordChildRules = true;
}

patchChildMethods();

export const SVG_NAMESPACE = SVG_NS;

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  apply(node, props, false);
  appendChildren(node, children);
  return node;
}

export function svgEl(tag, props, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  apply(node, props, true);
  appendChildren(node, children);
  return node;
}

export function fragment(...children) {
  const frag = document.createDocumentFragment();
  appendChildren(frag, children);
  return frag;
}

export function appendChildren(target, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) { appendChildren(target, child); continue; }
    if (child instanceof Node) { target.appendChild(child); continue; }
    target.appendChild(document.createTextNode(String(child)));
  }
  return target;
}

export function clear(target) {
  while (target.firstChild) target.removeChild(target.firstChild);
  return target;
}

export function replaceChildren(target, ...children) {
  clear(target);
  return appendChildren(target, children);
}

export function qs(selector, scope) {
  return (scope || document).querySelector(selector);
}

export function qsa(selector, scope) {
  return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
}

export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return function off() { target.removeEventListener(type, handler, options); };
}

// Whether the reader has asked for less motion, read once per call.
export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function apply(node, props, isSvg) {
  if (!props) return node;
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (value === undefined) continue;

    if (key === 'class' || key === 'className') {
      node.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value));
    } else if (key === 'style') {
      if (typeof value === 'string') node.setAttribute('style', value);
      else if (value) Object.assign(node.style, value);
    } else if (key === 'dataset') {
      for (const k of Object.keys(value)) {
        if (value[k] === null || value[k] === undefined) delete node.dataset[k];
        else node.dataset[k] = String(value[k]);
      }
    } else if (key === 'ref') {
      if (typeof value === 'function') value(node);
    } else if (key === 'text') {
      node.textContent = value === null || value === undefined ? '' : String(value);
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else if (key.length > 2 && key.slice(0, 2) === 'on' && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === false || value === null) {
      // false and null both mean "absent", which is what a boolean attribute
      // needs in order to not render at all.
    } else if (value === true) {
      node.setAttribute(attributeName(key), '');
    } else if (isSvg) {
      node.setAttribute(key, String(value));
    } else if (isProperty(node, key)) {
      node[key] = value;
    } else {
      node.setAttribute(attributeName(key), String(value));
    }
  }
  return node;
}

// `for` is `htmlFor` on a label, and a plain attribute everywhere else.
function attributeName(key) {
  return key;
}

// Assigning a real property is the difference between `disabled` disabling the
// control and `disabled="false"` leaving it enabled. Only settable properties
// are assigned; `for` is remapped, everything else falls through to an attribute.
function isProperty(node, key) {
  if (key === 'for') return false;
  if (key === 'list' || key === 'form') return false;
  try {
    return key in node;
  } catch {
    return false;
  }
}

// Focus trapping and restoration for overlays. Returns a teardown that restores
// the previously focused element, so closing a dialog returns the reader where
// they were rather than to the top of the document.
export function trapFocus(container) {
  const selector = 'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';
  const previouslyFocused = document.activeElement;

  function handler(event) {
    if (event.key !== 'Tab') return;
    const items = qsa(selector, container).filter((node) => node.offsetParent !== null || node === container);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  container.addEventListener('keydown', handler);
  return function release() {
    container.removeEventListener('keydown', handler);
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
      try { previouslyFocused.focus(); } catch { /* element left the document */ }
    }
  };
}
