// Sprints (with burndown and velocity) and Milestones (tasks roll up into progress).
import { get, patch, del } from '../api.js';
import { S, task, sprint, milestone, activeSprint, canWrite, isDone, byRank, changed, saveTask, upsertLocal, removeLocal, refreshTasks } from '../store.js';
import { h, raw, icon, avatarOf, typeIcon, statusPill, fmtDate, fmtDateY, today, diffDays, toast, openMenu, confirmDialog, empty, esc } from '../ui.js';
import { A, C } from '../actions.js';
import { sprintModal, milestoneModal, startSprintModal, completeSprintModal, newTaskModal } from '../forms.js';
import './tasks.js'; // registers the shared sprint/task actions

const pts = (list) => list.reduce((a, t) => a + (t.points || 0), 0);

// ------------------------------------------------------------ charts (inline SVG)
const nice = (n) => { if (n <= 5) return 5; const p = 10 ** Math.floor(Math.log10(n)); return Math.ceil(n / p) * p; };

export function burndownSvg(b) {
  if (!b?.days?.length) return h`<div class="muted sm" style="padding:30px;text-align:center">Set start and end dates to see the burndown.</div>`;
  const W = 680, H = 250, L = 44, R = 16, T = 14, B = 30;
  const max = nice(Math.max(b.total, 1));
  const n = b.days.length - 1 || 1;
  const x = (i) => L + ((W - L - R) * i) / n;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ideal = b.days.map((d, i) => `${x(i)},${y(d.ideal)}`).join(' ');
  const actual = b.days.map((d, i) => (d.remaining != null ? `${x(i)},${y(d.remaining)}` : null)).filter(Boolean).join(' ');
  const ti = b.days.findIndex((d) => d.date === today());
  const ticks = [0, max / 2, max];
  const lbl = [0, Math.floor(n / 2), n];
  return raw(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Burndown chart">
    ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border)"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`).join('')}
    ${lbl.map((i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === n ? 'end' : 'middle'}">${fmtDate(b.days[i].date)}</text>`).join('')}
    ${ti >= 0 ? `<line x1="${x(ti)}" x2="${x(ti)}" y1="${T}" y2="${H - B}" stroke="var(--danger)" stroke-dasharray="3 4" opacity=".6"/><text x="${x(ti)}" y="${T - 3}" text-anchor="middle" style="fill:var(--danger)">today</text>` : ''}
    <polyline points="${ideal}" fill="none" stroke="var(--faint)" stroke-width="2" stroke-dasharray="5 5"/>
    ${actual ? `<polyline points="${actual}" fill="none" stroke="var(--teal)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
    ${b.days.filter((d) => d.remaining != null).map((d) => `<circle cx="${x(b.days.indexOf(d))}" cy="${y(d.remaining)}" r="3.5" fill="var(--teal)"><title>${esc(fmtDate(d.date))}: ${d.remaining} ${b.unit} left</title></circle>`).join('')}
  </svg>`);
}

export function velocityChart() {
  const done = S.sprints.filter((s) => s.status === 'completed' && s.snapshot).sort((a, b) => (a.endDate || '').localeCompare(b.endDate || '')).slice(-8);
  if (!done.length) return h`<div class="muted sm" style="padding:30px;text-align:center">Complete a sprint to see velocity.</div>`;
  const useTasks = done.every((s) => !s.snapshot.committedPoints);
  const val = (s, k) => (useTasks ? (k === 'c' ? s.snapshot.tasks : s.snapshot.doneTasks) : (k === 'c' ? s.snapshot.committedPoints : s.snapshot.completedPoints));
  const W = 680, H = 230, L = 40, B = 40, T = 12;
  const max = nice(Math.max(...done.map((s) => val(s, 'c')), 1));
  const bw = (W - L - 10) / done.length;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const avg = done.reduce((a, s) => a + val(s, 'd'), 0) / done.length;
  return raw(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Velocity chart">
    ${[0, max / 2, max].map((v) => `<line x1="${L}" x2="${W - 6}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border)"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`).join('')}
    ${done.map((s, i) => { const cx = L + i * bw; const w = Math.min(34, bw * 0.34);
      return `<rect x="${cx + bw / 2 - w - 2}" y="${y(val(s, 'c'))}" width="${w}" height="${H - B - y(val(s, 'c'))}" rx="4" fill="var(--border-strong)"><title>${esc(s.name)} committed: ${val(s, 'c')}</title></rect>
        <rect x="${cx + bw / 2 + 2}" y="${y(val(s, 'd'))}" width="${w}" height="${H - B - y(val(s, 'd'))}" rx="4" fill="var(--teal)"><title>${esc(s.name)} completed: ${val(s, 'd')}</title></rect>
        <text x="${cx + bw / 2}" y="${H - 20}" text-anchor="middle">${esc(s.name.length > 12 ? `${s.name.slice(0, 11)}…` : s.name)}</text>`; }).join('')}
    <line x1="${L}" x2="${W - 6}" y1="${y(avg)}" y2="${y(avg)}" stroke="var(--warn)" stroke-dasharray="4 4"/><text x="${W - 8}" y="${y(avg) - 5}" text-anchor="end" style="fill:var(--warn)">avg ${avg.toFixed(1)}</text>
  </svg><div class="legend" style="margin-top:6px"><span><i style="background:var(--border-strong)"></i>Committed ${useTasks ? '(tasks)' : '(points)'}</span><span><i style="background:var(--teal)"></i>Completed</span></div>`);
}

// ------------------------------------------------------------ sprints
const burn = {}; // sprintId -> { sig, data }
function burndownFor(s) {
  const sig = S.tasks.filter((t) => t.sprintId === s.id).map((t) => `${t.id}${t.statusId}${t.points}`).join('|') + s.endDate + s.status;
  const cached = burn[s.id];
  if (cached && cached.sig === sig) return cached.data;
  if (!cached || !cached.loading) {
    burn[s.id] = { sig: cached?.sig, data: cached?.data, loading: true };
    get(`/sprints/${s.id}/burndown`).then((data) => { burn[s.id] = { sig, data }; changed(); }).catch(() => { burn[s.id] = { sig, data: null }; });
  }
  return cached?.data;
}

function sprintCard(s) {
  const tasks = S.tasks.filter((t) => t.sprintId === s.id);
  const done = tasks.filter(isDone);
  const snap = s.snapshot;
  return h`<section class="card"><div class="sprint-head"><h3>${s.name}</h3><span class="state ${s.status}">${s.status}</span>
    <div class="sprint-meta">${s.startDate ? h`<span>${icon('calendar', 13)} ${fmtDateY(s.startDate)} to ${fmtDateY(s.endDate)}</span>` : h`<span>No dates yet</span>`}
      ${s.status === 'completed' && snap ? h`<span>${snap.completedPoints}/${snap.committedPoints} pts · ${snap.doneTasks}/${snap.tasks} tasks${snap.movedTasks ? ` · ${snap.movedTasks} moved to ${snap.movedTo}` : ''}</span>` : h`<span>${done.length}/${tasks.length} tasks · ${pts(done)}/${pts(tasks)} pts</span>`}</div>
    <div class="right row">${canWrite() ? h`${s.status === 'planned' ? h`<button class="btn sm primary" data-act="sprint-start" data-id="${s.id}">Start sprint</button>` : ''}${s.status === 'active' ? h`<button class="btn sm" data-act="sprint-complete" data-id="${s.id}">Complete sprint</button>` : ''}<button class="icon-btn" data-act="sprint-menu" data-id="${s.id}" aria-label="Options">${icon('more', 16)}</button>` : ''}</div></div>
    ${s.goal ? h`<div class="muted sm" style="padding:0 14px 12px">Goal: ${s.goal}</div>` : ''}</section>`;
}

export function sprints() {
  const act = activeSprint();
  const bd = act ? burndownFor(act) : null;
  const all = S.sprints.slice().sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
  const order = { active: 0, planned: 1, completed: 2 };
  all.sort((a, b) => order[a.status] - order[b.status]);
  const left = act?.endDate ? diffDays(today(), act.endDate) : null;
  const body = h`<div class="page-narrow">
    ${act ? h`<section class="card" style="margin-bottom:18px"><div class="card-h"><h3>${act.name}: burndown</h3><span class="state active">active</span><span class="muted sm right">${left == null ? '' : left < 0 ? `${-left} days past the end date` : left === 0 ? 'Ends today' : `${left} day${left === 1 ? '' : 's'} left`}</span></div>
      <div class="card-b chart">${bd ? burndownSvg(bd) : h`<div class="muted sm" style="padding:30px;text-align:center">Loading...</div>`}<div class="legend" style="margin-top:6px"><span><i style="background:var(--faint)"></i>Ideal</span><span><i style="background:var(--teal)"></i>Remaining ${bd ? `(${bd.unit})` : ''}</span></div></div></section>` : ''}
    <div class="sec-title">All sprints ${canWrite() ? h`<button class="btn sm right" data-act="sprint-new">${icon('plus', 13)} New sprint</button>` : ''}</div>
    ${all.length ? h`<div class="col-flex" style="gap:12px">${all.map(sprintCard)}</div>` : h`<div class="card">${empty('bolt', 'No sprints yet', 'Create a sprint, choose how long it lasts, then plan tasks into it from the Backlog.', canWrite() ? h`<button class="btn primary" data-act="sprint-new">New sprint</button>` : '')}</div>`}
    <div class="sec-title" style="margin-top:24px">Velocity</div><div class="card"><div class="card-b chart">${velocityChart()}</div></div></div>`;
  return { title: 'Sprints', subtitle: act ? `${act.name} is active` : 'No active sprint', body };
}

// ------------------------------------------------------------ milestones
const msExpanded = new Set();
A['ms-new'] = () => milestoneModal();
A['ms-edit'] = (el) => milestoneModal(milestone(el.dataset.id));
A['ms-toggle-tasks'] = (el) => { const id = el.dataset.id; msExpanded.has(id) ? msExpanded.delete(id) : msExpanded.add(id); changed(); };
A['ms-complete'] = async (el) => { const m = milestone(el.dataset.id); upsertLocal('milestones', await patch(`/milestones/${m.id}`, { status: m.status === 'completed' ? 'open' : 'completed' })); };
A['ms-del'] = async (el) => {
  const m = milestone(el.dataset.id);
  if (!(await confirmDialog(`Delete the milestone "${m.name}"? Its tasks stay, just unlinked.`))) return;
  await del(`/milestones/${m.id}`); removeLocal('milestones', m.id); await refreshTasks();
};
A['ms-task'] = (el) => newTaskModal({ milestoneId: el.dataset.id });
A['ms-unlink'] = (el) => saveTask(el.dataset.task, { milestoneId: null }).catch((e) => toast(e.message, 'error'));
C['ms-link'] = async (el) => { if (el.value) { await saveTask(el.value, { milestoneId: el.dataset.id }); toast('Task added to milestone'); } };

function msCard(m) {
  const tasks = S.tasks.filter((t) => t.milestoneId === m.id).sort(byRank);
  const left = m.dueDate ? diffDays(today(), m.dueDate) : null;
  const over = m.status === 'open' && left != null && left < 0;
  const R = 28, Cc = 2 * Math.PI * R;
  const shown = msExpanded.has(m.id) ? tasks : tasks.slice(0, 4);
  const unlinked = S.tasks.filter((t) => !t.milestoneId && !isDone(t));
  return h`<section class="card ms-card">
    <div class="row" style="align-items:flex-start;gap:14px">
      <div class="big-ring"><svg width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="${R}" fill="none" stroke="var(--border)" stroke-width="6"/><circle cx="32" cy="32" r="${R}" fill="none" stroke="${m.status === 'completed' ? 'var(--ok)' : 'var(--teal)'}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${Cc}" stroke-dashoffset="${Cc * (1 - m.progress / 100)}" transform="rotate(-90 32 32)"/></svg><b>${m.progress}%</b></div>
      <div class="grow"><div class="row"><h3 class="trunc">${m.name}</h3>${m.status === 'completed' ? h`<span class="state completed">complete</span>` : over ? h`<span class="pill prio-high">Overdue</span>` : ''}</div>
        <div class="muted sm">${m.dueDate ? `Due ${fmtDateY(m.dueDate)}${m.status === 'open' && left != null ? ` · ${left < 0 ? `${-left}d overdue` : left === 0 ? 'today' : `in ${left}d`}` : ''}` : 'No due date'} · ${m.doneCount}/${m.taskCount} tasks done</div>
        ${m.description ? h`<div class="sm" style="margin-top:6px">${m.description}</div>` : ''}</div>
      ${canWrite() ? h`<button class="icon-btn" data-act="ms-menu" data-id="${m.id}" aria-label="Options">${icon('more', 16)}</button>` : ''}</div>
    <div class="bar"><i style="width:${m.progress}%"></i></div>
    <div>${shown.map((t) => h`<div class="sub-i" style="padding:6px 0">${typeIcon(t.type)}<span class="key">${t.key}</span><a class="t ${isDone(t) ? 'done' : ''}" href="#/task/${t.id}" style="color:inherit">${t.title}</a>${avatarOf(t.assigneeId, 20)}${statusPill(S.statuses.find((s) => s.id === t.statusId))}
      ${canWrite() ? h`<button class="icon-btn" data-act="ms-unlink" data-task="${t.id}" title="Remove from milestone" aria-label="Remove">${icon('x', 13)}</button>` : ''}</div>`)}
      ${tasks.length > 4 ? h`<button class="linkbtn" data-act="ms-toggle-tasks" data-id="${m.id}">${msExpanded.has(m.id) ? 'Show fewer' : `Show all ${tasks.length} tasks`}</button>` : ''}
      ${tasks.length ? '' : h`<p class="muted sm" style="margin:0">No tasks linked yet. Tasks you add roll up into this milestone's progress.</p>`}</div>
    ${canWrite() ? h`<div class="row wrap"><button class="btn sm" data-act="ms-task" data-id="${m.id}">${icon('plus', 13)} New task</button>
      ${unlinked.length ? h`<select class="select sm" style="width:auto;max-width:220px" data-change="ms-link" data-id="${m.id}" aria-label="Add an existing task"><option value="">Add existing task...</option>${unlinked.slice(0, 80).map((t) => h`<option value="${t.id}">${t.key} ${t.title}</option>`)}</select>` : ''}</div>` : ''}
  </section>`;
}
A['ms-menu'] = (el) => {
  const m = milestone(el.dataset.id);
  openMenu(el, [
    { label: 'Edit', icon: 'edit', onClick: () => milestoneModal(m) },
    { label: m.status === 'completed' ? 'Reopen' : 'Mark complete', icon: 'check', onClick: () => A['ms-complete']({ dataset: { id: m.id } }) },
    'sep', { label: 'Delete', icon: 'trash', danger: true, onClick: () => A['ms-del']({ dataset: { id: m.id } }) },
  ]);
};

export function milestones() {
  const open = S.milestones.filter((m) => m.status === 'open'), done = S.milestones.filter((m) => m.status === 'completed');
  const body = h`<div class="page-narrow">${S.milestones.length ? h`
    ${open.length ? h`<div class="grid g2">${open.map(msCard)}</div>` : ''}
    ${done.length ? h`<div class="sec-title" style="margin:24px 0 10px">Completed</div><div class="grid g2">${done.map(msCard)}</div>` : ''}`
      : h`<div class="card">${empty('flag', 'No milestones yet', 'Milestones mark big goals. Link tasks to them and progress builds up automatically.', canWrite() ? h`<button class="btn primary" data-act="ms-new">New milestone</button>` : '')}</div>`}</div>`;
  return { title: 'Milestones', subtitle: 'Tasks build up to your goals', actions: canWrite() ? h`<button class="btn primary" data-act="ms-new">${icon('plus', 16)} New milestone</button>` : '', body };
}

void task; void sprint; void raw;
