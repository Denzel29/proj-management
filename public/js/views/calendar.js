// Month calendar: task due dates, milestones, sprint start/end.
import { S, canWrite, isDone, changed, byRank, status } from '../store.js';
import { h, raw, icon, isoDate, today, addDays, parseDate } from '../ui.js';
import { A } from '../actions.js';
import { newTaskModal } from '../forms.js';
import { applyFilters, filterBar, viewTabs } from './tasks.js';

const now = new Date();
const cal = { y: now.getFullYear(), m: now.getMonth() };
A['cal-nav'] = (el) => {
  const d = el.dataset.d;
  if (d === 'today') { cal.y = new Date().getFullYear(); cal.m = new Date().getMonth(); }
  else { const x = new Date(cal.y, cal.m + Number(d), 1); cal.y = x.getFullYear(); cal.m = x.getMonth(); }
  changed();
};
A['cal-add'] = (el) => newTaskModal({ dueDate: el.dataset.date });

export default function calendar() {
  const first = new Date(cal.y, cal.m, 1);
  const lead = (first.getDay() + 6) % 7; // week starts Monday
  const start = isoDate(new Date(cal.y, cal.m, 1 - lead));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const rows = days.length;
  const tasks = applyFilters(S.tasks.filter((t) => t.dueDate));
  const byDay = (d) => tasks.filter((t) => t.dueDate === d).sort(byRank);
  const t0 = today();
  const title = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const cell = (d) => {
    const evs = [
      ...S.milestones.filter((m) => m.dueDate === d).map((m) => h`<a class="ev ms" href="#/milestones" title="Milestone">🚩 ${m.name}</a>`),
      ...S.sprints.filter((s) => s.startDate === d).map((s) => h`<a class="ev" style="--c:#0f9d92" href="#/sprints">▶ ${s.name} starts</a>`),
      ...S.sprints.filter((s) => s.endDate === d).map((s) => h`<a class="ev" style="--c:#64748b" href="#/sprints">■ ${s.name} ends</a>`),
      ...byDay(d).map((t) => h`<a class="ev ${isDone(t) ? 'done' : ''}" style="--c:${status(t.statusId)?.color || '#0f9d92'}" href="#/task/${t.id}" title="${t.key} ${t.title}">${t.title}</a>`),
    ];
    const more = evs.length - 4;
    return h`<div class="day ${parseDate(d).getMonth() !== cal.m ? 'other' : ''} ${d === t0 ? 'today' : ''}">
      <div class="num"><b>${parseDate(d).getDate()}</b>${canWrite() ? h`<button class="addd" data-act="cal-add" data-date="${d}" aria-label="Add task on this day">${icon('plus', 14)}</button>` : ''}</div>
      ${evs.slice(0, 4)}${more > 0 ? h`<span class="xs muted" style="padding:2px 6px;display:block">+${more} more</span>` : ''}</div>`;
  };

  const body = h`<div class="toolbar" style="justify-content:space-between"><div class="row">${viewTabs('calendar')}</div>
      <div class="row"><button class="icon-btn" data-act="cal-nav" data-d="-1" aria-label="Previous month">${icon('chevL')}</button><b style="min-width:150px;text-align:center">${title}</b><button class="icon-btn" data-act="cal-nav" data-d="1" aria-label="Next month">${icon('chevR')}</button><button class="btn sm" data-act="cal-nav" data-d="today">Today</button></div></div>
    ${filterBar()}
    <div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => h`<div class="dow">${d}</div>`)}${days.map(cell)}</div>
    <p class="hint">Tasks appear on their due date. Click the + on a day to add one.</p>`;
  void rows; void raw;
  return { title: 'Calendar', subtitle: 'Due dates, milestones and sprints', actions: canWrite() ? h`<button class="btn primary" data-act="new-task">${icon('plus', 16)} Add task</button>` : '', body };
}
