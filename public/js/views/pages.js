// Pages: nested documentation with a markdown editor, live preview, autosave, comments and files.
import { get, post, patch, del, upload } from '../api.js';
import { S, user, page, canWrite, isAdmin, onLiveEvent, changed, upsertLocal, removeLocal, isFavorite, toggleFavorite, visit } from '../store.js';
import { h, raw, icon, esc, avatar, openModal, toast, openMenu, confirmDialog, timeAgo, fmtDateTime, fileSize, debounce, empty, closeModal } from '../ui.js';
import { renderMd, toggleCheckbox } from '../md.js';
import { A, C, I, DRAG, go } from '../actions.js';
import { quickPage, pageTemplateModal } from '../forms.js';

const P = { id: null, page: null, loading: false, mode: 'view', draft: null, saveState: 'saved', conflict: null, comments: [], files: [], replyTo: null, missing: false };
const reset = (id) => Object.assign(P, { id, page: null, loading: true, mode: 'view', draft: null, saveState: 'saved', conflict: null, comments: [], files: [], replyTo: null, missing: false });

async function loadPage(id) {
  try {
    const [p, comments, files] = await Promise.all([get(`/pages/${id}`), get(`/comments?targetType=page&targetId=${id}`), get(`/attachments?targetType=page&targetId=${id}`)]);
    if (P.id !== id) return;
    Object.assign(P, { page: p, comments, files, loading: false });
    if (!p.content && canWrite()) P.mode = 'edit'; // a brand new page opens ready to type
    visit('page', id);
  } catch (e) { if (P.id === id) Object.assign(P, { loading: false, missing: true }); }
  changed();
}
const reloadComments = async () => { if (P.id) { P.comments = await get(`/comments?targetType=page&targetId=${P.id}`); changed(); } };
const reloadFiles = async () => { if (P.id) { P.files = await get(`/attachments?targetType=page&targetId=${P.id}`); changed(); } };

onLiveEvent((ev) => {
  if (!P.id) return;
  if (ev.type === 'page.updated' && ev.page.id === P.id && ev.page.updatedBy !== S.me.id) {
    if (P.draft == null) { P.page = ev.page; changed(); } else { P.conflict = ev.page; changed(); }
  } else if (ev.type === 'page.deleted' && ev.ids.includes(P.id)) { toast('This page was deleted'); go('#/pages'); }
  else if (ev.type.startsWith('comment.') && (ev.comment?.targetId || ev.targetId) === P.id) reloadComments();
  else if (ev.type === 'attachment.changed' && ev.targetId === P.id) reloadFiles();
});

// ------------------------------------------------------------ saving
const flush = async () => {
  if (P.draft == null || !P.page) return;
  const sent = P.draft;
  P.saveState = 'saving'; paintState();
  try {
    const out = await patch(`/pages/${P.id}`, { content: sent, baseUpdatedAt: P.page.updatedAt });
    P.page = out; upsertLocal('pages', out);
    if (P.draft === sent) P.draft = null;
    P.saveState = P.draft == null ? 'saved' : 'dirty'; paintState();
    if (P.draft != null) autosave();
  } catch (e) {
    if (e.status === 409) { P.conflict = e.data.current; P.saveState = 'conflict'; changed(); }
    else { P.saveState = 'error'; paintState(); toast(e.message, 'error'); }
  }
};
const autosave = debounce(flush, 1200);
const STATE_TEXT = { saved: 'Saved', saving: 'Saving...', dirty: 'Unsaved changes', error: 'Could not save', conflict: 'Edit conflict' };
function paintState() { const el = document.getElementById('save-state'); if (el) el.textContent = STATE_TEXT[P.saveState]; }

I['page-src'] = (el) => {
  P.draft = el.value; P.saveState = 'dirty'; paintState();
  const pv = document.getElementById('page-preview'); if (pv) pv.innerHTML = String(renderMd(el.value));
  autosave();
};
C['page-title'] = async (el) => {
  const title = el.value.trim() || 'Untitled';
  const out = await patch(`/pages/${P.id}`, { title }); P.page = { ...P.page, ...out, content: P.draft ?? out.content }; upsertLocal('pages', out); changed();
};
A['page-mode'] = async (el) => { if (el.dataset.mode === 'view') { autosave.cancel(); await flush(); } P.mode = el.dataset.mode; changed(); };
A['page-save-now'] = async () => { autosave.cancel(); await flush(); };

A['conflict-take-theirs'] = () => { P.page = P.conflict; P.draft = null; P.conflict = null; P.saveState = 'saved'; changed(); };
A['conflict-keep-mine'] = async () => { P.page = { ...P.page, updatedAt: P.conflict.updatedAt }; P.conflict = null; await flush(); changed(); };

// checkbox ticks in the rendered page
document.addEventListener('change', async (e) => {
  if (!e.target.matches?.('[data-md-check]') || e.target.closest('[data-md-src]')?.dataset.mdSrc !== 'page' || !P.page || !canWrite()) return;
  P.draft = toggleCheckbox(P.draft ?? P.page.content, Number(e.target.dataset.mdCheck));
  P.page = { ...P.page, content: P.draft }; changed(); await flush();
});

// ------------------------------------------------------------ toolbar
const TOOLS = [['bold', 'B', 'Bold'], ['italic', 'I', 'Italic'], ['h2', 'H2', 'Heading'], ['h3', 'H3', 'Subheading'], ['ul', '• List', 'Bulleted list'], ['ol', '1. List', 'Numbered list'], ['check', '☑ Tasks', 'Checklist'], ['quote', '❝', 'Quote'], ['code', '</>', 'Code block'], ['link', 'Link', 'Link'], ['table', 'Table', 'Table'], ['hr', '—', 'Divider'], ['mention', '@', 'Mention someone'], ['image', 'Image', 'Upload an image']];
function insertMd(kind) {
  const ta = document.querySelector('[data-fid="page-src"]'); if (!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value, sel = v.slice(s, e);
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  const wrap = (a, b = a, ph = 'text') => { ta.setRangeText(`${a}${sel || ph}${b}`, s, e, 'end'); };
  const prefix = (p) => { ta.setRangeText(p, lineStart, lineStart, 'preserve'); ta.selectionStart = ta.selectionEnd = e + p.length; };
  ({
    bold: () => wrap('**'), italic: () => wrap('*'), code: () => wrap('\n```\n', '\n```\n', 'code'), link: () => wrap('[', '](https://)', 'link text'),
    h2: () => prefix('## '), h3: () => prefix('### '), ul: () => prefix('- '), ol: () => prefix('1. '), check: () => prefix('- [ ] '), quote: () => prefix('> '),
    hr: () => ta.setRangeText('\n---\n', s, e, 'end'),
    table: () => ta.setRangeText('\n| Column | Column |\n|---|---|\n|  |  |\n', s, e, 'end'),
    mention: () => { ta.setRangeText('@', s, e, 'end'); },
    image: () => document.getElementById('page-img')?.click(),
  })[kind]();
  ta.focus(); ta.dispatchEvent(new Event('input', { bubbles: true }));
}
A['md-tool'] = (el) => insertMd(el.dataset.t);
C['page-img'] = async (el) => {
  const files = [...el.files]; el.value = ''; if (!files.length) return;
  try {
    const out = await upload('page', P.id, files);
    const ta = document.querySelector('[data-fid="page-src"]');
    if (ta) { ta.setRangeText(out.map((f) => `\n![${f.fileName}](${f.url}?inline=1)\n`).join(''), ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    await reloadFiles();
  } catch (e) { toast(e.message, 'error'); }
};

// ------------------------------------------------------------ page actions
const EMOJIS = ['📄', '📘', '📋', '🗓️', '⚖️', '🔁', '🚀', '💡', '🎯', '🛠️', '🧪', '📊', '🔒', '🐛', '📝', '📌', '⭐', '🏁', '🧭', '📦'];
A['page-icon'] = () => {
  if (!canWrite()) return;
  openModal({
    title: 'Choose an icon', submit: 'Use this icon', body: h`<div class="row wrap" style="gap:6px;margin-bottom:12px">${EMOJIS.map((e) => h`<button type="button" class="icon-btn" style="font-size:22px;width:42px;height:42px" data-act="icon-pick" data-e="${e}">${e}</button>`)}</div>
      <div class="field"><label>Or type any emoji</label><input name="icon" class="input" maxlength="8" value="${P.page.icon}"></div>`,
    onSubmit: async (v) => { if (v.icon?.trim()) { const out = await patch(`/pages/${P.id}`, { icon: v.icon.trim() }); P.page = { ...P.page, icon: out.icon }; upsertLocal('pages', out); } },
  });
};
A['icon-pick'] = (el) => { const f = document.querySelector('.modal input[name=icon]'); if (f) f.value = el.dataset.e; };
A['page-sub'] = () => quickPage(P.id).catch((e) => toast(e.message, 'error'));
A['page-fav'] = () => toggleFavorite('page', P.id);
function descendants(id) { const out = new Set([id]); let grew = true; while (grew) { grew = false; for (const p of S.pages) if (p.parentId && out.has(p.parentId) && !out.has(p.id)) { out.add(p.id); grew = true; } } return out; }
A['page-move'] = () => {
  const banned = descendants(P.id);
  openModal({
    title: 'Move page', submit: 'Move', body: h`<div class="field"><label>New parent</label><select class="select" name="parentId"><option value="">Top level</option>${S.pages.filter((p) => !banned.has(p.id)).map((p) => h`<option value="${p.id}" ${p.id === P.page.parentId ? raw('selected') : ''}>${p.icon} ${p.title}</option>`)}</select></div>`,
    onSubmit: async (v) => { const out = await patch(`/pages/${P.id}`, { parentId: v.parentId || null }); P.page = { ...P.page, parentId: out.parentId }; upsertLocal('pages', out); },
  });
};
A['page-del'] = async () => {
  const kids = [...descendants(P.id)].length - 1;
  if (!(await confirmDialog(`Delete "${P.page.title}"${kids ? ` and its ${kids} subpage${kids > 1 ? 's' : ''}` : ''}? Comments and files on them are deleted too.`))) return;
  const ids = [...descendants(P.id)];
  await del(`/pages/${P.id}`); ids.forEach((i) => removeLocal('pages', i)); go('#/pages');
};
A['page-more'] = (el) => openMenu(el, [
  { label: 'Move to...', icon: 'layers', onClick: A['page-move'] }, { label: 'Add subpage', icon: 'plus', onClick: A['page-sub'] },
  { label: 'Copy link', icon: 'link', onClick: () => navigator.clipboard?.writeText(`${location.origin}/#/pages/${P.id}`).then(() => toast('Copied')) },
  'sep', { label: 'Delete page', icon: 'trash', danger: true, onClick: A['page-del'] },
]);
A['tpl-create'] = async (el) => { const p = await post('/pages', { template: el.dataset.key }); upsertLocal('pages', p); go(`#/pages/${p.id}`); };

// files & comments
async function doUpload(files) { if (!files.length || !canWrite()) return; try { await upload('page', P.id, files); toast('Uploaded'); await reloadFiles(); } catch (e) { toast(e.message, 'error'); } }
C['page-upload'] = async (el) => { await doUpload([...el.files]); el.value = ''; };
DRAG['files-page'] = (z, files) => doUpload(files);
A['pfile-del'] = async (el) => { if (await confirmDialog('Remove this file?', { okLabel: 'Remove' })) { await del(`/attachments/${el.dataset.id}`); await reloadFiles(); } };
A['pc-send'] = async () => { const ta = document.querySelector('[data-fid="pc-new"]'); const body = ta.value.trim(); if (!body) return; ta.value = ''; await post('/comments', { targetType: 'page', targetId: P.id, body }); await reloadComments(); };
A['pc-reply'] = (el) => { P.replyTo = el.dataset.id; changed(); };
A['pc-reply-send'] = async (el) => { const ta = document.querySelector(`[data-fid="pc-reply-${el.dataset.id}"]`); const body = ta?.value.trim(); if (!body) return; P.replyTo = null; await post('/comments', { targetType: 'page', targetId: P.id, parentId: el.dataset.id, body }); await reloadComments(); };
A['pc-del'] = async (el) => { if (await confirmDialog('Delete this comment?')) { await del(`/comments/${el.dataset.id}`); await reloadComments(); } };

function commentBlock(c, replies = [], isReply = false) {
  const a = user(c.authorId);
  return h`<div class="comment ${isReply ? 'reply' : ''} ${c.deleted ? 'deleted' : ''}">${avatar(a, isReply ? 26 : 32)}<div class="bubble">
    <div class="meta"><b>${a?.name || 'Former member'}</b><span class="muted xs">${timeAgo(c.createdAt)}</span></div>
    <div class="body">${c.deleted ? 'This comment was deleted.' : renderMd(c.body)}</div>
    ${c.deleted ? '' : h`<div class="c-actions">${canWrite() && !isReply ? h`<button class="linkbtn" data-act="pc-reply" data-id="${c.id}">Reply</button>` : ''}${c.authorId === S.me.id || isAdmin() ? h`<button class="linkbtn" data-act="pc-del" data-id="${c.id}">Delete</button>` : ''}</div>`}
    ${replies.map((r) => commentBlock(r, [], true))}
    ${P.replyTo === c.id ? h`<div class="composer" style="margin-top:8px"><textarea data-fid="pc-reply-${c.id}" data-mentions placeholder="Write a reply..."></textarea><div class="bar-r"><span></span><button class="btn sm primary" data-act="pc-reply-send" data-id="${c.id}">Reply</button></div></div>` : ''}</div></div>`;
}

// ------------------------------------------------------------ views
function crumbs(p) {
  const chain = []; let cur = p;
  while (cur?.parentId) { cur = page(cur.parentId); if (cur) chain.unshift(cur); else break; }
  return h`<div class="crumbs"><a href="#/pages">Pages</a>${chain.map((c) => h`${icon('chevR', 12)}<a href="#/pages/${c.id}">${c.icon} ${c.title}</a>`)}</div>`;
}

function editor() {
  if (P.missing) return { title: 'Page not found', body: h`<div class="card">${empty('doc', 'Page not found', 'It may have been deleted.', raw('<a class="btn" href="#/pages">Back to pages</a>'))}</div>` };
  if (!P.page) return { title: 'Loading...', body: h`<div class="muted">Loading...</div>` };
  const p = P.page, w = canWrite();
  const content = P.draft ?? p.content;
  const kids = S.pages.filter((x) => x.parentId === p.id).sort((a, b) => a.position - b.position);
  const fav = isFavorite('page', p.id);
  const roots = P.comments.filter((c) => !c.parentId);
  const toolbar = h`<div class="md-toolbar">${TOOLS.map(([k, l, t]) => h`<button type="button" data-act="md-tool" data-t="${k}" title="${t}">${l}</button>`)}<input type="file" id="page-img" accept="image/*" hidden data-change="page-img"></div>`;
  const src = h`<textarea class="md-source" data-fid="page-src" data-input="page-src" data-mentions spellcheck="true" placeholder="Start writing... Use the toolbar, markdown, [[Page links]], task keys like ${S.project.key}-1, and @ to mention.">${content}</textarea>`;
  const body = h`<div class="page-narrow">
    ${crumbs(p)}
    <div class="editor-title"><button class="icon-pick" data-act="page-icon" title="Change icon">${p.icon}</button>
      <input class="title-input" data-fid="page-title" data-restore="no" data-change="page-title" value="${p.title}" ${w ? '' : raw('disabled')} aria-label="Page title" maxlength="200"></div>
    <div class="row wrap" style="margin-bottom:14px"><span class="muted sm">Edited ${timeAgo(p.updatedAt)}${p.updatedBy ? ` by ${user(p.updatedBy)?.name || 'someone'}` : ''}</span>
      ${w && P.mode !== 'view' ? h`<span class="save-state" id="save-state">${STATE_TEXT[P.saveState]}</span>` : ''}
      <span class="right row">${w ? h`<div class="seg">${[['view', 'View'], ['edit', 'Edit'], ['split', 'Split']].map(([m, l]) => h`<button data-act="page-mode" data-mode="${m}" class="${P.mode === m ? 'on' : ''}">${l}</button>`)}</div>` : ''}
        <button class="icon-btn" data-act="page-fav" title="${fav ? 'Remove from favorites' : 'Add to favorites'}" style="color:${fav ? '#f59e0b' : ''}">${icon('star', 17)}</button>
        ${w ? h`<button class="icon-btn" data-act="page-more" aria-label="More">${icon('more', 17)}</button>` : ''}</span></div>
    ${P.conflict ? h`<div class="warn-box">${icon('history', 18)}<div class="grow"><b>${user(P.conflict.updatedBy)?.name || 'Someone'} saved a newer version of this page.</b><div class="sm">Your unsaved edits would overwrite theirs.</div></div><button class="btn sm" data-act="conflict-take-theirs">Use their version</button><button class="btn sm" data-act="conflict-keep-mine">Keep mine</button></div>` : ''}
    ${P.mode === 'view' || !w ? h`<div class="card"><div class="card-b" style="min-height:120px" data-md-src="page">${content ? renderMd(content) : h`<span class="faint">This page is empty.${w ? ' Press Edit to start writing.' : ''}</span>`}</div></div>`
      : P.mode === 'edit' ? h`${toolbar}${src}`
        : h`${toolbar}<div class="split">${src}<div class="card" style="border-radius:0 0 10px 10px;border-top:0"><div class="card-b" id="page-preview">${renderMd(content)}</div></div></div>`}
    ${kids.length ? h`<div class="sec-title" style="margin-top:24px">Subpages</div><div class="page-links">${kids.map((k) => h`<a class="tile" href="#/pages/${k.id}"><span class="t-ic">${k.icon}</span><b class="trunc">${k.title}</b></a>`)}</div>` : ''}
    ${w ? h`<div style="margin-top:12px"><button class="btn sm" data-act="page-sub">${icon('plus', 13)} Add subpage</button></div>` : ''}
    <div data-filedrop="page" style="margin-top:26px"><div class="sec-title">${icon('clip', 15)} Files <span class="count-badge">${P.files.length}</span>${w ? h`<label class="btn sm right" style="cursor:pointer">${icon('plus', 13)} Upload<input type="file" multiple hidden data-change="page-upload"></label>` : ''}</div>
      ${P.files.length ? h`<div class="files">${P.files.map((f) => h`<div class="file"><div class="f-ic">${/^image\//.test(f.mime) ? raw(`<img src="${esc(f.url)}?inline=1" alt="">`) : esc((f.fileName.split('.').pop() || 'FILE').slice(0, 4).toUpperCase())}</div><div class="grow" style="min-width:0"><a class="name trunc" href="${f.url}" download>${f.fileName}</a><span class="muted xs">${fileSize(f.sizeBytes)}</span></div>${w && (f.uploaderId === S.me.id || isAdmin()) ? h`<button class="icon-btn x" data-act="pfile-del" data-id="${f.id}" aria-label="Remove">${icon('x', 14)}</button>` : ''}</div>`)}</div>` : h`<div class="muted sm">${w ? 'Drop files here or use Upload.' : 'No files.'}</div>`}</div>
    <div style="margin-top:26px"><div class="sec-title">${icon('message', 15)} Comments <span class="count-badge">${P.comments.filter((c) => !c.deleted).length}</span></div>
      ${roots.map((c) => commentBlock(c, P.comments.filter((r) => r.parentId === c.id)))}${roots.length ? '' : h`<p class="muted sm">No comments yet.</p>`}
      ${w ? h`<div class="composer"><textarea data-fid="pc-new" data-mentions placeholder="Write a comment... type @ to mention"></textarea><div class="bar-r"><span></span><button class="btn sm primary" data-act="pc-send">Comment</button></div></div>` : ''}</div></div>`;
  return { title: `${p.icon} ${p.title}`, body };
}

function index() {
  const roots = S.pages.filter((p) => !p.parentId).sort((a, b) => a.position - b.position);
  const TPL = [['docs', '📘', 'Project documentation'], ['meeting', '🗓️', 'Meeting notes'], ['requirements', '📋', 'Requirements'], ['decision', '⚖️', 'Decision record'], ['retro', '🔁', 'Sprint retrospective'], ['blank', '📄', 'Blank page']];
  const body = h`<div class="page-narrow">
    ${roots.length ? h`<div class="sec-title">All pages</div><div class="page-links" style="margin-bottom:28px">${roots.map((p) => { const n = S.pages.filter((x) => x.parentId === p.id).length; return h`<a class="tile" href="#/pages/${p.id}"><span class="t-ic">${p.icon}</span><b class="trunc">${p.title}</b><small>${n ? `${n} subpage${n > 1 ? 's' : ''} · ` : ''}Edited ${timeAgo(p.updatedAt)}</small></a>`; })}</div>` : h`<div class="card" style="margin-bottom:24px">${empty('doc', 'No pages yet', 'Pages hold your project documentation, meeting notes, requirements and decisions.')}</div>`}
    ${canWrite() ? h`<div class="sec-title">Start from a template</div><div class="page-links">${TPL.map(([k, e, n]) => h`<button class="tile" data-act="tpl-create" data-key="${k}" style="text-align:left;font:inherit;cursor:pointer"><span class="t-ic">${e}</span><b>${n}</b></button>`)}</div>` : ''}</div>`;
  return { title: 'Pages', subtitle: 'Project documentation', actions: canWrite() ? h`<button class="btn primary" data-act="new-page-modal">${icon('plus', 16)} New page</button>` : '', body };
}
A['new-page-modal'] = () => pageTemplateModal(null);

export default function pages(params) {
  const id = params[0];
  if (!id) { if (P.id) { P.id = null; } return index(); }
  if (P.id !== id) { reset(id); loadPage(id); }
  const out = editor();
  out.after = (root) => { if (P.mode !== 'view') { const ta = root.querySelector('[data-fid="page-src"]'); if (ta && !P.focused) { ta.focus(); P.focused = true; } } else P.focused = false; };
  return out;
}
void closeModal; void fmtDateTime;
