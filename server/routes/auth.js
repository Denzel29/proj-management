const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { prisma } = require('../db');
const sessions = require('../sessions');
const mail = require('../mail');
const realtime = require('../realtime');
const S = require('../services/serialize');
const { work, audit } = require('../services/core');
const H = require('../http');

const { z, wrap, parse, bad, forbidden, notFound, requireAuth, requireRole, rateLimit } = H;
const router = express.Router();

const COLORS = ['#0f9d92', '#6366f1', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9', '#ec4899', '#22c55e', '#f97316', '#64748b'];
const pickColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];
const email = z.string().trim().toLowerCase().email().max(200);
const code = z.string().trim().regex(/^\d{6}$/, 'enter the 6-digit code');

async function startSession(res, userId) {
  const { token, expires } = await sessions.createSession(userId);
  sessions.setCookie(res, token, expires);
}

// ---------------------------------------------------------------- sign-in codes
const codeHash = (addr, c) => sessions.sha256(`${addr}:${c}`);
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Create a fresh 6-digit code for an email (older unused codes stop working). */
async function issueCode(addr) {
  await prisma.loginToken.updateMany({ where: { email: addr, kind: 'code', usedAt: null }, data: { usedAt: new Date() } });
  const c = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await prisma.loginToken.create({ data: { email: addr, kind: 'code', tokenHash: codeHash(addr, c), expiresAt: new Date(Date.now() + config.codeMinutes * 60e3) } });
  return c;
}

/**
 * Check a code. A correct code is consumed; a wrong one counts as an attempt, and after
 * `codeMaxAttempts` misses the code is dead. Runs outside any transaction so failed
 * attempts are always recorded.
 */
async function verifyCode(addr, c) {
  const t = await prisma.loginToken.findFirst({
    where: { email: addr, kind: 'code', usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' },
  });
  if (!t || t.attempts >= config.codeMaxAttempts) return false;
  if (sameHash(t.tokenHash, codeHash(addr, c))) {
    // consume atomically so one code can never be used twice
    const r = await prisma.loginToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
    return r.count === 1;
  }
  await prisma.loginToken.update({ where: { id: t.id }, data: { attempts: { increment: 1 } } });
  return false;
}

async function sendCode(addr, c, purpose) {
  if (!config.smtp.host) console.log(`[auth] SMTP not configured. Code for ${addr}: ${c}`);
  await mail.sendNow({
    to: addr, subject: `Your Forge code: ${c}`,
    text: `Your Forge ${purpose} code is ${c}\n\nIt works for ${config.codeMinutes} minutes. If you did not ask for it, ignore this email.`,
    html: mail.layout(`Your ${purpose} code`, `<p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:16px 0">${c}</p><p>It works for ${config.codeMinutes} minutes and can be used once.</p><p style="color:#64748b;font-size:13px">If you did not ask for this, you can ignore this email.</p>`),
  });
}

const BAD_CODE = 'That code is wrong or has expired. Request a new one.';

// ---------------------------------------------------------------- status
router.get('/auth/status', wrap(async (req, res) => {
  const user = await sessions.userFromToken(req.cookies?.[sessions.COOKIE]);
  res.json({ needsSetup: (await prisma.user.count()) === 0, user: user ? S.user(user) : null });
}));

// ---------------------------------------------------------------- sign in
/** Step 1: ask for a code. Always answers "ok" so it cannot be used to discover who has an account. */
router.post('/auth/request-code', wrap(async (req, res) => {
  const body = parse(z.object({ email }), req.body);
  rateLimit(`code:${req.ip}`, 15, 3600e3);
  rateLimit(`code:${body.email}`, 5, 15 * 60e3);
  const u = await prisma.user.findFirst({ where: { email: body.email, active: true } });
  if (u) await sendCode(u.email, await issueCode(u.email), 'sign-in');
  res.json({ ok: true, expiresInMinutes: config.codeMinutes });
}));

/** Step 2: submit the code. */
router.post('/auth/verify', wrap(async (req, res) => {
  const body = parse(z.object({ email, code }), req.body);
  rateLimit(`verify:${req.ip}`, 30, 15 * 60e3);
  rateLimit(`verify:${body.email}`, 15, 15 * 60e3);
  const u = await prisma.user.findFirst({ where: { email: body.email, active: true } });
  const ok = u ? await verifyCode(u.email, body.code) : false;
  if (!u || !ok) throw new H.HttpError(401, BAD_CODE);
  await prisma.user.update({ where: { id: u.id }, data: { lastSeenAt: new Date() } });
  await startSession(res, u.id);
  res.json({ user: S.user(u) });
}));

router.post('/auth/logout', wrap(async (req, res) => {
  await sessions.destroySession(req.cookies?.[sessions.COOKIE]);
  sessions.clearCookie(res);
  res.json({ ok: true });
}));

/** Sign out of every other device. */
router.post('/auth/logout-others', requireAuth, wrap(async (req, res) => {
  const r = await prisma.session.deleteMany({ where: { userId: req.user.id, id: { not: req.user._sid } } });
  res.json({ ended: r.count });
}));

// ---------------------------------------------------------------- first-run setup
/** When SETUP_EMAIL is configured, nobody else can claim the first admin account. */
const checkSetupEmail = (addr) => {
  if (config.setupEmail && addr !== config.setupEmail) throw forbidden('This workspace can only be set up by its owner');
};

/** The very first admin proves their email with a code too. Only works while there are no users. */
router.post('/auth/setup/request-code', wrap(async (req, res) => {
  const body = parse(z.object({ email }), req.body);
  rateLimit(`setupcode:${req.ip}`, 10, 3600e3);
  if ((await prisma.user.count()) > 0) throw forbidden('Setup has already been completed');
  checkSetupEmail(body.email);
  await sendCode(body.email, await issueCode(body.email), 'setup');
  res.json({ ok: true, expiresInMinutes: config.codeMinutes });
}));

router.post('/auth/setup', wrap(async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(1).max(100), email, code,
    projectName: z.string().trim().min(1).max(100).default('Forge'),
    projectKey: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, '2-10 letters/numbers').default('FORGE'),
  }), req.body);
  rateLimit(`setup:${req.ip}`, 20, 3600e3);
  if ((await prisma.user.count()) > 0) throw forbidden('Setup has already been completed');
  checkSetupEmail(body.email);
  if (!(await verifyCode(body.email, body.code))) throw new H.HttpError(401, BAD_CODE);

  const user = await work(async (tx) => {
    await tx.$executeRaw`LOCK TABLE "User" IN EXCLUSIVE MODE`; // two simultaneous setups cannot both win
    if ((await tx.user.count()) > 0) throw forbidden('Setup has already been completed');
    const u = await tx.user.create({ data: { email: body.email, name: body.name, role: 'admin', color: pickColor() } });
    const project = await tx.project.create({
      data: {
        name: body.projectName, key: body.projectKey,
        statuses: { create: [
          { name: 'To Do', category: 'todo', color: '#64748b', position: 0 },
          { name: 'In Progress', category: 'doing', color: '#f59e0b', position: 1 },
          { name: 'In Review', category: 'doing', color: '#8b5cf6', position: 2 },
          { name: 'Done', category: 'done', color: '#22c55e', position: 3 },
        ] },
        labels: { create: [
          { name: 'Frontend', color: '#0ea5e9' }, { name: 'Backend', color: '#6366f1' },
          { name: 'Design', color: '#ec4899' }, { name: 'Documentation', color: '#22c55e' },
        ] },
      },
    });
    await audit(tx, u.id, 'project.setup', 'project', project.id, null, { name: body.projectName, key: body.projectKey });
    return u;
  });
  await startSession(res, user.id);
  res.status(201).json({ user: S.user(user) });
}));

// ---------------------------------------------------------------- invites
const liveInvite = (tokenHash) => ({ tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } });
const findInvite = (token) => prisma.invite.findFirst({ where: liveInvite(sessions.sha256(token)) });

router.get('/invites/lookup/:token', wrap(async (req, res) => {
  const inv = await findInvite(req.params.token);
  if (!inv) throw notFound('This invite is invalid or has expired');
  res.json({ email: inv.email, role: inv.role });
}));

/** The invitee proves they own the invited address: a code is emailed to it. */
router.post('/invites/request-code', wrap(async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10) }), req.body);
  rateLimit(`invcode:${req.ip}`, 15, 3600e3);
  const inv = await findInvite(body.token);
  if (!inv) throw notFound('This invite is invalid or has expired');
  rateLimit(`invcode:${inv.email}`, 5, 15 * 60e3);
  await sendCode(inv.email.toLowerCase(), await issueCode(inv.email.toLowerCase()), 'sign-up');
  res.json({ ok: true, expiresInMinutes: config.codeMinutes });
}));

router.post('/invites/accept', wrap(async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10), name: z.string().trim().min(1).max(100), code }), req.body);
  rateLimit(`accept:${req.ip}`, 20, 3600e3);
  const inv = await findInvite(body.token);
  if (!inv) throw bad('This invite is invalid or has expired');
  const addr = inv.email.toLowerCase();
  if (!(await verifyCode(addr, body.code))) throw new H.HttpError(401, BAD_CODE);

  const user = await work(async (tx, after) => {
    const fresh = await tx.invite.findFirst({ where: liveInvite(inv.tokenHash) });
    if (!fresh) throw bad('This invite is invalid or has expired');
    if (await tx.user.findUnique({ where: { email: addr } })) throw bad('An account with this email already exists');
    await tx.invite.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
    const u = await tx.user.create({ data: { email: addr, name: body.name, role: inv.role, color: pickColor() } });
    await audit(tx, u.id, 'user.join', 'user', u.id, null, { email: u.email, role: u.role });
    after(() => realtime.broadcast('user.joined', { user: S.user(u) }));
    return u;
  });
  await startSession(res, user.id);
  res.status(201).json({ user: S.user(user) });
}));

async function sendInvite(db, inv, token, inviterName) {
  const link = `${config.appUrl}/#/invite/${token}`;
  await mail.enqueue(db, {
    to: inv.email, subject: `${inviterName} invited you to Forge`,
    text: `${inviterName} invited you to join the Forge project workspace as ${inv.role}.\n\nOpen this link to join: ${link}\n\nThis invite expires in ${config.inviteDays} days.`,
    html: mail.layout("You're invited to Forge", `<p>${mail.esc(inviterName)} invited you to join the Forge project workspace as <b>${mail.esc(inv.role)}</b>.</p>${mail.button(link, 'Join Forge')}<p style="color:#64748b;font-size:13px">This invite expires in ${config.inviteDays} days.</p>`),
  });
  return link;
}
const inviteView = (i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt, createdAt: i.createdAt });

router.get('/invites', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const rows = await prisma.invite.findMany({ where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } });
  res.json(rows.map(inviteView));
}));

router.post('/invites', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const body = parse(z.object({ email, role: z.enum(['admin', 'member', 'viewer']).default('member') }), req.body);
  const out = await work(async (tx) => {
    if (await tx.user.findUnique({ where: { email: body.email } })) throw bad('That person already has an account');
    await tx.invite.updateMany({ where: { email: body.email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    const token = sessions.newToken();
    const inv = await tx.invite.create({
      data: { email: body.email, role: body.role, tokenHash: sessions.sha256(token), invitedBy: req.user.id, expiresAt: new Date(Date.now() + config.inviteDays * 864e5) },
    });
    const link = await sendInvite(tx, inv, token, req.user.name);
    await audit(tx, req.user.id, 'invite.create', 'invite', inv.id, null, { email: body.email, role: body.role });
    return { invite: inviteView(inv), link };
  });
  res.status(201).json(out); // link is returned so the admin can copy it if email is not working
}));

router.post('/invites/:id/resend', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const out = await work(async (tx) => {
    const cur = await tx.invite.findFirst({ where: { id: req.params.id, acceptedAt: null, revokedAt: null } });
    if (!cur) throw notFound('Invite not found');
    const token = sessions.newToken();
    const inv = await tx.invite.update({
      where: { id: cur.id }, data: { tokenHash: sessions.sha256(token), expiresAt: new Date(Date.now() + config.inviteDays * 864e5) },
    });
    return { invite: inviteView(inv), link: await sendInvite(tx, inv, token, req.user.name) };
  });
  res.json(out);
}));

router.delete('/invites/:id', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const r = await prisma.invite.updateMany({ where: { id: req.params.id, acceptedAt: null }, data: { revokedAt: new Date() } });
  if (!r.count) throw notFound('Invite not found');
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- admin fallback sign-in link
/** If email is down, an admin can hand someone a one-time link (valid for an hour) to get in. */
router.post('/users/:id/signin-link', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const u = await prisma.user.findFirst({ where: { id: req.params.id, active: true } });
  if (!u) throw notFound('User not found');
  const token = sessions.newToken();
  await prisma.loginToken.create({
    data: { email: u.email, kind: 'link', tokenHash: sessions.sha256(token), expiresAt: new Date(Date.now() + config.signinLinkMinutes * 60e3) },
  });
  await audit(prisma, req.user.id, 'user.signin_link', 'user', u.id);
  res.status(201).json({ link: `${config.appUrl}/#/signin/${token}`, expiresInMinutes: config.signinLinkMinutes });
}));

router.post('/auth/link', wrap(async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10) }), req.body);
  rateLimit(`link:${req.ip}`, 20, 15 * 60e3);
  const t = await prisma.loginToken.findFirst({ where: { kind: 'link', tokenHash: sessions.sha256(body.token), usedAt: null, expiresAt: { gt: new Date() } } });
  const used = t ? await prisma.loginToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } }) : { count: 0 };
  if (!t || used.count !== 1) throw new H.HttpError(401, 'This sign-in link is invalid or has expired');
  const u = await prisma.user.findFirst({ where: { email: t.email, active: true } });
  if (!u) throw new H.HttpError(401, 'This sign-in link is invalid or has expired');
  await startSession(res, u.id);
  res.json({ user: S.user(u) });
}));

// ---------------------------------------------------------------- users
router.get('/users', requireAuth, wrap(async (req, res) => {
  res.json((await prisma.user.findMany({ orderBy: { name: 'asc' } })).map(S.user));
}));

router.patch('/users/:id', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const body = parse(z.object({ role: z.enum(['admin', 'member', 'viewer']).optional(), active: z.boolean().optional() }), req.body);
  const user = await work(async (tx, after) => {
    const cur = await tx.user.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound('User not found');
    const next = { role: body.role ?? cur.role, active: body.active ?? cur.active };
    // never leave the workspace without an active admin
    if (cur.role === 'admin' && (next.role !== 'admin' || !next.active)) {
      const others = await tx.user.count({ where: { role: 'admin', active: true, id: { not: cur.id } } });
      if (!others) throw bad('There must be at least one active admin');
    }
    const u = await tx.user.update({ where: { id: cur.id }, data: next });
    if (!next.active) await tx.session.deleteMany({ where: { userId: cur.id } });
    await audit(tx, req.user.id, 'user.update', 'user', cur.id, { role: cur.role, active: cur.active }, next);
    after(() => realtime.broadcast('user.updated', { user: S.user(u) }));
    return u;
  });
  res.json(S.user(user));
}));

/** Admin: sign someone out of every device. */
router.delete('/users/:id/sessions', requireAuth, requireRole('admin'), wrap(async (req, res) => {
  const r = await prisma.session.deleteMany({ where: { userId: req.params.id } });
  await audit(prisma, req.user.id, 'user.sessions_ended', 'user', req.params.id, null, { count: r.count });
  res.json({ ended: r.count });
}));

// ---------------------------------------------------------------- own profile
router.patch('/me', requireAuth, wrap(async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(1).max(100).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    prefs: z.record(z.any()).optional(),
  }), req.body);
  const u = await prisma.user.update({ where: { id: req.user.id }, data: body });
  realtime.broadcast('user.updated', { user: S.user(u) });
  res.json(S.user(u));
}));

module.exports = router;
