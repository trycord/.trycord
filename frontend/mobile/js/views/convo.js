// The conversation: a channel or a direct chat, full-bleed.
//
// History is read through the shared encryption module — rows the server
// holds without text are opened on this device before they are drawn — and
// the realtime gateway feeds the same pipe. The composer is handed to the
// shell separately, so the words stay above the doors.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { avatar } from '../../../js/ui/primitives.js';
import { State, nameOf, normalizeUser, markConversationRead } from '../../../packages/store.js';
import { mediaUrl } from '../../../packages/media.js';
import { dayLabel, toDate, timeOfDay, fileSize } from '../../../packages/format.js';
import realtime, { EVENTS } from '../../../packages/realtime.js';
import Api from '../../../packages/api.js';
import { current as voice, join as joinVoice } from '../../../packages/voiceSession.js';
import * as encrypted from '../../../js/ui/encrypted.js';
import { navigate, path } from '../../../packages/nav.js';
import { sheet, closeSheet, confirm, attachLongPress, failed, toast, emptyState, hold, failure } from '../ui.js';
import { reportSheet } from '../actions.js';
import { timeAgo } from './time.js';

// --- one message, in the shape the screen reads -----------------------------

function normalizeMessage(raw) {
  if (!raw) return null;
  const group = raw.conversationId !== undefined && raw.conversationId !== null;
  return {
    id: raw.id,
    seq: raw.seq,
    content: raw.content || '',
    createdAt: raw.createdAt || raw.created_at,
    editedAt: raw.editedAt || raw.edited_at || null,
    authorId: group ? raw.authorId : (raw.authorId || raw.author_id),
    authorName: group ? raw.authorName : (raw.authorName || raw.username || raw.user),
    authorDisplay: group ? (raw.authorDisplay || raw.authorName) : (raw.authorDisplay || raw.display_name || raw.user),
    authorAvatar: raw.authorAvatar || raw.author_avatar || null,
    authorIsBot: !!(raw.authorIsBot || raw.author_is_bot),
    replyCount: raw.replyCount || raw.reply_count || 0,
    attachments: raw.attachments || [],
    reactions: raw.reactions || [],
    embeds: raw.embeds || [],
    pinned: !!raw.pinned,
    pending: !!raw.pending,
    encrypted: !!raw.encrypted,
    unreadable: !!raw.unreadable,
  };
}

function authorOf(message) {
  return {
    id: message.authorId,
    username: message.authorName,
    displayName: message.authorDisplay || message.authorName,
    avatarUrl: message.authorAvatar || null,
  };
}

function bySeq(a, b) { return (a.seq || 0) - (b.seq || 0); }

/** Links, code, emphasis and names become their parts; nothing becomes HTML. */
function renderRich(container, text) {
  const pattern = /(https?:\/\/[^\s]+|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|@[a-zA-Z0-9_.-]{2,32})/g;
  let last = 0;
  let m;
  const source = String(text || '');
  while ((m = pattern.exec(source))) {
    if (m.index > last) container.appendChild(document.createTextNode(source.slice(last, m.index)));
    const token = m[0];
    if (/^https?:\/\//.test(token)) container.appendChild(el('a', { class: 'm-link', href: token, target: '_blank', rel: 'noopener noreferrer' }, token));
    else if (/^`/.test(token)) container.appendChild(el('code', { class: 'm-code' }, token.slice(1, -1)));
    else if (/^\*\*/.test(token)) container.appendChild(el('strong', {}, token.slice(2, -2)));
    else if (/^\*/.test(token)) container.appendChild(el('em', {}, token.slice(1, -1)));
    else container.appendChild(el('span', { class: 'm-mention' }, token));
    last = m.index + token.length;
  }
  if (last < source.length) container.appendChild(document.createTextNode(source.slice(last)));
}

async function attachmentNode(att) {
  const url = await mediaUrl(att.url || ('/api/attachments/' + att.id));
  const kind = String(att.content_type || att.contentType || '');
  const name = att.filename || 'Attachment';
  // A picture is shown as a picture: its own tile, at the size a phone reads
  // it, with the name for the reader who cannot see it. A document keeps the
  // row with its name and size.
  if (kind.indexOf('image/') === 0) {
    return el('div', { class: 'm-msg__image' },
      el('img', { src: url, alt: name, loading: 'lazy' }));
  }
  return el('a', { class: 'm-msg__file', href: url, target: '_blank', rel: 'noopener noreferrer' },
    icon('hard-drive', { size: 16 }),
    el('span', { class: 'truncate' }, name),
    att.size ? el('span', { class: 'muted' }, fileSize(att.size)) : null);
}

function embedNode(card) {
  const body = el('div', { class: 'm-embed' });
  if (card.siteName || card.site_name) body.appendChild(el('div', { class: 'm-embed__site' }, card.siteName || card.site_name));
  if (card.title) body.appendChild(el('div', { class: 'm-embed__title' }, card.title));
  if (card.description || card.desc) body.appendChild(el('p', { class: 'm-embed__desc' }, card.description || card.desc));
  const image = card.image || card.imageUrl || card.image_url;
  if (image) {
    const holder = el('div', { class: 'm-embed__media' });
    mediaUrl(image).then((src) => { if (src) holder.appendChild(el('img', { src, alt: '', loading: 'lazy' })); }).catch(() => {});
    body.appendChild(holder);
  }
  return body;
}

// --- the screen --------------------------------------------------------------

/**
 * The conversation itself. Returns { node, composer, onMount, cleanup }: the
 * node is the reader's list, the composer is the form the shell paints below
 * it, and onMount and cleanup bracket the screen's life. A conversation that
 * is left before its history arrives never marks the room read and never
 * repaints the screen someone else owns.
 * @param {{ placeholder?: string }} context
 * @param {{ kind: 'dm'|'channel', id: string, placeholder?: string, serverId?: string }} scope
 */
export function renderConversation(context, scope) {
  const isDm = scope.kind === 'dm';
  const host = el('div', { class: 'm-convo' });
  const list = el('div', { class: 'm-convo__list' });
  host.appendChild(list);

  const rows = new Map();
  let generation = 0;
  let oldest = null;
  let exhausted = false;
  let loadingOlder = false;
  let replyTo = null;
  const offs = [];

  function find(id) { return rows.get(String(id)); }
  function findSeq(seq) {
    for (const row of rows.values()) if (row.seq === seq) return row;
    return null;
  }
  function remove(id) { rows.delete(String(id)); paint(); }

  function upsert(message) {
    if (!message || !message.id) return;
    rows.set(String(message.id), message);
    paint();
  }

  async function readPage(options) {
    const fetched = isDm
      ? await Api.dmMessages(scope.id, options)
      : await Api.messages(scope.id, options);
    const opened = await encrypted.readRows(Array.isArray(fetched) ? fetched : [], scope.id);
    return opened.map(normalizeMessage).filter(Boolean).sort(bySeq);
  }

  async function history() {
    const mine = ++generation;
    const page = await readPage({ limit: 40 });
    if (mine !== generation) return;
    for (const message of page) rows.set(String(message.id), message);
    if (page.length) oldest = page[0].seq;
    exhausted = page.length < 40;
    paint();
    // The room is only marked read once its words are on the screen and this
    // screen is still the one the reader is on.
    if (isDm) { try { await Api.dmRead(scope.id); } catch { /* the pip stays */ } }
    markConversationRead(scope.id);
  }

  async function older() {
    if (loadingOlder || exhausted || oldest === null) return;
    loadingOlder = true;
    try {
      const page = await readPage({ before: oldest, limit: 40 });
      const mine = generation;
      if (mine !== generation) return;
      for (const message of page) rows.set(String(message.id), message);
      if (page.length) oldest = page[0].seq;
      exhausted = page.length < 40;
      paint();
    } catch (e) {
      failed(e);
    } finally {
      loadingOlder = false;
    }
  }

  function dayBreak(previous, current) {
    const a = toDate(previous && previous.createdAt);
    const b = toDate(current.createdAt);
    if (!a || !b) return false;
    return a.toDateString() !== b.toDateString();
  }

  function messageNode(message, previous) {
    const mine = State.user && String(message.authorId) === String(State.user.id);
    const continued = previous && String(previous.authorId) === String(message.authorId)
      && !dayBreak(previous, message)
      && (toDate(message.createdAt) - toDate(previous.createdAt)) < 5 * 60 * 1000;

    const node = el('div', { class: 'm-msg' + (continued ? ' m-msg--continued' : '') + (mine ? ' m-msg--own' : '') + (message.pending ? ' m-msg--pending' : '') });
    node.tabIndex = 0;

    const face = el('div', { class: 'm-msg__rail' });
    if (!continued) face.appendChild(avatar(authorOf(message), { size: 'sm' }));

    const body = el('div', { class: 'm-msg__main' });
    const meta = el('div', { class: 'm-msg__meta' });
    if (!continued) {
      // The author's name is a way to their page, and it sits on the line
      // where a reader looks for it — not squeezed under the face.
      meta.appendChild(el('button', {
        class: 'm-msg__author', type: 'button',
        onClick: () => { if (!isDm && message.authorId) navigate(path('/users/' + message.authorId + '?server=' + (scope.serverId || ''))); },
      }, message.authorDisplay || message.authorName || 'Someone'));
    }
    if (message.authorIsBot) meta.appendChild(el('span', { class: 'm-msg__time' }, 'bot'));
    if (message.pinned) meta.appendChild(icon('pin', { size: 12 }));
    meta.appendChild(el('span', { class: 'm-msg__time' }, timeOfDay(message.createdAt)));
    body.appendChild(meta);

    if (message.unreadable) {
      body.appendChild(el('div', { class: 'm-msg__note' }, 'Sealed for another key — this device cannot open it.'));
    } else if (message.content) {
      const words = el('div', { class: 'm-msg__body' });
      renderRich(words, message.content);
      body.appendChild(words);
    }

    const files = el('div', { class: 'm-msg__files' });
    for (const att of message.attachments || []) {
      attachmentNode(att).then((n) => { files.appendChild(n); }).catch(() => {});
    }
    if (message.attachments && message.attachments.length) body.appendChild(files);

    if ((message.embeds || []).length) {
      body.appendChild(el('div', { class: 'm-embeds' }, message.embeds.map(embedNode)));
    }

    const reacted = (emoji) => State.user
      && ((message.reactions.find((r) => r.emoji === emoji) || {}).me
        || ((message.reactions.find((r) => r.emoji === emoji) || {}).users || []).some((u) => String(u) === String(State.user.id)));

    if ((message.reactions || []).length) {
      const bar = el('div', { class: 'm-msg__reactions' });
      for (const reaction of message.reactions) {
        bar.appendChild(el('button', {
          class: 'm-msg__reaction', type: 'button', 'aria-pressed': reacted(reaction.emoji) ? 'true' : 'false',
          onClick: () => toggleReaction(message, reaction.emoji),
        }, reaction.emoji + ' ' + (reaction.count || (reaction.users || []).length || 1)));
      }
      body.appendChild(bar);
    }

    if (message.replyCount > 0) {
      body.appendChild(el('button', {
        class: 'm-msg__replies', type: 'button',
        onClick: () => threadSheet(message),
      }, icon('message', { size: 12 }), message.replyCount + (message.replyCount === 1 ? ' reply' : ' replies')));
    }

    node.appendChild(face);
    node.appendChild(body);
    attachLongPress(node, () => messageActions(message, mine));
    return node;
  }

  // The screen is the scroller. The conversation is a row of the shell's grid
  // and the list inside it is as tall as its words, so a scroll set on the
  // list itself moves nothing: the reader who opens a room with a history in
  // it was left looking at the oldest word in it. The screen the list sits in
  // is the box that scrolls, and it is the one that is moved.
  function scroller() {
    const box = host.closest ? host.closest('.m-screen') : null;
    return box || host.parentElement || null;
  }
  function atNewest() {
    const box = scroller();
    if (!box) return true;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  }
  function toNewest() {
    const box = scroller();
    if (box) box.scrollTop = box.scrollHeight;
  }

  function paint() {
    const keep = atNewest();
    clear(list);
    const ordered = [...rows.values()].sort(bySeq);
    if (!ordered.length) {
      list.appendChild(emptyState('message', 'No words yet', 'The first thing said here appears at the bottom.'));
      return;
    }
    if (!exhausted) {
      list.appendChild(el('button', { class: 'm-older', type: 'button', onClick: older }, 'Earlier words'));
    }
    let previous = null;
    let lastDay = '';
    for (const message of ordered) {
      const when = toDate(message.createdAt);
      const day = when ? when.toDateString() : '';
      if (day && day !== lastDay) {
        list.appendChild(el('div', { class: 'm-day' }, dayLabel(message.createdAt)));
        lastDay = day;
      }
      list.appendChild(messageNode(message, previous));
      previous = message;
    }
    if (keep) toNewest();
  }

  // --- the actions one message offers ----------------------------------------

  async function toggleReaction(message, emoji) {
    try {
      if (isDm) {
        const had = (message.reactions || []).some((r) => r.emoji === emoji
          && ((r.me === true) || (r.users || []).some((u) => String(u) === String(State.user.id))));
        if (had) await Api.unreactDm(scope.id, message.id, emoji);
        else await Api.reactDm(scope.id, message.id, emoji);
      } else {
        const had = (message.reactions || []).some((r) => r.emoji === emoji
          && ((r.me === true) || (r.users || []).some((u) => String(u) === String(State.user.id))));
        if (had) await Api.unreactChannel(scope.id, message.id, emoji);
        else await Api.reactChannel(scope.id, message.id, emoji);
      }
      const fresh = isDm ? await Api.dmMessages(scope.id, { limit: 40 }) : await Api.messages(scope.id, { limit: 40 });
      const opened = await encrypted.readRows(Array.isArray(fresh) ? fresh : [], scope.id);
      for (const raw of opened) {
        const message_0 = normalizeMessage(raw);
        if (message_0 && (message_0.id === message.id || (rows.get(String(message_0.id)) || {}).seq === message_0.seq)) {
          const known = rows.get(String(message_0.id));
          if (known) known.reactions = message_0.reactions;
        }
      }
      paint();
    } catch (e) { failed(e); }
  }

  function messageActions(message, mine) {
    const items = [];
    items.push({ label: 'Reply first', icon: 'arrow-up', onClick: () => { replyTo = message; paintReply(); input.focus(); } });
    items.push({ label: 'Copy the words', icon: 'edit', onClick: async () => {
      try { await navigator.clipboard.writeText(message.content); toast('Copied', { type: 'success' }); }
      catch { toast('This device will not copy.', { type: 'danger' }); }
    } });
    if (message.replyCount > 0) items.push({ label: 'Read the replies', icon: 'message', onClick: () => threadSheet(message) });
    if (!isDm && scope.serverId) {
      items.push({ label: message.pinned ? 'Take off the pins' : 'Pin here', icon: 'pin', onClick: async () => {
        try {
          if (message.pinned) await Api.unpinMessage(scope.serverId, scope.id, message.id);
          else await Api.pinMessage(scope.serverId, scope.id, message.id);
          message.pinned = !message.pinned; paint();
        } catch (e) { failed(e); }
      } });
    }
    items.push({ label: 'Add a feeling', icon: 'message-square', onClick: () => reactionSheet(message) });
    // A message you did not write can be reported where it stands: the
    // report freezes the words and points at their author. Yours cannot be,
    // and a message still on its way is not on the server yet.
    if (!mine && !message.pending) {
      items.push({ label: 'Report', icon: 'flag', onClick: () => reportSheet({
        title: 'Report this message',
        who: message.authorDisplay || message.authorName || 'its author',
        payload: (reason, description) => ({
          targetType: isDm ? 'dm' : 'message',
          targetId: message.id,
          serverId: isDm ? undefined : (scope.serverId || undefined),
          reason, description,
        }),
      }) });
    }
    if (mine) {
      items.push({ label: 'Edit', icon: 'edit', onClick: () => editSheet(message) });
      items.push({ label: 'Delete', icon: 'trash', danger: true, onClick: async () => {
        if (!(await confirm({ title: 'Delete this message?', text: 'No one will read it again.', confirmLabel: 'Delete', danger: true }))) return;
        try {
          if (isDm) await Api.deleteDm(scope.id, message.id);
          else await Api.deleteMessage(scope.id, message.id);
          remove(message.id);
        } catch (e) { failed(e); }
      } });
    }
    return items;
  }

  function reactionSheet(message) {
    const layer = sheet({ title: 'Add a feeling' });
    const feelings = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀'];
    layer.body.appendChild(el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
      feelings.map((emoji) => el('button', {
        class: 'm-msg__reaction', type: 'button',
        onClick: () => { layer.close(); toggleReaction(message, emoji); },
      }, emoji))));
  }

  function editSheet(message) {
    const layer = sheet({ title: 'Edit the words' });
    const area = el('textarea', { class: 'm-area', 'aria-label': 'Message' }, message.content);
    const go = el('button', { class: 'm-go m-go--block', type: 'button' }, 'Save');
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        if (isDm) await Api.updateDm(scope.id, message.id, area.value);
        else await Api.updateMessage(scope.id, message.id, { content: area.value });
        message.content = area.value;
        message.editedAt = new Date().toISOString();
        layer.close(); paint();
      } catch (e) { failed(e); go.disabled = false; }
    });
    layer.body.append(area, go);
  }

  async function threadSheet(root) {
    const layer = sheet({ title: 'The replies' });
    layer.body.appendChild(hold());
    try {
      const page = await Api.thread(isDm ? 'dm' : 'channel', scope.id, root.id);
      clear(layer.body);
      const replies = (page && page.messages) || page || [];
      for (const raw of replies) {
        const message = normalizeMessage(await encrypted.readRow(raw, scope.id));
        if (!message) continue;
        layer.body.appendChild(el('div', { class: 'm-thread__row' },
          avatar(authorOf(message), { size: 'sm' }),
          el('div', { class: 'm-thread__body' },
            el('div', { class: 'm-msg__meta' }, el('span', { class: 'm-msg__author' }, message.authorDisplay || 'Someone')),
            el('div', {}, message.content))));
      }
      const area = el('textarea', { class: 'm-area', placeholder: 'A reply, in the thread', 'aria-label': 'Reply' });
      const go = el('button', { class: 'm-go', type: 'button' }, 'Reply');
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          const body = { content: area.value, replyToId: root.id };
          const post = isDm ? (b) => Api.sendDm(scope.id, b) : (b) => Api.sendMessage(scope.id, b);
          await encrypted.send(scope.id, body, post);
          layer.close();
        } catch (e) { failed(e); go.disabled = false; }
      });
      layer.body.appendChild(el('div', { class: 'm-thread__form' }, area, go));
    } catch (e) {
      clear(layer.body);
      layer.body.appendChild(failure(e, () => threadSheet(root)));
    }
  }

  // --- the composer ------------------------------------------------------------

  const input = el('textarea', {
    class: 'm-send__input', rows: '1',
    placeholder: (context && context.placeholder) || scope.placeholder || 'Say something',
    'aria-label': 'Message',
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
  });
  // The multifunction button. One press asks what is being sent, because a
  // library, a camera and a file system are three different pickers with
  // three different permissions — a single input that pretends otherwise
  // opens the wrong one.
  const pickImages = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, 'aria-label': 'Photos and videos' });
  const pickCamera = el('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-label': 'Take a photo' });
  const pickCameraCapture = true;
  if (pickCameraCapture) pickCamera.capture = 'environment';
  const pickFiles = el('input', { type: 'file', multiple: true, hidden: true, 'aria-label': 'Files' });

  let picks = [];

  function addPicks(list, kind) {
    for (const file of list || []) {
      picks.push({
        file,
        kind: kind === 'image' ? 'image' : 'file',
        url: kind === 'image' ? URL.createObjectURL(file) : null,
      });
    }
    paintChips();
  }

  pickImages.addEventListener('change', () => { addPicks(pickImages.files, 'image'); pickImages.value = ''; });
  pickCamera.addEventListener('change', () => { addPicks(pickCamera.files, 'image'); pickCamera.value = ''; });
  pickFiles.addEventListener('change', () => { addPicks(pickFiles.files, 'file'); pickFiles.value = ''; });

  function dropPick(pick) {
    if (pick.url) URL.revokeObjectURL(pick.url);
    picks = picks.filter((entry) => entry !== pick);
    paintChips();
  }

  const chips = el('div', { class: 'm-send__picks', hidden: true });
  function paintChips() {
    clear(chips);
    chips.hidden = !picks.length;
    for (const pick of picks) {
      if (pick.kind === 'image') {
        chips.appendChild(el('span', { class: 'm-send__tile' },
          el('img', { src: pick.url, alt: pick.file.name }),
          el('button', {
            class: 'm-send__tile-x', type: 'button', 'aria-label': 'Drop ' + pick.file.name,
            onClick: () => dropPick(pick),
          }, icon('x', { size: 13 }))));
      } else {
        chips.appendChild(el('span', { class: 'm-send__chip' },
          el('span', { class: 'truncate' }, pick.file.name + ' · ' + fileSize(pick.file.size)),
          el('button', { type: 'button', 'aria-label': 'Drop ' + pick.file.name, onClick: () => dropPick(pick) }, icon('x', { size: 14 }))));
      }
    }
  }

  function attachSheet() {
    const choice = (glyph, label, note, run) => el('button', {
      class: 'm-row', type: 'button',
      onClick: () => { closeSheet(); run(); },
    },
      el('span', { class: 'm-attach__glyph' }, icon(glyph, { size: 18 })),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__name' }, label),
        el('span', { class: 'm-row__note' }, note)));
    const layer = sheet({ title: 'Attach', note: 'What are you sending?' });
    layer.body.append(
      choice('image', 'Photos and videos', 'From this phone', () => pickImages.click()),
      choice('camera', 'Take a photo', 'Open the camera', () => pickCamera.click()),
      choice('file', 'Files', 'Documents and anything else', () => pickFiles.click()));
  }

  const replyBar = el('div', { hidden: true });
  function paintReply() {
    clear(replyBar);
    if (!replyTo) { replyBar.hidden = true; return; }
    replyBar.hidden = false;
    replyBar.appendChild(el('div', { class: 'm-reply' },
      el('span', { class: 'truncate' }, 'Replying to ' + (replyTo.authorDisplay || 'a message')),
      el('button', { class: 'm-reply__quit', type: 'button', 'aria-label': 'Stop replying', onClick: () => { replyTo = null; paintReply(); } }, icon('x', { size: 14 }))));
  }

  async function send() {
    const words = input.value.trim();
    if (!words && !picks.length) return;
    input.value = '';
    input.style.height = 'auto';
    const payload = { content: words };
    if (replyTo) payload.replyToId = replyTo.id;
    const pendingId = 'pending-' + Date.now();
    const images = picks.filter((pick) => pick.kind === 'image');
    if (images.length) {
      // The pictures travel with the pending row, so a slow network shows
      // what is on its way rather than an empty bubble.
      payload.attachments = images.map((pick) => ({
        url: pick.url,
        content_type: pick.file.type,
        filename: pick.file.name,
        size: pick.file.size,
      }));
    }
    upsert(normalizeMessage({
      id: pendingId, seq: -1, content: words,
      createdAt: new Date().toISOString(),
      authorId: State.user && State.user.id, pending: true,
      attachments: payload.attachments || [],
    }));
    try {
      if (picks.length) {
        const ids = [];
        for (const pick of picks) {
          const out = await encrypted.upload(scope.id, pick.file, (plainFile) => {
            const upload = isDm
              ? Api.uploadDmAttachment(scope.id, plainFile)
              : Api.uploadAttachment(scope.id, plainFile);
            return upload.promise;
          });
          const attachment = out && out.attachment ? out.attachment : out;
          if (attachment && attachment.id) ids.push(attachment.id);
        }
        if (ids.length) payload.attachmentIds = ids;
      }
      const post = isDm
        ? (b) => Api.sendDm(scope.id, b)
        : (b) => Api.sendMessage(scope.id, b);
      const sent = await encrypted.send(scope.id, payload, post);
      remove(pendingId);
      if (sent && sent.id) upsert(normalizeMessage(sent));
      for (const pick of picks) if (pick.url) URL.revokeObjectURL(pick.url);
      picks = [];
      replyTo = null;
      paintChips();
      paintReply();
    } catch (e) {
      remove(pendingId);
      failed(e);
      input.value = payload.content;
    }
  }

  const go = el('button', { class: 'm-send__go', type: 'button', 'aria-label': 'Send' }, icon('arrow-up', { size: 20 }));
  go.addEventListener('click', send);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
  });

  const composer = el('div', { class: 'm-send' },
    replyBar, chips,
    el('div', { class: 'm-send__field' },
      el('button', { class: 'm-send__attach', type: 'button', 'aria-label': 'Attach', onClick: attachSheet }, icon('plus', { size: 20 })),
      input, go),
    pickImages, pickCamera, pickFiles);

  // --- the realtime pipe ---------------------------------------------------------

  async function openFrame(frame) {
    const opened = await encrypted.readRow(Object.assign({}, frame, { conversationId: scope.id }), scope.id);
    upsert(normalizeMessage(opened));
  }

  function subscribe() {
    offs.push(realtime.on('open', catchUp));
    const stream = isDm ? 'dm' : 'channel';
    if (isDm) {
      offs.push(realtime.on(EVENTS.DM_MESSAGE, (frame) => { if (String(frame.conversationId) === String(scope.id)) openFrame(frame); }));
      offs.push(realtime.on(EVENTS.DM_MESSAGE_UPDATED, (frame) => { if (String(frame.conversationId) === String(scope.id)) openFrame(frame); }));
      offs.push(realtime.on(EVENTS.DM_MESSAGE_DELETED, (frame) => { if (String(frame.conversationId) === String(scope.id)) remove(frame.id); }));
      offs.push(realtime.on(EVENTS.DM_MESSAGE_EMBEDS, (frame) => {
        if (String(frame.conversationId) !== String(scope.id)) return;
        const known = find(frame.messageId);
        if (known) { known.embeds = frame.embeds || []; paint(); }
      }));
    } else {
      offs.push(realtime.on(EVENTS.MESSAGE, (frame) => { if (String(frame.channelId) === String(scope.id)) openFrame(frame); }));
      offs.push(realtime.on(EVENTS.MESSAGE_UPDATED, (frame) => { if (String(frame.channelId) === String(scope.id)) openFrame(frame); }));
      offs.push(realtime.on(EVENTS.MESSAGE_DELETED, (frame) => { if (String(frame.channelId) === String(scope.id)) remove(frame.id); }));
      offs.push(realtime.on(EVENTS.MESSAGE_EMBEDS, (frame) => {
        if (String(frame.channelId) !== String(scope.id)) return;
        const known = find(frame.messageId);
        if (known) { known.embeds = frame.embeds || []; paint(); }
      }));
      // A pin is a fact about the room: the row is told at once, whoever
      // pinned it.
      offs.push(realtime.on(EVENTS.MESSAGE_PINNED, (frame) => {
        const known = find(frame.messageId || (frame.message || {}).id);
        if (known) { known.pinned = true; paint(); }
      }));
      offs.push(realtime.on(EVENTS.MESSAGE_UNPINNED, (frame) => {
        const known = find(frame.messageId || (frame.message || {}).id);
        if (known) { known.pinned = false; paint(); }
      }));
    }
    // The direct chats pin too, under their own names.
    offs.push(realtime.on(EVENTS.DM_PINNED, (frame) => {
      if (String(frame.conversationId) !== String(scope.id)) return;
      const known = find(frame.messageId || (frame.message || {}).id);
      if (known) { known.pinned = true; paint(); }
    }));
    offs.push(realtime.on(EVENTS.DM_UNPINNED, (frame) => {
      if (String(frame.conversationId) !== String(scope.id)) return;
      const known = find(frame.messageId || (frame.message || {}).id);
      if (known) { known.pinned = false; paint(); }
    }));
  }

  async function catchUp() {
    const mine = generation;
    try {
      const page = await readPage({ limit: 20 });
      if (mine !== generation) return;
      for (const message of page) rows.set(String(message.id), message);
      paint();
    } catch { /* the next open tries again */ }
  }

  return {
    node: host,
    composer,
    onMount() {
      list.appendChild(hold());
      history().catch((e) => { clear(list); list.appendChild(failure(e, history)); });
      subscribe();
      toNewest();
    },
    cleanup() {
      generation += 1;
      for (const off of offs) { try { off(); } catch { /* an unsubscribe is safe twice */ } }
      offs.length = 0;
    },
  };
}

// --- the router wrapper -------------------------------------------------------

/**
 * The conversation page the router asks for. Both the DM and the channel
 * addresses land here; a voice channel is a room, not a reader.
 */
export function renderConvo(ctx) {
  const channel = ctx.channel;
  const isDm = ctx.page.id === 'dms.conversation';
  const scope = isDm
    ? { kind: 'dm', id: ctx.conversationId || ctx.params.id }
    : { kind: 'channel', id: (channel || {}).id || ctx.params.channel, serverId: ctx.serverId, placeholder: channel ? 'Say something in ' + channel.name : 'Say something' };

  if (!isDm && channel && (channel.type === 'voice' || channel.type === 'stage')) {
    return voiceRoom(channel, ctx.serverId);
  }

  const dm = isDm ? dmScope(scope.id) : null;
  const conversation = renderConversation({}, scope);

  return {
    node: conversation.node,
    composer: conversation.composer,
    bare: true,
    door: isDm ? '/dms' : '/communities',
    head: {
      back: true,
      title: isDm ? conversationTitle(dm) : (channel || {}).name || 'A channel',
      sub: isDm ? '@' + ((dm || {}).username || '') : 'in ' + ((serverOf(ctx) || {}).name || 'the place'),
      face: isDm && dm ? avatar(dm, { size: 'sm' }) : null,
      onFace: isDm && dm ? () => navigate(path('/users/' + dm.id)) : null,
      actions: isDm ? [] : [el('a', { class: 'm-bar__btn', href: path('/server/' + ctx.serverId + '/workspace'), 'aria-label': 'Files' }, icon('hard-drive', { size: 20 }))],
    },
    onMount: conversation.onMount,
    cleanup: conversation.cleanup,
  };
}

function dmScope(id) {
  const dm = (State.dms || []).find((d) => String(d.id) === String(id));
  if (!dm) return null;
  const others = (dm.people || dm.members || dm.users || []).filter((p) => !State.user || String(p.id) !== String(State.user.id));
  return normalizeUser(others[0] || {});
}

function conversationTitle(peer) {
  if (!peer) return 'A chat';
  return nameOf(peer) || peer.username || 'A chat';
}

function serverOf(ctx) { return (State.servers || []).find((s) => String(s.id) === String(ctx.serverId)) || null; }

// --- a voice room, on the phone -------------------------------------------------

function voiceRoom(channel, serverId) {
  const host = el('div', { class: 'm-stack' });
  let off = null;

  function paint() {
    clear(host);
    const live = voice();
    const inRoom = live && live.channelId === channel.id;
    host.appendChild(emptyState('volume', channel.name || 'A voice room',
      inRoom ? 'You have the room. The desk has the video; the phone holds the words.'
        : 'A room for voices. Pressing join takes your seat.'));
    host.appendChild(el('button', {
      class: 'm-go m-go--block' + (inRoom ? ' m-go--danger' : ''),
      type: 'button',
      onClick: async () => {
        try {
          if (inRoom) { const { leave } = await import('../../../packages/voiceSession.js'); leave(); paint(); }
          else { await joinVoice(channel); paint(); }
        } catch (e) { failed(e); }
      },
    }, inRoom ? 'Leave the room' : 'Join the room'));
    if (live && inRoom) {
      host.appendChild(el('div', { class: 'm-kicker' }, 'In the room'));
      host.appendChild(el('div', { class: 'm-card' },
        (live.participants || []).map((p) => el('div', { class: 'm-row' },
          avatar({ id: p.userId, username: p.username, displayName: p.displayName }, { size: 'sm' }),
          el('div', { class: 'm-row__body' }, el('div', { class: 'm-row__name' }, p.displayName || p.username || 'A voice')),
          p.muted ? el('span', { class: 'muted' }, 'muted') : null))));
    }
  }

  return {
    node: host,
    bare: false,
    door: '/communities',
    head: { back: true, title: channel.name || 'A voice room' },
    onMount() {
      paint();
      off = () => {};
    },
    cleanup() { if (off) off(); },
  };
}
