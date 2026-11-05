// A disposable demo workspace for trying the UI: node server/test/sandbox.js
// Uses its own temporary schema (your real data is never touched), email is OFF, port 3100.
// Prints a one-time sign-in link for the demo admin. Ctrl+C drops the schema.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const SCHEMA = 'forge_sandbox';
const PORT = Number(process.env.SANDBOX_PORT) || 3100;
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set('schema', SCHEMA);
Object.assign(process.env, {
  DATABASE_URL: url.toString(), SMTP_HOST: '', NODE_ENV: 'development', PORT: String(PORT), APP_URL: `http://localhost:${PORT}`,
  UPLOAD_DIR: path.join(os.tmpdir(), SCHEMA), PRISMA_HIDE_UPDATE_MESSAGE: '1',
});
const root = path.join(__dirname, '..', '..');
const sh = (cmd, args) => spawnSync(cmd, args, { cwd: root, env: process.env, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npx' });

(async () => {
  const { PrismaClient } = require('@prisma/client');
  const admin = new PrismaClient();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.$disconnect();
  if (sh('npx', ['prisma', 'migrate', 'deploy']).status !== 0) process.exit(1);

  const codes = {};
  const log = console.log;
  console.log = (...a) => { const m = /Code for (\S+): (\d{6})/.exec(String(a[0])); if (m) codes[m[1]] = m[2]; else if (!String(a[0]).startsWith('[auth] SMTP')) log(...a); };

  const { start } = require('../index');
  const { prisma } = require('../db');
  const server = await start({ port: PORT, background: false });
  const base = `http://localhost:${PORT}`;

  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(`${base}/api${p}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() || []) if (c.startsWith('forge_sid=')) cookie = c.split(';')[0];
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  // ---- people
  await call('POST', '/auth/setup/request-code', { email: 'ada@example.com' });
  await call('POST', '/auth/setup', { name: 'Ada Admin', email: 'ada@example.com', code: codes['ada@example.com'], projectName: 'Forge', projectKey: 'FORGE' });
  const adminUser = (await call('GET', '/bootstrap')).me;
  const mk = (email, name, role, color) => prisma.user.create({ data: { email, name, role, color } });
  const ben = await mk('ben@example.com', 'Ben Builder', 'member', '#6366f1');
  const cleo = await mk('cleo@example.com', 'Cleo Reviewer', 'member', '#f59e0b');
  await mk('vic@example.com', 'Vic Viewer', 'viewer', '#ec4899');

  const boot = await call('GET', '/bootstrap');
  const st = Object.fromEntries(boot.statuses.map((s) => [s.name, s.id]));
  const lb = Object.fromEntries(boot.labels.map((l) => [l.name, l.id]));

  // ---- milestones and sprints
  const alpha = await call('POST', '/milestones', { name: 'Alpha release', description: 'Core task tracking usable by the team.', dueDate: iso(24) });
  const beta = await call('POST', '/milestones', { name: 'Beta launch', description: 'Public beta with docs and onboarding.', dueDate: iso(70) });
  const s1 = await call('POST', '/sprints', { name: 'Sprint 1', goal: 'Foundations: auth and data model', startDate: iso(-28), endDate: iso(-15) });
  const s2 = await call('POST', '/sprints', { name: 'Sprint 2', goal: 'Board, backlog and task details', startDate: iso(-6), endDate: iso(7) });
  const s3 = await call('POST', '/sprints', { name: 'Sprint 3', goal: 'Reports and polish', startDate: iso(8), endDate: iso(21) });

  const T = async (d) => call('POST', '/tasks', d);
  const done = (t) => call('PATCH', `/tasks/${t.id}`, { statusId: st.Done });

  // sprint 1 (completed)
  const a1 = await T({ title: 'Set up project repository and CI', type: 'task', points: 3, sprintId: s1.id, assigneeId: adminUser.id, milestoneId: alpha.id, priority: 'high', labelIds: [lb.Backend] });
  const a2 = await T({ title: 'Design the database schema', type: 'story', points: 5, sprintId: s1.id, assigneeId: ben.id, milestoneId: alpha.id, labelIds: [lb.Backend] });
  const a3 = await T({ title: 'Passwordless sign-in', type: 'story', points: 8, sprintId: s1.id, assigneeId: adminUser.id, milestoneId: alpha.id, priority: 'high', labelIds: [lb.Backend] });
  const a4 = await T({ title: 'Email templates', type: 'task', points: 2, sprintId: s1.id, assigneeId: cleo.id, labelIds: [lb.Design] });
  await call('POST', `/sprints/${s1.id}/start`);
  for (const t of [a1, a2, a3]) await done(t);
  await call('POST', `/sprints/${s1.id}/complete`, { moveTo: 'backlog' });

  // sprint 2 (active)
  await call('POST', `/sprints/${s2.id}/start`);
  const epic = await T({ title: 'Task management', type: 'epic', sprintId: s2.id, milestoneId: alpha.id, assigneeId: adminUser.id, priority: 'high', description: '## Goal\nPlan, assign and track work.\n\n- [x] Task model\n- [ ] Board view\n- [ ] Backlog view\n\nSee FORGE-2 for details.' });
  const b1 = await T({ title: 'Kanban board with drag and drop', type: 'story', points: 8, sprintId: s2.id, assigneeId: ben.id, milestoneId: alpha.id, statusId: st['In Progress'], priority: 'high', dueDate: iso(3), startDate: iso(-4), labelIds: [lb.Frontend], parentId: epic.id });
  await T({ title: 'Column layout and cards', parentId: b1.id, assigneeId: ben.id, sprintId: s2.id, statusId: st.Done });
  await T({ title: 'Drag between columns', parentId: b1.id, assigneeId: ben.id, sprintId: s2.id, statusId: st['In Progress'] });
  await T({ title: 'Reorder within a column', parentId: b1.id, assigneeId: ben.id, sprintId: s2.id });
  const b2 = await T({ title: 'Backlog with sprint planning', type: 'story', points: 5, sprintId: s2.id, assigneeId: cleo.id, milestoneId: alpha.id, statusId: st['In Review'], dueDate: iso(1), labelIds: [lb.Frontend], parentId: epic.id });
  const b3 = await T({ title: 'Fix: crash when a task has no assignee', type: 'bug', points: 2, sprintId: s2.id, assigneeId: adminUser.id, priority: 'critical', dueDate: iso(-2), statusId: st['In Progress'] });
  const b4 = await T({ title: 'Task detail slide-over', type: 'story', points: 5, sprintId: s2.id, assigneeId: ben.id, milestoneId: alpha.id, priority: 'medium', dueDate: iso(5), labelIds: [lb.Frontend] });
  const b5 = await T({ title: 'Write onboarding guide', type: 'task', points: 3, sprintId: s2.id, assigneeId: cleo.id, milestoneId: beta.id, labelIds: [lb.Documentation], statusId: st.Done });
  await done(b5);
  await T({ title: 'Weekly status report', type: 'task', assigneeId: adminUser.id, dueDate: iso(0), recurrence: { every: 1, unit: 'week' }, sprintId: s2.id });
  await call('POST', `/tasks/${b3.id}/links`, { toTaskId: b4.id, type: 'blocks' });
  await call('POST', `/tasks/${b1.id}/time`, { minutes: 150, note: 'Prototype of drag and drop' });
  await call('PATCH', `/tasks/${b1.id}`, { estimateMin: 480 });
  await call('POST', '/comments', { targetType: 'task', targetId: b1.id, body: `Looking good so far. @[Cleo Reviewer](user:${cleo.id}) can you review the card layout?` });

  // sprint 3 (planned) and backlog
  await T({ title: 'Burndown and velocity charts', type: 'story', points: 5, sprintId: s3.id, milestoneId: beta.id, assigneeId: ben.id, dueDate: iso(14) });
  await T({ title: 'Calendar view', type: 'story', points: 3, sprintId: s3.id, milestoneId: beta.id });
  for (const [title, extra] of [['Import tasks from CSV', { points: 3, priority: 'low' }], ['Dark mode polish', { type: 'improvement', points: 2, labelIds: [lb.Design] }], ['Mobile layout review', { type: 'task', points: 3, labelIds: [lb.Frontend] }], ['Keyboard shortcuts cheat sheet', { type: 'improvement', priority: 'low' }], [a4.title, { points: 2, assigneeId: cleo.id }]]) await T({ title, ...extra });
  await call('POST', '/templates', { name: 'Bug report', data: { type: 'bug', priority: 'high', description: '**Steps to reproduce**\n1. \n\n**Expected**\n\n**Actual**', subtasks: ['Reproduce', 'Fix', 'Add a regression test'] } });

  // ---- pages
  const docs = await call('POST', '/pages', { template: 'docs' });
  await call('PATCH', `/pages/${docs.id}`, { content: `## Overview\nForge is where the team plans work, tracks sprints and keeps project documentation in one place.\n\n## Goals\n- [x] One place for tasks and docs\n- [ ] Ship the alpha by the milestone date\n- [ ] Onboard the whole team\n\n## Architecture\n| Layer | Technology |\n|---|---|\n| Server | Node.js + Express |\n| Database | PostgreSQL with Prisma |\n| Live updates | WebSockets |\n\nTasks are tracked as FORGE-3 and FORGE-5. Meeting notes live in [[Sprint 2 planning]].\n\n> Tip: type @ to mention a teammate.\n\n\`\`\`js\nconsole.log('hello forge');\n\`\`\`\n` });
  const mt = await call('POST', '/pages', { template: 'meeting', parentId: docs.id });
  await call('PATCH', `/pages/${mt.id}`, { title: 'Sprint 2 planning', content: '**Date:** this week  \n**Attendees:** Ada, Ben, Cleo\n\n## Decisions\n- Board and backlog first\n- Reports can wait for sprint 3\n\n## Action items\n- [ ] Ben: finish drag and drop\n- [ ] Cleo: review card layout\n' });
  await call('POST', '/pages', { template: 'decision', parentId: docs.id });
  await call('POST', '/pages', { template: 'requirements' });

  // favourites for the demo admin
  await call('PUT', '/favorites', { entityType: 'page', entityId: docs.id });
  await call('PUT', '/favorites', { entityType: 'task', entityId: b1.id });

  // sign-in links for the demo people
  const links = {};
  for (const [label, u] of [['Ada (admin)', adminUser], ['Ben (member)', ben], ['Vic (viewer)', (await prisma.user.findUnique({ where: { email: 'vic@example.com' } }))]]) {
    const r = await call('POST', `/users/${adminUser.id}/signin-link`.replace(adminUser.id, u.id));
    links[label] = r.link;
  }
  console.log = log;
  fs.writeFileSync(path.join(os.tmpdir(), 'forge-sandbox-links.json'), JSON.stringify(links, null, 2));
  console.log(`\n[sandbox] ready at ${base}`);
  for (const [k, v] of Object.entries(links)) console.log(`[sandbox] ${k}: ${v}`);

  const stop = async () => {
    server.close();
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {});
    fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
    console.log('[sandbox] schema dropped');
    process.exit(0);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
})().catch((e) => { console.error('[sandbox] failed:', e.message); process.exit(1); });
