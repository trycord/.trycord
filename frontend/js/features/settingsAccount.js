// Settings: the reader's own profile.
// The name, the photo, the few words that travel with them everywhere.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import Api from '../../packages/api.js';
import { State } from '../../packages/store.js';
import { avatar, bannerNode } from '../ui/primitives.js';
import { head, card, fault, fold } from '../ui/page.js';
import { errorToast, toast } from '../ui/overlays.js';

function paint(identity, user) {
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
                  toast('Banner removed');
                  reload();
                } catch (e) { errorToast(e); }
              },
            }, 'Remove banner') : null)),
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
              if (avatarFile) await Api.uploadProfileImage('avatar', avatarFile);
              if (bannerFile) await Api.uploadProfileImage('banner', bannerFile);
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
      paint(identity, State.user || {});
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
