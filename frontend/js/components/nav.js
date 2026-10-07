import { el, icon } from '../ui.js';
import { communityMark } from './media.js';

// The three row shapes the navigations are built from.
//
// Every list in the application is one of these, so every list aligns the same way.

export function navGroup({ label, collapsible = false, collapsed = false, action = null, id = null }) {
  const group = el('section', { class: 'nav-group' + (collapsible ? ' nav-group--collapsible' : ''), dataset: id ? { group: id } : {} });
  if (label) {
    const head = el('div', {
      class: 'nav-group__head',
      role: collapsible ? 'button' : null,
      tabindex: collapsible ? '0' : null,
      'aria-expanded': collapsible ? (collapsed ? 'false' : 'true') : null,
    });
    if (collapsible) {
      head.appendChild(el('span', { class: 'nav-group__caret' }, icon('chevronDown')));
    }
    head.appendChild(el('span', { class: 'nav-group__label' }, label));
    if (action) head.appendChild(action);
    if (collapsible) {
      let onToggle = null;
      const toggle = () => {
        const next = !group.classList.contains('is-collapsed');
        group.classList.toggle('is-collapsed', next);
        head.setAttribute('aria-expanded', next ? 'false' : 'true');
        if (typeof onToggle === 'function') onToggle(next);
      };
      group.onToggleChange = (fn) => { onToggle = fn; };
      head.addEventListener('click', (e) => {
        if (action && e.target.closest('.nav-group__action')) return;
        toggle();
      });
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
      if (collapsed) group.classList.add('is-collapsed');
    }
    group.appendChild(head);
  }
  const list = el('div', { class: 'nav-group__list' });
  group.appendChild(list);
  group.list = list;
  return group;
}

export function navRow({ label, sub, icon, href, active, count, onClick }) {
  const row = el('button', {
    class: 'row row--nav' + (active ? ' active' : ''),
    type: 'button',
    title: label,
    'aria-label': label,
    'aria-current': active ? 'page' : null,
    dataset: { nav: label.toLowerCase().replace(/\s+/g, '-') },
    onClick: onClick,
  });
  if (icon) row.appendChild(el('span', { class: 'nv-icon' }, icon));
  const labelWrap = el('span', { class: 'nv-label' }, label);
  if (sub) labelWrap.append(' ', el('small', { class: 'muted' }, sub));
  row.appendChild(labelWrap);
  if (count && count > 0) row.appendChild(el('span', { class: 'nv-count' }, count > 99 ? '99+' : count));
  if (href) row.setAttribute('data-href', href);
  return row;
}

// A community in the rail: the mark, and the community's name under it.
//
// The name is the point. The rail used to be glyphs only, which made it a
// column of shapes to be memorised - a first-time user could not tell which
// community they were looking at without hovering each one, and the hover
// tooltip is not a label. The mark carries the community's own colour and icon;
// the word beneath it says what it is, and it ellipsises rather than truncating
// mid-glyph.
export function serverChip(server, { active = false, onClick } = {}) {
  const name = server.name || 'Community';
  const chip = el('button', {
    class: 'rail-community' + (active ? ' is-active' : ''),
    type: 'button',
    title: name,
    'aria-label': name,
    'aria-current': active ? 'page' : null,
    onClick,
    dataset: { serverId: server.id },
  });
  const mark = el('span', { class: 'rail-mark' });
  mark.appendChild(communityMark(name, { server }));
  chip.appendChild(mark);
  chip.appendChild(el('span', { class: 'rail-community__name' }, name));
  if (server.is_owner) {
    chip.title = name + ' — you own this community';
  }
  return chip;
}
