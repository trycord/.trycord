// Trust & Safety end-to-end acceptance against a running server (default
// http://localhost:9971). Covers the §97 matrix: ordinary users are blocked
// from admin surfaces; reports; warnings, suspensions and bans persist and
// take effect (sessions invalidated, sockets cut, login refused); appeals
// with an action id; server suspension/removal with owner/admin bypass and
// discovery suppression; the audit trail.
//
// Precondition: the server was booted with ADMIN_USERNAMES=tsadmin and the
// account `tsadmin` / `secret123` exists and is promoted (see README for the
// bootstrap flow — a missing admin fails fast with a clear message).
//
// Run: node scripts/test-trustsafety.js [baseUrl]
// Exit 0 = all assertions passed. Exit 1 = failures.
const API = (process.argv[2] || process.env.TRYCORD_TEST_URL || 'http://localhost:9971').replace(/\/+$/, '');
const WS_BASE = API.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
const WebSocket = require('ws');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' :: ' + extra : '')); }
}
async function J(method, p, body, tok) {
  const h = {};
  if (body !== null && body !== undefined) h['Content-Type'] = 'application/json';
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(API + p, { method, headers: h, body: body !== null && body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}
function wsOpen(token) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('ws connect timeout')); }, 8000);
    const ws = new WebSocket(WS_BASE + '/?ticket=' + token);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); reject(new Error('ws HTTP ' + res.statusCode)); });
  });
}
function wsClosed(ws, ms = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} resolve(null); }, ms);
    ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}
(async () => {
  const legal = (await J('GET', '/api/legal')).json;
  async function mkuser(pfx) {
    const u = pfx + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    const r = await J('POST', '/api/auth/register', { username: u, password: 'secret123', termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion });
    if (r.status !== 200) throw new Error('register failed: ' + r.status + ' ' + JSON.stringify(r.json));
    const v = await J('POST', '/api/test/self-verify', null, r.json.token);
    if (v.status !== 200) throw new Error('self-verify failed — boot the server with ALLOW_TEST_HOOKS=true');
    return { name: u, token: r.json.token, id: r.json.user.id };
  }

  const adm = await J('POST', '/api/auth/login', { username: 'tsadmin', password: 'secret123' });
  if (adm.status !== 200) {
    console.log('tsadmin is not an admin or login failed (' + adm.status + '). Boot server with ADMIN_USERNAMES=tsadmin.');
    process.exit(1);
  }
  const A = await mkuser('tsA');   // server owner, later suspended then lifted
  const R = await mkuser('tsR');   // reporter
  const B = await mkuser('tsB');   // ban target
  const M = await mkuser('tsM');   // ordinary member used for negative checks

  // --- admin gate ---
  const ov = await J('GET', '/api/admin/overview', null, adm.json.token);
  ok('admin-overview-ok', ov.status === 200 && ov.json && typeof ov.json.users === 'number', 'status=' + ov.status);
  const nonAdmin = await J('GET', '/api/admin/overview', null, A.token);
  ok('ordinary-user-blocked-from-admin', nonAdmin.status === 403, 'status=' + nonAdmin.status);
  const anonAdmin = await J('GET', '/api/admin/overview', null, null);
  ok('anon-blocked-from-admin', anonAdmin.status === 401, 'status=' + anonAdmin.status);
  const unauthReq = await J('GET', '/api/admin/users', null, null);
  ok('anon-blocked-users', unauthReq.status === 401, 'status=' + unauthReq.status);

  // --- reports ---
  const rep = await J('POST', '/api/reports', { targetType: 'user', targetId: A.id, reason: 'repeated spam', description: 'detail' }, R.token);
  ok('report-created', rep.status === 201 && !!rep.json.id, 'status=' + rep.status);
  const repId = rep.json.id;
  const mineR = await J('GET', '/api/reports/mine', null, R.token);
  ok('reporter-sees-own', mineR.status === 200 && mineR.json.some((r) => r.id === repId));
  const mineA = await J('GET', '/api/reports/mine', null, A.token);
  ok('others-cannot-see', mineA.status === 200 && !mineA.json.some((r) => r.id === repId));
  const badReport = await J('POST', '/api/reports', { targetType: 'message' }, R.token);
  ok('report-requires-fields', badReport.status === 400, 'status=' + badReport.status);
  const adminReports = await J('GET', '/api/admin/reports', null, adm.json.token);
  ok('admin-sees-report', adminReports.status === 200 && adminReports.json.some((r) => r.id === repId && r.reporter_name === R.name));
  const investigating = await J('PATCH', '/api/admin/reports/' + repId, { status: 'INVESTIGATING' }, adm.json.token);
  ok('report-status-investigating', investigating.status === 200 && investigating.json.status === 'INVESTIGATING');
  const badStatus = await J('PATCH', '/api/admin/reports/' + repId, { status: 'NOPE' }, adm.json.token);
  ok('report-bad-status-rejected', badStatus.status === 400, 'status=' + badStatus.status);

  // --- warning (non-disruptive) ---
  const warn = await J('POST', '/api/admin/users/' + A.id + '/enforce', { actionType: 'WARNING', reason: 'first strike' }, adm.json.token);
  ok('warning-applied', warn.status === 200 && warn.json.type === 'WARNING', 'status=' + warn.status + ' ' + JSON.stringify(warn.json).slice(0, 120));
  const stillUsable = await J('GET', '/api/users/me', null, A.token);
  ok('warning-does-not-block-session', stillUsable.status === 200, 'status=' + stillUsable.status);
  const actionsA = await J('GET', '/api/admin/users/' + A.id + '/actions', null, adm.json.token);
  ok('user-action-history', actionsA.status === 200 && actionsA.json.some((a) => a.actionType === 'WARNING'));
  const badAction = await J('POST', '/api/admin/users/' + A.id + '/enforce', { actionType: 'WIPE', reason: 'x' }, adm.json.token);
  ok('invalid-action-type-rejected', badAction.status === 400, 'status=' + badAction.status);
  const noReason = await J('POST', '/api/admin/users/' + A.id + '/enforce', { actionType: 'WARNING' }, adm.json.token);
  ok('enforce-requires-reason', noReason.status === 400, 'status=' + noReason.status);

  // --- suspension: sessions + socket + login ---
  const susTicket = (await J('POST', '/api/auth/ws/ticket', {}, A.token)).json.ticket;
  ok('sus-ws-ticket', !!susTicket);
  const ws = await wsOpen(susTicket);
  ok('sus-ws-open-before', ws.readyState === WebSocket.OPEN);
  // Attach the close listener before enforcing: disconnectUser may close the
  // socket before the enforce response returns, and a close event fired
  // before the listener was attached would be lost.
  const closed = wsClosed(ws);
  const suspend = await J('POST', '/api/admin/users/' + A.id + '/enforce', { actionType: 'SUSPENSION', reason: 'continued spam', expiresInHours: 24 }, adm.json.token);
  ok('suspension-applied', suspend.status === 200 && suspend.json.type === 'SUSPENSION' && !!suspend.json.expiresAt, 'status=' + suspend.status + ' ' + JSON.stringify(suspend.json).slice(0, 120));
  const closeCode = await closed;
  ok('suspension-cuts-live-socket', closeCode === 1008, 'code=' + closeCode);
  const deadSession = await J('GET', '/api/users/me', null, A.token);
  ok('suspension-invalidates-session', deadSession.status === 401 || deadSession.status === 403,
    'status=' + deadSession.status + ' (401 session-revoked or 403 enforcement — token is unusable)');

  const susLogin = await J('POST', '/api/auth/login', { username: A.name, password: 'secret123' });
  ok('suspended-login-refused', susLogin.status === 403 &&
      susLogin.json.error.code === 'ACCOUNT_ENFORCED' &&
      susLogin.json.error.details.type === 'SUSPENSION' &&
      !!susLogin.json.error.details.actionId,
    'status=' + susLogin.status + ' ' + JSON.stringify(susLogin.json).slice(0, 160));
  const susActionId = susLogin.json.error.details.actionId;
  const freshTicket = await J('POST', '/api/auth/ws/ticket', {}, A.token);
  ok('no-ticket-for-suspended', freshTicket.status === 401 || freshTicket.status === 403, 'status=' + freshTicket.status);

  // --- appeal: approve lifts the suspension ---
  const ap = await J('POST', '/api/appeals', { actionId: susActionId, reason: 'I apologise and will stop' });
  ok('appeal-submitted', ap.status === 201 && !!ap.json.id, 'status=' + ap.status + ' ' + JSON.stringify(ap.json).slice(0, 120));
  const apId = ap.json.id;
  const dup = await J('POST', '/api/appeals', { actionId: susActionId, reason: 'duplicate' });
  ok('duplicate-appeal-blocked', dup.status === 400, 'status=' + dup.status);
  const adminAppeals = await J('GET', '/api/admin/appeals', null, adm.json.token);
  ok('admin-sees-appeal', adminAppeals.status === 200 && adminAppeals.json.some((a) => a.id === apId && a.action_type === 'SUSPENSION'));
  const deny = await J('PATCH', '/api/admin/appeals/' + apId, { decision: 'DENIED' }, adm.json.token);
  ok('appeal-denied', deny.status === 200 && deny.json.status === 'DENIED');
  const stillBanned = await J('POST', '/api/auth/login', { username: A.name, password: 'secret123' });
  ok('denied-appeal-keeps-enforcement', stillBanned.status === 403, 'status=' + stillBanned.status);
  const retryAppeal = await J('POST', '/api/appeals', { actionId: susActionId, reason: 'second chance, promise' });
  ok('re-appeal-allowed-after-deny', retryAppeal.status === 201, 'status=' + retryAppeal.status);
  const approve = await J('PATCH', '/api/admin/appeals/' + retryAppeal.json.id, { decision: 'APPROVED', note: 'granting one more chance' }, adm.json.token);
  ok('appeal-approved', approve.status === 200 && approve.json.status === 'APPROVED');
  const relogin = await J('POST', '/api/auth/login', { username: A.name, password: 'secret123' });
  ok('approved-appeal-restores-login', relogin.status === 200 && !!relogin.json.token, 'status=' + relogin.status);
  A.token = relogin.json.token; // old token stays revoked (sessions_invalidated_at) — correct model

  // --- ban: full lockout + denied appeal stays locked ---
  const ban = await J('POST', '/api/admin/users/' + B.id + '/enforce', { actionType: 'ACCOUNT_BAN', reason: 'egregious abuse', confirm: true }, adm.json.token);
  ok('ban-applied', ban.status === 200 && ban.json.type === 'ACCOUNT_BAN', 'status=' + ban.status + ' ' + JSON.stringify(ban.json).slice(0, 120));
  const banLogin = await J('POST', '/api/auth/login', { username: B.name, password: 'secret123' });
  ok('banned-login-refused', banLogin.status === 403 && banLogin.json.error.details.type === 'ACCOUNT_BAN' && !!banLogin.json.error.details.actionId);
  const banActionId = banLogin.json.error.details.actionId;
  const emptyAppeal = await J('POST', '/api/appeals', { reason: 'no actionId' });
  ok('appeal-requires-action', emptyAppeal.status === 400, 'status=' + emptyAppeal.status);
  const banAp = await J('POST', '/api/appeals', { actionId: banActionId, reason: 'please unban me' });
  ok('ban-appeal-submitted', banAp.status === 201 && !!banAp.json.id, 'status=' + banAp.status);
  const banDeny = await J('PATCH', '/api/admin/appeals/' + banAp.json.id, { decision: 'DENIED', note: 'reviewed and upheld' }, adm.json.token);
  ok('ban-appeal-denied', banDeny.status === 200 && banDeny.json.status === 'DENIED');
  const banLogin2 = await J('POST', '/api/auth/login', { username: B.name, password: 'secret123' });
  ok('banned-still-refused', banLogin2.status === 403, 'status=' + banLogin2.status);
  const banNoConfirm = await J('POST', '/api/admin/users/' + B.id + '/enforce', { actionType: 'ACCOUNT_BAN', reason: 'x' }, adm.json.token);
  ok('ban-requires-confirm', banNoConfirm.status === 400, 'status=' + banNoConfirm.status);

  // --- server suspension + owner/admin bypass + discovery + join gates ---
  const srv = await J('POST', '/api/servers', { name: 'ts-server', isPublic: true, isDiscoverable: true }, A.token);
  ok('ts-owner-creates-server', srv.status === 200 && !!srv.json.serverId, 'status=' + srv.status);
  const sid = srv.json.serverId, code = srv.json.joinCode;
  const joinR = await J('POST', '/api/servers/join/' + code, null, R.token);
  ok('ts-member-joins', joinR.status === 200, 'status=' + joinR.status);
  const suspSrv = await J('POST', '/api/admin/servers/' + sid + '/suspend', { reason: 'raid target', reportId: repId }, adm.json.token);
  ok('server-suspended', suspSrv.status === 200 && suspSrv.json.type === 'SERVER_SUSPENSION', 'status=' + suspSrv.status + ' ' + JSON.stringify(suspSrv.json).slice(0, 120));
  const memberDetail = await J('GET', '/api/servers/' + sid, null, R.token);
  ok('member-blocked-from-suspended', memberDetail.status === 403 && memberDetail.json.error.code === 'SERVER_SUSPENDED', 'status=' + memberDetail.status + ' ' + JSON.stringify(memberDetail.json).slice(0, 120));
  const adminList = await J('GET', '/api/admin/servers?q=ts-server', null, adm.json.token);
  ok('admin-can-inspect-suspended', adminList.status === 200 && adminList.json.some((s) => s.id === sid && s.enforcement_state === 'suspended'), 'status=' + adminList.status + ' ' + JSON.stringify(adminList.json).slice(0, 160));
  const ownerDetail = await J('GET', '/api/servers/' + sid, null, A.token);
  ok('owner-bypasses-server-suspend', ownerDetail.status === 200, 'status=' + ownerDetail.status);
  const disc = await J('GET', '/api/discover/servers?q=ts-server', null, R.token);
  ok('suspended-server-hidden-from-discover', disc.status === 200 && !disc.json.items.some((d) => d.id === sid));
  const joinBlocked = await J('POST', '/api/servers/join/' + code, null, M.token);
  ok('join-gated-while-suspended', joinBlocked.status === 403 && joinBlocked.json.error.code === 'SERVER_SUSPENDED', 'status=' + joinBlocked.status + ' ' + JSON.stringify(joinBlocked.json).slice(0, 120));
  const liftSrv = await J('POST', '/api/admin/servers/' + sid + '/lift', { reason: 'resolved' }, adm.json.token);
  ok('server-suspension-lifted', liftSrv.status === 200, 'status=' + liftSrv.status);
  const memberDetail2 = await J('GET', '/api/servers/' + sid, null, R.token);
  ok('member-access-restored', memberDetail2.status === 200, 'status=' + memberDetail2.status);
  const joinNow = await J('POST', '/api/servers/join/' + code, null, M.token);
  ok('join-restored', joinNow.status === 200, 'status=' + joinNow.status);

  // --- server removal ---
  const removeNoConfirm = await J('POST', '/api/admin/servers/' + sid + '/remove', { reason: 'duplicate' }, adm.json.token);
  ok('server-remove-requires-confirm', removeNoConfirm.status === 400, 'status=' + removeNoConfirm.status);
  const remove = await J('POST', '/api/admin/servers/' + sid + '/remove', { reason: 'duplicate community', confirm: true }, adm.json.token);
  ok('server-removed', remove.status === 200, 'status=' + remove.status);
  const gone = await J('GET', '/api/servers/' + sid, null, A.token);
  ok('removed-server-404', gone.status === 404, 'status=' + gone.status);

  // --- audit trail ---
  const auditSuspend = await J('GET', '/api/admin/audit?action=MODERATION_SUSPENSION', null, adm.json.token);
  ok('audit-suspension-recorded', auditSuspend.status === 200 && auditSuspend.json.length >= 1);
  const auditStrip = await J('GET', '/api/admin/audit?action=MODERATION_ACCOUNT_BAN', null, adm.json.token);
  ok('audit-ban-recorded', auditStrip.status === 200 && auditStrip.json.length >= 1);
  const auditLift = await J('GET', '/api/admin/audit?action=ENFORCEMENT_LIFTED', null, adm.json.token);
  ok('audit-lift-recorded', auditLift.status === 200 && auditLift.json.length >= 1);
  const auditReport = await J('GET', '/api/admin/audit?action=REPORT_CREATED', null, adm.json.token);
  ok('audit-report-recorded', auditReport.status === 200 && auditReport.json.some((a) => a.report_id === repId));
  const servingUserActions = await J('GET', '/api/admin/users/' + B.id + '/actions', null, adm.json.token);
  ok('banned-actions-history', servingUserActions.status === 200 && servingUserActions.json.some((a) => a.actionType === 'ACCOUNT_BAN'));

  console.log('trustsafety: pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TS_RUNTIME_ERROR', e && e.stack ? e.stack : e); process.exit(1); });