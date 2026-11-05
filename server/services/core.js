const { prisma } = require('../db');

/**
 * Run `fn(tx, after)` in a database transaction. Anything passed to `after(fn)` runs only
 * once the transaction has committed (used for realtime broadcasts, so clients never see
 * changes that were rolled back).
 */
async function work(fn) {
  const effects = [];
  const result = await prisma.$transaction((tx) => fn(tx, (f) => effects.push(f)), { timeout: 20000, maxWait: 10000 });
  for (const f of effects) { try { f(); } catch (e) { console.error('[effect]', e.message); } }
  return result;
}

/** Write an audit row. `before`/`after` should hold only the fields that matter. */
async function audit(db, actorId, action, entityType, entityId = null, before = null, after = null) {
  await db.auditLog.create({
    data: { actorId, action, entityType, entityId, before: before ?? undefined, after: after ?? undefined },
  });
}

/** Mentions are stored in text as @[Display Name](user:<uuid>). */
const MENTION_RE = /@\[[^\]]+\]\(user:([0-9a-f-]{36})\)/gi;
function extractMentions(text = '') {
  const ids = new Set();
  for (const m of text.matchAll(MENTION_RE)) ids.add(m[1].toLowerCase());
  return [...ids];
}

/** Shallow diff of two plain objects, returning { before, after, changed } for the given keys. */
function diff(before, after, keys) {
  const b = {}, a = {};
  for (const k of keys) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) { b[k] = before[k] ?? null; a[k] = after[k] ?? null; }
  }
  return { before: b, after: a, changed: Object.keys(a) };
}

module.exports = { work, audit, extractMentions, diff };
