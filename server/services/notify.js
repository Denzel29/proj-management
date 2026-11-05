const config = require('../config');
const realtime = require('../realtime');
const mail = require('../mail');

const DEFAULT_PREFS = { inapp: true, email: true };

/** Link to an entity in the SPA. */
function urlFor(entityType, entityId) {
  const path = { task: 'task', page: 'pages', sprint: 'sprint', milestone: 'milestone' }[entityType] || 'task';
  return `${config.appUrl}/#/${path}/${entityId}`;
}

/**
 * Create notifications for several users (never the actor).
 * Respects each user's prefs.notify[type] = { inapp, email }.
 * `title`/`detail` are shown in the inbox and in the email digest line.
 */
async function notify(tx, after, { userIds, type, actorId, entityType, entityId, data = {}, title, detail = '' }) {
  const targets = [...new Set(userIds.filter((id) => id && id !== actorId))];
  if (!targets.length) return;
  const users = await tx.user.findMany({ where: { id: { in: targets }, active: true }, select: { id: true, email: true, prefs: true } });

  for (const u of users) {
    const pref = { ...DEFAULT_PREFS, ...(u.prefs?.notify?.[type] || {}) };
    if (pref.inapp) {
      const n = await tx.notification.create({
        data: { userId: u.id, type, actorId, entityType, entityId, data: { title, detail, ...data } },
      });
      after(() => realtime.toUser(u.id, 'notification', {
        notification: { id: n.id, type, actorId, entityType, entityId, data: n.data, createdAt: n.createdAt, readAt: null },
      }));
    }
    if (pref.email) {
      await mail.enqueue(tx, {
        to: u.email, userId: u.id, kind: 'notification', subject: title,
        payload: { items: [{ title, detail, url: urlFor(entityType, entityId) }] },
        delaySec: 60, // lets rapid edits batch into one digest
      });
    }
  }
}

module.exports = { notify, urlFor };
