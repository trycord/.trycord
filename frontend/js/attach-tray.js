// The attachment tray above a composer, shared by channels and direct messages.
//
// The caller supplies the upload call and gets back the ids that are safe to send. Rows
// rather than a bare id list, because "did that upload?" and "take that one back" both
// have to be answerable while the reader is looking at the composer.

import { clear, el, toast } from './ui.js';

const MAX_BYTES = 8 * 1024 * 1024;

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// upload(file, onProgress) must return { promise, abort }, where promise
// resolves to the created attachment. onChange fires whenever the set of
// sendable ids changes, so the caller can enable or disable its send button.
export function createAttachTray({ upload, onChange }) {
  const node = el('div', { class: 'attach-tray', hidden: true });
  let entries = [];

  const notify = () => { if (typeof onChange === 'function') onChange(api); };

  function paint() {
    clear(node);
    node.hidden = entries.length === 0;
    for (const entry of entries) {
      const pct = Math.round((entry.progress || 0) * 100);
      const label = entry.state === 'ready' ? 'Ready'
        : entry.state === 'error' ? (entry.error || 'Upload failed')
          : 'Uploading ' + pct + '%';
      const row = el('div', { class: 'attach-row' + (entry.state === 'error' ? ' attach-row--error' : '') }, [
        el('span', { class: 'attach-name', title: entry.name }, entry.name),
        el('span', { class: 'attach-size' }, fmtSize(entry.size)),
        el('span', { class: 'attach-state' }, label),
      ]);
      if (entry.state === 'error') {
        row.appendChild(el('button', {
          class: 'btn ghost small', type: 'button',
          onClick: () => start(entry),
        }, 'Retry'));
      }
      row.appendChild(el('button', {
        class: 'attach-remove', type: 'button',
        title: entry.state === 'uploading' ? 'Cancel upload' : 'Remove',
        'aria-label': 'Remove ' + entry.name,
        onClick: () => {
          if (entry.xhr) entry.xhr.abort();
          entries = entries.filter((e) => e !== entry);
          paint();
          notify();
        },
      }, '×'));
      // Last, because it spans the full width: anything appended after it would
      // land on a third row.
      row.appendChild(el('div', { class: 'attach-bar' },
        el('div', { class: 'attach-bar__fill', style: 'width:' + (entry.state === 'ready' ? 100 : pct) + '%' })));
      node.appendChild(row);
    }
  }

  function start(entry) {
    entry.state = 'uploading';
    entry.error = null;
    entry.progress = 0;
    const up = upload(entry.file, (frac) => {
      entry.progress = frac;
      paint();
    });
    entry.xhr = up;
    up.promise.then((res) => {
      entry.id = res && res.attachment && res.attachment.id;
      entry.state = entry.id ? 'ready' : 'error';
      if (!entry.id) entry.error = 'Upload failed';
      entry.xhr = null;
      paint();
      notify();
    }).catch((ex) => {
      // An abort is the reader changing their mind rather than a failure, and
      // the row is usually already gone by the time this lands.
      if (ex && ex.name === 'AbortError') return;
      entry.state = 'error';
      entry.error = ex.message || 'Upload failed';
      entry.xhr = null;
      paint();
      notify();
    });
  }

  function addFiles(files) {
    let added = 0;
    for (const f of files) {
      if (f.size > MAX_BYTES) { toast('File too large: ' + f.name, 'error'); continue; }
      entries.push({ file: f, name: f.name, size: f.size, state: 'uploading', progress: 0, id: null });
      added++;
    }
    if (!added) return;
    paint();
    for (const entry of entries) if (entry.state === 'uploading' && !entry.xhr) start(entry);
    notify();
  }

  // Wire a composer to this tray: the button, the hidden input, drops onto the
  // given container, and pasted screenshots. Returns a teardown, because a
  // composer that is re-rendered must not leave these listeners behind.
  function attach({ container, composer, textarea, button, input }) {
    const onClick = () => input.click();
    const onChange = () => {
      addFiles(Array.from(input.files || []));
      input.value = '';
    };
    let dragDepth = 0;
    const setDropping = (on) => composer.classList.toggle('is-dropping', on);
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const onDragEnter = (e) => { if (!hasFiles(e)) return; dragDepth++; setDropping(true); };
    const onDragOver = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) setDropping(false); };
    const onDrop = (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      dragDepth = 0;
      setDropping(false);
      addFiles(Array.from(e.dataTransfer.files));
    };
    const onPaste = (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (!files || !files.length) return;
      // Only a paste that actually carries files is intercepted, so pasting
      // text into the message box behaves normally.
      e.preventDefault();
      addFiles(Array.from(files));
    };

    button.addEventListener('click', onClick);
    input.addEventListener('change', onChange);
    container.addEventListener('dragenter', onDragEnter);
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('dragleave', onDragLeave);
    container.addEventListener('drop', onDrop);
    textarea.addEventListener('paste', onPaste);
    return () => {
      button.removeEventListener('click', onClick);
      input.removeEventListener('change', onChange);
      container.removeEventListener('dragenter', onDragEnter);
      container.removeEventListener('dragover', onDragOver);
      container.removeEventListener('dragleave', onDragLeave);
      container.removeEventListener('drop', onDrop);
      textarea.removeEventListener('paste', onPaste);
      for (const entry of entries) if (entry.xhr) entry.xhr.abort();
    };
  }

  const api = {
    node,
    addFiles,
    attach,
    // Only these are safe to send: anything still uploading would arrive at the
    // message with no file attached to it.
    readyIds: () => entries.filter((e) => e.id).map((e) => e.id),
    isEmpty: () => entries.length === 0,
    isUploading: () => entries.some((e) => e.state === 'uploading'),
    hasReady: () => entries.some((e) => e.id),
    clear() {
      for (const entry of entries) if (entry.xhr) entry.xhr.abort();
      entries = [];
      paint();
      notify();
    },
  };
  return api;
}
