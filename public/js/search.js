// Command palette: Ctrl+K or "/". Searches tasks, pages, sprints, milestones and jumps to screens.
import { get } from './api.js';
import { S, canWrite } from './store.js';
import { h, raw, icon, $, typeIcon, debounce, esc } from './ui.js';
import { go } from './actions.js';
import { newTaskModal, sprintModal, milestoneModal, pageTemplateModal } from './forms.js';

let el = null;
const close = () => { el?.remove(); el = null; document.removeEventListener('keydown', onKey, true); };

const SCREENS = [['home', 'Home', 'home'], ['my-tasks', 'My Tasks', 'checkCircle'], ['inbox', 'Inbox', 'inbox'], ['backlog', 'Backlog', 'layers'], ['board', 'Board', 'board'], ['list', 'List', 'list'], ['calendar', 'Calendar', 'calendar'], ['timeline', 'Timeline', 'timeline'], ['sprints', 'Sprints', 'bolt'], ['milestones', 'Milestones', 'flag'], ['reports', 'Reports', 'chart'], ['pages', 'Pages', 'doc'], ['team', 'Team', 'users'], ['settings', 'Settings', 'settings']];

let items = [], sel = 0, serverPages = [];

function gather(q) {
  const t = q.trim().toLowerCase();
  const out = [];
  if (!t) {
    if (canWrite()) out.push({ g: 'Create', label: 'New task', ic: 'plus', run: () => newTaskModal() }, { g: 'Create', label: 'New page', ic: 'doc', run: () => pageTemplateModal(null) }, { g: 'Create', label: 'New sprint', ic: 'bolt', run: () => sprintModal() }, { g: 'Create', label: 'New milestone', ic: 'flag', run: () => milestoneModal() });
    SCREENS.forEach(([k, label, ic]) => out.push({ g: 'Go to', label, ic, run: () => go(`#/${k}`) }));
    return out;
  }
  S.tasks.filter((x) => x.title.toLowerCase().includes(t) || x.key.toLowerCase().includes(t)).slice(0, 8)
    .forEach((x) => out.push({ g: 'Tasks', label: x.title, sub: x.key, tic: x.type, run: () => go(`#/task/${x.id}`) }));
  const seen = new Set();
  [...S.pages.filter((p) => p.title.toLowerCase().includes(t)), ...serverPages].forEach((p) => {
    if (seen.has(p.id)) return; seen.add(p.id);
    out.push({ g: 'Pages', label: p.title, em: p.icon, run: () => go(`#/pages/${p.id}`) });
  });
  S.sprints.filter((s) => s.name.toLowerCase().includes(t)).forEach((s) => out.push({ g: 'Sprints', label: s.name, ic: 'bolt', run: () => go('#/sprints') }));
  S.milestones.filter((m) => m.name.toLowerCase().includes(t)).forEach((m) => out.push({ g: 'Milestones', label: m.name, ic: 'flag', run: () => go('#/milestones') }));
  SCREENS.filter(([, label]) => label.toLowerCase().includes(t)).forEach(([k, label, ic]) => out.push({ g: 'Go to', label, ic, run: () => go(`#/${k}`) }));
  return out;
}

function draw() {
  const box = $('.results', el);
  let last = '';
  box.innerHTML = items.length ? String(h`${items.map((it, i) => {
    const head = it.g !== last ? h`<div class="grp">${it.g}</div>` : '';
    last = it.g;
    return h`${head}<div class="res ${i === sel ? 'on' : ''}" data-i="${i}">
      ${it.tic ? typeIcon(it.tic) : it.em ? h`<span style="width:18px;text-align:center">${it.em}</span>` : icon(it.ic || 'search', 18)}
      <span class="grow trunc">${it.label}</span>${it.sub ? h`<span class="key">${it.sub}</span>` : ''}</div>`;
  })}`) : '<div class="empty" style="padding:24px">No results</div>';
  $('.res.on', el)?.scrollIntoView({ block: 'nearest' });
}

const queryServer = debounce(async (q) => {
  if (!el || q.trim().length < 2) return;
  try { serverPages = (await get(`/search?q=${encodeURIComponent(q.trim())}`)).pages || []; } catch { return; }
  if (!el) return;
  const cur = $('input', el).value;
  if (cur === q) { items = gather(cur); sel = Math.min(sel, items.length - 1); draw(); }
}, 250);

function onKey(e) {
  if (!el) return;
  if (e.key === 'Escape') { e.stopPropagation(); close(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
  else if (e.key === 'Enter') { e.preventDefault(); const it = items[sel]; if (it) { close(); it.run(); } }
}

export function openSearch() {
  if (el) return;
  serverPages = []; sel = 0;
  el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = '<div class="palette"><input placeholder="Search tasks, pages, sprints... or jump to a screen" autocomplete="off" aria-label="Search"><div class="results"></div></div>';
  $('#overlay-root').appendChild(el);
  items = gather(''); draw();
  const input = $('input', el);
  input.focus();
  input.addEventListener('input', () => { sel = 0; serverPages = []; items = gather(input.value); draw(); queryServer(input.value); });
  el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
  $('.results', el).addEventListener('click', (e) => { const r = e.target.closest('[data-i]'); if (r) { const it = items[Number(r.dataset.i)]; close(); it.run(); } });
  document.addEventListener('keydown', onKey, true);
}
void raw; void esc;
