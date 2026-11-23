// The social surface, end to end.
//
// This is the workflow the V10 directive names: a profile answers only when
// the pair is allowed to see it, a friendship moves through request,
// acceptance, notification and removal, a direct conversation carries names,
// roles, invitations, pins and search, and a notification is one row the
// reader can filter, read, dismiss and clear.
//
// The assertions are deliberately about the whole path rather than one route.
// A profile that is private in the client but readable from the API is not
// private; a group role that is drawn but not enforced is decoration; a
// notification preference that suppresses the row but still counts it in the
// badge is a setting that does nothing.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

function details(res) {
  return JSON.stringify(res.data);
}

async function befriend(from, to) {
  const sent = await from.post('/api/friends/requests', { userId: to.user.id });
  assert.equal(sent.status, 200, 'the request was refused: ' + details(sent));
  if (sent.data.autoAccepted) return null;
  assert.ok(sent.data.id, 'a pending request is named');
  const accepted = await to.post('/api/friends/requests/' + sent.data.id + '/accept');
  assert.equal(accepted.status, 200, 'the request could not be accepted: ' + details(accepted));
  return sent.data.id;
}

async function notificationList(client, query) {
  const res = await client.get('/api/notifications' + (query || ''));
  assert.equal(res.status, 200, 'notifications could not be read: ' + details(res));
  return res.data;
}

test('the social surface', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const ada = await registerUser(instance, 'ada');
  const bob = await registerUser(instance, 'bob');
  const grace = await registerUser(instance, 'grace');
  const dave = await registerUser(instance, 'dave');

  let communityId = null;
  let groupId = null;

  await t.test('a profile reveals a person, and only to the people allowed', async () => {
    // Ada and Grace both know Bob but not each other yet: the mutual friend
    // the profile should name.
    await befriend(ada, bob);
    await befriend(grace, bob);

    const community = await ada.post('/api/servers', { name: 'Common Ground' });
    assert.equal(community.status, 200, details(community));
    communityId = community.data.serverId;
    const invite = await ada.post('/api/servers/' + communityId + '/invites', { maxUses: 5 });
    assert.ok(invite.status < 400, details(invite));
    const joined = await grace.post('/api/invites/' + invite.data.code + '/join', {});
    assert.ok(joined.status < 400, details(joined));

    const profile = await ada.get('/api/users/' + grace.user.id);
    assert.equal(profile.status, 200, details(profile));
    assert.equal(profile.data.relation, 'none');
    assert.equal(profile.data.mutualFriendCount, 1);
    assert.equal(profile.data.mutualFriends[0].id, bob.user.id);
    assert.ok(
      profile.data.sharedCommunities.some((entry) => entry.id === communityId),
      'the community both readers belong to is part of the profile'
    );

    // The account's own chosen state is visible to the account, and only a
    // state the presence policy allows is visible to anybody else.
    const chosen = await ada.patch('/api/users/me/presence', { status: 'idle' });
    assert.equal(chosen.status, 200, details(chosen));
    assert.equal(chosen.data.status, 'idle');
    const self = await ada.get('/api/users/me');
    assert.equal(self.data.presenceStatus, 'idle');
    const invalid = await ada.patch('/api/users/me/presence', { status: 'sleeping' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error.code, 'VALIDATION_ERROR');

    // Friends-only is enforced on the route, not only by a hidden button.
    const friendsOnly = await grace.patch('/api/me/privacy', { profileVisibility: 'friends' });
    assert.equal(friendsOnly.status, 200, details(friendsOnly));
    const hidden = await ada.get('/api/users/' + grace.user.id);
    assert.equal(hidden.status, 403);
    assert.equal(hidden.data.error.code, 'PROFILE_PRIVATE');
    const selfStillOpen = await grace.get('/api/users/' + grace.user.id);
    assert.equal(selfStillOpen.status, 200, details(selfStillOpen));

    // Becoming friends is the fact that changes the answer.
    await befriend(ada, grace);
    const visible = await ada.get('/api/users/' + grace.user.id);
    assert.equal(visible.status, 200, details(visible));
    assert.equal(visible.data.relation, 'friend');
    assert.equal(visible.data.mutualFriendCount, 1);

    // 'anyone' is the same answer as the default. This is also the regression
    // guard for the default vocabulary: a saved 'anyone' must not behave like
    // 'friends' merely because the first row wrote one spelling and the check
    // remembered another.
    const anyone = await grace.patch('/api/me/privacy', { profileVisibility: 'anyone' });
    assert.equal(anyone.status, 200, details(anyone));
    const strangerView = await dave.get('/api/users/' + grace.user.id);
    assert.equal(strangerView.status, 200, details(strangerView));

    const nobody = await grace.patch('/api/me/privacy', { profileVisibility: 'nobody' });
    assert.equal(nobody.status, 200, details(nobody));
    const closed = await dave.get('/api/users/' + grace.user.id);
    assert.equal(closed.status, 403);
    assert.equal(closed.data.error.code, 'PROFILE_PRIVATE');

    const reopened = await grace.patch('/api/me/privacy', {
      profileVisibility: 'anyone', presence: 'nobody',
    });
    assert.equal(reopened.status, 200, details(reopened));
    const withoutPresence = await dave.get('/api/users/' + grace.user.id);
    assert.equal(withoutPresence.status, 200, details(withoutPresence));
    assert.equal(withoutPresence.data.presence, null, 'a hidden presence is absent, not "offline"');

    // A block wins over any visibility setting, and removes the friendship it
    // found rather than leaving one alive behind it.
    const blocked = await grace.post('/api/me/blocks', { userId: ada.user.id });
    assert.equal(blocked.status, 200, details(blocked));
    const blockedProfile = await ada.get('/api/users/' + grace.user.id);
    assert.equal(blockedProfile.status, 403);
    assert.equal(blockedProfile.data.error.code, 'PROFILE_PRIVATE');
    const dms = await ada.post('/api/dms', { userId: grace.user.id });
    assert.equal(dms.status, 403);
    assert.equal(dms.data.error.code, 'BLOCKED');
    const blockList = await grace.get('/api/me/blocks');
    assert.ok(blockList.data.some((entry) => entry.id === ada.user.id));

    const unblocked = await grace.delete('/api/me/blocks/' + ada.user.id);
    assert.equal(unblocked.status, 200, details(unblocked));
    const openAgain = await ada.get('/api/users/' + grace.user.id);
    assert.equal(openAgain.status, 200, details(openAgain));
    assert.equal(openAgain.data.relation, 'none', 'a block ended the friendship');
    assert.equal(openAgain.data.blockedByViewer, false);
  });

  await t.test('a friendship is a lifecycle and a notification is a durable row', async () => {
    // A preference suppresses the row entirely: the button says "do not tell
    // me", and a row that still arrives in the list or the badge contradicts
    // the answer.
    const mute = await dave.patch('/api/me/notification-prefs', { friend: false });
    assert.equal(mute.status, 200, details(mute));
    assert.equal(mute.data.effective.friend, false);

    const first = await ada.post('/api/friends/requests', { userId: dave.user.id });
    assert.equal(first.status, 200, details(first));
    const muted = await notificationList(dave);
    assert.equal(
      muted.items.filter((entry) => entry.category === 'friend').length,
      0,
      'a muted category must not persist a row'
    );

    const cancelled = await ada.delete('/api/friends/requests/' + first.data.id);
    assert.equal(cancelled.status, 200, details(cancelled));

    const unmute = await dave.patch('/api/me/notification-prefs', { friend: true });
    assert.equal(unmute.status, 200, details(unmute));

    const second = await ada.post('/api/friends/requests', { userId: dave.user.id });
    assert.equal(second.status, 200, details(second));
    const requestRow = await notificationList(dave, '?category=friend');
    const requestNotification = requestRow.items.find((entry) => entry.type === 'friend_request');
    assert.ok(requestNotification, 'the friend request was not delivered');
    assert.equal(requestNotification.actor.id, ada.user.id);
    assert.ok(requestRow.items.every((entry) => entry.category === 'friend'));
    assert.equal(requestRow.category, 'friend');
    assert.ok(requestRow.unreadByCategory.friend >= 1);

    const accepted = await dave.post('/api/friends/requests/' + second.data.id + '/accept');
    assert.equal(accepted.status, 200, details(accepted));
    const adaRows = await notificationList(ada, '?category=friend');
    assert.ok(
      adaRows.items.some((entry) => entry.type === 'friend_accepted'),
      'the accepter is told the request was accepted'
    );

    // Read is per row; unread is a whole-account count. Dismissal removes the
    // row rather than hiding it in the client until the next refresh.
    const read = await dave.post('/api/notifications/' + requestNotification.id + '/read');
    assert.equal(read.status, 200, details(read));
    const afterRead = await notificationList(dave);
    assert.ok(
      afterRead.items.find((entry) => entry.id === requestNotification.id).readAt,
      'the row keeps its read timestamp'
    );
    const removed = await dave.delete('/api/notifications/' + requestNotification.id);
    assert.equal(removed.status, 200, details(removed));
    const afterRemove = await notificationList(dave);
    assert.ok(!afterRemove.items.some((entry) => entry.id === requestNotification.id));

    // A second request for an existing friendship is refused, not duplicated.
    const again = await ada.post('/api/friends/requests', { userId: dave.user.id });
    assert.equal(again.status, 409);
    assert.equal(again.data.error.code, 'CONFLICT');

    const removedFriend = await dave.delete('/api/friends/' + ada.user.id);
    assert.equal(removedFriend.status, 200, details(removedFriend));
    const noLonger = await ada.get('/api/users/' + dave.user.id);
    assert.equal(noLonger.data.relation, 'none');
  });

  await t.test('a group has a name, roles, invitations, pins and a search', async () => {
    const created = await ada.post('/api/dms/groups', {
      name: 'Weekend Plans',
      userIds: [bob.user.id, grace.user.id],
    });
    assert.equal(created.status, 201, details(created));
    groupId = created.data.id;
    assert.equal(created.data.isGroup, true);
    assert.equal(created.data.myRole, 'owner');
    assert.equal(created.data.memberCount, 3);
    assert.equal(created.data.name, 'Weekend Plans');

    // A group is shown by what its members can see, and its roles are on the
    // people in it rather than inferred from who created it.
    const detail = await bob.get('/api/dms/' + groupId);
    assert.equal(detail.status, 200, details(detail));
    assert.equal(detail.data.ownerId, ada.user.id);
    assert.equal(detail.data.myRole, 'member');
    assert.equal(detail.data.people.length, 3);
    assert.equal(detail.data.permissions.canRename, false);

    const message = await bob.post('/api/dms/' + groupId + '/messages', { content: 'pinned world' });
    assert.equal(message.status, 200, details(message));

    // Any member may keep a message at hand; the pin carries who kept it.
    const pinned = await grace.post('/api/dms/' + groupId + '/pins', { messageId: message.data.id });
    assert.equal(pinned.status, 200, details(pinned));
    const pins = await ada.get('/api/dms/' + groupId + '/pins');
    assert.equal(pins.status, 200, details(pins));
    assert.equal(pins.data.length, 1);
    assert.equal(pins.data[0].content, 'pinned world');
    const search = await ada.get('/api/dms/' + groupId + '/messages/search?q=pinned');
    assert.equal(search.status, 200, details(search));
    assert.ok(search.data.some((entry) => entry.id === message.data.id));
    const unpinned = await ada.delete('/api/dms/' + groupId + '/pins/' + message.data.id);
    assert.equal(unpinned.status, 200, details(unpinned));

    // A member cannot rename; an admin can. The route and the service agree.
    const memberRename = await bob.patch('/api/dms/' + groupId, { name: 'Not Mine' });
    assert.equal(memberRename.status, 403);
    assert.equal(memberRename.data.error.code, 'PERMISSION_DENIED');
    const promoted = await ada.patch('/api/dms/' + groupId + '/members/' + bob.user.id, { role: 'admin' });
    assert.equal(promoted.status, 200, details(promoted));
    assert.equal(promoted.data.role, 'admin');
    const renamed = await bob.patch('/api/dms/' + groupId, { name: 'Weekend, Renamed' });
    assert.equal(renamed.status, 200, details(renamed));
    assert.equal(renamed.data.name, 'Weekend, Renamed');

    // Invitation is a question: declining ends the wait, inviting again
    // revives the same conversation's question, and accepting joins.
    const invited = await grace.post('/api/dms/' + groupId + '/invites', { userId: dave.user.id });
    assert.equal(invited.status, 201, details(invited));
    const invitations = await dave.get('/api/dms/invites');
    assert.equal(invitations.status, 200, details(invitations));
    const waiting = invitations.data.find((entry) => entry.id === invited.data.id);
    assert.ok(waiting, 'the invitation is waiting for the invited person');
    assert.equal(waiting.displayName, 'Weekend, Renamed');
    const declined = await dave.post('/api/dms/invites/' + invited.data.id + '/decline');
    assert.equal(declined.status, 200, details(declined));
    const declinedList = await dave.get('/api/dms/invites');
    assert.ok(!declinedList.data.some((entry) => entry.id === invited.data.id));

    const reInvited = await grace.post('/api/dms/' + groupId + '/invites', { userId: dave.user.id });
    assert.equal(reInvited.status, 201, details(reInvited));
    const joined = await dave.post('/api/dms/invites/' + reInvited.data.id + '/accept');
    assert.equal(joined.status, 200, details(joined));
    assert.equal(joined.data.conversation.people.length, 4);
    const joinedDetail = await dave.get('/api/dms/' + groupId);
    assert.equal(joinedDetail.status, 200, details(joinedDetail));

    // The invitation is a notification category of its own, delivered with
    // the group name resolved for the reader.
    const groupRows = await notificationList(dave, '?category=group');
    assert.ok(groupRows.items.some((entry) => entry.type === 'group_invite'));

    const removed = await bob.delete('/api/dms/' + groupId + '/members/' + grace.user.id);
    assert.equal(removed.status, 200, details(removed));
    const afterRemoval = await grace.get('/api/dms/' + groupId);
    assert.equal(afterRemoval.status, 403);
    assert.equal(afterRemoval.data.error.code, 'NOT_A_MEMBER');

    // Ownership is transferred, not guessed at; the old owner becomes an
    // admin and may leave, while the new owner may not walk away from a group
    // that still has people in it.
    const transferred = await ada.post('/api/dms/' + groupId + '/transfer', { userId: bob.user.id });
    assert.equal(transferred.status, 200, details(transferred));
    assert.equal(transferred.data.ownerId, bob.user.id);
    const afterTransfer = await ada.get('/api/dms/' + groupId);
    assert.equal(afterTransfer.data.myRole, 'admin');
    assert.equal(afterTransfer.data.ownerId, bob.user.id);

    const ownerLeaves = await bob.delete('/api/dms/' + groupId + '/members');
    assert.equal(ownerLeaves.status, 400);
    assert.equal(ownerLeaves.data.error.code, 'OWNER_CANNOT_LEAVE');
    const adminLeaves = await ada.delete('/api/dms/' + groupId + '/members');
    assert.equal(adminLeaves.status, 200, details(adminLeaves));

    // Two people are the floor. Neither the other member nor the owner may
    // reduce the conversation to one voice.
    const removeLastOther = await bob.delete('/api/dms/' + groupId + '/members/' + dave.user.id);
    assert.equal(removeLastOther.status, 400);
    assert.equal(removeLastOther.data.error.code, 'VALIDATION_ERROR');
    const leaveLastOther = await dave.delete('/api/dms/' + groupId + '/members');
    assert.equal(leaveLastOther.status, 400);
    assert.equal(leaveLastOther.data.error.code, 'VALIDATION_ERROR');
  });

  await t.test('the notification list can be read, filtered and cleared', async () => {
    // A category filter narrows the rows without shrinking the whole-account
    // badge; the rows are the only things that disappear.
    const all = await notificationList(dave);
    assert.ok(all.items.length > 0, 'the workflow produced notifications');
    const before = all.unreadCount;
    const group = await notificationList(dave, '?category=group');
    assert.ok(group.items.length > 0);
    assert.ok(group.items.every((entry) => entry.category === 'group'));
    assert.equal(group.unreadCount, before, 'a filter does not shrink the badge');

    const unknown = await dave.get('/api/notifications?category=not-a-category');
    assert.equal(unknown.status, 400);
    assert.equal(unknown.data.error.code, 'VALIDATION_ERROR');

    const readAll = await dave.post('/api/notifications/read-all');
    assert.equal(readAll.status, 200, details(readAll));
    const clearedRead = await dave.delete('/api/notifications?read=true');
    assert.equal(clearedRead.status, 200, details(clearedRead));
    assert.equal(clearedRead.data.remaining, 0);
    const empty = await notificationList(dave);
    assert.equal(empty.unreadCount, 0);
    assert.equal(empty.items.length, 0);
  });

  await t.test('a one-to-one conversation is created once', async () => {
    const first = await bob.post('/api/dms', { userId: ada.user.id });
    assert.equal(first.status, 200, details(first));
    assert.equal(first.data.created, true);
    const second = await bob.post('/api/dms', { userId: ada.user.id });
    assert.equal(second.status, 200, details(second));
    assert.equal(second.data.created, false);
    assert.equal(second.data.id, first.data.id);
    const opened = await ada.get('/api/dms/' + first.data.id);
    assert.equal(opened.status, 200, details(opened));
    assert.equal(opened.data.peer.id, bob.user.id);
    assert.equal(opened.data.isGroup, false);
  });
});
