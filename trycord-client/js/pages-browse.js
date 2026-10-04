
import Api from './api.js';
import { esc, el, clear, icon, plural, toast } from './ui.js';
import State, { refreshServers, isAuthed } from './state.js';
import { renderContextHeader } from './shell.js';
import { communityMark } from './components.js';
import { navigate } from './nav.js';

let page = 1;
let pages = 1;
let total = 0;
let query = '';

async function fetchPage(increment) {
  const res = await Api.discover({ q: query, page, limit: 12 });
  page = res.page || page;
  pages = res.pages || 1;
  total = res.total || 0;
  return res.items || [];
}

function serverCard(s, onClick) {
  const c = el('div', { class: 'stack' });
  const btn = el('button', {
    class: 'row row--surface', type: 'button',
    onClick,
  });
  const b = communityMark(s.name || '?', { server: s });
  btn.appendChild(b);
  const m = el('div', { class: 'row-main' });
  m.appendChild(el('div', { class: 'row-title' }, s.name));
  m.appendChild(el('div', { class: 'row-sub' }, esc(s.description || 'No description')));
  m.appendChild(el('div', { class: 'row-sub' }, plural(s.member_count || 0, 'member') + ' · ' + plural(s.channel_count || 0, 'channel')));
  btn.appendChild(m);
  c.appendChild(btn);
  return c;
}

export async function renderBrowse(container, { previewId } = {}) {
  clear(container);
  renderContextHeader({ title: 'Discover', sub: 'Public communities on this instance' });

  const wrap = el('div', { class: 'page' });

  const searchRow = el('div', { class: 'row-line' });
  const input = el('input', {
    class: 'input', type: 'search', placeholder: 'Search communities…', value: query,
    style: { flex: '1 1 320px' },
  });
  const goBtn = el('button', { class: 'btn', type: 'button' }, 'Search');
  searchRow.appendChild(input);
  searchRow.appendChild(goBtn);
  wrap.appendChild(searchRow);
  const resultMeta = el('div', { class: 'muted small', style: { margin: 'var(--t-d-2) 0' } });
  wrap.appendChild(resultMeta);

  const previewPane = el('div', { hidden: true, class: 'stack' });
  wrap.appendChild(previewPane);

  const listPane = el('div', { class: 'stack' });
  wrap.appendChild(listPane);

  async function showPreview(id) {
    let detail;
    try {
      detail = await Api.discoverServer(id);
    } catch (ex) {
      toast(ex.message || 'Cannot load community', 'error');
      return;
    }
    previewPane.hidden = false;
    clear(previewPane);
    previewPane.appendChild(el('h2', {}, esc(detail.name)));
    previewPane.appendChild(el('p', { class: 'muted' }, esc(detail.description || 'No description')));
    previewPane.appendChild(el('p', { class: 'muted small' },
      plural(detail.member_count || 0, 'member')));
    const ch = el('div', { class: 'stack' });
    for (const c of detail.channels || []) {
      ch.appendChild(el('div', { class: 'row row--channel', style: { marginLeft: 0, width: '100%' } },
        el('span', { class: 'ch-prefix' }, '#'), el('span', { class: 'ch-name' }, c.name)));
    }
    if (detail.channels && detail.channels.length) previewPane.appendChild(ch);
    if (isAuthed()) {
      const joinBtn = el('button', { class: 'btn primary', type: 'button' }, 'Join');
      joinBtn.addEventListener('click', async () => {
        joinBtn.setAttribute('aria-busy', 'true');
        try {
          await Api.joinDiscover(id);
          toast('Joined!', 'ok');
          await refreshServers();
          navigate('/home');
        } catch (ex) {
          toast(ex.message || 'Could not join', 'error');
          joinBtn.removeAttribute('aria-busy');
        }
      });
      previewPane.appendChild(el('div', {}, joinBtn));
    }
  }

  async function runSearch(gotoPage) {
    if (gotoPage !== undefined) page = gotoPage;
    listPane.setAttribute('aria-busy', 'true');
    clear(listPane);
    try {
      const items = await fetchPage(0);
      const searching = String(query || '').trim().length > 0;
      // One statement about the result, not two. 'No results' in the meta line and
      // 'Nothing here' in the panel said the same thing twice, in two different
      // voices, directly above each other.
      resultMeta.textContent = items.length
        ? total + (total === 1 ? ' community' : ' communities')
        : (searching ? 'No matches' : '');
      if (!items.length) {
        // An honest distinction: a search that found nothing is not the same as an
        // instance with nothing public on it, and the copy should say which happened.
        listPane.appendChild(el('div', { class: 'empty-state' },
          el('div', { class: 'es-icon' }, icon(searching ? 'search' : 'globe')),
          el('div', { class: 'empty-state__title' },
            searching ? 'Nothing matched that search' : 'No public communities here'),
          el('div', { class: 'empty-state__body' }, searching
            ? 'This instance has communities, just not ones matching that. Try a different word.'
            : 'This instance has not published any communities for anyone to discover. Ones you create stay private until you make them public.')));
      } else {
        for (const s of items) {
          listPane.appendChild(serverCard(s, () => showPreview(s.id)));
        }
      }
      if (pages > 1) {
        const pager = el('div', { class: 'row-line' });
        pager.appendChild(el('span', { class: 'small muted' }, 'Page ' + page + ' of ' + pages));
        const prevB = el('button', { class: 'btn sm', type: 'button', disabled: page <= 1 }, '← Newer');
        const nextB = el('button', { class: 'btn sm', type: 'button', disabled: page >= pages }, 'Older →');
        prevB.addEventListener('click', () => runSearch(page - 1));
        nextB.addEventListener('click', () => runSearch(page + 1));
        pager.appendChild(prevB);
        pager.appendChild(nextB);
        listPane.appendChild(pager);
      }
    } catch (ex) {
      resultMeta.textContent = '';
      listPane.appendChild(el('div', { class: 'form-error' }, ex.message || 'Search failed'));
    } finally {
      listPane.removeAttribute('aria-busy');
    }
  }

  goBtn.addEventListener('click', () => {
    query = input.value.trim();
    page = 1;
    runSearch(1);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { query = input.value.trim(); page = 1; runSearch(1); }
  });

  container.appendChild(wrap);
  await runSearch(1);
  if (previewId) showPreview(previewId);
}

export default { renderBrowse };
