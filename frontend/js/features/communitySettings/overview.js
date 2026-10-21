// The overview of a community.
//
// Everything the community is to the outside: what it is called, who may
// read it, whether other instances are told about it, what a newcomer is
// greeted with, and the rules the community has agreed to.
//
// The settings are read back before they are shown. That is the whole point
// of this section: a box that cannot be read is a box that is written blind,
// and an operator who writes the rules again without seeing them has
// replaced them with whatever they remember.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { head, card, fold, hold, fault, memo } from '../../ui/page.js';
import { fieldRow, switchControl, serverMark, bannerNode } from '../../ui/primitives.js';
import { copyText } from '../../ui/clipboard.js';
import { refreshServer } from '../../../packages/store.js';
import {
  createFormState, readDocument, communityApi,
} from '../../../packages/communitySettings.js';
import { reporter } from './parts.js';

export function overviewSection(ctx) {
  const serverId = ctx.serverId;
  const host = el('div', { class: 'fold' });
  const dirtyHost = el('div', {});
  const form = createFormState({});

  // What has been typed, and what the server holds. The two are compared
  // field by field, so a section knows whether it is dirty and which fields
  // are the dirty ones.
  const refreshDirty = () => {
    const fields = form.dirtyFields();
    dirtyHost.replaceChildren(...(fields.length ? [memo({
      tone: 'warning',
      title: 'Unsaved changes',
      text: 'Not saved yet: ' + fields.join(', ') + '. Leaving this section asks first.',
    })] : []));
  };

  // The settings the server holds. When they cannot be read, the fields that
  // would overwrite them are closed: the operator is told what failed, and
  // nothing is offered that would replace rules nobody was shown.
  const readCommunity = async () => {
    host.replaceChildren(hold('Reading the community settings'));
    let community = null;
    try {
      community = await Api.server(serverId);
    } catch (error) {
      host.replaceChildren(fold([fault(error, readCommunity)]));
      return;
    }
    let settings = null;
    let settingsProblem = null;
    try {
      settings = await communityApi.readSettings(serverId);
    } catch (error) {
      settingsProblem = error;
    }
    paint(community, settings, settingsProblem);
  };

  const paint = (community, settings, settingsProblem) => {
    const federated = community.federated !== false;

    // -- identity ------------------------------------------------------------
    const name = el('input', {
      class: 'input', type: 'text', value: community.name || '',
      'aria-label': 'Community name',
    });
    const description = el('input', {
      class: 'input', type: 'text', value: community.description || '',
      'aria-label': 'What the community is about',
      placeholder: 'One sentence on what this place is for',
    });
    name.addEventListener('input', () => { form.set('name', name.value); refreshDirty(); });
    description.addEventListener('input', () => { form.set('description', description.value); refreshDirty(); });
    form.load({ name: community.name || '', description: community.description || '' });

    const identityReport = reporter();
    const saveIdentity = async () => {
      const body = {};
      if (form.changed('name')) body.name = name.value.trim();
      if (form.changed('description')) body.description = description.value.trim();
      if (!Object.keys(body).length) {
        identityReport.ok('Nothing changed, so nothing was written.');
        return;
      }
      try {
        await Api.updateServer(serverId, body);
        form.commit(['name', 'description']);
        refreshDirty();
        identityReport.ok('The identity was saved.');
        await refreshServer(serverId).catch(() => {});
      } catch (error) {
        // What was typed stays in the boxes: the operator can try again
        // without writing it all out a second time.
        identityReport.fail(error);
      }
    };

    // -- the pictures ---------------------------------------------------------
    //
    // The face of the community and its cover. They are uploaded on their
    // own rather than written with the name and the description, because
    // they are images: choosing one replaces it at once, and the words
    // beside them are saved when the operator says so.
    const iconPick = el('input', {
      type: 'file', class: 'visually-hidden', tabindex: '-1', accept: 'image/*',
      'aria-label': 'Choose a picture for this community',
    });
    const bannerPick = el('input', {
      type: 'file', class: 'visually-hidden', tabindex: '-1', accept: 'image/*',
      'aria-label': 'Choose a cover image for this community',
    });
    const picturesReport = reporter();
    iconPick.addEventListener('change', () => { uploadPicture('icon', iconPick); });
    bannerPick.addEventListener('change', () => { uploadPicture('banner', bannerPick); });

    const uploadPicture = async (kind, input) => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        await Api.setServerImage(serverId, kind, file);
        picturesReport.ok(kind === 'banner'
          ? 'The cover image was uploaded.'
          : 'The picture was uploaded.');
        await refreshServer(serverId).catch(() => {});
      } catch (error) {
        picturesReport.fail(error);
      } finally {
        // The same file can be chosen again after a change.
        input.value = '';
      }
    };
    const removePicture = async (kind) => {
      try {
        await Api.removeServerImage(serverId, kind);
        picturesReport.ok(kind === 'banner'
          ? 'The cover image was removed.'
          : 'The picture was removed.');
        await refreshServer(serverId).catch(() => {});
      } catch (error) {
        picturesReport.fail(error);
      }
    };

    const iconUrl = community.icon_url || community.iconUrl || '';
    const bannerUrl = community.banner_url || community.bannerUrl || '';
    const pictureRow = (label, description, preview, kind, input, hasPicture) => fieldRow(
      label, description,
      el('span', { class: 'rowtools' },
        preview,
        el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Upload ' + (kind === 'banner' ? 'a cover image' : 'a picture'),
          onClick: () => input.click(),
        }, icon('upload', { size: 14 }), 'Upload'),
        hasPicture ? el('button', {
          class: 'btn btn--ghost btn--sm', type: 'button',
          'aria-label': 'Remove the ' + (kind === 'banner' ? 'cover image' : 'picture'),
          onClick: () => removePicture(kind),
        }, 'Remove') : null,
        input),
    );

    // -- reach ---------------------------------------------------------------
    const publicToggle = switchControl(!!community.is_public, (on) => {
      form.set('isPublic', on); refreshDirty();
    }, 'Public');
    const discoverToggle = switchControl(!!community.is_discoverable, (on) => {
      form.set('isDiscoverable', on); refreshDirty();
    }, 'Discoverable');
    const federatedToggle = switchControl(federated, (on) => {
      form.set('federated', on); refreshDirty();
    }, 'Federated with other instances');
    form.load({
      isPublic: !!community.is_public,
      isDiscoverable: !!community.is_discoverable,
      federated,
    });

    const reachReport = reporter();
    const saveReach = async () => {
      const body = {};
      if (form.changed('isPublic')) body.isPublic = form.value('isPublic');
      if (form.changed('isDiscoverable')) body.isDiscoverable = form.value('isDiscoverable');
      if (form.changed('federated')) body.federated = form.value('federated');
      if (!Object.keys(body).length) {
        reachReport.ok('Nothing changed, so nothing was written.');
        return;
      }
      try {
        await Api.updateServer(serverId, body);
        form.commit(['isPublic', 'isDiscoverable', 'federated']);
        refreshDirty();
        const said = [];
        if (body.isPublic !== undefined) said.push(body.isPublic ? 'The community is public.' : 'The community is private.');
        if (body.isDiscoverable !== undefined) said.push(body.isDiscoverable ? 'It is listed on Discover.' : 'It is off Discover.');
        if (body.federated !== undefined) {
          said.push(body.federated
            ? 'Other instances are told about this community again.'
            : 'This community is not listed to other instances, and nothing is relayed from it.');
        }
        reachReport.ok(said.join(' '));
        await refreshServer(serverId).catch(() => {});
      } catch (error) {
        reachReport.fail(error);
      }
    };

    // -- the way in ----------------------------------------------------------
    const joinCode = el('div', { class: 'joincode' }, community.join_code || 'not set');

    // -- onboarding ----------------------------------------------------------
    const welcome = el('textarea', {
      class: 'input', rows: '4',
      'aria-label': 'The message a newcomer is greeted with',
      placeholder: 'What somebody reads when they arrive',
    });
    const settingsText = settings || {};
    const welcomeOn = switchControl(!!settingsText.welcomeEnabled, (on) => {
      form.set('welcomeEnabled', on); refreshDirty();
    }, 'Show the welcome message');
    welcome.value = settingsText.welcomeContent || '';
    form.load({
      welcomeContent: settingsText.welcomeContent || '',
      welcomeEnabled: !!settingsText.welcomeEnabled,
    });
    welcome.addEventListener('input', () => { form.set('welcomeContent', welcome.value); refreshDirty(); });

    const welcomeReport = reporter();
    const saveWelcome = async () => {
      const body = {};
      if (form.changed('welcomeContent')) body.welcome_content = welcome.value;
      if (form.changed('welcomeEnabled')) body.welcome_enabled = form.value('welcomeEnabled');
      if (!Object.keys(body).length) {
        welcomeReport.ok('Nothing changed, so nothing was written.');
        return;
      }
      try {
        await Api.updateServerSettings(serverId, body);
        form.commit(['welcomeContent', 'welcomeEnabled']);
        refreshDirty();
        welcomeReport.ok('The welcome was saved.');
      } catch (error) {
        welcomeReport.fail(error);
      }
    };

    // -- the guidelines ------------------------------------------------------
    const guidelines = el('textarea', {
      class: 'input', rows: '8',
      'aria-label': 'The rules of this community',
      placeholder: 'The rules people agree to here',
    });
    guidelines.value = settingsText.guidelines || '';
    form.load({ guidelines: settingsText.guidelines || '' });
    guidelines.addEventListener('input', () => { form.set('guidelines', guidelines.value); refreshDirty(); });

    const guidelinesReport = reporter();
    const saveGuidelines = async () => {
      // The guard: an unchanged box is never written. The rules of a
      // community are not something to replace with an empty copy because
      // nobody happened to type in them.
      if (!form.changed('guidelines')) {
        guidelinesReport.ok('The guidelines are unchanged, so nothing was written.');
        return;
      }
      try {
        await Api.updateServerSettings(serverId, { guidelines: guidelines.value });
        form.commit(['guidelines']);
        refreshDirty();
        guidelinesReport.ok('The guidelines were saved.');
      } catch (error) {
        guidelinesReport.fail(error);
      }
    };

    // -- the defaults --------------------------------------------------------
    const notifications = el('textarea', {
      class: 'input mono', rows: '4',
      'aria-label': 'The notification defaults of this community',
      placeholder: '{ }',
    });
    const interactions = el('textarea', {
      class: 'input mono', rows: '4',
      'aria-label': 'The interaction settings of this community',
      placeholder: '{ }',
    });
    const notificationDocument = readDocument(settingsText.notificationDefaults);
    const interactionDocument = readDocument(settingsText.interactionSettings);
    notifications.value = notificationDocument.text;
    interactions.value = interactionDocument.text;
    form.load({
      notificationDefaults: notificationDocument.text,
      interactionSettings: interactionDocument.text,
    });
    notifications.addEventListener('input', () => {
      form.set('notificationDefaults', notifications.value); refreshDirty();
    });
    interactions.addEventListener('input', () => {
      form.set('interactionSettings', interactions.value); refreshDirty();
    });

    // A document that does not parse is shown exactly as it is stored, and
    // the reader is told why. It is never dropped and never replaced: the
    // way out of it is to write a document that does parse.
    const documentNote = (document) => (document.ok ? null : memo({
      tone: 'warning',
      title: 'This document is not valid JSON',
      text: document.reason + ' It is shown exactly as it is stored; edit it here to replace it.',
    }));

    const defaultsReport = reporter();
    const saveDefaults = async () => {
      const body = {};
      if (form.changed('notificationDefaults')) body.notification_defaults = notifications.value;
      if (form.changed('interactionSettings')) body.interaction_settings = interactions.value;
      if (!Object.keys(body).length) {
        defaultsReport.ok('Nothing changed, so nothing was written.');
        return;
      }
      try {
        await Api.updateServerSettings(serverId, body);
        form.commit(['notificationDefaults', 'interactionSettings']);
        refreshDirty();
        defaultsReport.ok('The defaults were saved.');
      } catch (error) {
        defaultsReport.fail(error);
      }
    };

    // The settings could not be read. The fields that would write over them
    // are closed, and the reason is said out loud.
    const unreadable = () => (settingsProblem ? memo({
      tone: 'danger',
      title: 'The settings could not be read',
      text: (settingsProblem && settingsProblem.message ? settingsProblem.message : 'The server did not answer.')
        + ' The welcome, the guidelines and the defaults are closed until they can be read: writing over rules nobody was shown is not a thing this console will do.',
    }) : null);
    if (settingsProblem) {
      for (const control of [welcome, welcomeOn, guidelines, notifications, interactions]) {
        control.setAttribute('disabled', '');
      }
    }

    host.replaceChildren(fold([
      dirtyHost,
      card({
        label: 'Identity', glyph: 'grid',
        body: fold([
          fieldRow('Name', 'What the community calls itself.', name),
          fieldRow('Description', 'One sentence on what this place is for.', description),
          el('button', {
            class: 'btn btn--primary btn--sm', type: 'button', onClick: saveIdentity,
          }, 'Save identity'),
          identityReport.node,
          // The cover as it stands now, drawn wide, because that is how it
          // is seen everywhere else.
          bannerUrl ? bannerNode(bannerUrl, 'settings-banner') : null,
          pictureRow('Picture',
            'The face of the community. It is drawn wherever the community is named.',
            serverMark(community, { size: 'md' }), 'icon', iconPick, !!iconUrl),
          pictureRow('Cover',
            'A wide image above the community, on its profile and on the pages that show it.',
            el('span', { class: 'settings-note' },
              bannerUrl ? 'A cover image is set.' : 'No cover image yet.'),
            'banner', bannerPick, !!bannerUrl),
          picturesReport.node,
        ]),
      }),
      card({
        label: 'Reach', glyph: 'compass',
        body: fold([
          fieldRow('Public', 'Anyone with the address can read it.', publicToggle),
          fieldRow('Discoverable', 'Listed on Discover.', discoverToggle),
          fieldRow('Federated',
            'Other instances are told about this community and relay it. Turning this off means the community is not listed to other instances, and nothing is relayed from it.',
            federatedToggle),
          el('button', {
            class: 'btn btn--primary btn--sm', type: 'button', onClick: saveReach,
          }, 'Save reach'),
          reachReport.node,
        ]),
      }),
      card({
        label: 'The way in', glyph: 'key',
        body: fold([
          fieldRow('Join code', 'The code that lets somebody in without an invite.', el('span', { class: 'rowtools' },
            joinCode,
            el('button', {
              class: 'btn btn--ghost btn--sm', type: 'button',
              'aria-label': 'Copy the join code',
              onClick: () => copyText(community.join_code || '', 'The join code was copied.'),
            }, icon('copy', { size: 14 }), 'Copy'))),
        ]),
      }),
      card({
        label: 'Onboarding', glyph: 'mail',
        body: fold([
          unreadable(),
          fieldRow('Welcome message', 'What somebody reads when they arrive.', welcome),
          fieldRow('Show the welcome', 'The welcome is shown to newcomers.', welcomeOn),
          el('button', {
            class: 'btn btn--primary btn--sm', type: 'button', onClick: saveWelcome,
          }, 'Save welcome'),
          welcomeReport.node,
        ]),
      }),
      card({
        label: 'Guidelines', glyph: 'book',
        body: fold([
          unreadable(),
          guidelines,
          el('button', {
            class: 'btn btn--primary btn--sm', type: 'button', onClick: saveGuidelines,
          }, 'Save guidelines'),
          guidelinesReport.node,
        ]),
      }),
      card({
        label: 'Defaults', glyph: 'cog',
        body: fold([
          unreadable(),
          el('p', { class: 'lede' },
            'The instance keeps these two as they are written. A document it cannot read is kept as it is, and is shown as it is.'),
          fieldRow('Notification defaults', 'What the community notifies about by default.', notifications),
          fieldRow('Interaction settings', 'How the community behaves for the people in it.', interactions),
          documentNote(notificationDocument),
          documentNote(interactionDocument),
          el('button', {
            class: 'btn btn--primary btn--sm', type: 'button', onClick: saveDefaults,
          }, 'Save defaults'),
          defaultsReport.node,
        ]),
      }),
    ]));
    refreshDirty();
  };

  return {
    node: fold([
      head({
        kicker: 'Community',
        title: 'Overview',
        lede: 'The face and the welcome of this place.',
        actions: null,
      }),
      host,
    ]),
    onMount: readCommunity,
    isDirty: () => form.isDirty(),
  };
}

export default { overviewSection };
