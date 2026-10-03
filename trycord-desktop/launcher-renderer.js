// Launcher renderer. Renders what the main process reports and asks for
// nothing except permission to open Trycord or install.

(function () {
  'use strict';

  var bridge = window.trycordLauncher || null;

  function $(name) {
    return document.querySelector('[data-bind="' + name + '"]');
  }

  var sections = {};
  Array.prototype.forEach.call(document.querySelectorAll('[data-state]'), function (el) {
    sections[el.getAttribute('data-state')] = el;
  });

  // Phrased as sentences rather than echoing the label, so it does not say
  // "checking for updates, checking for updates".
  var spoken = {
    waiting:   'Starting Trycord',
    checking:  'Checking for updates',
    current:   'Trycord is up to date',
    available: 'An update is available and will be downloaded automatically',
    ready:     'The update is ready to install',
    blocked:   'Could not check for updates. Continue to Trycord, or retry.'
  };

  var errorLine = {
    'missing-metadata': 'Update information unavailable',
    'offline':          'Can’t reach the update service',
    'unknown':          'Couldn’t check for updates'
  };

  var errorDetail = {
    'missing-metadata': 'The latest release has no update information. Your installed version still works.',
    'offline':          'You may be offline. Your installed version still works.',
    'unknown':          'Your installed version still works.'
  };

  function show(state) {
    Object.keys(sections).forEach(function (key) {
      sections[key].hidden = key !== state;
    });
    if (spoken[state]) $('live').textContent = spoken[state];
  }

  // electron-updater reports bytes. Anything under a megabyte is shown in KB,
  // and a partial download early on would otherwise read "0 KB of 122 MB".
  function bytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }

  function hideProgress() {
    var wrap = $('progressWrap');
    wrap.hidden = true;
    wrap.classList.remove('progress--indeterminate');
    $('percent').textContent = '';
    $('bytes').textContent = '';
  }

  // Real numbers from the updater. With no percentage, a sweep rather than a
  // made-up one.
  function renderProgress(p) {
    var wrap = $('progressWrap');
    var fill = $('fill');
    wrap.hidden = false;
    var known = p && typeof p.percent === 'number' && isFinite(p.percent);
    if (known) {
      wrap.classList.remove('progress--indeterminate');
      fill.style.width = Math.max(0, Math.min(100, p.percent)) + '%';
      $('percent').textContent = Math.round(p.percent) + '%';
    } else {
      wrap.classList.add('progress--indeterminate');
      fill.style.width = '';
      $('percent').textContent = '';
    }
    var got = bytes(p && p.transferred);
    var all = bytes(p && p.total);
    $('bytes').textContent = got && all ? got + ' of ' + all : (got || '');
  }

  function applyState(payload) {
    if (!payload) return;
    if (payload.version) $('version').textContent = 'Version ' + payload.version;

    if (payload.type === 'progress') {
      renderProgress(payload.progress);
      return;
    }
    if (payload.type === 'download-complete') {
      hideProgress();
      show('available');
      $('live').textContent = 'The update to version '
        + ((payload.update && payload.update.version) || 'the new version')
        + ' is ready to install.';
      return;
    }
    if (!payload.state) return;

    switch (payload.state) {
      case 'waiting':
        $('detail').textContent = 'Preparing your workspace';
        show('waiting');
        return;

      case 'checking':
        hideProgress();
        show('checking');
        return;

      case 'current':
        hideProgress();
        show('current');
        return;

      case 'available':
        $('from').textContent = payload.version || 'installed';
        $('to').textContent = (payload.update && payload.update.version) || 'newer version';
        show('available');
        return;

      case 'blocked': {
        var kind = (payload.error && payload.error.kind) || 'unknown';
        var host = document.querySelector('[data-state="blocked"] [data-bind="errorLine"]');
        var detail = document.querySelector('[data-state="blocked"] [data-bind="errorDetail"]');
        host.textContent = errorLine[kind] || errorLine.unknown;
        detail.textContent = errorDetail[kind] || errorDetail.unknown;
        hideProgress();
        show('blocked');
        return;
      }

      default:
        show(payload.state);
    }
  }

  document.addEventListener('click', function (ev) {
    var action = ev.target && ev.target.getAttribute
      ? ev.target.getAttribute('data-action') : null;
    if (!action || !bridge) return;
    if (action === 'continue') bridge.continueToApp();
    else if (action === 'retry') bridge.retry();
    else if (action === 'home') bridge.openExternal('https://trycord.dev/');
  });

  // Escape is the keyboard route to Continue. A dialog-shaped failure with only
  // a mouse affordance strands keyboard users.
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && bridge) bridge.continueToApp();
  });

  if (bridge) {
    bridge.onState(applyState);
    bridge.getState().then(applyState);
  } else {
    $('detail').textContent = 'Launcher unavailable';
    show('waiting');
  }
})();