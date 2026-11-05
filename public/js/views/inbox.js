// Inbox: notifications (mentions, assignments, replies, watched changes, due dates).
import { get, post } from '../api.js';
import { S, user, changed } from '../store.js';
import { h, raw, icon, avatarOf, timeAgo, empty } from '../ui.js';
import { A, go } from '../actions.js';

let tab = 'all';
let loading = false;

/** Load notifications once (live ones are added by the WebSocket handler). */
export async function ensureNotifications() {
  if (S.notifications || loading) return;
  loading = true;
  try { const r = await get('/notifications?limit=100'); S.notifications = r.notifications; S.unread = r.unreadCount; }
  finally { loading = false; }
  changed();
}

const ICON = { mention: 'message', reply: 'message', assigned: 'users', watched_update: 'eye', due_soon: 'clock', overdue: 'clock' };

export async function openNotification(n) {
  if (!n.readAt) {
    n.readAt = new Date().toISOString();
    S.unread = Math.max(0, S.unread - 1); changed();
    post('/notifications/read', { ids: [n.id] }).catch(() => {});
  }
  if (n.entityType === 'page') go(`#/pages/${n.entityId}`); else go(`#/task/${n.entityId}`);
}

export function feedItem(n) {
  const actor = user(n.actorId);
  return h`<div class="feed-i ${n.readAt ? '' : 'unread'}" data-act="open-notification" data-id="${n.id}">
    ${actor ? avatarOf(n.actorId, 32) : h`<span class="avatar" style="--s:32px;background:#64748b">${icon(ICON[n.type] || 'bell', 16)}</span>`}
    <div class="grow"><div>${n.data?.title || 'Notification'}</div>${n.data?.detail ? h`<div class="muted sm trunc">${n.data.detail}</div>` : ''}<div class="xs faint">${timeAgo(n.createdAt)}</div></div>
    ${n.readAt ? '' : raw('<span class="dot" style="background:var(--teal);margin-top:8px"></span>')}</div>`;
}

A['open-notification'] = (el) => { const n = (S.notifications || []).find((x) => x.id === el.dataset.id); if (n) openNotification(n); };
A['notif-tab'] = (el) => { tab = el.dataset.tab; changed(); };
A['notif-read-all'] = async () => {
  const r = await post('/notifications/read', { all: true });
  (S.notifications || []).forEach((n) => { n.readAt ||= new Date().toISOString(); });
  S.unread = r.unreadCount; changed();
};

export default function inbox() {
  ensureNotifications();
  const all = S.notifications || [];
  const list = tab === 'unread' ? all.filter((n) => !n.readAt) : all;
  return {
    title: 'Inbox', subtitle: S.unread ? `${S.unread} unread` : 'You are all caught up',
    actions: S.unread ? h`<button class="btn" data-act="notif-read-all">${icon('check', 15)} Mark all read</button>` : '',
    body: h`<div class="page-narrow"><div class="tabs">${[['all', 'All'], ['unread', 'Unread']].map(([k, l]) => h`<button class="tab ${tab === k ? 'on' : ''}" data-act="notif-tab" data-tab="${k}">${l}${k === 'unread' && S.unread ? h`<span class="count">${S.unread}</span>` : ''}</button>`)}</div>
      <div class="card">${!S.notifications ? h`<div class="empty"><p>Loading...</p></div>` : list.length ? list.map(feedItem) : empty('inbox', tab === 'unread' ? 'No unread notifications' : 'Nothing here yet', 'Mentions, assignments, replies and due dates show up here.')}</div></div>`,
  };
}
