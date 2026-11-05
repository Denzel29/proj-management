// Client-side state: loaded once from /api/bootstrap, then kept current by WebSocket events.
import { get, post, patch, put, del } from './api.js';

export const S = {
  ready: false, me: null, project: null,
  statuses: [], labels: [], users: [], tasks: [], sprints: [], milestones: [], templates: [], favorites: [], pages: [],
  unread: 0, online: new Set(), notifications: null, // notifications are fetched when the inbox opens
  connected: false,
};

// ---------------------------------------------------------------- indexes
let idx = {};
function reindex() {
  const m = (arr) => new Map(arr.map((x) => [x.id, x]));
  const children = new Map();
  for (const t of S.tasks) if (t.parentId) { if (!children.has(t.parentId)) children.set(t.parentId, []); children.get(t.parentId).push(t); }
  idx = {
    users: m(S.users), statuses: m(S.statuses), labels: m(S.labels), sprints: m(S.sprints),
    milestones: m(S.milestones), tasks: m(S.tasks), pages: m(S.pages), children,
    byKey: new Map(S.tasks.map((t) => [t.key, t])),
  };
}
export const user = (id) => idx.users?.get(id) || null;
export const status = (id) => idx.statuses?.get(id) || null;
export const label = (id) => idx.labels?.get(id) || null;
export const sprint = (id) => idx.sprints?.get(id) || null;
export const milestone = (id) => idx.milestones?.get(id) || null;
export const task = (id) => idx.tasks?.get(id) || null;
export const taskByKey = (key) => idx.byKey?.get(key) || null;
export const page = (id) => idx.pages?.get(id) || null;
export const childrenOf = (id) => (idx.children?.get(id) || []).slice().sort((a, b) => a.rank - b.rank);

export const activeUsers = () => S.users.filter((u) => u.active);
export const isDone = (t) => t.statusCategory === 'done';
export const firstTodo = () => S.statuses.find((s) => s.category === 'todo') || S.statuses[0];
export const doneStatus = () => S.statuses.find((s) => s.category === 'done');
export const activeSprint = () => S.sprints.find((s) => s.status === 'active') || null;
export const canWrite = () => S.me && S.me.role !== 'viewer';
export const isAdmin = () => S.me && S.me.role === 'admin';
export const byRank = (a, b) => a.rank - b.rank || a.num - b.num;

// ---------------------------------------------------------------- change notification
const subs = new Set();
let queued = false;
/**
 * Subscribers run once per animation frame however many events arrive. A short timer is the
 * fallback because browsers pause animation frames in background tabs.
 */
export function changed() {
  if (queued) return;
  queued = true;
  const run = () => { if (!queued) return; queued = false; subs.forEach((f) => f()); };
  requestAnimationFrame(run);
  setTimeout(run, 50);
}
export const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };

// Non-state events (comments, attachments...) that open panels listen to directly.
const listeners = new Set();
export const onLiveEvent = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

let hooks = { notification: () => {}, signedOut: () => {} };
export const setHooks = (h) => { hooks = { ...hooks, ...h }; };

// ---------------------------------------------------------------- loading
export async function loadAll() {
  const b = await get('/bootstrap');
  S.me = b.me; S.project = b.project; S.statuses = b.statuses; S.labels = b.labels; S.users = b.users;
  S.tasks = b.tasks; S.sprints = b.sprints; S.milestones = b.milestones; S.templates = b.templates;
  S.favorites = b.favorites; S.pages = b.pages; S.unread = b.unreadCount; S.ready = true;
  reindex(); changed();
}
export async function refreshTasks() { S.tasks = await get('/tasks'); reindex(); changed(); }

function upsert(arr, item) {
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) arr[i] = item; else arr.push(item);
}

// ---------------------------------------------------------------- tasks
export function upsertTask(t) { upsert(S.tasks, t); reindex(); changed(); }
export function removeTasks(ids) { const s = new Set(ids); S.tasks = S.tasks.filter((t) => !s.has(t.id)); reindex(); changed(); }

const saveQueue = new Map();
/**
 * Change a task. The screen updates immediately; requests for the same task run one at a time
 * so each one carries the latest version. A conflict re-syncs the task from the server.
 */
export function saveTask(id, patchData) {
  const local = task(id);
  if (!local) return Promise.resolve(null);
  Object.assign(local, patchData); // optimistic
  if ('statusId' in patchData) { const st = status(patchData.statusId); if (st) local.statusCategory = st.category; }
  changed();
  const run = async () => {
    const cur = task(id);
    try {
      const out = await patch(`/tasks/${id}`, { ...patchData, version: cur?.version });
      upsertTask(out.task);
      if (out.spawned) upsertTask(out.spawned);
      return out.task;
    } catch (err) {
      if (err.status === 409 && err.data?.current) upsertTask(err.data.current);
      else await refreshTasks();
      throw err;
    }
  };
  const next = (saveQueue.get(id) || Promise.resolve()).catch(() => {}).then(run);
  saveQueue.set(id, next);
  return next;
}

export async function createTask(data) {
  const t = await post('/tasks', data);
  upsertTask(t);
  return t;
}

/** Apply an API response to local state right away (the WebSocket event repeats it harmlessly). */
export function upsertLocal(kind, obj) {
  const arr = { sprints: S.sprints, milestones: S.milestones, labels: S.labels, templates: S.templates, pages: S.pages }[kind];
  if (!arr) return;
  const slim = kind === 'pages' ? { id: obj.id, title: obj.title, icon: obj.icon, parentId: obj.parentId, position: obj.position, updatedAt: obj.updatedAt } : obj;
  upsert(arr, slim); reindex(); changed();
}
export function removeLocal(kind, id) {
  S[kind] = S[kind].filter((x) => x.id !== id); reindex(); changed();
}

/** Rank that places an item between two neighbours (either may be missing). */
export function rankBetween(prev, next) {
  if (prev != null && next != null) return (prev + next) / 2;
  if (prev != null) return prev + 1000;
  if (next != null) return next - 1000;
  return 1000;
}

// ---------------------------------------------------------------- favorites / recents
export const isFavorite = (type, id) => S.favorites.some((f) => f.entityType === type && f.entityId === id);
export async function toggleFavorite(type, id) {
  if (isFavorite(type, id)) { await del(`/favorites/${type}/${id}`); S.favorites = S.favorites.filter((f) => !(f.entityType === type && f.entityId === id)); }
  else { await put('/favorites', { entityType: type, entityId: id }); S.favorites.push({ entityType: type, entityId: id, position: Date.now() }); }
  changed();
}
export function visit(type, id) { post('/recent', { entityType: type, entityId: id }).catch(() => {}); }

/** Favorites resolved to something displayable (items whose target was deleted are skipped). */
export function favoritesList() {
  const out = [];
  for (const f of S.favorites) {
    if (f.entityType === 'page') { const p = page(f.entityId); if (p) out.push({ href: `#/pages/${p.id}`, icon: p.icon, title: p.title }); }
    else if (f.entityType === 'task') { const t = task(f.entityId); if (t) out.push({ href: `#/task/${t.id}`, icon: '☑️', title: `${t.key} ${t.title}` }); }
    else if (f.entityType === 'sprint') { const s = sprint(f.entityId); if (s) out.push({ href: '#/sprints', icon: '⚡', title: s.name }); }
    else if (f.entityType === 'milestone') { const m = milestone(f.entityId); if (m) out.push({ href: '#/milestones', icon: '🚩', title: m.name }); }
  }
  return out;
}

// ---------------------------------------------------------------- live events
function applyEvent(ev) {
  switch (ev.type) {
    case 'hello': break;
    case 'presence': S.online = new Set(ev.online); changed(); break;
    case 'task.created': case 'task.updated': upsertTask(ev.task); break;
    case 'task.deleted': removeTasks(ev.ids); break;
    case 'task.watchers': { const t = task(ev.taskId); if (t) { t.watcherIds = ev.watcherIds; changed(); } break; }
    case 'tasks.refresh': refreshTasks(); break;
    case 'sprint.created': case 'sprint.updated': upsert(S.sprints, ev.sprint); reindex(); changed(); break;
    case 'sprint.deleted': S.sprints = S.sprints.filter((s) => s.id !== ev.id); reindex(); changed(); break;
    case 'milestone.created': case 'milestone.updated': upsert(S.milestones, ev.milestone); reindex(); changed(); break;
    case 'milestone.deleted': S.milestones = S.milestones.filter((m) => m.id !== ev.id); reindex(); changed(); break;
    case 'label.upserted': upsert(S.labels, ev.label); reindex(); changed(); break;
    case 'label.deleted': S.labels = S.labels.filter((l) => l.id !== ev.id); reindex(); changed(); break;
    case 'statuses.updated': S.statuses = ev.statuses; reindex(); changed(); break;
    case 'template.upserted': upsert(S.templates, ev.template); changed(); break;
    case 'template.deleted': S.templates = S.templates.filter((t) => t.id !== ev.id); changed(); break;
    case 'project.updated': S.project = { ...S.project, ...ev.project }; changed(); break;
    case 'user.joined': case 'user.updated': upsert(S.users, ev.user); if (ev.user.id === S.me.id) S.me = ev.user; reindex(); changed(); break;
    case 'page.created': case 'page.updated': upsert(S.pages, { id: ev.page.id, title: ev.page.title, icon: ev.page.icon, parentId: ev.page.parentId, position: ev.page.position, updatedAt: ev.page.updatedAt }); reindex(); changed(); break;
    case 'page.deleted': S.pages = S.pages.filter((p) => !ev.ids.includes(p.id)); reindex(); changed(); break;
    case 'notification':
      S.unread++; if (S.notifications) S.notifications.unshift(ev.notification);
      hooks.notification(ev.notification); changed(); break;
    default: break;
  }
  listeners.forEach((f) => f(ev));
}

// ---------------------------------------------------------------- websocket with reconnect
let ws = null, retry = 0, closed = false;
export function connect() {
  closed = false;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    const wasDown = retry > 0;
    retry = 0; S.connected = true; changed();
    if (wasDown) loadAll().catch(() => {}); // catch up on anything missed while offline
  };
  ws.onmessage = (m) => { try { applyEvent(JSON.parse(m.data)); } catch (e) { console.error(e); } };
  ws.onclose = () => {
    S.connected = false; changed();
    if (closed) return;
    retry++;
    setTimeout(connect, Math.min(15000, 800 * 2 ** Math.min(retry, 5)));
  };
  ws.onerror = () => ws.close();
}
export function disconnect() { closed = true; ws?.close(); }
export { hooks };
