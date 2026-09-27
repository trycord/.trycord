// Presentation grouping for the role permission editor.
//
// This is deliberately NOT a second permission system. The authority for which
// permissions exist is the backend: `GET /roles/permissions` returns `all`
// (the keys) and `descriptions` (their text), and every key in `all` must
// appear here or fall into "Other". Adding a permission server-side therefore
// makes it show up automatically instead of silently vanishing from the editor.
//
// What lives here is only the order and the section headings, which is a UI
// decision, not an authorization one.

const GROUPS = [
  {
    key: 'general',
    title: 'General',
    blurb: 'Community-wide administration.',
    perms: ['MANAGE_SERVER', 'MANAGE_INVITES'],
  },
  {
    key: 'channels',
    title: 'Channels',
    blurb: 'Structure and content in text channels.',
    perms: ['MANAGE_CHANNELS', 'SEND_MESSAGES', 'MANAGE_MESSAGES'],
  },
  {
    key: 'members',
    title: 'Members',
    blurb: 'Acting on other people in the community.',
    perms: ['KICK_MEMBERS', 'BAN_MEMBERS'],
  },
  {
    key: 'roles',
    title: 'Roles',
    blurb: 'Who may hand out authority.',
    perms: ['MANAGE_ROLES'],
  },
];

// Split the backend's permission list into display groups. Unknown keys are
// collected into a trailing group rather than dropped.
export function groupPermissions(allPerms, descriptions) {
  const known = new Set();
  const groups = [];
  for (const g of GROUPS) {
    const items = g.perms
      .filter((p) => allPerms.includes(p))
      .map((p) => ({ key: p, description: (descriptions && descriptions[p]) || '' }));
    for (const it of items) known.add(it.key);
    if (items.length) groups.push({ key: g.key, title: g.title, blurb: g.blurb, items });
  }
  const rest = allPerms
    .filter((p) => !known.has(p))
    .map((p) => ({ key: p, description: (descriptions && descriptions[p]) || '' }));
  if (rest.length) {
    groups.push({ key: 'other', title: 'Other', blurb: 'Additional permissions from this server.', items: rest });
  }
  return groups;
}

// "SEND_MESSAGES" -> "Send messages". Used for compact display next to a role
// name; the full sentence from `descriptions` is the accessible title.
export function humanizePerm(key) {
  const words = String(key || '').toLowerCase().split('_').filter(Boolean);
  if (!words.length) return '';
  const first = words[0];
  const sentence = first.charAt(0).toUpperCase() + first.slice(1) + ' ' + words.slice(1).join(' ');
  return sentence;
}

export default { groupPermissions, humanizePerm };
