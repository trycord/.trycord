// The inspector.
//
// The right-hand panel, and the only surface that shows context *about* what is
// on the stage rather than more of it: the roster beside a channel, activity
// beside the inbox. It holds tabs, and it remembers two things per screen kind -
// which tab was open and whether the panel itself was - so opening Members once
// opens Members on the next channel too.
//
// It slides over the stage's right edge rather than taking a column of its own,
// so opening it never reflows the conversation underneath.

import { el, clear } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import {
  readPrefs, rememberInspectorTab, rememberInspectorOpen, rememberInspectorWidth,
  regionEnabled, INSPECTOR_MIN, INSPECTOR_MAX,
} from '../prefs.js';
import { attachColumnResize } from './frame.js';

export function createInspector(refs) {
  let spec = null;
  let activeId = null;
  const cache = new Map();
  const tabs = () => (spec && spec.tabs) || [];
  const isOpen = () => refs.root.dataset.context === 'open';

  function setSpec(next) {
    // The panel that was on screen is torn down before the next one is built,
    // so a roster that listens for presence stops listening.
    if (spec && typeof spec.dispose === 'function') {
      try { spec.dispose(); } catch { /* a disposal must not stop the next panel */ }
    }
    spec = next && next.tabs && next.tabs.length ? next : null;
    cache.clear();
    activeId = null;
    clear(refs.inspectorHead);
    clear(refs.inspectorBody);
    if (!spec) { apply(false, false); return; }

    const remembered = readPrefs().inspectorTabs[spec.kind];
    activeId = tabs().some((tab) => tab.id === remembered) ? remembered
      : (spec.active && tabs().some((tab) => tab.id === spec.active) ? spec.active : tabs()[0].id);
    refs.inspectorHead.appendChild(tabStrip());
    refs.inspectorHead.appendChild(el('button', {
      class: 'icon-btn inspector-close', type: 'button', 'aria-label': 'Close panel',
      onClick: () => close(),
    }, icon('x', { size: 16 })));
    activate(activeId, false);
    apply(readPrefs().inspectorOpen.indexOf(spec.kind) !== -1, false);
  }

  function apply(open, remember) {
    // The reader may have taken the panel out of the arrangement; a panel that
    // is not in the arrangement does not open.
    const allowed = regionEnabled('inspector');
    const shown = open && allowed;
    refs.root.dataset.context = shown ? 'open' : 'closed';
    refs.inspector.hidden = !shown;
    // Whatever control on the stage opens this panel reports its state too, so
    // the disclosure is never a lie after the panel was closed from inside.
    for (const toggle of document.querySelectorAll('.context-toggle')) {
      toggle.setAttribute('aria-expanded', String(shown));
    }
    if (remember && spec) rememberInspectorOpen(spec.kind, shown);
    if (shown && activeId && !refs.inspectorBody.childNodes.length) activate(activeId, false);
  }

  function open() { if (spec) apply(true, true); }
  function close() { if (spec) apply(false, true); }
  function toggle() { if (spec) apply(!isOpen(), true); }

  function tabStrip() {
    const strip = el('div', { class: 'inspector-tabs', role: 'tablist', 'aria-label': 'Panel views' });
    for (const tab of tabs()) {
      strip.appendChild(el('button', {
        class: 'inspector-tab' + (tab.id === activeId ? ' is-active' : ''),
        type: 'button', role: 'tab',
        dataset: { tab: tab.id },
        'aria-selected': String(tab.id === activeId),
        onClick: () => activate(tab.id, true),
      },
        tab.icon ? icon(tab.icon, { size: 15 }) : null,
        el('span', { class: 'truncate' }, tab.label),
      ));
    }
    return strip;
  }

  function paintSelection() {
    for (const button of refs.inspectorHead.querySelectorAll('.inspector-tab')) {
      const selected = button.dataset.tab === activeId;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-selected', String(selected));
    }
  }

  function activate(id, remember) {
    const tab = tabs().find((entry) => entry.id === id);
    if (!tab) return;
    activeId = id;
    if (remember && spec) rememberInspectorTab(spec.kind, id);
    paintSelection();
    clear(refs.inspectorBody);

    const cached = cache.get(id);
    if (cached) { refs.inspectorBody.appendChild(cached); return; }

    let result;
    try {
      result = tab.render();
    } catch (error) {
      refs.inspectorBody.appendChild(note(error && error.message ? error.message : 'This panel could not be built.'));
      return;
    }
    if (result && typeof result.then === 'function') {
      refs.inspectorBody.appendChild(el('div', { class: 'inspector-loading' }, el('span', { class: 'spinner', role: 'status', 'aria-label': 'Loading' })));
      result.then((node) => {
        if (!node) return;
        cache.set(id, node);
        if (activeId === id && isOpen()) { clear(refs.inspectorBody); refs.inspectorBody.appendChild(node); }
      }).catch((error) => {
        if (activeId === id) { clear(refs.inspectorBody); refs.inspectorBody.appendChild(note(error && error.message ? error.message : 'This panel could not load.')); }
      });
      return;
    }
    if (result) { cache.set(id, result); refs.inspectorBody.appendChild(result); }
  }

  function note(text) {
    return el('div', { class: 'inspector-note' }, text);
  }

  attachColumnResize(refs.inspectorGrip, {
    root: refs.root,
    variable: '--inspector-w',
    min: INSPECTOR_MIN,
    max: INSPECTOR_MAX,
    sign: -1,
    remember: rememberInspectorWidth,
    fallback: readPrefs().inspectorWidth,
  });

  return {
    setSpec,
    open,
    close,
    // Close the panel without forgetting that the reader likes it open: the
    // panel is taken away by the arrangement, not by the reader.
    dismiss() { if (spec) apply(false, false); },
    toggle,
    isOpen,
    currentKind: () => (spec ? spec.kind : null),
  };
}
