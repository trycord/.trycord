// A conversation, on a phone.
//
// One renderer for a channel and for a direct message, because the two are the
// same thing on a small screen: a scroll of grouped messages and a composer
// pinned above the keyboard. What differs is the routes that read and write the
// scroll, so those are the only thing passed in. This is the Mobile module's own
// conversation engine; it shares the platform packages and nothing else.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { avatar } from '../components.js';
import { State } from '../../../packages/store.js';
import { menu, confirm, toast, sheet, attachLongPress } from '../ui.js';
import { copyText } from '../clipboard.js';
import { embedCard, imagesOf, kindOf } from '../embeds.js';
import { mediaUrl } from '../../../packages/media.js';
import { saveDraft, clearDraft, restoreDraft } from '../../../packages/drafts.js';
import { dayLabel, toDate, timeOfDay, fileSize } from '../../../packages/format.js';
import realtime, { EVENTS } from '../../../packages/realtime.js';
import { navigate, path } from '../../../packages/nav.js';
import Api from '../../../packages/api.js';
import { empty } from '../components.js';
import { templateSheet, collectionSheet, expandInDraft } from '../saved.js';
import * as encrypted from '../encrypted.js';

const QUICK = ['\u{1F44D}', '\u{1F525}', '\u{1F389}', '\u{1F602}', '\u{1F440}', '\u{2705}'];

function dayKey(value) {
  const date = toDate(value);
  if (!date) return '';
  return date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate();
}

function bySeq(a, b) {
  const sa = a.seq === undefined || a.seq === null ? 0 : a.seq;
  const sb = b.seq === undefined || b.seq === null ? 0 : b.seq;
  if (sa !== sb) return sa - sb;
  return toDate(a.createdAt) - toDate(b.createdAt);
}

// The wire is not uniform: a channel message is snake_case with an author_*
// block, a direct message is camelCase. Reading both here leaves the list below
// one shape to answer for.
function normalizeMessage(raw) {
  if (!raw) return null;
  if (raw.conversationId !== undefined && raw.conversationId !== null) {
    return {
      id: raw.id,
      seq: raw.seq,
      content: raw.content || '',
      createdAt: raw.createdAt || raw.created_at,
      editedAt: raw.editedAt || raw.edited_at || null,
      authorId: raw.authorId,
      authorName: raw.authorName,
      authorDisplay: raw.authorDisplay || raw.authorName,
      authorAvatar: raw.authorAvatar || raw.author_avatar || null,
      // Whether the author is a bot. The server says so; a name that says
      // "bot" is not a substitute for knowing it.
      authorIsBot: !!(raw.authorIsBot || raw.author_is_bot),
      replyCount: raw.replyCount || raw.reply_count || 0,
      attachments: raw.attachments || [],
      reactions: raw.reactions || [],
      embeds: raw.embeds || [],
      pinned: !!raw.pinned,
      // An encrypted message, and whether this device could open it. The
      // server holds no text for an encrypted message, so a message that
      // could not be opened has a reason and not an empty body.
      encrypted: !!raw.encrypted,
      unreadable: !!raw.unreadable,
    };
  }
  return {
    id: raw.id,
    seq: raw.seq,
    content: raw.content || '',
    createdAt: raw.createdAt || raw.created_at,
    editedAt: raw.editedAt || raw.edited_at || null,
    authorId: raw.authorId || raw.author_id,
    authorName: raw.authorName || raw.username || raw.user,
    authorDisplay: raw.authorDisplay || raw.display_name || raw.user,
    authorAvatar: raw.authorAvatar || raw.author_avatar || null,
    replyCount: raw.replyCount || raw.reply_count || 0,
    attachments: raw.attachments || [],
    reactions: raw.reactions || [],
    embeds: raw.embeds || [],
    pinned: !!raw.pinned,
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

async function readPage(scope, options) {
  const rows = scope.kind === 'dm'
    ? await Api.dmMessages(scope.id, options)
    : await Api.messages(scope.id, options);
  // The rows are opened before they are drawn: an encrypted row carries no
  // text from the server, so it has to be opened here or it is drawn as an
  // empty message.
  const opened = await encrypted.readRows(Array.isArray(rows) ? rows : [], scope.id);
  return opened.map(normalizeMessage).filter(Boolean).sort(bySeq);
}

function renderRich(container, text) {
  const pattern = /(https?:\/\/[^\s]+|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|@[a-zA-Z0-9_.-]{2,32}|#[a-z0-9][a-z0-9-]{0,38})/g;
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

function attachmentNode(att) {
  const url = att.url || ('/api/attachments/' + att.id);
  const kind = String(att.content_type || att.contentType || '');
  const name = att.filename || 'Attachment';
  if (kind.indexOf('image/') === 0) {
    const img = el('img', { class: 'm-attach__image', alt: att.filename || 'image', loading: 'lazy' });
    mediaUrl(url).then((src) => { if (src) img.src = src; }).catch(() => {});
    const holder = el('div', { class: 'm-attach' }, img);
    attachLongPress(holder, () => attachmentMenuItems(att, url, name), { title: name });
    return holder;
  }
  if (kind.indexOf('video/') === 0 || kind.indexOf('audio/') === 0) {
    const tag = kind.indexOf('video/') === 0 ? 'video' : 'audio';
    const media = el(tag, { class: 'm-attach__media', controls: true, preload: 'metadata' });
    mediaUrl(url).then((src) => { if (src) media.src = src; }).catch(() => {});
    const holder = el('div', { class: 'm-attach' }, media);
    attachLongPress(holder, () => attachmentMenuItems(att, url, name), { title: name });
    return holder;
  }
  const link = el('a', { class: 'm-attach m-attach--file', href: url, target: '_blank', rel: 'noopener noreferrer' },
    icon('file', { size: 18 }),
    el('span', { class: 'm-attach__name truncate' }, name),
    att.size ? el('span', { class: 'm-attach__size' }, fileSize(att.size)) : null);
  attachLongPress(link, () => attachmentMenuItems(att, url, name), { title: name });
  return link;
}

// The menu a file offers. Every entry acts on the file.
function attachmentMenuItems(att, url, name) {
  const items = [];
  if (url) {
    items.push({
      label: 'Open the file', icon: 'external',
      onSelect: () => { window.open(url, '_blank', 'noopener,noreferrer'); },
    });
    items.push({ label: 'Copy the address', icon: 'link', onSelect: () => copyText(url, 'File address') });
  }
  items.push({ label: 'Copy the name', icon: 'copy', onSelect: () => copyText(name, 'File name') });
  return items;
}

// The previews of one message. The images of the message are collected first
// so the sheet can move between them.
function embedRow(cards) {
  const list = cards || [];
  const images = imagesOf(list);
  let seen = 0;
  const holder = el('div', { class: 'm-embed-row' });
  for (const card of list) {
    let index = 0;
    if (kindOf(card) === 'image') { index = seen; seen += 1; }
    holder.appendChild(embedCard(card, { images, index, onCopy: copyText }));
  }
  return holder;
}

function reactionRow(message, handlers) {
  const row = el('div', { class: 'm-reactions' });
  for (const reaction of message.reactions || []) {
    row.appendChild(el('button', {
      class: 'm-reaction' + (reaction.mine ? ' is-mine' : ''),
      type: 'button', 'aria-label': reaction.emoji + ' ' + reaction.count,
      onClick: (event) => { event.stopPropagation(); handlers.toggleReaction(message, reaction.emoji, !!reaction.mine); },
    }, el('span', {}, reaction.emoji), el('span', {}, String(reaction.count))));
  }
  return row;
}

function messageRow(message, previous, handlers) {
  const who = authorOf(message);
  const compact = previous
    && previous.authorId === message.authorId
    && dayKey(previous.createdAt) === dayKey(message.createdAt)
    && (toDate(message.createdAt) - toDate(previous.createdAt)) < 1000 * 60 * 7;

  const node = el('article', { class: 'm-msg' + (compact ? ' m-msg--compact' : ''), dataset: { id: message.id }, id: 'm-' + message.id });

  const gutter = el('div', { class: 'm-msg__gutter' });
  if (compact) gutter.appendChild(el('span', { class: 'm-msg__gutter-time' }, timeOfDay(message.createdAt)));
  else gutter.appendChild(avatar(authorOf(message), { size: 'sm', decorative: true }));

  const main = el('div', { class: 'm-msg__main' });
  if (!compact) {
    main.appendChild(el('div', { class: 'm-msg__head' },
      el('button', { class: 'm-msg__author', type: 'button', onClick: () => handlers.openProfile(message.authorId) },
        message.authorDisplay || message.authorName || 'Unknown',
        message.authorIsBot ? el('span', { class: 'botflag', title: 'This is a bot' }, 'BOT') : null),
      el('time', { class: 'm-msg__time', datetime: message.createdAt || '' }, timeOfDay(message.createdAt))));
  }
  if (message.content) {
    const body = el('div', { class: 'm-msg__text' });
    if (message.unreadable) {
      // A message this device could not open. It is not an error in the
      // message and it is not empty: the text is in the envelope, and this
      // device does not have the key.
      body.appendChild(el('p', { class: 'm-unreadable' },
        message.content || 'This message could not be opened on this device.'));
    } else {
      renderRich(body, message.content);
    }
    main.appendChild(body);
  }
  for (const att of message.attachments || []) main.appendChild(attachmentNode(att));
  if ((message.embeds || []).length) main.appendChild(embedRow(message.embeds));
  if ((message.reactions || []).length) main.appendChild(reactionRow(message, handlers));
  if (message.editedAt) main.appendChild(el('span', { class: 'm-msg__edited' }, 'edited'));
  if (message.replyCount) {
    main.appendChild(el('button', { class: 'm-msg__thread', type: 'button', onClick: () => handlers.thread(message) },
      icon('message', { size: 14 }), String(message.replyCount) + (message.replyCount === 1 ? ' reply' : ' replies')));
  }

  // A tap on the row body opens the message's own sheet. Taps that land on a
  // link, an attachment or a control are left to that control.
  node.addEventListener('click', (event) => {
    const target = event.target;
    if (target && typeof target.closest === 'function'
      && target.closest('a, button, input, textarea, select, img, video, audio')) return;
    handlers.open(message);
  });

  node.append(gutter, main);
  return node;
}

function createComposer(scope, submit) {
  const input = el('textarea', {
    class: 'm-composer__input', rows: '1',
    placeholder: scope.placeholder || 'Message',
    'aria-label': scope.placeholder || 'Message',
  });
  // The draft is in the box before the conversation is: a reader who comes
  // back to a conversation finds what they were writing.
  restoreDraft(scope.id, input);
  const replyBar = el('div', { class: 'm-composer__reply', hidden: true });
  const fileInput = el('input', { type: 'file', class: 'visually-hidden', multiple: true, 'aria-label': 'Attach files', tabindex: '-1' });
  const staged = el('div', { class: 'm-composer__staged' });
  const form = el('form', { class: 'm-composer' },
    replyBar, staged, fileInput, input,
    el('div', { class: 'm-composer__bar' },
      el('button', { class: 'm-iconbtn', type: 'button', title: 'Attach a file', 'aria-label': 'Attach a file', onClick: () => fileInput.click() }, icon('paperclip', { size: 20 })),
      el('button', { class: 'm-iconbtn', type: 'button', title: 'Insert a template', 'aria-label': 'Insert a template', onClick: () => openTemplates() }, icon('zap', { size: 20 })),
      el('span', { class: 'm-spacer' }),
      el('button', { class: 'm-composer__send', type: 'submit', 'aria-label': 'Send' }, icon('send', { size: 20 }))));

  const files = [];
  let replyTo = null;
  let expanding = false;

  // The template picker: the reader's own templates, and the way one of them
  // is put into the draft.
  function openTemplates() {
    templateSheet((entry) => {
      const body = String((entry && entry.body) || '');
      const at = input.selectionStart === null ? input.value.length : input.selectionStart;
      input.value = input.value.slice(0, at) + body + input.value.slice(at);
      input.setSelectionRange(at + body.length, at + body.length);
      input.focus();
    });
  }

  function updateStaged() {
    clear(staged);
    staged.hidden = files.length === 0;
    for (let i = 0; i < files.length; i++) {
      staged.appendChild(el('span', { class: 'm-chip' }, files[i].name));
    }
  }

  fileInput.addEventListener('change', () => {
    for (const file of Array.from(fileInput.files || [])) files.push(file);
    fileInput.value = '';
    updateStaged();
  });

  input.addEventListener('input', () => {
    // The draft is remembered as it is written, so a reader who goes to
    // another conversation and comes back finds their sentence where they
    // left it - and so does a reader whose phone reloads.
    saveDraft(scope.id, input.value);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    if (scope.onTyping) scope.onTyping();
    // A shortcut is expanded when the reader has finished the word. The
    // templates are read once, so this costs nothing per keystroke.
    if (expanding) return;
    expanding = true;
    expandInDraft(input.value).then((expanded) => {
      if (!expanded) return;
      input.value = expanded.text;
      input.setSelectionRange(input.value.length, input.value.length);
    }).catch(() => { /* a template that cannot be read is not expanded */ })
      .finally(() => { expanding = false; });
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content && !files.length) return;
    const send = form.querySelector('.m-composer__send');
    if (send) send.disabled = true;
    try {
      await submit({ content, files: files.slice(), replyTo });
      // The draft is forgotten when the message is sent. A send that failed
      // leaves it alone, because the text is still in the box.
      clearDraft(scope.id);
      input.value = '';
      input.style.height = 'auto';
      files.length = 0;
      updateStaged();
      replyTo = null;
      replyBar.hidden = true;
      clear(replyBar);
      input.focus();
    } catch (error) {
      toast(error && error.message ? error.message : 'That did not send.', { type: 'danger' });
    } finally {
      if (send) send.disabled = false;
    }
  });

  return {
    form,
    focus: () => input.focus(),
    setReply(message) {
      replyTo = message;
      clear(replyBar);
      replyBar.hidden = false;
      replyBar.append(
        el('span', { class: 'truncate' }, 'Replying to ' + (message.authorDisplay || message.authorName || 'a message')),
        el('button', { class: 'm-iconbtn', type: 'button', 'aria-label': 'Cancel reply', onClick: () => { replyTo = null; replyBar.hidden = true; } }, icon('x', { size: 16 })));
      input.focus();
    },
  };
}

export function renderConversation(ctx, scope) {
  const state = { messages: [] };
  const list = el('div', { class: 'm-convo' });
  const node = list;
  let scroller = ctx.scroller || null;
  let atBottom = true;
  let loadingOlder = false;
  let mounted = false;
  let loadGeneration = 0;
  const isDm = scope.kind === 'dm';

  function paint() {
    if (!mounted) return;
    const stick = atBottom;
    clear(list);
    if (!state.messages.length) {
      list.appendChild(empty({
        icon: scope.icon || 'hash',
        title: scope.emptyTitle || 'No messages yet',
        text: scope.emptyText || 'Be the first to write here.',
      }));
      if (stick) scrollBottom();
      return;
    }
    let previous = null;
    const frag = document.createDocumentFragment();
    for (const message of state.messages) {
      if (!previous || dayKey(previous.createdAt) !== dayKey(message.createdAt)) {
        frag.appendChild(el('div', { class: 'm-date-sep' }, el('span', {}, dayLabel(message.createdAt))));
      }
      frag.appendChild(messageRow(message, previous, handlers));
      previous = message;
    }
    list.appendChild(frag);
    if (stick) scrollBottom();
  }

  function scrollBottom() {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  async function load() {
    const mine = ++loadGeneration;
    try {
      const messages = await readPage(scope, { limit: 50 });
      if (!mounted || mine !== loadGeneration) return;
      state.messages = messages;
      paint();
      requestAnimationFrame(scrollBottom);
      if (isDm) Api.dmRead(scope.id).catch(() => {});
    } catch (error) {
      if (!mounted || mine !== loadGeneration) return;
      clear(list);
      list.appendChild(empty({ title: 'Could not load this conversation', text: error && error.message ? error.message : 'Try again in a moment.' }));
    }
  }

  async function loadOlder() {
    if (!mounted || loadingOlder || !state.messages.length) return;
    const mine = loadGeneration;
    const oldest = state.messages[0].seq;
    if (oldest === undefined || oldest === null) return;
    loadingOlder = true;
    const anchorHeight = scroller ? scroller.scrollHeight : 0;
    const anchorTop = scroller ? scroller.scrollTop : 0;
    try {
      const rows = await readPage(scope, { before: oldest, limit: 50 });
      if (!mounted || mine !== loadGeneration) return;
      const known = new Set(state.messages.map((m) => m.id));
      const older = rows.filter((m) => !known.has(m.id));
      if (older.length) {
        state.messages = older.concat(state.messages).sort(bySeq);
        paint();
        if (scroller) scroller.scrollTop = scroller.scrollHeight - anchorHeight + anchorTop;
      }
    } catch (error) {
      if (!mounted || mine !== loadGeneration) return;
      toast(error && error.message ? error.message : 'Could not load earlier messages.', { type: 'danger' });
    } finally {
      loadingOlder = false;
    }
  }

  async function catchUp() {
    if (!mounted) return;
    const mine = loadGeneration;
    let highest = 0;
    for (const message of state.messages) {
      const value = Number(message.seq);
      if (Number.isFinite(value) && value > highest) highest = value;
    }
    if (!highest) return;
    try {
      const rows = await readPage(scope, { after: highest, limit: 200 });
      if (!mounted || mine !== loadGeneration) return;
      if (!rows.length) return;
      const known = new Set(state.messages.map((m) => m.id));
      const fresh = rows.filter((m) => !known.has(m.id));
      if (!fresh.length) return;
      state.messages = state.messages.concat(fresh).sort(bySeq);
      paint();
    } catch { /* the next reconnect tries again */ }
  }

  function onScroll() {
    if (!mounted || !scroller) return;
    atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
    if (scroller.scrollTop < 200) loadOlder();
  }

  function upsert(message) {
    if (!mounted || !message) return;
    const index = state.messages.findIndex((m) => m.id === message.id);
    if (index === -1) state.messages.push(message);
    else state.messages[index] = message;
    state.messages.sort(bySeq);
    paint();
  }

  function find(id) { return state.messages.find((m) => m.id === id) || null; }

  function remove(id) {
    if (!mounted) return;
    state.messages = state.messages.filter((m) => m.id !== id);
    paint();
  }

  async function toggleReaction(message, emoji, liked) {
    try {
      if (isDm) {
        if (liked) await Api.unreactDm(scope.id, message.id, emoji);
        else await Api.reactDm(scope.id, message.id, emoji);
      } else if (liked) {
        await Api.unreactChannel(scope.id, message.id, emoji);
      } else {
        await Api.reactChannel(scope.id, message.id, emoji);
      }
    } catch (error) {
      toast(error && error.message ? error.message : 'That reaction did not save.', { type: 'danger' });
    }
  }

  async function togglePin(message) {
    try {
      if (message.pinned) await Api.unpinMessage(scope.serverId, scope.id, message.id);
      else await Api.pinMessage(scope.serverId, scope.id, message.id);
      message.pinned = !message.pinned;
      paint();
    } catch (error) {
      toast(error && error.message ? error.message : 'That pin did not save.', { type: 'danger' });
    }
  }

  function edit(message) {
    const area = el('textarea', { class: 'm-input m-input--area', rows: '4' }, message.content);
    const layer = sheet({
      title: 'Edit message',
      body: area,
      footer: el('button', {
        class: 'm-btn m-btn--block m-btn--primary', type: 'button',
        onClick: async () => {
          const value = area.value.trim();
          layer.close();
          if (!value || value === message.content) return;
          try {
            if (isDm) await Api.updateDm(scope.id, message.id, value);
            else await Api.updateMessage(scope.id, message.id, { content: value });
          } catch (error) {
            toast(error && error.message ? error.message : 'That edit did not save.', { type: 'danger' });
          }
        },
      }, 'Save'),
    });
  }

  async function removeMessage(message) {
    const sure = await confirm({ title: 'Delete this message?', text: 'This cannot be undone.', confirmLabel: 'Delete', danger: true });
    if (!sure) return;
    try {
      if (isDm) await Api.deleteDm(scope.id, message.id);
      else await Api.deleteMessage(scope.id, message.id);
      remove(message.id);
    } catch (error) {
      toast(error && error.message ? error.message : 'That message did not delete.', { type: 'danger' });
    }
  }

  function linkTo(message) {
    const route = isDm ? '/dms/' + scope.id : '/server/' + scope.serverId + '/channel/' + scope.id;
    return window.location.origin + path(route) + '#m-' + message.id;
  }

  function reactMenu(message) {
    menu({
      title: 'React',
      items: QUICK.map((emoji) => ({ label: emoji, icon: emoji, onSelect: () => toggleReaction(message, emoji, false) })),
    });
  }

  async function thread(message) {
    if (!message.replyCount) return;
    const host = el('div', { class: 'm-thread' });
    sheet({ title: 'Thread', body: host });
    host.appendChild(el('div', { class: 'm-loading' }, 'Loading replies'));
    try {
      const rows = await Api.thread(isDm ? 'dm' : 'channel', scope.id, message.id);
      const replies = (Array.isArray(rows) ? rows : (rows && rows.replies) || []).map(normalizeMessage).filter(Boolean);
      clear(host);
      if (!replies.length) { host.appendChild(el('p', { class: 'm-lede' }, 'No replies yet.')); return; }
      for (const reply of replies) host.appendChild(messageRow(reply, null, handlers));
    } catch (error) {
      clear(host);
      host.appendChild(el('p', { class: 'm-lede' }, error && error.message ? error.message : 'Could not load the thread.'));
    }
  }

  const handlers = {
    openProfile(userId) { if (userId) navigate('/users/' + userId); },
    open(message) {
      const mine = State.user && String(State.user.id) === String(message.authorId);
      const items = [
        { label: 'Reply', icon: 'reply', onSelect: () => composer.setReply(message) },
        { label: 'React', icon: 'smile', onSelect: () => reactMenu(message) },
        { label: 'Copy text', icon: 'copy', onSelect: () => copyText(message.content) },
        { label: 'Copy link', icon: 'link', onSelect: () => copyText(linkTo(message)) },
      ];
      if (!isDm && scope.serverId) {
        items.push({ separator: true });
        items.push({ label: message.pinned ? 'Unpin' : 'Pin', icon: 'pin', onSelect: () => togglePin(message) });
        // A collection belongs to a community, so a message can only be saved
        // into one when the conversation is in one.
        items.push({ label: 'Save to a collection', icon: 'folder', onSelect: () => collectionSheet(scope.serverId, { itemType: 'message', itemId: message.id }) });
      }
      if (mine) {
        items.push({ separator: true });
        items.push({ label: 'Edit', icon: 'edit', onSelect: () => edit(message) });
        items.push({ label: 'Delete', icon: 'trash', danger: true, onSelect: () => removeMessage(message) });
      }
      menu({ title: message.authorDisplay || message.authorName || 'Message', items });
    },
    thread,
    toggleReaction,
  };

  const composer = createComposer({
    placeholder: scope.placeholder,
    onTyping: isDm ? () => realtime.typing(scope.id) : null,
  }, async (draft) => {
    const ids = [];
    for (const file of draft.files) {
      const out = await encrypted.upload(scope.id, file, (plainFile) => {
        const upload = isDm
          ? Api.uploadDmAttachment(scope.id, plainFile)
          : Api.uploadAttachment(scope.id, plainFile);
        return upload.promise;
      });
      const attachment = out && out.attachment ? out.attachment : out;
      if (attachment && attachment.id) ids.push(attachment.id);
    }
    const body = { content: draft.content };
    if (ids.length) body.attachmentIds = ids;
    if (draft.replyTo) body.replyToId = draft.replyTo.id;
    const post = isDm
      ? (b) => Api.sendDm(scope.id, b)
      : (b) => Api.sendMessage(scope.id, b);
    const sent = await encrypted.send(scope.id, body, post);
    if (sent && sent.id) upsert(normalizeMessage(sent));
  });

  const offs = [];

  function subscribe() {
    offs.push(realtime.on('open', catchUp));
    if (isDm) {
      offs.push(realtime.on(EVENTS.DM_MESSAGE, async (frame) => {
        if (String(frame.conversationId) !== String(scope.id)) return;
        const opened = await encrypted.readRow(
          Object.assign({}, frame, { conversationId: scope.id }), scope.id);
        upsert(normalizeMessage(opened));
      }));
      offs.push(realtime.on(EVENTS.DM_MESSAGE_UPDATED, async (frame) => {
        if (String(frame.conversationId) !== String(scope.id)) return;
        const opened = await encrypted.readRow(
          Object.assign({}, frame, { conversationId: scope.id }), scope.id);
        upsert(normalizeMessage(opened));
      }));
      offs.push(realtime.on(EVENTS.DM_MESSAGE_DELETED, (frame) => { if (String(frame.conversationId) === String(scope.id)) remove(frame.id); }));
      offs.push(realtime.on(EVENTS.DM_MESSAGE_EMBEDS, (frame) => {
        if (String(frame.conversationId) !== String(scope.id)) return;
        const known = find(frame.messageId);
        if (known) { known.embeds = frame.embeds || []; paint(); }
      }));
      return;
    }
    offs.push(realtime.on(EVENTS.MESSAGE, async (frame) => {
      if (String(frame.channel_id) !== String(scope.id)) return;
      upsert(normalizeMessage(await encrypted.readRow(frame, scope.id)));
    }));
    offs.push(realtime.on(EVENTS.MESSAGE_UPDATED, async (frame) => {
      if (String(frame.channel_id) !== String(scope.id)) return;
      const opened = await encrypted.readRow(frame, scope.id);
      const known = find(opened.id);
      if (known) upsert(Object.assign({}, known, normalizeMessage(opened)));
    }));
    offs.push(realtime.on(EVENTS.MESSAGE_DELETED, (frame) => { if (String(frame.channel_id) === String(scope.id)) remove(frame.id); }));
    offs.push(realtime.on(EVENTS.MESSAGE_REACTION, (frame) => {
      if (String(frame.channel_id) !== String(scope.id)) return;
      const known = find(frame.id);
      if (known) { known.reactions = frame.reactions || []; paint(); }
    }));
    offs.push(realtime.on(EVENTS.MESSAGE_PINNED, (frame) => {
      if (String(frame.channel_id) !== String(scope.id)) return;
      const known = find(frame.id);
      if (known) { known.pinned = true; paint(); }
    }));
    offs.push(realtime.on(EVENTS.MESSAGE_UNPINNED, (frame) => {
      if (String(frame.channel_id) !== String(scope.id)) return;
      const known = find(frame.id);
      if (known) { known.pinned = false; paint(); }
    }));
    offs.push(realtime.on(EVENTS.MESSAGE_EMBEDS, (frame) => {
      if (String(frame.channel_id) !== String(scope.id)) return;
      const known = find(frame.messageId);
      if (known) { known.embeds = frame.embeds || []; paint(); }
    }));
  }

  return {
    node,
    composer: composer.form,
    onMount() {
      if (mounted) return;
      mounted = true;
      loadGeneration += 1;
      scroller = ctx.scroller || scroller || node.parentElement;
      if (scroller) scroller.addEventListener('scroll', onScroll, { passive: true });
      subscribe();
      if (isDm) realtime.joinDm(scope.id);
      else { realtime.joinServer(scope.serverId); realtime.joinChannel(scope.id); }
      load();
    },
    cleanup() {
      mounted = false;
      loadGeneration += 1;
      if (scroller) scroller.removeEventListener('scroll', onScroll);
      for (const off of offs) off();
      offs.length = 0;
      if (isDm) realtime.leaveDm();
      else { realtime.leaveChannel(); realtime.leaveServer(); }
    },
  };
}

export default { renderConversation };
