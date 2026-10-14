// A conversation.
//
// One renderer for a channel and for a direct message, because on screen they
// are the same thing: a scroll of grouped messages, the actions each one
// carries, and a composer. What differs is the routes that read and write the
// scroll, so those are the only thing passed in.

import { el, clear } from '../dom.js';
import { icon } from '../icons.js';
import { avatar } from '../components.js';
import { State } from '../store.js';
import { openMenu, openDialog, confirmDialog, errorToast } from '../ui.js';
import { mediaUrl, isServerPath } from '../media.js';
import { dayLabel, toDate, timeOfDay, fullTimestamp, fileSize } from '../format.js';
import realtime, { EVENTS } from '../realtime.js';
import { navigate, path } from '../nav.js';
import Api from '../api.js';

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
  if (raw.conversationId !== undefined && raw.conversationId !== null) {
    return {
      id: raw.id,
      seq: raw.seq,
      content: raw.content || '',
      createdAt: raw.createdAt || raw.created_at,
      editedAt: raw.editedAt || raw.edited_at || null,
      authorId: raw.authorId,
      authorName: raw.authorName || '',
      authorDisplay: raw.authorDisplay || raw.authorName || '',
      authorAvatar: raw.authorAvatar || null,
      replyCount: raw.replyCount || 0,
      attachments: raw.attachments || [],
      reactions: raw.reactions || [],
      embeds: raw.embeds || [],
      pinned: false,
    };
  }
  return {
    id: raw.id,
    seq: raw.seq,
    content: raw.content || '',
    createdAt: raw.created_at,
    editedAt: raw.edited_at || null,
    authorId: raw.author_id,
    authorName: raw.user || raw.author_name || '',
    authorDisplay: raw.author_display || raw.user || '',
    authorAvatar: raw.author_avatar || null,
    replyCount: raw.reply_count || 0,
    attachments: raw.attachments || [],
    reactions: raw.reactions || [],
    embeds: raw.embeds || [],
    pinned: !!raw.pinned,
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
  return (Array.isArray(rows) ? rows : []).map(normalizeMessage).sort(bySeq);
}

// -- inline ------------------------------------------------------------------

function renderRich(container, text) {
  const pattern = /(https?:\/\/[^\s]+|`[^`]+`|\*\*\*[^*]+\*\*\*|___[^_]+___|\*\*[^*]+\*\*|__[^_]+__|_[^_]+_|\*[^*]+\*|~~[^~]+~~|@[\w.-]+|#[\w-]+)/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) container.appendChild(document.createTextNode(text.slice(last, match.index)));
    container.appendChild(inlineToken(match[0]));
    last = pattern.lastIndex;
  }
  if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
}

function inlineToken(token) {
  if (/^https?:\/\//.test(token)) return el('a', { class: 'msg-link', href: token, target: '_blank', rel: 'noreferrer' }, token);
  if (/^(\*\*\*|___).+(\*\*\*|___)$/.test(token)) return el('strong', {}, el('em', {}, token.slice(3, -3)));
  if (/^(\*\*|__).+(\*\*|__)$/.test(token)) return el('strong', {}, token.slice(2, -2));
  if (/^(\*|_).+(\*|_)$/.test(token)) return el('em', {}, token.slice(1, -1));
  if (/^~~.+~~$/.test(token)) return el('s', {}, token.slice(2, -2));
  if (/^`.+`$/.test(token)) return el('code', {}, token.slice(1, -1));
  if (/^@/.test(token)) return el('span', { class: 'mention' }, token);
  if (/^#/.test(token)) return el('span', { class: 'mention' }, token);
  return document.createTextNode(token);
}

function loadMedia(node, url) {
  if (isServerPath(url)) mediaUrl(url).then((resolved) => { if (resolved) node.src = resolved; });
  else node.src = url;
}

function attachmentNode(att) {
  const mime = String(att.mime || '');
  const url = att.url || ('/api/attachments/' + att.id);

  if (/^image\//.test(mime)) {
    const img = el('img', { alt: att.filename || 'image', loading: 'lazy', style: { maxHeight: '320px', borderRadius: 'var(--radius-md)', marginTop: '6px' } });
    loadMedia(img, url);
    return img;
  }
  if (/^(video|audio)\//.test(mime)) {
    const tag = /^video\//.test(mime) ? 'video' : 'audio';
    const player = el(tag, { controls: true, preload: 'metadata', style: { maxWidth: '420px', marginTop: '6px' } });
    loadMedia(player, url);
    return player;
  }
  return el('a', { class: 'attachment', href: url, target: '_blank', rel: 'noreferrer' },
    el('span', { class: 'attachment-icon' }, icon('file', { size: 18 })),
    el('span', {},
      el('div', { class: 'attachment-name truncate' }, att.filename || 'file'),
      att.size ? el('div', { class: 'attachment-size' }, fileSize(att.size)) : null),
  );
}

function reactionRow(message, handlers) {
  const row = el('div', { class: 'msg-reactions reactions' });
  for (const reaction of message.reactions || []) {
    row.appendChild(el('button', {
      class: 'reaction' + (reaction.mine ? ' reaction--mine' : ''),
      type: 'button',
      title: reaction.count + ' reacted',
      onClick: () => handlers.toggleReaction(message, reaction.emoji, !!reaction.mine),
    }, el('span', {}, reaction.emoji), el('span', {}, String(reaction.count))));
  }
  row.appendChild(el('button', {
    class: 'reaction reaction-add', type: 'button', title: 'Add reaction', 'aria-label': 'Add reaction',
    onClick: (event) => handlers.emojis(message, event.currentTarget),
  }, icon('smile', { size: 15 })));
  return row;
}

function messageRow(message, previous, handlers) {
  const compact = previous
    && previous.authorId === message.authorId
    && dayKey(previous.createdAt) === dayKey(message.createdAt)
    && (toDate(message.createdAt) - toDate(previous.createdAt)) < 1000 * 60 * 7;

  const node = el('article', { class: 'msg' + (compact ? ' msg--compact' : ''), dataset: { id: message.id }, id: 'm-' + message.id });

  const gutter = el('div', { class: 'msg-gutter' });
  if (compact) gutter.appendChild(el('span', { class: 'msg-time-gutter' }, timeOfDay(message.createdAt)));
  else gutter.appendChild(avatar(authorOf(message), { size: 'md' }));

  const main = el('div', { class: 'msg-main' });

  if (!compact) {
    const author = el('button', { class: 'msg-author', type: 'button' }, message.authorDisplay || message.authorName);
    author.addEventListener('click', () => handlers.openProfile(message.authorId));
    main.appendChild(el('div', { class: 'msg-head' },
      author,
      el('time', { class: 'msg-time', datetime: message.createdAt || '' }, fullTimestamp(message.createdAt)),
      message.pinned ? el('span', { class: 'msg-time', title: 'Pinned' }, ' pinned') : null,
    ));
  }

  if (message.content) {
    const text = el('div', { class: 'msg-text' });
    renderRich(text, message.content);
    main.appendChild(text);
  }

  for (const att of message.attachments || []) main.appendChild(attachmentNode(att));

  for (const card of message.embeds || []) {
    main.appendChild(el('a', { class: 'embed', href: card.url || '#', target: '_blank', rel: 'noreferrer' },
      el('div', { class: 'embed-title truncate' }, card.title || card.url || 'Link'),
      card.description ? el('div', { class: 'embed-text' }, card.description) : null,
    ));
  }

  main.appendChild(reactionRow(message, handlers));
  if (message.editedAt) main.appendChild(el('span', { class: 'msg-time msg-edited' }, ' (edited)'));
  if (message.replyCount) {
    main.appendChild(el('button', {
      class: 'msg-thread-badge', type: 'button',
      onClick: () => handlers.reply(message),
    },
      icon('message', { size: 14 }),
      el('span', { class: 'msg-thread-badge__count' }, String(message.replyCount)),
      el('span', {}, message.replyCount === 1 ? ' reply' : ' replies'),
    ));
  }

  node.append(gutter, main, el('div', { class: 'msg-actions' },
    el('button', { class: 'msg-tool', type: 'button', title: 'Reply', 'aria-label': 'Reply', onClick: () => handlers.reply(message) }, icon('reply', { size: 16 })),
    el('button', { class: 'msg-tool', type: 'button', title: 'React', 'aria-label': 'React', onClick: (event) => handlers.emojis(message, event.currentTarget) }, icon('smile', { size: 16 })),
    el('button', { class: 'msg-tool', type: 'button', title: 'More', 'aria-label': 'More', onClick: (event) => handlers.more(message, event.currentTarget) }, icon('more', { size: 16 })),
  ));
  return node;
}

// -- composer ----------------------------------------------------------------

function createComposer(scope, submit) {
  const input = el('textarea', {
    class: 'composer-input', rows: '1',
    placeholder: scope.placeholder || 'Message',
    'aria-label': scope.placeholder || 'Message',
  });
  const replyBar = el('div', { class: 'composer-note', hidden: true });
  const fileInput = el('input', { type: 'file', class: 'visually-hidden', multiple: true, 'aria-label': 'Attach files', tabindex: '-1' });
  const note = el('span', { class: 'composer-note' });
  const sendBtn = el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Send');

  const form = el('form', { class: 'composer' },
    replyBar, fileInput, input,
    el('div', { class: 'composer-bar' },
      el('button', { class: 'icon-btn', type: 'button', title: 'Attach a file', 'aria-label': 'Attach a file', onClick: () => fileInput.click() }, icon('paperclip', { size: 18 })),
      note,
      el('span', { class: 'spacer' }),
      sendBtn,
    ),
  );

  const staged = [];
  let replyTo = null;

  function update() {
    note.textContent = staged.length ? staged.length + (staged.length === 1 ? ' file attached' : ' files attached') : '';
  }

  fileInput.addEventListener('change', () => {
    for (const file of Array.from(fileInput.files || [])) staged.push(file);
    fileInput.value = '';
    update();
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 320) + 'px';
    // Typing is a DM-only signal on the wire, so a channel scope passes no
    // callback and nothing is sent. realtime.typing throttles to one frame
    // every few seconds while the writer keeps going.
    if (scope.onTyping) scope.onTyping();
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
    if (!content && !staged.length) return;
    sendBtn.disabled = true;
    try {
      await submit({ content, files: staged.slice(), replyTo });
      input.value = '';
      input.style.height = 'auto';
      staged.length = 0;
      replyTo = null;
      replyBar.hidden = true;
      clear(replyBar);
      update();
      input.focus();
    } catch (error) {
      errorToast(error);
    } finally {
      sendBtn.disabled = false;
    }
  });

  return {
    form,
    focus: () => input.focus(),
    setReply(message) {
      replyTo = message;
      replyBar.hidden = false;
      clear(replyBar);
      replyBar.append(
        el('span', {}, 'Replying to ' + (message.authorDisplay || message.authorName || 'a message')),
        el('button', { class: 'btn btn--sm btn--ghost', type: 'button', style: { marginLeft: '8px' }, onClick: () => { replyTo = null; replyBar.hidden = true; } }, 'Cancel'),
      );
      input.focus();
    },
  };
}

// -- the conversation --------------------------------------------------------

export function renderConversation(ctx, scope) {
  const state = { messages: [], draft: null };
  const list = el('div', { class: 'convo-scroll' });
  const node = el('div', { class: 'convo' }, list);

  // A phone has no hover, so a message's actions have to open on a tap: the
  // tapped row is marked and the previous one cleared. A tap that lands on a
  // link or a control is left to that control, and a mouse never reaches this,
  // because a hover already opens the same bar.
  if (window.matchMedia && window.matchMedia('(hover: none)').matches) {
    list.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest('a, button, input, textarea, select, img, video, audio')) return;
      const row = target.closest('.msg');
      const open = list.querySelector('.msg--hovered');
      if (open && open !== row) open.classList.remove('msg--hovered');
      if (row) row.classList.toggle('msg--hovered');
    });
  }
  let scroller = ctx.scroller || null;
  let atBottom = true;
  let loadingOlder = false;
  let typingNode = null;
  let typingTimer = 0;

  const isDm = scope.kind === 'dm';

  function paint() {
    const stick = atBottom;
    clear(list);
    if (!state.messages.length) {
      list.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon(scope.icon || 'hash', { size: 24 })),
        el('div', { class: 'empty-title' }, scope.emptyTitle || 'No messages yet'),
        el('div', { class: 'empty-text' }, scope.emptyText || 'Be the first to write here.'),
      ));
      if (stick && scroller) scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    let previous = null;
    const frag = document.createDocumentFragment();
    for (const message of state.messages) {
      if (!previous || dayKey(previous.createdAt) !== dayKey(message.createdAt)) {
        frag.appendChild(el('div', { class: 'date-sep' }, el('span', {}, dayLabel(message.createdAt))));
      }
      frag.appendChild(messageRow(message, previous, handlers));
      previous = message;
    }
    list.appendChild(frag);
    if (stick && scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  async function load() {
    try {
      state.messages = await readPage(scope, { limit: 50 });
      paint();
      scrollBottom();
      if (isDm) Api.dmRead(scope.id).catch(() => {});
    } catch (error) {
      clear(list);
      list.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'empty-title' }, 'Could not load this conversation'),
        el('div', { class: 'empty-text' }, error && error.message ? error.message : 'Something went wrong.'),
      ));
    }
  }

  function scrollBottom() {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  async function loadOlder() {
    if (loadingOlder || !state.messages.length) return;
    const oldest = state.messages[0].seq;
    if (oldest === undefined || oldest === null) return;
    loadingOlder = true;
    const anchorHeight = scroller ? scroller.scrollHeight : 0;
    const anchorTop = scroller ? scroller.scrollTop : 0;
    try {
      const rows = await readPage(scope, { before: oldest, limit: 50 });
      const known = new Set(state.messages.map((m) => m.id));
      const older = rows.filter((m) => !known.has(m.id));
      if (older.length) {
        state.messages = older.concat(state.messages).sort(bySeq);
        paint();
        if (scroller) scroller.scrollTop = scroller.scrollHeight - anchorHeight + anchorTop;
      }
    } catch (error) {
      errorToast(error);
    } finally {
      loadingOlder = false;
    }
  }

  // After a reconnect the room is rejoined, but anything said while the socket
  // was down is not in the scroll. Ask for everything past the highest sequence
  // we hold rather than reloading, so the reader keeps their place.
  async function catchUp() {
    let highest = 0;
    for (const message of state.messages) {
      const value = Number(message.seq);
      if (Number.isFinite(value) && value > highest) highest = value;
    }
    if (!highest) return;
    try {
      const rows = await readPage(scope, { after: highest, limit: 200 });
      if (!rows.length) return;
      const known = new Set(state.messages.map((m) => m.id));
      const fresh = rows.filter((m) => !known.has(m.id));
      if (!fresh.length) return;
      state.messages = state.messages.concat(fresh).sort(bySeq);
      paint();
    } catch { /* the next reconnect tries again */ }
  }

  function onScroll() {
    if (!scroller) return;
    atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
    if (scroller.scrollTop < 220) loadOlder();
  }

  function upsert(message) {
    const index = state.messages.findIndex((m) => m.id === message.id);
    if (index === -1) state.messages.push(message);
    else state.messages[index] = message;
    state.messages.sort(bySeq);
    paint();
  }

  function find(id) {
    return state.messages.find((m) => m.id === id) || null;
  }

  function remove(id) {
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
      errorToast(error);
    }
  }

  async function togglePin(message) {
    try {
      if (message.pinned) await Api.unpinMessage(scope.serverId, scope.id, message.id);
      else await Api.pinMessage(scope.serverId, scope.id, message.id);
      message.pinned = !message.pinned;
      paint();
    } catch (error) {
      errorToast(error);
    }
  }

  function edit(message) {
    const area = el('textarea', { class: 'input', rows: '4' }, message.content);
    let saved = message.content;
    openDialog({
      title: 'Edit message',
      body: area,
      foot: [
        (function () { const b = el('button', { class: 'btn btn--ghost', type: 'button' }, 'Cancel'); b.addEventListener('click', () => b.closest('.overlay').remove()); return b; })(),
        (function () { const b = el('button', { class: 'btn btn--primary', type: 'button' }, 'Save'); b.addEventListener('click', () => { saved = area.value.trim(); b.closest('.overlay').remove(); }); return b; })(),
      ],
      onClose: async () => {
        if (!saved || saved === message.content) return;
        try {
          if (isDm) await Api.updateDm(scope.id, message.id, saved);
          else await Api.updateMessage(scope.id, message.id, { content: saved });
        } catch (error) {
          errorToast(error);
        }
      },
    });
  }

  async function removeMessage(message) {
    const sure = await confirmDialog({ title: 'Delete this message?', body: 'This cannot be undone.', confirmLabel: 'Delete', danger: true });
    if (!sure) return;
    try {
      if (isDm) await Api.deleteDm(scope.id, message.id);
      else await Api.deleteMessage(scope.id, message.id);
      remove(message.id);
    } catch (error) {
      errorToast(error);
    }
  }

  function copyText(value) {
    const text = String(value || '');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
    else {
      const area = el('textarea', { class: 'visually-hidden' }, text);
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch { /* nothing to do */ }
      area.remove();
    }
  }

  function linkTo(message) {
    const route = isDm
      ? '/dms/' + scope.id
      : '/server/' + scope.serverId + '/channel/' + scope.id;
    return window.location.origin + path(route) + '#m-' + message.id;
  }

  const handlers = {
    openProfile(userId) {
      if (userId) navigate('/users/' + userId);
    },
    reply(message) {
      composer.setReply(message);
    },
    emojis(message, anchor) {
      openMenu({
        anchor,
        items: QUICK.map((emoji) => ({
          label: emoji + '   react',
          onSelect: () => toggleReaction(message, emoji, false),
        })),
      });
    },
    more(message, anchor) {
      const mine = State.user && String(State.user.id) === String(message.authorId);
      const items = [
        { label: 'Copy text', icon: 'copy', onSelect: () => copyText(message.content) },
        { label: 'Copy link', icon: 'link', onSelect: () => copyText(linkTo(message)) },
        { label: 'Reply', icon: 'reply', onSelect: () => composer.setReply(message) },
      ];
      if (!isDm && scope.serverId) {
        items.push({ separator: true });
        items.push({ label: message.pinned ? 'Unpin' : 'Pin', icon: 'pin', onSelect: () => togglePin(message) });
      }
      if (mine) {
        items.push({ separator: true });
        items.push({ label: 'Edit', icon: 'edit', onSelect: () => edit(message) });
        items.push({ label: 'Delete', icon: 'trash', danger: true, onSelect: () => removeMessage(message) });
      }
      openMenu({ anchor, items, align: 'right' });
    },
    toggleReaction,
  };

  const composer = createComposer({
    placeholder: scope.placeholder,
    // Typing is a DM-only frame on the wire; a channel has no such signal, so
    // this stays null there and no callback is stored.
    onTyping: isDm ? () => realtime.typing(scope.id) : null,
  }, async (draft) => {
    const ids = [];
    for (const file of draft.files) {
      const upload = isDm ? Api.uploadDmAttachment(scope.id, file) : Api.uploadAttachment(scope.id, file);
      const out = await upload.promise;
      const attachment = out && out.attachment ? out.attachment : out;
      if (attachment && attachment.id) ids.push(attachment.id);
    }
    const body = { content: draft.content };
    if (ids.length) body.attachmentIds = ids;
    if (draft.replyTo) body.replyToId = draft.replyTo.id;
    // Draw the message the moment the write is accepted, rather than waiting on
    // the room echo. The echo still arrives - that is how another tab, another
    // device or a peer sees it - and upsert keys on id, so the two are one row.
    const sent = isDm ? await Api.sendDm(scope.id, body) : await Api.sendMessage(scope.id, body);
    if (sent && sent.id) upsert(normalizeMessage(sent));
  });
  // The composer belongs to the conversation, inside the stage body, so the
  // scroller is the message list and the composer stays pinned below it.
  node.appendChild(composer.form);

  function typingLine(username) {
    if (!typingNode) {
      typingNode = el('div', { class: 'typing' });
      list.appendChild(typingNode);
    }
    clear(typingNode);
    typingNode.append(
      el('span', { class: 'typing-dots' }, el('i'), el('i'), el('i')),
      el('span', {}, (username || 'Someone') + ' is typing'),
    );
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { if (typingNode) typingNode.remove(); typingNode = null; }, 5000);
  }

  const offs = [];

  function subscribe() {
    // A reconnect re-joins the room (realtime replays the last join on open),
    // but the gap in the scroll has to be fetched. 'open' also fires on the
    // first connect, where catchUp finds nothing above the loaded page.
    offs.push(realtime.on('open', catchUp));
    if (isDm) {
      offs.push(realtime.on(EVENTS.DM_MESSAGE, (frame) => {
        if (String(frame.conversationId) !== String(scope.id)) return;
        upsert(normalizeMessage(Object.assign({}, frame, { conversationId: scope.id })));
      }));
      offs.push(realtime.on(EVENTS.DM_MESSAGE_UPDATED, (frame) => {
        if (String(frame.conversationId) !== String(scope.id)) return;
        upsert(normalizeMessage(Object.assign({}, frame, { conversationId: scope.id })));
      }));
      offs.push(realtime.on(EVENTS.DM_MESSAGE_DELETED, (frame) => {
        if (String(frame.conversationId) !== String(scope.id)) return;
        remove(frame.id);
      }));
      offs.push(realtime.on(EVENTS.DM_TYPING, (frame) => {
        if (String(frame.conversationId) !== String(scope.id)) return;
        if (State.user && frame.userId === State.user.id) return;
        typingLine(frame.username);
      }));
      offs.push(realtime.on(EVENTS.DM_MESSAGE_EMBEDS, (frame) => {
        if (String(frame.conversationId) !== String(scope.id)) return;
        const known = find(frame.messageId);
        if (known) { known.embeds = frame.embeds || []; paint(); }
      }));
      return;
    }
    offs.push(realtime.on(EVENTS.MESSAGE, (frame) => {
      if (String(frame.channel_id) !== String(scope.id)) return;
      // No author skip: the channel room echoes to the sender too, which is how
      // a message sent from another tab or device lands here. The optimistic
      // insert above and this echo collapse onto one row by id.
      upsert(normalizeMessage(frame));
    }));
    offs.push(realtime.on(EVENTS.MESSAGE_UPDATED, (frame) => {
      if (String(frame.channel_id) !== String(scope.id)) return;
      const known = find(frame.id);
      if (known) upsert(Object.assign({}, known, frame));
    }));
    offs.push(realtime.on(EVENTS.MESSAGE_DELETED, (frame) => {
      if (String(frame.channel_id) !== String(scope.id)) return;
      remove(frame.id);
    }));
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
    composer: null,
    onMount() {
      scroller = list;
      if (scroller) scroller.addEventListener('scroll', onScroll, { passive: true });
      subscribe();
      // Join before the first read, so a message that arrives while the history
      // is in flight is delivered to the listener that can draw it.
      if (isDm) realtime.joinDm(scope.id);
      else { realtime.joinServer(scope.serverId); realtime.joinChannel(scope.id); }
      composer.focus();
      load();
    },
    cleanup() {
      if (scroller) scroller.removeEventListener('scroll', onScroll);
      for (const off of offs) off();
      offs.length = 0;
      clearTimeout(typingTimer);
      // Leave on the way out. The socket is shared and single-valued per room,
      // so a stale membership is another conversation's events with nothing
      // left on screen to draw them.
      if (isDm) realtime.leaveDm();
      else { realtime.leaveChannel(); realtime.leaveServer(); }
    },
  };
}

export default { renderConversation };
