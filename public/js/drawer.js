// Task slide-over: properties, description, attachments, subtasks, links, comments, time, activity.
import { get, post, patch, del, upload } from './api.js';
import { S, user, status, label, sprint, milestone, task, childrenOf, activeUsers, canWrite, isAdmin, isDone, firstTodo, doneStatus, saveTask, createTask, removeTasks, onLiveEvent, changed, isFavorite, toggleFavorite, visit } from './store.js';
import { h, raw, icon, esc, avatar, avatarOf, typeIcon, TYPE, priorityPill, statusPill, labelChip, ring, fmtDate, fmtDue, fmtDateTime, timeAgo, fmtMinutes, parseDuration, fileSize, toast, openMenu, confirmDialog, copyText, taskProgress, today, debounce } from './ui.js';
import { renderMd, toggleCheckbox } from './md.js';
import { A, C, K, DRAG, go } from './actions.js';
import { newTaskModal } from './forms.js';

const D = { taskId: null, tab: 'comments', editDesc: false, loaded: false, detail: null, comments: [], files: [], replyTo: null, editComment: null };
const EMOJI = ['👍', '❤️', '🎉', '😄', '👀', '🚀', '✅', '🙏'];
const sel = (v, cur) => (v === cur ? raw('selected') : '');
const dis = () => (canWrite() ? '' : raw('disabled'));

export function drawerClosed() { Object.assign(D, { taskId: null, loaded: false, detail: null, comments: [], files: [], editDesc: false, replyTo: null, editComment: null }); }

async function loadDetail(id) {
  try {
    const [detail, comments, files] = await Promise.all([get(`/tasks/${id}`), get(`/comments?targetType=task&targetId=${id}`), get(`/attachments?targetType=task&targetId=${id}`)]);
    if (D.taskId !== id) return;
    Object.assign(D, { detail, comments, files, loaded: true });
  } catch { if (D.taskId === id) D.loaded = true; }
  changed();
}
// Each reload only refreshes the screen when something actually changed, so quiet echoes of our own saves cause no flicker.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reloadComments = async () => { const id = D.taskId; if (!id) return; const v = await get(`/comments?targetType=task&targetId=${id}`); if (D.taskId !== id || same(v, D.comments)) return; D.comments = v; changed(); };
const reloadFiles = async () => { const id = D.taskId; if (!id) return; const v = await get(`/attachments?targetType=task&targetId=${id}`); if (D.taskId !== id || same(v, D.files)) return; D.files = v; changed(); };
const reloadDetail = async () => { const id = D.taskId; if (!id) return; const v = await get(`/tasks/${id}`); if (D.taskId !== id || same(v, D.detail)) return; D.detail = v; changed(); };
const reloadDetailSoon = debounce(reloadDetail, 300); // several live events in a row become one reload

// keep open drawer current when teammates act
onLiveEvent((ev) => {
  if (!D.taskId) return;
  if (ev.type.startsWith('comment.') && (ev.targetType === 'task' ? ev.targetId : ev.comment?.targetId) === D.taskId) reloadComments();
  else if (ev.type === 'attachment.changed' && ev.targetId === D.taskId) reloadFiles();
  else if (ev.type === 'task.linked' || ev.type === 'task.unlinked') reloadDetailSoon();
  else if (ev.type === 'task.updated' && ev.task.id === D.taskId) reloadDetailSoon();
});

// ------------------------------------------------------------ rendering
function props(t) {
  const sprints = S.sprints.filter((s) => s.status !== 'completed' || s.id === t.sprintId);
  const rec = t.recurrence;
  const recVal = !rec ? '' : rec.every === 1 ? rec.unit : 'custom';
  const logged = t.loggedMin;
  const watching = t.watcherIds.includes(S.me.id);
  const row = (ic, k, v) => h`<div class="k">${icon(ic, 15)}${k}</div><div class="v">${v}</div>`;
  const field = (name, extra = '') => raw(`data-change="d-field" data-field="${name}" ${extra}`);
  return h`<div class="props">
    ${row('target', 'Status', h`<select class="select bare" ${field('statusId')} ${dis()} style="font-weight:600;color:${status(t.statusId)?.color}">${S.statuses.map((s) => h`<option value="${s.id}" ${sel(s.id, t.statusId)}>${s.name}</option>`)}</select>`)}
    ${row('arrowUp', 'Priority', h`<select class="select bare" ${field('priority')} ${dis()}>${['low', 'medium', 'high', 'critical'].map((p) => h`<option value="${p}" ${sel(p, t.priority)}>${p[0].toUpperCase() + p.slice(1)}</option>`)}</select>`)}
    ${row('users', 'Assignee', h`${avatarOf(t.assigneeId, 24)}<select class="select bare" ${field('assigneeId')} ${dis()}><option value="">Unassigned</option>${activeUsers().map((u) => h`<option value="${u.id}" ${sel(u.id, t.assigneeId)}>${u.name}</option>`)}</select>`)}
    ${row('edit', 'Reporter', h`${avatarOf(t.reporterId, 24)}<span class="sm">${user(t.reporterId)?.name || 'Unknown'}</span>`)}
    ${row('list', 'Type', h`<select class="select bare" ${field('type')} ${dis()}>${Object.entries(TYPE).map(([k, v]) => h`<option value="${k}" ${sel(k, t.type)}>${v.label}</option>`)}</select>`)}
    ${row('bolt', 'Sprint', h`<select class="select bare" ${field('sprintId')} ${dis()}><option value="">Backlog</option>${sprints.map((s) => h`<option value="${s.id}" ${sel(s.id, t.sprintId)}>${s.name}${s.status === 'active' ? ' (active)' : ''}</option>`)}</select>`)}
    ${row('flag', 'Milestone', h`<select class="select bare" ${field('milestoneId')} ${dis()}><option value="">None</option>${S.milestones.map((m) => h`<option value="${m.id}" ${sel(m.id, t.milestoneId)}>${m.name}</option>`)}</select>`)}
    ${row('star', 'Labels', h`${S.labels.map((l) => { const on = t.labelIds.includes(l.id); return h`<button type="button" class="chip" data-act="d-label" data-id="${l.id}" style="--c:${l.color};border:0;cursor:pointer;opacity:${on ? 1 : 0.4}" ${canWrite() ? '' : raw('disabled')} title="${on ? 'Remove' : 'Add'} label">${l.name}</button>`; })}${S.labels.length ? '' : h`<span class="faint sm">No labels yet (add them in Settings)</span>`}`)}
    ${row('calendar', 'Start date', h`<input type="date" class="input bare" ${field('startDate')} value="${t.startDate || ''}" ${dis()}>`)}
    ${row('calendar', 'Due date', h`<input type="date" class="input bare ${t.dueDate && !isDone(t) && t.dueDate < today() ? 'due-over' : ''}" ${field('dueDate')} value="${t.dueDate || ''}" ${dis()}>`)}
    ${row('chart', 'Story points', h`<input type="number" min="0" step="0.5" class="input bare" style="width:90px" ${field('points', 'data-t="num"')} value="${t.points ?? ''}" ${dis()}>`)}
    ${row('clock', 'Estimate', h`<input class="input bare" style="width:110px" ${field('estimateMin', 'data-t="dur"')} value="${t.estimateMin ? fmtMinutes(t.estimateMin) : ''}" placeholder="e.g. 4h" ${dis()}>`)}
    ${row('repeat', 'Repeats', h`<select class="select bare" ${field('recurrence', 'data-t="rec"')} ${dis()}><option value="">Does not repeat</option>${[['day', 'Every day'], ['week', 'Every week'], ['month', 'Every month'], ['year', 'Every year']].map(([u, l]) => h`<option value="${u}" ${sel(u, recVal)}>${l}</option>`)}${rec && rec.every > 1 ? h`<option value="custom" selected>Every ${rec.every} ${rec.unit}s</option>` : ''}</select>`)}
    ${row('eye', 'Watchers', h`<span class="avatars">${t.watcherIds.map((id) => avatarOf(id, 24))}</span><span class="muted sm">${t.watcherIds.length}</span>
      ${canWrite() ? h`<select class="select bare sm" style="width:auto" data-change="d-add-watcher" aria-label="Add watcher"><option value="">+ Add</option>${activeUsers().filter((u) => !t.watcherIds.includes(u.id)).map((u) => h`<option value="${u.id}">${u.name}</option>`)}</select>` : ''}`)}
    ${t.childCount ? row('check', 'Progress', h`<div class="bar" style="width:160px"><i style="width:${taskProgress(t)}%"></i></div><span class="muted sm">${t.childDone}/${t.childCount} subtasks</span>`) : ''}
    ${t.parentId && task(t.parentId) ? row('layers', 'Parent', h`<a href="#/task/${t.parentId}">${task(t.parentId).key} ${task(t.parentId).title}</a>`) : ''}
    ${t.completedAt ? row('check', 'Completed', h`<span class="sm">${fmtDateTime(t.completedAt)}</span>`) : ''}
    ${row('history', 'Created', h`<span class="muted sm">${fmtDateTime(t.createdAt)}${t.updatedAt !== t.createdAt ? ` · updated ${timeAgo(t.updatedAt)}` : ''}</span>`)}
    ${void watching ?? ''}
  </div>`;
}

function descBlock(t) {
  if (D.editDesc && canWrite()) {
    return h`<div class="composer" style="margin-bottom:18px"><textarea data-fid="d-desc" data-mentions placeholder="Describe the task... (markdown, @ to mention)" style="min-height:140px">${t.description}</textarea>
      <div class="bar-r"><span class="hint">Ctrl+Enter to save</span><span class="row"><button class="btn sm" data-act="desc-cancel">Cancel</button><button class="btn sm primary" data-act="desc-save">Save</button></span></div></div>`;
  }
  return h`<div class="desc-box ${t.description ? '' : 'empty-d'}" data-md-src="task" ${canWrite() ? raw('data-act="desc-edit"') : ''}>${t.description ? renderMd(t.description) : (canWrite() ? 'Add a description...' : 'No description')}</div>`;
}

function filesBlock() {
  const isImg = (f) => /^image\/(png|jpe?g|gif|webp)$/.test(f.mime);
  return h`<div data-filedrop="task" class="files-wrap" style="margin-bottom:18px">
    <div class="sec-title">${icon('clip', 15)} Attachments <span class="count-badge">${D.files.length}</span>${canWrite() ? h`<label class="btn sm right" style="cursor:pointer">${icon('plus', 13)} Upload<input type="file" multiple hidden data-change="d-upload"></label>` : ''}</div>
    ${D.files.length ? h`<div class="files">${D.files.map((f) => h`<div class="file"><div class="f-ic">${isImg(f) ? raw(`<img src="${esc(f.url)}?inline=1" alt="">`) : esc((f.fileName.split('.').pop() || 'FILE').slice(0, 4).toUpperCase())}</div>
      <div class="grow" style="min-width:0"><a class="name trunc" href="${f.url}" download>${f.fileName}</a><span class="muted xs">${fileSize(f.sizeBytes)}</span></div>
      ${canWrite() && (f.uploaderId === S.me.id || isAdmin()) ? h`<button class="icon-btn x" data-act="file-del" data-id="${f.id}" aria-label="Remove file">${icon('x', 14)}</button>` : ''}</div>`)}</div>`
      : h`<div class="muted sm">${canWrite() ? 'Drop files here, paste an image, or use Upload.' : 'No attachments.'}</div>`}</div>`;
}

function subtasksTab(t) {
  const kids = childrenOf(t.id);
  return h`${kids.length ? h`<div class="bar" style="margin-bottom:10px"><i style="width:${taskProgress(t)}%"></i></div>` : ''}
    ${kids.map((k) => h`<div class="sub-i"><input type="checkbox" data-act="sub-toggle" data-id="${k.id}" ${isDone(k) ? raw('checked') : ''} ${dis()} aria-label="Done">
      <span class="key">${k.key}</span><span class="t ${isDone(k) ? 'done' : ''}" data-act="open-sub" data-id="${k.id}">${k.title}</span>${k.dueDate ? h`<span class="xs muted">${fmtDue(k.dueDate)}</span>` : ''}${avatarOf(k.assigneeId, 22)}</div>`)}
    ${kids.length ? '' : h`<p class="muted sm">No subtasks yet.</p>`}
    ${canWrite() ? h`<div class="row" style="margin-top:10px"><input class="input" data-fid="sub-new" data-enter="sub-add" placeholder="Add a subtask and press Enter" aria-label="New subtask"><button class="btn" data-act="sub-modal" title="Add with details">${icon('plus', 15)}</button></div>` : ''}`;
}

const LINK_TEXT = { out: { blocks: 'blocks', relates: 'relates to', duplicates: 'duplicates' }, inn: { blocks: 'is blocked by', relates: 'relates to', duplicates: 'is duplicated by' } };
function linksTab(t) {
  const links = D.detail?.links || [];
  return h`${links.map((l) => {
    const out = l.fromTaskId === t.id; const other = task(out ? l.toTaskId : l.fromTaskId);
    return h`<div class="sub-i"><span class="muted sm" style="width:110px">${LINK_TEXT[out ? 'out' : 'inn'][l.type]}</span>${other ? h`<span class="key">${other.key}</span><span class="t ${isDone(other) ? 'done' : ''}" data-act="open-sub" data-id="${other.id}">${other.title}</span>${statusPill(status(other.statusId))}` : h`<span class="faint">(deleted task)</span>`}
      ${canWrite() ? h`<button class="icon-btn" data-act="link-del" data-id="${l.id}" aria-label="Remove link">${icon('x', 14)}</button>` : ''}</div>`;
  })}${links.length ? '' : h`<p class="muted sm">No linked tasks.</p>`}
    ${canWrite() ? h`<div class="row" style="margin-top:10px"><select class="select" style="width:150px" data-fid="link-type"><option value="blocks">blocks</option><option value="relates">relates to</option><option value="duplicates">duplicates</option></select>
      <input class="input" list="task-list" data-fid="link-to" data-enter="link-add" placeholder="Type a task key or title" aria-label="Linked task"><datalist id="task-list">${S.tasks.filter((x) => x.id !== t.id).map((x) => h`<option value="${x.key} ${x.title}"></option>`)}</datalist>
      <button class="btn" data-act="link-add-btn">Link</button></div>` : ''}`;
}

function commentHtml(c, replies = [], isReply = false) {
  const author = user(c.authorId);
  const mine = c.authorId === S.me.id;
  const editing = D.editComment === c.id;
  const reacts = Object.entries(c.reactions || {});
  return h`<div class="comment ${isReply ? 'reply' : ''} ${c.deleted ? 'deleted' : ''}" id="c-${c.id}">${avatar(author, isReply ? 26 : 32)}
    <div class="bubble"><div class="meta"><b>${author?.name || 'Former member'}</b><span class="muted xs" title="${fmtDateTime(c.createdAt)}">${timeAgo(c.createdAt)}${c.editedAt ? ' · edited' : ''}</span></div>
      ${c.deleted ? h`<div class="body">This comment was deleted.</div>`
        : editing ? h`<div class="composer"><textarea data-fid="c-edit-${c.id}" data-mentions>${c.body}</textarea><div class="bar-r"><span></span><span class="row"><button class="btn sm" data-act="c-edit-cancel">Cancel</button><button class="btn sm primary" data-act="c-edit-save" data-id="${c.id}">Save</button></span></div></div>`
          : h`<div class="body" data-md-src="comment">${renderMd(c.body)}</div>
            ${c.attachments?.length ? h`<div class="row wrap" style="margin-top:6px">${c.attachments.map((a) => h`<a class="chip" style="--c:#64748b" href="${a.url}" download>${icon('clip', 12)} ${a.fileName}</a>`)}</div>` : ''}
            <div class="c-actions">${reacts.map(([e, ids]) => h`<button class="react ${ids.includes(S.me.id) ? 'mine' : ''}" data-act="react" data-id="${c.id}" data-emoji="${e}" title="${ids.map((i) => user(i)?.name).filter(Boolean).join(', ')}">${e} ${ids.length}</button>`)}
              ${canWrite() ? h`<button class="linkbtn" data-act="react-pick" data-id="${c.id}" title="Add reaction">${icon('smile', 15)}</button>${!isReply ? h`<button class="linkbtn" data-act="c-reply" data-id="${c.id}">Reply</button>` : ''}${mine ? h`<button class="linkbtn" data-act="c-edit" data-id="${c.id}">Edit</button>` : ''}${mine || isAdmin() ? h`<button class="linkbtn" data-act="c-del" data-id="${c.id}">Delete</button>` : ''}` : ''}</div>`}
      ${replies.map((r) => commentHtml(r, [], true))}
      ${D.replyTo === c.id ? h`<div class="composer" style="margin-top:8px"><textarea data-fid="c-reply-${c.id}" data-mentions data-autofocus placeholder="Write a reply..."></textarea><div class="bar-r"><span class="hint">Ctrl+Enter to send</span><span class="row"><button class="btn sm" data-act="c-reply-cancel">Cancel</button><button class="btn sm primary" data-act="c-reply-send" data-id="${c.id}">Reply</button></span></div></div>` : ''}
    </div></div>`;
}

function commentsTab() {
  const roots = D.comments.filter((c) => !c.parentId);
  return h`${roots.map((c) => commentHtml(c, D.comments.filter((r) => r.parentId === c.id)))}
    ${roots.length ? '' : h`<p class="muted sm">No comments yet. Start the conversation.</p>`}
    ${canWrite() ? h`<div class="composer" style="margin-top:6px"><textarea data-fid="c-new" data-mentions data-paste placeholder="Write a comment... type @ to mention a teammate"></textarea>
      <div class="bar-r"><span class="hint">Ctrl+Enter to send</span><button class="btn sm primary" data-act="c-send">Comment</button></div></div>` : ''}`;
}

function timeTab(t) {
  const entries = D.detail?.time || [];
  const pct = t.estimateMin ? Math.min(100, Math.round((t.loggedMin / t.estimateMin) * 100)) : 0;
  return h`<div class="row between" style="margin-bottom:8px"><b>${fmtMinutes(t.loggedMin)} logged</b><span class="muted sm">${t.estimateMin ? `of ${fmtMinutes(t.estimateMin)} estimated` : 'No estimate'}</span></div>
    ${t.estimateMin ? h`<div class="bar" style="margin-bottom:12px"><i style="width:${pct}%;${t.loggedMin > t.estimateMin ? 'background:var(--danger)' : ''}"></i></div>` : ''}
    ${entries.map((e) => h`<div class="sub-i">${avatarOf(e.userId, 24)}<b class="sm">${fmtMinutes(e.minutes)}</b><span class="grow muted sm trunc">${e.note || ''}</span><span class="xs muted">${fmtDate(e.loggedOn)}</span>${canWrite() && (e.userId === S.me.id || isAdmin()) ? h`<button class="icon-btn" data-act="time-del" data-id="${e.id}" aria-label="Delete entry">${icon('x', 14)}</button>` : ''}</div>`)}
    ${canWrite() ? h`<div class="row wrap" style="margin-top:10px"><input class="input" style="width:110px" data-fid="time-dur" placeholder="1h 30m" aria-label="Time spent"><input class="input" style="flex:1;min-width:120px" data-fid="time-note" data-enter="time-add" placeholder="What did you work on? (optional)"><input class="input" style="width:150px" type="date" data-fid="time-date" value="${today()}" aria-label="Date"><button class="btn primary" data-act="time-add-btn">Log time</button></div>` : ''}`;
}

// ---- activity feed
const FIELD = { statusId: 'status', priority: 'priority', assigneeId: 'assignee', type: 'type', sprintId: 'sprint', milestoneId: 'milestone', dueDate: 'due date', startDate: 'start date', points: 'story points', estimateMin: 'estimate', title: 'title', description: 'description', labelIds: 'labels', parentId: 'parent task', recurrence: 'repeat rule' };
function fmtVal(k, v) {
  if (v == null || v === '') return 'none';
  if (k === 'statusId') return status(v)?.name || 'a status';
  if (k === 'assigneeId') return user(v)?.name || 'someone';
  if (k === 'sprintId') return sprint(v)?.name || 'a sprint';
  if (k === 'milestoneId') return milestone(v)?.name || 'a milestone';
  if (k === 'parentId') return task(v)?.key || 'a task';
  if (k === 'labelIds') return v.map((id) => label(id)?.name).filter(Boolean).join(', ') || 'none';
  if (k === 'estimateMin') return fmtMinutes(v);
  if (k === 'recurrence') return `every ${v.every} ${v.unit}${v.every > 1 ? 's' : ''}`;
  if (k === 'dueDate' || k === 'startDate') return fmtDate(v);
  return String(v);
}
function describe(a) {
  const who = user(a.actorId)?.name || 'Someone';
  if (a.action === 'task.create') return h`<b>${who}</b> created this task`;
  if (a.action === 'task.update') {
    const parts = Object.keys(a.after || {}).map((k) => (k === 'description' ? 'updated the description' : k === 'title' ? `renamed it to "${a.after[k]}"` : `changed ${FIELD[k] || k} from ${fmtVal(k, a.before?.[k])} to ${fmtVal(k, a.after[k])}`));
    return h`<b>${who}</b> ${parts.join('; ')}`;
  }
  if (a.action === 'task.link') return h`<b>${who}</b> linked a task (${a.after?.type})`;
  if (a.action === 'task.unlink') return h`<b>${who}</b> removed a link`;
  if (a.action === 'task.time') return h`<b>${who}</b> logged ${fmtMinutes(a.after?.minutes)}`;
  if (a.action === 'task.recur') return h`<b>${who}</b> completed it; the next repeat was created`;
  if (a.action === 'attachment.add') return h`<b>${who}</b> attached ${(a.after?.files || []).join(', ')}`;
  if (a.action === 'attachment.remove') return h`<b>${who}</b> removed ${a.before?.file || 'a file'}`;
  if (a.action.startsWith('comment.')) return h`<b>${who}</b> ${a.action.slice(8)}ed a comment`;
  return h`<b>${who}</b> ${a.action}`;
}
const activityTab = () => h`${(D.detail?.activity || []).map((a) => h`<div class="activity-i">${avatarOf(a.actorId, 24)}<div><div>${describe(a)}</div><div class="xs faint">${fmtDateTime(a.createdAt)}</div></div></div>`)}${D.detail?.activity?.length ? '' : h`<p class="muted sm">No activity recorded.</p>`}`;

export function drawer(taskId) {
  if (D.taskId !== taskId) { drawerClosed(); D.taskId = taskId; D.tab = 'comments'; loadDetail(taskId); visit('task', taskId); }
  const t = task(taskId);
  const shell = (inner, tt) => ({
    html: h`<div class="drawer-backdrop" data-act="drawer-close"></div><aside class="drawer" role="dialog" aria-label="Task details">${inner}</aside>`,
    after: (root) => { const f = root.querySelector('[data-autofocus]'); if (f && document.activeElement !== f) f.focus(); void tt; },
  });
  if (!t) {
    return shell(h`<div class="drawer-h"><span class="grow"></span><button class="icon-btn" data-act="drawer-close" aria-label="Close">${icon('x')}</button></div>
      <div class="drawer-body">${D.loaded || S.tasks.length ? h`<div class="empty"><h3>Task not found</h3><p>It may have been deleted.</p></div>` : h`<p class="muted">Loading...</p>`}</div>`);
  }
  const fav = isFavorite('task', t.id);
  const watching = t.watcherIds.includes(S.me.id);
  const tabs = [['subtasks', 'Subtasks', t.childCount], ['links', 'Links', D.detail?.links?.length || 0], ['comments', 'Comments', t.commentCount], ['time', 'Time', null], ['activity', 'Activity', null]];
  return shell(h`
    <div class="drawer-h">${typeIcon(t.type)}<span class="key">${t.key}</span><span class="grow"></span>
      ${canWrite() ? h`<button class="btn sm ${watching ? '' : 'ghost'}" data-act="d-watch">${icon('eye', 14)} ${watching ? 'Watching' : 'Watch'}</button>` : ''}
      <button class="icon-btn" data-act="d-fav" title="${fav ? 'Remove from favorites' : 'Add to favorites'}" style="color:${fav ? '#f59e0b' : ''}">${icon('star', 17)}</button>
      <button class="icon-btn" data-act="d-copy" title="Copy link">${icon('link', 17)}</button>
      ${canWrite() ? h`<button class="icon-btn" data-act="d-menu" aria-label="More">${icon('more', 17)}</button>` : ''}
      <button class="icon-btn" data-act="drawer-close" aria-label="Close">${icon('x', 18)}</button></div>
    <div class="drawer-body">
      <input class="title-input" data-fid="d-title" data-restore="no" data-change="d-title" value="${t.title}" ${dis()} aria-label="Title" maxlength="300">
      ${props(t)}
      <div class="sec-title">Description</div>${descBlock(t)}
      ${filesBlock()}
      <div class="tabs">${tabs.map(([k, l, n]) => h`<button class="tab ${D.tab === k ? 'on' : ''}" data-act="d-tab" data-tab="${k}">${l}${n ? h`<span class="count">${n}</span>` : ''}</button>`)}</div>
      ${D.tab === 'subtasks' ? subtasksTab(t) : D.tab === 'links' ? linksTab(t) : D.tab === 'comments' ? commentsTab() : D.tab === 'time' ? timeTab(t) : activityTab()}
    </div>`, t);
}

// ------------------------------------------------------------ handlers
const err = (e) => { if (e.status !== 409) toast(e.message, 'error'); else toast('Someone else just changed this task. Showing the latest version.', 'error'); };
const tid = () => D.taskId;

C['d-field'] = async (el) => {
  const f = el.dataset.field; let v = el.value;
  if (el.dataset.t === 'num') v = v === '' ? null : Number(v);
  else if (el.dataset.t === 'dur') { v = v.trim() === '' ? null : parseDuration(v); if (v === null && el.value.trim() !== '') { toast('Use a format like 1h 30m or 2d', 'error'); changed(); return; } }
  else if (el.dataset.t === 'rec') v = v === '' ? null : v === 'custom' ? task(tid()).recurrence : { every: 1, unit: v };
  else if (v === '' && ['assigneeId', 'sprintId', 'milestoneId', 'startDate', 'dueDate'].includes(f)) v = null;
  await saveTask(tid(), { [f]: v }).catch(err);
};
C['d-title'] = async (el) => { const v = el.value.trim(); if (!v) { el.value = task(tid()).title; return; } await saveTask(tid(), { title: v }).catch(err); };
A['d-label'] = async (el) => {
  const t = task(tid()); const set = new Set(t.labelIds);
  set.has(el.dataset.id) ? set.delete(el.dataset.id) : set.add(el.dataset.id);
  await saveTask(t.id, { labelIds: [...set] }).catch(err);
};
C['d-add-watcher'] = async (el) => { if (el.value) await post(`/tasks/${tid()}/watchers`, { userId: el.value }); };
A['d-watch'] = async () => { const t = task(tid()); t.watcherIds.includes(S.me.id) ? await del(`/tasks/${t.id}/watch`) : await post(`/tasks/${t.id}/watch`); };
A['d-fav'] = () => toggleFavorite('task', tid());
A['d-copy'] = () => copyText(`${location.origin}/#/task/${tid()}`);
A['d-tab'] = (el) => { D.tab = el.dataset.tab; changed(); };
A['d-menu'] = (el) => {
  const t = task(tid());
  openMenu(el, [
    { label: 'Add subtask', icon: 'plus', onClick: () => newTaskModal({ parentId: t.id, sprintId: t.sprintId || undefined, milestoneId: t.milestoneId || undefined }) },
    'sep',
    { label: 'Delete task', icon: 'trash', danger: true, onClick: async () => {
      const { deleteTask } = await import('./views/tasks.js');
      if (await deleteTask(t)) A['drawer-close']();
    } },
  ]);
};

// description
A['desc-edit'] = (el, e) => { if (e.target.closest('a,input')) return; D.editDesc = true; changed(); setTimeout(() => document.querySelector('[data-fid="d-desc"]')?.focus(), 30); };
A['desc-cancel'] = () => { D.editDesc = false; changed(); };
A['desc-save'] = async () => {
  const v = document.querySelector('[data-fid="d-desc"]').value;
  D.editDesc = false; changed();
  if (v !== task(tid()).description) await saveTask(tid(), { description: v }).catch(err);
};
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key !== 'Enter') return;
  const fid = e.target.dataset?.fid || '';
  if (fid === 'd-desc') A['desc-save']();
  else if (fid === 'c-new') A['c-send']();
  else if (fid.startsWith('c-reply-')) A['c-reply-send']({ dataset: { id: fid.slice(8) } });
  else if (fid.startsWith('c-edit-')) A['c-edit-save']({ dataset: { id: fid.slice(7) } });
});
document.addEventListener('change', (e) => { // tick boxes inside a rendered description
  if (!e.target.matches?.('[data-md-check]') || e.target.closest('[data-md-src]')?.dataset.mdSrc !== 'task') return;
  const t = task(tid()); if (!t || !canWrite()) return;
  saveTask(t.id, { description: toggleCheckbox(t.description, Number(e.target.dataset.mdCheck)) }).catch(err);
});

// attachments
async function doUpload(files) {
  if (!files.length || !canWrite()) return;
  try { await upload('task', tid(), files); toast(`${files.length} file${files.length > 1 ? 's' : ''} uploaded`); await reloadFiles(); }
  catch (e) { toast(e.message, 'error'); }
}
C['d-upload'] = async (el) => { await doUpload([...el.files]); el.value = ''; };
DRAG['files-task'] = (zone, files) => { if (D.taskId) doUpload(files); };
A['file-del'] = async (el) => { if (await confirmDialog('Remove this file?', { okLabel: 'Remove' })) { await del(`/attachments/${el.dataset.id}`); await reloadFiles(); } };
document.addEventListener('paste', (e) => { // paste a screenshot into a comment to attach it
  if (!D.taskId || !e.target.matches?.('textarea[data-paste]')) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); doUpload(files.map((f, i) => new File([f], f.name === 'image.png' ? `screenshot-${Date.now()}-${i}.png` : f.name, { type: f.type }))); }
});

// subtasks
A['sub-toggle'] = async (el) => {
  const k = task(el.dataset.id); const target = isDone(k) ? firstTodo() : doneStatus();
  await saveTask(k.id, { statusId: target.id }).catch(err);
};
A['open-sub'] = (el) => go(`#/task/${el.dataset.id}`);
K['sub-add'] = async (el) => {
  const title = el.value.trim(); if (!title) return;
  const t = task(tid()); el.value = '';
  await createTask({ title, parentId: t.id, ...(t.sprintId ? { sprintId: t.sprintId } : {}), ...(t.milestoneId ? { milestoneId: t.milestoneId } : {}) }).catch((e) => toast(e.message, 'error'));
};
A['sub-modal'] = () => { const t = task(tid()); newTaskModal({ parentId: t.id, sprintId: t.sprintId || undefined, milestoneId: t.milestoneId || undefined }); };

// links
async function addLink() {
  const type = document.querySelector('[data-fid="link-type"]').value;
  const text = document.querySelector('[data-fid="link-to"]').value.trim();
  const key = text.split(/\s+/)[0].toUpperCase();
  const other = S.tasks.find((x) => x.key === key) || S.tasks.find((x) => x.title.toLowerCase() === text.toLowerCase());
  if (!other) return toast('Pick a task from the list (type its key, like FORGE-3)', 'error');
  await post(`/tasks/${tid()}/links`, { toTaskId: other.id, type });
  document.querySelector('[data-fid="link-to"]').value = '';
  await reloadDetail();
}
K['link-add'] = addLink; A['link-add-btn'] = addLink;
A['link-del'] = async (el) => { await del(`/links/${el.dataset.id}`); await reloadDetail(); };

// comments
A['c-send'] = async () => {
  const ta = document.querySelector('[data-fid="c-new"]'); const body = ta.value.trim(); if (!body) return;
  ta.value = ''; await post('/comments', { targetType: 'task', targetId: tid(), body }); await reloadComments();
};
A['c-reply'] = (el) => { D.replyTo = el.dataset.id; changed(); };
A['c-reply-cancel'] = () => { D.replyTo = null; changed(); };
A['c-reply-send'] = async (el) => {
  const ta = document.querySelector(`[data-fid="c-reply-${el.dataset.id}"]`); const body = ta?.value.trim(); if (!body) return;
  D.replyTo = null; await post('/comments', { targetType: 'task', targetId: tid(), parentId: el.dataset.id, body }); await reloadComments();
};
A['c-edit'] = (el) => { D.editComment = el.dataset.id; changed(); };
A['c-edit-cancel'] = () => { D.editComment = null; changed(); };
A['c-edit-save'] = async (el) => {
  const body = document.querySelector(`[data-fid="c-edit-${el.dataset.id}"]`)?.value.trim(); if (!body) return;
  D.editComment = null; await patch(`/comments/${el.dataset.id}`, { body }); await reloadComments();
};
A['c-del'] = async (el) => { if (await confirmDialog('Delete this comment?')) { await del(`/comments/${el.dataset.id}`); await reloadComments(); } };
const react = async (id, emoji) => { await post(`/comments/${id}/reactions`, { emoji }); await reloadComments(); };
A.react = (el) => react(el.dataset.id, el.dataset.emoji);
A['react-pick'] = (el) => {
  closeEmoji(); const pop = document.createElement('div');
  pop.className = 'menu emoji-pop'; pop.id = 'emoji-pop'; pop.innerHTML = EMOJI.map((e) => `<button type="button" data-e="${e}">${e}</button>`).join('');
  document.body.appendChild(pop);
  const r = el.getBoundingClientRect(); pop.style.left = `${Math.min(r.left, innerWidth - pop.offsetWidth - 8)}px`; pop.style.top = `${r.bottom + 4}px`;
  pop.onclick = (ev) => { const b = ev.target.closest('[data-e]'); if (b) { closeEmoji(); react(el.dataset.id, b.dataset.e); } };
  setTimeout(() => document.addEventListener('click', closeEmoji, { once: true }), 0);
};
function closeEmoji() { document.getElementById('emoji-pop')?.remove(); }

// time
async function addTime() {
  const mins = parseDuration(document.querySelector('[data-fid="time-dur"]').value);
  if (!mins) return toast('Enter the time spent, like 1h 30m', 'error');
  await post(`/tasks/${tid()}/time`, { minutes: mins, note: document.querySelector('[data-fid="time-note"]').value.trim(), loggedOn: document.querySelector('[data-fid="time-date"]').value || undefined });
  document.querySelector('[data-fid="time-dur"]').value = ''; document.querySelector('[data-fid="time-note"]').value = '';
  await reloadDetail();
}
K['time-add'] = addTime; A['time-add-btn'] = addTime;
A['time-del'] = async (el) => { await del(`/time/${el.dataset.id}`); await reloadDetail(); };

void removeTasks; void priorityPill; void labelChip; void ring; void esc;
