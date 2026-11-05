// Shared create/edit dialogs: tasks, sprints, milestones, pages.
import { post, patch } from './api.js';
import { S, activeUsers, createTask, upsertLocal, firstTodo, activeSprint } from './store.js';
import { h, raw, icon, openModal, toast, today, addDays, closeModal } from './ui.js';
import { C, go } from './actions.js';

const options = (list, sel, text) => list.map((x) => h`<option value="${x.id}" ${x.id === sel ? raw('selected') : ''}>${text(x)}</option>`);

// ------------------------------------------------------------ new task
export function newTaskModal(d = {}) {
  const sprints = S.sprints.filter((s) => s.status !== 'completed');
  const body = h`
    ${S.templates.length ? h`<div class="field"><label>Start from a template</label>
      <select class="select" name="templateId" data-change="tplPick"><option value="">No template</option>${options(S.templates, '', (t) => t.name)}</select></div>` : ''}
    <div class="field"><label>Title</label><input name="title" class="input" required maxlength="300" placeholder="What needs to be done?" value="${d.title || ''}"></div>
    <div class="field-row">
      <div class="field"><label>Type</label><select class="select" name="type">${['task', 'story', 'bug', 'improvement', 'epic'].map((t) => h`<option value="${t}" ${t === (d.type || 'task') ? raw('selected') : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`)}</select></div>
      <div class="field"><label>Priority</label><select class="select" name="priority">${['low', 'medium', 'high', 'critical'].map((p) => h`<option value="${p}" ${p === (d.priority || 'medium') ? raw('selected') : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`)}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Assignee</label><select class="select" name="assigneeId"><option value="">Unassigned</option>${options(activeUsers(), d.assigneeId, (u) => u.name)}</select></div>
      <div class="field"><label>Status</label><select class="select" name="statusId">${options(S.statuses, d.statusId || firstTodo()?.id, (s) => s.name)}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Sprint</label><select class="select" name="sprintId"><option value="">Backlog</option>${options(sprints, d.sprintId, (s) => `${s.name}${s.status === 'active' ? ' (active)' : ''}`)}</select></div>
      <div class="field"><label>Milestone</label><select class="select" name="milestoneId"><option value="">None</option>${options(S.milestones.filter((m) => m.status === 'open'), d.milestoneId, (m) => m.name)}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Story points</label><input name="points" type="number" min="0" step="0.5" class="input" placeholder="e.g. 3"></div>
      <div class="field"><label>Due date</label><input name="dueDate" type="date" class="input" value="${d.dueDate || ''}"></div>
    </div>
    ${S.labels.length ? h`<div class="field"><label>Labels</label><div class="row wrap">${S.labels.map((l) => h`<label class="check chip" style="--c:${l.color};height:26px;padding:0 10px"><input type="checkbox" name="labelIds" value="${l.id}"> ${l.name}</label>`)}</div></div>` : ''}
    <div class="field"><label>Description</label><textarea class="textarea" name="description" data-mentions placeholder="Add details... (markdown supported, type @ to mention someone)">${d.description || ''}</textarea></div>
    ${d.parentId ? raw(`<input type="hidden" name="parentId" value="${d.parentId}">`) : ''}`;

  openModal({
    title: d.parentId ? 'New subtask' : 'New task', body, submit: 'Create task', wide: true,
    onSubmit: async (v) => {
      const data = { title: v.title.trim() };
      for (const k of ['type', 'priority', 'assigneeId', 'statusId', 'sprintId', 'milestoneId', 'dueDate', 'description', 'parentId', 'templateId']) if (v[k]) data[k] = v[k];
      if (v.points !== '' && v.points != null) data.points = Number(v.points);
      const labels = [].concat(v.labelIds || []);
      if (labels.length) data.labelIds = labels;
      const t = await createTask(data);
      toast(`${t.key} created`);
      d.onCreated?.(t);
    },
  });
}

/** Choosing a template fills the form; the server also applies the template (including its subtasks). */
C.tplPick = (el) => {
  const form = el.closest('form');
  const tpl = S.templates.find((t) => t.id === el.value);
  if (!tpl) return;
  const set = (name, val) => { const f = form.elements[name]; if (f && val != null) f.value = val; };
  const t = tpl.data || {};
  if (!form.elements.title.value && t.title) set('title', t.title);
  set('type', t.type); set('priority', t.priority); set('description', t.description); set('points', t.points);
  form.querySelectorAll('input[name=labelIds]').forEach((c) => { c.checked = (t.labelIds || []).includes(c.value); });
  if (t.subtasks?.length) toast(`${t.subtasks.length} subtasks will be created`);
};

// ------------------------------------------------------------ sprints
const sprintEnd = (start, weeks) => (start && weeks ? addDays(start, Number(weeks) * 7 - 1) : '');

export function sprintModal(s = null) {
  const n = S.sprints.length + 1;
  const weeks = S.project?.settings?.sprintWeeks || 2;
  const start = s?.startDate || '';
  const body = h`
    <div class="field"><label>Name</label><input name="name" class="input" required maxlength="100" value="${s?.name || `Sprint ${n}`}"></div>
    <div class="field"><label>Goal</label><textarea class="textarea" name="goal" style="min-height:64px" placeholder="What should be true when this sprint ends?">${s?.goal || ''}</textarea></div>
    <div class="field-row">
      <div class="field"><label>Duration</label><select class="select" name="weeks" data-change="sprintCalc">
        ${[1, 2, 3, 4].map((w) => h`<option value="${w}" ${w === weeks && !s ? raw('selected') : ''}>${w} week${w > 1 ? 's' : ''}</option>`)}<option value="" ${s ? raw('selected') : ''}>Custom dates</option></select></div>
      <div class="field"><label>Start date</label><input name="startDate" type="date" class="input" value="${start}" data-change="sprintCalc"></div>
    </div>
    <div class="field"><label>End date</label><input name="endDate" type="date" class="input" value="${s?.endDate || ''}"></div>
    <p class="hint">Pick a duration and a start date and the end date fills itself in. You can also set exact dates.</p>`;
  const m = openModal({
    title: s ? 'Edit sprint' : 'New sprint', body, submit: s ? 'Save' : 'Create sprint',
    onSubmit: async (v) => {
      const data = { name: v.name.trim(), goal: v.goal || '', startDate: v.startDate || null, endDate: v.endDate || null };
      if (data.startDate && data.endDate && data.endDate < data.startDate) throw new Error('End date must be after the start date');
      const out = s ? await patch(`/sprints/${s.id}`, data) : await post('/sprints', data);
      upsertLocal('sprints', out);
      toast(s ? 'Sprint updated' : 'Sprint created');
    },
  });
  if (!s) { const f = m.form; f.elements.startDate.value = today(); f.elements.endDate.value = sprintEnd(today(), weeks); }
}
C.sprintCalc = (el) => {
  const f = el.closest('form');
  const w = f.elements.weeks.value, st = f.elements.startDate.value;
  if (w && st) f.elements.endDate.value = sprintEnd(st, w);
};

export function startSprintModal(s) {
  const other = activeSprint();
  if (other) return toast(`"${other.name}" is still active. Complete it first.`, 'error');
  const count = S.tasks.filter((t) => t.sprintId === s.id).length;
  openModal({
    title: `Start ${s.name}`, submit: 'Start sprint',
    body: h`<p class="muted">${count} task${count === 1 ? '' : 's'} in this sprint. Confirm the dates to begin.</p>
      <div class="field-row"><div class="field"><label>Start date</label><input type="date" name="startDate" class="input" value="${s.startDate || today()}" required></div>
      <div class="field"><label>End date</label><input type="date" name="endDate" class="input" value="${s.endDate || addDays(today(), (S.project.settings.sprintWeeks || 2) * 7 - 1)}" required></div></div>`,
    onSubmit: async (v) => {
      if (v.endDate < v.startDate) throw new Error('End date must be after the start date');
      upsertLocal('sprints', await patch(`/sprints/${s.id}`, { startDate: v.startDate, endDate: v.endDate }));
      upsertLocal('sprints', await post(`/sprints/${s.id}/start`));
      toast(`${s.name} started`);
      go('#/board');
    },
  });
}

export function completeSprintModal(s) {
  const tasks = S.tasks.filter((t) => t.sprintId === s.id);
  const done = tasks.filter((t) => t.statusCategory === 'done').length;
  const open = tasks.length - done;
  const planned = S.sprints.filter((x) => x.status === 'planned');
  openModal({
    title: `Complete ${s.name}`, submit: 'Complete sprint',
    body: h`<p><b>${done}</b> task${done === 1 ? '' : 's'} done, <b>${open}</b> not finished.</p>
      ${open ? h`<div class="field"><label>Move unfinished tasks to</label><select class="select" name="moveTo"><option value="backlog">Backlog</option>${options(planned, '', (p) => p.name)}</select></div>` : h`<p class="muted">Everything is done. Nice work.</p>`}`,
    onSubmit: async (v) => {
      upsertLocal('sprints', await post(`/sprints/${s.id}/complete`, { moveTo: v.moveTo || 'backlog' }));
      toast(`${s.name} completed`);
    },
  });
}

// ------------------------------------------------------------ milestones
export function milestoneModal(m = null) {
  openModal({
    title: m ? 'Edit milestone' : 'New milestone', submit: m ? 'Save' : 'Create milestone',
    body: h`<div class="field"><label>Name</label><input name="name" class="input" required maxlength="150" value="${m?.name || ''}" placeholder="e.g. Alpha release"></div>
      <div class="field"><label>Due date</label><input name="dueDate" type="date" class="input" value="${m?.dueDate || ''}"></div>
      <div class="field"><label>Description</label><textarea class="textarea" name="description" placeholder="What does reaching this milestone mean?">${m?.description || ''}</textarea></div>`,
    onSubmit: async (v) => {
      const data = { name: v.name.trim(), description: v.description || '', dueDate: v.dueDate || null };
      upsertLocal('milestones', m ? await patch(`/milestones/${m.id}`, data) : await post('/milestones', data));
      toast(m ? 'Milestone updated' : 'Milestone created');
    },
  });
}

// ------------------------------------------------------------ pages
export async function quickPage(parentId = null) {
  const p = await post('/pages', { parentId });
  upsertLocal('pages', p);
  go(`#/pages/${p.id}`);
}

export async function pageTemplateModal(parentId = null) {
  const tpls = await (await import('./api.js')).get('/page-templates');
  openModal({
    title: 'New page', submit: 'Create page',
    body: h`<div class="col-flex">${tpls.map((t, i) => h`<label class="check card" style="padding:10px 14px"><input type="radio" name="template" value="${t.key}" ${i === 0 ? raw('checked') : ''}><span style="font-size:20px">${t.icon}</span><b>${t.name}</b></label>`)}</div>`,
    onSubmit: async (v) => {
      const p = await post('/pages', { template: v.template, parentId });
      upsertLocal('pages', p);
      closeModal();
      go(`#/pages/${p.id}`);
      return false;
    },
  });
}

export const _ico = icon;
