// Roles, and the colour they carry.
//
// A role's colour is a display hint the community chooses: the colour of the
// dot beside a role, the tint of the chip a role's name is drawn in, the
// colour of the role in a list. It is stored with the role, returned with the
// role, and drawn from the role - never from a copy in a component, because a
// copy is a colour that is right until somebody changes the role.
//
// **The precedence rule.** A member may hold several roles, and each may
// carry a colour. The one that is shown is the **topmost** role's: the
// roles of a community are ordered, the top one is the most senior, and the
// most senior role is the one that describes the member best. A member whose
// topmost role has no colour is drawn with the default, even if a lower role
// has one - otherwise the colour of a member would change as the roles are
// reordered, which is not a thing a reader expects.
//
// The rule is the same in every place a role is drawn, and it is here rather
// than in each of them, so that it cannot differ.
//
// **The colour never makes the text unreadable.** The colour identifies the
// role: it is the dot, and it is the tint of the chip the role's name is
// drawn in. The text inside that chip keeps the interface's own colour,
// always, whatever colour the community chose - so a pale role colour cannot
// make a name unreadable, and the choice a community makes can never cost a
// reader the ability to read a name.
//
// **The default.** A role with no colour configured has no colour. It is
// drawn in the interface's own default, and the server never invents one: a
// role nobody gave a colour to is not a role with a colour somebody chose.
//
// The desk and the phone draw their own controls, because each module owns
// its own presentation, but they share the rules below: which hex is a
// colour, which colours are offered, what the precedence is, and what the
// contrast of a swatch against the panel it sits on.

import { el } from './dom.js';

// -- the colour a role carries ------------------------------------------------

// The colour a role carries, or null when it has none.
export function roleColor(role) {
  if (!role) return null;
  const colour = String(role.color || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(colour) ? colour : null;
}

// The colour a member's roles are drawn in.
//
// The topmost role wins, and a role with no colour means the default.
export function memberRoleColor(member) {
  const roles = rolesOf(member);
  if (!roles.length) return null;
  return roleColor(roles[0]);
}

// The member's roles, in the order they are drawn.
//
// The backend orders a member's roles from the top down, so the first is the
// most senior. A list that arrives in another order is sorted here, because
// the rule must not depend on how a list happened to be fetched.
export function rolesOf(member) {
  if (!member) return [];
  const list = Array.isArray(member.roles) ? member.roles.slice() : [];
  list.sort((a, b) => (Number(b.position || 0) - Number(a.position || 0)));
  return list;
}

// The dot beside a role, in the role's colour.
//
// It is a span rather than a coloured box so the colour is a background on a
// shape the stylesheet already knows, and so a role with no colour is the
// default dot rather than an invisible one.
export function roleDot(role, extra, base) {
  const colour = roleColor(role);
  const node = el('span', {
    class: (base || 'role-dot') + (colour ? ' role-dot--role' : '') + (extra ? ' ' + extra : ''),
    'aria-hidden': 'true',
  });
  if (colour) node.style.setProperty('--role-colour', colour);
  return node;
}

// The dot that stands for a member: the colour of their topmost role.
//
// This is where the precedence rule is visible. A member whose topmost role
// has no colour is drawn in the default, even when a lower role of theirs
// has one - the dot is the topmost role's, never "the first one that has a
// colour".
export function memberRoleDot(member, extra, base) {
  const colour = memberRoleColor(member);
  const node = el('span', {
    class: (base || 'role-dot') + (colour ? ' role-dot--role' : '') + (extra ? ' ' + extra : ''),
    'aria-hidden': 'true',
  });
  if (colour) node.style.setProperty('--role-colour', colour);
  return node;
}

// A member's roles, drawn in their colours.
//
// The names are drawn with the colour of the role they belong to, and the
// most senior role's colour is what a member's name is drawn in elsewhere.
export function roleNames(member) {
  const roles = rolesOf(member);
  if (roles.length) {
    return roles.map((role) => {
      const name = el('span', { class: 'role-name' }, role.name || '');
      const colour = roleColor(role);
      if (colour) name.style.setProperty('--role-colour', colour);
      return name;
    });
  }
  if (member.roleNames && member.roleNames.length) {
    return member.roleNames.map((name) => el('span', { class: 'role-name' }, name));
  }
  return [];
}

// A readable colour for text.
//
// A role's colour is chosen by a person, and it may be a pale colour that
// text cannot be read in. The colour is kept for the dot, and the text is
// drawn in the interface's own colour, so the choice can never make a name
// unreadable. This is the rule: the colour identifies the role, and the
// interface keeps the text readable.
//
// The value here is the colour to tint a *surface* with - the dot, the chip's
// background. It is never applied to the text itself: the stylesheet keeps
// the name in the interface's own colour whatever this returns.
export function roleTint(role) {
  const colour = roleColor(role);
  return colour || null;
}

// -- drawing a member's roles -------------------------------------------------

// The class names the shared drawing uses. The desk and the phone keep their
// own presentation, so each may name them its own way; the rule - which
// roles, in which order, in which colour - does not change.
const CHIP_CLASSES = {
  chips: 'role-chips',
  chip: 'role-chip',
  dot: 'role-dot',
  name: 'role-name',
};

// A member's roles, drawn as chips: a dot in the role's colour, and the name
// beside it.
//
// Each role is drawn in its own colour - that is what tells two roles apart -
// and the order is the order the roles are held in, the most senior first.
// The colour that stands for the member as a whole is the topmost role's,
// and that is memberRoleColor's business, not this one's.
export function roleChips(member, options) {
  const opts = options || {};
  const classes = Object.assign({}, CHIP_CLASSES, opts.classes || {});
  const roles = rolesOf(member);
  if (!roles.length) return null;
  const wrap = el('span', { class: classes.chips });
  for (const role of roles) {
    const chip = el('span', { class: classes.chip });
    const colour = roleColor(role);
    if (colour) chip.style.setProperty('--role-colour', colour);
    chip.appendChild(roleDot(role, 'role-dot--sm'));
    chip.appendChild(el('span', { class: classes.name }, role.name || ''));
    wrap.appendChild(chip);
  }
  return wrap;
}

// -- choosing a colour --------------------------------------------------------

// The colours a community is offered.
//
// A small set: enough to tell two roles apart at a glance, few enough that a
// reader learns what the colours mean. A free hex field is offered as well,
// because a community has its own idea of what a colour is - and because the
// server accepts any hex, so refusing one here would be a rule the client
// invented.
export const PRESET_COLOURS = [
  '#ff8a24', // the ember of the interface itself
  '#e5484d', // red
  '#f2c14e', // gold
  '#3fb950', // green
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#8f949f', // the interface's own quiet grey
];

// The pattern a colour has to match: six hex digits, with the #.
export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

// Whether a value is a colour at all.
export function isRoleColor(value) {
  if (value === null || value === undefined) return false;
  return COLOR_PATTERN.test(String(value).trim());
}

// The colour as the server stores it: lower case, with the #.
//
// null when the value is not a colour. The server does the same thing with
// the same rule, so a colour the client accepts is a colour the server
// accepts.
export function normalizeColor(value) {
  if (!isRoleColor(value)) return null;
  return String(value).trim().toLowerCase();
}

// What a person typed in the colour field.
//
// The empty field is not an error: it is the way to say "this role has no
// colour", which the server stores as no colour at all.
export function readColorInput(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return { ok: true, colour: null, error: null };
  if (text[0] !== '#') {
    return { ok: false, colour: null, error: 'A colour starts with #, like #ff8a24.' };
  }
  if (!COLOR_PATTERN.test(text)) {
    return { ok: false, colour: null, error: 'A colour is six hex digits, like #ff8a24.' };
  }
  return { ok: true, colour: text.toLowerCase(), error: null };
}

// The colour a person is choosing, and the rules about it.
//
// The desk's editor and the phone's editor each draw their own control, and
// each asks this for the same answers: which colours are offered, whether
// what was typed is a colour, and what the colour chosen will look like
// against the panel it sits on. Nothing here saves anything - the editor that
// owns the role is what sends it to the server, so there is one write path.
export function colourChoice(initial) {
  const state = { value: initial === null || initial === undefined ? '' : String(initial).trim() };
  return {
    presets: PRESET_COLOURS.slice(),
    get value() { return state.value; },
    // What is in the field now, read the same way the server reads it.
    set(value) {
      state.value = value === null || value === undefined ? '' : String(value).trim();
      return this.read();
    },
    read() { return readColorInput(state.value); },
    // Whether the colour can be seen against the panel it sits on.
    note(panel) { return swatchNote(this.read().colour, panel); },
  };
}

// The colour field of the role editor.
//
// The swatches are the quick way and the hex field is the exact one, and the
// hex field refuses a colour that is not a colour rather than saving
// something that will be drawn as nothing.
//
// The field says whether the colour can be seen against the panel it sits on,
// because a role's colour is chosen by a person and a pale colour on a pale
// panel is a role nobody can pick out.
//
// It returns the element and a way to read the chosen colour: null means
// "no colour", a string means the colour, and undefined means the value in
// the field is not a colour and must not be saved.
export function roleColourField(options) {
  const opts = options || {};
  const choice = colourChoice(opts.role ? opts.role.color : null);
  const panel = opts.panel || FALLBACK_PANEL;

  const hex = el('input', {
    class: 'input role-colour__hex', type: 'text', value: choice.value,
    placeholder: '#ff4d24', maxlength: 7, 'aria-label': 'The role colour, as a hex value',
  });
  const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
  const note = el('p', { class: 'settings-note' });

  const swatches = el('div', {
    class: 'role-colour__swatches', role: 'group', 'aria-label': 'Role colours',
  });

  const markChosen = (colour) => {
    for (const other of swatches.children) {
      const chosen = other.getAttribute('data-colour') === colour;
      other.classList.toggle('is-chosen', chosen);
      other.setAttribute('aria-pressed', chosen ? 'true' : 'false');
    }
  };

  for (const colour of choice.presets) {
    const button = el('button', {
      class: 'role-colour__swatch', type: 'button',
      'aria-label': 'Use the colour ' + colour,
      'aria-pressed': 'false',
      onClick: () => {
        hex.value = colour;
        choice.set(colour);
        markChosen(colour);
        paintNote();
      },
    });
    button.setAttribute('data-colour', colour);
    button.style.setProperty('--role-colour', colour);
    swatches.appendChild(button);
  }
  markChosen(choice.value);

  const paintNote = () => {
    const read = choice.read();
    if (!read.ok) {
      note.textContent = '';
      error.hidden = true;
      return;
    }
    if (!read.colour) {
      note.textContent = 'No colour: the role is drawn in the interface\'s own.';
      error.hidden = true;
      return;
    }
    const said = choice.note(panel);
    note.textContent = said.text;
    error.hidden = true;
  };

  hex.addEventListener('input', () => {
    const read = choice.read();
    if (!read.ok) {
      error.hidden = false;
      error.textContent = 'A colour is six hexadecimal digits, like #ff4d24.';
      note.textContent = '';
      markChosen('');
      return;
    }
    error.hidden = true;
    markChosen(read.colour || '');
    paintNote();
  });
  paintNote();

  return {
    node: el('div', { class: 'role-colour' },
      el('span', { class: 'field-label' }, opts.label || 'The colour of this role'),
      el('p', { class: 'settings-note' },
        'The colour identifies the role. The name keeps the interface\'s own '
        + 'colour, so a role is never unreadable.'),
      swatches,
      hex,
      note,
      error),
    // The colour to save: null for none, a string for one, undefined for a
    // value that is not a colour.
    read() {
      const read = choice.read();
      if (!read.ok) return undefined;
      return read.colour || null;
    },
    element: hex,
  };
}

// -- the contrast of a swatch -------------------------------------------------

// The panel a swatch is drawn on, when the interface has not said.
//
// The dark surface of the interface. The light theme's panel is lighter, and
// a colour that is too close to one of them is too close to the other by the
// same reasoning: the swatch carries a ring of the interface's own line
// colour, so it is a visible shape whatever the colour is.
export const FALLBACK_PANEL = '#151922';

// The panel the swatch is drawn on, read from the interface when it can be.
//
// A custom property is resolved by the browser, so this is the real panel
// colour of the theme in force rather than a guess.
export function panelColour(node) {
  try {
    const view = globalThis.window;
    if (!view || typeof view.getComputedStyle !== 'function') return FALLBACK_PANEL;
    const target = node || (globalThis.document && globalThis.document.documentElement);
    if (!target) return FALLBACK_PANEL;
    const value = String(view.getComputedStyle(target).getPropertyValue('--panel') || '').trim();
    if (isRoleColor(value)) return value.toLowerCase();
  } catch {
    /* the interface is not laid out; the fallback is the answer */
  }
  return FALLBACK_PANEL;
}

// The relative luminance of a colour, the way the contrast rules measure it.
export function relativeLuminance(hex) {
  const colour = normalizeColor(hex);
  if (!colour) return null;
  const channels = [1, 3, 5].map((at) => {
    const part = parseInt(colour.slice(at, at + 2), 16) / 255;
    return part <= 0.03928 ? part / 12.92 : Math.pow((part + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

// The contrast of two colours, from 1 to 21.
//
// The measure the accessibility rules use: the ratio of the lighter colour's
// luminance to the darker one's, plus a half.
export function contrastRatio(first, second) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  if (a === null || b === null) return null;
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

// How well a swatch can be seen against the panel it sits on.
export function swatchContrast(colour, panel) {
  const against = panel || FALLBACK_PANEL;
  return contrastRatio(colour, against);
}

// What to say about a swatch that cannot be seen.
//
// A colour this close to the panel is not refused - the community may want it
// - but it is said out loud, because a dot nobody can see is a role nobody
// can tell apart. The swatch also carries a ring of the interface's own line
// colour, so the shape is there even when the colour is not.
export function swatchNote(colour, panel) {
  if (!colour) return null;
  const ratio = swatchContrast(colour, panel);
  if (ratio === null || ratio >= 3) return null;
  return 'This colour is very close to the panel it sits on, so the dot will be hard to see.';
}

export default {
  roleColor, memberRoleColor, rolesOf, roleDot, memberRoleDot, roleNames,
  roleTint, roleChips, roleColourField, PRESET_COLOURS, COLOR_PATTERN, isRoleColor,
  normalizeColor, readColorInput, colourChoice, FALLBACK_PANEL,
  panelColour, relativeLuminance, contrastRatio, swatchContrast, swatchNote,
};
