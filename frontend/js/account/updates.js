// updates — part of the account settings tree.
//
// Split out of the single 1,288-line module that held all eight tabs. Each tab
// is its own page; keeping them in one file meant opening the whole settings
// surface to change the appearance picker.

import { el } from '../ui.js';

let updatesUnsub = null;

export function renderUpdates(wrap) {
  const desk = (typeof window.trycordDesktop !== 'undefined') ? window.trycordDesktop : null;
  wrap.appendChild(el('div', { class: 'section-label' }, 'Application'));

  if (!desk) {
    const box = el('div', { class: 'card card--auth' });
    box.appendChild(el('p', {}, 'You are running Trycord in a browser. The browser build does not auto-update.'));
    box.appendChild(el('p', { class: 'muted small' }, 'The desktop app checks for and installs updates automatically.'));
    wrap.appendChild(el('div', {},
      el('a', { class: 'btn primary', href: 'https://github.com/trycord/.trycord/releases', rel: 'noopener', target: '_blank' }, 'Download the desktop app')));
    return;
  }

  const status = el('p', { class: 'muted small', 'aria-live': 'polite' }, 'Checking update status…');
  const releaseLink = el('a', { class: 'btn', href: 'https://github.com/trycord/.trycord/releases', rel: 'noopener', target: '_blank' }, 'Open Releases page');
  const checkBtn = el('button', { class: 'btn primary', type: 'button' }, 'Check for updates');
  const installBtn = el('button', { class: 'btn danger', type: 'button', hidden: true }, 'Restart & update');
  let prefs = { autoInstall: true, channel: 'latest' };
  let downloadedVersion = null;

  const paint = () => {
    version.textContent = 'Trycord on ' + (desk.platform || 'desktop');
    latestBtn.classList.toggle('active', prefs.channel !== 'beta');
    latestBtn.classList.toggle('ghost', prefs.channel === 'beta');
    betaBtn.classList.toggle('active', prefs.channel === 'beta');
    betaBtn.classList.toggle('ghost', prefs.channel !== 'beta');
    autoToggle.checked = prefs.autoInstall !== false;
  };

  desk.updater.getPrefs().then((p) => { if (p) prefs = p; paint(); }).catch(() => { paint(); });

  const version = el('div', { class: 'row-line' });
  const latestBtn = el('button', { type: 'button', class: 'btn' }, 'Stable');
  latestBtn.addEventListener('click', () => {
    desk.updater.setPrefs({ channel: 'latest' }).then((p) => { prefs = p; paint(); status.textContent = 'Channel switched to Stable.'; }).catch(() => {});
  });
  const betaBtn = el('button', { type: 'button', class: 'btn' }, 'Beta (PTB)');
  betaBtn.addEventListener('click', () => {
    desk.updater.setPrefs({ channel: 'beta' }).then((p) => { prefs = p; paint(); status.textContent = 'Channel switched to Beta — you will see public test builds.'; }).catch(() => {});
  });
  const autoToggle = el('input', { type: 'checkbox', class: 'input' });
  autoToggle.addEventListener('change', () => {
    desk.updater.setPrefs({ autoInstall: autoToggle.checked }).then((p) => { prefs = p; paint(); }).catch(() => {});
  });

  const onEvent = (ev) => {
    if (!ev || !ev.type) return;
    if (ev.type === 'checking') status.textContent = 'Checking for updates…';
    else if (ev.type === 'available') status.textContent = 'Update available — downloading…';
    else if (ev.type === 'progress') status.textContent = Math.round((ev.percent || 0)) + '% downloaded';
    else if (ev.type === 'downloaded') {
      downloadedVersion = ev.version;
      status.textContent = 'Ready to install.';
      installBtn.hidden = false;
    } else if (ev.type === 'not-available') status.textContent = 'You are up to date' + (ev.lastChecked ? ' (last checked ' + new Date(ev.lastChecked).toLocaleString() + ').' : '.');
    else if (ev.type === 'error') {
      status.textContent = 'Update check failed: ' + (ev.message || ev.kind || 'unknown') + '. You keep running the current version.';
      installBtn.hidden = true;
    }
  };
  if (updatesUnsub) { try { updatesUnsub(); } catch { /* ignore */ } updatesUnsub = null; }
  updatesUnsub = desk.updater.onEvent(onEvent);
  checkBtn.addEventListener('click', () => { status.textContent = 'Checking…'; desk.updater.check().catch(() => {}); });
  installBtn.addEventListener('click', () => { desk.updater.install().catch(() => {}); });

  wrap.appendChild(el('div', {}, version));
  wrap.appendChild(el('div', { class: 'field' }, el('label', {}, 'Update channel'), el('div', { class: 'row-line' }, latestBtn, betaBtn),
    el('span', { class: 'hint' }, 'Beta shows public test builds (PTB). Stable shows release builds.')));
  wrap.appendChild(el('div', { class: 'field' }, el('div', { class: 'row-line' }, autoToggle, el('label', {}, 'Install updates automatically when quitting'))));
  wrap.appendChild(el('div', { class: 'row-line' }, checkBtn, installBtn, releaseLink));
  wrap.appendChild(status);
}

export default { renderUpdates };
