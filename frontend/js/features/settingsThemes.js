// Settings: the theme packages this instance runs.
//
// A theme package is a set of values with a schema version, not code. This
// screen imports one, shows what it would change before it is applied, and
// rolls back to the theme that was in force before the last change.
//
// The rule that holds for a hand-authored palette holds here too: a theme
// that breaks the shell is refused and the previous theme is restored. The
// shell is measured before the package is sent, so a theme that cannot
// survive never reaches the instance.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import theme, { previewThemePackage, validateThemePackage, CUSTOM_TOKEN_DEFS } from '../../packages/theme.js';
import { head, card, row, blank, fault, fold, facts } from '../ui/page.js';
import { openDialog, errorToast, toast } from '../ui/overlays.js';

// One token, before and after.
function changeRow(change) {
  return el('div', { class: 'theme-change' },
    el('span', { class: 'theme-change-label' }, change.label),
    el('span', { class: 'theme-change-pair' },
      el('span', { class: 'theme-change-swatch', style: { background: change.from } }),
      el('code', { class: 'theme-change-value' }, change.from || '—'),
      icon('arrow-right', { size: 13 }),
      el('span', { class: 'theme-change-swatch', style: { background: change.to } }),
      el('code', { class: 'theme-change-value' }, change.to)));
}

// The preview: what the package would change, seen before it is applied.
function previewPanel(pkg) {
  const current = theme.loadPalette() || theme.DEFAULT_CUSTOM_TOKENS;
  const preview = previewThemePackage(pkg, current);
  if (!preview.ok) {
    return el('div', { class: 'theme-preview' },
      el('p', { class: 'form-error', role: 'alert' }, 'This package was refused:'),
      el('ul', { class: 'theme-problems' },
        preview.problems.map((problem) => el('li', {}, problem))));
  }
  if (!preview.changes.length) {
    return el('div', { class: 'theme-preview' },
      el('p', { class: 'form-note' },
        'This package sets the colours that are already in force. Applying it changes nothing here.'));
  }
  return el('div', { class: 'theme-preview' },
    el('p', { class: 'form-note' },
      preview.theme.name + ' ' + preview.theme.version
      + ' would change ' + preview.changes.length + ' colour'
      + (preview.changes.length === 1 ? '' : 's') + ':'),
    el('div', { class: 'theme-changes' }, preview.changes.map(changeRow)));
}

// The import dialog: the package, the preview, and the decision.
function openImport(onApplied) {
  const text = el('textarea', {
    class: 'textarea theme-package', rows: '8', spellcheck: 'false',
    'aria-label': 'The theme package',
    placeholder: '{ "schemaVersion": 1, "name": "Ember", "version": "1.0.0", "tokens": { "accent": "#FF4D24" } }',
  });
  const file = el('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', 'aria-label': 'Choose a theme package file' });
  const preview = el('div', { class: 'theme-preview-holder' });
  const note = el('p', { class: 'form-note', role: 'status', 'aria-live': 'polite' });

  const applyButton = el('button', {
    class: 'btn btn--primary btn--sm', type: 'submit', disabled: 'true',
  }, 'Apply it');

  const dialog = openDialog({
    title: 'Import a theme package',
    sub: 'A package is values, not code. A package that carries anything else is refused.',
    body: el('form', {
      class: 'form-stack', onSubmit: async (event) => {
        event.preventDefault();
        let pkg = null;
        try {
          pkg = JSON.parse(text.value);
        } catch (error) {
          note.textContent = 'That is not a package this build can read: ' + error.message;
          return;
        }
        const checked = validateThemePackage(pkg);
        if (checked.problems.length) {
          note.textContent = 'This package was refused: ' + checked.problems.join('; ');
          return;
        }
        await applyPackage(pkg, dialog, onApplied);
      },
    },
    text,
    file,
    el('div', { class: 'formfoot' },
      el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: () => file.click(),
      }, icon('upload', { size: 14 }), 'Choose a file'),
      el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        onClick: () => {
          try {
            const pkg = JSON.parse(text.value);
            preview.replaceChildren(previewPanel(pkg));
            applyButton.disabled = false;
            note.textContent = '';
          } catch (error) {
            note.textContent = 'That is not a package this build can read: ' + error.message;
          }
        },
      }, 'Preview it')),
    preview,
    note,
    el('div', { class: 'formfoot' }, applyButton)),
  });

  file.addEventListener('change', () => {
    const chosen = file.files && file.files[0];
    if (!chosen) return;
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      text.value = String(reader.result || '');
      try {
        const pkg = JSON.parse(text.value);
        preview.replaceChildren(previewPanel(pkg));
        applyButton.disabled = false;
        note.textContent = '';
      } catch (error) {
        note.textContent = 'That file is not a package this build can read.';
      }
    });
    reader.readAsText(chosen);
  });

  text.focus();
  return dialog;
}

// Apply a package.
//
// The shell is measured first: a theme that cannot survive is refused here and
// never sent, so the instance is not left running a theme that hides the
// interface. If the server refuses a package the client accepted, the
// previous theme is put back here as well.
async function applyPackage(pkg, dialog, onApplied) {
  const previous = theme.loadPalette();
  const tokens = pkg.tokens || {};
  const applied = theme.applyThemePackage(tokens);
  if (!applied.ok) {
    theme.applyCustomPalette(previous || theme.DEFAULT_CUSTOM_TOKENS);
    theme.applyTheme();
    errorToast(new Error('Refused: ' + (applied.problems || []).join('; ')));
    return;
  }
  try {
    await Api.importTheme({ theme: pkg });
    dialog.close();
    toast('The theme is in force');
    if (onApplied) onApplied();
  } catch (error) {
    theme.applyCustomPalette(previous || theme.DEFAULT_CUSTOM_TOKENS);
    theme.applyTheme();
    errorToast(error);
  }
}

export function themePackages() {
  const body = el('div', { class: 'fold fold--tight' });
  const installed = el('div', { class: 'rowlist' });

  async function paint() {
    body.replaceChildren(el('p', { class: 'holdline', 'aria-busy': 'true' }, 'Reading the themes'));
    installed.replaceChildren();
    try {
      const answer = await Api.themes();
      const schema = (answer && answer.schema) || {};
      const active = answer && answer.active;
      const themes = Array.isArray(answer && answer.themes) ? answer.themes : [];

      body.replaceChildren(fold([
        facts([
          { value: active ? active.name : 'the built-in ember', label: 'in force' },
          { value: active ? active.version : '—', label: 'version' },
          { value: (schema.knownSchemaVersions || []).join(', ') || '—', label: 'schema' },
        ]),
        active && active.tokens
          ? el('div', { class: 'theme-tokens' }, Object.keys(active.tokens).map((key) => {
            const def = CUSTOM_TOKEN_DEFS.find((entry) => entry.key === key);
            return el('span', { class: 'theme-token' },
              el('span', { class: 'theme-change-swatch', style: { background: active.tokens[key] } }),
              el('span', {}, (def ? def.label : key) + ': ' + active.tokens[key]));
          }))
          : null,
        el('p', { class: 'card-note' },
          'A package this build does not know is refused, and a package that carries '
          + 'anything but colours is refused too. A theme that breaks the shell is '
          + 'refused here, before it is sent.'),
        el('div', { class: 'formfoot' },
          el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: () => openImport(paint),
          }, icon('upload', { size: 14 }), 'Import a package'),
          el('button', {
            class: 'btn btn--ghost btn--sm', type: 'button',
            onClick: () => rollback(paint),
          }, 'Roll back')),
      ], { tight: true }));

      installed.replaceChildren(...(themes.length ? themes.map((entry) => row({
        class: 'theme-row-item',
        lead: el('span', { class: 'language-glyph' }, icon('image', { size: 15 })),
        title: entry.name,
        sub: 'version ' + (entry.version || '?') + ' · schema ' + (entry.schemaVersion || '?')
          + ' · ' + (entry.scope === 'community' ? 'a community' : 'the instance'),
        side: el('span', { class: 'badge' }, entry.state || 'active'),
      })) : [blank({
        glyph: 'image',
        title: 'No theme packages installed',
        text: 'Import one to bring a palette of values from somewhere else.',
      })]));
    } catch (error) {
      body.replaceChildren(fault(error, paint));
    }
  }

  // Go back to the theme that was in force before the last change.
  async function rollback(repaint) {
    try {
      const back = await Api.rollbackTheme();
      const tokens = back && back.tokens;
      if (tokens && Object.keys(tokens).length) {
        const applied = theme.applyThemePackage(tokens);
        if (!applied.ok) {
          theme.applyCustomPalette(theme.DEFAULT_CUSTOM_TOKENS);
          theme.applyTheme();
        }
      } else {
        theme.clearCustomInline();
        theme.applyTheme();
      }
      toast('The previous theme is in force again');
      await repaint();
    } catch (error) {
      errorToast(error);
    }
  }

  return {
    node: fold([
      head({
        kicker: 'Preferences',
        title: 'Theme packages',
        lede: 'A theme is values, not code.',
      }),
      card({ label: 'This instance', glyph: 'image', body }),
      card({ label: 'Installed packages', glyph: 'layers', flush: true, body: installed }),
    ]),
    onMount: paint,
    cleanup() {},
  };
}

export default { themePackages };
