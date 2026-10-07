import { el, clear, toast, btn } from '../ui.js';
import { isAuthed, clearSession } from '../state.js';
import { TrycordConfig } from '../config.js';
import Realtime from '../realtime.js';
// configured default. Switching backends while signed in drops the session
// (tokens belong to one backend) and reloads.
export function renderBackendSelector(mount) {
  clear(mount);
  const url = TrycordConfig.backendUrl();
  const source = TrycordConfig.backendSource();

  mount.appendChild(el('div', { class: 'section-label' }, 'Backend'));
  const current = el('div', { class: 'row-line', style: { marginBottom: 'var(--t-d-2)' } },
    el('span', { class: 'muted small', style: { overflowWrap: 'anywhere' } }, url),
    el('span', { class: 'badge' }, source));
  mount.appendChild(current);

  const input = el('input', { class: 'input', type: 'url', inputmode: 'url', value: url, placeholder: 'https://api.example.com' });
  const status = el('div', { class: 'muted small', 'aria-live': 'polite', style: { minHeight: '1.2em' } },
    'Default: the official backend. Point here at your own instance to self-host.');
  const row = el('div', { class: 'row-line', style: { marginTop: 'var(--t-d-2)' } });
  const saveBtn = el('button', { class: 'btn sm', type: 'button' }, 'Save');
  const testBtn = el('button', { class: 'btn ghost sm', type: 'button' }, 'Test connection');
  const resetBtn = el('button', { class: 'btn ghost sm', type: 'button' }, 'Reset to default');
  row.append(saveBtn, testBtn, resetBtn);
  mount.appendChild(el('div', { class: 'field' }, el('label', {}, 'Backend URL'), input, row, status));

  let testing = false;
  testBtn.addEventListener('click', async () => {
    if (testing) return;
    testing = true;
    testBtn.setAttribute('aria-busy', 'true');
    status.textContent = 'Testing connection…';
    const res = await TrycordConfig.testBackend(input.value.trim());
    testing = false;
    testBtn.removeAttribute('aria-busy');
    status.textContent = res.ok ? '● Connected — ' + res.name : res.error;
  });
  saveBtn.addEventListener('click', () => {
    const next = TrycordConfig.setApiUrl(input.value.trim());
    if (!next) {
      status.textContent = 'Enter a valid http(s) URL, e.g. https://api.example.com';
      return;
    }
    if (next === url && !isAuthed()) {
      status.textContent = 'Backend saved — ' + next;
      renderBackendSelector(mount);
      return;
    }
    if (isAuthed()) {
      // Sessions belong to one backend: sign out everywhere in this client
      try { Realtime.disconnect(); } catch { /* ignore */ }
      clearSession();
    }
    toast('Backend switched. Reloading…', 'ok');
    // into its CSP connect-src, so the rebooted page may actually reach it.
    // Hash routing is preserved.
    try {
      const u = new URL(location.href);
      u.searchParams.set('api', next);
      location.href = u.toString();
    } catch {
      location.reload();
    }
  });
  resetBtn.addEventListener('click', () => {
    TrycordConfig.resetBackend();
    if (isAuthed()) {
      try { Realtime.disconnect(); } catch { /* ignore */ }
      clearSession();
      toast('Backend reset. Reloading…', 'ok');
      try {
        const u = new URL(location.href);
        u.searchParams.delete('api');
        location.href = u.toString();
      } catch {
        location.reload();
      }
      return;
    }
    renderBackendSelector(mount);
    toast('Backend reset to default.', 'ok');
  });
}
