// The admin Pages section: the list of public pages and the editor that changes one.
//
// The editor hid the shell's context header for itself, which is a decision this file
// owns and one the list below needs undone - so the frame stays here rather than moving
// into either module.
//
//   pages/list.js    the list of pages
//   pages/blocks.js  the block vocabulary, and the editor for one page's blocks
//   pages/bbcode.js  the bbcode toolbar

import { el, clear } from '../ui.js';
import { renderContextHeader } from '../shell.js';
import { settingsFrame } from '../settings-shell.js';
import { sectionHead } from '../settings-ui.js';
import { pageEditor } from './pages/blocks.js';
import { pageList } from './pages/list.js';

export async function renderAdminPages(container, { route } = {}) {
  if (route) {
    pageEditor(container, route);
    return;
  }
  // The editor hid the shell's context header for itself. Leaving it set would take the
  // header away from the page list too, and from whatever the reader navigates to next.
  delete document.documentElement.dataset.fullpage;
  clear(container);
  renderContextHeader({ title: 'Pages', sub: 'Public pages an editor can change' });

  // Same frame as every other admin section, so Pages is not the one surface with the
  // nav stacked above the content instead of beside it.
  const { frame, pane: body } = settingsFrame({ scope: 'admin', active: 'pages', contentClass: 'admin-page' });
  const wrap = el('div', { class: 'page' }, frame);
  wrap.appendChild(sectionHead('Pages', 'Public pages an editor can change.'));
  body.appendChild(el('p', { class: 'muted small' },
    'These pages ship as templates. The sections describing what the software does are accurate as '
    + 'written; the fields marked OPERATOR are yours to fill in. Editing a draft does not change what '
    + 'visitors see until you publish it.'));
  const list = el('div', {});
  list.appendChild(pageList(() => {}));
  body.appendChild(list);
  wrap.appendChild(body);
  container.appendChild(wrap);
}

export default { renderAdminPages };