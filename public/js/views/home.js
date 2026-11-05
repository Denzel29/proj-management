// Home: a calm, Notion-style landing page. Recents, favorites, my tasks, mentions, sprint, milestones.
import { get } from '../api.js';
import { S, user, task, page, sprint, milestone, activeSprint, favoritesList, canWrite, isDone, byRank, changed } from '../store.js';
import { h, raw, icon, esc, typeIcon, statusPill, priorityPill, fmtDue, fmtDate, today, diffDays, greeting, empty, taskProgress } from '../ui.js';
import { A, go } from '../actions.js';
import { newTaskModal, pageTemplateModal, sprintModal } from '../forms.js';
import { ensureNotifications, feedItem } from './inbox.js';

let recent = null; // loaded once per visit to Home
let loadedAt = 0;

function recentTiles() {
  const out = [];
  for (const r of recent || []) {
    if (r.entityType === 'page') { const p = page(r.entityId); if (p) out.push({ href: `#/pages/${p.id}`, ic: p.icon, title: p.title, sub: 'Page' }); }
    else if (r.entityType === 'task') { const t = task(r.entityId); if (t) out.push({ href: `#/task/${t.id}`, ic: '☑️', title: t.title, sub: t.key }); }
    else if (r.entityType === 'sprint') { const s = sprint(r.entityId); if (s) out.push({ href: '#/sprints', ic: '⚡', title: s.name, sub: 'Sprint' }); }
    else if (r.entityType === 'milestone') { const m = milestone(r.entityId); if (m) out.push({ href: '#/milestones', ic: '🚩', title: m.name, sub: 'Milestone' }); }
  }
  return out.slice(0, 8);
}

const tile = (t) => h`<a class="tile" href="${t.href}"><span class="t-ic">${t.ic}</span><b class="trunc">${t.title}</b><small>${t.sub}</small></a>`;

function myTaskRows() {
  const mine = S.tasks.filter((t) => t.assigneeId === S.me.id && !isDone(t));
  const t0 = today();
  const bucket = (t) => (!t.dueDate ? 4 : t.dueDate < t0 ? 0 : t.dueDate === t0 ? 1 : diffDays(t0, t.dueDate) <= 7 ? 2 : 3);
  const names = ['Overdue', 'Today', 'Next 7 days', 'Later', 'No date'];
  const sorted = mine.slice().sort((a, b) => bucket(a) - bucket(b) || (a.dueDate || '9').localeCompare(b.dueDate || '9') || byRank(a, b));
  const shown = sorted.slice(0, 12);
  if (!shown.length) return empty('checkCircle', 'You are all clear', 'Nothing assigned to you right now.');
  let last = -1;
  return h`${shown.map((t) => {
    const b = bucket(t); const head = b !== last ? h`<div class="group-label">${names[b]}</div>` : ''; last = b;
    return h`${head}<div class="mini-task" data-act="open-task" data-id="${t.id}">${typeIcon(t.type)}<span class="key">${t.key}</span><span class="grow trunc">${t.title}</span>
      <span class="sm nowrap ${b === 0 ? 'due-over' : ''}">${t.dueDate ? fmtDue(t.dueDate) : ''}</span>${statusPill(S.statuses.find((s) => s.id === t.statusId))}</div>`;
  })}${sorted.length > shown.length ? h`<a class="mini-task" href="#/my-tasks" style="justify-content:center;color:var(--teal)">View all ${sorted.length} tasks</a>` : ''}`;
}

export default function home() {
  if (!recent || Date.now() - loadedAt > 60000) { loadedAt = Date.now(); get('/recent').then((r) => { recent = r; changed(); }).catch(() => { recent = []; }); }
  ensureNotifications();

  const act = activeSprint();
  const sprintTasks = act ? S.tasks.filter((t) => t.sprintId === act.id) : [];
  const pct = sprintTasks.length ? Math.round((sprintTasks.filter(isDone).length / sprintTasks.length) * 100) : 0;
  const left = act?.endDate ? diffDays(today(), act.endDate) : null;
  const favs = favoritesList().slice(0, 6);
  const tiles = recentTiles();
  const feed = (S.notifications || []).slice(0, 6);
  const upcoming = S.milestones.filter((m) => m.status === 'open').sort((a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9')).slice(0, 4);
  const first = S.me.name.split(' ')[0];

  const body = h`<div class="page-narrow">
    <div class="hero"><h1>${greeting()}, ${first}</h1><p>${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · ${S.project.name}</p></div>
    ${canWrite() ? h`<div class="quick"><button class="btn primary" data-act="home-task">${icon('plus', 16)} New task</button><button class="btn" data-act="home-page">${icon('doc', 16)} New page</button><button class="btn" data-act="home-sprint">${icon('bolt', 16)} New sprint</button></div>` : '<div style="height:18px"></div>'}

    ${act ? h`<div class="banner"><div class="grow"><h3>${act.name} is active</h3><small>${act.goal || 'No sprint goal set'}${left != null ? ` · ${left < 0 ? `${-left} day${left === -1 ? '' : 's'} overdue` : left === 0 ? 'ends today' : `${left} day${left === 1 ? '' : 's'} left`}` : ''}</small>
      <div class="bar" style="margin-top:10px;max-width:420px"><i style="width:${pct}%"></i></div><small>${sprintTasks.filter(isDone).length} of ${sprintTasks.length} tasks done</small></div><a class="btn" href="#/board">Open board</a></div>` : ''}

    ${tiles.length ? h`<div class="sec-title">Recently visited</div><div class="tiles">${tiles.map(tile)}</div>` : ''}
    ${favs.length ? h`<div class="sec-title">${icon('star', 14)} Favorites</div><div class="tiles">${favs.map((f) => h`<a class="tile" href="${f.href}"><span class="t-ic">${f.icon}</span><b class="trunc">${f.title}</b></a>`)}</div>` : ''}

    <div class="home-cols">
      <div><div class="sec-title">${icon('checkCircle', 14)} My tasks</div><div class="card">${myTaskRows()}</div></div>
      <div class="col-flex" style="gap:22px">
        <div><div class="sec-title">${icon('bell', 14)} Mentions &amp; updates <a class="right xs" href="#/inbox">See all</a></div><div class="card">${!S.notifications ? h`<div class="empty"><p>Loading...</p></div>` : feed.length ? feed.map(feedItem) : empty('inbox', 'No updates yet', 'Mentions and changes on tasks you follow appear here.')}</div></div>
        ${upcoming.length ? h`<div><div class="sec-title">${icon('flag', 14)} Upcoming milestones <a class="right xs" href="#/milestones">See all</a></div><div class="card">${upcoming.map((m) => h`<a class="mini-task" href="#/milestones" style="color:inherit;text-decoration:none"><span class="grow trunc"><b>${m.name}</b><div class="bar" style="margin-top:6px"><i style="width:${m.progress}%"></i></div></span><span class="sm muted nowrap">${m.dueDate ? fmtDate(m.dueDate) : 'No date'}</span><b class="sm">${m.progress}%</b></a>`)}</div></div>` : ''}
      </div></div>
    ${!S.tasks.length && !S.pages.length ? h`<div class="card" style="margin-top:22px">${empty('bolt', 'Welcome to Forge', 'Create a task, write a page, or plan your first sprint. Everything you do here is shared live with your team.')}</div>` : ''}
  </div>`;
  return { title: 'Home', body };
}
A['home-task'] = () => newTaskModal();
A['home-page'] = () => pageTemplateModal(null);
A['home-sprint'] = () => sprintModal();
void user; void go; void raw; void esc; void priorityPill; void taskProgress;
