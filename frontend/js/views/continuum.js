// Community Continuum administration.
//
// The operator's console for federation: which remote instances this one
// exchanges events with, how much they trust each one, and whether delivery is
// succeeding. Continuum is opt-in — when it is disabled this page is not
// reachable at all.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { toast, errorToast } from '../ui.js';
import { panel, loading, failure, nothing } from './util.js';

// -- shared furniture --------------------------------------------------------

function actionButton(label, kind, onClick) {
  return el('button', { class: 'btn btn--' + kind + ' btn--sm', type: 'button', onClick }, label);
}

function trustBadge(status) {
  const kind = status === 'trusted' ? 'success' : status === 'blocked' ? 'danger' : 'warning';
  return el('span', { class: 'badge badge--' + kind }, status.charAt(0).toUpperCase() + status.slice(1));
}

function instanceRow(inst) {
  const btn = actionButton(
    inst.trust_status === 'trusted' ? 'Block' : 'Trust',
    inst.trust_status === 'trusted' ? 'danger' : 'success',
    () => {
      const nextStatus = inst.trust_status === 'trusted' ? 'blocked' : 'trusted';
      setTrust(inst.id, nextStatus);
    }
  );
  return el('tr',
    el('td', inst.name),
    el('td', { class: 'mono' }, inst.origin),
    el('td', trustBadge(inst.trust_status)),
    el('td', btn)
  );
}

function instancesTable(rows) {
  return el('table', { class: 'table' },
    el('thead', el('tr',
      el('th', 'Instance'),
      el('th', 'Origin'),
      el('th', 'Trust'),
      el('th', 'Actions'))),
    el('tbody', ...rows.map(instanceRow))
  );
}

let loadInstances = null;

// Build the Continuum admin section: remote instances and the add form.
// Returns a node the admin shell appends into its content area.
export function continuumSection() {
  const host = el('div', { class: 'settings-stack' });

  const instances = el('div', { class: 'stack' });
  const formHost = el('div', { class: 'stack' });

  loadInstances = async function load() {
    instances.replaceChildren(el('div', { class: 'stack' }, loading('Loading remote instances…')));
    let rows;
    try {
      rows = await Api.request('GET', '/api/continuum/instances');
    } catch (error) {
      instances.replaceChildren(failure(error, load));
      return;
    }
    if (!rows || !rows.length) {
      instances.replaceChildren(nothing('No remote instances yet. Add one below to begin federating.'));
    } else {
      instances.replaceChildren(instancesTable(rows));
    }
  };

  async function setTrust(id, status) {
    try {
      await Api.request('PATCH', '/api/continuum/instances/' + encodeURIComponent(id) + '/trust', { body: { trust_status: status } });
      toast('Trust updated.', { type: 'success' });
      loadInstances();
    } catch (error) { errorToast(error); }
  }

  // -- add instance form -------------------------------------------------------

  const nameInput = el('input', { class: 'input', placeholder: 'Remote instance name', maxLength: '128' });
  const originInput = el('input', { class: 'input', placeholder: 'https://remote.example.com', maxLength: '512' });
  const keyInput = el('textarea', { class: 'input', rows: '4', placeholder: '-----BEGIN PUBLIC KEY-----...', maxLength: '512' });
  const addError = el('div', { class: 'form-error' });
  const addBtn = el('button', { class: 'btn btn--primary', type: 'button' }, 'Add instance');

  addBtn.addEventListener('click', async () => {
    addError.textContent = '';
    if (!nameInput.value.trim()) { addError.textContent = 'Give the instance a name.'; return; }
    if (!originInput.value.trim()) { addError.textContent = 'Enter its origin URL.'; return; }
    if (!keyInput.value.trim()) { addError.textContent = 'Paste its public key.'; return; }
    addBtn.disabled = true;
    try {
      await Api.request('POST', '/api/continuum/instances', { body: {
        id: nameInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-'),
        name: nameInput.value.trim(),
        origin: originInput.value.trim(),
        public_key: keyInput.value.trim(),
      }});
      nameInput.value = ''; originInput.value = ''; keyInput.value = '';
      toast('Remote instance added. It starts untrusted; set it to Trust to exchange events.', { type: 'success' });
      loadInstances();
    } catch (error) { addError.textContent = error.message || 'That did not work.'; }
    finally { addBtn.disabled = false; }
  });

  const addForm = el('div', { class: 'stack' },
    fieldBlock('Name', 'Shown in lists.', nameInput),
    fieldBlock('Origin', 'The instance\'s origin URL, https:// or http://.', originInput),
    fieldBlock('Public key', 'Paste the remote instance\'s public key so its events can be verified.', keyInput),
    el('div', { class: 'stack' }, addError, addBtn)
  );
  const addPanel = panel({ title: 'Add a remote instance', body: addForm });

  host.replaceChildren(
    panel({ title: 'Remote instances', body: instances }),
    addPanel
  );

  loadInstances();

  return host;
}

function fieldBlock(label, hint, control) {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label' }, label),
    control,
    hint ? el('span', { class: 'field-hint' }, hint) : null);
}
