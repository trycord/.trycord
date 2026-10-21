// Settings: the reader's own profile.
// The name, the photo, the few words that travel with them everywhere.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { State, loadSession } from '../../packages/store.js';
import {
  checkImage, previewOf, uploadProfilePicture, removeProfilePicture,
} from '../../packages/profileMedia.js';
import { avatar, bannerNode } from '../ui/primitives.js';
import { head, card, fault, fold } from '../ui/page.js';
import { errorToast, toast, openDialog } from '../ui/overlays.js';
import { createCropper } from '../../packages/imageCropper.js';

// The identity panel.
//
// `reload` is handed in: removing the avatar or the banner changes the
// profile, and the panel has to show the profile as it now is. It used to
// call a `reload` that was not in its scope - a function of the view below -
// so removing your picture threw a ReferenceError after the picture was
// already gone, and the reader was shown an error instead of their profile.
function paint(identity, user, reload) {
  const name = el('input', {
    class: 'input', type: 'text', value: user.displayName || user.username || '',
    'aria-label': 'Display name',
  });
  const status = el('input', {
    class: 'input', type: 'text', value: user.statusText || '',
    'aria-label': 'Your status',
    placeholder: 'What you are up to',
  });
  const about = el('textarea', {
    class: 'input', rows: '3',
    'aria-label': 'About you',
    placeholder: 'A few words for the people who open your profile',
  });
  // The words the reader already wrote are shown, so saving the page does not
  // quietly replace them with an empty box.
  about.value = user.bio || '';

  // The pictures are uploaded the moment they are chosen.
  //
  // They used to be held until the profile was saved, so a reader who chose
  // a picture and looked away saw nothing happen at all - the picture was
  // chosen, it was on the disk, and the profile still showed the old one.
  // A picture is not a draft: it is replaced when it is chosen, and the
  // words beside it are the part that waits to be saved.
  const avatarPick = el('input', {
    type: 'file', class: 'visually-hidden', tabindex: '-1', accept: 'image/*',
    'aria-label': 'Choose a new avatar image',
  });
  const bannerPick = el('input', {
    type: 'file', class: 'visually-hidden', tabindex: '-1', accept: 'image/*',
    'aria-label': 'Choose a new banner image',
  });

  // The picture as it is now, and the one that was chosen but is not up yet.
  // The preview is the file the browser has, so it is the very picture that
  // will be uploaded - not a guess at it.
  const face = el('span', { class: 'settings-profile-face' });
  const cover = el('div', { class: 'settings-profile-cover' });
  const pictureNote = el('p', { class: 'settings-note', role: 'status' });
  let preview = null;

  const drawFace = (user) => {
    face.replaceChildren(avatar(user, { size: 'lg', rounded: true }));
  };
  const drawCover = (user) => {
    if (user.bannerUrl) {
      cover.replaceChildren(bannerNode(user.bannerUrl, 'settings-banner'));
      cover.classList.remove('is-empty');
    } else {
      cover.replaceChildren();
      cover.classList.add('is-empty');
    }
  };

  // The part of the picture to use.
  //
  // The reader chooses: the picture is shown, a frame is dragged over the
  // part of it they want, and that part is what is uploaded. A frame over
  // the middle of a photograph is rarely the face in it.
  const choosePart = (file, kind) => new Promise((resolve) => {
    const shape = kind === 'avatar' ? 'square' : 'wide';
    createCropper(file, { shape, size: kind === 'avatar' ? 512 : 1024 }).then((cropper) => {
      if (!cropper) {
        // A browser that cannot draw the picture cannot crop it either, so
        // the picture goes up as it is.
        resolve(file);
        return;
      }
      const dialog = openDialog({
        title: kind === 'avatar' ? 'Choose your picture' : 'Choose your cover',
        sub: 'Drag the frame over the part of the picture to use.',
        body: cropper.node,
        foot: [
          el('button', {
            class: 'btn btn--default btn--sm', type: 'button',
            onClick: () => { cropper.destroy(); dialog.close(); resolve(null); },
          }, 'Cancel'),
          el('button', {
            class: 'btn btn--primary btn--sm', type: 'button',
            onClick: async () => {
              const cropped = await cropper.result();
              cropper.destroy();
              dialog.close();
              resolve(cropped || file);
            },
          }, 'Use this picture'),
        ],
        onClose: () => { cropper.destroy(); resolve(null); },
      });
    }).catch(() => resolve(file));
  });

  const uploadPicture = async (kind, input) => {
    const file = input.files && input.files[0];
    if (!file) return;
    const checked = checkImage(file);
    if (!checked.ok) {
      // Said where the reader is looking, and nothing is uploaded: the old
      // picture stays exactly where it was.
      pictureNote.textContent = checked.reason;
      input.value = '';
      return;
    }
    // The part of the picture to use is chosen first.
    const chosen = await choosePart(file, kind);
    if (!chosen) {
      pictureNote.textContent = '';
      input.value = '';
      return;
    }
    // The chosen part is shown while it is on its way up, so the reader sees
    // what they picked before the server has answered.
    const shown = previewOf(chosen);
    if (kind === 'avatar') {
      preview = shown;
      face.replaceChildren(el('img', { class: 'avatar-img', src: shown.url, alt: '' }));
    } else {
      preview = shown;
      cover.replaceChildren(el('img', { class: 'settings-banner', src: shown.url, alt: '' }));
      cover.classList.remove('is-empty');
    }
    pictureNote.textContent = 'Uploading the picture…';
    try {
      const updated = await uploadProfilePicture(kind, chosen);
      pictureNote.textContent = kind === 'banner'
        ? 'The cover image is up.'
        : 'The picture is up.';
      toast(kind === 'banner' ? 'The cover image was uploaded.' : 'The picture was uploaded.');
      if (updated && updated.id) {
        // The profile is now the one the server holds, so every surface
        // shows the new picture and not the old one.
        State.user = Object.assign({}, State.user || {}, updated);
      }
      await reload();
    } catch (e) {
      pictureNote.textContent = (e && e.message) || 'The picture was not uploaded.';
      errorToast(e);
      // The picture that failed to upload is put back the way it was, so a
      // failure never leaves a broken face on the screen.
      if (preview === chosen) {
        preview.release();
        preview = null;
        drawFace(user);
        drawCover(user);
      }
    } finally {
      // The same file can be chosen again after a change.
      input.value = '';
    }
  };
  avatarPick.addEventListener('change', () => { uploadPicture('avatar', avatarPick); });
  bannerPick.addEventListener('change', () => { uploadPicture('banner', bannerPick); });

  const removePicture = async (kind) => {
    try {
      const updated = await removeProfilePicture(kind);
      pictureNote.textContent = kind === 'banner'
        ? 'The cover image was taken away.'
        : 'The picture was taken away.';
      toast(kind === 'banner' ? 'The cover image was removed.' : 'The picture was removed.');
      if (updated && updated.id) {
        State.user = Object.assign({}, State.user || {}, updated);
      }
      await reload();
    } catch (e) {
      errorToast(e);
    }
  };

  drawFace(user);
  drawCover(user);

  identity.replaceChildren(
    card({
      label: 'Picture', glyph: 'image',
      body: fold([
        el('div', { class: 'settings-profile-top' },
          face,
          el('div', { class: 'fold fold--tight' },
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'Upload a new avatar',
              onClick: () => avatarPick.click(),
            }, icon('upload', { size: 14 }), 'Avatar'),
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'Upload a new banner',
              onClick: () => bannerPick.click(),
            }, icon('upload', { size: 14 }), 'Banner'),
            user.bannerUrl ? el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'Remove the banner',
              onClick: () => removePicture('banner'),
            }, 'Remove banner') : null,
            user.avatarUrl ? el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'Remove the avatar',
              onClick: () => removePicture('avatar'),
            }, 'Remove avatar') : null)),
        cover,
        pictureNote,
        avatarPick, bannerPick,
      ]),
    }),
    card({
      label: 'Words', glyph: 'edit',
      body: fold([
        name, status, about,
        el('button', {
          class: 'btn btn--primary btn--sm', type: 'button',
          onClick: async () => {
            try {
              await Api.updateMe({
                displayName: name.value.trim(),
                statusText: status.value.trim(),
                bio: about.value,
              });
              toast('Saved');
              reload();
            } catch (e) { errorToast(e); }
          },
        }, 'Save profile'),
      ]),
    }));
}

export function profileView() {
  const identity = el('div', { class: 'anticipation-line' });

  const reload = async () => {
    try {
      // The session is read through the store, so the account everywhere else
      // - the button in the corner, the list of conversations - sees the new
      // picture at once and not on the next page.
      await loadSession();
      paint(identity, State.user || {}, reload);
    } catch (e) {
      identity.replaceChildren(fold([fault(e, null)]));
    }
  };

  const host = el('div', { class: 'fold fold--tight' },
    head({
      kicker: 'You',
      title: 'Profile',
      lede: 'The name, the photo, the few words.',
    }),
    identity);

  return {
    node: host,
    onMount: reload,
    cleanup() {},
  };
}
