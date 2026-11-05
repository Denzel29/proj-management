// Settings: profile & notifications, project, workflow, labels, task templates, audit log.
import { get, post, patch, put, del } from '../api.js';
import { S, user, status, label, isAdmin, canWrite, changed, upsertLocal, removeLocal, refreshTasks } from '../store.js';
import { h, raw, icon, avatar, openModal, toast, confirmDialog, timeAgo, fmtDateTime, empty, esc } from '../ui.js';
import { A, C, K, go } from '../actions.js';
import { setTheme } from '../main.js';

const TABS = [['profile', 'Profile & notifications', 'users', false], ['project', 'Project', 'settings', true], ['workflow', 'Workflow', 'board', true], ['labels', 'Labels', 'star', false], ['templates', 'Task templates', 'copy', false], ['audit', 'Audit log', 'history', true]];
const NOTIFY = [['mention', 'Someone mentions me'], ['reply', 'Someone replies to my comment'], ['assigned', 'A task is assigned to me'], ['watched_update', 'A task I watch changes'], ['due_soon', 'A task of mine is due soon'], ['overdue', 'A task of mine is overdue']];
const COLORS = ['#0f9d92', '#6366f1', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9', '#ec4899', '#22c55e', '#f97316', '#64748b'];

// ------------------------------------------------------------ profile
function profile() {
  const me = S.me; const prefs = me.prefs?.notify || {};
  const pref = (t, k) => (prefs[t]?.[k] ?? true);
  return h`<section class="card"><div class="card-h"><h3>Profile</h3></div><div class="card-b">
      <div class="row" style="margin-bottom:16px">${avatar(me, 56)}<div><b>${me.name}</b><div class="muted sm">${me.email} · ${me.role}</div></div></div>
      <div class="field"><label>Display name</label><input class="input" style="max-width:340px" data-change="me-name" value="${me.name}" maxlength="100"></div>
      <div class="field"><label>Colour</label><div class="row wrap">${COLORS.map((c) => h`<button class="swatch ${c === me.color ? 'on' : ''}" style="background:${c}" data-act="me-color" data-c="${c}" aria-label="Colour ${c}"></button>`)}</div></div>
      <div class="field"><label>Theme</label><select class="select" style="max-width:240px" data-change="me-theme"><option value="">Match my device</option><option value="light" ${document.documentElement.dataset.theme === 'light' ? raw('selected') : ''}>Light</option><option value="dark" ${document.documentElement.dataset.theme === 'dark' ? raw('selected') : ''}>Dark</option></select></div></div></section>
    <section class="card" style="margin-top:18px"><div class="card-h"><h3>Notifications</h3><span class="muted sm">Choose how you hear about things</span></div>
      <div class="card-b"><table class="md" style="width:100%"><thead><tr><th style="text-align:left">When</th><th style="width:90px">In app</th><th style="width:90px">Email</th></tr></thead><tbody>
        ${NOTIFY.map(([t, l]) => h`<tr><td>${l}</td><td style="text-align:center"><input type="checkbox" data-change="me-notify" data-t="${t}" data-k="inapp" ${pref(t, 'inapp') ? raw('checked') : ''}></td><td style="text-align:center"><input type="checkbox" data-change="me-notify" data-t="${t}" data-k="email" ${pref(t, 'email') ? raw('checked') : ''}></td></tr>`)}</tbody></table>
        <p class="hint">Emails are grouped into one message so a burst of changes does not fill your inbox.</p></div></section>
    <section class="card" style="margin-top:18px"><div class="card-h"><h3>Security</h3></div><div class="card-b"><p class="muted" style="margin-top:0">You sign in with an emailed code and stay signed in for 30 days on each device.</p>
      <button class="btn" data-act="me-logout-others">${icon('logout', 15)} Sign out of my other devices</button></div></section>`;
}
C['me-name'] = async (el) => { if (el.value.trim()) { S.me = await patch('/me', { name: el.value.trim() }); changed(); toast('Saved'); } };
A['me-color'] = async (el) => { S.me = await patch('/me', { color: el.dataset.c }); changed(); };
C['me-theme'] = (el) => setTheme(el.value);
C['me-notify'] = async (el) => {
  const notify = JSON.parse(JSON.stringify(S.me.prefs?.notify || {}));
  notify[el.dataset.t] = { ...(notify[el.dataset.t] || {}), [el.dataset.k]: el.checked };
  S.me = await patch('/me', { prefs: { ...(S.me.prefs || {}), notify } }); changed();
};
A['me-logout-others'] = async () => { const r = await post('/auth/logout-others'); toast(`Signed out ${r.ended} other session${r.ended === 1 ? '' : 's'}`); };

// ------------------------------------------------------------ project
function project() {
  const p = S.project;
  return h`<section class="card"><div class="card-h"><h3>Project</h3></div><div class="card-b" style="max-width:560px">
    <div class="field"><label>Project name</label><input class="input" data-change="proj" data-f="name" value="${p.name}" maxlength="100"></div>
    <div class="field"><label>Key</label><input class="input" value="${p.key}" disabled style="max-width:140px"><span class="hint">The prefix on task ids (${p.key}-12). It cannot be changed.</span></div>
    <div class="field"><label>Description</label><textarea class="textarea" data-change="proj" data-f="description" maxlength="5000">${p.description}</textarea></div>
    <div class="field-row"><div class="field"><label>Default sprint length (weeks)</label><input class="input" type="number" min="1" max="8" data-change="proj" data-f="sprintWeeks" value="${p.settings.sprintWeeks}"></div>
      <div class="field"><label>Max subtask depth</label><input class="input" type="number" min="1" max="6" data-change="proj" data-f="maxSubtaskDepth" value="${p.settings.maxSubtaskDepth}"></div></div></div></section>`;
}
C.proj = async (el) => {
  const f = el.dataset.f;
  const body = ['sprintWeeks', 'maxSubtaskDepth'].includes(f) ? { settings: { [f]: Number(el.value) } } : { [f]: el.value };
  const out = await patch('/project', body); S.project = { ...S.project, ...out }; changed(); toast('Saved');
};

// ------------------------------------------------------------ workflow
function workflow() {
  const n = S.statuses.length;
  return h`<section class="card"><div class="card-h"><h3>Workflow</h3><span class="muted sm">The columns tasks move through. Each belongs to a category so progress is measured correctly.</span></div>
    ${S.statuses.map((s, i) => h`<div class="list-i"><div class="row"><button class="icon-btn" data-act="st-move" data-id="${s.id}" data-d="-1" ${i === 0 ? raw('disabled') : ''} aria-label="Move up">${icon('arrowUp', 14)}</button><button class="icon-btn" data-act="st-move" data-id="${s.id}" data-d="1" ${i === n - 1 ? raw('disabled') : ''} aria-label="Move down">${icon('chevD', 14)}</button></div>
      <input type="color" value="${s.color}" data-change="st-edit" data-id="${s.id}" data-f="color" aria-label="Colour"><input class="input" style="max-width:220px" value="${s.name}" data-change="st-edit" data-id="${s.id}" data-f="name" maxlength="40" aria-label="Name">
      <select class="select" style="max-width:190px" data-change="st-edit" data-id="${s.id}" data-f="category" aria-label="Category"><option value="todo" ${s.category === 'todo' ? raw('selected') : ''}>To do (not started)</option><option value="doing" ${s.category === 'doing' ? raw('selected') : ''}>In progress</option><option value="done" ${s.category === 'done' ? raw('selected') : ''}>Done</option></select>
      <span class="muted sm">${S.tasks.filter((t) => t.statusId === s.id).length} tasks</span><button class="icon-btn right" data-act="st-del" data-id="${s.id}" aria-label="Delete">${icon('trash', 16)}</button></div>`)}
    <div class="card-b"><div class="row wrap"><input type="color" value="#64748b" data-fid="st-new-color" aria-label="Colour"><input class="input" style="max-width:220px" data-fid="st-new-name" data-enter="st-add" placeholder="New status name" maxlength="40"><select class="select" style="max-width:190px" data-fid="st-new-cat"><option value="doing">In progress</option><option value="todo">To do</option><option value="done">Done</option></select><button class="btn" data-act="st-add">${icon('plus', 14)} Add status</button></div></div></section>`;
}
C['st-edit'] = async (el) => { await patch(`/statuses/${el.dataset.id}`, { [el.dataset.f]: el.value }); await refreshTasks(); };
A['st-move'] = async (el) => {
  const ids = S.statuses.map((s) => s.id); const i = ids.indexOf(el.dataset.id); const j = i + Number(el.dataset.d);
  if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; await put('/statuses/order', { ids });
};
K['st-add'] = () => A['st-add']();
A['st-add'] = async () => {
  const name = document.querySelector('[data-fid="st-new-name"]').value.trim(); if (!name) return toast('Enter a name', 'error');
  await post('/statuses', { name, category: document.querySelector('[data-fid="st-new-cat"]').value, color: document.querySelector('[data-fid="st-new-color"]').value });
};
A['st-del'] = async (el) => {
  const s = status(el.dataset.id); const used = S.tasks.filter((t) => t.statusId === s.id).length;
  const others = S.statuses.filter((x) => x.id !== s.id);
  if (!used) { if (await confirmDialog(`Delete the status "${s.name}"?`)) await del(`/statuses/${s.id}`).catch((e) => toast(e.message, 'error')); return; }
  openModal({
    title: `Delete "${s.name}"`, submit: 'Delete and move tasks', danger: true,
    body: h`<p>${used} task${used === 1 ? '' : 's'} use this status. Move them to:</p><div class="field"><select class="select" name="moveTo">${others.map((x) => h`<option value="${x.id}">${x.name}</option>`)}</select></div>`,
    onSubmit: async (v) => { await del(`/statuses/${s.id}?moveTo=${v.moveTo}`); await refreshTasks(); },
  });
};

// ------------------------------------------------------------ labels
function labels() {
  return h`<section class="card"><div class="card-h"><h3>Labels</h3><span class="muted sm">Tag tasks to group and filter them</span></div>
    ${S.labels.map((l) => h`<div class="list-i"><input type="color" value="${l.color}" data-change="lb-edit" data-id="${l.id}" data-f="color" aria-label="Colour"><input class="input" style="max-width:260px" value="${l.name}" data-change="lb-edit" data-id="${l.id}" data-f="name" maxlength="40" aria-label="Name">
      <span class="muted sm">${S.tasks.filter((t) => t.labelIds.includes(l.id)).length} tasks</span>${canWrite() ? h`<button class="icon-btn right" data-act="lb-del" data-id="${l.id}" aria-label="Delete">${icon('trash', 16)}</button>` : ''}</div>`)}
    ${S.labels.length ? '' : h`<div class="card-b muted">No labels yet.</div>`}
    ${canWrite() ? h`<div class="card-b"><div class="row"><input type="color" value="#0f9d92" data-fid="lb-new-color" aria-label="Colour"><input class="input" style="max-width:260px" data-fid="lb-new-name" data-enter="lb-add" placeholder="New label name" maxlength="40"><button class="btn" data-act="lb-add">${icon('plus', 14)} Add label</button></div></div>` : ''}</section>`;
}
C['lb-edit'] = async (el) => { upsertLocal('labels', await patch(`/labels/${el.dataset.id}`, { [el.dataset.f]: el.value })); };
K['lb-add'] = () => A['lb-add']();
A['lb-add'] = async () => {
  const name = document.querySelector('[data-fid="lb-new-name"]').value.trim(); if (!name) return;
  upsertLocal('labels', await post('/labels', { name, color: document.querySelector('[data-fid="lb-new-color"]').value }));
  document.querySelector('[data-fid="lb-new-name"]').value = '';
};
A['lb-del'] = async (el) => { const l = label(el.dataset.id); if (await confirmDialog(`Delete the label "${l.name}"? It is removed from all tasks.`)) { await del(`/labels/${l.id}`); removeLocal('labels', l.id); await refreshTasks(); } };

// ------------------------------------------------------------ templates
function tplModal(t = null) {
  const d = t?.data || {};
  openModal({
    title: t ? 'Edit template' : 'New task template', submit: 'Save template', wide: true,
    body: h`<div class="field"><label>Template name</label><input class="input" name="name" required maxlength="100" value="${t?.name || ''}" placeholder="e.g. Bug report"></div>
      <div class="field"><label>Default title (optional)</label><input class="input" name="title" maxlength="300" value="${d.title || ''}"></div>
      <div class="field-row"><div class="field"><label>Type</label><select class="select" name="type">${['task', 'story', 'bug', 'improvement', 'epic'].map((x) => h`<option value="${x}" ${x === (d.type || 'task') ? raw('selected') : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`)}</select></div>
        <div class="field"><label>Priority</label><select class="select" name="priority">${['low', 'medium', 'high', 'critical'].map((x) => h`<option value="${x}" ${x === (d.priority || 'medium') ? raw('selected') : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`)}</select></div></div>
      <div class="field"><label>Story points</label><input class="input" type="number" min="0" step="0.5" name="points" style="max-width:140px" value="${d.points ?? ''}"></div>
      ${S.labels.length ? h`<div class="field"><label>Labels</label><div class="row wrap">${S.labels.map((l) => h`<label class="check chip" style="--c:${l.color};height:26px;padding:0 10px"><input type="checkbox" name="labelIds" value="${l.id}" ${(d.labelIds || []).includes(l.id) ? raw('checked') : ''}> ${l.name}</label>`)}</div></div>` : ''}
      <div class="field"><label>Description</label><textarea class="textarea" name="description" placeholder="Steps, acceptance criteria...">${d.description || ''}</textarea></div>
      <div class="field"><label>Subtasks (one per line, created with the task)</label><textarea class="textarea" name="subtasks" placeholder="Reproduce the issue&#10;Write a fix&#10;Add a test">${(d.subtasks || []).map((s) => (typeof s === 'string' ? s : s.title)).join('\n')}</textarea></div>`,
    onSubmit: async (v) => {
      const data = { type: v.type, priority: v.priority, description: v.description || '', labelIds: [].concat(v.labelIds || []), subtasks: (v.subtasks || '').split('\n').map((x) => x.trim()).filter(Boolean) };
      if (v.title?.trim()) data.title = v.title.trim();
      if (v.points !== '') data.points = Number(v.points);
      upsertLocal('templates', t ? await patch(`/templates/${t.id}`, { name: v.name.trim(), data }) : await post('/templates', { name: v.name.trim(), data }));
      toast('Template saved');
    },
  });
}
function templates() {
  return h`<section class="card"><div class="card-h"><h3>Task templates</h3><span class="muted sm">Presets for tasks you create often. They can include subtasks.</span>${canWrite() ? h`<button class="btn sm primary right" data-act="tpl-new">${icon('plus', 13)} New template</button>` : ''}</div>
    ${S.templates.length ? S.templates.map((t) => h`<div class="list-i"><div class="grow"><b>${t.name}</b><div class="xs muted">${t.data.type || 'task'} · ${t.data.priority || 'medium'}${t.data.subtasks?.length ? ` · ${t.data.subtasks.length} subtasks` : ''}</div></div>
      ${canWrite() ? h`<button class="btn sm" data-act="tpl-edit" data-id="${t.id}">Edit</button><button class="icon-btn" data-act="tpl-del" data-id="${t.id}" aria-label="Delete">${icon('trash', 16)}</button>` : ''}</div>`) : h`<div class="card-b">${empty('copy', 'No templates yet', 'Create one for things like bug reports or release checklists.')}</div>`}</section>`;
}
A['tpl-new'] = () => tplModal();
A['tpl-edit'] = (el) => tplModal(S.templates.find((t) => t.id === el.dataset.id));
A['tpl-del'] = async (el) => { const t = S.templates.find((x) => x.id === el.dataset.id); if (await confirmDialog(`Delete the template "${t.name}"?`)) { await del(`/templates/${t.id}`); removeLocal('templates', t.id); } };

// ------------------------------------------------------------ audit log (admin)
const AU = { rows: null, loading: false, done: false, filter: { actorId: '', entityType: '' } };
async function loadAudit(more = false) {
  if (AU.loading) return; AU.loading = true;
  const q = new URLSearchParams({ limit: '50' });
  if (AU.filter.actorId) q.set('actorId', AU.filter.actorId); if (AU.filter.entityType) q.set('entityType', AU.filter.entityType);
  if (more && AU.rows?.length) q.set('before', String(AU.rows[AU.rows.length - 1].id));
  try { const rows = await get(`/audit?${q}`); AU.rows = more ? [...(AU.rows || []), ...rows] : rows; AU.done = rows.length < 50; } catch (e) { toast(e.message, 'error'); AU.rows = AU.rows || []; }
  AU.loading = false; changed();
}
C['au-filter'] = (el) => { AU.filter[el.dataset.f] = el.value; AU.rows = null; loadAudit(); };
A['au-more'] = () => loadAudit(true);
const brief = (a) => { const o = a.after || a.before || {}; return Object.entries(o).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '); };
function audit() {
  if (AU.rows === null && !AU.loading) loadAudit();
  const rows = AU.rows || [];
  return h`<section class="card"><div class="card-h"><h3>Audit log</h3><span class="muted sm">Who changed what, and when</span></div>
    <div class="card-b"><div class="row wrap"><select class="select sm" style="width:auto" data-change="au-filter" data-f="actorId"><option value="">Everyone</option>${S.users.map((u) => h`<option value="${u.id}" ${AU.filter.actorId === u.id ? raw('selected') : ''}>${u.name}</option>`)}</select>
      <select class="select sm" style="width:auto" data-change="au-filter" data-f="entityType"><option value="">All items</option>${['task', 'page', 'sprint', 'milestone', 'user', 'invite', 'status', 'template', 'project'].map((x) => h`<option value="${x}" ${AU.filter.entityType === x ? raw('selected') : ''}>${x}</option>`)}</select></div></div>
    ${AU.rows === null ? h`<div class="card-b muted">Loading...</div>` : rows.length ? rows.map((a) => h`<div class="list-i" style="align-items:flex-start">${avatar(user(a.actorId), 28)}<div class="grow" style="min-width:0"><div><b>${user(a.actorId)?.name || 'System'}</b> <code>${a.action}</code></div>${brief(a) ? h`<div class="xs muted trunc">${brief(a)}</div>` : ''}</div><span class="xs muted nowrap" title="${fmtDateTime(a.createdAt)}">${timeAgo(a.createdAt)}</span></div>`) : h`<div class="card-b muted">No entries.</div>`}
    ${rows.length && !AU.done ? h`<div class="card-b" style="text-align:center"><button class="btn" data-act="au-more">Load more</button></div>` : ''}</section>`;
}

// ------------------------------------------------------------ screen
export default function settings(params) {
  const tab = TABS.find((t) => t[0] === params[0] && (!t[3] || isAdmin())) ? params[0] : 'profile';
  const content = { profile, project, workflow, labels, templates, audit }[tab]();
  const body = h`<div class="settings-layout"><nav class="settings-nav">${TABS.filter((t) => !t[3] || isAdmin()).map(([k, l, ic]) => h`<a class="nav-i ${k === tab ? 'on' : ''}" href="#/settings/${k}">${icon(ic, 17)}<span>${l}</span></a>`)}</nav><div style="min-width:0;max-width:820px">${content}</div></div>`;
  return { title: 'Settings', subtitle: TABS.find((t) => t[0] === tab)[1], body };
}
void go; void esc;
