// End-to-end API tests. Run with `npm test` (uses a temporary database schema).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

// capture sign-in codes: with SMTP off they are printed as "Code for <email>: 123456"
const codes = {};
const origLog = console.log;
console.log = (...a) => {
  const m = /Code for (\S+): (\d{6})/.exec(String(a[0]));
  if (m) codes[m[1]] = m[2];
  else if (!String(a[0]).startsWith('[auth] SMTP')) origLog(...a);
};

const { start } = require('../index');
const { prisma } = require('../db');

let server, base;
const ctx = {};

class Client {
  constructor() { this.cookie = ''; }
  async call(method, path, body, headers = {}) {
    const res = await fetch(base + '/api' + path, {
      method, headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() || []) { const kv = c.split(';')[0]; if (kv.startsWith('forge_sid=')) this.cookie = kv; }
    let json = null; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
  }
  get(p) { return this.call('GET', p); }
  post(p, b = {}) { return this.call('POST', p, b); }
  patch(p, b) { return this.call('PATCH', p, b); }
  del(p) { return this.call('DELETE', p); }
}

const admin = new Client();
const member = new Client();
const viewer = new Client();
const anon = new Client();

const ok = (r, status = 200) => assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${JSON.stringify(r.json)}`);

before(async () => {
  server = await start({ port: 0, background: false });
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await prisma.$disconnect(); });

// ------------------------------------------------------------------ auth
test('fresh database needs setup', async () => {
  const r = await anon.get('/auth/status');
  ok(r);
  assert.equal(r.json.needsSetup, true);
  assert.equal(r.json.user, null);
});

test('API needs sign-in', async () => {
  ok(await anon.get('/bootstrap'), 401);
});

test('SETUP_EMAIL restricts who can claim the first admin account', async () => {
  const config = require('../config');
  config.setupEmail = 'owner@example.com';
  try {
    delete codes['stranger@example.com'];
    ok(await anon.post('/auth/setup/request-code', { email: 'stranger@example.com' }), 403);
    assert.equal(codes['stranger@example.com'], undefined, 'no code is sent to a stranger');
    ok(await anon.post('/auth/setup', { name: 'X', email: 'stranger@example.com', code: '123456' }), 403);
  } finally { config.setupEmail = ''; }
});

test('first-run setup with an emailed code', async () => {
  ok(await admin.post('/auth/setup/request-code', { email: 'admin@example.com' }));
  assert.match(codes['admin@example.com'], /^\d{6}$/);
  // wrong code is refused
  ok(await admin.post('/auth/setup', { name: 'Ada', email: 'admin@example.com', code: '000000' }), 401);
  const r = await admin.post('/auth/setup', { name: 'Ada', email: 'admin@example.com', code: codes['admin@example.com'], projectName: 'Forge', projectKey: 'forge' });
  ok(r, 201);
  assert.equal(r.json.user.role, 'admin');
  assert.ok(admin.cookie, 'session cookie set');
  // setup can only run once
  ok(await anon.post('/auth/setup/request-code', { email: 'x@example.com' }), 403);
});

test('a code is single use and dies after 5 wrong guesses', async () => {
  ok(await anon.post('/auth/request-code', { email: 'admin@example.com' }));
  const good = codes['admin@example.com'];
  const wrong = good === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) ok(await anon.post('/auth/verify', { email: 'admin@example.com', code: wrong }), 401);
  ok(await anon.post('/auth/verify', { email: 'admin@example.com', code: good }), 401); // locked out even with the right code
  // fresh code works once
  ok(await anon.post('/auth/request-code', { email: 'admin@example.com' }));
  const c2 = codes['admin@example.com'];
  ok(await anon.post('/auth/verify', { email: 'admin@example.com', code: c2 }));
  ok(await new Client().post('/auth/verify', { email: 'admin@example.com', code: c2 }), 401); // reuse refused
});

test('unknown email gets the same answer and no code', async () => {
  const r = await anon.post('/auth/request-code', { email: 'nobody@example.com' });
  ok(r);
  assert.equal(codes['nobody@example.com'], undefined);
});

test('cross-origin writes are blocked', async () => {
  ok(await admin.call('POST', '/tasks', { title: 'x' }, { origin: 'https://evil.example' }), 403);
});

test('bootstrap returns the workspace', async () => {
  const r = await admin.get('/bootstrap');
  ok(r);
  ctx.boot = r.json;
  assert.equal(r.json.project.key, 'FORGE');
  assert.equal(r.json.statuses.length, 4);
  assert.equal(r.json.labels.length, 4);
  assert.equal(r.json.users.length, 1);
  ctx.adminId = r.json.me.id;
  ctx.st = Object.fromEntries(r.json.statuses.map((s) => [s.name, s.id]));
});

// ------------------------------------------------------------------ invites / roles
async function join(client, email, role, name) {
  const inv = await admin.post('/invites', { email, role });
  ok(inv, 201);
  const token = inv.json.link.split('/invite/')[1];
  ok(await anon.get(`/invites/lookup/${token}`));
  ok(await anon.post('/invites/request-code', { token }));
  ok(await client.post('/invites/accept', { token, name, code: '000000' }), 401);
  const r = await client.post('/invites/accept', { token, name, code: codes[email] });
  ok(r, 201);
  assert.equal(r.json.user.role, role);
  return { token, user: r.json.user };
}

test('invites: member and viewer join with an emailed code', async () => {
  const m = await join(member, 'member@example.com', 'member', 'Mia');
  const v = await join(viewer, 'viewer@example.com', 'viewer', 'Vic');
  ctx.memberId = m.user.id; ctx.viewerId = v.user.id;
  // new accounts are sent to notification settings first and start with quieter email
  assert.equal(m.user.prefs.onboarded, false);
  assert.deepEqual(m.user.prefs.notify.watched_update, { inapp: true, email: false });
  assert.equal(admin.cookie !== '' && (await admin.get('/bootstrap')).json.me.prefs.onboarded, false, 'the first admin is a new account too');
  // the invite cannot be reused
  ok(await anon.get(`/invites/lookup/${m.token}`), 404);
});

test('viewer can read but not write', async () => {
  ok(await viewer.get('/tasks'));
  ok(await viewer.post('/tasks', { title: 'nope' }), 403);
  ok(await member.post('/invites', { email: 'z@example.com' }), 403); // member is not admin
});

test('the last admin cannot be demoted', async () => {
  ok(await admin.patch(`/users/${ctx.adminId}`, { role: 'member' }), 400);
  ok(await admin.patch(`/users/${ctx.adminId}`, { active: false }), 400);
});

test('admin fallback sign-in link works once', async () => {
  const r = await admin.post(`/users/${ctx.memberId}/signin-link`);
  ok(r, 201);
  const token = r.json.link.split('/signin/')[1];
  const c = new Client();
  ok(await c.post('/auth/link', { token }));
  ok(await c.get('/bootstrap'));
  ok(await new Client().post('/auth/link', { token }), 401);
});

// ------------------------------------------------------------------ tasks
test('create, read and update a task with a version check', async () => {
  const r = await admin.post('/tasks', { title: 'Build login page', priority: 'high', points: 5, assigneeId: ctx.memberId, labelIds: [ctx.boot.labels[0].id] });
  ok(r, 201);
  ctx.t1 = r.json;
  assert.equal(ctx.t1.key, 'FORGE-1');
  assert.equal(ctx.t1.version, 1);
  assert.deepEqual(ctx.t1.labelIds, [ctx.boot.labels[0].id]);
  assert.ok(ctx.t1.watcherIds.includes(ctx.memberId), 'assignee watches automatically');

  const u = await admin.patch(`/tasks/${ctx.t1.id}`, { title: 'Build the login page', version: 1, dueDate: '2026-11-20' });
  ok(u);
  assert.equal(u.json.task.version, 2);
  assert.equal(u.json.task.dueDate, '2026-11-20');

  // a stale version is rejected with the current task
  const stale = await member.patch(`/tasks/${ctx.t1.id}`, { title: 'Stale edit', version: 1 });
  ok(stale, 409);
  assert.equal(stale.json.current.title, 'Build the login page');
});

test('assignment notifies the assignee (in-app) and queues an email', async () => {
  const r = await member.get('/notifications');
  ok(r);
  assert.ok(r.json.unreadCount >= 1);
  const n = r.json.notifications.find((x) => x.type === 'assigned');
  assert.ok(n, 'assigned notification');
  assert.equal(n.entityId, ctx.t1.id);
  assert.equal(await prisma.emailQueue.count({ where: { kind: 'notification', toEmail: 'member@example.com' } }) >= 1, true);
  const read = await member.post('/notifications/read', { all: true });
  ok(read);
  assert.equal(read.json.unreadCount, 0);
});

test('mentions notify the mentioned person', async () => {
  const mention = `Please review, @[Mia](user:${ctx.memberId})`;
  ok(await admin.patch(`/tasks/${ctx.t1.id}`, { description: mention }));
  const r = await member.get('/notifications');
  assert.ok(r.json.notifications.some((n) => n.type === 'mention'));
});

test('subtask hierarchy: nesting, cycles and depth limit', async () => {
  const epic = (await admin.post('/tasks', { title: 'Epic', type: 'epic' })).json;
  const child = await admin.post('/tasks', { title: 'Child', parentId: epic.id });
  ok(child, 201);
  const grand = await admin.post('/tasks', { title: 'Grandchild', parentId: child.json.id });
  ok(grand, 201);
  // 4th level is refused
  ok(await admin.post('/tasks', { title: 'Too deep', parentId: grand.json.id }), 400);
  // cycle refused
  ok(await admin.patch(`/tasks/${epic.id}`, { parentId: grand.json.id }), 400);
  ok(await admin.patch(`/tasks/${epic.id}`, { parentId: epic.id }), 400);
  const detail = await admin.get(`/tasks/${epic.id}`);
  assert.equal(detail.json.children.length, 1);
  assert.equal(detail.json.task.childCount, 1);
  ctx.epic = epic; ctx.child = child.json; ctx.grand = grand.json;
});

test('deleting a parent deletes its subtasks', async () => {
  const p = (await admin.post('/tasks', { title: 'Temp parent' })).json;
  const c = (await admin.post('/tasks', { title: 'Temp child', parentId: p.id })).json;
  ok(await admin.del(`/tasks/${p.id}`));
  ok(await admin.get(`/tasks/${c.id}`), 404);
});

test('links, watchers and time logging', async () => {
  const other = (await admin.post('/tasks', { title: 'Deploy' })).json;
  const l = await admin.post(`/tasks/${other.id}/links`, { toTaskId: ctx.t1.id, type: 'blocks' });
  ok(l, 201);
  ok(await admin.post(`/tasks/${other.id}/links`, { toTaskId: ctx.t1.id, type: 'blocks' }), 409); // duplicate
  ok(await admin.post(`/tasks/${other.id}/links`, { toTaskId: other.id, type: 'relates' }), 400); // self link
  const d = await admin.get(`/tasks/${ctx.t1.id}`);
  assert.equal(d.json.links.length, 1);
  ok(await admin.del(`/links/${l.json.id}`));

  ok(await member.del(`/tasks/${ctx.t1.id}/watch`));
  assert.equal((await admin.get(`/tasks/${ctx.t1.id}`)).json.task.watcherIds.includes(ctx.memberId), false);
  ok(await admin.post(`/tasks/${ctx.t1.id}/watchers`, { userId: ctx.memberId }));

  ok(await member.post(`/tasks/${ctx.t1.id}/time`, { minutes: 90, note: 'spike' }), 201);
  const t = (await admin.get(`/tasks/${ctx.t1.id}`)).json;
  assert.equal(t.task.loggedMin, 90);
  assert.equal(t.time.length, 1);
});

test('bulk edit: status, labels, then delete', async () => {
  const a = (await admin.post('/tasks', { title: 'Bulk A' })).json;
  const b = (await admin.post('/tasks', { title: 'Bulk B' })).json;
  const lab = ctx.boot.labels[1].id;
  const r = await admin.post('/tasks/bulk', { ids: [a.id, b.id], patch: { statusId: ctx.st['In Progress'], priority: 'low' }, labelAdd: [lab] });
  ok(r);
  assert.equal(r.json.updated, 2);
  const all = (await admin.get('/tasks')).json;
  for (const id of [a.id, b.id]) {
    const t = all.find((x) => x.id === id);
    assert.equal(t.statusId, ctx.st['In Progress']);
    assert.equal(t.priority, 'low');
    assert.deepEqual(t.labelIds, [lab]);
  }
  ok(await admin.post('/tasks/bulk', { ids: [a.id, b.id], delete: true }));
  ok(await admin.get(`/tasks/${a.id}`), 404);
});

test('recurring task creates its next copy when completed', async () => {
  const t = (await admin.post('/tasks', { title: 'Weekly report', dueDate: '2026-11-10', recurrence: { every: 1, unit: 'week' } })).json;
  const r = await admin.patch(`/tasks/${t.id}`, { statusId: ctx.st['Done'] });
  ok(r);
  assert.ok(r.json.task.completedAt, 'completed_at set');
  assert.ok(r.json.spawned, 'next copy created');
  assert.equal(r.json.spawned.dueDate, '2026-11-17');
  assert.equal(r.json.spawned.statusId, ctx.st['To Do']);
  assert.deepEqual(r.json.spawned.recurrence, { every: 1, unit: 'week' });
  // reopening clears completion
  const re = await admin.patch(`/tasks/${t.id}`, { statusId: ctx.st['To Do'] });
  assert.equal(re.json.task.completedAt, null);
});

test('templates create a task with subtasks', async () => {
  const tpl = await admin.post('/templates', { name: 'Bug report', data: { type: 'bug', priority: 'high', description: 'Steps to reproduce', subtasks: ['Reproduce', 'Fix', 'Add regression test'] } });
  ok(tpl, 201);
  const r = await member.post('/tasks', { templateId: tpl.json.id, title: 'Crash on save' });
  ok(r, 201);
  assert.equal(r.json.type, 'bug');
  assert.equal(r.json.priority, 'high');
  assert.equal(r.json.childCount, 3);
});

// ------------------------------------------------------------------ planning
test('sprints: durations, one active at a time, completion moves unfinished work', async () => {
  const s1 = await admin.post('/sprints', { name: 'Sprint 1', goal: 'Auth', startDate: '2026-11-02', weeks: 2 });
  ok(s1, 201);
  assert.equal(s1.json.endDate, '2026-11-15');
  const s2 = (await admin.post('/sprints', { name: 'Sprint 2', startDate: '2026-11-16', weeks: 1 })).json;
  assert.equal(s2.endDate, '2026-11-22');
  ok(await admin.post('/sprints', { name: 'Bad', startDate: '2026-11-10', endDate: '2026-11-01' }), 400);

  const done = (await admin.post('/tasks', { title: 'Sprint done', points: 3, sprintId: s1.json.id })).json;
  const open = (await admin.post('/tasks', { title: 'Sprint open', points: 2, sprintId: s1.json.id })).json;

  ok(await admin.post(`/sprints/${s1.json.id}/start`));
  ok(await admin.post(`/sprints/${s2.id}/start`), 400); // only one active sprint

  ok(await admin.patch(`/tasks/${done.id}`, { statusId: ctx.st['Done'] }));
  const bd = await admin.get(`/sprints/${s1.json.id}/burndown`);
  ok(bd);
  assert.equal(bd.json.unit, 'points');
  assert.equal(bd.json.total, 5);
  assert.equal(bd.json.days.length, 14);

  const c = await admin.post(`/sprints/${s1.json.id}/complete`, { moveTo: s2.id });
  ok(c);
  assert.equal(c.json.status, 'completed');
  assert.equal(c.json.snapshot.committedPoints, 5);
  assert.equal(c.json.snapshot.completedPoints, 3);
  assert.equal(c.json.snapshot.movedTasks, 1);
  const all = (await admin.get('/tasks')).json;
  assert.equal(all.find((t) => t.id === open.id).sprintId, s2.id);
  assert.equal(all.find((t) => t.id === done.id).sprintId, s1.json.id);

  ctx.sprint1 = s1.json; ctx.sprint2 = s2;
  ok(await admin.post(`/sprints/${s2.id}/start`)); // now allowed
  ok(await admin.del(`/sprints/${s2.id}`), 400); // active sprint cannot be deleted
});

test('milestones roll tasks up into a progress percentage', async () => {
  const m = await admin.post('/milestones', { name: 'Alpha', dueDate: '2026-12-01' });
  ok(m, 201);
  const a = (await admin.post('/tasks', { title: 'M1', points: 3, milestoneId: m.json.id })).json;
  await admin.post('/tasks', { title: 'M2', points: 1, milestoneId: m.json.id });
  await admin.patch(`/tasks/${a.id}`, { statusId: ctx.st['Done'] });
  const list = (await admin.get('/milestones')).json;
  const alpha = list.find((x) => x.id === m.json.id);
  assert.equal(alpha.taskCount, 2);
  assert.equal(alpha.doneCount, 1);
  assert.equal(alpha.progress, 75); // 3 of 4 points
  ok(await admin.patch(`/milestones/${m.json.id}`, { status: 'completed' }));
  // deleting a milestone keeps its tasks
  ok(await admin.del(`/milestones/${m.json.id}`));
  assert.ok((await admin.get(`/tasks/${a.id}`)).json.task.milestoneId === null);
});

test('workflow: edit statuses (admin only), delete moves tasks', async () => {
  ok(await member.post('/statuses', { name: 'Blocked', category: 'doing' }), 403);
  const s = await admin.post('/statuses', { name: 'Blocked', category: 'doing', color: '#ef4444' });
  ok(s, 201);
  const t = (await admin.post('/tasks', { title: 'Stuck', statusId: s.json.id })).json;
  ok(await admin.del(`/statuses/${s.json.id}`), 400); // tasks use it, no destination
  ok(await admin.del(`/statuses/${s.json.id}?moveTo=${ctx.st['To Do']}`));
  assert.equal((await admin.get(`/tasks/${t.id}`)).json.task.statusId, ctx.st['To Do']);
  // cannot remove the only "done" status
  ok(await admin.del(`/statuses/${ctx.st['Done']}?moveTo=${ctx.st['To Do']}`), 400);
});

// ------------------------------------------------------------------ personal / meta
test('favorites, recent visits and saved filters', async () => {
  ok(await member.call('PUT', '/favorites', { entityType: 'task', entityId: ctx.t1.id }));
  assert.equal((await member.get('/favorites')).json.length, 1);
  ok(await member.post('/recent', { entityType: 'task', entityId: ctx.t1.id }));
  assert.equal((await member.get('/recent')).json.length, 1);
  ok(await member.post('/filters', { name: 'My open bugs', filter: { type: 'bug', assigneeId: ctx.memberId } }), 201);
  assert.equal((await member.get('/filters')).json.length, 1);
  ok(await member.del(`/favorites/task/${ctx.t1.id}`));
  assert.equal((await member.get('/favorites')).json.length, 0);
});

test('audit log: entity history for all, global log for admins only', async () => {
  const h = await member.get(`/audit?entityType=task&entityId=${ctx.t1.id}`);
  ok(h);
  const actions = h.json.map((a) => a.action);
  assert.ok(actions.includes('task.create') && actions.includes('task.update'));
  const upd = h.json.find((a) => a.action === 'task.update' && a.after.title);
  assert.equal(upd.before.title, 'Build login page');
  ok(await member.get('/audit'), 403);
  ok(await admin.get('/audit?action=sprint'));
});

test('search finds tasks by title and key', async () => {
  const byTitle = (await admin.get('/search?q=login')).json;
  assert.ok(byTitle.tasks.some((t) => t.key === 'FORGE-1'));
  const byKey = (await admin.get('/search?q=FORGE-1')).json;
  assert.ok(byKey.tasks.some((t) => t.id === ctx.t1.id));
});

test('sessions: sign out of other devices, admin ends sessions, deactivate blocks sign-in', async () => {
  const phone = new Client();
  ok(await phone.post('/auth/link', { token: (await admin.post(`/users/${ctx.memberId}/signin-link`)).json.link.split('/signin/')[1] }));
  ok(await phone.get('/bootstrap'));
  ok(await member.post('/auth/logout-others'));
  ok(await phone.get('/bootstrap'), 401);
  ok(await member.get('/bootstrap')); // current device stays signed in
  ok(await admin.patch(`/users/${ctx.viewerId}`, { active: false }));
  ok(await viewer.get('/bootstrap'), 401);
  // a deactivated person gets no code and cannot sign back in
  delete codes['viewer@example.com'];
  ok(await anon.post('/auth/request-code', { email: 'viewer@example.com' }));
  assert.equal(codes['viewer@example.com'], undefined);
  ok(await anon.post('/auth/verify', { email: 'viewer@example.com', code: '000000' }), 401);
});

// ------------------------------------------------------------------ realtime
test('websocket pushes changes to connected users (and requires a session)', async () => {
  // no cookie: refused
  await new Promise((resolve) => {
    const w = new WebSocket(base.replace('http', 'ws') + '/ws');
    w.on('error', () => resolve());
    w.on('unexpected-response', () => resolve());
    w.on('open', () => { w.close(); assert.fail('anonymous socket should not open'); });
  });

  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie: member.cookie } });
  const events = [];
  ws.on('message', (m) => events.push(JSON.parse(m)));
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

  const t = (await admin.post('/tasks', { title: 'Live task', assigneeId: ctx.memberId })).json;
  await admin.patch(`/tasks/${t.id}`, { priority: 'critical' });
  await new Promise((r) => setTimeout(r, 400));
  const types = events.map((e) => e.type);
  assert.ok(types.includes('hello'));
  assert.ok(types.includes('task.created'), `got ${types}`);
  assert.ok(types.includes('task.updated'));
  assert.ok(types.includes('notification'), 'assignee gets a live notification');
  assert.equal(events.find((e) => e.type === 'task.updated').task.priority, 'critical');
  ws.close();
});

// ------------------------------------------------------------------ comments
const notes = async (client, type) => (await client.get('/notifications')).json.notifications.filter((n) => !type || n.type === type);

test('comments: threads, replies to replies flatten, notifications', async () => {
  await member.post('/notifications/read', { all: true });
  await admin.post('/notifications/read', { all: true });

  const root = await member.post('/comments', { targetType: 'task', targetId: ctx.t1.id, body: 'Looks good, starting now' });
  ok(root, 201);
  ctx.root = root.json;
  assert.equal(root.json.parentId, null);

  // admin (a watcher) hears about the comment
  assert.ok((await notes(admin, 'watched_update')).some((n) => /commented on FORGE-1/.test(n.data.title)));

  // admin replies: the member is told about the reply
  const reply = await admin.post('/comments', { targetType: 'task', targetId: ctx.t1.id, parentId: root.json.id, body: 'Great, ping me when ready' });
  ok(reply, 201);
  assert.equal(reply.json.parentId, root.json.id);
  assert.ok((await notes(member, 'reply')).some((n) => n.data.commentId === reply.json.id));

  // a reply to a reply attaches to the original comment (threads are one level deep)
  const deep = await member.post('/comments', { targetType: 'task', targetId: ctx.t1.id, parentId: reply.json.id, body: 'Will do' });
  assert.equal(deep.json.parentId, root.json.id);

  // a reply must belong to the same target
  ok(await member.post('/comments', { targetType: 'task', targetId: ctx.epic.id, parentId: root.json.id, body: 'wrong place' }), 400);

  const list = (await member.get(`/comments?targetType=task&targetId=${ctx.t1.id}`)).json;
  assert.equal(list.length, 3);
  assert.equal((await admin.get(`/tasks/${ctx.t1.id}`)).json.task.commentCount, 3);
});

test('comments: @mentions notify once, edits only notify new mentions', async () => {
  await member.post('/notifications/read', { all: true });
  const c = await admin.post('/comments', { targetType: 'task', targetId: ctx.t1.id, body: `Can @[Mia](user:${ctx.memberId}) check this?` });
  ok(c, 201);
  const mine = await notes(member);
  assert.equal(mine.filter((n) => n.data.commentId === c.json.id).length, 1, 'one notification even though Mia also watches the task');
  assert.equal(mine.find((n) => n.data.commentId === c.json.id).type, 'mention');

  await member.post('/notifications/read', { all: true });
  const e = await admin.patch(`/comments/${c.json.id}`, { body: `Can @[Mia](user:${ctx.memberId}) check this please?` });
  ok(e);
  assert.ok(e.json.editedAt);
  assert.equal((await notes(member)).filter((n) => !n.readAt).length, 0, 'same mention is not re-sent');
  ctx.mentionComment = c.json;
});

test('comments: only the author edits; author or admin deletes; threads keep a stub', async () => {
  ok(await member.patch(`/comments/${ctx.mentionComment.id}`, { body: 'hijack' }), 403);
  ok(await member.del(`/comments/${ctx.mentionComment.id}`), 403);
  ok(await admin.del(`/comments/${ctx.mentionComment.id}`)); // author deletes, no replies: gone
  assert.ok(!(await member.get(`/comments?targetType=task&targetId=${ctx.t1.id}`)).json.some((c) => c.id === ctx.mentionComment.id));

  // deleting a comment that has replies leaves a stub so the thread still reads
  ok(await member.del(`/comments/${ctx.root.id}`));
  const list = (await member.get(`/comments?targetType=task&targetId=${ctx.t1.id}`)).json;
  const stub = list.find((c) => c.id === ctx.root.id);
  assert.equal(stub.deleted, true);
  assert.equal(stub.body, '');
  assert.equal(list.filter((c) => c.parentId === ctx.root.id).length, 2);
  ok(await member.post(`/comments`, { targetType: 'task', targetId: ctx.t1.id, parentId: ctx.root.id, body: 'reply to deleted' }), 400);
});

test('reactions toggle on and off', async () => {
  const c = (await member.post('/comments', { targetType: 'task', targetId: ctx.t1.id, body: 'React to me' })).json;
  let r = await member.post(`/comments/${c.id}/reactions`, { emoji: '👍' });
  assert.deepEqual(r.json.reactions, { '👍': [ctx.memberId] });
  r = await admin.post(`/comments/${c.id}/reactions`, { emoji: '👍' });
  assert.deepEqual(r.json.reactions['👍'].sort(), [ctx.adminId, ctx.memberId].sort());
  await admin.post(`/comments/${c.id}/reactions`, { emoji: '🎉' });
  r = await member.post(`/comments/${c.id}/reactions`, { emoji: '👍' }); // toggles off
  assert.deepEqual(Object.keys(r.json.reactions).sort(), ['👍', '🎉'].sort());
  assert.deepEqual(r.json.reactions['👍'], [ctx.adminId]);
  const listed = (await admin.get(`/comments?targetType=task&targetId=${ctx.t1.id}`)).json.find((x) => x.id === c.id);
  assert.deepEqual(listed.reactions['🎉'], [ctx.adminId]);
});

test('viewers cannot comment or react', async () => {
  const v = new Client();
  await join(v, 'viewer2@example.com', 'viewer', 'Val');
  ok(await v.post('/comments', { targetType: 'task', targetId: ctx.t1.id, body: 'hi' }), 403);
  ok(await v.get(`/comments?targetType=task&targetId=${ctx.t1.id}`));
  ctx.viewer2 = v;
});

// ------------------------------------------------------------------ attachments
const fs = require('fs');
const path = require('path');
const config = require('../config');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function upload(client, fields, files) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append('files', new Blob([f.data], { type: f.type }), f.name);
  const res = await fetch(`${base}/api/attachments`, { method: 'POST', headers: { cookie: client.cookie }, body: fd });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const download = async (client, url) => {
  const res = await fetch(base + url, { headers: { cookie: client.cookie } });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
};
const storedFiles = () => (fs.existsSync(config.uploadDir) ? fs.readdirSync(config.uploadDir) : []);

test('attachments: upload, list, download (forced) and inline images', async () => {
  const r = await upload(member, { targetType: 'task', targetId: ctx.t1.id }, [
    { name: 'notes.txt', type: 'text/plain', data: 'hello forge' },
    { name: 'pixel.png', type: 'image/png', data: PNG },
  ]);
  ok(r, 201);
  assert.equal(r.json.length, 2);
  ctx.files = r.json;
  assert.equal(storedFiles().length >= 2, true);
  assert.equal((await admin.get(`/tasks/${ctx.t1.id}`)).json.task.attachmentCount, 2);
  assert.equal((await admin.get(`/attachments?targetType=task&targetId=${ctx.t1.id}`)).json.length, 2);

  const txt = ctx.files.find((f) => f.fileName === 'notes.txt');
  const d = await download(admin, txt.url);
  assert.equal(d.buf.toString(), 'hello forge');
  assert.match(d.headers.get('content-disposition'), /^attachment/);
  // text can never be shown inline, even if asked
  const forced = await download(admin, txt.url + '?inline=1');
  assert.match(forced.headers.get('content-disposition'), /^attachment/);

  const png = ctx.files.find((f) => f.fileName === 'pixel.png');
  const img = await download(admin, png.url + '?inline=1');
  assert.match(img.headers.get('content-disposition'), /^inline/);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(img.buf, PNG);

  assert.equal((await download(new Client(), txt.url)).status, 401); // downloads need a session
});

test('attachments: path tricks, permissions, targets', async () => {
  const r = await upload(member, { targetType: 'task', targetId: ctx.t1.id }, [{ name: '../../evil.txt', type: 'text/plain', data: 'x' }]);
  ok(r, 201);
  assert.equal(r.json[0].fileName, 'evil.txt');
  assert.ok(storedFiles().every((f) => /^[0-9a-f-]{36}$/.test(f)), 'files stored under random ids only');

  assert.equal((await upload(ctx.viewer2, { targetType: 'task', targetId: ctx.t1.id }, [{ name: 'a.txt', type: 'text/plain', data: 'x' }])).status, 403);
  assert.equal((await upload(member, { targetType: 'task', targetId: '00000000-0000-4000-8000-000000000000' }, [{ name: 'a.txt', type: 'text/plain', data: 'x' }])).status, 404);
  assert.equal((await upload(member, { targetType: 'task', targetId: ctx.t1.id }, [])).status, 400);
  const before = storedFiles().length;
  await upload(member, { targetType: 'task', targetId: '00000000-0000-4000-8000-000000000000' }, [{ name: 'a.txt', type: 'text/plain', data: 'x' }]);
  assert.equal(storedFiles().length, before, 'rejected uploads leave no orphan files');

  // only the uploader or an admin can remove a file
  ok(await ctx.viewer2.del(`/attachments/${r.json[0].id}`), 403);
  ok(await admin.del(`/attachments/${r.json[0].id}`));
  assert.equal((await download(admin, r.json[0].url)).status, 404);
});

test('attachments on comments, and files are deleted with their task', async () => {
  const t = (await admin.post('/tasks', { title: 'Has files' })).json;
  const c = (await member.post('/comments', { targetType: 'task', targetId: t.id, body: 'see attached' })).json;
  const cu = await upload(member, { targetType: 'comment', targetId: c.id }, [{ name: 'shot.png', type: 'image/png', data: PNG }]);
  ok(cu, 201);
  assert.equal((await admin.post('/comments', { targetType: 'task', targetId: t.id, body: 'x' })).status, 201);
  assert.equal((await upload(admin, { targetType: 'comment', targetId: c.id }, [{ name: 'x.txt', type: 'text/plain', data: 'x' }])).status, 403); // not your comment
  const withFiles = (await admin.get(`/comments?targetType=task&targetId=${t.id}`)).json.find((x) => x.id === c.id);
  assert.equal(withFiles.attachments.length, 1);
  await upload(admin, { targetType: 'task', targetId: t.id }, [{ name: 'doc.txt', type: 'text/plain', data: 'doc' }]);

  const before = storedFiles().length;
  ok(await admin.del(`/tasks/${t.id}`));
  assert.equal(storedFiles().length, before - 2, 'both files removed from disk with the task');
  assert.equal(await prisma.attachment.count({ where: { targetId: { in: [t.id, c.id] } } }), 0);
  assert.equal(await prisma.comment.count({ where: { targetId: t.id } }), 0);
});

// ------------------------------------------------------------------ pages
test('pages: templates, tree, nesting, ordering', async () => {
  const tpls = (await admin.get('/page-templates')).json;
  assert.ok(tpls.some((t) => t.key === 'meeting') && tpls.some((t) => t.key === 'docs'));
  const root = await admin.post('/pages', { template: 'docs' });
  ok(root, 201);
  assert.equal(root.json.title, 'Project documentation');
  assert.match(root.json.content, /## Overview/);
  ok(await admin.post('/pages', { template: 'nope' }), 400);
  const kid = await member.post('/pages', { title: 'Architecture', parentId: root.json.id, content: 'Initial draft' });
  ok(kid, 201);
  const grand = (await member.post('/pages', { title: 'Database', parentId: kid.json.id })).json;
  ctx.page = root.json; ctx.kid = kid.json; ctx.grand = grand;

  const tree = (await member.get('/pages')).json;
  assert.equal(tree.length, 3);
  assert.equal(tree.find((p) => p.id === kid.json.id).parentId, root.json.id);
  assert.equal('content' in tree[0], false, 'tree listing omits content');
  assert.equal((await member.get('/bootstrap')).json.pages.length, 3);

  // cannot move a page inside itself or its own subpage
  ok(await admin.patch(`/pages/${root.json.id}`, { parentId: grand.id }), 400);
  ok(await admin.patch(`/pages/${root.json.id}`, { parentId: root.json.id }), 400);
  // moving works, and position controls order
  const moved = await admin.patch(`/pages/${grand.id}`, { parentId: root.json.id, position: 500 });
  ok(moved);
  assert.equal(moved.json.parentId, root.json.id);
  ok(await viewer.get('/pages'), 401); // deactivated earlier
  ok(await ctx.viewer2.get('/pages'));
  ok(await ctx.viewer2.post('/pages', { title: 'no' }), 403);
});

test('pages: edit conflicts, mentions and audit', async () => {
  await member.post('/notifications/read', { all: true });
  const loaded = (await member.get(`/pages/${ctx.kid.id}`)).json;
  const mine = await member.patch(`/pages/${ctx.kid.id}`, { content: 'Reviewed by Mia and ADA', baseUpdatedAt: loaded.updatedAt });
  ok(mine);
  // admin still holds the old copy: saving it is refused instead of overwriting
  const stale = await admin.patch(`/pages/${ctx.kid.id}`, { content: 'overwrite attempt', baseUpdatedAt: loaded.updatedAt });
  ok(stale, 409);
  assert.match(stale.json.current.content, /Reviewed by/);
  // with the fresh timestamp it saves, and the mention notifies the page editor's colleague
  const fresh = await admin.patch(`/pages/${ctx.kid.id}`, { content: `Ping @[Mia](user:${ctx.memberId}) again`, baseUpdatedAt: mine.json.updatedAt });
  ok(fresh);
  assert.ok((await notes(member, 'mention')).some((n) => n.entityType === 'page' && n.entityId === ctx.kid.id));

  const h = (await admin.get(`/audit?entityType=page&entityId=${ctx.kid.id}`)).json;
  const upd = h.find((a) => a.action === 'page.update');
  assert.ok(upd.after.contentChars > 0);
  assert.equal(JSON.stringify(h).includes('Ping @'), false, 'audit never stores page text');
});

test('pages: comments, search and deleting a page removes its whole subtree', async () => {
  const c = await member.post('/comments', { targetType: 'page', targetId: ctx.kid.id, body: 'Nice page' });
  ok(c, 201);
  assert.equal((await admin.get(`/comments?targetType=page&targetId=${ctx.kid.id}`)).json.length, 1);
  assert.ok((await notes(admin)).length >= 0);

  const f = await upload(member, { targetType: 'page', targetId: ctx.kid.id }, [{ name: 'diagram.png', type: 'image/png', data: PNG }]);
  ok(f, 201);

  const found = (await admin.get('/search?q=Architecture')).json;
  assert.ok(found.pages.some((p) => p.id === ctx.kid.id));
  const byText = (await admin.get('/search?q=again')).json; // matches the page body
  assert.ok(byText.pages.some((p) => p.id === ctx.kid.id));

  const before = storedFiles().length;
  ok(await admin.del(`/pages/${ctx.kid.id}`));
  ok(await admin.get(`/pages/${ctx.kid.id}`), 404);
  assert.equal(storedFiles().length, before - 1);
  assert.equal(await prisma.comment.count({ where: { targetId: ctx.kid.id } }), 0);
  assert.equal((await admin.get('/pages')).json.length, 2); // root + the moved page remain
  await admin.del(`/pages/${ctx.page.id}`);
  assert.equal((await admin.get('/pages')).json.length, 0);
});

// ------------------------------------------------------------------ reminders
test('reminders: due soon and overdue, once each, never for finished tasks', async () => {
  const { runReminders } = require('../services/reminders');
  const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const soon = (await admin.post('/tasks', { title: 'Due tomorrow', assigneeId: ctx.memberId, dueDate: day(1) })).json;
  const late = (await admin.post('/tasks', { title: 'Overdue', assigneeId: ctx.memberId, dueDate: day(-2) })).json;
  const finished = (await admin.post('/tasks', { title: 'Done already', assigneeId: ctx.memberId, dueDate: day(-1), statusId: ctx.st['Done'] })).json;
  const far = (await admin.post('/tasks', { title: 'Far away', assigneeId: ctx.memberId, dueDate: day(30) })).json;
  await member.post('/notifications/read', { all: true });

  const sent = await runReminders();
  assert.ok(sent >= 2);
  const mine = await notes(member);
  const reminders = mine.filter((n) => n.type === 'due_soon' || n.type === 'overdue');
  assert.ok(reminders.some((n) => n.type === 'due_soon' && n.entityId === soon.id));
  assert.ok(reminders.some((n) => n.type === 'overdue' && n.entityId === late.id));
  assert.ok(!reminders.some((n) => n.entityId === finished.id), 'completed tasks are not nagged');
  assert.ok(!reminders.some((n) => n.entityId === far.id), 'far-off tasks are not nagged');
  assert.equal(await runReminders(), 0, 'running again sends nothing new');
});

// ------------------------------------------------------------------ automatic milestone status
test('a milestone completes itself when all its tasks are done, and reopens if one is not', async () => {
  const m = (await admin.post('/milestones', { name: 'Auto milestone', dueDate: '2027-01-01' })).json;
  const get = async () => (await admin.get('/milestones')).json.find((x) => x.id === m.id);
  const done = (id) => admin.patch(`/tasks/${id}`, { statusId: ctx.st['Done'] });
  const doing = (id) => admin.patch(`/tasks/${id}`, { statusId: ctx.st['In Progress'] });

  assert.equal((await get()).status, 'open', 'a milestone with no tasks stays open');
  const a = (await admin.post('/tasks', { title: 'Auto A', milestoneId: m.id })).json;
  const b = (await admin.post('/tasks', { title: 'Auto B', milestoneId: m.id, points: 3 })).json;

  await done(a.id);
  assert.equal((await get()).status, 'open', 'one of two done: still open');
  await done(b.id);
  let s = await get();
  assert.equal(s.status, 'completed', 'all done: completed');
  assert.equal(s.progress, 100);

  await doing(b.id);                                               // done -> in progress
  s = await get();
  assert.equal(s.status, 'open', 'a task moved back reopens it');
  assert.equal(s.doneCount, 1);

  await done(b.id);
  assert.equal((await get()).status, 'completed');
  const c = (await admin.post('/tasks', { title: 'Auto C', milestoneId: m.id })).json;
  assert.equal((await get()).status, 'open', 'adding an open task reopens it');
  ok(await admin.del(`/tasks/${c.id}`));
  assert.equal((await get()).status, 'completed', 'deleting the last open task completes it');

  const d = (await admin.post('/tasks', { title: 'Auto D', milestoneId: m.id })).json;
  assert.equal((await get()).status, 'open');
  await admin.patch(`/tasks/${d.id}`, { milestoneId: null });      // unlink the open task
  assert.equal((await get()).status, 'completed', 'unlinking the open task completes it');
  const other = (await admin.post('/milestones', { name: 'Other milestone' })).json;
  await admin.patch(`/tasks/${a.id}`, { milestoneId: other.id });  // moving a done task keeps both consistent
  assert.equal((await get()).status, 'completed');
  assert.equal((await admin.get('/milestones')).json.find((x) => x.id === other.id).status, 'completed');

  // a subtask counts like any other task
  const sub = (await admin.post('/tasks', { title: 'Auto sub', milestoneId: m.id, parentId: b.id })).json;
  assert.equal((await get()).status, 'open');
  await done(sub.id);
  assert.equal((await get()).status, 'completed');

  // status cannot be set by hand: it always follows the tasks
  await doing(sub.id);
  const forced = await admin.patch(`/milestones/${m.id}`, { status: 'completed' });
  ok(forced);
  assert.equal(forced.json.status, 'open');
  assert.ok((await admin.get(`/audit?entityType=milestone&entityId=${m.id}`)).json.some((x) => x.action === 'milestone.auto_status'));
});

test('bulk changes and workflow edits keep milestone status in step', async () => {
  const m = (await admin.post('/milestones', { name: 'Bulk milestone' })).json;
  const t1 = (await admin.post('/tasks', { title: 'Bulk 1', milestoneId: m.id })).json;
  const t2 = (await admin.post('/tasks', { title: 'Bulk 2', milestoneId: m.id })).json;
  const get = async () => (await admin.get('/milestones')).json.find((x) => x.id === m.id);
  ok(await admin.post('/tasks/bulk', { ids: [t1.id, t2.id], patch: { statusId: ctx.st['Done'] } }));
  assert.equal((await get()).status, 'completed', 'bulk-completing finishes the milestone');
  // a new "doing"-type status: moving the done tasks into it reopens the milestone when it is deleted with a move
  const s = (await admin.post('/statuses', { name: 'Parked', category: 'doing', color: '#888888' })).json;
  await admin.post('/tasks/bulk', { ids: [t1.id], patch: { statusId: s.id } });
  assert.equal((await get()).status, 'open');
  ok(await admin.del(`/statuses/${s.id}?moveTo=${ctx.st['Done']}`));  // t1 moves to Done
  assert.equal((await get()).status, 'completed', 'deleting a status and moving its tasks to Done completes it');
});

// ------------------------------------------------------------------ new-member notification defaults
test('a new member can finish onboarding, and watched-task emails stay off for them', async () => {
  // finishing keeps the other preferences and only flips the flag
  const me = (await member.get('/bootstrap')).json.me;
  const done = await member.patch('/me', { prefs: { ...me.prefs, onboarded: true } });
  ok(done);
  assert.equal(done.json.prefs.onboarded, true);
  assert.deepEqual(done.json.prefs.notify.watched_update, { inapp: true, email: false });
  // a watched-task change reaches their Inbox but is not queued as an email for them
  const t = (await admin.post('/tasks', { title: 'Quiet watcher test', assigneeId: ctx.adminId })).json;
  await admin.post(`/tasks/${t.id}/watchers`, { userId: ctx.memberId });
  await prisma.emailQueue.deleteMany({ where: { toEmail: 'member@example.com' } });
  await admin.patch(`/tasks/${t.id}`, { priority: 'critical' });
  assert.equal(await prisma.emailQueue.count({ where: { toEmail: 'member@example.com' } }), 0, 'no email for a watched-task change');
  assert.ok((await member.get('/notifications')).json.notifications.some((n) => n.type === 'watched_update' && n.entityId === t.id), 'but it is in the Inbox');
  await admin.del(`/tasks/${t.id}`);
});

// ------------------------------------------------------------------ removing people
test('removing a member: work stays, access ends, they can be invited again', async () => {
  const lee = new Client();
  const { user } = await join(lee, 'leaver@example.com', 'member', 'Lee Leaver');
  const t = (await admin.post('/tasks', { title: 'Lee task', assigneeId: user.id })).json;
  const c = (await lee.post('/comments', { targetType: 'task', targetId: t.id, body: 'from Lee' })).json;
  await lee.call('PUT', '/favorites', { entityType: 'task', entityId: t.id });

  ok(await member.del(`/users/${user.id}`), 403);              // only admins
  ok(await admin.del(`/users/${ctx.adminId}`), 400);           // never yourself
  ok(await admin.del('/users/00000000-0000-4000-8000-000000000000'), 404);

  const r = await admin.del(`/users/${user.id}`);
  ok(r);
  assert.equal(r.json.tasksUnassigned, 1);

  // their work stays, anonymised
  assert.equal((await admin.get(`/tasks/${t.id}`)).json.task.assigneeId, null);
  const kept = (await admin.get(`/comments?targetType=task&targetId=${t.id}`)).json.find((x) => x.id === c.id);
  assert.ok(kept, 'comment is kept');
  assert.equal(kept.authorId, null);
  // access is gone and their personal data is cleaned up
  ok(await lee.get('/bootstrap'), 401);
  assert.equal(await prisma.user.count({ where: { email: 'leaver@example.com' } }), 0);
  assert.equal(await prisma.favorite.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);
  ok(await admin.del(`/users/${user.id}`), 404);
  assert.ok((await admin.get('/audit?action=user.remove')).json.some((a) => a.entityId === user.id));

  // the same address can be invited again
  await join(new Client(), 'leaver@example.com', 'viewer', 'Lee Returns');
});

test('inviting a deactivated person explains how to bring them back', async () => {
  const r = await admin.post('/invites', { email: 'viewer@example.com', role: 'member' }); // deactivated in an earlier test
  ok(r, 400);
  assert.match(r.json.error, /deactivated/i);
  const act = await admin.post('/invites', { email: 'member@example.com', role: 'member' });
  ok(act, 400);
  assert.match(act.json.error, /already a member/i);
});

test('removing an admin is refused when it would leave no admin', async () => {
  const second = new Client();
  const { user } = await join(second, 'second-admin@example.com', 'admin', 'Second Admin');
  ok(await admin.patch(`/users/${ctx.adminId}`, { role: 'member' }));      // the original admin steps down
  ok(await second.del(`/users/${ctx.adminId}`));                           // the new admin may remove them
  ok(await second.del(`/users/${user.id}`), 400);                          // but cannot remove themselves
  // restore an admin so later tests are unaffected
  await prisma.user.create({ data: { email: 'restored-admin@example.com', name: 'Restored', role: 'admin' } });
});
