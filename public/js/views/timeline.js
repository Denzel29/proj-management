// Timeline (roadmap): sprints, milestones, and task bars grouped by milestone.
import { S, status, isDone, changed, byRank } from '../store.js';
import { h, raw, icon, today, addDays, diffDays, fmtDate, parseDate, typeIcon, empty } from '../ui.js';
import { A, C } from '../actions.js';

const LABEL_W = 230;
let tlLeft = null;
let zoom = localStorage.getItem('forge.tlzoom') || 'week';
C['tl-zoom'] = (el) => { zoom = el.value; try { localStorage.setItem('forge.tlzoom', zoom); } catch { /* ignore */ } changed(); };
A['tl-today'] = () => { const el = document.querySelector('.tl'); const t = document.querySelector('.tl-today'); if (el && t) el.scrollLeft = t.offsetLeft - el.clientWidth / 2; };

export default function timeline() {
  const ppd = zoom === 'month' ? 5 : zoom === 'day' ? 34 : 16; // pixels per day
  const t0 = today();
  const tasks = S.tasks.filter((t) => t.dueDate || t.startDate);
  const dates = [t0, ...tasks.flatMap((t) => [t.startDate, t.dueDate]), ...S.sprints.flatMap((s) => [s.startDate, s.endDate]), ...S.milestones.map((m) => m.dueDate)].filter(Boolean).sort();
  if (!dates.length) return { title: 'Timeline', body: h`<div class="card">${empty('timeline', 'Nothing to plot yet', 'Give tasks start and due dates, or create sprints and milestones, and they will appear here.')}</div>` };
  const min = addDays(dates[0], -7), max = addDays(dates[dates.length - 1], 14);
  const total = diffDays(min, max) + 1;
  const width = total * ppd;
  const x = (d) => LABEL_W + diffDays(min, d) * ppd;

  // header cells: months (and weeks when zoomed in)
  const cells = [];
  for (let d = min; d <= max;) {
    const dt = parseDate(d);
    const span = zoom === 'month' ? new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate() - dt.getDate() + 1 : 7;
    const text = zoom === 'month' ? dt.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }) : fmtDate(d);
    cells.push(h`<div class="cell" style="width:${span * ppd}px">${text}</div>`);
    d = addDays(d, span);
  }

  const barStyle = (s, e, color) => `left:${x(s)}px;width:${Math.max(ppd, (diffDays(s, e) + 1) * ppd)}px;--c:${color}`;
  const grp = (label, ic) => h`<div class="tl-row grp"><div class="tl-label">${icon(ic, 15)} ${label}</div></div>`;

  const sprintRows = S.sprints.filter((s) => s.startDate && s.endDate).sort((a, b) => a.startDate.localeCompare(b.startDate)).map((s) => h`<div class="tl-row"><div class="tl-label trunc">${s.name}</div>
    <a class="tl-bar sprint" href="#/sprints" style="${raw(barStyle(s.startDate, s.endDate, s.status === 'active' ? '#0f9d92' : s.status === 'completed' ? '#22a06b' : '#94a3b8'))}">${s.name}</a></div>`);

  const msRows = S.milestones.filter((m) => m.dueDate).map((m) => h`<div class="tl-row"><div class="tl-label trunc">${m.name}</div>
    <a class="tl-ms" href="#/milestones" title="${m.name} (${fmtDate(m.dueDate)})" style="left:${x(m.dueDate) - 10}px;${m.status === 'completed' ? 'background:#22a06b' : ''}"></a></div>`);

  const taskRow = (t) => {
    const s = t.startDate || t.dueDate, e = t.dueDate || t.startDate;
    const [a, b] = s <= e ? [s, e] : [e, s];
    const wide = (diffDays(a, b) + 1) * ppd >= 130; // short bars cannot hold their title, so it goes beside them
    return h`<div class="tl-row"><div class="tl-label trunc">${typeIcon(t.type)}<span class="key">${t.key}</span><span class="trunc">${t.title}</span></div>
      <a class="tl-bar" href="#/task/${t.id}" title="${t.key} ${t.title}" style="${raw(barStyle(a, b, status(t.statusId)?.color || '#0f9d92'))};${isDone(t) ? 'opacity:.5' : ''}">${wide ? t.title : ''}</a>
      ${wide ? '' : h`<a class="tl-beside" href="#/task/${t.id}" style="left:${x(b) + Math.max(ppd, 6) + 8}px">${t.title}</a>`}</div>`;
  };
  const groups = [...S.milestones.map((m) => ({ name: m.name, tasks: tasks.filter((t) => t.milestoneId === m.id) })), { name: 'No milestone', tasks: tasks.filter((t) => !t.milestoneId) }].filter((g) => g.tasks.length);

  const body = h`<div class="toolbar"><select class="select sm" style="width:auto" data-change="tl-zoom" aria-label="Zoom"><option value="day" ${zoom === 'day' ? raw('selected') : ''}>Days</option><option value="week" ${zoom === 'week' ? raw('selected') : ''}>Weeks</option><option value="month" ${zoom === 'month' ? raw('selected') : ''}>Months</option></select>
    <button class="btn sm" data-act="tl-today">Jump to today</button><span class="hint">Bars use start and due dates. Set them on a task to plot it.</span></div>
    <div class="tl"><div class="tl-grid" style="width:${width + LABEL_W}px">
      <div class="tl-head"><div style="width:${LABEL_W}px;flex:none;position:sticky;left:0;background:var(--surface-2);z-index:3;border-right:1px solid var(--border)"></div>${cells}</div>
      <div class="tl-today" style="left:${x(t0)}px"></div>
      ${sprintRows.length ? [grp('Sprints', 'bolt'), sprintRows] : ''}
      ${msRows.length ? [grp('Milestones', 'flag'), msRows] : ''}
      ${groups.map((g) => [grp(g.name, 'layers'), g.tasks.sort(byRank).map(taskRow)])}
    </div></div>`;
  return {
    title: 'Timeline', subtitle: 'Roadmap of sprints, milestones and tasks', body,
    after: (root) => { // start near today, then remember where the user scrolled to across live updates
      const el = root.querySelector('.tl'); const td = root.querySelector('.tl-today');
      if (!el) return;
      el.scrollLeft = tlLeft ?? Math.max(0, (td?.offsetLeft || 0) - el.clientWidth / 3);
      el.onscroll = () => { tlLeft = el.scrollLeft; };
    },
  };
}
