// The composer: the textarea, the attachment tray, the send button, and the rules
// about when a send may happen.
//
// It was the middle 110 lines of a channel renderer with about forty closures around it,
// and it is a self-contained thing: given a channel and somewhere to put itself, it draws
// and sends. The dependencies it used to close over are now arguments, which is what makes
// it possible to render one without a channel behind it.
//
// Two rules live here rather than at the call site, because they are about the composer:
//
//   a double submit must not produce two messages
//   the nonce is generated per attempt and *held* across a retry of that attempt, because
//   if the POST times out there is no way to tell whether the server wrote it, and the
//   nonce is the only thing that stops the retry posting it twice
//
// Both were in the same shape in the DM composer, and both are worth reading together.

import Api from '../api.js';
import State from '../state.js';
import { canInChannel, mustVerifyToPost } from '../state.js';
import { createAttachTray } from '../attach-tray.js';
import { el, icon, insertAtCursor, showEmojiPicker, toast } from '../ui.js';

/** A value that identifies one send attempt. */
function newNonce() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch { /* fall through */ }
  return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * Draw the composer into `conv` and return what the caller needs to drive it.
 *
 * @param {object}      o
 * @param {HTMLElement} o.conv      where the dock is appended
 * @param {string}      o.channelId upload target and send endpoint
 * @param {string}      o.chanName  the channel name, for the placeholder
 * @param {Function}    o.upsertMessage  called with the server's echo of a sent message
 * @param {Function}    o.reload          called when a send returns no message
 */
export function renderComposer({ conv, channelId, chanName, upsertMessage, reload }) {
  const composer = el('div', { class: 'composer' });
  const fileBtn = el('button', { class: 'file-btn', type: 'button', title: 'Attach file', 'aria-label': 'Attach file' }, icon('paperclip'));
  const fileInput = el('input', { type: 'file', hidden: true, multiple: true });
  const ta = el('textarea', { placeholder: 'Message #' + chanName, rows: 1, 'aria-label': 'Message' });
  const sendBtn = el('button', { class: 'btn primary', type: 'button' }, 'Send');
  const emojiBtn = el('button', { class: 'emoji-btn', type: 'button', title: 'Emoji', 'aria-label': 'Insert emoji' }, icon('smile'));
  emojiBtn.addEventListener('click', () => showEmojiPicker(emojiBtn, (e) => insertAtCursor(ta, e)));
  const attachments = createAttachTray({
    upload: (file, onProgress) => Api.uploadAttachmentWithProgress(channelId, file, onProgress),
    onChange: () => { sendBtn.disabled = !attachments.hasReady() && !ta.value.trim(); },
  });
  // Suppress previews for the next message. The flag travels with the send and
  // the server decides what to do with it, so this cannot drift into a control
  // that only changes how the composer looks.
  const previewOff = el('button', {
    class: 'preview-toggle', type: 'button',
    title: 'Do not generate link previews for this message',
    'aria-label': 'Do not generate link previews for this message',
    'aria-pressed': 'false',
  }, icon('globe'));
  previewOff.addEventListener('click', () => {
    const on = previewOff.getAttribute('aria-pressed') !== 'true';
    previewOff.setAttribute('aria-pressed', on ? 'true' : 'false');
    previewOff.classList.toggle('is-on', on);
    previewOff.title = on ? 'Link previews are off for the next message'
      : 'Do not generate link previews for this message';
  });

  composer.appendChild(fileBtn);
  composer.appendChild(fileInput);
  composer.appendChild(ta);
  composer.appendChild(el('div', { class: 'composer-actions' }, previewOff, emojiBtn, sendBtn));
  // The tray is a sibling of the composer rather than a flex child of it: as a
  // child it competed with the textarea for the line and collapsed to nothing on
  // a phone.
  conv.appendChild(el('div', { class: 'composer-dock' }, attachments.node, composer));
  {
    const me = State.me;
    const locked = !canInChannel('SEND_MESSAGES') ? 'You do not have permission to send messages here.'
      : mustVerifyToPost() ? 'Verify your email to send messages.' : null;
    if (locked) {
      ta.disabled = true;
      ta.placeholder = locked;
      sendBtn.disabled = true;
      fileBtn.disabled = true;
      emojiBtn.disabled = true;
      previewOff.disabled = true;
      composer.classList.add('locked');
    }
  }

  attachments.attach({ container: conv, composer, textarea: ta, button: fileBtn, input: fileInput });

  function resize() {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }
  ta.addEventListener('input', () => { resize(); sendBtn.disabled = !attachments.hasReady() && !ta.value.trim(); });

  // A double submit must not produce two real messages. Mirrors the DM sendLock.
  let sending = false;
  let pendingNonce = null;
  async function send() {
    if (sending) return;
    const content = ta.value.trim();
    // Only files that finished uploading can go on the message. Sending while
    // one is still in flight would attach nothing for it and silently drop it.
    const readyIds = attachments.readyIds();
    if (!content && !readyIds.length) {
      if (attachments.isUploading()) { toast('Still uploading', 'warn'); return; }
      return;
    }
    sending = true;
    sendBtn.setAttribute('aria-busy', 'true');
    // One nonce per attempt, reused across a retry of the same attempt. If the
    // POST times out we cannot tell whether the server wrote the message, so the
    // nonce is what stops a retry from posting it twice.
    const clientNonce = pendingNonce || newNonce();
    pendingNonce = clientNonce;
    const attachmentIds = readyIds.length ? readyIds : undefined;
    try {
      const suppressEmbeds = previewOff.getAttribute('aria-pressed') === 'true';
      const saved = await Api.sendMessage(channelId, {
        content, attachmentIds, clientNonce, suppressEmbeds: suppressEmbeds || undefined,
      });
      pendingNonce = null;
      // The choice is about one message, so it does not stick to the next one.
      if (suppressEmbeds) {
        previewOff.setAttribute('aria-pressed', 'false');
        previewOff.classList.remove('is-on');
      }
      ta.value = '';
      attachments.clear();
      resize();
      if (saved && saved.id) {
        upsertMessage(saved, { scroll: true });
      } else {
        await reload();
      }
    } catch (ex) {
      toast(ex.message || 'Cannot send', 'error');
    } finally {
      sending = false;
      sendBtn.removeAttribute('aria-busy');
    }
  }
  sendBtn.addEventListener('click', send);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });


  return { composer, textarea: ta, send, attachments };
}
