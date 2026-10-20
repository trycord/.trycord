// Community onboarding.
//
// What a community says to somebody who has just arrived: the rules, the
// channels worth looking at, and a few questions whose answers decide what
// the member is shown.
//
// **The rule that matters.** An answer may assign a role, and a role is
// authority. So the roles an answer may assign are checked twice: once when
// the question is written, so the picker only offers what is eligible, and
// again when the answer is recorded, because a role that was ordinary when
// the question was set up may be the owner's role by the time somebody
// answers it.
//
// The check is the same one the interactive role screen makes:
//
//   - the role must not be the community's owner role;
//   - the role must not carry a permission the person granting it does not
//     hold, and a role with the wildcard permission is refused outright;
//   - the role must not be a role that grants a permission the community
//     treats as administrative.
//
// An answer that would do any of those is refused, and the refusal says
// which role and which permission - so the person who set the question up
// can see what to change.

'use strict';

const db = require('../../db');
const { now, uuid } = require('../../util');
const { fail, required, optionalInstant } = require('../workspace/common');
const roles = require('../roles');
const permissions = require('../permissions');

const MAX_TITLE = 200;
const MAX_BODY = 4000;
const MAX_RULES = 20;
const MAX_RULE_TEXT = 500;
const MAX_QUESTIONS = 20;
const MAX_OPTIONS = 15;
const MAX_OPTION_LABEL = 200;
const MAX_CHANNELS = 50;

// The permissions an onboarding answer may never hand out.
//
// An onboarding answer is given by a member, and it is given once, at the
// moment of joining. A permission that administers the community - who may
// remove people, who may change the settings, who may hand out other
// permissions - is not something a join form may give.
const NEVER_ASSIGNED = [
  'MANAGE_SERVER',
  'MANAGE_CHANNELS',
  'MANAGE_ROLES',
  'MANAGE_MESSAGES',
  'ADMINISTRATOR',
  'OWNER',
];

// ---- reading and writing the configuration --------------------------------

function parseList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function shapeConfiguration(row, questions) {
  if (!row) {
    return {
      enabled: false,
      welcomeTitle: null,
      welcomeBody: null,
      rules: [],
      defaultChannels: [],
      required: false,
      questions: [],
    };
  }
  return {
    enabled: !!row.enabled,
    welcomeTitle: row.welcome_title || null,
    welcomeBody: row.welcome_body || null,
    rules: parseList(row.rules),
    defaultChannels: parseList(row.default_channels),
    required: !!row.required,
    questions: questions || [],
  };
}

function shapeQuestion(row) {
  return {
    id: row.id,
    position: Number(row.position || 0),
    text: row.text,
    kind: row.kind === 'multiple' ? 'multiple' : 'single',
    required: !!row.required,
    options: parseList(row.options).map((option) => ({
      id: String(option.id || ''),
      label: String(option.label || ''),
      roleIds: Array.isArray(option.roleIds) ? option.roleIds.map(String) : [],
      channelIds: Array.isArray(option.channelIds) ? option.channelIds.map(String) : [],
    })),
  };
}

async function questionsOf(serverId) {
  const rows = await db.all(
    'SELECT * FROM community_onboarding_questions WHERE server_id = ? ORDER BY position ASC, id ASC',
    [serverId],
  );
  return rows.map(shapeQuestion);
}

async function configuration(serverId) {
  const row = await db.get(
    'SELECT * FROM community_onboarding WHERE server_id = ?',
    [serverId],
  );
  return shapeConfiguration(row, await questionsOf(serverId));
}

/**
 * Whether a role may be handed out by an onboarding answer.
 *
 * The three reasons, in the order they are checked:
 *
 *   - it is the community's owner role, which is not a thing an answer may
 *     give to anybody, least of all to the person who wrote the question;
 *   - it carries a permission that administers the community, which an
 *     answer may never hand out;
 *   - it carries a permission the person setting the question up does not
 *     hold themselves, which is the rule the role screen makes.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function roleIsEligible(serverId, roleId, actorId) {
  const role = await db.get(
    'SELECT * FROM roles WHERE id = ? AND server_id = ?',
    [roleId, serverId],
  );
  if (!role) return { ok: false, reason: 'that role is not in this community' };

  // The owner role is the community's owner. Nothing an answer does may hand
  // it out.
  const owner = await db.get('SELECT owner_id FROM servers WHERE id = ?', [serverId]);
  if (owner && String(role.id) === String(owner.owner_id)) {
    return { ok: false, reason: 'the owner role may not be given by an onboarding answer' };
  }
  if (role.owner === 1 || role.owner === true) {
    return { ok: false, reason: 'the owner role may not be given by an onboarding answer' };
  }

  let held = [];
  try { held = JSON.parse(role.permissions || '[]'); } catch { held = []; }
  if (!Array.isArray(held)) held = [];
  for (const permission of held) {
    if (permission === '*') {
      return { ok: false, reason: 'a role with every permission may not be given by an onboarding answer' };
    }
    if (NEVER_ASSIGNED.indexOf(permission) !== -1) {
      return { ok: false, reason: 'the role may not be given by an onboarding answer, because it carries '
        + permission };
    }
  }

  // The person setting the question up must hold the permission themselves.
  if (actorId) {
    const actorHolds = await permissions.hasPermission(actorId, serverId, '*').catch(() => false);
    if (!actorHolds) {
      for (const permission of held) {
        const has = await permissions.hasPermission(actorId, serverId, permission).catch(() => false);
        if (!has) {
          return { ok: false, reason: 'the role may not be given by an onboarding answer, because it '
            + 'carries ' + permission + ' and nobody who sets the questions up holds it' };
        }
      }
    }
  }

  return { ok: true };
}

/**
 * The roles of a community an onboarding answer may hand out.
 *
 * Every role that is not administrative and that the person setting the
 * questions up holds the permissions of. It is what the picker offers, so
 * the picker cannot offer something the answer would refuse.
 */
async function eligibleRoles(serverId, actorId) {
  const rows = await db.all(
    'SELECT * FROM roles WHERE server_id = ? ORDER BY position ASC, id ASC',
    [serverId],
  );
  const out = [];
  for (const row of rows) {
    const eligible = await roleIsEligible(serverId, row.id, actorId);
    if (!eligible.ok) continue;
    out.push({ id: row.id, name: row.name, color: row.color || null });
  }
  return out;
}

/**
 * Save the configuration.
 *
 * The questions are replaced wholesale, because a question's options carry
 * what an answer may do, and editing one in place would leave an answer
 * recorded against options that no longer mean what they meant.
 */
async function save(serverId, actorId, input) {
  const body = input || {};

  const enabled = body.enabled === true;
  const welcomeTitle = body.welcomeTitle === undefined || body.welcomeTitle === null
    ? null : required(body.welcomeTitle, MAX_TITLE, 'welcomeTitle');
  const welcomeBody = body.welcomeBody === undefined || body.welcomeBody === null
    ? null : String(body.welcomeBody).slice(0, MAX_BODY);
  const required_ = body.required === true;

  const rules = [];
  const rawRules = Array.isArray(body.rules) ? body.rules : [];
  if (rawRules.length > MAX_RULES) fail('VALIDATION_ERROR', 'a community may have at most ' + MAX_RULES + ' rules');
  for (const rule of rawRules) {
    const text = typeof rule === 'string' ? rule : (rule && rule.text);
    const line = required(text, MAX_RULE_TEXT, 'a rule');
    rules.push({ id: String((rule && rule.id) || uuid()), text: line });
  }

  const defaultChannels = [];
  const rawChannels = Array.isArray(body.defaultChannels) ? body.defaultChannels : [];
  if (rawChannels.length > MAX_CHANNELS) {
    fail('VALIDATION_ERROR', 'a community may point at at most ' + MAX_CHANNELS + ' channels');
  }
  for (const channelId of rawChannels) {
    const id = String(channelId || '').trim();
    if (!id) continue;
    const channel = await db.get(
      'SELECT id FROM channels WHERE id = ? AND server_id = ?',
      [id, serverId],
    );
    if (!channel) fail('NOT_FOUND', 'that channel is not in this community');
    if (!defaultChannels.includes(id)) defaultChannels.push(id);
  }

  // The questions, and the roles and channels their answers may reach.
  const questions = [];
  const rawQuestions = Array.isArray(body.questions) ? body.questions : [];
  if (rawQuestions.length > MAX_QUESTIONS) {
    fail('VALIDATION_ERROR', 'a community may ask at most ' + MAX_QUESTIONS + ' questions');
  }
  for (const [index, question] of rawQuestions.entries()) {
    const text = required(question && question.text, 500, 'a question');
    const kind = question.kind === 'multiple' ? 'multiple' : 'single';
    const options = [];
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    if (rawOptions.length > MAX_OPTIONS) {
      fail('VALIDATION_ERROR', 'a question may have at most ' + MAX_OPTIONS + ' options');
    }
    for (const option of rawOptions) {
      const label = required(option && option.label, MAX_OPTION_LABEL, 'an option');
      const roleIds = [];
      for (const roleId of (Array.isArray(option.roleIds) ? option.roleIds : [])) {
        const id = String(roleId || '').trim();
        if (!id) continue;
        const eligible = await roleIsEligible(serverId, id, actorId);
        if (!eligible.ok) {
          fail('VALIDATION_ERROR', 'that role may not be given by an onboarding answer: '
            + eligible.reason);
        }
        if (!roleIds.includes(id)) roleIds.push(id);
      }
      const channelIds = [];
      for (const channelId of (Array.isArray(option.channelIds) ? option.channelIds : [])) {
        const id = String(channelId || '').trim();
        if (!id) continue;
        const channel = await db.get(
          'SELECT id FROM channels WHERE id = ? AND server_id = ?',
          [id, serverId],
        );
        if (!channel) fail('NOT_FOUND', 'that channel is not in this community');
        if (!channelIds.includes(id)) channelIds.push(id);
      }
      options.push({
        id: String((option && option.id) || uuid()),
        label,
        roleIds,
        channelIds,
      });
    }
    questions.push({
      id: String((question && question.id) || uuid()),
      position: index,
      text,
      kind,
      required: question && question.required === true,
      options,
    });
  }

  const ts = now();
  await db.transaction(async (t) => {
    await t.run(
      'INSERT INTO community_onboarding'
      + ' (id, server_id, enabled, welcome_title, welcome_body, rules, default_channels, required,'
      + ' created_at, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      + ' ON CONFLICT (server_id) DO UPDATE SET enabled = ?, welcome_title = ?, welcome_body = ?,'
      + ' rules = ?, default_channels = ?, required = ?, updated_at = ?',
      [
        uuid(), serverId, enabled ? 1 : 0, welcomeTitle, welcomeBody,
        JSON.stringify(rules), JSON.stringify(defaultChannels), required_ ? 1 : 0, ts, ts,
        enabled ? 1 : 0, welcomeTitle, welcomeBody,
        JSON.stringify(rules), JSON.stringify(defaultChannels), required_ ? 1 : 0, ts,
      ],
    );
    // The questions are replaced, because an answer recorded against an
    // option that no longer exists would be an answer to nothing.
    await t.run('DELETE FROM community_onboarding_questions WHERE server_id = ?', [serverId]);
    for (const question of questions) {
      await t.run(
        'INSERT INTO community_onboarding_questions'
        + ' (id, server_id, position, text, kind, required, options, created_at, updated_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          question.id, serverId, question.position, question.text, question.kind,
          question.required ? 1 : 0, JSON.stringify(question.options), ts, ts,
        ],
      );
    }
  });

  return configuration(serverId);
}

// ---- the member's side -----------------------------------------------------

/**
 * What a member is shown when they arrive.
 *
 * The welcome, the rules, the channels, and the questions - with the
 * questions' options reduced to what they may actually do. A member is told
 * which channels an answer would reveal and which roles it would give, so
 * the choice is not a blind one.
 */
async function preview(serverId, userId) {
  const config = await configuration(serverId);
  const answered = await answersOf(serverId, userId);
  const answeredIds = new Set(answered.map((entry) => entry.questionId));

  const questions = config.questions.map((question) => ({
    id: question.id,
    position: question.position,
    text: question.text,
    kind: question.kind,
    required: question.required,
    answered: answeredIds.has(question.id),
    options: question.options.map((option) => ({
      id: option.id,
      label: option.label,
      // The roles and the channels are named, not granted: the reader is
      // choosing, and an answer that was refused by the server must not
      // look as though it would work.
      grantsRoles: option.roleIds.length,
      revealsChannels: option.channelIds.length,
    })),
  }));

  return {
    enabled: config.enabled,
    welcomeTitle: config.welcomeTitle,
    welcomeBody: config.welcomeBody,
    rules: config.rules,
    defaultChannels: config.defaultChannels,
    required: config.required,
    questions,
    // Whether the member still has something to answer.
    outstanding: questions.filter((question) => question.required && !question.answered).length,
  };
}

function shapeAnswer(row) {
  return {
    id: row.id,
    questionId: row.question_id,
    optionIds: parseList(row.option_ids),
    answeredAt: row.answered_at,
  };
}

async function answersOf(serverId, userId) {
  const rows = await db.all(
    'SELECT * FROM community_onboarding_answers WHERE server_id = ? AND user_id = ? ORDER BY answered_at ASC',
    [serverId, userId],
  );
  return rows.map(shapeAnswer);
}

/**
 * Record the member's answers, and act on them.
 *
 * The roles an answer gives are checked again here, one more time, against
 * the roles as they are now. The picker offered what was eligible when the
 * question was written; the world may have moved since.
 */
async function answer(serverId, userId, input) {
  const config = await configuration(serverId);
  if (!config.enabled) fail('CONFLICT', 'this community has no onboarding');

  const answers = Array.isArray(input && input.answers) ? input.answers : [];
  if (!answers.length) fail('VALIDATION_ERROR', 'there is nothing to answer');

  const byId = new Map(config.questions.map((question) => [question.id, question]));
  const ts = now();

  // What the answers would do, worked out before anything is written.
  const roleIds = new Set();
  const channelIds = new Set();
  const records = [];

  for (const entry of answers) {
    const question = byId.get(String(entry && entry.questionId));
    if (!question) fail('NOT_FOUND', 'that question is not one of this community');
    const chosen = (Array.isArray(entry.optionIds) ? entry.optionIds : []).map(String);
    if (question.kind === 'single' && chosen.length > 1) {
      fail('VALIDATION_ERROR', 'that question takes one answer');
    }
    const options = question.options.filter((option) => chosen.indexOf(option.id) !== -1);
    if (chosen.length && !options.length) {
      fail('VALIDATION_ERROR', 'that is not one of the options');
    }
    if (question.required && !options.length) {
      fail('VALIDATION_ERROR', 'that question has to be answered');
    }
    for (const option of options) {
      for (const roleId of option.roleIds) roleIds.add(roleId);
      for (const channelId of option.channelIds) channelIds.add(channelId);
    }
    records.push({ questionId: question.id, optionIds: chosen });
  }

  // The roles are checked again, now, against the roles as they are.
  const granted = [];
  for (const roleId of roleIds) {
    const eligible = await roleIsEligible(serverId, roleId, null);
    if (!eligible.ok) {
      fail('PERMISSION_DENIED', 'that role may not be given by an onboarding answer: '
        + eligible.reason);
    }
    granted.push(roleId);
  }

  await db.transaction(async (t) => {
    for (const record of records) {
      await t.run(
        'INSERT INTO community_onboarding_answers'
        + ' (id, server_id, user_id, question_id, option_ids, answered_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?)'
        + ' ON CONFLICT (user_id, question_id) DO UPDATE SET option_ids = ?, answered_at = ?',
        [
          uuid(), serverId, userId, record.questionId,
          JSON.stringify(record.optionIds), ts,
          JSON.stringify(record.optionIds), ts,
        ],
      );
    }
  });

  // The roles are given, and the channels the answers reveal are recorded as
  // the member's default channels so the community can point them at them.
  const given = [];
  for (const roleId of granted) {
    await roles.assign(serverId, userId, roleId);
    given.push(roleId);
  }

  return {
    answers: await answersOf(serverId, userId),
    rolesGranted: given,
    channelsRevealed: Array.from(channelIds),
  };
}

/**
 * The member's own answers, and the channels their answers revealed.
 *
 * A member who wants to change their mind later uses this: the answers are
 * theirs, and they are the only ones who may change them.
 */
async function mine(serverId, userId) {
  const config = await configuration(serverId);
  const answers = await answersOf(serverId, userId);
  const channelIds = new Set(config.defaultChannels);
  for (const answer of answers) {
    const question = config.questions.find((entry) => entry.id === answer.questionId);
    if (!question) continue;
    for (const option of question.options) {
      if (answer.optionIds.indexOf(option.id) === -1) continue;
      for (const channelId of option.channelIds) channelIds.add(channelId);
    }
  }
  return {
    configuration: config,
    answers,
    channels: Array.from(channelIds),
  };
}

module.exports = {
  configuration, save, preview, answer, mine, eligibleRoles, roleIsEligible,
  NEVER_ASSIGNED, MAX_QUESTIONS, MAX_OPTIONS,
};
