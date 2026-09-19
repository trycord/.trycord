/* UI primitives: escaping, toasts, modal/dialog, states, avatar, time. */
(function () {
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function toast(message, type) {
    var root = document.getElementById('toasts');
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.setAttribute('role', 'status');
    var span = document.createElement('span');
    span.textContent = message;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn';
    btn.setAttribute('aria-label', 'Dismiss');
    btn.textContent = '✕';
    btn.onclick = () => el.remove();
    el.append(span, btn);
    root.appendChild(el);
    setTimeout(() => { if (el.isConnected) el.remove(); }, 5000);
  }

  function openModal(opts) {
    var root = document.getElementById('modal-root');
    root.innerHTML = '';
    var scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    var box = document.createElement('div');
    box.className = 'modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', opts.title || 'Dialog');
    var head = document.createElement('div');
    head.className = 'modal-head';
    var h2 = document.createElement('h2');
    h2.textContent = opts.title || '';
    head.appendChild(h2);
    var body = document.createElement('div');
    body.className = 'modal-body';
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    var foot = document.createElement('div');
    foot.className = 'modal-foot';
    function close() {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    (opts.actions || [{ id: 'ok', label: 'OK', primary: true }]).forEach((a) => {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn' + (a.primary ? ' btn-primary' : '') + (a.danger ? ' btn-danger' : '');
      b.textContent = a.label;
      b.onclick = () => {
        if (a.onClick) a.onClick(close);
        else close();
      };
      foot.appendChild(b);
      if (a.primary) setTimeout(() => b.focus(), 0);
    });
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
    document.addEventListener('keydown', onKey);
    box.append(head, body, foot);
    scrim.appendChild(box);
    root.appendChild(scrim);
    return close;
  }

  function confirmDialog(opts) {
    return new Promise((resolve) => {
      var msg = document.createElement('p');
      msg.textContent = opts.message || 'Are you sure?';
      openModal({
        title: opts.title || 'Confirm',
        body: msg,
        onClose: () => resolve(false),
        actions: [
          { id: 'cancel', label: opts.cancelText || 'Cancel' },
          {
            id: 'ok', label: opts.confirmText || 'Confirm', primary: !opts.danger, danger: !!opts.danger,
            onClick: (close) => { close(); resolve(true); },
          },
        ],
      });
    });
  }

  function skeletons(n, cls) {
    var html = '';
    for (var i = 0; i < (n || 3); i++) html += '<div class="skeleton"></div>';
    return '<div class="' + (cls || 'stack') + '" aria-busy="true" aria-label="Loading">' + html + '</div>';
  }

  function emptyState(o) {
    return (
      '<div class="state" role="status">' +
      '<div class="glyph" aria-hidden="true">' + (o.icon || '○') + '</div>' +
      '<h3>' + esc(o.title || 'Nothing here yet') + '</h3>' +
      '<p>' + esc(o.hint || '') + '</p>' +
      '<div class="actions">' + (o.actions || '') + '</div></div>'
    );
  }

  function errorState(message, retryLabel) {
    return (
      '<div class="state" role="alert">' +
      '<div class="glyph" aria-hidden="true">⚠</div><h3>Something went wrong</h3>' +
      '<p>' + esc(message || 'Request failed.') + '</p>' +
      '<div class="actions"><button type="button" class="btn btn-primary" data-retry>' +
      esc(retryLabel || 'Retry') + '</button></div></div>'
    );
  }

  function avatarHtml(name, size) {
    var n = String(name || '?').trim() || '?';
    var hue = 0;
    for (var i = 0; i < n.length; i++) hue = (hue * 31 + n.charCodeAt(i)) % 360;
    return '<span class="avatar ' + (size || '') + '" aria-hidden="true" style="background:hsl(' +
      hue + ',45%,42%)">' + esc(n[0].toUpperCase()) + '</span>';
  }

  function badge(text, kind) {
    return '<span class="badge ' + (kind || '') + '">' + esc(text) + '</span>';
  }

  function timeAgo(iso) {
    if (!iso) return 'never';
    var t = new Date(iso).getTime();
    if (isNaN(t)) return 'never';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
    return new Date(t).toLocaleDateString();
  }

  function fullDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString();
  }

  function fieldError(input, msg) {
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    var err = input.parentElement.querySelector('.field-err');
    if (!err) {
      err = document.createElement('div');
      err.className = 'field-err';
      input.after(err);
    }
    err.textContent = msg || '';
    return !msg;
  }

  function setLoading(btn, loading, label) {
    if (!btn) return;
    if (loading) {
      btn.dataset.label = btn.textContent;
      btn.disabled = true;
      btn.textContent = label || 'Working…';
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
    }
  }

  window.TrycordUi = {
    esc, toast, openModal, confirmDialog, skeletons,
    emptyState, errorState, avatarHtml, badge, timeAgo, fullDate,
    fieldError, setLoading,
  };
})();
