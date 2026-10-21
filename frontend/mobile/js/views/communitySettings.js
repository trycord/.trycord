// The community settings console, on a phone.
//
// A screen at a time: the sections are a strip at the top, and the section
// that is open fills the screen below it. The desk is a studio with a rail
// beside the work; a phone has no room for that, so the console is a strip
// and one screen.
//
// The capabilities are the same as the desk's, and they come from the same
// catalogue (packages/communitySettings.js): the same sections, the same
// rules, and the same calls. What is different is the shape - a sheet
// instead of a dialog, a thumb instead of a mouse, and one thing on the
// screen rather than a rail and a stage.
//
// Three rules the phone keeps:
//
//   - a section says it is loading rather than showing an empty form;
//   - a section with unsaved changes asks before it is left;
//   - a secret is shown once, in a sheet, and never again.

import { el, replaceChildren } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { navigate } from '../../../packages/nav.js';
import { screen } from './util.js';
import { empty, loading, failure } from '../components.js';
import { sheet, confirm, toast } from '../ui.js';
import {
  State, serverById, refreshServer, refreshServerTree, refreshServerRoles,
  refreshServerMembers, can, isOwner,
} from '../../../packages/store.js';
import {
  COMMUNITY_SECTIONS, communityApi, createFormState, readDocument, maskSecret,
} from '../../../packages/communitySettings.js';
import { voiceSection } from './communityVoice.js';
import { rulesSection } from './communityRules.js';
import { onboardingSection } from './onboardingSettings.js';
import {
  renderMembersPage, renderRolesPage, renderInvitesPage, renderCategoriesPage,
} from './community.js';
import { openChannelEditor, deleteChannel } from '../manage.js';

// The name of a member, however the server spells it.
function memberName(member) {
  return member.nickname || member.display_name || member.displayName
    || member.username || 'Someone';
}

// A labelled control.
function field(label, control, note) {
  return el('label', { class: 'm-field' },
    el('span', { class: 'm-field__label' }, label),
    control,
    note ? el('span', { class: 'm-field__note' }, note) : null);
}

// A line that says what happened.
function reporter() {
  const node = el('div', { class: 'm-notice m-notice--info', role: 'status' },
    el('span', { class: 'm-notice__icon' }, icon('info', { size: 18 })),
    el('div', { class: 'm-notice__main' },
      el('div', { class: 'm-notice__text' }, '')));
  const text = node.querySelector('.m-notice__text');
  return {
    node,
    say(message) {
      text.textContent = message;
      node.classList.remove('m-notice--danger');
      node.classList.add('m-notice--success');
    },
    fail(error) {
      text.textContent = (error && error.message) ? error.message : 'That did not work.';
      node.classList.remove('m-notice--success');
      node.classList.add('m-notice--danger');
    },
  };
}

// The one copy of a secret, in a sheet.
//
// It is shown once and it is not kept: the sheet holds it until it is closed,
// and the console keeps a mask in its place.
function showSecret(title, value, text) {
  const code = el('div', { class: 'm-code' }, value);
  const layer = sheet({
    title,
    body: el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' }, text),
      code,
      el('p', { class: 'm-section__note' },
        'Nothing keeps a copy of this. Copy it now: it cannot be read again.')),
  });
  return layer;
}

// -- overview -----------------------------------------------------------------

function overviewSection(serverId) {
  const host = el('div', { class: 'm-stack' });
  const form = createFormState({});
  const status = reporter();

  const build = (community, settings) => {
    const name = el('input', {
      class: 'm-input', type: 'text', value: community.name || '', maxlength: '60',
      'aria-label': 'Community name',
    });
    const description = el('textarea', {
      class: 'm-input m-input--area', rows: '3', maxlength: '400',
      'aria-label': 'Description',
    }, community.description || '');
    const isPublic = el('input', {
      type: 'checkbox', class: 'm-check', checked: community.is_public ? true : null,
    });
    const discoverable = el('input', {
      type: 'checkbox', class: 'm-check', checked: community.is_discoverable ? true : null,
    });
    const federated = el('input', {
      type: 'checkbox', class: 'm-check', checked: community.federated === false ? null : true,
    });
    const welcome = el('textarea', {
      class: 'm-input m-input--area', rows: '3',
      'aria-label': 'The message a newcomer is greeted with',
    }, settings.welcomeContent || '');
    const welcomeOn = el('input', {
      type: 'checkbox', class: 'm-check', checked: settings.welcomeEnabled ? true : null,
    });
    const guidelines = el('textarea', {
      class: 'm-input m-input--area', rows: '6',
      'aria-label': 'The rules of this community',
    }, settings.guidelines || '');
    const notifications = el('textarea', {
      class: 'm-input m-input--area m-input--compact', rows: '3',
      'aria-label': 'The notification defaults of this community',
    }, settings.notificationDefaults || '');
    const interactions = el('textarea', {
      class: 'm-input m-input--area m-input--compact', rows: '3',
      'aria-label': 'The interaction settings of this community',
    }, settings.interactionSettings || '');

    form.load({
      name: community.name || '',
      description: community.description || '',
      isPublic: !!community.is_public,
      isDiscoverable: !!community.is_discoverable,
      federated: community.federated !== false,
      welcomeContent: settings.welcomeContent || '',
      welcomeEnabled: !!settings.welcomeEnabled,
      guidelines: settings.guidelines || '',
      notificationDefaults: settings.notificationDefaults || '',
      interactionSettings: settings.interactionSettings || '',
    });

    name.addEventListener('input', () => form.set('name', name.value));
    description.addEventListener('input', () => form.set('description', description.value));
    isPublic.addEventListener('change', () => form.set('isPublic', isPublic.checked));
    discoverable.addEventListener('change', () => form.set('isDiscoverable', discoverable.checked));
    federated.addEventListener('change', () => form.set('federated', federated.checked));
    welcome.addEventListener('input', () => form.set('welcomeContent', welcome.value));
    welcomeOn.addEventListener('change', () => form.set('welcomeEnabled', welcomeOn.checked));
    guidelines.addEventListener('input', () => form.set('guidelines', guidelines.value));
    notifications.addEventListener('input', () => form.set('notificationDefaults', notifications.value));
    interactions.addEventListener('input', () => form.set('interactionSettings', interactions.value));

    const saveIdentity = el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
    }, 'Save the identity and the reach');
    saveIdentity.addEventListener('click', async () => {
      saveIdentity.disabled = true;
      try {
        const body = {};
        if (form.changed('name')) body.name = name.value.trim();
        if (form.changed('description')) body.description = description.value.trim();
        if (form.changed('isPublic')) body.isPublic = form.value('isPublic');
        if (form.changed('isDiscoverable')) body.isDiscoverable = form.value('isDiscoverable');
        if (form.changed('federated')) body.federated = form.value('federated');
        if (!Object.keys(body).length) {
          status.say('Nothing changed, so nothing was written.');
          return;
        }
        await Api.updateServer(serverId, body);
        form.commit(['name', 'description', 'isPublic', 'isDiscoverable', 'federated']);
        status.say(body.federated === false
          ? 'Saved. This community is not listed to other instances, and nothing is relayed from it.'
          : 'Saved.');
        await refreshServer(serverId).catch(() => {});
      } catch (error) {
        status.fail(error);
      } finally {
        saveIdentity.disabled = false;
      }
    });

    const saveWelcome = el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
    }, 'Save the welcome');
    saveWelcome.addEventListener('click', async () => {
      saveWelcome.disabled = true;
      try {
        const body = {};
        if (form.changed('welcomeContent')) body.welcome_content = welcome.value;
        if (form.changed('welcomeEnabled')) body.welcome_enabled = form.value('welcomeEnabled');
        if (!Object.keys(body).length) {
          status.say('Nothing changed, so nothing was written.');
          return;
        }
        await Api.updateServerSettings(serverId, body);
        form.commit(['welcomeContent', 'welcomeEnabled']);
        status.say('The welcome was saved.');
      } catch (error) {
        status.fail(error);
      } finally {
        saveWelcome.disabled = false;
      }
    });

    const saveGuidelines = el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
    }, 'Save the guidelines');
    saveGuidelines.addEventListener('click', async () => {
      saveGuidelines.disabled = true;
      try {
        // The guard: an unchanged box is never written over.
        if (!form.changed('guidelines')) {
          status.say('The guidelines are unchanged, so nothing was written.');
          return;
        }
        await Api.updateServerSettings(serverId, { guidelines: guidelines.value });
        form.commit(['guidelines']);
        status.say('The guidelines were saved.');
      } catch (error) {
        status.fail(error);
      } finally {
        saveGuidelines.disabled = false;
      }
    });

    const saveDefaults = el('button', {
      class: 'm-btn m-btn--block m-btn--primary', type: 'button',
    }, 'Save the defaults');
    saveDefaults.addEventListener('click', async () => {
      saveDefaults.disabled = true;
      try {
        const body = {};
        if (form.changed('notificationDefaults')) body.notification_defaults = notifications.value;
        if (form.changed('interactionSettings')) body.interaction_settings = interactions.value;
        if (!Object.keys(body).length) {
          status.say('Nothing changed, so nothing was written.');
          return;
        }
        await Api.updateServerSettings(serverId, body);
        form.commit(['notificationDefaults', 'interactionSettings']);
        status.say('The defaults were saved.');
      } catch (error) {
        status.fail(error);
      } finally {
        saveDefaults.disabled = false;
      }
    });

    const notificationDocument = readDocument(settings.notificationDefaults);
    const interactionDocument = readDocument(settings.interactionSettings);
    const documentNote = (document) => (document.ok ? null : el('p', { class: 'm-section__note' },
      document.reason + ' It is shown exactly as it is stored; edit it here to replace it.'));

    replaceChildren(host, 
      status.node,
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'The community')),
        el('div', { class: 'm-stack' },
          field('Name', name),
          field('Description', description),
          el('label', { class: 'm-check-row' }, isPublic,
            el('span', {}, 'Public — anyone with the address can read it')),
          el('label', { class: 'm-check-row' }, discoverable,
            el('span', {}, 'Discoverable — listed on Discover')),
          el('label', { class: 'm-check-row' }, federated,
            el('span', {}, 'Federated — other instances are told about this community and relay it. Turning this off means the community is not listed to other instances, and nothing is relayed from it.')),
          el('div', { class: 'm-actions' }, saveIdentity),
          el('p', { class: 'm-section__note' },
            'The join code is ' + (community.join_code || 'not set') + '.'),
          el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            onClick: () => {
              const code = community.join_code || '';
              if (navigator && navigator.clipboard) {
                navigator.clipboard.writeText(code).then(
                  () => toast('The join code was copied.', { type: 'success' }),
                  () => toast('The join code could not be copied.', { type: 'danger' }));
              }
            },
          }, icon('copy', { size: 16 }), 'Copy the join code'))),
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'The welcome')),
        el('div', { class: 'm-stack' },
          field('Welcome message', welcome),
          el('label', { class: 'm-check-row' }, welcomeOn, el('span', {}, 'Show the welcome')),
          el('div', { class: 'm-actions' }, saveWelcome))),
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'The guidelines')),
        el('div', { class: 'm-stack' },
          field('The rules of this community', guidelines),
          el('div', { class: 'm-actions' }, saveGuidelines))),
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'The defaults')),
        el('div', { class: 'm-stack' },
          el('p', { class: 'm-section__note' },
            'The instance keeps these two as they are written. A document it cannot read is kept as it is, and is shown as it is.'),
          field('Notification defaults', notifications),
          documentNote(notificationDocument),
          field('Interaction settings', interactions),
          documentNote(interactionDocument),
          el('div', { class: 'm-actions' }, saveDefaults))),
    );
  };

  const load = async () => {
    replaceChildren(host, loading('Reading the community settings'));
    let community = null;
    try {
      community = await Api.server(serverId);
    } catch (error) {
      replaceChildren(host, failure(error, load));
      return;
    }
    let settings = {};
    try {
      settings = await communityApi.readSettings(serverId);
    } catch (error) {
      settings = {};
    }
    build(community, settings || {});
  };

  return { node: host, load, isDirty: () => form.isDirty() };
}

// -- appearance ----------------------------------------------------------------

function appearanceSection(serverId) {
  const host = el('div', { class: 'm-stack' });

  const build = () => {
    const community = serverById(serverId) || {};
    const pick = (kind) => {
      const input = el('input', { type: 'file', accept: 'image/*', class: 'visually-hidden' });
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) return;
        try {
          await Api.setServerImage(serverId, kind, file);
          toast('Image updated.', { type: 'success' });
          await refreshServer(serverId).catch(() => {});
          build();
        } catch (error) {
          toast(error.message, { type: 'danger' });
        }
      });
      input.click();
    };
    replaceChildren(host, 
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'The house')),
        el('div', { class: 'm-stack' },
          el('div', { class: 'm-actions' },
            el('button', {
              class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
              onClick: () => pick('icon'),
            }, icon('image', { size: 16 }), 'Change the icon'),
            community.icon_url ? el('button', {
              class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
              onClick: async () => {
                try {
                  await Api.removeServerImage(serverId, 'icon');
                  toast('Image removed.', { type: 'success' });
                  await refreshServer(serverId).catch(() => {});
                  build();
                } catch (error) { toast(error.message, { type: 'danger' }); }
              },
            }, 'Remove the icon') : null),
          el('div', { class: 'm-actions' },
            el('button', {
              class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
              onClick: () => pick('banner'),
            }, icon('image', { size: 16 }), 'Change the banner'),
            community.banner_url ? el('button', {
              class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
              onClick: async () => {
                try {
                  await Api.removeServerImage(serverId, 'banner');
                  toast('Image removed.', { type: 'success' });
                  await refreshServer(serverId).catch(() => {});
                  build();
                } catch (error) { toast(error.message, { type: 'danger' }); }
              },
            }, 'Remove the banner') : null))),
    );
  };

  const load = async () => {
    replaceChildren(host, loading('Reading the community'));
    try {
      await refreshServer(serverId);
    } catch { /* the form still edits what it has */ }
    build();
  };

  return { node: host, load };
}

// -- channels -------------------------------------------------------------------

function channelsSection(serverId) {
  const host = el('div', { class: 'm-stack' });

  const load = async () => {
    replaceChildren(host, loading('Loading channels'));
    try {
      await refreshServerTree(serverId, { force: true });
    } catch (error) {
      replaceChildren(host, failure(error, load));
      return;
    }
    const tree = State.serverTree.get(serverId) || { channels: [] };
    const channels = tree.channels || [];
    const newButton = el('button', {
      class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
      onClick: () => openChannelEditor(serverId, null, load),
    }, 'New channel');
    if (!channels.length) {
      replaceChildren(host, empty({
        icon: 'hash', title: 'No channels', text: 'Make one so people can talk.',
      }));
      return;
    }
    const rows = el('div', { class: 'm-list' });
    for (const channel of channels) {
      rows.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__lead' }, icon(channel.type === 'voice' ? 'volume' : 'hash', { size: 17 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' }, channel.name),
          el('span', { class: 'm-row__sub truncate' }, channel.topic || '')),
        el('span', { class: 'm-row__actions' },
          el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            'aria-label': 'Edit ' + channel.name,
            onClick: () => openChannelEditor(serverId, channel, load),
          }, 'Edit'),
          el('button', {
            class: 'm-btn m-btn--sm m-btn--danger', type: 'button',
            'aria-label': 'Delete ' + channel.name,
            onClick: () => deleteChannel(serverId, channel, load),
          }, 'Delete'))));
    }
    replaceChildren(host, 
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' },
          el('div', { class: 'm-section__title' }, 'Channels'), newButton),
        rows),
    );
  };

  return { node: host, load };
}

// -- categories -------------------------------------------------------------------

// The categories, and what each one allows whatever the roles say.
function categoriesSection(serverId) {
  const host = el('div', { class: 'm-stack' });
  const mayManage = can(serverId, 'MANAGE_CHANNELS') || isOwner(serverId);

  const load = async () => {
    replaceChildren(host, loading('Loading the categories'));
    const page = renderCategoriesPage({ serverId });
    const overrides = mayManage ? overridesEditor(serverId, 'category') : null;
    replaceChildren(host, 
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'Categories')),
        page.node),
      overrides ? overrides.node : null,
    );
    if (page.onMount) await page.onMount();
    if (overrides && overrides.load) await overrides.load();
  };

  return { node: host, load };
}

// What one channel or one category allows, whatever the roles say.
function overridesEditor(serverId, kind) {
  const isChannel = kind === 'channel';
  const host = el('div', { class: 'm-stack' });
  const status = reporter();
  const picker = el('select', {
    class: 'm-input m-input--select',
    'aria-label': isChannel ? 'The channel to change' : 'The category to change',
  });

  const entities = () => {
    const tree = State.serverTree.get(serverId) || { channels: [], categories: [] };
    return isChannel ? (tree.channels || []) : (tree.categories || []);
  };

  const load = async () => {
    const list = entities();
    replaceChildren(picker, ...list.map((entity) => el('option', {
      value: entity.id,
    }, isChannel ? '#' + entity.name : entity.name)));
    if (!list.length) {
      replaceChildren(host, el('p', { class: 'm-section__note' },
        isChannel ? 'There are no channels to change yet.' : 'There are no categories to change yet.'));
      return;
    }
    if (!picker.value) picker.value = list[0].id;
    replaceChildren(host, loading('Reading the overrides'));
    try {
      const [answer, catalogue] = await Promise.all([
        isChannel
          ? communityApi.channelOverrides(serverId, picker.value)
          : communityApi.categoryOverrides(serverId, picker.value),
        Api.rolePermissions(serverId),
      ]);
      const overrides = (answer && answer.overrides) || {};
      const all = (answer && answer.all) || (catalogue && catalogue.all) || [];
      const descriptions = (catalogue && catalogue.descriptions) || {};
      const rows = el('div', { class: 'm-list' });
      for (const permission of all) {
        const control = el('select', {
          class: 'm-input m-input--select',
          'aria-label': 'What ' + permission + ' is allowed in ' + (picker.value || ''),
        },
        el('option', { value: 'inherit' }, 'Inherited'),
        el('option', { value: 'allow' }, 'Allowed'),
        el('option', { value: 'deny' }, 'Refused'));
        control.value = overrides[permission] || 'inherit';
        control.addEventListener('change', async () => {
          try {
            if (isChannel) {
              await communityApi.setChannelOverride(serverId, picker.value, permission, control.value);
            } else {
              await communityApi.setCategoryOverride(serverId, picker.value, permission, control.value);
            }
            status.say('The server answered: ' + permission + ' is ' + control.value + '.');
          } catch (error) {
            status.fail(error);
          }
        });
        rows.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, permission),
            el('span', { class: 'm-row__sub' }, descriptions[permission] || '')),
          el('span', { class: 'm-row__side' }, control)));
      }
      replaceChildren(host, 
        status.node,
        el('section', { class: 'm-section' },
          el('div', { class: 'm-section__head' },
            el('div', { class: 'm-section__title' }, isChannel ? 'What a channel allows' : 'What a category allows')),
          el('div', { class: 'm-stack' }, picker, rows)),
      );
    } catch (error) {
      replaceChildren(host, failure(error, load));
    }
  };

  picker.addEventListener('change', load);

  return {
    node: host,
    load,
  };
}

// -- roles -------------------------------------------------------------------------

// The roles, the catalogue of permissions, and the overrides.
function rolesSection(serverId) {
  const host = el('div', { class: 'm-stack' });
  const mayRoles = can(serverId, 'MANAGE_ROLES') || isOwner(serverId);
  const mayChannels = can(serverId, 'MANAGE_CHANNELS') || isOwner(serverId);

  const load = async () => {
    replaceChildren(host, loading('Loading the roles'));
    const page = renderRolesPage({ serverId });
    const catalogue = el('div', { class: 'm-list' });
    const assignment = el('div', { class: 'm-stack' });

    try {
      const answer = await Api.rolePermissions(serverId);
      const all = (answer && answer.all) || [];
      const descriptions = (answer && answer.descriptions) || {};
      for (const permission of all) {
        catalogue.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, permission),
            el('span', { class: 'm-row__sub' }, descriptions[permission] || ''))));
      }
    } catch (error) {
      catalogue.appendChild(failure(error, null));
    }

    if (mayRoles) {
      const rolePick = el('select', { class: 'm-input m-input--select', 'aria-label': 'The role to give' });
      const memberPick = el('select', { class: 'm-input m-input--select', 'aria-label': 'The member who gets it' });
      const give = el('button', { class: 'm-btn m-btn--sm m-btn--primary', type: 'button' }, 'Give the role');
      const status = reporter();
      try {
        await refreshServerRoles(serverId);
        const roles = State.serverRoles.get(serverId) || [];
        for (const role of roles) rolePick.appendChild(el('option', { value: role.id }, role.name));
        const page2 = await refreshServerMembers(serverId);
        for (const member of (page2 && page2.items) || []) {
          memberPick.appendChild(el('option', { value: member.id }, memberName(member)));
        }
        give.addEventListener('click', async () => {
          if (!rolePick.value || !memberPick.value) return;
          try {
            await Api.assignRole(serverId, rolePick.value, memberPick.value);
            status.say('The server answered: the role was given.');
            await load();
          } catch (error) {
            status.fail(error);
          }
        });
        replaceChildren(assignment, status.node, el('div', { class: 'm-stack' },
          field('The role', rolePick),
          field('The member', memberPick),
          el('div', { class: 'm-actions' }, give)));
      } catch (error) {
        replaceChildren(assignment, failure(error, null));
      }
    }

    const channelOverrides = mayChannels ? overridesEditor(serverId, 'channel') : null;
    const categoryOverrides = mayChannels ? overridesEditor(serverId, 'category') : null;

    replaceChildren(host, 
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'Roles')),
        page.node),
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'What a role may do')),
        catalogue),
      assignment,
      channelOverrides ? channelOverrides.node : null,
      categoryOverrides ? categoryOverrides.node : null,
    );
    if (page.onMount) await page.onMount();
    if (channelOverrides) await channelOverrides.load();
    if (categoryOverrides) await categoryOverrides.load();
  };

  return { node: host, load };
}

// -- moderation -------------------------------------------------------------------

// The note about a member.
//
// A note is a moderator's private record of what they think of somebody:
// what was said, what was tried, what to watch for. So it is written here
// and nowhere else, and the member it is about never sees it - the server
// refuses to hand it to anybody who cannot moderate here.
function editNote(serverId, member, note, status, load) {
  const body = el('textarea', {
    class: 'm-input m-input--area', rows: '5', maxlength: '2000',
    'aria-label': 'The note about ' + memberName(member),
    placeholder: 'What should the next moderator know?',
  });
  body.value = note ? note.body : '';

  const save = el('button', { class: 'm-btn m-btn--primary', type: 'button' }, 'Save the note');
  // The note can be taken away as well as written, so the sheet carries both
  // buttons when there is a note to take.
  const drop = note
    ? el('button', { class: 'm-btn m-btn--ghost', type: 'button' }, 'Take it away')
    : null;
  const layer = sheet({
    title: 'A note about ' + memberName(member),
    body: el('div', { class: 'm-stack' },
      el('p', { class: 'm-lede' },
        'Only the moderators of this community can read this. '
        + 'The member it is about never sees it.'),
      el('div', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'The note'), body),
      drop,
      save),
  });

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await Api.setMemberNote(serverId, member.id, body.value.trim());
      status.say('The server answered: the note about ' + memberName(member) + ' was saved.');
      layer.close();
      await load();
    } catch (error) {
      save.disabled = false;
      status.fail(error);
    }
  });

  if (drop) {
    drop.addEventListener('click', async () => {
      drop.disabled = true;
      try {
        await Api.deleteMemberNote(serverId, member.id);
        status.say('The server answered: the note about ' + memberName(member) + ' was taken away.');
        layer.close();
        await load();
      } catch (error) {
        drop.disabled = false;
        status.fail(error);
      }
    });
  }
}


// The bans, the timeouts and the removal.
function moderationSection(serverId) {
  const host = el('div', { class: 'm-stack' });
  const status = reporter();

  // The selection for the bulk actions.
  //
  // Several members at once is a real job - a raid, a wave of spam, a room
  // that needs clearing - and doing it one person at a time is slow enough
  // that people give up half way. The selection is only ever shown to
  // somebody who may act on the members in it.
  let selecting = false;
  const selected = new Set();

  // The roster the removal list is drawn from, and the bulk actions act on.
  let members = [];

  const load = async () => {
    replaceChildren(host, loading('Reading the moderation lists'));
    const mayBan = can(serverId, 'BAN_MEMBERS') || isOwner(serverId);
    const mayKick = can(serverId, 'KICK_MEMBERS') || isOwner(serverId);
    let bans = [];
    try {
      const [banRows, page] = await Promise.all([
        mayBan ? Api.bans(serverId) : Promise.resolve([]),
        Api.serverMembers(serverId, { limit: 200 }),
      ]);
      bans = Array.isArray(banRows) ? banRows : (banRows && banRows.items) || [];
      members = (page && page.items) || [];
    } catch (error) {
      replaceChildren(host, failure(error, load));
      return;
    }

    const banRows = el('div', { class: 'm-list' });
    if (!bans.length) {
      banRows.appendChild(empty({
        icon: 'ban', title: 'Nobody is banned', text: 'People you ban appear here, and can be unbanned.',
      }));
    }
    for (const ban of bans) {
      const name = ban.displayName || ban.username || 'Someone';
      banRows.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, name),
          el('span', { class: 'm-row__sub' }, ban.reason || 'No reason given')),
        el('span', { class: 'm-row__actions' },
          el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            'aria-label': 'Lift the ban on ' + name,
            onClick: async () => {
              const sure = await confirm({
                title: 'Lift the ban?', text: name + ' can come back to the community.',
                confirmLabel: 'Lift the ban',
              });
              if (!sure) return;
              try {
                await Api.unbanMember(serverId, ban.userId || ban.user_id || ban.id);
                status.say('The server answered: the ban was lifted.');
                await load();
              } catch (error) { status.fail(error); }
            },
          }, 'Lift'))));
    }

    const timedOut = members.filter((member) => member.timeout_expires_at
      && Date.parse(member.timeout_expires_at) > Date.now());
    const timeoutRows = el('div', { class: 'm-list' });
    if (!timedOut.length) {
      timeoutRows.appendChild(empty({
        icon: 'clock', title: 'Nobody is timed out',
        text: 'A member who is timed out stays in the community and cannot post until it lapses.',
      }));
    }
    for (const member of timedOut) {
      timeoutRows.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, memberName(member)),
          el('span', { class: 'm-row__sub' }, 'Cannot post until ' + member.timeout_expires_at)),
        el('span', { class: 'm-row__actions' },
          el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            'aria-label': 'Lift the timeout on ' + memberName(member),
            onClick: async () => {
              const sure = await confirm({
                title: 'Lift the timeout?', text: memberName(member) + ' can post again straight away.',
                confirmLabel: 'Lift the timeout',
              });
              if (!sure) return;
              try {
                await Api.timeoutMember(serverId, member.id, 0);
                status.say('The server answered: the timeout was lifted.');
                await load();
              } catch (error) { status.fail(error); }
            },
          }, 'Lift'))));
    }

    const removalRows = el('div', { class: 'm-list' });
    if (!mayKick) {
      removalRows.appendChild(empty({
        icon: 'logout', title: 'You cannot remove members here',
        text: 'Removing somebody takes a permission this account does not hold.',
      }));
    }
    // The notes the community's moderators keep about the people in it. The
    // same family of permissions opens them: somebody who may remove a
    // member or run the community may keep notes about the people in it.
    const mayWriteNotes = mayBan || mayKick
      || can(serverId, 'MANAGE_SERVER') || isOwner(serverId);
    const notes = mayWriteNotes ? await Api.memberNotes(serverId) : { notes: [] };
    const noteList = (notes && notes.notes) || [];
    const noteFor = (id) => noteList.find((note) => String(note.userId) === String(id)) || null;
    for (const member of mayKick ? members : []) {
      if (member.is_owner || member.isOwner) continue;
      const picked = selected.has(String(member.id));
      // A member with a note says so, so a moderator knows there is
      // something to read before they act.
      const note = noteFor(member.id);
      removalRows.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title' }, memberName(member)),
          el('span', { class: 'm-row__sub' },
            note ? '@' + (member.username || '') + ' · has a note' : '@' + (member.username || ''))),
        el('span', { class: 'm-row__actions' },
          selecting ? el('input', {
            type: 'checkbox', class: 'm-check',
            'aria-label': 'Select ' + memberName(member),
            checked: picked ? true : null,
            onChange: (event) => {
              const on = event.target.checked;
              if (on) selected.add(String(member.id));
              else selected.delete(String(member.id));
              load();
            },
          }) : null,
          mayWriteNotes ? el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            'aria-label': (note ? 'Read the note about ' : 'Write a note about ') + memberName(member),
            onClick: () => editNote(serverId, member, note, status, load),
          }, 'Note') : null,
          el('button', {
            class: 'm-btn m-btn--sm m-btn--danger', type: 'button',
            'aria-label': 'Remove ' + memberName(member) + ' from the community',
            onClick: async () => {
              const sure = await confirm({
                title: 'Remove ' + memberName(member) + '?',
                text: 'They leave the community. They can come back if there is a place for them.',
                confirmLabel: 'Remove', danger: true,
              });
              if (!sure) return;
              try {
                await Api.kickMember(serverId, member.id);
                status.say('The server answered: ' + memberName(member) + ' was removed.');
                await load();
              } catch (error) { status.fail(error); }
            },
          }, 'Remove'))));
    }

    // -- several at a time ----------------------------------------------------
    //
    // The bar that appears when members are picked. It says how many are
    // picked, and it does the thing to all of them at once - and it says what
    // happened, including the ones it could not do.
    const names = members
      .filter((member) => selected.has(String(member.id)))
      .map((member) => memberName(member));
    const bar = el('div', { class: 'm-stack' });
    if (selecting && names.length) {
      bar.appendChild(el('p', { class: 'm-lede' },
        names.length + (names.length === 1 ? ' member is picked' : ' members are picked')
        + ': ' + names.join(', ') + '.'));
      const times = el('button', { class: 'm-btn m-btn--default', type: 'button' }, 'Time them out');
      times.addEventListener('click', () => bulk(names, (member) => Api.timeoutMember(serverId, member.id, 60),
        'They are timed out for an hour'));
      const drops = el('button', { class: 'm-btn m-btn--danger', type: 'button' }, 'Remove them');
      drops.addEventListener('click', async () => {
        const sure = await confirm({
          title: names.length === 1 ? 'Remove ' + names[0] + '?' : 'Remove ' + names.length + ' members?',
          text: names.join(', ') + ' leave the community.',
          confirmLabel: 'Remove', danger: true,
        });
        if (!sure) return;
        await bulk(names, (member) => Api.kickMember(serverId, member.id), 'They were removed');
      });
      bar.appendChild(times);
      bar.appendChild(drops);
      const none = el('button', { class: 'm-btn m-btn--ghost', type: 'button' }, 'Pick none');
      none.addEventListener('click', () => { selected.clear(); load(); });
      bar.appendChild(none);
    }

    const pick = el('button', {
      class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
      onClick: () => {
        selecting = !selecting;
        if (!selecting) selected.clear();
        load();
      },
    }, selecting ? 'Done' : 'Pick several');

    replaceChildren(host, 
      status.node,
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'Banned')),
        banRows),
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'Timed out')),
        timeoutRows),
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' },
          el('div', { class: 'm-section__title' }, 'The roster'),
          mayKick ? pick : null),
        removalRows,
        bar),
    );
  };

  // Several members at a time.
  //
  // The server is asked once per member, because the server is the only thing
  // that knows whether it will. So the answer is counted and reported
  // honestly: if four of five could not be removed, the report says so
  // rather than claiming that five were.
  const bulk = async (names, act, described) => {
    const done = [];
    const refused = [];
    for (const name of names) {
      const member = members.find((m) => memberName(m) === name);
      if (!member) { refused.push(name + ' (no longer here)'); continue; }
      try {
        await act(member);
        done.push(name);
      } catch (error) {
        refused.push(name + ' (' + ((error && error.message) || 'refused') + ')');
      }
    }
    selected.clear();
    selecting = false;
    if (refused.length) {
      status.fail({
        message: described + ': ' + done.length + ' of ' + names.length
          + ' went through. Not: ' + refused.join(', ') + '.',
      });
    } else {
      status.say('The server answered: ' + described + ' for '
        + done.length + (done.length === 1 ? ' member.' : ' members.'));
    }
    await load();
  };

  return { node: host, load };
}

// -- integrations --------------------------------------------------------------------

// The webhooks and the applications, and the secrets they hold.
function integrationsSection(serverId) {
  const host = el('div', { class: 'm-stack' });
  const status = reporter();

  const load = async () => {
    replaceChildren(host, loading('Reading the integrations'));
    let hooks = [];
    let apps = [];
    try {
      const [hookAnswer, appAnswer] = await Promise.all([
        Api.webhooks(serverId),
        communityApi.apps(serverId),
      ]);
      hooks = (hookAnswer && hookAnswer.webhooks) || [];
      apps = (appAnswer && appAnswer.apps) || [];
    } catch (error) {
      replaceChildren(host, failure(error, load));
      return;
    }

    const hookRows = el('div', { class: 'm-list' });
    if (!hooks.length) {
      hookRows.appendChild(empty({
        icon: 'zap', title: 'No webhooks',
        text: 'A webhook is an address another program can post messages through.',
      }));
    }
    for (const hook of hooks) {
      hookRows.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__lead' }, icon('zap', { size: 17 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' }, hook.name || 'Webhook'),
          el('span', { class: 'm-row__sub truncate' }, hook.url || ''),
          el('span', { class: 'm-row__sub' }, 'The signing secret is ' + maskSecret() + ' - it cannot be read again.')),
        el('span', { class: 'm-row__actions' },
          el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            'aria-label': 'Replace the secret of ' + (hook.name || 'the webhook'),
            onClick: async () => {
              const sure = await confirm({
                title: 'Replace the secret?',
                text: 'The old secret stops working at once.',
                confirmLabel: 'Replace the secret', danger: true,
              });
              if (!sure) return;
              try {
                const answer = await Api.rotateWebhookSecret(serverId, hook.id);
                status.say('The server answered: the secret was replaced.');
                if (answer && answer.secret) {
                  showSecret('The new webhook secret', answer.secret,
                    'This is the new secret, and the only time it can be shown.');
                }
                await load();
              } catch (error) { status.fail(error); }
            },
          }, 'Replace'),
          el('button', {
            class: 'm-btn m-btn--sm m-btn--danger', type: 'button',
            'aria-label': 'Delete the webhook ' + (hook.name || ''),
            onClick: async () => {
              const sure = await confirm({
                title: 'Delete this webhook?',
                text: 'It stops being called, and its secret goes with it.',
                confirmLabel: 'Delete', danger: true,
              });
              if (!sure) return;
              try {
                await Api.deleteWebhook(serverId, hook.id);
                status.say('The server answered: the webhook was deleted.');
                await load();
              } catch (error) { status.fail(error); }
            },
          }, 'Delete'))));
    }

    const appRows = el('div', { class: 'm-list' });
    if (!apps.length) {
      appRows.appendChild(empty({
        icon: 'bot', title: 'No applications',
        text: 'An application posts as itself and answers commands.',
      }));
    }
    for (const app of apps) {
      appRows.appendChild(el('div', { class: 'm-row' },
        el('span', { class: 'm-row__lead' }, icon('bot', { size: 17 })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' }, app.name || 'Application'),
          el('span', { class: 'm-row__sub truncate' }, app.description || ''),
          el('span', { class: 'm-row__sub' }, 'The token is ' + maskSecret() + ' - it cannot be read again.')),
        el('span', { class: 'm-row__actions' },
          el('button', {
            class: 'm-btn m-btn--sm m-btn--ghost', type: 'button',
            'aria-label': 'The commands of ' + (app.name || 'the application'),
            onClick: () => appCommands(serverId, app, status),
          }, 'Commands'),
          el('button', {
            class: 'm-btn m-btn--sm m-btn--danger', type: 'button',
            'aria-label': 'Remove the application ' + (app.name || ''),
            onClick: async () => {
              const sure = await confirm({
                title: 'Remove this application?',
                text: 'It stops posting, and its token goes with it.',
                confirmLabel: 'Remove', danger: true,
              });
              if (!sure) return;
              try {
                await communityApi.deleteApp(serverId, app.id);
                status.say('The server answered: the application was removed.');
                await load();
              } catch (error) { status.fail(error); }
            },
          }, 'Remove'))));
    }

    const newHook = el('button', {
      class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
      onClick: () => webhookSheet(serverId, load),
    }, 'New webhook');
    const newApp = el('button', {
      class: 'm-btn m-btn--sm m-btn--primary', type: 'button',
      onClick: () => appSheet(serverId, load),
    }, 'New application');

    replaceChildren(host, 
      status.node,
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' },
          el('div', { class: 'm-section__title' }, 'Webhooks'), newHook),
        hookRows),
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' },
          el('div', { class: 'm-section__title' }, 'Applications'), newApp),
        appRows),
    );
  };

  return { node: host, load };
}

// The sheet that makes a webhook. The secret is shown once, afterwards.
function webhookSheet(serverId, reload) {
  const name = el('input', { class: 'm-input', type: 'text', 'aria-label': 'The name of the webhook' });
  const url = el('input', { class: 'm-input', type: 'url', 'aria-label': 'The address the webhook posts to' });
  const problem = el('p', { class: 'm-form-error' });
  const create = el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button' }, 'Create');
  const layer = sheet({
    title: 'New webhook',
    body: el('div', { class: 'm-stack' },
      field('Name', name),
      field('Address', url, 'It has to be an https address.'),
      problem,
      create),
  });
  create.addEventListener('click', async () => {
    create.disabled = true;
    try {
      const answer = await Api.createWebhook(serverId, { name: name.value.trim(), url: url.value.trim() });
      layer.close();
      reload();
      const created = answer && answer.webhook ? answer.webhook : answer;
      if (created && created.secret) {
        showSecret('The webhook secret', created.secret,
          'This webhook signs what it sends. This is the only time the secret can be shown.');
      }
    } catch (error) {
      problem.textContent = (error && error.message) ? error.message : 'That did not work.';
      create.disabled = false;
    }
  });
}

// The sheet that makes an application. The token is shown once, afterwards.
function appSheet(serverId, reload) {
  const name = el('input', { class: 'm-input', type: 'text', 'aria-label': 'The name of the application' });
  const description = el('input', { class: 'm-input', type: 'text', 'aria-label': 'What the application does' });
  const problem = el('p', { class: 'm-form-error' });
  const create = el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button' }, 'Create');
  const layer = sheet({
    title: 'New application',
    body: el('div', { class: 'm-stack' },
      field('Name', name),
      field('What it does', description),
      problem,
      create),
  });
  create.addEventListener('click', async () => {
    create.disabled = true;
    try {
      const answer = await communityApi.createApp(serverId, {
        name: name.value.trim(),
        description: description.value.trim(),
      });
      layer.close();
      reload();
      const created = answer && answer.app ? answer.app : answer;
      if (created && created.token) {
        showSecret('The application token', created.token,
          'This token is what the application posts with. This is the only time it can be shown.');
      }
    } catch (error) {
      problem.textContent = (error && error.message) ? error.message : 'That did not work.';
      create.disabled = false;
    }
  });
}

// The commands one application answers.
async function appCommands(serverId, app, status) {
  const body = el('div', { class: 'm-stack' });
  const layer = sheet({ title: 'The commands of ' + (app.name || 'the application'), body });
  const paint = async () => {
    replaceChildren(body, loading('Reading the commands'));
    try {
      const answer = await communityApi.appCommands(serverId, app.id);
      const commands = (answer && answer.commands) || [];
      const rows = el('div', { class: 'm-list' });
      if (!commands.length) {
        rows.appendChild(empty({
          icon: 'slash', title: 'It answers nothing yet',
          text: 'A command is a word the application answers with a message.',
        }));
      }
      for (const command of commands) {
        rows.appendChild(el('div', { class: 'm-row' },
          el('span', { class: 'm-row__body' },
            el('span', { class: 'm-row__title' }, '/' + command.name),
            el('span', { class: 'm-row__sub' }, command.description || command.response)),
          el('span', { class: 'm-row__actions' },
            el('button', {
              class: 'm-btn m-btn--sm m-btn--danger', type: 'button',
              'aria-label': 'Remove the command /' + command.name,
              onClick: async () => {
                const sure = await confirm({
                  title: 'Remove /' + command.name + '?',
                  text: 'The application stops answering it.',
                  confirmLabel: 'Remove', danger: true,
                });
                if (!sure) return;
                try {
                  await communityApi.deleteAppCommand(serverId, app.id, command.id);
                  await paint();
                } catch (error) { status.fail(error); }
              },
            }, 'Remove'))));
      }
      replaceChildren(body, rows);
    } catch (error) {
      replaceChildren(body, failure(error, null));
    }
  };
  await paint();
}

// -- ownership -----------------------------------------------------------------------

function ownershipSection(serverId) {
  const host = el('div', { class: 'm-stack' });
  const status = reporter();

  const load = async () => {
    replaceChildren(host, loading('Reading the roster'));
    const pick = el('select', { class: 'm-input m-input--select', 'aria-label': 'Who takes over' });
    const transfer = el('button', { class: 'm-btn m-btn--block m-btn--primary', type: 'button' }, 'Transfer ownership');
    try {
      const page = await refreshServerMembers(serverId);
      for (const member of (page && page.items) || []) {
        if (String(member.id) === String((State.user || {}).id)) continue;
        pick.appendChild(el('option', { value: member.id }, memberName(member)));
      }
    } catch (error) {
      replaceChildren(host, failure(error, load));
      return;
    }
    transfer.addEventListener('click', async () => {
      if (!pick.value) return;
      const sure = await confirm({
        title: 'Transfer ownership?',
        text: 'After this, everything an owner can do, another person can do. It is final.',
        confirmLabel: 'Transfer', danger: true,
      });
      if (!sure) return;
      try {
        await Api.transferServer(serverId, pick.value);
        status.say('The server answered: the community was handed over.');
      } catch (error) { status.fail(error); }
    });
    const remove = el('button', { class: 'm-btn m-btn--block m-btn--danger', type: 'button' }, 'Delete the community');
    remove.addEventListener('click', async () => {
      const sure = await confirm({
        title: 'Delete this community?',
        text: 'The conversations, the members, the settings. It does not come back.',
        confirmLabel: 'Delete community', danger: true,
      });
      if (!sure) return;
      try {
        await Api.deleteServer(serverId);
        navigate('/home');
      } catch (error) { status.fail(error); }
    });

    replaceChildren(host, 
      status.node,
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'Hand it over')),
        el('div', { class: 'm-stack' }, field('Who takes over', pick), el('div', { class: 'm-actions' }, transfer))),
      el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'End it')),
        el('div', { class: 'm-stack' },
          el('p', { class: 'm-section__note' }, 'Everything here goes - channels, messages, roles. It is not reversible.'),
          el('div', { class: 'm-actions' }, remove))),
    );
  };

  return { node: host, load };
}

// -- analytics -----------------------------------------------------------------------

function analyticsSection(serverId) {
  const host = el('div', { class: 'm-stack' });

  const load = async () => {
    replaceChildren(host, loading('Reading the numbers'));
    try {
      const report = await Api.analytics(serverId);
      const totals = (report && (report.totals || report)) || {};
      const labels = {
        messages: 'messages sent',
        members: 'people around',
        joined: 'joined',
        left: 'left',
        reactions: 'reactions given',
        threads: 'threads started',
      };
      const rows = el('div', { class: 'm-stat-row' });
      let any = false;
      for (const [fieldName, value] of Object.entries(totals).slice(0, 6)) {
        any = true;
        rows.appendChild(el('div', { class: 'm-stat' },
          el('div', { class: 'm-stat__value' }, String(value === undefined || value === null ? '—' : value)),
          el('div', { class: 'm-stat__label' }, labels[fieldName] || fieldName)));
      }
      replaceChildren(host, el('section', { class: 'm-section' },
        el('div', { class: 'm-section__head' }, el('div', { class: 'm-section__title' }, 'Facts')),
        any ? rows : empty({ icon: 'chart', title: 'No numbers yet', text: 'Activity shows up once there is any.' })));
    } catch (error) {
      replaceChildren(host, failure(error, load));
    }
  };

  return { node: host, load };
}

// -- the console -----------------------------------------------------------------------

// The sections the phone offers, and the section that is open.
function builders(serverId) {
  return {
    overview: () => overviewSection(serverId),
    appearance: () => appearanceSection(serverId),
    channels: () => channelsSection(serverId),
    categories: () => categoriesSection(serverId),
    members: () => ({ node: renderMembersPage({ serverId }).node, load: null }),
    roles: () => rolesSection(serverId),
    invites: () => ({ node: renderInvitesPage({ serverId }).node, load: null }),
    moderation: () => moderationSection(serverId),
    rules: () => rulesSection(serverId),
    voice: () => voiceSection(serverId),
    onboarding: () => onboardingSection(serverId),
    ownership: () => ownershipSection(serverId),
    analytics: () => analyticsSection(serverId),
    integrations: () => integrationsSection(serverId),
  };
}

// The sections the phone's console is made of, in the order it shows them.
export function communitySettingsSections() {
  return COMMUNITY_SECTIONS.map((section) => section.id);
}

export function renderCommunitySettings(ctx) {
  const serverId = ctx.serverId;
  const community = serverById(serverId) || {};
  if (!can(serverId, 'MANAGE_SERVER') && !isOwner(serverId)) {
    return {
      head: { lead: 'back', title: 'Community settings' },
      node: screen(empty({
        icon: 'shield', title: 'Not your call',
        text: 'Only administrators can change this community.',
      })),
    };
  }

  const wanted = ctx.query ? (ctx.query.get('section') || 'overview') : 'overview';
  const table = builders(serverId);
  const active = table[wanted] ? wanted : 'overview';
  const host = el('div', { class: 'm-stack' });
  const strip = el('div', { class: 'm-seg m-seg--scroll', role: 'tablist', 'aria-label': 'Community settings' });

  const node = screen(
    el('div', { class: 'm-hero m-hero--quiet' },
      el('h1', { class: 'm-hero__title' }, community.name || 'Community'),
      el('div', { class: 'm-hero__sub' }, 'Settings')),
    strip, host);

  let current = null;

  const show = async (id) => {
    // A section with unsaved changes is left only after the reader is asked.
    if (current && current.isDirty && current.isDirty()) {
      const sure = await confirm({
        title: 'Leave with unsaved changes?',
        text: 'What you have typed here has not been saved. Leaving now loses it.',
        confirmLabel: 'Leave anyway', danger: true,
      });
      if (!sure) return;
    }
    for (const button of strip.children) {
      const isActive = button.getAttribute('data-section') === id;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
    if (current && current.cleanup) current.cleanup();
    replaceChildren(host, loading('Loading the section'));
    const section = table[id]();
    current = section;
    replaceChildren(host, section.node);
    if (section.load) await section.load();
  };

  for (const section of COMMUNITY_SECTIONS) {
    if (!table[section.id]) continue;
    strip.appendChild(el('button', {
      class: 'm-seg__item' + (section.id === active ? ' is-active' : ''),
      type: 'button', role: 'tab', 'aria-selected': section.id === active ? 'true' : 'false',
      dataset: { section: section.id },
      onClick: () => { show(section.id); },
    }, section.label));
  }

  return {
    node,
    head: { lead: 'back', title: 'Community settings' },
    onMount: () => show(active),
  };
}

export default { renderCommunitySettings, communitySettingsSections };
