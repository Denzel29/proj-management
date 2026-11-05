const fs = require('fs/promises');
const path = require('path');
const config = require('../config');

/**
 * Delete attachment rows matching `where` and, once the transaction commits, their files on disk.
 */
async function purgeAttachments(tx, after, where) {
  const rows = await tx.attachment.findMany({ where });
  if (!rows.length) return;
  await tx.attachment.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  after(() => {
    for (const r of rows) fs.unlink(path.join(config.uploadDir, r.storageKey)).catch(() => {});
  });
}

/**
 * Comments, attachments, favorites, recent visits and notifications point at tasks/pages by plain
 * id (no foreign key), so deleting a task or page must clean them up explicitly.
 * `type` is 'task' or 'page'.
 */
async function removeTargets(tx, after, type, ids) {
  if (!ids.length) return;
  const comments = await tx.comment.findMany({ where: { targetType: type, targetId: { in: ids } }, select: { id: true } });
  const commentIds = comments.map((c) => c.id);
  await purgeAttachments(tx, after, {
    OR: [{ targetType: type, targetId: { in: ids } }, ...(commentIds.length ? [{ targetType: 'comment', targetId: { in: commentIds } }] : [])],
  });
  await tx.comment.deleteMany({ where: { targetType: type, targetId: { in: ids } } });
  await tx.favorite.deleteMany({ where: { entityType: type, entityId: { in: ids } } });
  await tx.recentVisit.deleteMany({ where: { entityType: type, entityId: { in: ids } } });
  await tx.notification.deleteMany({ where: { entityType: type, entityId: { in: ids } } });
}

module.exports = { purgeAttachments, removeTargets };
