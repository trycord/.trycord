// appearance — part of the account settings tree.
//
// Split out of the single 1,288-line module that held all eight tabs. Each tab
// is its own page; keeping them in one file meant opening the whole settings
// surface to change the appearance picker.

import { el, clear, toast } from '../ui.js';
import { renderContextHeader } from '../shell.js';
import { THEMES, getTheme, setTheme, loadPalette, savePalette, applyCustomPalette, CUSTOM_TOKEN_DEFS, DEFAULT_CUSTOM_TOKENS, loadCustomTheme, saveCustomTheme, serializeCustomTheme, parseCustomTheme, validateCustomCss, applyCustomTheme, recoverToEmber } from '../theme.js';

export function renderAppearance(wrap) {
  const active = getTheme();
  wrap.appendChild(el('div', { class: 'section-label' }, 'Theme'));
  const grid = el('div', { class: 'theme-grid' });
  for (const t of THEMES) {
    const b = el('button', {
      type: 'button',
      class: 'theme-chip' + (t.id === active ? ' active' : ''),
      'data-theme': t.id,
      'aria-pressed': t.id === active ? 'true' : 'false',
    });
    const sw = el('span', { class: 'theme-chip-swatch', 'data-theme': t.id });
    const name = el('strong', {}, t.label);
    const desc = el('span', { class: 'muted small' }, t.blurb);
    b.appendChild(sw);
    b.appendChild(el('span', { class: 'theme-chip-label' }, name, desc));
    b.addEventListener('click', () => {
      setTheme(t.id);
      for (const c of grid.querySelectorAll('.theme-chip')) {
        const on = c.getAttribute('data-theme') === t.id;
        c.classList.toggle('active', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (t.id === 'custom') {
        customPanel.hidden = false;
        refreshCustom();
      } else {
        customPanel.hidden = true;
      }
      renderContextHeader({ title: 'Settings', sub: 'Your account and preferences' });
    });
    grid.appendChild(b);
  }
  wrap.appendChild(grid);
  wrap.appendChild(el('p', { class: 'muted small' }, 'Themes override design tokens. Switching applies immediately and persists for this device.'));

  const customPanel = el('div', { class: 'theme-custom', hidden: active !== 'custom' });
  const palette = loadPalette();
  const accentInput = el('input', { type: 'color', class: 'input', value: /^#[0-9a-f]{6}$/i.test(palette.accent) ? palette.accent : '#ff914d' });
  const toneDark = el('button', { type: 'button', class: 'btn ' + (palette.tone === 'light' ? 'ghost' : 'active') }, 'Dark base');
  const toneLight = el('button', { type: 'button', class: 'btn ' + (palette.tone === 'light' ? 'active' : 'ghost') }, 'Light base');
  const refreshCustom = () => {
    const p = loadPalette();
    accentInput.value = /^#[0-9a-f]{6}$/i.test(p.accent) ? p.accent : '#ff914d';
    toneDark.classList.toggle('active', p.tone !== 'light');
    toneDark.classList.toggle('ghost', p.tone === 'light');
    toneLight.classList.toggle('active', p.tone === 'light');
    toneLight.classList.toggle('ghost', p.tone !== 'light');
  };
  accentInput.addEventListener('input', () => {
    savePalette({ accent: accentInput.value, tone: loadPalette().tone });
    if (getTheme() === 'custom') applyCustomPalette(loadPalette());
  });
  const chooseTone = (tone) => {
    savePalette({ accent: loadPalette().accent, tone });
    if (getTheme() === 'custom') applyCustomPalette(loadPalette());
    refreshCustom();
  };
  toneDark.addEventListener('click', () => chooseTone('dark'));
  toneLight.addEventListener('click', () => chooseTone('light'));
  customPanel.appendChild(el('div', { class: 'field' }, el('label', {}, 'Accent color'), accentInput));
  customPanel.appendChild(el('div', { class: 'field' }, el('label', {}, 'Base tone'), el('div', { class: 'row-line' }, toneDark, toneLight)));
  customPanel.appendChild(el('p', { class: 'muted small' }, 'Two inputs derive the full custom theme (surfaces, text, ambient). Semantic colors stay from the base palette.'));
  wrap.appendChild(customPanel);
  renderThemeStudio(wrap);
}

export function renderThemeStudio(wrap) {
  const studio = el('div', { class: 'theme-studio' });
  studio.appendChild(el('div', { class: 'section-label' }, 'Custom theme studio'));
  studio.appendChild(el('p', { class: 'muted small' },
    'Guided controls adjust the Custom theme safely. Advanced CSS allows deep visual restyling, but structural layout, navigation, and safety surfaces are protected and unsafe CSS is rejected.'));

  const state = loadCustomTheme();
  const tokens = Object.assign({}, DEFAULT_CUSTOM_TOKENS, state.tokens || {});

  const grid = el('div', { class: 'theme-studio__row' });
  for (const def of CUSTOM_TOKEN_DEFS) {
    const select = el('select', { class: 'input' });
    for (const opt of def.options) {
      const o = el('option', { value: opt }, opt);
      if (tokens[def.key] === opt) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', () => {
      tokens[def.key] = select.value;
      const next = saveCustomTheme({ tokens, css: cssInput.value });
      if (getTheme() === 'custom') {
        const res = applyCustomTheme(next);
        paintErrors(res);
        if (res.ok) toast('Custom theme updated.', 'ok');
      }
    });
    grid.appendChild(el('div', { class: 'field' }, el('label', {}, def.label), select));
  }
  studio.appendChild(grid);

  const cssInput = el('textarea', {
    class: 'theme-studio__css',
    spellcheck: 'false',
    placeholder: '/* Advanced visual CSS. Structural layout, navigation, and safety surfaces are protected. */',
  }, state.css || '');
  studio.appendChild(el('div', { class: 'field' }, el('label', {}, 'Advanced CSS (visual properties only)'), cssInput));

  const errorsBox = el('div', { class: 'theme-studio__errors' });
  const paintErrors = (res) => {
    clear(errorsBox);
    const problems = [...(res.errors || []), ...(res.problems || [])];
    if (!problems.length && res.ok) {
      errorsBox.appendChild(el('div', { class: 'form-success' }, 'Custom theme is valid and active.'));
      return;
    }
    for (const p of problems.slice(0, 8)) errorsBox.appendChild(el('div', { class: 'form-error' }, p));
  };
  studio.appendChild(errorsBox);

  const actions = el('div', { class: 'row-line' });
  const validateBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Validate');
  validateBtn.addEventListener('click', () => {
    paintErrors(validateCustomCss(cssInput.value));
  });
  const applyBtn = el('button', { class: 'btn primary', type: 'button' }, 'Apply and save');
  applyBtn.addEventListener('click', () => {
    const next = saveCustomTheme({ tokens, css: cssInput.value });
    setTheme('custom');
    const res = applyCustomTheme(next);
    paintErrors(res);
    if (res.ok) toast('Custom theme applied.', 'ok');
    else toast('Custom theme rejected; Ember restored.', 'error');
  });
  const resetBtn = el('button', { class: 'btn danger', type: 'button' }, 'Reset to Ember');
  resetBtn.addEventListener('click', () => {
    recoverToEmber();
    toast('Ember theme restored.', 'ok');
  });
  const exportBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Export');
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([serializeCustomTheme({ tokens, css: cssInput.value })], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'trycord-custom-theme.json' });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  const importBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Import');
  // Hidden, and so announced by nothing unless named. The visible buttons are
  // what a reader uses; this is only the mechanism behind them.
  const fileInput = el('input', {
    type: 'file', accept: '.json,.css,.txt', hidden: true,
    'aria-label': 'Choose a file to import',
  });
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        let next;
        try { next = parseCustomTheme(reader.result); }
        catch { next = { tokens, css: String(reader.result || '') }; }
        const check = validateCustomCss(next.css);
        if (!check.ok) { paintErrors(check); return; }
        saveCustomTheme(next);
        cssInput.value = next.css || '';
        setTheme('custom');
        const res = applyCustomTheme(next);
        paintErrors(res);
        if (res.ok) toast('Custom theme imported.', 'ok');
      } catch (ex) {
        paintErrors({ ok: false, errors: [ex.message || 'Import failed.'] });
      }
      fileInput.value = '';
    };
    reader.readAsText(file);
  });
  actions.append(validateBtn, applyBtn, resetBtn, exportBtn, importBtn, fileInput);
  studio.appendChild(actions);
  wrap.appendChild(studio);
}

export default { renderAppearance, renderThemeStudio };
