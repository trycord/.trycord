// The account studio on the phone.
//
// The desk keeps nine addresses behind one rail; the phone answers each
// address with its own screen, through the same API. Nothing here is a stub:
// the sessions really end, the password really changes, the quiet hours
// really hold, and the data really exports.

import {
  el, clear, icon, Api, confirm, toast, failed, hold, failure, emptyState,
  items, when, statusWord, row, cardOf, fact, wordsSheet, formSheet, consoleScreen,
  describeValue,
} from './kit.js';
import { navigate, path } from '../../../packages/nav.js';
import { nameOf, refreshMutes, State } from '../../../packages/store.js';
import { request } from '../../../packages/api.js';
import { readPrefs, patchPrefs } from '../prefs.js';

// -- the index ----------------------------------------------------------------

async function index(host) {
  const me = State.user || {};
  host.appendChild(cardOf('Signed in as', [row({
    title: nameOf(me) || me.username || 'You',
    sub: me.email ? me.email : '@' + (me.username || ''),
    chevron: true,
    onClick: () => navigate(path('/users/' + (me.id || 'me'))),
  })]));
  host.appendChild(cardOf('The sections', SECTIONS_LIST.map(([pageId, label, iconName]) => row({
    lead: el('span', { class: 'm-row__chevron' }, icon(iconName, { size: 16 })),
    title: label,
    chevron: true,
    onClick: () => navigate(path('/' + ROUTES[pageId])),
  }))));
}

const SECTIONS_LIST = [
  ['settings.security', 'Security', 'shield'],
  ['settings.privacy', 'Privacy', 'lock'],
  ['settings.notifications', 'Notifications', 'bell'],
  ['settings.encryption', 'Encryption', 'key'],
  ['settings.appearance', 'Appearance', 'palette'],
  ['settings.language', 'Language', 'globe'],
  ['settings.backend', 'The connection', 'server'],
  ['settings.updates', 'The build', 'package'],
];

const ROUTES = {
  'settings': 'settings',
  'settings.security': 'settings/security',
  'settings.privacy': 'settings/privacy',
  'settings.notifications': 'settings/notifications',
  'settings.encryption': 'settings/encryption',
  'settings.appearance': 'settings/appearance',
  'settings.language': 'settings/language',
  'settings.backend': 'settings/backend',
  'settings.updates': 'settings/updates',
};

// -- security -----------------------------------------------------------------

async function security(host) {
  const sessionsCard = cardOf('Sessions', []);
  const factorsCard = cardOf('Two-step sign-in', []);
  const passwordCard = cardOf('The password', []);
  const deleteCard = cardOf('Leaving', []);
  host.append(sessionsCard, factorsCard, passwordCard, deleteCard);

  const paintSessions = async () => {
    sessionsCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Sessions'), hold());
    try {
      const rows = items(await Api.sessions());
      sessionsCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Sessions'),
        ...(rows.length ? rows.map((session) => row({
          title: session.label || session.userAgent || 'A device',
          sub: (session.current ? 'This device · ' : '') + (session.createdAt ? 'since ' + when(session.createdAt) : ''),
          side: el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'End this session',
            onClick: async () => {
              try {
                await Api.revokeSession(session.jti);
                toast('The session is ended');
                await paintSessions();
              } catch (error) { failed(error); }
            },
          }, 'End'),
        })) : [emptyState('shield', 'No other sessions', 'The devices reading this account appear here.')]));
    } catch (error) {
      sessionsCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Sessions'), failure(error, paintSessions));
    }
  };

  const paintFactors = async () => {
    factorsCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Two-step sign-in'), hold());
    try {
      const status = await Api.twoFactorStatus();
      const enabled = !!(status && (status.enabled || status.twoFactorEnabled));
      factorsCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Two-step sign-in'),
        fact('State', enabled ? 'On — a code is asked at sign-in' : 'Off'));
      if (!enabled) {
        factorsCard.appendChild(row({
          title: 'Turn it on', lead: el('span', { class: 'm-row__chevron' }, icon('shield', { size: 16 })), chevron: true,
          onClick: () => enableFactors(factorsCard, paintFactors),
        }));
      } else {
        factorsCard.appendChild(row({
          title: 'Read the recovery codes', lead: el('span', { class: 'm-row__chevron' }, icon('key', { size: 16 })), chevron: true,
          onClick: async () => {
            const answer = await new Promise((done) => wordsSheet({
              title: 'The password, to read the codes', fieldLabel: 'Password', confirmLabel: 'Show the codes',
              placeholder: 'Your password', required: false,
            }, done));
            try {
              const out = await Api.twoFactorRecoveryCodes({ password: answer });
              const codes = items(out.codes ? { items: out.codes } : out);
              host.appendChild(cardOf('Recovery codes', codes.length
                ? codes.map((code) => row({ title: typeof code === 'string' ? code : (code.code || 'A code'), sub: 'Each code signs in once.' }))
                : [emptyState('key', 'No codes', 'The instance did not return any codes.')]));
            } catch (error) { failed(error); }
          },
        }));
        factorsCard.appendChild(row({
          title: 'Turn it off', danger: true, lead: el('span', { class: 'm-row__chevron' }, icon('x', { size: 16 })), chevron: true,
          onClick: async () => {
            const answer = await new Promise((done) => wordsSheet({
              title: 'Turn two-step off?', fieldLabel: 'Password and code', confirmLabel: 'Turn it off', danger: true,
              placeholder: 'password + 6-digit code', required: false,
            }, done));
            const parts = String(answer || '').trim().split(/\s+/);
            try {
              await Api.twoFactorDisable({ password: parts[0] || '', code: parts[1] || '' });
              toast('Two-step sign-in is off');
              await paintFactors();
            } catch (error) { failed(error); }
          },
        }));
      }
    } catch (error) {
      factorsCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Two-step sign-in'), failure(error, paintFactors));
    }
  };

  const enableFactors = (card, repaint) => {
    card.appendChild(row({
      title: 'Begin the setup', lead: el('span', { class: 'm-row__chevron' }, icon('plus', { size: 16 })), chevron: true,
      onClick: async () => {
        const password = await new Promise((done) => wordsSheet({
          title: 'The password, to begin', fieldLabel: 'Password', confirmLabel: 'Begin',
          placeholder: 'Your password', required: false,
        }, done));
        if (!password) return;
        try {
          const setup = await Api.twoFactorSetup({ password });
          const secret = (setup && (setup.secret || setup.otpauth_url || setup.uri)) || '';
          const code = await new Promise((done) => wordsSheet({
            title: 'The code your app shows',
            note: secret ? 'Add this secret to your authenticator app: ' + String(secret).slice(0, 60) : null,
            fieldLabel: 'The 6-digit code', confirmLabel: 'Turn it on', placeholder: '123456', required: false,
          }, done));
          if (!code) return;
          await Api.twoFactorEnable({ password, code: code.trim() });
          toast('Two-step sign-in is on');
          repaint();
        } catch (error) { failed(error); }
      },
    }));
  };

  const changePassword = () => formSheet({ title: 'A new password', confirmLabel: 'Change the password' }, [
    ['The current password', el('input', { class: 'm-input', type: 'password', autocomplete: 'current-password', 'aria-label': 'The current password' })],
    ['The new password', el('input', { class: 'm-input', type: 'password', autocomplete: 'new-password', 'aria-label': 'The new password' })],
  ], async () => {
    const box = document.querySelectorAll('.m-sheet .m-input');
    await Api.changePassword({ currentPassword: box[0].value, newPassword: box[1].value });
    toast('The password is changed');
  });

  passwordCard.appendChild(row({
    title: 'Change the password', lead: el('span', { class: 'm-row__chevron' }, icon('key', { size: 16 })), chevron: true,
    onClick: changePassword,
  }));

  deleteCard.appendChild(row({
    title: 'Ask for the account to be erased', danger: true,
    lead: el('span', { class: 'm-row__chevron' }, icon('trash', { size: 16 })), chevron: true,
    onClick: async () => {
      if (!(await confirm({
        title: 'Ask to be erased?',
        text: 'The operators of this instance are asked to remove the account and its data. It can be cancelled until it is carried out.',
        confirmLabel: 'Ask', danger: true,
      }))) return;
      try {
        await Api.requestDeletion({ confirm: true });
        toast('The request is filed');
      } catch (error) { failed(error); }
    },
  }));

  await Promise.all([paintSessions(), paintFactors()]);
}

// -- privacy ------------------------------------------------------------------

async function privacy(host) {
  const reachCard = cardOf('Who may reach you', []);
  const blocksCard = cardOf('Blocked', []);
  const reportsCard = cardOf('Your reports', []);
  const dataCard = cardOf('Your data', []);
  host.append(reachCard, blocksCard, reportsCard, dataCard);

  const SCOPES = [['friendRequests', 'Friend requests'], ['dms', 'Messages'], ['presence', 'Presence']];
  const VALUES = [['everyone', 'Everyone'], ['friends', 'Friends'], ['nobody', 'Nobody']];
  try {
    const privacy = await Api.privacy();
    for (const [key, label] of SCOPES) {
      reachCard.appendChild(row({
        title: label,
        sub: 'Currently: ' + String(privacy[key] || 'everyone'),
        side: el('button', {
          class: 'm-go m-go--quiet', type: 'button',
          onClick: () => formSheet({ title: label, confirmLabel: 'Save' }, [
            ['Who may', el('select', { class: 'm-input', 'aria-label': label },
              VALUES.map(([value, word]) => el('option', { value, selected: privacy[key] === value ? '' : null }, word)))],
          ], async () => {
            const pick = document.querySelector('.m-sheet select');
            const body = {};
            body[key] = pick.value;
            await Api.setPrivacy(body);
            toast('Saved');
            host.replaceChildren();
            await privacy(host);
          }),
        }, 'Change'),
      }));
    }
  } catch (error) {
    reachCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Who may reach you'), failure(error, () => { host.replaceChildren(); return privacy(host); }));
  }

  const paintBlocks = async () => {
    try {
      const rows = items(await Api.blocks());
      blocksCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Blocked'),
        ...(rows.length ? rows.map((blocked) => row({
          title: nameOf(blocked) || blocked.username || 'An account',
          sub: '@' + (blocked.username || ''),
          side: el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Unblock',
            onClick: async () => {
              try {
                await Api.unblockUser(blocked.id);
                toast('No longer blocked');
                await paintBlocks();
              } catch (error) { failed(error); }
            },
          }, 'Unblock'),
        })) : [emptyState('lock', 'Nobody blocked', 'A person you block stops reaching you here.')]));
    } catch (error) {
      blocksCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Blocked'), failure(error, paintBlocks));
    }
  };

  const paintReports = async () => {
    try {
      const rows = items(await Api.myReports());
      reportsCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Your reports'),
        ...(rows.length ? rows.map((entry) => row({
          title: entry.reason || 'A report',
          sub: statusWord(entry.targetType || entry.target_type) + (entry.createdAt ? ' · ' + when(entry.createdAt) : ''),
          side: el('span', { class: 'm-row__note' }, statusWord(entry.status)),
        })) : [emptyState('flag', 'Nothing filed', 'A report you file is answered here.')]));
    } catch (error) {
      reportsCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Your reports'), failure(error, paintReports));
    }
  };

  dataCard.appendChild(row({
    title: 'Export your data', lead: el('span', { class: 'm-row__chevron' }, icon('download', { size: 16 })), chevron: true,
    onClick: async () => {
      try {
        const answer = await Api.exportMyData();
        const text = typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2);
        const blob = new Blob([text], { type: 'application/json' });
        const link = el('a', {
          href: URL.createObjectURL(blob), download: 'trycord-data.json',
          'aria-label': 'Download the data export',
        });
        document.body.appendChild(link);
        link.click();
        link.remove();
        toast('The export is downloaded');
      } catch (error) { failed(error); }
    },
  }));

  await Promise.all([paintBlocks(), paintReports()]);
}

// -- notifications ------------------------------------------------------------

async function notifications(host) {
  const wellbeingCard = cardOf('Do not disturb', []);
  const quietCard = cardOf('Quiet hours', []);
  const mutedCard = cardOf('Muted channels', []);
  host.append(wellbeingCard, quietCard, mutedCard);

  try {
    const wellbeing = await Api.wellbeing() || {};
    const dnd = !!wellbeing.dndEnabled;
    wellbeingCard.appendChild(row({
      title: dnd ? 'On — nothing pings you' : 'Off — notifications come as they happen',
      side: el('button', {
        class: 'm-go' + (dnd ? ' m-go--quiet' : ''), type: 'button',
        onClick: async () => {
          try {
            await Api.setWellbeing({ dndEnabled: !dnd });
            toast(dnd ? 'Do not disturb is off' : 'Do not disturb is on');
            host.replaceChildren();
            await notifications(host);
          } catch (error) { failed(error); }
        },
      }, dnd ? 'Turn off' : 'Turn on'),
    }));

    const hours = [[0, 'Midnight'], [8, 'Morning'], [21, 'Evening']];
    quietCard.appendChild(fact('State', wellbeing.quietHoursOn ? 'Holding' : 'Not set'));
    quietCard.appendChild(row({
      title: wellbeing.quietHoursOn
        ? 'From ' + describeValue(wellbeing.quietStart) + ' to ' + describeValue(wellbeing.quietEnd) + ' minutes past midnight'
        : 'Set a span in which nothing arrives',
      side: el('button', {
        class: 'm-go m-go--quiet', type: 'button',
        onClick: () => formSheet({ title: 'Quiet hours', confirmLabel: 'Save' }, [
          ['From', el('select', { class: 'm-input', 'aria-label': 'Quiet hours begin' },
            hours.map(([value, label]) => el('option', { value: String(value) }, label + ' (' + value + ')')))],
          ['Until', el('select', { class: 'm-input', 'aria-label': 'Quiet hours end' },
            hours.map(([value, label]) => el('option', { value: String(value) }, label + ' (' + value + ')')))],
        ], async () => {
          const picks = document.querySelectorAll('.m-sheet select');
          await Api.setWellbeing({
            quietHoursOn: true,
            quietStart: Number(picks[0].value || 0),
            quietEnd: Number(picks[1].value || 0),
          });
          toast('The quiet hours are set');
          host.replaceChildren();
          await notifications(host);
        }),
      }, 'Set'),
    }));
    quietCard.appendChild(row({
      title: 'Lift the quiet hours', chevron: true,
      onClick: async () => {
        try {
          await Api.setWellbeing({ quietHoursOn: false });
          toast('Nothing is held back');
          host.replaceChildren();
          await notifications(host);
        } catch (error) { failed(error); }
      },
    }));
  } catch (error) {
    wellbeingCard.replaceChildren(failure(error, () => { host.replaceChildren(); return notifications(host); }));
  }

  try {
    await refreshMutes();
    const muted = Array.from(State.mutedChannels || []);
    mutedCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Muted channels'),
      ...(muted.length ? muted.map((channelId) => row({
        title: 'A muted channel',
        sub: channelId,
        side: el('button', {
          class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Unmute the channel',
          onClick: async () => {
            try {
              await Api.unmuteChannel(channelId);
              toast('Unmuted');
              host.replaceChildren();
              await notifications(host);
            } catch (error) { failed(error); }
          },
        }, 'Unmute'),
      })) : [emptyState('volume-off', 'Nothing muted', 'A channel you mute stops pinging.')]));
  } catch (error) {
    mutedCard.replaceChildren(failure(error, () => { host.replaceChildren(); return notifications(host); }));
  }
}

// -- encryption ---------------------------------------------------------------

async function encryption(host) {
  const devicesCard = cardOf('Devices', []);
  host.appendChild(cardOf('Where the keys are', [
    el('p', { class: 'm-sheet__note' },
      'Private keys never leave the browser that made them. The server holds the public keys and a copy sealed under your recovery key, so a lost device can be replaced but not read.'),
  ]));
  host.appendChild(devicesCard);

  const paint = async () => {
    devicesCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Devices'), hold());
    try {
      const answer = await request('GET', '/api/e2ee/devices');
      const rows = items(answer.devices || answer);
      devicesCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Devices'),
        ...(rows.length ? rows.map((device) => row({
          lead: el('span', { class: 'm-row__chevron' }, icon('lock', { size: 16 })),
          title: device.label || 'A device',
          sub: (device.createdAt ? 'registered ' + when(device.createdAt) : '') + (device.last_seen_at ? ' · seen ' + when(device.last_seen_at) : ''),
          side: el('button', {
            class: 'm-go m-go--quiet', type: 'button', 'aria-label': 'Revoke the device',
            onClick: async () => {
              if (!(await confirm({
                title: 'Revoke this device?',
                text: 'It loses its keys and can no longer read sealed messages.',
                confirmLabel: 'Revoke', danger: true,
              }))) return;
              try {
                await request('DELETE', '/api/e2ee/devices/' + encodeURIComponent(device.id));
                toast('The device is revoked');
                await paint();
              } catch (error) { failed(error); }
            },
          }, 'Revoke'),
        })) : [emptyState('lock', 'No devices', 'A device registers the first time it sends a sealed message.')]));
    } catch (error) {
      devicesCard.replaceChildren(el('div', { class: 'm-kicker' }, 'Devices'), failure(error, paint));
    }
  };
  await paint();
}

// -- appearance ---------------------------------------------------------------

function currentTheme() {
  try { return localStorage.getItem('trycord.theme') || 'trycord'; } catch { return 'trycord'; }
}

async function appearance(host) {
  const themeCard = cardOf('The theme', []);
  const motionCard = cardOf('Motion', []);
  host.append(themeCard, motionCard);

  try {
    const themes = items(await Api.themes());
    const current = currentTheme();
    themeCard.replaceChildren(el('div', { class: 'm-kicker' }, 'The theme'),
      ...(themes.length ? themes.map((theme) => row({
        title: theme.name || theme.id,
        sub: theme.id === current ? 'In use' : (theme.description || ''),
        side: theme.id === current ? el('span', { class: 'm-row__note' }, 'On') : el('button', {
          class: 'm-go m-go--quiet', type: 'button',
          onClick: () => {
            try {
              localStorage.setItem('trycord.theme', theme.id);
              document.documentElement.setAttribute('data-theme', theme.id);
              toast('The theme is on');
              host.replaceChildren();
              return appearance(host);
            } catch { toast('This device will not keep the choice.', { type: 'danger' }); }
          },
        }, 'Use'),
      })) : [emptyState('palette', 'No themes offered', 'The instance offers none, so the default stays.')]));
  } catch (error) {
    themeCard.replaceChildren(el('div', { class: 'm-kicker' }, 'The theme'), failure(error, () => { host.replaceChildren(); return appearance(host); }));
  }

  let motion = '';
  try { motion = localStorage.getItem('trycord.motion') || ''; } catch { /* session-only */ }
  const reduced = motion === 'reduced';
  motionCard.appendChild(row({
    title: reduced ? 'Reduced — transitions are cut' : 'Full — the interface moves',
    side: el('button', {
      class: 'm-go' + (reduced ? '' : ' m-go--quiet'), type: 'button',
      onClick: () => {
        try {
          localStorage.setItem('trycord.motion', reduced ? '' : 'reduced');
          document.documentElement.setAttribute('data-motion', reduced ? '' : 'reduced');
          toast(reduced ? 'Motion is back' : 'Motion is reduced');
          host.replaceChildren();
          return appearance(host);
        } catch { toast('This device will not keep the choice.', { type: 'danger' }); }
      },
    }, reduced ? 'Restore' : 'Reduce'),
  }));

  const prefs = readPrefs();
  host.appendChild(cardOf('The phone\'s own choices', [
    fact('Density', describeValue(prefs.density)),
    row({
      title: 'Reset the phone\'s stored choices', chevron: true,
      onClick: async () => {
        if (!(await confirm({ title: 'Reset the stored choices?', text: 'Tabs and density go back to what a new device would see.', confirmLabel: 'Reset' }))) return;
        patchPrefs({});
        toast('Reset');
      },
    }),
  ]));
}

// -- language -----------------------------------------------------------------

async function language(host) {
  const card = cardOf('The words', []);
  host.appendChild(card);
  try {
    const [locales, preference] = await Promise.all([
      Api.localisationLocales(),
      Api.localisationPreference(),
    ]);
    const rows = items(locales.locales || locales);
    const current = preference && (preference.locale || preference.language);
    card.replaceChildren(el('div', { class: 'm-kicker' }, 'The words'),
      ...(rows.length ? rows.map((locale) => row({
        title: (locale.label || locale.name || locale.locale || locale.code || 'A language')
          + (locale.nativeName && locale.nativeName !== (locale.label || locale.name) ? ' · ' + locale.nativeName : ''),
        sub: locale.code === current ? 'In use' : (locale.code || ''),
        side: locale.code === current ? el('span', { class: 'm-row__note' }, 'On') : el('button', {
          class: 'm-go m-go--quiet', type: 'button',
          onClick: async () => {
            try {
              await Api.setLocalisationPreference({ locale: locale.code });
              toast('The words are set');
              host.replaceChildren();
              await language(host);
            } catch (error) { failed(error); }
          },
        }, 'Use'),
      })) : [emptyState('globe', 'One language', 'This instance serves its own words only.')]));
  } catch (error) {
    card.replaceChildren(failure(error, () => { host.replaceChildren(); return language(host); }));
  }
}

// -- backend / updates --------------------------------------------------------

async function backend(host) {
  host.appendChild(hold());
  try {
    const [instance, status] = await Promise.all([
      Api.instance(),
      Api.instanceSettingsStatus().catch(() => null),
    ]);
    clear(host);
    host.appendChild(cardOf('The instance', [
      fact('Name', instance.name),
      fact('Version', instance.version),
      fact('Address', instance.instanceId || ''),
      fact('Description', instance.description || '—'),
      instance.supportUrl ? fact('Support', instance.supportUrl) : null,
    ]));
    if (status) {
      host.appendChild(cardOf('What is forced by the deployment', [
        fact('Environment authority', status.envAuthority ? 'Some values are set by the deployment' : 'Everything is saved here'),
      ]));
    }
    host.appendChild(row({
      title: 'Open the public site', lead: el('span', { class: 'm-row__chevron' }, icon('external', { size: 16 })), chevron: true,
      onClick: () => { window.open(location.origin, '_blank', 'noopener,noreferrer'); },
    }));
  } catch (error) {
    clear(host);
    host.appendChild(failure(error, () => { host.replaceChildren(); return backend(host); }));
  }
}

async function updates(host) {
  host.appendChild(hold());
  try {
    const instance = await Api.instance();
    clear(host);
    host.appendChild(cardOf('The build', [
      fact('Version', instance.version),
      fact('Instance', instance.name),
    ]));
    host.appendChild(el('p', { class: 'm-sheet__note' },
      'Trycord is self-hosted: updates are carried by whoever runs this instance, not by an app store. This page says what is running, so a question to the operators can name it.'));
  } catch (error) {
    clear(host);
    host.appendChild(failure(error, () => { host.replaceChildren(); return updates(host); }));
  }
}

const SECTIONS = {
  'settings': index,
  'settings.security': security,
  'settings.privacy': privacy,
  'settings.notifications': notifications,
  'settings.encryption': encryption,
  'settings.appearance': appearance,
  'settings.language': language,
  'settings.backend': backend,
  'settings.updates': updates,
};

export function renderSettings(ctx) {
  return consoleScreen(ctx.page.id, SECTIONS);
}
