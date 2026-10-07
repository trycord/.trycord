import { toggleContextSidebar } from './sidebar.js';
import { el, clear, qs, toast, relTime, confirmDialog, openModal, openReportDialog, attachMenu, attachContextMenu, showUserCard, copyText, announce } from '../ui.js';
import { avatar, icon, navRow, serverChip, navGroup } from '../components.js';
import { isDesktopNavOpen, openDesktopNav, closeDesktopNav } from '../presentation.js';

// The context header above a surface: its title, and what you can do there.

// `icon` is destructured to iconGlyph rather than bound as `icon`: the imported
// icon() below builds the navigation toggle, and a parameter of the same name
// shadowed it. Every caller omits it, so icon() resolved to undefined and threw
// "icon is not a function" on every single header render - which is every page.
// The public { icon } key is unchanged; only the local binding is renamed.
export function renderContextHeader({ title, sub, icon: iconGlyph, actions } = {}) {
  const header = qs('#context-header');
  if (!header) return;
  header.dataset.hasIcon = iconGlyph ? 'true' : 'false';
  clear(header);

  if (title) announce(title + (sub ? '. ' + sub : ''));

  const navToggle = el('button', {
    class: 'nav-toggle', type: 'button',
    title: 'Navigation', 'aria-label': 'Toggle navigation',
    'aria-expanded': isDesktopNavOpen() ? 'true' : 'false',
  }, icon('menu'));
  navToggle.addEventListener('click', () => toggleContextSidebar());
  header.appendChild(navToggle);

  const titles = el('div', { class: 'context-header__titles' });
  if (iconGlyph) titles.appendChild(el('div', { class: 'context-header__icon' }, iconGlyph));
  // The one h1 on every surface. It was a div, so no page in the application
  // had a top-level heading: someone navigating by heading found nothing to
  // land on, and the current view had no heading identifying it at all.
  titles.appendChild(el('h1', { class: 'context-title', id: 'context-title' },
    title || 'Trycord'));
  if (sub) titles.appendChild(el('div', { class: 'context-sub' }, sub));
  header.appendChild(titles);

  // Accepts one node or a list of them. Nineteen page modules call this, and
  // passing a bare element where a list was expected threw on the for-of, which
  // took the entire surface down to the error screen over one header button.
  // Normalised here so that cannot happen again.
  const list = actions == null ? [] : (Array.isArray(actions) ? actions : [actions]);
  const acts = el('div', { class: 'context-actions' });
  for (const a of list) if (a) acts.appendChild(a);
  if (acts.childNodes.length) header.appendChild(acts);

}
