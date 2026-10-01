// An expanded thread, in place under the message it hangs from.
//
// Inline rather than a side panel: it reuses the feed, the message rows and the
// composer that are already here, and it needs no new region in the shell, which
// matters because a thread has to work the same in a channel and in a direct
// message. On a phone a side panel has nowhere to go.
//
// The root is repeated in the thread even though it is the message being
// expanded. Without it the replies have no context - the thing they are replying
// to is the whole point - and on a narrow screen the expanded block is often the
// only part of the message still visible.

import Api from './api.js';
import { el, clear, insertAtCursor, showEmojiPicker, toast } from './ui.js';
import { icon } from './components.js';
import { loadingState, errorState } from './states.js';

let openSeq = 0;

export function createThread({ kind, scopeId, rootMessage, onPosted, canReply = true }) {
  const seq = ++openSeq;
  const box = el('div', { class: 'msg-thread', 'data-thread-root': rootMessage.id });
  const list = el('div', { class: 'msg-thread__list' });
  const ta = el('textarea', {
    class: 'msg-thread__input', rows: 1, 'aria-label': 'Reply in thread',
    placeholder: 'Reply in thread…',
  });
  const sendBtn = el('button', { class: 'btn primary small', type: 'button' }, 'Reply');
  const emojiBtn = el('button', { class: 'emoji-btn', type: 'button', title: 'Emoji', 'aria-label': 'Insert emoji' }, icon('smile'));
  const form = el('div', { class: 'msg-thread__form' }, ta, el('div', { class: 'composer-actions' }, emojiBtn, sendBtn));
  if (!canReply) form.hidden = true;

  box.appendChild(el('div', { class: 'msg-thread__head' },
    el('span', { class: 'msg-thread__title' }, 'Thread'),
    el('button', {
      class: 'msg-thread__close', type: 'button', 'aria-label': 'Close thread',
      onClick: () => box.remove(),
    }, '×')));
  box.appendChild(list);
  box.appendChild(form);

  emojiBtn.addEventListener('click', () => showEmojiPicker(emojiBtn, (e) => insertAtCursor(ta, e)));

  let rows = null;

  function paint(state) {
    clear(list);
    if (state) list.appendChild(state);
    if (!rows) return;
    // The root is rendered from the message we already had, so the thread opens
    // with its context on screen before the request comes back.
    const root = el('div', { class: 'msg-thread__root' }, [renderOne(rootMessage, true)]);
    list.appendChild(root);
    for (const r of rows) list.appendChild(renderOne(r, false));
  }

  function renderOne(m, isRoot) {
    const who = el('span', { class: 'msg-author' }, m.authorName || m.author_name || m.user || 'Unknown');
    const when = el('span', { class: 'msg-time' }, m.createdAt ? new Date(m.createdAt).toLocaleString() : '');
    const inner = el('div', { class: 'msg-body' }, [
      el('div', { class: 'msg-head' }, who, when),
      el('div', { class: 'msg-text' }, m.content || ''),
    ]);
    if (m.attachments && m.attachments.length) {
      const files = el('div', { class: 'msg-files' });
      for (const a of m.attachments) {
        files.appendChild(el('span', { class: 'msg-file' }, a.filename || 'attachment'));
      }
      inner.appendChild(files);
    }
    // The .msg-body wrapper is what makes .msg lay out as a column here; without
    // it the author, timestamp and text sit side by side.
    return el('div', {
      class: 'msg msg-thread__msg' + (isRoot ? ' msg-thread__msg--root' : ''),
      'data-message-id': m.id,
    }, inner);
  }

  async function load() {
    paint(loadingState('Loading thread'));
    try {
      const data = await Api.messageThread(kind, scopeId, rootMessage.id);
      if (seq !== openSeq) return;
      rows = data.replies || [];
      paint(null);
    } catch (ex) {
      if (seq !== openSeq) return;
      paint(errorState('Could not load this thread', load, { detail: ex.message || '' }));
    }
  }

  let sending = false;
  async function submit() {
    if (sending) return;
    const content = ta.value.trim();
    if (!content) return;
    sending = true;
    sendBtn.setAttribute('aria-busy', 'true');
    try {
      const posted = await Api.sendThreadReply(kind, scopeId, content, rootMessage.id);
      ta.value = '';
      ta.style.height = 'auto';
      if (posted && typeof onPosted === 'function') onPosted(posted);
      // The server is the authority on the reply list, so re-read rather than
      // pushing the optimistic copy in - it is one request and cannot drift.
      await load();
    } catch (ex) {
      toast(ex.message || 'Could not reply', 'error');
    } finally {
      sending = false;
      sendBtn.removeAttribute('aria-busy');
    }
  }

  sendBtn.addEventListener('click', submit);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  });

  load();
  return { node: box, destroy: () => { openSeq++; } };
}
