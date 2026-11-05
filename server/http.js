const { z } = require('zod');
const config = require('./config');
const sessions = require('./sessions');

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const bad = (m, extra) => new HttpError(400, m, extra);
const forbidden = (m = 'You do not have permission to do that') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);
const conflict = (m, extra) => new HttpError(409, m, extra);

/** Wrap an async route handler so thrown errors reach the error middleware. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Parse and validate with zod; throws a 400 with readable details. */
function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw bad(msg);
  }
  return r.data;
}

const RANK = { viewer: 0, member: 1, admin: 2 };

/** Loads the session user into req.user, or 401. */
const requireAuth = wrap(async (req, res, next) => {
  const token = req.cookies?.[sessions.COOKIE];
  const user = await sessions.userFromToken(token);
  if (!user) throw new HttpError(401, 'Please sign in');
  await sessions.renewIfNeeded(res, token, user); // keeps active people signed in
  req.user = user;
  next();
});

/** Require at least this role (viewer < member < admin). */
const requireRole = (min) => (req, res, next) => {
  if (RANK[req.user.role] < RANK[min]) return next(forbidden());
  next();
};

/** Basic CSRF defence for cookie auth: mutating requests must come from our own origin. */
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next(); // non-browser clients (curl, tests); cookies are SameSite=Lax anyway
  try {
    const o = new URL(origin).host;
    const allowed = new Set([new URL(config.appUrl).host, req.get('host')]);
    if (allowed.has(o)) return next();
  } catch { /* fall through */ }
  next(new HttpError(403, 'Cross-origin request blocked'));
}

// ---- tiny in-memory rate limiter (per key) ----
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (b.length >= max) throw new HttpError(429, 'Too many attempts, try again later');
  b.push(now);
  buckets.set(key, b);
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.some((t) => now - t < 3600e3)) buckets.delete(k); }, 600e3).unref();

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  // Prisma known-request errors
  if (err.code === 'P2002') return res.status(409).json({ error: 'That already exists' });
  if (err.code === 'P2003') return res.status(400).json({ error: 'Related item does not exist' });
  if (err.code === 'P2025') return res.status(404).json({ error: 'Not found' });
  if (err.code === 'P2023' || /Error creating UUID|invalid input syntax for type uuid/i.test(err.message || '')) return res.status(400).json({ error: 'Invalid id' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large' });
  if (err.name === 'MulterError') return res.status(400).json({ error: 'Upload failed: ' + err.message });
  console.error('[error]', req.method, req.path, err);
  res.status(500).json({ error: 'Something went wrong' });
}

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

module.exports = {
  HttpError, bad, forbidden, notFound, conflict, wrap, parse, requireAuth, requireRole,
  sameOrigin, rateLimit, errorHandler, z, uuid, date,
};
