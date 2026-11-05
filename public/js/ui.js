// UI helpers: safe HTML templating, icons, avatars, pills, dates, modals, menus, toasts.
import { S, user, status, label, sprint, milestone } from './store.js';

// ------------------------------------------------------------ safe templating
// h`...` escapes every interpolated value unless it is already Safe (produced by h or raw()).
export class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s ?? ''));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function part(v) {
  if (v == null || v === false || v === true) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}
export function h(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return new Safe(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------ icons (stroke icons, 24px grid)
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  board: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v12"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  timeline: '<path d="M4 6h9M8 12h12M6 18h8"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  flag: '<path d="M5 21V4m0 0h11l-2 4 2 4H5"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  chevD: '<path d="m6 9 6 6 6-6"/>',
  chevL: '<path d="m15 18-6-6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  star: '<path d="m12 2 3 6.9 7.5.7-5.7 5 1.7 7.4L12 18l-6.5 4 1.7-7.4-5.7-5 7.5-.7z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  clip: '<path d="m21 11-9 9a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.3-8.3"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  repeat: '<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  play: '<path d="m6 4 14 8-14 8z"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
};
export function icon(name, size = 18, cls = '') {
  return raw(`<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);
}

// ------------------------------------------------------------ dates
const pad = (n) => String(n).padStart(2, '0');
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => isoDate(new Date());
export const parseDate = (s) => { if (!s) return null; const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return isoDate(d); };
export const diffDays = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);
export const fmtDate = (s) => (s ? parseDate(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
export const fmtDateY = (s) => (s ? parseDate(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
export function fmtDue(s) {
  if (!s) return '';
  const d = diffDays(today(), s);
  const y = parseDate(s).getFullYear() === new Date().getFullYear() ? fmtDate(s) : fmtDateY(s);
  return d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d === -1 ? 'Yesterday' : y;
}
export function timeAgo(ts) {
  const sec = Math.max(1, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
  if (sec < 60) return 'just now';
  const m = Math.round(sec / 60); if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60); if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24); if (d < 7) return `${d}d ago`;
  return fmtDateY(isoDate(new Date(ts)));
}
export const fmtDateTime = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export function fmtMinutes(min) {
  if (!min) return '0m';
  const hr = Math.floor(min / 60), m = min % 60;
  return hr ? (m ? `${hr}h ${m}m` : `${hr}h`) : `${m}m`;
}
/** "1h 30m", "90m", "1.5h", "2d" -> minutes (8h days). Returns null when unparsable. */
export function parseDuration(text) {
  const t = String(text).trim().toLowerCase();
  if (!t) return null;
  let total = 0, matched = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m)?/g)) {
    const n = parseFloat(m[1]); const u = m[2] || 'm'; matched = true;
    total += u === 'd' ? n * 480 : u === 'h' ? n * 60 : n;
  }
  return matched ? Math.round(total) : null;
}

// ------------------------------------------------------------ small components
export function initials(name = '') {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase() || '?';
}
export function avatar(u, size = 28) {
  if (!u) return raw(`<span class="avatar none" style="--s:${size}px" title="Unassigned">${icon('users', Math.round(size * 0.55))}</span>`);
  const online = S.online.has(u.id);
  return h`<span class="avatar" style="--s:${size}px;background:${u.color}" title="${u.name}">${initials(u.name)}${online ? raw('<i class="presence"></i>') : ''}</span>`;
}
export const avatarOf = (id, size) => avatar(user(id), size);

export const TYPE = {
  task: { label: 'Task', glyph: '✓', color: '#3b82f6' }, story: { label: 'Story', glyph: '★', color: '#22c55e' },
  bug: { label: 'Bug', glyph: '●', color: '#ef4444' }, improvement: { label: 'Improvement', glyph: '▲', color: '#8b5cf6' },
  epic: { label: 'Epic', glyph: '⚡', color: '#f59e0b' },
};
export const typeIcon = (t) => { const x = TYPE[t] || TYPE.task; return raw(`<span class="type-ic" style="background:${x.color}" title="${x.label}">${x.glyph}</span>`); };

export const PRIORITY = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
export const priorityPill = (p) => raw(`<span class="pill prio-${p}">${PRIORITY[p] || p}</span>`);

export function statusPill(st) {
  if (!st) return '';
  return h`<span class="pill status" style="--c:${st.color}"><i></i>${st.name}</span>`;
}
export function labelChip(l) { return h`<span class="chip" style="--c:${l.color}">${l.name}</span>`; }

/** Small ring showing 0-100 progress. */
export function ring(pct, size = 22) {
  const r = (size - 4) / 2, c = 2 * Math.PI * r, off = c * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return raw(`<span class="ring" title="${Math.round(pct)}%"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--border)" stroke-width="3"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--teal)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg><b>${Math.round(pct)}%</b></span>`);
}

export const empty = (iconName, title, text = '', action = '') =>
  h`<div class="empty">${icon(iconName, 34)}<h3>${title}</h3>${text ? h`<p>${text}</p>` : ''}${action}</div>`;

/** Task progress: subtasks done, or 100/0 from status. */
export function taskProgress(t) {
  if (t.childCount) return Math.round((t.childDone / t.childCount) * 100);
  return t.statusCategory === 'done' ? 100 : 0;
}

export function sprintLabel(id) { const s = sprint(id); return s ? s.name : ''; }
export function milestoneLabel(id) { const m = milestone(id); return m ? m.name : ''; }

// ------------------------------------------------------------ toasts
export function toast(msg, kind = 'info', ms = 3500) {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, ms);
}

// ------------------------------------------------------------ modal
let modalEl = null;
export function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; document.removeEventListener('keydown', escClose); } }
function escClose(e) { if (e.key === 'Escape') closeModal(); }

/**
 * Open a modal containing a form. `onSubmit(values, form)` may return false to keep it open.
 * Fields use name="..." attributes; values come from FormData (repeated names become arrays).
 */
export function openModal({ title, body, submit = 'Save', onSubmit, wide = false, danger = false, hideCancel = false }) {
  closeModal();
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = String(h`
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <form>
        <header><h2>${title}</h2><button type="button" class="icon-btn" data-modal-close aria-label="Close">${icon('x')}</button></header>
        <div class="modal-body">${body}</div>
        ${onSubmit ? h`<footer>${hideCancel ? '' : raw('<button type="button" class="btn" data-modal-close>Cancel</button>')}<button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${submit}</button></footer>` : ''}
      </form>
    </div>`);
  $('#overlay-root').appendChild(wrap);
  modalEl = wrap;
  document.addEventListener('keydown', escClose);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closeModal(); });
  wrap.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', closeModal));
  const form = $('form', wrap);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const fd = new FormData(form);
    const values = {};
    for (const k of new Set(fd.keys())) { const all = fd.getAll(k); values[k] = all.length > 1 ? all : all[0]; }
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try { if ((await onSubmit(values, form)) !== false) closeModal(); }
    catch (err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; }
  });
  // focus the first text field (a leading dropdown, like the template picker, should not steal it)
  setTimeout(() => ($('input[type=text], input[type=email], input:not([type]), textarea', form) || $('input:not([type=hidden]), select', form))?.focus(), 30);
  return { el: wrap, form };
}

export function confirmDialog(message, { okLabel = 'Delete', danger = true, title = 'Are you sure?' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({ title, body: h`<p class="muted">${message}</p>`, submit: okLabel, danger, onSubmit: () => { done = true; resolve(true); } });
    m.el.addEventListener('remove-check', () => {});
    const observer = new MutationObserver(() => { if (!document.body.contains(m.el)) { observer.disconnect(); if (!done) resolve(false); } });
    observer.observe($('#overlay-root'), { childList: true });
  });
}

// ------------------------------------------------------------ popover menu
let menuEl = null;
export function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
/** Show a menu next to `anchor`. items: [{label, icon, danger, onClick}] or 'sep'. */
export function openMenu(anchor, items, { align = 'right' } = {}) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = String(h`${items.map((it, i) => (it === 'sep' ? raw('<hr>') : h`<button type="button" class="menu-item ${it.danger ? 'danger' : ''}" data-i="${i}">${it.icon ? icon(it.icon, 16) : ''}<span>${it.label}</span></button>`))}`);
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  m.style.left = `${left}px`; m.style.top = `${top}px`;
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]'); if (!b) return;
    closeMenu(); items[Number(b.dataset.i)].onClick?.();
  });
  menuEl = m;
  setTimeout(() => document.addEventListener('click', outside, { once: true }), 0);
  function outside(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); else if (menuEl) document.addEventListener('click', outside, { once: true }); }
}

// ------------------------------------------------------------ @mention autocomplete for textareas
let mentionBox = null;
export function closeMentions() { mentionBox?.remove(); mentionBox = null; }

/** Call on `input` events for any <textarea data-mentions>. */
export function handleMentionInput(ta) {
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const m = /(^|\s)@([\w .'-]{0,30})$/.exec(before);
  if (!m) return closeMentions();
  const q = m[2].toLowerCase();
  const people = S.users.filter((u) => u.active && u.name.toLowerCase().includes(q)).slice(0, 6);
  if (!people.length) return closeMentions();
  closeMentions();
  mentionBox = document.createElement('div');
  mentionBox.className = 'menu mention-menu';
  mentionBox.innerHTML = String(h`${people.map((u) => h`<button type="button" class="menu-item" data-uid="${u.id}">${avatar(u, 20)}<span>${u.name}</span></button>`)}`);
  document.body.appendChild(mentionBox);
  const r = ta.getBoundingClientRect();
  mentionBox.style.left = `${Math.min(r.left + 12, window.innerWidth - 240)}px`;
  mentionBox.style.top = `${Math.min(r.bottom + 4, window.innerHeight - mentionBox.offsetHeight - 8)}px`;
  mentionBox.onmousedown = (e) => {
    e.preventDefault();
    const b = e.target.closest('[data-uid]'); if (!b) return;
    const u = user(b.dataset.uid);
    const start = pos - m[2].length - 1;
    const token = `@[${u.name}](user:${u.id}) `;
    ta.value = ta.value.slice(0, start) + token + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = start + token.length;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    closeMentions();
  };
}

// ------------------------------------------------------------ misc
export function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Could not copy', 'error'));
}
export const debounce = (fn, ms = 400) => { let t; const f = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; f.flush = (...a) => { clearTimeout(t); fn(...a); }; f.cancel = () => clearTimeout(t); return f; };
export function fileSize(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
export const greeting = () => { const hr = new Date().getHours(); return hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'; };
