// Settings: how this client looks and what it talks to.
// Three honest surfaces: the colours and motion the reader chooses, the backend
// this build was signed into, and what this build actually is.
//
// The colours run through one engine - packages/theme.js - rather than a private
// keying here: the choices named here are the themes that stylesheet actually
// knows, the custom palette installs only if the shell survives it, and every
// button on this page maps to a store the engine reads.

import { el } from '../../packages/dom.js';
import Api from '../../packages/api.js';
import theme, { THEMES, CUSTOM_TOKEN_DEFS, DEFAULT_CUSTOM_TOKENS } from '../../packages/theme.js';
import { readPrefs, patchPrefs, applyDensity, rememberRegions, rememberStageWidth, DENSITIES, REGIONS, STAGE_MIN, STAGE_MAX } from '../prefs.js';
import { switchControl, fieldRow } from '../ui/primitives.js';
import { head, card, blank, fault, fold, facts } from '../ui/page.js';
import { toast } from '../ui/overlays.js';

// A colour choice names a theme the stylesheet actually knows, and its swatch
// carries the target theme as an attribute so the preview shows that theme's
// real colours rather than sampling whatever is active.
function themeChoice(id, label, currentId) {
  const scoped = id === 'system'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'trycord')
    : id;
  return el('button', {
    class: 'theme-choice' + (currentId === id ? ' is-current' : ''),
    type: 'button',
    'data-theme-choice': id,
    'aria-pressed': String(currentId === id),
    onClick: () => {
      theme.setTheme(id);
      toast('The colour is ' + label.toLowerCase());
      return id;
    },
  },
    el('span', { class: 'theme-swatch', 'data-theme-swatch': id, 'data-theme': scoped }),
    label);
}

// The custom palette previews live; installing it as a theme is a measured act,
// because a palette the shell cannot survive takes the interface with it.
function paletteControls(statusLine) {
  const palette = Object.assign({}, DEFAULT_CUSTOM_TOKENS, theme.loadPalette() || {});
  const inputs = [];
  for (const def of CUSTOM_TOKEN_DEFS) {
    const input = el('input', {
      class: 'input input--color', type: 'color', value: palette[def.key] || '#000000',
      id: 'custom-token-' + def.key,
      'aria-label': def.label,
      onInput: () => {
        const next = Object.assign({}, palette, { [def.key]: input.value });
        theme.savePalette(next);
        theme.applyCustomPalette(next);
      },
    });
    inputs.push(el('label', { class: 'palette-field', for: 'custom-token-' + def.key },
      input, el('span', {}, def.label)));
  }

  return el('div', { class: 'palette-row' },
    inputs,
    el('div', { class: 'palette-row-side' },
      el('button', {
        class: 'btn btn--default btn--sm', type: 'button', 'aria-label': 'Install this palette',
        onClick: () => {
          const result = theme.applyCustomTheme({ tokens: theme.loadPalette() });
          if (result.ok) {
            theme.setTheme('custom');
            statusLine.replaceChildren(el('span', { class: 'ok-line' }, 'Installed. It survives reloads.'));
          } else {
            statusLine.replaceChildren(el('span', { class: 'warn-line' },
              'Refused: ' + (result.problems || []).join('; ')));
          }
        },
      }, 'Install this palette'),
      el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button', 'aria-label': 'Reset the palette to the built-in ember',
        onClick: () => {
          theme.clearCustomInline();
          try { localStorage.removeItem('trycord.theme.tokens'); } catch { /* session-only */ }
          theme.applyTheme();
          statusLine.replaceChildren(el('span', { class: 'ok-line' }, 'Back to the built-in ember.'));
          for (const node of inputs) {
            const input = node.querySelector('input');
            const def = CUSTOM_TOKEN_DEFS[inputs.indexOf(node)];
            if (input && def) input.value = DEFAULT_CUSTOM_TOKENS[def.key];
          }
        },
      }, 'Reset')));
}

function densityControls() {
  const current = readPrefs().density;
  return el('div', { class: 'density-row' },
    DENSITIES.map((name) => el('button', {
      class: 'btn btn--ghost btn--sm' + (current === name ? ' is-current' : ''),
      type: 'button', 'aria-pressed': String(current === name), 'data-density-choice': name,
      onClick: () => {
        patchPrefs({ density: name });
        applyDensity();
      },
    }, name.charAt(0).toUpperCase() + name.slice(1))));
}

// The arrangement: which regions of the workspace are shown. Each one is a
// switch, and the choice is remembered for this account.
const REGION_LABEL = {
  rail: ['Communities rail', 'The strip of communities down the left.'],
  column: ['Place column', 'The navigation beside the page: the places you can go.'],
  inspector: ['Side panel', 'The panel that opens beside the page, with the roster in it.'],
};

function regionControls() {
  const prefs = readPrefs();
  return el('div', { class: 'layout-regions' },
    REGIONS.map((region) => {
      const [label, description] = REGION_LABEL[region];
      const control = switchControl(prefs.regions[region] !== false, (on) => {
        const next = Object.assign({}, readPrefs().regions, { [region]: on });
        rememberRegions(next);
      }, label);
      return fieldRow(label, description, control);
    }));
}

// The reading column's width. The grip in the workspace does the same thing
// with the pointer; this is the same number, written down.
function stageWidthControl() {
  const prefs = readPrefs();
  const value = el('span', { class: 'layout-value' }, prefs.stageWidth + ' px');
  const slider = el('input', {
    class: 'layout-width', type: 'range',
    min: String(STAGE_MIN), max: String(STAGE_MAX), step: '20',
    value: String(prefs.stageWidth),
    'aria-label': 'The width of the reading column',
  });
  slider.addEventListener('input', () => {
    value.textContent = slider.value + ' px';
    rememberStageWidth(Number(slider.value));
  });
  return el('div', { class: 'layout-widths' }, slider, value);
}

// The motion the reader asked for, as it is stored: the choice wins over what
// the system asks for, because the reader made it on purpose.
function storedMotion() {
  try { return localStorage.getItem('trycord-motion') || ''; } catch { return ''; }
}

export function appearanceView() {
  const stored = storedMotion();
  const asked = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
  const reduce = switchControl(
    stored ? stored === 'reduced' : asked,
    async (on) => {
      document.documentElement.dataset.motion = on ? 'reduced' : '';
      try { localStorage.setItem('trycord-motion', on ? 'reduced' : ''); } catch { /* session only */ }
      toast(on ? 'The animation is turned down' : 'The animation is back');
    },
    'Less motion');

  const statusLine = el('p', { class: 'palette-status', role: 'status', 'aria-live': 'polite' });
  // What is marked current is the stored choice, not the resolved attribute:
  // 'custom' resolves visually to the default palette but stays a choice.
  const currentId = (() => {
    try { return localStorage.getItem('trycord.theme') || 'trycord'; } catch { return 'trycord'; }
  })();

  return {
    node: fold([
      head({
        kicker: 'Preferences',
        title: 'Appearance',
        lede: 'Colours, and how much happens on screen.',
      }),
      card({
        label: 'Colours', glyph: 'palette',
        body: fold([
          el('div', { class: 'theme-row' },
            THEMES.filter((t) => t.id !== 'custom')
              .map((t) => themeChoice(t.id, t.label, currentId))),
          el('div', { class: 'palette-guide' }, 'Or bring your own: set the four colours below, then install it. A palette is only installed if the shell survives it.'),
          paletteControls(statusLine),
          statusLine,
        ]),
      }),
      card({
        label: 'Density', glyph: 'equal',
        rows: [el('div', {},
          el('p', { class: 'card-note' }, 'How tall rows are and how much air they carry.'),
          densityControls())],
      }),
      card({
        label: 'Arrangement', glyph: 'sidebar',
        rows: [el('div', {},
          el('p', { class: 'card-note' }, 'Which parts of the workspace are shown.'),
          regionControls())],
      }),
      card({
        label: 'Reading column', glyph: 'monitor',
        rows: [el('div', {},
          el('p', { class: 'card-note' }, 'How wide the conversation is. The grip on the stage does the same.'),
          stageWidthControl())],
      }),
      card({
        label: 'Motion', glyph: 'wind',
        rows: [fieldRow('Less motion', 'Backgrounds stop drifting; nothing slides in.', reduce)],
      }),
    ]),
    onMount: null,
    cleanup() {},
  };
}

export function backendView() {
  const body = el('div', { class: 'anticipation-line' });

  return {
    node: fold([
      head({
        kicker: 'Preferences',
        title: 'Connection',
        lede: 'Which backend this client speaks to, and how healthy it is.',
      }),
      card({ label: 'The connection', glyph: 'server', body }),
    ]),
    onMount: async () => {
      try {
        const [instance, status] = await Promise.all([
          Api.instance(),
          Api.instanceSettingsStatus(),
        ]);
        body.replaceChildren(fold([
          facts([
            { value: (instance && (instance.name || instance.instance_name)) || 'This instance', label: 'server' },
            { value: status && status.database ? 'healthy' : 'unknown', label: 'storage' },
          ]),
          blank({
            glyph: 'check',
            title: 'Everything answers',
            text: 'The client is reading ' + (instance && instance.version
              ? 'build ' + instance.version : 'from the instance') + ', and the connection is fresh.',
          }),
        ]));
      } catch (e) {
        body.replaceChildren(fold([fault(e, null)]));
      }
    },
    cleanup() {},
  };
}

export function updatesView() {
  const body = el('div', { class: 'anticipation-line' });

  return {
    node: fold([
      head({
        kicker: 'Preferences',
        title: 'This build',
        lede: 'What is running, and how fresh it is.',
      }),
      card({ label: 'The build', glyph: 'info', body }),
    ]),
    onMount: async () => {
      try {
        // The build this client talks to is the one the server reports: the
        // number is read from the instance, never written into this file.
        const instance = await Api.instance();
        const built = instance && (instance.version || instance.build);
        body.replaceChildren(fold([
          facts([
            { value: built || 'unknown', label: 'version' },
            { value: (instance && instance.apiVersion) || 'unknown', label: 'api' },
            { value: (instance && instance.protocolVersion) || 'unknown', label: 'protocol' },
            { value: (instance && instance.name) || 'this instance', label: 'instance' },
          ]),
          blank({
            glyph: 'refresh',
            title: 'A reload keeps the session',
            text: 'Reloading picks up whatever shipped since this tab was opened; the session and the settings stay.',
          }),
        ]));
      } catch (e) {
        body.replaceChildren(fold([fault(e, null)]));
      }
    },
    cleanup() {},
  };
}
