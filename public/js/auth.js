// Sign-in, first-run setup, invites and admin sign-in links. All passwordless (emailed codes).
import { api, post, get } from './api.js';
import { h, icon, esc, $ } from './ui.js';

const root = () => $('#app');
const logo = () => h`<div class="logo">${icon('check', 24)}</div>`;

/** Call a function with the button disabled, showing errors inside the card. */
async function guarded(form, fn) {
  const btn = form.querySelector('button[type=submit]');
  const err = form.querySelector('.err');
  if (err) err.remove();
  btn.disabled = true;
  try { await fn(); }
  catch (e) {
    const box = document.createElement('div'); box.className = 'err'; box.textContent = e.message;
    form.prepend(box);
  } finally { btn.disabled = false; }
}

function card(content) {
  root().innerHTML = String(h`<div class="auth"><div class="auth-card">${content}</div></div>`);
}

function resendButton(onResend) {
  let left = 30;
  const btn = $('#resend');
  if (!btn) return;
  const tick = () => {
    if (!document.body.contains(btn)) return;
    btn.disabled = left > 0; btn.textContent = left > 0 ? `Send a new code (${left}s)` : 'Send a new code';
    if (left-- > 0) setTimeout(tick, 1000);
  };
  tick();
  btn.onclick = async () => { btn.disabled = true; try { await onResend(); left = 30; tick(); } catch (e) { btn.textContent = e.message; } };
}

const codeField = h`<div class="field"><label for="code">6-digit code</label><input id="code" name="code" class="input code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" required autofocus></div>`;

// ------------------------------------------------------------ sign in
export function showLogin(onDone, email = '') {
  card(h`${logo()}<h1>Sign in to Forge</h1><p>We email you a 6-digit code. No password needed.</p>
    <form id="f">
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" class="input" autocomplete="email" required autofocus value="${email}"></div>
      <button class="btn primary" style="width:100%;height:40px" type="submit">Email me a code</button>
    </form>`);
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const addr = new FormData(e.target).get('email').trim().toLowerCase();
    guarded(e.target, async () => { await post('/auth/request-code', { email: addr }); showCode(addr, onDone); });
  };
}

function showCode(addr, onDone) {
  card(h`${logo()}<h1>Check your email</h1><p>If <b>${addr}</b> has an account, a code is on its way. It works for 10 minutes.</p>
    <form id="f">${codeField}
      <button class="btn primary" style="width:100%;height:40px" type="submit">Sign in</button>
      <div class="row between" style="margin-top:14px"><button type="button" class="linkbtn" id="resend">Send a new code</button><button type="button" class="linkbtn" id="back">Use a different email</button></div>
    </form>`);
  $('#back').onclick = () => showLogin(onDone, addr);
  resendButton(() => post('/auth/request-code', { email: addr }));
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const code = new FormData(e.target).get('code').trim();
    guarded(e.target, async () => { await post('/auth/verify', { email: addr, code }); onDone(); });
  };
}

// ------------------------------------------------------------ first-run setup
export function showSetup(onDone) {
  card(h`${logo()}<h1>Set up Forge</h1><p>Create the first admin account and your project. You confirm your email with a code.</p>
    <form id="f">
      <div class="field"><label>Your name</label><input name="name" class="input" required autofocus></div>
      <div class="field"><label>Your email</label><input name="email" type="email" class="input" required></div>
      <div class="field-row"><div class="field"><label>Project name</label><input name="projectName" class="input" value="Forge" required></div>
      <div class="field"><label>Project key</label><input name="projectKey" class="input" value="FORGE" pattern="[A-Za-z][A-Za-z0-9]{1,9}" title="2-10 letters or numbers" required style="text-transform:uppercase"></div></div>
      <p class="hint" style="margin:-4px 0 14px">The key prefixes task ids, for example FORGE-12.</p>
      <button class="btn primary" style="width:100%;height:40px" type="submit">Email me a code</button>
    </form>`);
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    v.email = v.email.trim().toLowerCase(); v.projectKey = v.projectKey.toUpperCase();
    guarded(e.target, async () => { await post('/auth/setup/request-code', { email: v.email }); showSetupCode(v, onDone); });
  };
}

function showSetupCode(v, onDone) {
  card(h`${logo()}<h1>Confirm your email</h1><p>We sent a code to <b>${v.email}</b>.</p>
    <form id="f">${codeField}
      <button class="btn primary" style="width:100%;height:40px" type="submit">Create my workspace</button>
      <div class="row between" style="margin-top:14px"><button type="button" class="linkbtn" id="resend">Send a new code</button><button type="button" class="linkbtn" id="back">Back</button></div>
    </form>`);
  $('#back').onclick = () => showSetup(onDone);
  resendButton(() => post('/auth/setup/request-code', { email: v.email }));
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const code = new FormData(e.target).get('code').trim();
    guarded(e.target, async () => { await post('/auth/setup', { ...v, code }); onDone(); });
  };
}

// ------------------------------------------------------------ invites
export async function showInvite(token, onDone) {
  card(h`${logo()}<h1>Checking your invite...</h1>`);
  let inv;
  try { inv = await get(`/invites/lookup/${encodeURIComponent(token)}`); }
  catch (e) {
    return card(h`${logo()}<h1>Invite not valid</h1><p>${e.message}. Ask an admin to send you a new invite.</p><a class="btn" href="#/">Go to sign in</a>`);
  }
  card(h`${logo()}<h1>You're invited</h1><p>Join Forge as <b>${inv.role}</b> using <b>${inv.email}</b>. We will email you a code to confirm it is you.</p>
    <form id="f"><button class="btn primary" style="width:100%;height:40px" type="submit">Email me a code</button></form>`);
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    guarded(e.target, async () => { await post('/invites/request-code', { token }); showInviteCode(token, inv, onDone); });
  };
}

function showInviteCode(token, inv, onDone) {
  card(h`${logo()}<h1>Finish joining</h1><p>Enter the code sent to <b>${inv.email}</b> and choose your name.</p>
    <form id="f">
      <div class="field"><label>Your name</label><input name="name" class="input" required autofocus></div>
      ${codeField}
      <button class="btn primary" style="width:100%;height:40px" type="submit">Join Forge</button>
      <div style="margin-top:14px"><button type="button" class="linkbtn" id="resend">Send a new code</button></div>
    </form>`);
  resendButton(() => post('/invites/request-code', { token }));
  $('#f').onsubmit = (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    guarded(e.target, async () => { await post('/invites/accept', { token, name: v.name.trim(), code: v.code.trim() }); onDone(); });
  };
}

// ------------------------------------------------------------ admin one-time link
export async function showLink(token, onDone) {
  card(h`${logo()}<h1>Signing you in...</h1>`);
  try { await post('/auth/link', { token }); onDone(); }
  catch (e) { card(h`${logo()}<h1>Link not valid</h1><p>${e.message}.</p><a class="btn primary" href="#/">Sign in with a code instead</a>`); }
}

export const _unused = { api, esc };
