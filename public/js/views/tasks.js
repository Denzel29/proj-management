// List, Board, Backlog and My Tasks screens, plus shared filters, rows and bulk edit.
import { get, post, del } from '../api.js';
import { S, user, status, label, sprint, milestone, task, activeUsers, activeSprint, canWrite, isDone, firstTodo, byRank, changed, saveTask, createTask, removeTasks, upsertLocal, removeLocal, refreshTasks } from '../store.js';
import { h, raw, icon, esc, avatar, avatarOf, typeIcon, priorityPill, statusPill, labelChip, ring, fmtDue, fmtDate, today, diffDays, toast, openMenu, openModal, confirmDialog, copyText, empty, taskProgress, PRIORITY } from '../ui.js';
import { A, C, I, K, go } from '../actions.js';
import { newTaskModal, sprintModal, startSprintModal, completeSprintModal } from '../forms.js';

// ------------------------------------------------------------ filters (shared by list, board, backlog)
const load = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return d; } };
const FILTER_DEFAULT = { q: '', assignee: '', priority: '', type: '', label: '', subtasks: '1' };
export const F = load('forge.filters', FILTER_DEFAULT);
const saveF = () => { try { localStorage.setItem('forge.filters', JSON.stringify(F)); } catch { /* ignore */ } };
let savedFilters = null;

export function applyFilters(tasks) {
  const q = F.q.trim().toLowerCase();
  return tasks.filter((t) => {
    if (q && !(t.title.toLowerCase().includes(q) || t.key.toLowerCase().includes(q))) return false;
    if (F.assignee === 'none' ? t.assigneeId : F.assignee && t.assigneeId !== F.assignee) return false;
    if (F.priority && t.priority !== F.priority) return false;
    if (F.type && t.type !== F.type) return false;
    if (F.label && !t.labelIds.includes(F.label)) return false;
    if (F.subtasks === '0' && t.parentId) return false;
    return true;
  });
}
const filtersActive = () => F.q || F.assignee || F.priority || F.type || F.label || F.subtasks === '0';

const sel = (v, cur) => (v === cur ? raw('selected') : '');

export function filterBar() {
  if (savedFilters === null) { savedFilters = []; get('/filters').then((r) => { savedFilters = r; changed(); }).catch(() => {}); }
  return h`<div class="toolbar">
    <div class="search">${icon('search', 16)}<input class="input" placeholder="Search tasks..." data-fid="f-q" data-input="f-q" value="${F.q}" aria-label="Search tasks"></div>
    <select class="select sm" style="width:auto" data-change="f-assignee" aria-label="Assignee"><option value="">Anyone</option><option value="none" ${sel('none', F.assignee)}>Unassigned</option>${activeUsers().map((u) => h`<option value="${u.id}" ${sel(u.id, F.assignee)}>${u.name}</option>`)}</select>
    <select class="select sm" style="width:auto" data-change="f-priority" aria-label="Priority"><option value="">Any priority</option>${Object.entries(PRIORITY).map(([k, v]) => h`<option value="${k}" ${sel(k, F.priority)}>${v}</option>`)}</select>
    <select class="select sm" style="width:auto" data-change="f-type" aria-label="Type"><option value="">Any type</option>${['task', 'story', 'bug', 'improvement', 'epic'].map((k) => h`<option value="${k}" ${sel(k, F.type)}>${k[0].toUpperCase() + k.slice(1)}</option>`)}</select>
    ${S.labels.length ? h`<select class="select sm" style="width:auto" data-change="f-label" aria-label="Label"><option value="">Any label</option>${S.labels.map((l) => h`<option value="${l.id}" ${sel(l.id, F.label)}>${l.name}</option>`)}</select>` : ''}
    <label class="check sm"><input type="checkbox" data-change="f-subtasks" ${F.subtasks === '1' ? raw('checked') : ''}> Subtasks</label>
    ${filtersActive() ? h`<button class="btn ghost sm" data-act="f-clear">Clear</button>` : ''}
    <button class="btn sm" data-act="f-saved">${icon('filter', 14)} Saved filters</button>
  </div>`;
}
I['f-q'] = (el) => { F.q = el.value; saveF(); changed(); };
C['f-assignee'] = (el) => { F.assignee = el.value; saveF(); changed(); };
C['f-priority'] = (el) => { F.priority = el.value; saveF(); changed(); };
C['f-type'] = (el) => { F.type = el.value; saveF(); changed(); };
C['f-label'] = (el) => { F.label = el.value; saveF(); changed(); };
C['f-subtasks'] = (el) => { F.subtasks = el.checked ? '1' : '0'; saveF(); changed(); };
A['f-clear'] = () => { Object.assign(F, FILTER_DEFAULT); saveF(); changed(); };
A['f-saved'] = (el) => {
  const items = savedFilters.map((s) => ({ label: s.name, icon: 'filter', onClick: () => { Object.assign(F, FILTER_DEFAULT, s.filter); saveF(); changed(); } }));
  items.push(items.length ? 'sep' : { label: 'No saved filters yet', icon: 'filter' });
  items.push({
    label: 'Save current filters...', icon: 'plus', onClick: () => openModal({
      title: 'Save filters', submit: 'Save', body: h`<div class="field"><label>Name</label><input name="name" class="input" required maxlength="80" placeholder="e.g. My open bugs"></div>`,
      onSubmit: async (v) => { const s = await post('/filters', { name: v.name.trim(), filter: { ...F } }); savedFilters.push(s); toast('Filter saved'); },
    }),
  });
  savedFilters.forEach((s) => items.push({ label: `Delete "${s.name}"`, icon: 'trash', danger: true, onClick: async () => { await del(`/filters/${s.id}`); savedFilters = savedFilters.filter((x) => x.id !== s.id); changed(); } }));
  openMenu(el, items, { align: 'left' });
};

export const viewTabs = (cur) => h`<div class="seg">${[['list', 'List', 'list'], ['board', 'Board', 'board'], ['calendar', 'Calendar', 'calendar']].map(([k, l, i]) => h`<a href="#/${k}" class="${k === cur ? 'on' : ''}">${icon(i, 15)} ${l}</a>`)}</div>`;
const addBtn = (d = {}) => (canWrite() ? h`<button class="btn primary" data-act="new-task" ${raw(Object.entries(d).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' '))}>${icon('plus', 16)} Add task</button>` : '');
A['new-task'] = (el) => newTaskModal({ sprintId: el.dataset.sprint || undefined, statusId: el.dataset.status || undefined, dueDate: el.dataset.due || undefined, assigneeId: el.dataset.assignee || undefined });

// ------------------------------------------------------------ small helpers
export const plain = (md = '') => md.replace(/@\[([^\]]+)\]\(user:[^)]+\)/g, '@$1').replace(/[#>*_`~\[\]()!-]/g, ' ').replace(/\s+/g, ' ').trim();
const points = (list) => list.reduce((a, t) => a + (t.points || 0), 0);
const dueCls = (t) => (t.dueDate && !isDone(t) ? (diffDays(today(), t.dueDate) < 0 ? 'due-over' : diffDays(today(), t.dueDate) <= 1 ? 'due-soon' : '') : '');
const userOpts = (cur) => activeUsers().map((u) => h`<option value="${u.id}" ${sel(u.id, cur)}>${u.name}</option>`);

function counts(t) {
  return h`${t.commentCount ? h`<span class="stat" title="Comments">${icon('message', 13)}${t.commentCount}</span>` : ''}${t.attachmentCount ? h`<span class="stat" title="Attachments">${icon('clip', 13)}${t.attachmentCount}</span>` : ''}${t.recurrence ? h`<span class="stat" title="Repeats">${icon('repeat', 13)}</span>` : ''}${t.watcherIds.includes(S.me.id) ? h`<span class="stat" title="You are watching">${icon('eye', 13)}</span>` : ''}`;
}

// ------------------------------------------------------------ rows
const selected = new Set();
const LIST_COLS = '24px 74px minmax(180px, 1fr) 150px 128px 84px 96px 92px 30px';

/** A list/backlog row. `drag` makes it draggable between drop zones. */
function row(t, { cols = LIST_COLS, drag = true, check = true } = {}) {
  const st = status(t.statusId);
  const parent = t.parentId ? task(t.parentId) : null;
  return h`<div class="trow ${selected.has(t.id) ? 'selected' : ''}" style="--cols:${cols}" data-drag-task="${t.id}" ${drag && canWrite() ? raw('draggable="true"') : ''}>
    <span class="keep">${check && canWrite() ? h`<input type="checkbox" data-act="sel-toggle" data-id="${t.id}" ${selected.has(t.id) ? raw('checked') : ''} aria-label="Select">` : ''}</span>
    <span class="key">${t.key}</span>
    <div class="title" data-act="open-task" data-id="${t.id}">${typeIcon(t.type)}${parent ? h`<span class="key" title="Subtask of ${parent.title}">↳ ${parent.key}</span>` : ''}<span class="t ${isDone(t) ? 'done' : ''}">${t.title}</span>${t.labelIds.slice(0, 2).map((l) => { const L = label(l); return L ? labelChip(L) : ''; })}${counts(t)}</div>
    <div class="row">${avatarOf(t.assigneeId, 24)}<span class="trunc sm">${user(t.assigneeId)?.name || h`<span class="faint">Unassigned</span>`}</span></div>
    <div>${canWrite()
      ? h`<select class="select bare sm" data-change="row-status" data-id="${t.id}" aria-label="Status" style="color:${st?.color}">${S.statuses.map((s) => h`<option value="${s.id}" ${sel(s.id, t.statusId)}>${s.name}</option>`)}</select>`
      : statusPill(st)}</div>
    <div>${t.childCount ? h`<span class="ring-row">${ring(taskProgress(t))}${t.childDone}/${t.childCount}</span>` : h`<span class="faint">${t.points != null ? `${t.points} pt` : '—'}</span>`}</div>
    <div class="sm nowrap ${dueCls(t)}">${t.dueDate ? fmtDue(t.dueDate) : h`<span class="faint">—</span>`}</div>
    <div>${priorityPill(t.priority)}</div>
    <button class="icon-btn keep" data-act="row-menu" data-id="${t.id}" aria-label="More">${icon('more', 16)}</button>
  </div>`;
}
const headRow = (cols = LIST_COLS, withSort = true) => h`<div class="trow head" style="--cols:${cols}"><span></span><span>ID</span>
  <span ${withSort ? raw('class="sortable" data-act="sort" data-by="title"') : ''}>Task ${sortArrow('title')}</span><span>Assignee</span><span>Status</span><span>Progress</span>
  <span ${withSort ? raw('class="sortable" data-act="sort" data-by="due"') : ''}>Deadline ${sortArrow('due')}</span><span ${withSort ? raw('class="sortable" data-act="sort" data-by="priority"') : ''}>Priority ${sortArrow('priority')}</span><span></span></div>`;

C['row-status'] = (el) => saveTask(el.dataset.id, { statusId: el.value }).catch((e) => toast(e.message, 'error'));
A['sel-toggle'] = (el) => { el.checked ? selected.add(el.dataset.id) : selected.delete(el.dataset.id); changed(); };
A['row-menu'] = (el, e) => {
  e.stopPropagation();
  const t = task(el.dataset.id);
  openMenu(el, [
    { label: 'Open', icon: 'edit', onClick: () => go(`#/task/${t.id}`) },
    ...(canWrite() ? [{ label: 'Add subtask', icon: 'plus', onClick: () => newTaskModal({ parentId: t.id, sprintId: t.sprintId || undefined, milestoneId: t.milestoneId || undefined }) }] : []),
    { label: 'Copy link', icon: 'link', onClick: () => copyText(`${location.origin}/#/task/${t.id}`) },
    ...(canWrite() ? ['sep', { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteTask(t) }] : []),
  ]);
};
export async function deleteTask(t) {
  const subs = t.childCount ? ` and its ${t.childCount} subtask${t.childCount > 1 ? 's' : ''}` : '';
  if (!(await confirmDialog(`Delete ${t.key} "${t.title}"${subs}? This cannot be undone.`))) return false;
  await del(`/tasks/${t.id}`); removeTasks([t.id]); toast(`${t.key} deleted`);
  return true;
}

// ------------------------------------------------------------ sorting
const sort = { by: '', dir: 1 };
const sortArrow = (k) => (sort.by === k ? (sort.dir > 0 ? '▲' : '▼') : '');
A.sort = (el) => { const by = el.dataset.by; if (sort.by === by) sort.dir = -sort.dir; else { sort.by = by; sort.dir = 1; } changed(); };
const PW = { critical: 0, high: 1, medium: 2, low: 3 };
function sorted(list, base = byRank) {
  const arr = list.slice().sort(base);
  if (!sort.by) return arr;
  const key = { title: (t) => t.title.toLowerCase(), due: (t) => t.dueDate || '9999', priority: (t) => PW[t.priority] }[sort.by];
  return arr.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * sort.dir);
}

// ------------------------------------------------------------ bulk edit
function bulkBar() {
  const n = selected.size;
  if (!n || !canWrite()) return '';
  return h`<div class="bulkbar"><b>${n} selected</b>
    <select class="select sm" data-change="bulk" data-field="statusId"><option value="">Status...</option>${S.statuses.map((s) => h`<option value="${s.id}">${s.name}</option>`)}</select>
    <select class="select sm" data-change="bulk" data-field="assigneeId"><option value="">Assign to...</option><option value="null">Unassigned</option>${userOpts()}</select>
    <select class="select sm" data-change="bulk" data-field="priority"><option value="">Priority...</option>${Object.entries(PRIORITY).map(([k, v]) => h`<option value="${k}">${v}</option>`)}</select>
    <select class="select sm" data-change="bulk" data-field="sprintId"><option value="">Move to...</option><option value="null">Backlog</option>${S.sprints.filter((s) => s.status !== 'completed').map((s) => h`<option value="${s.id}">${s.name}</option>`)}</select>
    <select class="select sm" data-change="bulk" data-field="milestoneId"><option value="">Milestone...</option><option value="null">None</option>${S.milestones.map((m) => h`<option value="${m.id}">${m.name}</option>`)}</select>
    ${S.labels.length ? h`<select class="select sm" data-change="bulk" data-field="labelAdd"><option value="">Add label...</option>${S.labels.map((l) => h`<option value="${l.id}">${l.name}</option>`)}</select>` : ''}
    <button class="btn sm" data-act="bulk-delete">${icon('trash', 14)} Delete</button><button class="btn sm" data-act="sel-clear">Clear</button></div>`;
}
C.bulk = async (el) => {
  if (!el.value) return;
  const body = { ids: [...selected] };
  if (el.dataset.field === 'labelAdd') body.labelAdd = [el.value];
  else body.patch = { [el.dataset.field]: el.value === 'null' ? null : el.value };
  const r = await post('/tasks/bulk', body);
  toast(`${r.updated} task${r.updated === 1 ? '' : 's'} updated`);
  selected.clear();
  await refreshTasks();
};
A['sel-clear'] = () => { selected.clear(); changed(); };
A['bulk-delete'] = async () => {
  if (!(await confirmDialog(`Delete ${selected.size} tasks (and their subtasks)? This cannot be undone.`))) return;
  await post('/tasks/bulk', { ids: [...selected], delete: true });
  selected.clear(); await refreshTasks();
};

// ------------------------------------------------------------ grouping
const groupBy = { value: localStorage.getItem('forge.groupby') || 'status' };
const collapsed = new Set();
C['group-by'] = (el) => { groupBy.value = el.value; try { localStorage.setItem('forge.groupby', el.value); } catch { /* ignore */ } changed(); };
A['group-toggle'] = (el) => { const k = el.dataset.key; collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k); changed(); };

function groupsFor(mode, tasks) {
  const by = (fn) => tasks.filter(fn);
  if (mode === 'status') return S.statuses.map((s) => ({ key: s.id, color: s.color, label: s.name, drop: `statusId:${s.id}`, tasks: by((t) => t.statusId === s.id) }));
  if (mode === 'assignee') return [{ key: 'none', label: 'Unassigned', color: '#94a3b8', drop: 'assigneeId:null', tasks: by((t) => !t.assigneeId) }, ...activeUsers().map((u) => ({ key: u.id, label: u.name, color: u.color, drop: `assigneeId:${u.id}`, tasks: by((t) => t.assigneeId === u.id) }))];
  if (mode === 'priority') return ['critical', 'high', 'medium', 'low'].map((p) => ({ key: p, label: PRIORITY[p], color: { critical: '#c93338', high: '#e5484d', medium: '#0f9d92', low: '#7c6fd6' }[p], drop: `priority:${p}`, tasks: by((t) => t.priority === p) }));
  if (mode === 'sprint') {
    const order = { active: 0, planned: 1, completed: 3 };
    const sp = S.sprints.slice().sort((a, b) => order[a.status] - order[b.status]);
    const groups = sp.map((s) => ({ key: s.id, label: s.name, color: s.status === 'active' ? '#0f9d92' : '#94a3b8', drop: s.status === 'completed' ? '' : `sprintId:${s.id}`, tasks: by((t) => t.sprintId === s.id) }));
    groups.splice(sp.filter((s) => s.status !== 'completed').length, 0, { key: 'backlog', label: 'Backlog', color: '#64748b', drop: 'sprintId:null', tasks: by((t) => !t.sprintId) });
    return groups;
  }
  if (mode === 'milestone') return [{ key: 'none', label: 'No milestone', color: '#94a3b8', drop: 'milestoneId:null', tasks: by((t) => !t.milestoneId) }, ...S.milestones.map((m) => ({ key: m.id, label: m.name, color: '#f59e0b', drop: `milestoneId:${m.id}`, tasks: by((t) => t.milestoneId === m.id) }))];
  return [{ key: 'all', label: 'All tasks', color: '#0f9d92', drop: '', tasks }];
}

// ------------------------------------------------------------ LIST
export function list() {
  const all = applyFilters(S.tasks);
  const groups = groupsFor(groupBy.value, all).filter((g) => groupBy.value === 'status' || groupBy.value === 'sprint' || g.tasks.length);
  const body = h`
    <div class="toolbar" style="justify-content:space-between"><div class="row">${viewTabs('list')}</div>
      <div class="row"><label class="muted sm" for="gb">Group by</label><select id="gb" class="select sm" style="width:auto" data-change="group-by">${[['status', 'Status'], ['assignee', 'Assignee'], ['priority', 'Priority'], ['sprint', 'Sprint'], ['milestone', 'Milestone'], ['none', 'None']].map(([k, l]) => h`<option value="${k}" ${sel(k, groupBy.value)}>${l}</option>`)}</select>
      <button class="btn sm" data-act="export-csv">${icon('download', 14)} Export CSV</button></div></div>
    ${filterBar()}
    ${!S.tasks.length ? h`<div class="card">${empty('list', 'No tasks yet', 'Create your first task to get started.', addBtn())}</div>` : groups.map((g) => h`
      <section class="card group ${collapsed.has(g.key) ? 'closed' : ''}">
        <div class="group-head" data-act="group-toggle" data-key="${g.key}">${icon('chevD', 16, 'twist')}<span class="gtag" style="--c:${g.color}">${g.label}</span><span class="count-badge">${g.tasks.length}</span></div>
        <div class="tbl drop-zone" ${g.drop && canWrite() ? raw(`data-drop="${g.drop}"`) : ''}>${headRow()}${sorted(g.tasks).map((t) => row(t))}${g.tasks.length ? '' : h`<div class="trow" style="--cols:1fr"><span class="faint">${g.drop ? 'Drop tasks here' : 'Nothing here'}</span></div>`}</div>
      </section>`)}
    ${bulkBar()}`;
  return { title: 'Tasks', subtitle: 'Track and organize all your team\'s work in one place', actions: addBtn(), body };
}
A['export-csv'] = () => {
  const rows = [['Key', 'Title', 'Type', 'Status', 'Priority', 'Assignee', 'Sprint', 'Milestone', 'Points', 'Start', 'Due']];
  for (const t of applyFilters(S.tasks)) rows.push([t.key, t.title, t.type, status(t.statusId)?.name, t.priority, user(t.assigneeId)?.name || '', sprint(t.sprintId)?.name || '', milestone(t.milestoneId)?.name || '', t.points ?? '', t.startDate || '', t.dueDate || '']);
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${S.project.key}-tasks.csv`; a.click();
};

// ------------------------------------------------------------ BOARD
const boardScope = { value: localStorage.getItem('forge.boardscope') || 'active' };
C['board-scope'] = (el) => { boardScope.value = el.value; try { localStorage.setItem('forge.boardscope', el.value); } catch { /* ignore */ } changed(); };
let addingCol = null;

function scopedTasks() {
  const v = boardScope.value;
  if (v === 'all') return S.tasks;
  if (v === 'backlog') return S.tasks.filter((t) => !t.sprintId);
  if (v === 'active') { const a = activeSprint(); return a ? S.tasks.filter((t) => t.sprintId === a.id) : S.tasks; }
  return S.tasks.filter((t) => t.sprintId === v);
}

function card(t) {
  const desc = plain(t.description);
  return h`<article class="tcard" data-drag-task="${t.id}" ${canWrite() ? raw('draggable="true"') : ''} data-act="open-task" data-id="${t.id}">
    <div class="row">${typeIcon(t.type)}<span class="key">${t.key}</span><span class="right">${priorityPill(t.priority)}</span></div>
    ${t.labelIds.length ? h`<div class="row wrap">${t.labelIds.map((l) => { const L = label(l); return L ? labelChip(L) : ''; })}</div>` : ''}
    <h4 class="${isDone(t) ? 'muted' : ''}">${t.title}</h4>
    ${desc ? h`<div class="desc">${desc}</div>` : ''}
    <div class="foot">${avatarOf(t.assigneeId, 26)}${t.childCount ? ring(taskProgress(t), 24) : ''}
      ${t.dueDate ? h`<span class="stat ${dueCls(t)}">${icon('calendar', 13)}${fmtDue(t.dueDate)}</span>` : ''}<span class="right row" style="gap:8px">${counts(t)}${t.points != null ? h`<span class="count-badge">${t.points}</span>` : ''}</span></div>
  </article>`;
}

export function board() {
  const act = activeSprint();
  if (boardScope.value === 'active' && !act) boardScope.value = 'all';
  const tasks = applyFilters(scopedTasks());
  const scopeSprint = boardScope.value !== 'all' && boardScope.value !== 'backlog' ? sprint(boardScope.value === 'active' ? act?.id : boardScope.value) : null;
  const dropSprint = scopeSprint ? `sprintId:${scopeSprint.id}` : '';
  const body = h`
    <div class="toolbar" style="justify-content:space-between"><div class="row">${viewTabs('board')}
      <select class="select sm" style="width:auto" data-change="board-scope" aria-label="Board scope">
        ${act ? h`<option value="active" ${sel('active', boardScope.value)}>Active sprint: ${act.name}</option>` : ''}<option value="all" ${sel('all', boardScope.value)}>All tasks</option><option value="backlog" ${sel('backlog', boardScope.value)}>Backlog only</option>
        ${S.sprints.filter((s) => !(act && s.id === act.id)).map((s) => h`<option value="${s.id}" ${sel(s.id, boardScope.value)}>${s.name} (${s.status})</option>`)}</select></div>
      ${scopeSprint ? h`<span class="muted sm">${scopeSprint.goal ? `Goal: ${scopeSprint.goal}` : ''} ${scopeSprint.endDate ? `· ends ${fmtDate(scopeSprint.endDate)}` : ''}</span>` : ''}</div>
    ${filterBar()}
    <div class="board">${S.statuses.map((s) => {
      const items = tasks.filter((t) => t.statusId === s.id).sort(byRank);
      return h`<section class="col"><div class="col-h"><span class="gtag" style="--c:${s.color}">${s.name}</span><span class="count-badge">${items.length}</span></div>
        <div class="col-body drop-zone" ${canWrite() ? raw(`data-drop="statusId:${s.id} ${dropSprint}"`) : ''}>${items.map(card)}</div>
        ${canWrite() ? h`<div class="col-add">${addingCol === s.id
          ? h`<input class="input" data-fid="qa-${s.id}" data-autofocus data-enter="board-add" data-status="${s.id}" placeholder="Task title, then Enter" aria-label="New task title">`
          : h`<button class="btn ghost sm" data-act="board-adding" data-status="${s.id}">${icon('plus', 14)} Add task</button>`}</div>` : ''}</section>`;
    })}</div>`;
  return { title: 'Board', subtitle: scopeSprint ? scopeSprint.name : 'All work, by status', actions: addBtn({ sprint: scopeSprint?.id || '' }), body, after: autofocus };
}
function autofocus(root) { const el = root.querySelector('[data-autofocus]'); if (el && document.activeElement !== el) el.focus(); }
A['board-adding'] = (el) => { addingCol = el.dataset.status; changed(); };
K['board-add'] = async (el) => {
  const title = el.value.trim();
  if (!title) { addingCol = null; changed(); return; }
  const act = activeSprint();
  const sprintId = boardScope.value === 'active' ? act?.id : boardScope.value !== 'all' && boardScope.value !== 'backlog' ? boardScope.value : undefined;
  el.value = '';
  await createTask({ title, statusId: el.dataset.status, ...(sprintId ? { sprintId } : {}) });
};

// ------------------------------------------------------------ BACKLOG
function sprintSection(s) {
  const tasks = applyFilters(S.tasks.filter((t) => t.sprintId === s.id)).sort(byRank);
  const all = S.tasks.filter((t) => t.sprintId === s.id);
  const done = all.filter(isDone);
  return h`<section class="card sprint-card">
    <div class="sprint-head"><h3>${s.name}</h3><span class="state ${s.status}">${s.status}</span>
      <div class="sprint-meta">${s.startDate ? h`<span>${icon('calendar', 13)} ${fmtDate(s.startDate)} to ${fmtDate(s.endDate)}</span>` : ''}<span>${all.length} task${all.length === 1 ? '' : 's'}</span><span>${points(done)}/${points(all)} pts</span></div>
      <div class="right row">${canWrite() ? h`${s.status === 'planned' ? h`<button class="btn sm primary" data-act="sprint-start" data-id="${s.id}">${icon('play', 12)} Start sprint</button>` : ''}${s.status === 'active' ? h`<button class="btn sm" data-act="sprint-complete" data-id="${s.id}">Complete sprint</button>` : ''}
        <button class="icon-btn" data-act="sprint-menu" data-id="${s.id}" aria-label="Sprint options">${icon('more', 16)}</button>` : ''}</div></div>
    ${s.goal ? h`<div class="muted sm" style="padding:0 14px 10px">Goal: ${s.goal}</div>` : ''}
    <div class="tbl drop-zone" ${canWrite() ? raw(`data-drop="sprintId:${s.id}"`) : ''}>${tasks.map((t) => row(t, { cols: LIST_COLS }))}${tasks.length ? '' : h`<div class="trow" style="--cols:1fr"><span class="faint">${all.length ? 'No tasks match your filters' : 'Plan this sprint by dragging tasks here from the backlog'}</span></div>`}</div>
    ${canWrite() ? quickAdd(s.id) : ''}</section>`;
}
const quickAdd = (sprintId) => h`<div class="quick-add"><input class="input" data-fid="qa-sp-${sprintId || 'backlog'}" data-enter="quick-add" data-sprint="${sprintId || ''}" placeholder="+ Create task (type a title, press Enter)" aria-label="Create task"></div>`;
K['quick-add'] = async (el) => {
  const title = el.value.trim(); if (!title) return;
  el.value = '';
  await createTask({ title, ...(el.dataset.sprint ? { sprintId: el.dataset.sprint } : {}) });
};
A['sprint-start'] = (el) => startSprintModal(sprint(el.dataset.id));
A['sprint-complete'] = (el) => completeSprintModal(sprint(el.dataset.id));
A['sprint-menu'] = (el) => {
  const s = sprint(el.dataset.id);
  openMenu(el, [
    { label: 'Edit sprint', icon: 'edit', onClick: () => sprintModal(s) },
    { label: 'Delete sprint', icon: 'trash', danger: true, onClick: async () => {
      if (!(await confirmDialog(`Delete "${s.name}"? Its tasks go back to the backlog.`))) return;
      await del(`/sprints/${s.id}`); removeLocal('sprints', s.id); await refreshTasks();
    } },
  ]);
};

export function backlog() {
  const open = S.sprints.filter((s) => s.status !== 'completed').sort((a, b) => (a.status === 'active' ? -1 : b.status === 'active' ? 1 : (a.startDate || '').localeCompare(b.startDate || '')));
  const bl = applyFilters(S.tasks.filter((t) => !t.sprintId && !isDone(t))).sort(byRank);
  const blAll = S.tasks.filter((t) => !t.sprintId && !isDone(t));
  const body = h`
    ${filterBar()}
    ${open.map(sprintSection)}
    <section class="card sprint-card">
      <div class="sprint-head"><h3>Backlog</h3><div class="sprint-meta"><span>${blAll.length} task${blAll.length === 1 ? '' : 's'}</span><span>${points(blAll)} pts</span></div></div>
      <div class="tbl drop-zone" ${canWrite() ? raw('data-drop="sprintId:null"') : ''}>${bl.map((t) => row(t))}${bl.length ? '' : h`<div class="trow" style="--cols:1fr"><span class="faint">${blAll.length ? 'No tasks match your filters' : 'The backlog is empty. Add ideas below.'}</span></div>`}</div>
      ${canWrite() ? quickAdd(null) : ''}</section>
    ${bulkBar()}`;
  return { title: 'Backlog', subtitle: 'Plan sprints by dragging tasks in', actions: canWrite() ? h`<button class="btn" data-act="sprint-new">${icon('bolt', 15)} New sprint</button>${addBtn()}` : '', body };
}
A['sprint-new'] = () => sprintModal();

// ------------------------------------------------------------ MY TASKS
let showDone = false;
C['my-done'] = (el) => { showDone = el.checked; changed(); };
export function myTasks() {
  const mine = S.tasks.filter((t) => t.assigneeId === S.me.id && (showDone || !isDone(t)));
  const t0 = today();
  const bucket = (t) => (isDone(t) ? 'done' : !t.dueDate ? 'none' : t.dueDate < t0 ? 'over' : t.dueDate === t0 ? 'today' : diffDays(t0, t.dueDate) <= 7 ? 'week' : 'later');
  const groups = [['over', 'Overdue', '#e5484d'], ['today', 'Today', '#f59e0b'], ['week', 'Next 7 days', '#0f9d92'], ['later', 'Later', '#64748b'], ['none', 'No date', '#94a3b8'], ['done', 'Completed', '#22a06b']]
    .map(([k, label, color]) => ({ key: `my-${k}`, label, color, tasks: mine.filter((t) => bucket(t) === k) })).filter((g) => g.tasks.length);
  const body = h`<div class="toolbar"><label class="check"><input type="checkbox" data-change="my-done" ${showDone ? raw('checked') : ''}> Show completed</label></div>
    ${groups.length ? groups.map((g) => h`<section class="card group ${collapsed.has(g.key) ? 'closed' : ''}"><div class="group-head" data-act="group-toggle" data-key="${g.key}">${icon('chevD', 16, 'twist')}<span class="gtag" style="--c:${g.color}">${g.label}</span><span class="count-badge">${g.tasks.length}</span></div>
      <div class="tbl">${headRow(LIST_COLS, false)}${sorted(g.tasks, (a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9') || byRank(a, b)).map((t) => row(t, { drag: false }))}</div></section>`)
      : h`<div class="card">${empty('checkCircle', 'Nothing assigned to you', 'Tasks assigned to you will appear here.')}</div>`}${bulkBar()}`;
  return { title: 'My Tasks', subtitle: `${mine.filter((t) => !isDone(t)).length} open`, actions: addBtn({ assignee: S.me.id }), body };
}

void user; void I; void milestone; void firstTodo; void upsertLocal; void avatar;
