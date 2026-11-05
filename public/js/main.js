// App entry: boot, auth gate, shell (sidebar + top bar), router, global event delegation.
import { get, post, onUnauthorized } from './api.js';
import { S, loadAll, connect, disconnect, subscribe, setHooks, changed, canWrite, isAdmin, favoritesList } from './store.js';
import { A, C, I, K, go } from './actions.js';
import { h, raw, icon, $, $$, avatar, openMenu, closeMenu, closeMentions, handleMentionInput, toast, openModal, closeModal } from './ui.js';
import { initDnd } from './dnd.js';
import { newTaskModal, quickPage, pageTemplateModal, sprintModal, milestoneModal } from './forms.js';
import { openSearch } from './search.js';
import * as auth from './auth.js';

// Views are loaded on demand: each exports default(params) -> { title, subtitle?, actions?, body, after? }
const VIEWS = {
  home: () => import('./views/home.js'), 'my-tasks': () => import('./views/tasks.js').then((m) => ({ default: m.myTasks })),
  inbox: () => import('./views/inbox.js'), backlog: () => import('./views/tasks.js').then((m) => ({ default: m.backlog })),
  board: () => import('./views/tasks.js').then((m) => ({ default: m.board })), list: () => import('./views/tasks.js').then((m) => ({ default: m.list })),
  calendar: () => import('./views/calendar.js'), timeline: () => import('./views/timeline.js'),
  sprints: () => import('./views/planning.js').then((m) => ({ default: m.sprints })), milestones: () => import('./views/planning.js').then((m) => ({ default: m.milestones })),
  reports: () => import('./views/reports.js'), pages: () => import('./views/pages.js'), team: () => import('./views/team.js'), settings: () => import('./views/settings.js'),
};

const NAV = [
  { h: 'General', items: [['home', 'Home', 'home'], ['my-tasks', 'My Tasks', 'checkCircle'], ['inbox', 'Inbox', 'inbox']] },
  { h: 'Project', items: [['backlog', 'Backlog', 'layers'], ['board', 'Board', 'board'], ['list', 'List', 'list'], ['calendar', 'Calendar', 'calendar'], ['timeline', 'Timeline', 'timeline'], ['sprints', 'Sprints', 'bolt'], ['milestones', 'Milestones', 'flag'], ['reports', 'Reports', 'chart']] },
];

// ---------------------------------------------------------------- routing
export const ui = { taskId: null, base: '#/home' };
function parseRoute() {
  const hash = location.hash || '#/home';
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const name = parts[0] || 'home';
  if (name === 'task') { ui.taskId = parts[1] || null; return { name: ui.base.replace(/^#\//, '').split('/')[0] || 'home', params: ui.base.replace(/^#\//, '').split('/').slice(1), hash: ui.base }; }
  ui.taskId = null; ui.base = hash;
  return { name: VIEWS[name] ? name : 'home', params: parts.slice(1), hash };
}

// ---------------------------------------------------------------- boot
async function afterAuth() { location.hash = '#/home'; await start(); }
async function start() {
  await loadAll();
  connect();
  mountShell();
  await render();
}
async function boot() {
  let m;
  if ((m = /^#\/invite\/(.+)$/.exec(location.hash))) return auth.showInvite(decodeURIComponent(m[1]), afterAuth);
  if ((m = /^#\/signin\/(.+)$/.exec(location.hash))) return auth.showLink(decodeURIComponent(m[1]), afterAuth);
  let st;
  try { st = await get('/auth/status'); }
  catch { return void ($('#app').innerHTML = '<div class="auth"><div class="auth-card"><h1>Cannot reach the server</h1><p>Check your connection and reload.</p></div></div>'); }
  if (st.user) return start();
  if (st.needsSetup) return auth.showSetup(afterAuth);
  auth.showLogin(afterAuth);
}
function signedOut(message) {
  S.ready = false; disconnect(); closeModal(); $('#drawer-root').innerHTML = '';
  location.hash = '#/';
  auth.showLogin(afterAuth);
  if (message) toast(message, 'error');
}
onUnauthorized(() => { if (S.ready) signedOut('Your session ended. Please sign in again.'); });
setHooks({ notification: (n) => toast(n.data?.title || 'New notification') });

// ---------------------------------------------------------------- shell
function mountShell() {
  $('#app').innerHTML = String(h`<div class="app">
    <aside class="side" id="side"></aside>
    <div class="main"><header class="top" id="top"></header><main class="content" id="content"></main></div></div>`);
}

const treeOpen = new Set(JSON.parse(localStorage.getItem('forge.treeopen') || '[]'));
const saveTree = () => localStorage.setItem('forge.treeopen', JSON.stringify([...treeOpen]));

function treeHtml(parentId, depth, currentId) {
  const kids = S.pages.filter((p) => (p.parentId || null) === parentId).sort((a, b) => a.position - b.position);
  return kids.map((p) => {
    const hasKids = S.pages.some((x) => x.parentId === p.id);
    const open = treeOpen.has(p.id);
    return h`<a class="tree-i ${p.id === currentId ? 'on' : ''}" href="#/pages/${p.id}" style="padding-left:${8 + depth * 14}px">
      ${hasKids ? h`<button class="tw ${open ? 'open' : ''}" data-act="tree-toggle" data-id="${p.id}" aria-label="Toggle">${icon('chevR', 13)}</button>` : raw('<span class="tw"></span>')}
      <span class="em">${p.icon}</span><span class="grow trunc">${p.title}</span>
      ${canWrite() ? h`<button class="add" data-act="tree-add" data-id="${p.id}" title="Add a page inside">${icon('plus', 14)}</button>` : ''}</a>
      ${hasKids && open ? treeHtml(p.id, depth + 1, currentId) : ''}`;
  });
}

function favHtml() {
  const items = favoritesList();
  if (!items.length) return '';
  return h`<div class="nav-h">Favorites</div>${items.map((f) => h`<a class="tree-i" href="${f.href}"><span class="em">${f.icon}</span><span class="grow trunc">${f.title}</span></a>`)}`;
}

function sideHtml(route) {
  const curPage = route.name === 'pages' ? route.params[0] : null;
  return h`
    <div class="brand"><div class="logo">${icon('check', 18)}</div><div><b>${S.project.name}</b><small>Project workspace</small></div></div>
    ${canWrite() ? h`<button class="btn primary create" data-act="create-menu">${icon('plus', 16)} Create</button>` : ''}
    ${NAV.map((g) => h`<div class="nav-h">${g.h}</div>${g.items.map(([key, label, ic]) => h`<a class="nav-i ${route.name === key ? 'on' : ''}" href="#/${key}">${icon(ic, 18)}<span>${label}</span>${key === 'inbox' && S.unread ? h`<span class="badge">${S.unread > 99 ? '99+' : S.unread}</span>` : ''}</a>`)}`)}
    ${favHtml()}
    <div class="nav-h"><a href="#/pages" style="color:inherit">Pages</a>${canWrite() ? h`<button data-act="page-menu" title="New page">${icon('plus', 15)}</button>` : ''}</div>
    <div>${S.pages.length ? treeHtml(null, 0, curPage) : h`<div class="faint sm" style="padding:4px 10px">No pages yet</div>`}</div>
    <div class="side-foot">
      ${S.connected ? '' : h`<div class="conn">Reconnecting...</div>`}
      <a class="nav-i ${route.name === 'team' ? 'on' : ''}" href="#/team">${icon('users', 18)}<span>Team</span></a>
      <a class="nav-i ${route.name === 'settings' ? 'on' : ''}" href="#/settings">${icon('settings', 18)}<span>Settings</span></a>
      <button class="me-chip" data-act="user-menu">${avatar(S.me, 32)}<div class="grow"><b class="trunc" style="display:block">${S.me.name}</b><span class="muted xs" style="text-transform:capitalize">${S.me.role}</span></div>${icon('more', 16)}</button>
    </div>`;
}

function topHtml(view) {
  return h`<button class="icon-btn menu-btn" data-act="nav-open" aria-label="Menu">${icon('menu')}</button>
    <div class="grow" style="min-width:0"><h1 class="trunc">${view.title}</h1>${view.subtitle ? h`<div class="sub trunc">${view.subtitle}</div>` : ''}</div>
    ${view.actions || ''}
    <div class="searchbox" data-act="search-open" role="button" tabindex="0">${icon('search', 16)}<span>Search</span><kbd class="kbd">Ctrl K</kbd></div>
    <a class="icon-btn" href="#/inbox" aria-label="Inbox">${icon('bell')}${S.unread ? h`<span class="badge">${S.unread > 99 ? '99+' : S.unread}</span>` : ''}</a>`;
}

// ---------------------------------------------------------------- rendering
let renderSeq = 0;
/** Remember typed text/focus in fields marked data-fid so a live update never wipes what you are typing. */
function snapshotFields(scope) {
  const out = {};
  $$('[data-fid]', scope).forEach((el) => { out[el.dataset.fid] = { value: el.value, checked: el.checked, start: el.selectionStart, end: el.selectionEnd, focus: el === document.activeElement }; });
  return out;
}
function restoreFields(scope, snap) {
  for (const [id, s] of Object.entries(snap)) {
    const el = scope.querySelector(`[data-fid="${CSS.escape(id)}"]`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = s.checked; else if (el.value !== s.value && el.dataset.restore !== 'no') el.value = s.value;
    if (s.focus) { el.focus(); try { el.setSelectionRange(s.start, s.end); } catch { /* not a text field */ } }
  }
}

export async function render() {
  if (!S.ready) return;
  const seq = ++renderSeq;
  const route = parseRoute();
  const loader = VIEWS[route.name];
  let view;
  try { view = (await loader()).default(route.params); }
  catch (e) { console.error(e); view = { title: 'Something went wrong', body: h`<div class="empty"><h3>This screen failed to load</h3><p>${e.message}</p></div>` }; }
  if (seq !== renderSeq) return; // a newer render started while we waited

  const content = $('#content'), main = $('.main');
  if (!content) return;
  const scrollY = window.scrollY, snap = snapshotFields(document.body);
  const boardScroll = $('.board')?.scrollLeft || 0;

  $('#side').innerHTML = String(sideHtml(route));
  $('#top').innerHTML = String(topHtml(view));
  content.innerHTML = String(view.body);
  document.title = `${view.title} | ${S.project.name}`;

  const nb = $('.board'); if (nb) nb.scrollLeft = boardScroll;
  window.scrollTo(0, scrollY);
  view.after?.(content);
  await renderDrawer();
  restoreFields(document.body, snap);
  void main;
}

async function renderDrawer() {
  const root = $('#drawer-root');
  if (!ui.taskId) { if (root.innerHTML) { root.innerHTML = ''; (await import('./drawer.js')).drawerClosed(); } return; }
  const d = await import('./drawer.js');
  const prevScroll = $('.drawer-body')?.scrollTop || 0;
  const out = d.drawer(ui.taskId);
  root.innerHTML = String(out.html);
  const body = $('.drawer-body'); if (body) body.scrollTop = prevScroll;
  out.after?.(root);
}

subscribe(() => render());
window.addEventListener('hashchange', () => { closeMenu(); render(); });

// ---------------------------------------------------------------- global actions
A['nav-open'] = () => $('#side').classList.toggle('open');
A['search-open'] = () => openSearch();
A['tree-toggle'] = (el, e) => { e.preventDefault(); e.stopPropagation(); const id = el.dataset.id; treeOpen.has(id) ? treeOpen.delete(id) : treeOpen.add(id); saveTree(); changed(); };
A['tree-add'] = (el, e) => { e.preventDefault(); e.stopPropagation(); treeOpen.add(el.dataset.id); saveTree(); quickPage(el.dataset.id).catch((x) => toast(x.message, 'error')); };
A['page-menu'] = (el) => openMenu(el, [
  { label: 'Blank page', icon: 'doc', onClick: () => quickPage(null).catch((x) => toast(x.message, 'error')) },
  { label: 'From a template...', icon: 'copy', onClick: () => pageTemplateModal(null) },
]);
A['create-menu'] = (el) => openMenu(el, [
  { label: 'Task', icon: 'checkCircle', onClick: () => newTaskModal() },
  { label: 'Page', icon: 'doc', onClick: () => pageTemplateModal(null) },
  { label: 'Sprint', icon: 'bolt', onClick: () => sprintModal() },
  { label: 'Milestone', icon: 'flag', onClick: () => milestoneModal() },
], { align: 'left' });

const THEMES = [['', 'Match my device'], ['light', 'Light'], ['dark', 'Dark']];
A['user-menu'] = (el) => openMenu(el, [
  { label: 'Profile & notifications', icon: 'settings', onClick: () => go('#/settings/profile') },
  ...THEMES.map(([val, label]) => ({ label: `Theme: ${label}`, icon: 'moon', onClick: () => setTheme(val) })),
  'sep',
  { label: 'Sign out', icon: 'logout', danger: true, onClick: async () => { try { await post('/auth/logout'); } catch { /* ignore */ } signedOut(); } },
], { align: 'left' });

export function setTheme(val) {
  if (val) document.documentElement.dataset.theme = val; else delete document.documentElement.dataset.theme;
  try { val ? localStorage.setItem('forge.theme', val) : localStorage.removeItem('forge.theme'); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- delegated DOM events
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) {
    if (!e.target.closest('.side') && window.innerWidth <= 860) $('#side')?.classList.remove('open');
    return;
  }
  const fn = A[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A' && el.dataset.keepdefault == null && !el.getAttribute('href')?.startsWith('#')) e.preventDefault();
  Promise.resolve(fn(el, e)).catch((err) => { console.error(err); toast(err.message || 'Something went wrong', 'error'); });
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && C[el.dataset.change]) Promise.resolve(C[el.dataset.change](el, e)).catch((err) => toast(err.message, 'error'));
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.matches?.('textarea[data-mentions]')) handleMentionInput(el);
  const t = el.closest?.('[data-input]');
  if (t && I[t.dataset.input]) I[t.dataset.input](t, e);
});
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === 'Enter' && !e.shiftKey && e.target.dataset?.enter && K[e.target.dataset.enter]) {
    e.preventDefault(); Promise.resolve(K[e.target.dataset.enter](e.target, e)).catch((err) => toast(err.message, 'error')); return;
  }
  if (e.key === 'Enter' && e.target.dataset?.act && e.target.getAttribute('role') === 'button') { A[e.target.dataset.act]?.(e.target, e); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
  if (e.key === 'Escape') {
    closeMentions(); closeMenu();
    if (!$('.modal-backdrop') && ui.taskId) { go(ui.base); }
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); openSearch(); }
  else if (e.key === 'c' && canWrite() && S.ready && !$('.modal-backdrop')) { e.preventDefault(); newTaskModal(); }
});

// "Close" for the task drawer: go back to the screen underneath
A['drawer-close'] = () => go(ui.base);
A['open-task'] = (el, e) => { if (e.target.closest('input,select,button,a')) return; go(`#/task/${el.dataset.id}`); };

initDnd();
boot();
void isAdmin; void closeModal; void openModal;
