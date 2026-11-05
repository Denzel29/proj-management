// Reports: status mix, priorities, workload, created vs resolved, velocity.
import { S, user, status, isDone, activeUsers } from '../store.js';
import { h, raw, icon, esc, today, addDays, fmtDate, fmtMinutes, avatarOf, empty, diffDays } from '../ui.js';
import { velocityChart } from './planning.js';

const day = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function donut(parts, total) {
  const R = 54, C = 2 * Math.PI * R; let off = 0;
  return raw(`<svg viewBox="0 0 140 140" width="150" height="150" role="img" aria-label="Tasks by status"><circle cx="70" cy="70" r="${R}" fill="none" stroke="var(--border)" stroke-width="18"/>
    ${parts.filter((p) => p.n).map((p) => { const len = (p.n / total) * C; const el = `<circle cx="70" cy="70" r="${R}" fill="none" stroke="${p.color}" stroke-width="18" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"><title>${esc(p.name)}: ${p.n}</title></circle>`; off += len; return el; }).join('')}
    <text x="70" y="68" text-anchor="middle" style="font-size:22px;font-weight:700;fill:var(--text)">${total}</text><text x="70" y="86" text-anchor="middle">tasks</text></svg>`);
}

export default function reports() {
  if (!S.tasks.length) return { title: 'Reports', body: h`<div class="card">${empty('chart', 'No data yet', 'Reports appear once you have some tasks.')}</div>` };
  const open = S.tasks.filter((t) => !isDone(t));
  const t0 = today();
  const overdue = open.filter((t) => t.dueDate && t.dueDate < t0);
  const doneWeek = S.tasks.filter((t) => t.completedAt && diffDays(day(t.completedAt), t0) <= 7);
  const logged = S.tasks.reduce((a, t) => a + t.loggedMin, 0);

  const byStatus = S.statuses.map((s) => ({ name: s.name, color: s.color, n: S.tasks.filter((t) => t.statusId === s.id).length }));
  const prios = [['critical', '#c93338'], ['high', '#e5484d'], ['medium', '#0f9d92'], ['low', '#7c6fd6']].map(([p, c]) => ({ p, c, n: open.filter((t) => t.priority === p).length }));
  const pmax = Math.max(1, ...prios.map((x) => x.n));

  const people = [...activeUsers().map((u) => ({ id: u.id, name: u.name, tasks: open.filter((t) => t.assigneeId === u.id) })), { id: null, name: 'Unassigned', tasks: open.filter((t) => !t.assigneeId) }].filter((p) => p.tasks.length || p.id);
  const wmax = Math.max(1, ...people.map((p) => p.tasks.length));

  const days = Array.from({ length: 14 }, (_, i) => addDays(t0, i - 13));
  const created = days.map((d) => S.tasks.filter((t) => day(t.createdAt) === d).length);
  const resolved = days.map((d) => S.tasks.filter((t) => t.completedAt && day(t.completedAt) === d).length);
  const cmax = Math.max(1, ...created, ...resolved);
  const W = 680, H = 200, L = 30, B = 26, T = 10, bw = (W - L) / days.length;
  const cy = (v) => T + (H - T - B) * (1 - v / cmax);

  const body = h`<div class="page-narrow">
    <div class="grid g4" style="margin-bottom:18px">
      <div class="card stat-card"><div class="n">${open.length}</div><div class="l">Open tasks</div></div>
      <div class="card stat-card"><div class="n" style="color:var(--danger)">${overdue.length}</div><div class="l">Overdue</div></div>
      <div class="card stat-card"><div class="n" style="color:var(--ok)">${doneWeek.length}</div><div class="l">Done in the last 7 days</div></div>
      <div class="card stat-card"><div class="n">${fmtMinutes(logged)}</div><div class="l">Time logged</div></div></div>
    <div class="grid g2">
      <section class="card"><div class="card-h"><h3>Tasks by status</h3></div><div class="card-b row" style="gap:24px;flex-wrap:wrap">${donut(byStatus, S.tasks.length)}
        <div class="col-flex" style="gap:6px">${byStatus.map((p) => h`<div class="row"><span class="dot" style="background:${p.color}"></span><span>${p.name}</span><b class="right" style="padding-left:18px">${p.n}</b></div>`)}</div></div></section>
      <section class="card"><div class="card-h"><h3>Open tasks by priority</h3></div><div class="card-b">${prios.map((x) => h`<div class="hbar"><span>${x.p[0].toUpperCase() + x.p.slice(1)}</span><div class="track"><i style="width:${(x.n / pmax) * 100}%;background:${x.c}"></i></div><b>${x.n}</b></div>`)}</div></section>
      <section class="card"><div class="card-h"><h3>Workload</h3><span class="muted sm">open tasks per person</span></div><div class="card-b">${people.map((p) => h`<div class="hbar"><span class="row trunc">${p.id ? avatarOf(p.id, 20) : ''}<span class="trunc">${p.name}</span></span><div class="track"><i style="width:${(p.tasks.length / wmax) * 100}%;background:var(--teal)"></i></div><b title="${p.tasks.reduce((a, t) => a + (t.points || 0), 0)} points">${p.tasks.length}</b></div>`)}</div></section>
      <section class="card"><div class="card-h"><h3>Created vs resolved</h3><span class="muted sm">last 14 days</span></div><div class="card-b chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Created versus resolved">
        ${raw([0, Math.ceil(cmax / 2), cmax].map((v) => `<line x1="${L}" x2="${W}" y1="${cy(v)}" y2="${cy(v)}" stroke="var(--border)"/><text x="${L - 6}" y="${cy(v) + 4}" text-anchor="end">${v}</text>`).join(''))}
        ${raw(days.map((d, i) => `<rect x="${L + i * bw + bw * 0.12}" y="${cy(created[i])}" width="${bw * 0.34}" height="${H - B - cy(created[i])}" rx="3" fill="var(--border-strong)"><title>${esc(fmtDate(d))}: ${created[i]} created</title></rect><rect x="${L + i * bw + bw * 0.5}" y="${cy(resolved[i])}" width="${bw * 0.34}" height="${H - B - cy(resolved[i])}" rx="3" fill="var(--teal)"><title>${esc(fmtDate(d))}: ${resolved[i]} resolved</title></rect>${i % 3 === 0 ? `<text x="${L + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(fmtDate(d))}</text>` : ''}`).join(''))}</svg>
        <div class="legend"><span><i style="background:var(--border-strong)"></i>Created</span><span><i style="background:var(--teal)"></i>Resolved</span></div></div></section>
    </div>
    <section class="card" style="margin-top:16px"><div class="card-h"><h3>Sprint velocity</h3></div><div class="card-b chart">${velocityChart()}</div></section></div>`;
  return { title: 'Reports', subtitle: 'How the project is going', body };
}
void user; void status; void icon;
