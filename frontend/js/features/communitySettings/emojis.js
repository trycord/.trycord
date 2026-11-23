// The emojis a community gives a name to.
//
// The section is two facts and one question. The facts: what pictures this
// community has named, and who named them. The question, put to a manager
// only: what picture should carry the next name.
//
// A name once given is a promise to the words already written with it —
// `:sparkle:` in a message from last month means the picture it meant then.
// So there is no editing: a name is taken away and given again, and a second
// upload under a taken name is refused by the server rather than quietly
// replacing the face.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { confirmDialog } from '../../ui/overlays.js';
import { head, card, row, blank, fault, fold, hold } from '../../ui/page.js';
import { State, refreshServerEmojis, can } from '../../../packages/store.js';
import { reporter } from './parts.js';

const ACCEPTED = 'image/png,image/jpeg,image/webp,image/gif';

function thumb(emoji) {
  return el('img', {
    class: 'settings-emoji-thumb', src: emoji.url, alt: ':' + emoji.name + ':',
    title: ':' + emoji.name + ':', draggable: 'false', loading: 'lazy',
  });
}

function whenOf(iso) {
  try {
    const at = new Date(iso);
    return isNaN(at.getTime()) ? '' : at.toLocaleDateString();
  } catch { return ''; }
}

export function emojisSection(ctx) {
  const serverId = ctx.serverId;
  const manager = can(serverId, 'MANAGE_SERVER');
  const host = el('div', { class: 'fold' });
  const status = reporter();

  // -- the upload form --------------------------------------------------------
  //
  // The name is typed first, because it is the promise; the picture is picked
  // second. Both travel together in one multipart body, and the server's
  // answer is the emoji as it now stands.
  let picked = null;
  const nameInput = el('input', {
    class: 'input', type: 'text', maxlength: '30', placeholder: 'sparkle',
    'aria-label': 'The name of the emoji, as it will be typed between colons',
  });
  const fileInput = el('input', {
    class: 'input input--file', type: 'file', accept: ACCEPTED,
    'aria-label': 'The picture for the emoji',
  });
  fileInput.addEventListener('change', () => {
    picked = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
  });

  const uploadBtn = el('button', { class: 'btn btn--default btn--sm', type: 'button' },
    icon('image', { size: 14 }), 'Name it');
  uploadBtn.addEventListener('click', async () => {
    const name = String(nameInput.value || '').trim();
    if (!name) { status.fail({ message: 'The emoji needs a name first.' }); return; }
    if (!picked) { status.fail({ message: 'Choose a picture for the name.' }); return; }
    uploadBtn.disabled = true;
    try {
      const created = await Api.createEmoji(serverId, picked, name);
      status.answered(':' + created.name + ': now belongs to this community.');
      nameInput.value = '';
      fileInput.value = '';
      picked = null;
      await refreshServerEmojis(serverId, { force: true });
      paint();
    } catch (error) {
      status.fail(error);
    } finally {
      uploadBtn.disabled = false;
    }
  });

  const formCard = card({
    label: 'Give a picture a name', glyph: 'image',
    body: fold([
      el('p', { class: 'form-note' },
        'Members type the name between colons — :sparkle: — in a message, '
        + 'or hang it on a message as a feeling. A name is 2 to 30 lowercase letters, digits or underscores; '
        + 'the picture is at most 256 KB and a PNG, JPEG, WebP or GIF.'),
      el('div', { class: 'emoji-upload' }, nameInput, fileInput, uploadBtn),
      status.node,
    ]),
  });

  // -- the list ---------------------------------------------------------------
  const listBody = el('div', { class: 'rowlist' });

  const removeOf = (emoji) => async () => {
    const yes = await confirmDialog({
      title: 'Take :' + emoji.name + ': away?',
      body: 'The name goes with the picture. Old messages keep the words '
        + ':' + emoji.name + ':, and they read as text from then on.',
      confirmLabel: 'Take it away',
      danger: true,
    });
    if (!yes) return;
    try {
      await Api.deleteEmoji(serverId, emoji.id);
      status.answered(':' + emoji.name + ': was taken away.');
      await refreshServerEmojis(serverId, { force: true });
      paint();
    } catch (error) {
      status.fail(error);
    }
  };

  const paint = () => {
    const list = State.serverEmojis.get(serverId) || [];
    if (!list.length) {
      listBody.replaceChildren(blank({
        glyph: 'image',
        title: 'No emojis yet',
        text: manager
          ? 'Name the first picture above; the community can use it as soon as it lands.'
          : 'A manager of this community can name the first picture.',
      }));
    } else {
      listBody.replaceChildren(...list.map((emoji) => row({
        lead: thumb(emoji),
        title: ':' + emoji.name + ':',
        sub: whenOf(emoji.createdAt) ? 'Named ' + whenOf(emoji.createdAt) : '',
        side: manager ? el('button', {
          class: 'btn btn--danger btn--sm', type: 'button',
          'aria-label': 'Take :' + emoji.name + ': away',
          onClick: removeOf(emoji),
        }, icon('trash', { size: 14 }), 'Remove') : null,
      })));
    }

    const cards = [card({
      label: 'The emojis of this community', glyph: 'smile',
      body: listBody, flush: true,
    })];
    if (manager) cards.unshift(formCard);
    const note = manager ? null : el('p', { class: 'form-note' },
      'Naming and taking away is a manager\'s question. The list is every member\'s to read.');
    host.replaceChildren(fold([...cards, note]));
  };

  const load = async () => {
    host.replaceChildren(hold('Reading the emojis'));
    try {
      await refreshServerEmojis(serverId, { force: true });
    } catch (error) {
      host.replaceChildren(fold([fault(error, load)]));
      return;
    }
    paint();
  };

  return {
    node: fold([
      head({
        kicker: 'Community',
        title: 'Emojis',
        lede: 'The pictures this community has given a name to, and the names they answer to.',
        actions: null,
      }),
      host,
    ]),
    onMount: load,
  };
}

export default { emojisSection };
