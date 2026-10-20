// The conversation engine.
//
// A message timeline, a composer and the actions hanging off each message are
// the same work in a community channel and in a direct message. The two callers
// hand down only the transport - how to load, how to send, who may do what -
// and every decision about grouping, day breaks, edits, reactions, replies and
// threads is made once, here.
//
// The engine fetches nothing on its own. The caller composes it, routes the
// realtime events through the apply* functions and owns the lifecycle.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { avatar, spinner } from './primitives.js';
import { State, nameOf } from '../../packages/store.js';
import { blank } from './page.js';
import {
  openMenu, openContextMenu, openDialog, confirmDialog, errorToast,
  attachContextMenu,
} from './overlays.js';
import { copyText } from './clipboard.js';
import { embedCard, imagesOf, kindOf } from './embeds.js';

const QUICK_REACTIONS = ['👍', '❤️', '🔥', '🎉', '👀', '😅'];
const CHAT_EMOJI = ['😀', '😂', '🙂', '😍', '🥳', '👍', '🙏', '🔥', '💯', '🎉', '🤝', '👋'];
const GROUP_WINDOW_MS = 5 * 60 * 1000;

// -- normalisation ------------------------------------------------------------

export function asMessage(raw) {
  if (!raw) return null;
  const pick = (...names) => {
    for (const n of names) {
      if (raw[n] !== undefined && raw[n] !== null) return raw[n];
    }
    return null;
  };
  const reactions = raw.reactions;
  return {
    id: raw.id,
    seq: raw.seq === undefined || raw.seq === null ? null : Number(raw.seq),
    content: raw.content || '',
    createdAt: pick('createdAt', 'created_at'),
    editedAt: pick('editedAt', 'edited_at') || null,
    authorId: pick('authorId', 'author_id'),
    authorName: raw.authorName || raw.author_display || raw.author_name || 'Someone',
    authorAvatar: raw.author_avatar || raw.avatar_url || null,
    threadRootId: pick('threadRootId', 'thread_root_id') || null,
    replyCount: Number(pick('replyCount', 'reply_count') || 0),
    attachments: raw.attachments || [],
    embeds: raw.embeds || [],
    reactions: Array.isArray(reactions) ? reactions.slice() : [],
    pinned: !!raw.pinned,
    pending: !!raw.pending,
  };
}

function stampOf(m) {
  const t = m.createdAt ? new Date(m.createdAt) : null;
  return t && !Number.isNaN(t.getTime()) ? t : null;
}

function dayKeyOf(m) {
  const t = stampOf(m);
  return t ? t.toDateString() : '';
}

function readableDay(key) {
  const t = new Date(key);
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return t.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return (u === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[u];
}

export { copyText };

// -- pieces of one row ----------------------------------------------------------

// Inline message formatting: links, emphasis, inline code, @mentions and
// #channels are picked out of plain text and rendered as their own node. A
// scanner rather than a regex replace, so the pieces between tokens stay text
// and nothing nests wrong.
const INLINE_RULES = [
  { kind: 'link', re: /^https?:\/\/\S+/ },
  { kind: 'code', re: /^`[^`\n]+`/ },
  { kind: 'strongem', re: /^\*\*\*[^*\n]+\*\*\*/ },
  { kind: 'strong', re: /^\*\*[^*\n]+\*\*/ },
  { kind: 'em', re: /^\*[^*\n]+\*/ },
  { kind: 'strike', re: /^~~[^~\n]+~~/ },
  { kind: 'codeblockline', re: /^``[^`\n]+``/ },
  { kind: 'mention', re: /^@[\w.-]+/ },
  { kind: 'channel', re: /^#[\w-]+/ },
];

function richText(text) {
  const out = [];
  let rest = String(text || '');
  while (rest.length) {
    let hit = null;
    for (const rule of INLINE_RULES) {
      const m = rest.match(rule.re);
      if (m) { hit = { rule, m }; break; }
    }
    if (!hit) {
      out.push(rest[0]);
      rest = rest.slice(1);
      continue;
    }
    const token = hit.m[0];
    const tag = {
      link: () => el('a', { class: 'msg-link', href: token, target: '_blank', rel: 'noreferrer' }, token),
      code: () => el('code', {}, token.slice(1, -1)),
      strongem: () => el('strong', {}, el('em', {}, token.slice(3, -3))),
      strong: () => el('strong', {}, token.slice(2, -2)),
      em: () => el('em', {}, token.slice(1, -1)),
      strike: () => el('s', {}, token.slice(2, -2)),
      codeblockline: () => el('code', {}, token.slice(2, -2)),
      mention: () => el('span', { class: 'mention' }, token),
      channel: () => el('span', { class: 'mention' }, token),
    }[hit.rule.kind];
    out.push(tag());
    rest = rest.slice(token.length);
  }
  return out;
}

function inlineContent(m) {
  const nodes = richText(m.content || '');
  if (m.editedAt) nodes.push(' ', el('span', { class: 'msg-edited' }, '(edited)'));
  return nodes;
}

// A file the message carries. It is a link, so it opens where it is; the menu
// it carries offers the things a file can be asked for - its address, its name,
// and a copy of either.
function attachmentNode(a) {
  const url = a.url || a.objectUrl || '';
  const nice = a.name || a.filename || 'Attachment';
  const isImage = a.contentType && String(a.contentType).startsWith('image/');
  const node = isImage
    ? el('a', { class: 'msg-file msg-file--image', href: url, target: '_blank', rel: 'noreferrer' },
      el('img', { class: 'msg-image', src: url, alt: nice, loading: 'lazy', title: nice }))
    : el('a', { class: 'msg-file', href: url, target: '_blank', rel: 'noreferrer' },
      el('span', { class: 'msg-file-glyph' }, icon('download', { size: 15 })),
      el('span', { class: 'msg-file-name' }, nice),
      a.size ? el('span', { class: 'msg-file-size' }, humanSize(a.size)) : null);
  attachContextMenu(node, () => attachmentMenuItems(a, url, nice));
  return node;
}

// The menu a file offers. Every entry acts on the file and nothing else.
export function attachmentMenuItems(att, url, nice) {
  const items = [];
  if (url) {
    items.push({
      label: 'Open the file', icon: 'external',
      onSelect: () => { window.open(url, '_blank', 'noopener,noreferrer'); },
    });
    items.push({ label: 'Copy the address', icon: 'link', onSelect: () => copyText(url, 'File address') });
  }
  items.push({ label: 'Copy the name', icon: 'copy', onSelect: () => copyText(nice, 'File name') });
  return items;
}

// The previews of one message, drawn as cards. The images of the message are
// collected first so the lightbox can move between them.
function embedRow(cards) {
  const list = cards || [];
  const images = imagesOf(list);
  let seen = 0;
  return el('div', { class: 'msg-embeds' }, list.map((card) => {
    let index = 0;
    if (kindOf(card) === 'image') { index = seen; seen += 1; }
    return embedCard(card, { images, index });
  }));
}

function reactionChip(entry, toggle, live) {
  const names = entry.users && entry.users.length
    ? 'from ' + entry.users.length + ' reader' + (entry.users.length === 1 ? '' : 's')
    : 'from ' + entry.count;
  const face = el('span', { class: 'msg-reaction-emoji', 'aria-hidden': 'true' }, entry.emoji);
  const count = el('span', { class: 'msg-reaction-count' }, String(entry.count));
  const share = 'React with ' + entry.emoji + ' ' + names;
  if (!live) {
    return el('span', {
      class: 'msg-reaction' + (entry.mine ? ' msg-reaction--mine' : '') + ' msg-reaction--flat',
      title: entry.emoji + ' ' + names,
    }, face, count);
  }
  const chip = el('button', {
    class: 'msg-reaction' + (entry.mine ? ' msg-reaction--mine' : ''),
    type: 'button',
    'aria-label': (entry.mine ? 'Remove your ' : 'React with ') + entry.emoji + ' ' + names,
    'aria-pressed': entry.mine ? 'true' : 'false',
    title: entry.emoji + ' ' + names,
  }, face, count);
  chip.addEventListener('click', () => toggle(entry.emoji, entry.mine, share));
  return chip;
}

// -- the per-message menu -------------------------------------------------------
//
// One item builder serves every summoner: the hover tools and the right-click.
// `live` is false only for a read-only row (the pins page), whose menu copies
// and does nothing else, because a copy cannot be edited where it is copied to.

const messageMenu = (m, self, cfg, composer, openThread, del, live) => {
  const mine = m.reactions.find((entry) => entry.mine);
  const items = [];
  if (live) {
    items.push({ header: 'React' });
    items.push(...QUICK_REACTIONS.map((emoji) => ({
      label: emoji,
      onSelect: () => {
        if (!cfg.reactTo) return;
        Promise.resolve(cfg.reactTo(m.id, emoji)).catch((e) => errorToast(e));
      },
    })));
    items.push({ separator: true });
    items.push({ label: 'Reply', icon: 'reply', onSelect: () => composer.replyTo(m) });
    if (cfg.threadOf) {
      items.push({
        label: 'Open thread' + (m.replyCount ? ' (' + m.replyCount + ')' : ''),
        icon: 'message',
        onSelect: () => openThread(m),
      });
    }
  }
  items.push({
    label: 'Copy link', icon: 'link',
    onSelect: () => copyText(cfg.copyHref ? cfg.copyHref(m) : '', 'Message link'),
  });
  items.push({
    label: 'Copy text', icon: 'copy',
    onSelect: () => copyText(m.content || '', 'Message text'),
  });
  if (live) {
    if (self && !m.pending) {
      items.push({ separator: true });
      items.push({ label: 'Edit message', icon: 'edit', onSelect: () => composer.edit(m) });
      items.push({
        label: 'Delete message', icon: 'trash', danger: true,
        onSelect: () => confirmDialog({
          title: 'Delete this message?',
          body: (m.content || '').slice(0, 140) || 'This message has no text.',
          confirmLabel: 'Delete',
          danger: true,
        }).then((yes) => { if (yes) del(m.id); }),
      });
    }
    if (cfg.canManage) {
      items.push({ separator: true });
      items.push({
        label: m.pinned ? 'Unpin message' : 'Pin message',
        icon: 'pin', checked: !!m.pinned,
        // The caller updates the row when the server has accepted the pin; a
        // refusal is reported rather than left as an unhandled rejection.
        onSelect: () => {
          Promise.resolve(cfg.pin(m.id, !m.pinned)).catch((error) => errorToast(error));
        },
      });
    }
    if (mine && cfg.unreactFrom) {
      items.push({
        label: 'Remove your reaction', icon: 'smile',
        onSelect: () => cfg.unreactFrom(m.id, mine.emoji),
      });
    }
  }
  return items;
};

// -- the row ---------------------------------------------------------------------
//
// The row a timeline draws is the row a pins page needs, so the builder lives at
// module scope and takes its collaborators as lazy references. The engine passes
// its own composer, thread panel and delete plumbing; a read-only caller passes
// stubs and gets a row that only copies.

export function buildMessageRow(deps) {
  return (m, continued) => {
    const cfg = deps.cfg || {};
    const composer = deps.composerRef() || { replyTo() {}, edit() {} };
    const openThread = deps.openThreadRef() || (() => null);
    const del = deps.delRef() || (() => Promise.resolve());
    const rootNames = deps.rootNames || new Map();

    const self = String(m.authorId) === String(State.user && State.user.id);
    const replyAuthor = m.threadRootId ? rootNames.get(m.threadRootId) : null;
    const when = String(m.id).indexOf('pending-') === 0 ? new Date() : stampOf(m);
    const live = !cfg.standalone;

    const touch = (fn) => (event) => {
      event.stopPropagation();
      fn(event);
    };

    const openAt = (x, y) => openContextMenu(x, y, messageMenu(m, self, cfg, composer, openThread, del, live));

    const tools = el('div', { class: 'msg-tools' });
    if (live) {
      const reactBtn = el('button', {
        class: 'toolbtn', type: 'button', 'aria-label': 'React to this message',
        'aria-haspopup': 'menu',
        onClick: touch((event) => openAt(event.clientX, event.clientY)),
      }, icon('smile', { size: 15 }));
      const replyBtn = el('button', {
        class: 'toolbtn', type: 'button', 'aria-label': 'Reply to this message',
        onClick: touch(() => composer.replyTo(m)),
      }, icon('reply', { size: 15 }));
      tools.append(reactBtn, replyBtn);
    }
    const moreBtn = el('button', {
      class: 'toolbtn', type: 'button',
      'aria-label': 'More actions for this message', 'aria-haspopup': 'menu',
      onClick: touch((event) => {
        m.__anchor = moreBtn;
        const items = messageMenu(m, self, cfg, composer, openThread, del, live);
        if (event.clientX || event.clientY) {
          openContextMenu(event.clientX, event.clientY, items);
        } else {
          openMenu({ anchor: m.__anchor || deps.listEl, align: 'left', items });
        }
      }),
    }, icon('more', { size: 15 }));
    tools.append(moreBtn);

    const meta = continued ? null : el('div', { class: 'msg-meta' },
      el('span', { class: 'msg-author' }, m.authorName),
      when ? el('time', {
        class: 'msg-stamp',
        dateTime: when.toISOString(),
        title: when.toLocaleString(),
      }, when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) : null,
      m.pinned ? el('span', { class: 'msg-pinflag', title: 'Pinned in this channel' }, icon('pin', { size: 13 })) : null,
      m.pending ? el('span', { class: 'msg-sending' }, 'sending') : null);

    const content = el('div', { class: 'msg-content' },
      el('p', { class: 'msg-text' + (m.pending ? ' msg-text--pending' : '') },
        inlineContent(m),
        m.pending ? el('span', { class: 'msg-waiting' }, spinner()) : null),
      m.threadRootId ? el('p', { class: 'msg-replying' },
        icon('reply', { size: 13 }),
        el('span', {}, 'replies to ',
          el('span', { class: 'msg-replying-name' }, replyAuthor || 'an earlier message'))) : null,
      m.attachments.length ? el('div', { class: 'msg-attachments' }, m.attachments.map(attachmentNode)) : null,
      m.embeds.length ? embedRow(m.embeds) : null,
      m.reactions.length ? el('div', { class: 'msg-reactions' },
        m.reactions.map((entry) => reactionChip(entry, (emoji, wasMine, share) => {
          void share;
          if (wasMine && cfg.unreactFrom) {
            Promise.resolve(cfg.unreactFrom(m.id, emoji)).catch((e) => errorToast(e));
          } else if (cfg.reactTo) {
            Promise.resolve(cfg.reactTo(m.id, emoji)).catch((e) => errorToast(e));
          }
        }, live))) : null,
      m.replyCount && cfg.threadOf ? el('button', {
        class: 'msg-thread-badge', type: 'button',
        'aria-label': 'Open thread, ' + m.replyCount + (m.replyCount === 1 ? ' reply' : ' replies'),
        onClick: touch(() => openThread(m)),
      },
        icon('message', { size: 13 }),
        el('span', { class: 'msg-thread-badge__count' }, String(m.replyCount)),
        el('span', { class: 'msg-thread-badge-label' }, m.replyCount === 1 ? 'reply' : 'replies')) : null);

    const row = el('article', {
      class: 'msg' + (continued ? ' msg--continued' : '')
        + (self ? ' msg--own' : '') + (m.pending ? ' msg--pending' : '')
        + (live ? '' : ' msg--standalone'),
      'data-id': m.id,
      tabindex: '0',
    },
      el('span', { class: 'msg-rail' },
        avatar({ id: m.authorId, displayName: m.authorName, avatarUrl: m.authorAvatar },
          { size: 'md', rounded: true })),
      el('div', { class: 'msg-main' }, meta, content, tools));

    // A right-click (or a phone long press) opens the same menu, at the pointer.
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openAt(event.clientX, event.clientY);
    });
    return row;
  };
}

// A read-only row: the pins page and other callers that show a message outside
// its conversation. Nothing here acts; the menu only copies.

export function messageRow(m, opts) {
  const o = opts || {};
  const stub = { replyTo() {}, edit() {} };
  const factory = buildMessageRow({
    cfg: Object.assign({ standalone: true, canManage: false }, o.cfg || {}),
    composerRef: () => stub,
    openThreadRef: () => null,
    delRef: () => () => Promise.resolve(),
    rootNames: new Map(),
  });
  return factory(asMessage(m), !!o.continued);
}

// -- the engine -------------------------------------------------------------------

export function conversationSurface(config) {
  const cfg = config || {};
  const items = [];
  const byId = new Map();
  const rootNames = new Map();   // threadRootId -> root author, so replies read

  let hasOlder = true;
  let readingOlder = false;
  let painting = false;

  const listEl = el('div', { class: 'convo', 'aria-label': cfg.composerLabel || 'Conversation' });

  const emptyHint = cfg.emptyHint;
  const scroller = () => (listEl.closest('.convo-scroll')
    || listEl.closest('.stage-body')
    || listEl.parentElement);

  const sortItems = () => {
    items.sort((a, b) => {
      const sa = a.seq === null ? Infinity : a.seq;
      const sb = b.seq === null ? Infinity : b.seq;
      if (sa !== sb) return sa - sb;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
  };

  const rememberRoots = () => {
    for (const m of items) if (m.threadRootId) rootNames.set(m.threadRootId, m.authorName);
  };

  const insert = (m) => {
    const norm = asMessage(m);
    if (!norm || byId.has(norm.id)) return null;
    byId.set(norm.id, norm);
    items.push(norm);
    sortItems();
    return norm;
  };

  const dropPending = (pending) => {
    if (!pending) return;
    byId.delete(pending.id);
    const at = items.indexOf(pending);
    if (at >= 0) items.splice(at, 1);
  };

  const replace = (m) => {
    const norm = asMessage(m);
    if (!norm) return null;
    const had = byId.get(norm.id);
    if (!had) return insert(norm);
    Object.assign(had, norm, { id: had.id, seq: had.seq === null ? norm.seq : had.seq, pending: false });
    sortItems();
    return norm;
  };

  // The collaborators are declared below this row factory; the thunks keep the
  // references alive without a hoisting dance.
  const rowFactory = buildMessageRow({
    cfg,
    listEl,
    rootNames,
    composerRef: () => composer,
    openThreadRef: () => openThread,
    delRef: () => del,
  });

  const repaint = (keepScroll) => {
    painting = true;
    const scrollerEl = scroller();
    const before = keepScroll && scrollerEl
      ? { top: scrollerEl.scrollTop, bottom: scrollerEl.scrollHeight - scrollerEl.scrollTop }
      : null;

    const next = document.createDocumentFragment();
    if (!items.length) {
      next.appendChild(blank({
        glyph: cfg.kind === 'dm' ? 'message' : 'hash',
        title: (emptyHint && emptyHint.title) || 'Nothing has been said yet',
        text: (emptyHint && emptyHint.text) || 'The first message starts this conversation.',
      }));
    }
    let lastKey = '';
    let last = null;
    for (const m of items) {
      const key = dayKeyOf(m);
      if (key !== lastKey) {
        next.appendChild(el('div', { class: 'day-sep', role: 'separator' },
          el('span', {}, readableDay(key))));
        lastKey = key;
        last = null;
      }
      const linked = last
        && last.authorId === m.authorId
        && !m.threadRootId && !last.threadRootId
        && Math.abs(stampOf(m).getTime() - stampOf(last).getTime()) < GROUP_WINDOW_MS;
      next.appendChild(rowFactory(m, linked));
      last = m;
    }
    listEl.replaceChildren(next);

    if (before && scrollerEl) {
      scrollerEl.scrollTop = scrollerEl.scrollHeight - before.bottom;
    } else if (scrollerEl) {
      scrollerEl.scrollTop = scrollerEl.scrollHeight;
    }
    painting = false;
  };

  // -- older pages ---------------------------------------------------------------

  const loadOlder = async () => {
    if (readingOlder || !hasOlder || !cfg.loadOlder || !items.length || items.some((m) => m.pending)) return;
    readingOlder = true;
    const first = items[0];
    const anchor = first.seq !== null ? first.seq : first.id;
    try {
      const page = await cfg.loadOlder(anchor);
      const rowsIn = ((page && page.messages) || []).map(asMessage).filter(Boolean);
      for (const m of rowsIn) insert(m);
      rememberRoots();
      hasOlder = page && page.hasOlder !== undefined
        ? !!page.hasOlder
        : rowsIn.length >= 40;
      repaint(true);
    } catch (e) {
      errorToast(e);
    } finally {
      readingOlder = false;
    }
  };

  const onScroll = () => {
    const scrollerEl = scroller();
    if (!scrollerEl || painting) return;
    const below = scrollerEl.scrollHeight - scrollerEl.scrollTop - scrollerEl.clientHeight;
    if (scrollerEl.scrollTop <= 40 && below > 80) loadOlder();
  };

  const wireScroller = () => {
    const scrollerEl = scroller();
    if (scrollerEl && !scrollerEl.__convoWired) {
      scrollerEl.__convoWired = true;
      scrollerEl.addEventListener('scroll', onScroll, { passive: true });
    }
  };

  // -- the thread panel -------------------------------------------------------------

  const openThread = (m) => {
    if (!cfg.threadOf || !cfg.send) return;
    const repliesHolder = el('div', { class: 'thread-replies' });

    const input = el('textarea', {
      class: 'input composer-input', rows: '2',
      placeholder: 'Reply in thread',
      'aria-label': 'Reply in thread to this message',
    });
    const form = el('form', {
      class: 'composer thread-composer',
      onSubmit: (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        Promise.resolve(cfg.send({ content: text, replyToId: m.id }))
          .then(() => fill())
          .catch((e) => { errorToast(e); input.value = text; });
      },
    },
      input,
      el('button', { class: 'btn btn--primary btn--sm', type: 'submit' }, 'Reply'));

    const body = el('div', { class: 'thread-flow' },
      el('p', { class: 'thread-note' }, 'Replies to this message, together with it.'));
    const dialog = openDialog({
      title: 'Thread',
      sub: (m.content || '').slice(0, 140),
      body,
      wide: true,
    });
    body.append(repliesHolder, form);
    void dialog;
    input.focus();

    const fill = async () => {
      const box = el('p', { class: 'holdline' }, spinner(), 'Reading the thread');
      repliesHolder.replaceChildren(box);
      try {
        const data = await cfg.threadOf(m.id);
        const root = asMessage(data.root || m);
        const replies = (data.messages || data.replies || []).map(asMessage).filter(Boolean);
        if (!replies.length) {
          repliesHolder.replaceChildren(blank({
            glyph: 'message', title: 'No replies yet',
            text: 'Answer it below; the thread keeps it together.',
          }));
          return;
        }
        const next = document.createDocumentFragment();
        let last = null;
        for (const r of [root].concat(replies)) {
          const linked = !!last && last.authorId === r.authorId
            && Math.abs(stampOf(r).getTime() - stampOf(last).getTime()) < GROUP_WINDOW_MS;
          next.appendChild(rowFactory(r, linked && !r.threadRootId));
          last = r;
        }
        repliesHolder.replaceChildren(next);
      } catch (e) {
        repliesHolder.replaceChildren(el('p', { class: 'form-error' },
          (e && e.message) || 'The thread did not load.'));
      }
    };
    fill();
  };

  // -- the composer ------------------------------------------------------------------

  const textarea = el('textarea', {
    class: 'composer-input', rows: '1',
    placeholder: cfg.composerHint || 'Write a message',
    'aria-label': cfg.composerLabel || 'Write a message',
    spellcheck: 'true',
  });
  const errorLine = el('p', { class: 'form-error', role: 'alert', hidden: 'true' });
  const contextBanner = el('div', { class: 'composer-context', hidden: 'true' });
  const fileInput = el('input', {
    type: 'file', class: 'visually-hidden', tabindex: '-1',
    'aria-label': 'Attach a file',
  });
  const sendBtn = el('button', {
    class: 'btn btn--primary btn--sm composer-send', type: 'button', 'aria-label': 'Send message',
  }, icon('send', { size: 15 }), 'Send');
  const emojiBtn = el('button', {
    class: 'iconbtn', type: 'button', 'aria-label': 'Insert an emoji', 'aria-haspopup': 'menu',
  }, icon('smile', { size: 16 }));
  const attachBtn = el('button', {
    class: 'iconbtn', type: 'button', 'aria-label': 'Attach a file',
  }, icon('paperclip', { size: 16 }));

  const form = el('form', {
    class: 'composer',
    onSubmit: (event) => {
      event.preventDefault();
      submit();
    },
  },
    contextBanner,
    el('div', { class: 'composer-row' }, attachBtn, textarea, emojiBtn, sendBtn),
    errorLine,
    fileInput);

  const uploadIds = [];

  const showContext = (parts) => {
    contextBanner.replaceChildren(...(parts || []));
    contextBanner.hidden = !(parts && parts.length);
  };

  let replyTarget = null;
  let editTarget = null;

  const resetContext = () => {
    replyTarget = null;
    editTarget = null;
    showContext(null);
    textarea.placeholder = cfg.composerHint || 'Write a message';
  };

  const composer = {
    node: form,
    replyTo(m) {
      editTarget = null;
      replyTarget = m;
      showContext([
        el('span', { class: 'composer-context-note' }, 'Replying to ',
          el('span', { class: 'composer-context-name' }, m.authorName || 'an earlier message')),
        el('span', { class: 'composer-context-text' }, (m.content || '').slice(0, 80) || '(an attachment)'),
        el('button', {
          class: 'iconbtn', type: 'button', 'aria-label': 'Cancel the reply',
          onClick: () => resetContext(),
        }, icon('x', { size: 14 })),
      ]);
      textarea.focus();
    },
    edit(m) {
      replyTarget = null;
      editTarget = m;
      textarea.value = m.content || '';
      textarea.focus();
      showContext([
        el('span', { class: 'composer-context-note' }, 'Editing your message'),
        el('span', { class: 'composer-context-text' }, (m.content || '').slice(0, 80) || '(an attachment)'),
        el('button', {
          class: 'iconbtn', type: 'button', 'aria-label': 'Stop editing',
          onClick: () => { textarea.value = ''; resetContext(); },
        }, icon('x', { size: 14 })),
      ]);
      textarea.placeholder = 'Edit your message';
    },
    clearError() { errorLine.hidden = true; errorLine.textContent = ''; },
    setError(text) { errorLine.hidden = false; errorLine.textContent = text || 'Something went wrong.'; },
    focus() { textarea.focus(); },
    reset() { textarea.value = ''; resetContext(); },
  };

  const del = async (id) => {
    try {
      await cfg.del(id);
      byId.delete(id);
      const at = items.findIndex((m) => m.id === id);
      if (at >= 0) items.splice(at, 1);
      repaint(true);
    } catch (e) {
      errorToast(e);
    }
  };

  const submit = async () => {
    composer.clearError();
    const text = textarea.value.trim();

    if (editTarget) {
      const m = editTarget;
      const original = m.content;
      if (text === (original || '').trim()) { textarea.value = ''; resetContext(); return; }
      sendBtn.disabled = true;
      textarea.value = '';
      resetContext();
      try {
        const updated = await cfg.edit(m.id, text);
        replace(updated || Object.assign({}, m, { content: text, editedAt: new Date().toISOString() }));
        repaint(true);
      } catch (e) {
        errorToast(e);
        replace(Object.assign({}, m, { content: original }));
        repaint(true);
      } finally {
        sendBtn.disabled = false;
      }
      return;
    }

    if (!text && !uploadIds.length) {
      composer.setError('Write something first, or attach a file.');
      return;
    }
    sendBtn.disabled = true;
    const payload = { content: text };
    if (replyTarget) payload.replyToId = replyTarget.id;
    const ids = uploadIds.splice(0).map((u) => u.id);
    if (ids.length) payload.attachmentIds = ids;

    const pendingRow = insert({
      id: 'pending-' + Math.random().toString(36).slice(2),
      authorId: State.user && State.user.id,
      authorName: nameOf(State.user),
      content: text,
      createdAt: new Date().toISOString(),
      pending: true,
      threadRootId: replyTarget ? replyTarget.id : null,
      attachments: [],
    });
    resetContext();
    repaint(true);
    try {
      const sent = asMessage(await cfg.send(payload));
      dropPending(pendingRow);
      insert(sent);
      rememberRoots();
      repaint(true);
      textarea.focus();
    } catch (e) {
      dropPending(pendingRow);
      const root = payload.replyToId ? byId.get(payload.replyToId) : null;
      composer.reset();
      textarea.value = text;
      if (root) composer.replyTo(root);
      composer.setError((e && (e.message || e.code)) || 'The message did not send.');
      repaint(true);
    } finally {
      sendBtn.disabled = false;
    }
  };

  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
  });
  sendBtn.addEventListener('click', (event) => {
    event.preventDefault();
    submit();
  });
  emojiBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openMenu({
      anchor: emojiBtn,
      align: 'right',
      items: CHAT_EMOJI.map((e) => ({
        label: e,
        onSelect: () => {
          const at = textarea.selectionStart === null ? textarea.value.length : textarea.selectionStart;
          textarea.value = textarea.value.slice(0, at) + e + textarea.value.slice(at);
          const next = at + e.length;
          textarea.setSelectionRange(next, next);
          textarea.focus();
        },
      })),
    });
  });
  const pickFile = () => {
    if (!cfg.upload) {
      composer.setError('Attachments are not open here.');
      return;
    }
    fileInput.value = '';
    fileInput.click();
  };
  attachBtn.addEventListener('click', pickFile);
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    startUpload(file);
  });

  // A file dropped on the composer is a file the composer accepts. The drop
  // only happens over the composer, so a stray drag across the page does not
  // open anything.
  form.addEventListener('dragover', (event) => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
    event.preventDefault();
    form.classList.add('is-dropping');
  });
  form.addEventListener('dragleave', (event) => {
    if (form.contains(event.relatedTarget)) return;
    form.classList.remove('is-dropping');
  });
  form.addEventListener('drop', (event) => {
    if (!event.dataTransfer || !event.dataTransfer.files || !event.dataTransfer.files.length) return;
    event.preventDefault();
    form.classList.remove('is-dropping');
    const file = event.dataTransfer.files[0];
    if (file) startUpload(file);
  });

  // One upload at a time, so two files cannot race for the same context slot.
  // The upload itself reports how far it has got, can be stopped, and can be
  // tried again without the reader losing their draft.
  let uploading = null;

  function startUpload(file) {
    if (!cfg.upload) {
      composer.setError('Attachments are not open here.');
      return;
    }
    if (uploading) {
      composer.setError('Wait for the current upload to finish.');
      return;
    }

    const bar = el('span', { class: 'upload-bar' }, el('span', { class: 'upload-bar-fill' }));
    const label = el('span', { class: 'composer-context-text' }, '0%');
    const cancel = el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button',
      'aria-label': 'Cancel this upload',
      onClick: () => {
        if (uploading && uploading.abort) uploading.abort();
      },
    }, 'Cancel');
    const chip = el('span', { class: 'composer-context-note' },
      spinner(), file.name, ' ', label, bar, ' ', cancel);
    showContext([chip]);

    const started = cfg.upload(file, (fraction) => {
      const pct = Math.max(0, Math.min(100, Math.round((Number(fraction) || 0) * 100)));
      label.textContent = pct + '%';
      const fill = bar.querySelector('.upload-bar-fill');
      if (fill) fill.style.width = pct + '%';
    });

    const handle = started && typeof started === 'object' && started.promise
      ? started
      : { promise: Promise.resolve(started) };
    uploading = handle;

    handle.promise.then((created) => {
      uploading = null;
      const id = typeof created === 'object' && created ? created.id : created;
      uploadIds.push({ id, name: file.name });
      showContext([el('span', { class: 'composer-context-note' }, 'Attached: ' + file.name)]);
      composer.clearError();
    }).catch((e) => {
      uploading = null;
      // A cancelled upload is the reader's own doing, not a failure to report.
      if (e && e.name === 'AbortError') {
        showContext(null);
        return;
      }
      const retry = el('button', {
        class: 'btn btn--ghost btn--sm', type: 'button',
        onClick: () => startUpload(file),
      }, 'Try again');
      showContext([el('span', { class: 'composer-context-note' },
        'Could not attach ' + file.name + '. ', retry)]);
      errorToast(e);
    });
  }

  // -- typing -------------------------------------------------------------------------

  const typing = new Map();
  let typingTimer = null;
  const typingEl = el('p', { class: 'typingline', 'aria-live': 'polite' });
  const drawTyping = () => {
    const names = [...typing.values()];
    typingEl.hidden = names.length === 0;
    if (!names.length) { typingEl.replaceChildren(); return; }
    typingEl.replaceChildren(
      el('span', { class: 'typing-dots', 'aria-hidden': 'true' }, '···'),
      el('span', {}, names.length === 1 ? names[0] + ' is typing'
        : names.length === 2 ? names[0] + ' and ' + names[1] + ' are typing'
          : names.length + ' people are typing'));
  };

  // -- the public surface ----------------------------------------------------------------

  return {
    node: listEl,
    typing: typingEl,
    composer,
    wireScroller,
    api: {
      paint(rowsIn, opts) {
        items.length = 0;
        byId.clear();
        for (const raw of rowsIn || []) insert(raw);
        rememberRoots();
        hasOlder = opts && opts.hasOlder !== undefined
          ? !!opts.hasOlder
          : (rowsIn || []).length >= 40;
        repaint(false);
        wireScroller();
      },
      created(raw) {
        const m = insert(raw);
        if (!m) return;
        rememberRoots();
        const scrollerEl = scroller();
        const pinnedDown = scrollerEl
          ? (scrollerEl.scrollHeight - scrollerEl.scrollTop - scrollerEl.clientHeight) < 160
          : true;
        repaint(pinnedDown);
        if (cfg.onChanged) cfg.onChanged('created', m);
      },
      updated(raw) {
        replace(raw);
        repaint(true);
        if (cfg.onChanged) cfg.onChanged('updated', raw);
      },
      deleted(id) {
        byId.delete(id);
        const at = items.findIndex((m) => m.id === id);
        if (at >= 0) items.splice(at, 1);
        repaint(true);
        if (cfg.onChanged) cfg.onChanged('deleted', id);
      },
      reaction(id, summary) {
        const m = byId.get(id);
        if (!m) return;
        m.reactions = Array.isArray(summary) ? summary : [];
        repaint(true);
        if (cfg.onChanged) cfg.onChanged('reaction', id);
      },
      embeds(id, cards) {
        const m = byId.get(id);
        if (!m) return;
        m.embeds = Array.isArray(cards) ? cards : [];
        repaint(true);
      },
      pinned(id, pinned) {
        const m = byId.get(id);
        if (!m) return;
        m.pinned = pinned === undefined ? !m.pinned : !!pinned;
        repaint(true);
      },
      older(page, opts) {
        for (const raw of ((page && page.messages) || (Array.isArray(page) ? page : []))) insert(raw);
        rememberRoots();
        repaint(true);
        if (opts) hasOlder = !!opts.hasOlder;
      },
      typing(name) {
        if (!name) return;
        typing.set(name, name);
        drawTyping();
        if (typingTimer) clearTimeout(typingTimer);
        typingTimer = setTimeout(() => {
          typing.clear();
          drawTyping();
        }, 4200);
      },
      focus: () => textarea.focus(),
    },
    cleanup() {
      if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
      typing.clear();
      drawTyping();
      const scrollerEl = scroller();
      if (scrollerEl) scrollerEl.removeEventListener('scroll', onScroll);
      listEl.replaceChildren();
      items.length = 0;
      byId.clear();
    },
  };
}
