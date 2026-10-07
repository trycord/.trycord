import Api from '../api.js';
import { el, btn, clear, toast, confirmDialog, fullTime } from '../ui.js';
import { emptyState } from '../components.js';

export async function renderAnnouncements(body, show, seq) {
  const listWrap = el('div', { class: 'admin-list' });
  const editor = el('div', { class: 'admin-block' });

  const text = el('textarea', { class: 'input', rows: 3, maxlength: 500, placeholder: 'What should everyone on this instance know?' });
  const level = el('select', { class: 'input' },
    el('option', { value: 'info' }, 'Info'),
    el('option', { value: 'warning' }, 'Warning'),
    el('option', { value: 'critical' }, 'Critical'));
  const linkLabel = el('input', { class: 'input', type: 'text', maxlength: 64, placeholder: 'Link text (optional)' });
  const linkHref = el('input', { class: 'input', type: 'text', placeholder: '/support' });
  const expires = el('input', { class: 'input', type: 'datetime-local' });
  const err = el('div', { class: 'form-error', hidden: true });
  const save = el('button', { class: 'btn primary', type: 'button' }, 'Publish banner');

  const form = el('form', { class: 'settings-form' },
    el('div', { class: 'field' }, el('label', {}, 'Message'), text,
      el('span', { class: 'hint' }, 'Shown to every signed-in user on this instance until you retire it.')),
    el('div', { class: 'field' }, el('label', {}, 'Level'), level),
    el('div', { class: 'field' }, el('label', {}, 'Link label'), linkLabel),
    el('div', { class: 'field' }, el('label', {}, 'Link'), linkHref,
      el('span', { class: 'hint' }, 'An in-app path, e.g. /support. Leave empty for no link.')),
    el('div', { class: 'field' }, el('label', {}, 'Expires'), expires,
      el('span', { class: 'hint' }, 'Optional. Leave empty to run until you retire it.')),
    err,
    el('div', {}, save));

  save.addEventListener('click', async () => {
    err.hidden = true;
    save.disabled = true;
    try {
      await Api.createAnnouncement({
        body: text.value,
        level: level.value,
        linkLabel: linkLabel.value,
        linkHref: linkHref.value,
        expiresAt: expires.value ? new Date(expires.value).toISOString() : null,
      });
      text.value = ''; linkLabel.value = ''; linkHref.value = ''; expires.value = '';
      await loadList();
    } catch (ex) {
      err.hidden = false;
      err.textContent = (ex && ex.message) || 'Could not publish the banner.';
    } finally { save.disabled = false; }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); save.click(); });

  editor.appendChild(el('div', { class: 'section-label' }, 'New banner'));
  editor.appendChild(form);

  const rowFor = (a) => {
    const row = el('div', { class: 'card card--list--row' });
    const main = el('div', { class: 'grow' });
    main.appendChild(el('div', { class: 'admin-name' }, a.body));
    const meta = [a.level, a.expiresAt ? 'expires ' + fullTime(a.expiresAt) : 'no expiry'];
    main.appendChild(el('div', { class: 'muted small' }, meta.join(' · ') + (a.active ? '' : ' · retired')));
    row.appendChild(main);

    const acts = el('div', { class: 'card--list__actions' });
    acts.appendChild(el('button', {
      class: 'btn sm ' + (a.active ? 'ghost' : 'primary'), type: 'button',
      onClick: async () => {
        try { await Api.updateAnnouncement(a.id, { active: !a.active }); await loadList(); }
        catch (ex) { toast(ex.message || 'Could not update.', 'error'); }
      },
    }, a.active ? 'Retire' : 'Republish'));
    acts.appendChild(el('button', {
      class: 'btn sm danger', type: 'button',
      onClick: () => confirmDialog({
        title: 'Delete this banner?', message: 'It disappears for everyone immediately.',
        danger: true, confirmText: 'Delete',
        onConfirm: async () => {
          try { await Api.deleteAnnouncement(a.id); await loadList(); }
          catch (ex) { toast(ex.message || 'Could not delete.', 'error'); }
        },
      }),
    }, 'Delete'));
    row.appendChild(acts);
    return row;
  };

  const loadList = async () => {
    let all = [];
    try { all = await Api.allAnnouncements(); }
    catch (ex) { listWrap.appendChild(emptyState('', 'Could not load banners.', (ex && ex.message) || '')); return; }
    clear(listWrap);
    if (!all || !all.length) {
      listWrap.appendChild(emptyState('', 'No banners yet.', 'Publish one above to notify everyone on this instance.'));
      return;
    }
    for (const a of all) listWrap.appendChild(rowFor(a));
  };

  show(el('div', { class: 'admin-block admin-block--sections' },
    editor,
    el('div', { class: 'admin-block' },
      el('div', { class: 'section-label' }, 'Published banners'),
      listWrap)));
  await loadList();
}
