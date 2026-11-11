// The files, on a desk.
//
// A community's own store: files the workspace keeps, rather than files a
// message carries. A file is uploaded from here, listed here, downloaded from
// here, and removed by the person who uploaded it or by a moderator. The
// server decides all of that; the desk only offers what the server would
// grant, and shows a refusal as what it is.
//
// The list follows the community live: a file somebody else uploaded arrives
// through the server room, the way a channel does.

import { el, replaceChildren } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { card, row, blank, fault, fold, hold, facts } from '../../ui/page.js';
import { iconButton } from '../../ui/primitives.js';
import { confirmDialog, errorToast, toast } from '../../ui/overlays.js';
import { relativeTime, fileSize } from '../../../packages/format.js';
import { path, navigate } from '../../../packages/nav.js';
import { State, on as onStore } from '../../../packages/store.js';
import { on as onRealtime } from '../../../packages/realtime.js';
import Api from '../../../packages/api.js';
import {
  Workspace, mayPost, mayActOn, paramId,
  filesRoute,
} from '../../../packages/workspace.js';

// One file row: its name, how large it is, when it came, and what may be
// done to it. The name opens the file's own page; the tools download it and
// - for those the server would allow - remove it.
function fileRow(serverId, file, canRemove, reload) {
  const rowEl = row({
    lead: el('span', { class: 'role-dot' }, icon('folder', { size: 15 })),
    title: file.name,
    sub: fileSize(file.size) + ' · ' + relativeTime(file.createdAt),
    href: path(filesRoute(serverId, file.id)),
  });

  const tools = el('span', { class: 'rowtools' });
  tools.appendChild(el('a', {
    class: 'icon-btn', href: file.url, target: '_blank', rel: 'noreferrer',
    'aria-label': 'Download ' + file.name, title: 'Download',
  }, icon('download', { size: 15 })));
  if (canRemove) {
    tools.appendChild(iconButton('trash', {
      label: 'Remove ' + file.name,
      onClick: async () => {
        const yes = await confirmDialog({
          title: 'Remove this file?',
          body: file.name + ' goes away for everybody in the community, not just from this list.',
          confirmLabel: 'Remove',
          danger: true,
        });
        if (!yes) return;
        try {
          await Workspace.deleteFile(serverId, file.id);
          toast('File removed');
          reload();
        } catch (e) { errorToast(e); }
      },
    }));
  }
  rowEl.appendChild(tools);
  return rowEl;
}

// -- the list ------------------------------------------------------------------

export function filesList(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'rowlist' });
  const canPost = mayPost(serverId);

  // The picker is opened by the button and by a drop on the card. A file
  // dropped here is stored, not attached to a draft: this is a store.
  const fileInput = el('input', {
    type: 'file', class: 'visually-hidden', tabindex: '-1',
    'aria-label': 'Upload a file',
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (file) send(file);
  });

  const node = card({
    label: 'Files',
    glyph: 'folder',
    note: 'storage the community keeps',
    actions: canPost
      ? el('span', { class: 'rowtools' },
        fileInput,
        el('button', {
          class: 'btn btn--default btn--sm', type: 'button',
          onClick: () => fileInput.click(),
        }, icon('upload', { size: 14 }), 'Upload a file'))
      : null,
    body: host,
    flush: true,
  });

  const load = async () => {
    replaceChildren(host, hold('Reading the files'));
    try {
      const rows = await Workspace.files(serverId);
      replaceChildren(host, ...(rows.length
        ? rows.map((file) => fileRow(serverId, file, mayActOn(serverId, file.uploadedBy, State.user && State.user.id), load))
        : [blank({
          glyph: 'folder',
          title: 'No files yet',
          text: canPost
            ? 'Upload one from here, or drop one on this list.'
            : 'The community keeps its files here once somebody uploads them.',
        })]));
    } catch (e) {
      replaceChildren(host, fault(e, load));
    }
  };

  const send = async (file) => {
    try {
      await Api.uploadWorkspaceFile(serverId, file, () => {});
      toast('Uploaded ' + file.name);
      load();
    } catch (e) { errorToast(e); }
  };

  // A drag across the list is a drop the list answers. The upload posts
  // itself; the reload that follows draws it.
  node.addEventListener('dragover', (event) => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('Files')) return;
    event.preventDefault();
    node.classList.add('is-dropping');
  });
  node.addEventListener('dragleave', (event) => {
    if (node.contains(event.relatedTarget)) return;
    node.classList.remove('is-dropping');
  });
  node.addEventListener('drop', (event) => {
    if (!event.dataTransfer || !event.dataTransfer.files || !event.dataTransfer.files.length) return;
    event.preventDefault();
    node.classList.remove('is-dropping');
    for (const file of event.dataTransfer.files) if (file) send(file);
  });

  // Somebody else's upload lands here the same way a new channel does: an
  // event in the community's room, and the list reads itself again.
  const offCreated = onRealtime('workspace_file_created', () => load());
  const offDeleted = onRealtime('workspace_file_deleted', () => load());
  const offDropping = onStore('resync', () => load());

  return {
    node,
    onMount: load,
    cleanup() {
      offCreated();
      offDeleted();
      offDropping();
    },
  };
}

// -- the open file -------------------------------------------------------------

export function filesDetail(ctx) {
  const serverId = ctx.serverId;
  const fileId = paramId(ctx.params, 'file');

  if (!fileId) {
    return {
      node: blank({
        glyph: 'folder',
        title: 'No file open',
        text: 'Choose a file on the left to see it.',
      }),
      onMount: async () => {},
      cleanup() {},
    };
  }

  const me = State.user && State.user.id;

  const node = fold([hold('Reading the file')]);

  const paint = (file) => {
    const canRemove = mayActOn(serverId, file.uploadedBy, me);
    node.replaceChildren(
      facts([
        { value: file.name, label: 'Name' },
        { value: fileSize(file.size), label: 'Size' },
        { value: file.mime, label: 'Type' },
        { value: relativeTime(file.createdAt), label: 'Uploaded' },
        { value: file.uploadedBy === me ? 'you' : file.uploadedBy, label: 'By' },
      ]),
      el('div', { class: 'rowtools' },
        el('a', {
          class: 'btn btn--default btn--sm', href: file.url, target: '_blank', rel: 'noreferrer',
        }, icon('download', { size: 14 }), 'Download'),
        canRemove
          ? el('button', {
            class: 'btn btn--danger btn--sm', type: 'button',
            onClick: async () => {
              const yes = await confirmDialog({
                title: 'Remove this file?',
                body: file.name + ' goes away for everybody in the community.',
                confirmLabel: 'Remove',
                danger: true,
              });
              if (!yes) return;
              try {
                await Workspace.deleteFile(serverId, file.id);
                toast('File removed');
                navigate(filesRoute(serverId));
              } catch (e) { errorToast(e); }
            },
          }, icon('trash', { size: 14 }), 'Remove')
          : null),
    );
  };

  return {
    node,
    onMount: async () => {
      try {
        const file = await Workspace.file(serverId, fileId);
        if (!file) {
          node.replaceChildren(blank({
            glyph: 'folder',
            title: 'No such file',
            text: 'The link points at a file that is not here. The list on the left has what is.',
          }));
          return;
        }
        paint(file);
      } catch (e) {
        node.replaceChildren(fold([fault(e, null)]));
      }
    },
    cleanup() {},
  };
}
