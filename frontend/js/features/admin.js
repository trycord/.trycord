// The instance administration.
//
// Twelve addresses, one dispatcher, three small modules behind it: the people
// and the moderation queue in adminSurfaces.js, the instance infrastrucure in
// adminInfra.js, and the configuration console - with the mail panel - in
// adminCfg.js. The registry binds once; the pages stay readable. Around every
// page the dispatcher draws the studio rail, so the twelve doors are visible
// from all of them.

import {
  adminOverview, adminPeople, adminCommunities, adminReports, adminAppeals,
  adminAudit, adminGdpr, adminApprovals,
} from './adminSurfaces.js';
import {
  adminAnnouncements, adminDatabase, adminContinuum, adminDiagnostics,
} from './adminInfra.js';
import { adminPageEditor } from './adminPages.js';
import { adminConfiguration } from './adminCfg.js';
import { adminIncidents } from './adminIncidents.js';
import { adminFederation } from './adminFederation.js';
import { adminVoice } from './voice.js';
import { adminFrame } from './adminFrame.js';
import { el } from '../../packages/dom.js';

const LAYOUTS = new Map([
  ['admin', () => adminOverview()],
  ['admin.users', () => adminPeople()],
  ['admin.approvals', () => adminApprovals()],
  ['admin.communities', () => adminCommunities()],
  ['admin.reports', () => adminReports()],
  ['admin.appeals', () => adminAppeals()],
  ['admin.audit', () => adminAudit()],
  ['admin.gdpr', () => adminGdpr()],
  ['admin.announcements', () => adminAnnouncements()],
  ['admin.pages', () => adminPageEditor()],
  ['admin.settings', () => adminConfiguration()],
  ['admin.database', () => adminDatabase()],
  ['admin.continuum', () => adminContinuum()],
  ['admin.voice', () => adminVoice()],
  ['admin.diagnostics', () => adminDiagnostics()],
  ['admin.incidents', () => adminIncidents()],
  ['admin.federation', () => adminFederation()],
]);

// The console frames every page in the administration shell - the masthead,
// the grouped doors with their live counts, and the page inside. The pages
// keep their own lifecycle ({ node, onMount, cleanup }); the frame hosts
// them without swallowing it.
export function renderAdmin(ctx) {
  const view = LAYOUTS.get(ctx.page.id);
  if (!view) return null;
  const page = view();
  const node = page && page.node ? page.node : page;
  const frame = adminFrame(ctx.page.id);
  frame.stage.appendChild(node);
  if (page && page.node) {
    return { node: frame.root, onMount: page.onMount, cleanup: page.cleanup };
  }
  return frame.root;
}

export default { renderAdmin };
