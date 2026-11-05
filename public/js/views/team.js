// Team: members, roles, presence, and (for admins) invites and account controls.
import { get, post, patch, del } from '../api.js';
import { S, isAdmin, isDone, changed, upsertLocal, removeLocal, refreshTasks } from '../store.js';
import { h, raw, icon, avatar, openModal, toast, openMenu, confirmDialog, copyText, timeAgo, fmtDateY, empty } from '../ui.js';
import { A, K } from '../actions.js';

let invites = null;
let loadingInv = false;
async function loadInvites() {
  if (!isAdmin() || loadingInv) return;
  loadingInv = true;
  try { invites = await get('/invites'); } catch { invites = []; }
  loadingInv = false; changed();
}

const ROLES = { admin: 'Full access, manages people and settings', member: 'Can create and edit everything', viewer: 'Read-only access' };

function linkModal(title, text, link) {
  openModal({
    title, hideCancel: true, body: h`<p class="muted">${text}</p><div class="row"><input class="input" readonly value="${link}" onclick="this.select()" aria-label="Link"><button type="button" class="btn" data-act="copy-link" data-link="${link}">${icon('copy', 15)} Copy</button></div>`,
  });
}
A['copy-link'] = (el) => copyText(el.dataset.link);

K['invite-send'] = () => A['invite-send']();
A['invite-send'] = async () => {
  const email = document.querySelector('[data-fid="inv-email"]'); const role = document.querySelector('[data-fid="inv-role"]');
  if (!email.value.trim()) return toast('Enter an email address', 'error');
  const r = await post('/invites', { email: email.value.trim(), role: role.value });
  email.value = ''; await loadInvites();
  linkModal('Invite sent', 'We emailed the invite. You can also share this link with them directly (it works once and expires in 7 days).', r.link);
};
A['invite-resend'] = async (el) => { const r = await post(`/invites/${el.dataset.id}/resend`); await loadInvites(); linkModal('Invite re-sent', 'A fresh link was emailed. The previous link no longer works.', r.link); };
A['invite-revoke'] = async (el) => { if (await confirmDialog('Revoke this invite?', { okLabel: 'Revoke' })) { await del(`/invites/${el.dataset.id}`); await loadInvites(); } };

// ---- add a member (same invite as the box on the page, in a dialog)
A['member-add'] = () => openModal({
  title: 'Add a member', submit: 'Send invite',
  body: h`<p class="muted" style="margin-top:0">They get an email with a link. They confirm their address with a code and choose a name.</p>
    <div class="field"><label>Email address</label><input class="input" type="email" name="email" required placeholder="name@example.com"></div>
    <div class="field"><label>Role</label><select class="select" name="role">${Object.entries(ROLES).map(([r, d]) => h`<option value="${r}" ${r === 'member' ? raw('selected') : ''}>${r[0].toUpperCase() + r.slice(1)}: ${d}</option>`)}</select></div>`,
  onSubmit: async (v) => {
    const r = await post('/invites', { email: v.email.trim(), role: v.role });
    await loadInvites();
    linkModal('Invite sent', 'We emailed the invite. You can also share this link with them directly (it works once and expires in 7 days).', r.link);
    return false; // the link dialog replaces this one, so do not close it
  },
});

// ---- remove a member for good
async function removeMember(u) {
  const n = S.tasks.filter((t) => t.assigneeId === u.id).length;
  const ok = await confirmDialog(
    `Remove ${u.name} from the project? They are signed out and lose access straight away. ${n ? `Their ${n} assigned task${n === 1 ? '' : 's'} become unassigned. ` : ''}Their comments, files and history stay, shown as "Former member". You can invite them again later.`,
    { okLabel: 'Remove from project', title: `Remove ${u.name}?` });
  if (!ok) return;
  const r = await del(`/users/${u.id}`);
  removeLocal('users', u.id); await refreshTasks();
  toast(`${u.name} was removed${r.tasksUnassigned ? ` and ${r.tasksUnassigned} task${r.tasksUnassigned === 1 ? ' is' : 's are'} now unassigned` : ''}`);
}

async function setRole(u, role) { upsertLocal; const out = await patch(`/users/${u.id}`, { role }); toast(`${u.name} is now ${out.role}`); }
A['member-menu'] = (el) => {
  const u = S.users.find((x) => x.id === el.dataset.id);
  openMenu(el, [
    ...['admin', 'member', 'viewer'].filter((r) => r !== u.role).map((r) => ({ label: `Make ${r}`, icon: 'shield', onClick: () => setRole(u, r).catch((e) => toast(e.message, 'error')) })),
    'sep',
    { label: 'Create sign-in link', icon: 'link', onClick: async () => { const r = await post(`/users/${u.id}/signin-link`); linkModal(`Sign-in link for ${u.name}`, `Share this one-time link with ${u.name}. It signs them in once and expires in ${r.expiresInMinutes} minutes. Use it if email is not reaching them.`, r.link); } },
    { label: 'Sign out of all devices', icon: 'logout', onClick: async () => { const r = await del(`/users/${u.id}/sessions`); toast(`Ended ${r.ended} session${r.ended === 1 ? '' : 's'}`); } },
    'sep',
    { label: 'Remove from project...', icon: 'trash', danger: true, onClick: () => removeMember(u).catch((e) => toast(e.message, 'error')) },
    u.active ? { label: 'Deactivate (can be undone)', icon: 'x', danger: true, onClick: async () => { if (await confirmDialog(`Deactivate ${u.name}? They are signed out and cannot sign in. Their tasks and comments stay.`, { okLabel: 'Deactivate' })) await patch(`/users/${u.id}`, { active: false }).catch((e) => toast(e.message, 'error')); } }
      : { label: 'Reactivate account', icon: 'check', onClick: () => patch(`/users/${u.id}`, { active: true }) },
  ]);
};

function card(u) {
  const open = S.tasks.filter((t) => t.assigneeId === u.id && !isDone(t)).length;
  const online = S.online.has(u.id);
  return h`<div class="card member-card" style="${u.active ? '' : 'opacity:.6'}">${avatar(u, 48)}
    <div class="grow" style="min-width:0"><b class="trunc" style="display:block">${u.name}${u.id === S.me.id ? ' (you)' : ''}</b>
      ${isAdmin() || u.id === S.me.id ? h`<div class="muted sm trunc">${u.email}</div>` : ''}
      <div class="row wrap" style="margin-top:4px"><span class="state ${u.role === 'admin' ? 'active' : 'planned'}">${u.role}</span><span class="xs muted">${online ? h`<span class="dot" style="background:#22c55e"></span> Online` : u.lastSeenAt ? `Seen ${timeAgo(u.lastSeenAt)}` : 'Not signed in yet'}</span><span class="xs muted">${open} open task${open === 1 ? '' : 's'}</span></div></div>
    ${isAdmin() && u.id !== S.me.id ? h`<button class="icon-btn" data-act="member-menu" data-id="${u.id}" aria-label="Manage">${icon('more', 16)}</button>` : ''}</div>`;
}

export default function team() {
  if (isAdmin() && invites === null) loadInvites();
  const active = S.users.filter((u) => u.active), inactive = S.users.filter((u) => !u.active);
  const body = h`<div class="page-narrow">
    ${isAdmin() ? h`<section class="card" style="margin-bottom:22px"><div class="card-h"><h3>Invite someone</h3><span class="muted sm">They get an email with a link to join</span></div>
      <div class="card-b"><div class="row wrap"><input class="input" style="flex:1;min-width:220px" type="email" data-fid="inv-email" data-enter="invite-send" placeholder="name@example.com" aria-label="Email to invite">
        <select class="select" style="width:auto" data-fid="inv-role" aria-label="Role">${Object.keys(ROLES).map((r) => h`<option value="${r}" ${r === 'member' ? raw('selected') : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`)}</select>
        <button class="btn primary" data-act="invite-send">${icon('mail', 15)} Send invite</button></div>
        <p class="hint" style="margin:10px 0 0">Admin: ${ROLES.admin}. Member: ${ROLES.member}. Viewer: ${ROLES.viewer}.</p></div>
      ${invites?.length ? h`<div style="border-top:1px solid var(--border)">${invites.map((i) => h`<div class="list-i">${icon('mail', 16)}<div class="grow"><b>${i.email}</b><div class="xs muted">${i.role} · expires ${fmtDateY(i.expiresAt.slice(0, 10))}</div></div><button class="btn sm" data-act="invite-resend" data-id="${i.id}">Resend</button><button class="btn sm ghost" data-act="invite-revoke" data-id="${i.id}">Revoke</button></div>`)}</div>` : ''}</section>` : ''}
    <div class="sec-title">Members <span class="count-badge">${active.length}</span></div>
    <div class="grid g2">${active.map(card)}</div>
    ${inactive.length && isAdmin() ? h`<div class="sec-title" style="margin-top:24px">Deactivated</div><div class="grid g2">${inactive.map(card)}</div>` : ''}</div>`;
  return {
    title: 'Team', subtitle: `${active.length} member${active.length === 1 ? '' : 's'}`, body,
    actions: isAdmin() ? h`<button class="btn primary" data-act="member-add">${icon('plus', 16)} Add member</button>` : '',
  };
}
void empty;
