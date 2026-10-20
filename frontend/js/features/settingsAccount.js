// Settings: the reader's own profile.
// The name, the photo, the few words that travel with them everywhere.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { State } from '../../packages/store.js';
import { avatar, bannerNode } from '../ui/primitives.js';
import { forgetMedia } from '../../packages/media.js';
import { head, card, fault, fold } from '../ui/page.js';
import { errorToast, toast } from '../ui/overlays.js';

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
  let avatarFile = null;
  let bannerFile = null;

  const avatarPick = el('input', {
    type: 'file', class: 'visually-hidden', tabindex: '-1',
    'aria-label': 'Choose a new avatar image',
  });
  const bannerPick = el('input', {
    type: 'file', class: 'visually-hidden', tabindex: '-1',
    'aria-label': 'Choose a new banner image',
  });
  avatarPick.addEventListener('change', () => { avatarFile = avatarPick.files[0] || null; });
  bannerPick.addEventListener('change', () => { bannerFile = bannerPick.files[0] || null; });

  identity.replaceChildren(
    card({
      label: 'Picture', glyph: 'image',
      body: fold([
        el('div', { class: 'settings-profile-top' },
          avatar(user, { size: 'lg', rounded: true }),
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
              onClick: async () => {
                try {
                  await Api.removeProfileImage('banner');
                  // The banner keeps its path, so the picture that was
                  // fetched for it is still in the cache - and the banner
                  // would come straight back.
                  forgetMedia(user.bannerUrl);
                  toast('Banner removed');
                  reload();
                } catch (e) { errorToast(e); }
              },
            }, 'Remove banner') : null,
            user.avatarUrl ? el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'Remove the avatar',
              onClick: async () => {
                try {
                  await Api.removeProfileImage('avatar');
                  forgetMedia(user.avatarUrl);
                  toast('Avatar removed');
                  reload();
                } catch (e) { errorToast(e); }
              },
            }, 'Remove avatar') : null)),
        user.bannerUrl ? bannerNode(user.bannerUrl, 'settings-banner') : null,
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
              // A new picture replaces the old one at the same path, so the
              // bytes that were fetched for that path have to be forgotten -
              // otherwise the old picture is still the one on screen.
              if (avatarFile) {
                await Api.uploadProfileImage('avatar', avatarFile);
                forgetMedia(user.avatarUrl);
              }
              if (bannerFile) {
                await Api.uploadProfileImage('banner', bannerFile);
                forgetMedia(user.bannerUrl);
              }
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
      const me = await Api.me();
      State.user = Object.assign({}, State.user || {}, me || {});
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
