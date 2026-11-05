const crypto = require('crypto');
const config = require('./config');
const { prisma } = require('./db');

const COOKIE = 'forge_sid';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

async function createSession(userId) {
  const token = newToken();
  const expires = new Date(Date.now() + config.sessionDays * 864e5);
  await prisma.session.create({ data: { id: sha256(token), userId, expiresAt: expires } });
  return { token, expires };
}

const destroySession = async (token) => { if (token) await prisma.session.deleteMany({ where: { id: sha256(token) } }); };
const destroyUserSessions = (userId) => prisma.session.deleteMany({ where: { userId } });

/** Returns the active user for a session token, or null. Carries the session expiry for renewal. */
async function userFromToken(token) {
  if (!token) return null;
  const s = await prisma.session.findFirst({
    where: { id: sha256(token), expiresAt: { gt: new Date() }, user: { active: true } },
    include: { user: true },
  });
  return s ? Object.assign(s.user, { _sid: s.id, _exp: s.expiresAt }) : null;
}

/** Sliding expiry: whenever a session has used up a day, push it back out to the full 30 days. */
async function renewIfNeeded(res, token, user) {
  const full = config.sessionDays * 864e5;
  if (!user._exp || user._exp.getTime() - Date.now() > full - 864e5) return;
  const expires = new Date(Date.now() + full);
  await prisma.session.update({ where: { id: user._sid }, data: { expiresAt: expires } });
  setCookie(res, token, expires);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const userFromCookieHeader = (header) => userFromToken(parseCookies(header)[COOKIE]);

function setCookie(res, token, expires) {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.isProd, expires, path: '/' });
}
const clearCookie = (res) => res.clearCookie(COOKIE, { path: '/' });

module.exports = {
  COOKIE, sha256, newToken, createSession, destroySession, destroyUserSessions,
  userFromToken, renewIfNeeded, userFromCookieHeader, setCookie, clearCookie,
};
