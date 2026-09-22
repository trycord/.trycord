/* UI primitives: escaping, toasts, modal/dialog, states, avatar, time. */
(function () {
  // Trycord icon vocabulary — ONE source of truth for typographic icons.
  // These are text glyphs (arrows, math, geometric shapes) chosen for
  // broad cross-platform rendering: every entry defaults to monochrome
  // text presentation, never color emoji. Anything complex, brand-critical,
  // or at risk of emoji substitution (bell, lock, logo) stays an inline
  // SVG symbol in index.html instead. Use Ui.icon(name) so the language
  // can evolve without hunting the codebase.
  var icons = {
    back: '←',
    forward: '→',
    close: '×',
    add: '+',
    more: '⋮',
    overflow: '⋯',
    search: '⌕',
    command: '⌘',
    settings: '⚙',
    edit: '✎',
    refresh: '↻',
    external: '↗',
    upload: '↑',
    download: '↓',
    check: '✓',
    checks: '✓✓',
    channel: '#',
    mention: '@',
    star: '☆',
    starFilled: '★',
    dot: '•',
    chevron: '›',
    empty: '○',
    clock: '◷',
    grid: '▦',
  };

  // <span class="ico" aria-hidden="true">X</span> — decorative by default.
  // Icon-only controls MUST carry their own aria-label (never rely on this).
  function icon(name, cls) {
    var glyph = icons[name] || icons.empty;
    return '<span class="ico' + (cls ? ' ' + cls : '') + '" aria-hidden="true">' + glyph + '</span>';
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function toast(message, type) {
    var root = document.getElementById('toasts');
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.setAttribute('role', 'status');
    var content = document.createElement('div');
    content.className = 'toast-content';
    var title = document.createElement('div');
    title.className = 'toast-title';
    title.textContent = type === 'success' ? 'Success' : type === 'error' ? 'Error' : type === 'warning' ? 'Warning' : 'Info';
    var span = document.createElement('div');
    span.className = 'toast-message';
    span.textContent = message;
    content.append(title, span);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-close';
    btn.setAttribute('aria-label', 'Dismiss');
    btn.innerHTML = '&times;';
    btn.onclick = () => el.remove();
    el.append(content, btn);
    root.appendChild(el);
    setTimeout(() => { if (el.isConnected) el.remove(); }, 5000);
  }

  function openModal(opts) {
    var root = document.getElementById('modal-root');
    root.innerHTML = '';
    var scrim = document.createElement('div');
    scrim.className = 'modal-overlay';
    var box = document.createElement('div');
    box.className = 'modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', opts.title || 'Dialog');
    var head = document.createElement('div');
    head.className = 'modal-header';
    var h2 = document.createElement('h2');
    h2.className = 'modal-title';
    h2.textContent = opts.title || '';
    head.appendChild(h2);
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'modal-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute('aria-label', 'Close');
    head.appendChild(closeBtn);
    var body = document.createElement('div');
    body.className = 'modal-body';
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    var foot = document.createElement('div');
    foot.className = 'modal-footer';
    function close() {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      if (opts.onClose) opts.onClose();
    }
    closeBtn.onclick = close;
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
    for (var i = 0; i < (n || 3); i++) html += '<div class="skeleton skeleton-text"></div>';
    return '<div class="' + (cls || 'stack') + '" aria-busy="true" aria-label="Loading">' + html + '</div>';
  }

  function emptyState(o) {
    return (
      '<div class="empty-state" role="status">' +
      '<div class="empty-state-icon" aria-hidden="true">' + (o.icon || '○') + '</div>' +
      '<h3 class="empty-state-title">' + esc(o.title || 'Nothing here yet') + '</h3>' +
      '<p class="empty-state-text">' + esc(o.hint || '') + '</p>' +
      '<div class="actions">' + (o.actions || '') + '</div></div>'
    );
  }

  function errorState(message, retryLabel) {
    return (
      '<div class="empty-state" role="alert">' +
      '<div class="empty-state-icon" aria-hidden="true">⚠</div>' +
      '<h3 class="empty-state-title">Something went wrong</h3>' +
      '<p class="empty-state-text">' + esc(message || 'Request failed.') + '</p>' +
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
    var cls = 'badge';
    if (kind === 'owner') cls += ' badge-primary';
    else if (kind === 'pub') cls += ' badge-success';
    else if (kind === 'priv') cls += ' badge-secondary';
    return '<span class="' + cls + '">' + esc(text) + '</span>';
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

  function dayLabel(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var nowD = new Date();
    var day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var today = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate());
    var diff = Math.round((today - day) / 86400000);
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() === nowD.getFullYear() ? undefined : 'numeric' });
  }

  function closeCtx() {
    var root = document.getElementById('ctx-root');
    if (root) root.innerHTML = '';
    document.removeEventListener('keydown', ctxKey);
  }

  function ctxKey(e) {
    if (e.key === 'Escape') closeCtx();
  }

  // Minimal permission-aware context menu. items: [{ label, icon, danger,
  // onClick, hidden }]. Anchored at x/y, clamped to the viewport, keyboard
  // dismissible, single-flight.
  function contextMenu(x, y, items) {
    closeCtx();
    var list = (items || []).filter((it) => it && !it.hidden);
    if (!list.length) return;
    var root = document.getElementById('ctx-root');
    if (!root) return;
    var menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.setAttribute('role', 'menu');
    menu.style.position = 'fixed';
    list.forEach((it) => {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      if (it.danger) b.className = 'danger';
      b.innerHTML = (it.icon ? '<svg aria-hidden="true"><use href="#' + it.icon + '"/></svg>' : '') +
        '<span>' + esc(it.label) + '</span>';
      b.onclick = () => { closeCtx(); it.onClick && it.onClick(); };
      menu.appendChild(b);
    });
    root.appendChild(menu);
    var r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
    document.addEventListener('keydown', ctxKey);
    setTimeout(() => {
      document.addEventListener('mousedown', function outside(e) {
        if (!menu.contains(e.target)) {
          closeCtx();
          document.removeEventListener('mousedown', outside);
        }
      });
    }, 0);
    var first = menu.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }

  // Long-press for touch screens: fires fn(x, y) after 550ms of steady
  // touch. Movement cancels. Never the only path — every long-press target
  // also has a visible affordance (buttons, ⋮) or contextmenu handler.
  function longPress(el, fn) {
    var timer = null;
    var sx = 0;
    var sy = 0;
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(sx, sy);
      }, 550);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!timer) return;
      var t = e.touches[0];
      if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) {
        clearTimeout(timer);
        timer = null;
      }
    }, { passive: true });
    el.addEventListener('touchend', () => {
      clearTimeout(timer);
      timer = null;
    });
    el.addEventListener('touchcancel', () => {
      clearTimeout(timer);
      timer = null;
    });
  }

  // Bind long-press to every element matching selector under root that
  // doesn't already have one. Call after each list render.
  function bindLongPress(root, selector, fn) {
    root.querySelectorAll(selector).forEach((el) => {
      if (el.dataset.lpBound) return;
      el.dataset.lpBound = '1';
      longPress(el, (x, y) => fn(el, x, y));
    });
  }

  // Re-dispatch as contextmenu so touch/long-press flows through the exact
  // same permission-aware menu code as right-click. One code path.
  function fireContextMenu(el, x, y) {
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    }));
  }

  // Layout state comes from the single canonical source (presentation.js).
  // All layout-dependent JS asks TrycordPresentation.isMobile() — never a
  // private width sniff. Visual layout stays in CSS.
  function isMobileLayout() {
    return !!(window.TrycordPresentation && window.TrycordPresentation.isMobile());
  }

  window.TrycordUi = {
    esc, toast, openModal, confirmDialog, skeletons,
    emptyState, errorState, avatarHtml, badge, timeAgo, fullDate, dayLabel,
    fieldError, setLoading, contextMenu, closeCtx, longPress, bindLongPress,
    fireContextMenu, isMobileLayout, icons, icon,
  };
})();
