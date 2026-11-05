const express = require('express');
const { prisma } = require('../db');
const realtime = require('../realtime');
const { work, audit, extractMentions } = require('../services/core');
const { notify } = require('../services/notify');
const { purgeAttachments } = require('../services/cleanup');
const T = require('../services/tasks');
const H = require('../http');

const { z, uuid, wrap, parse, bad, notFound, forbidden, requireRole } = H;
const router = express.Router();
const member = requireRole('member');

const target = z.object({ targetType: z.enum(['task', 'page']), targetId: uuid });
const bodyText = z.string().trim().min(1).max(20000);
const emoji = z.string().trim().min(1).max(16);

/** Short human label for notifications: the task key + title, or the page title. */
async function loadTarget(db, type, id) {
  if (type === 'task') {
    const t = await db.task.findUnique({ where: { id }, include: { project: { select: { key: true } } } });
    if (!t) throw notFound('Task not found');
    return { label: `${t.project.key}-${t.num}`, title: t.title };
  }
  const p = await db.page.findUnique({ where: { id } });
  if (!p) throw notFound('Page not found');
  return { label: p.title, title: p.title };
}

const excerpt = (s) => (s.length > 120 ? `${s.slice(0, 117)}...` : s).replace(/@\[([^\]]+)\]\(user:[0-9a-f-]{36}\)/gi, '@$1');

/** Build the API shape for comments, with reactions grouped by emoji and attachments. */
async function loadComments(db, type, id) {
  const rows = await db.comment.findMany({ where: { targetType: type, targetId: id }, orderBy: { createdAt: 'asc' }, include: { reactions: true } });
  const hasReplies = new Set(rows.filter((r) => r.parentId).map((r) => r.parentId));
  const visible = rows.filter((r) => !r.deletedAt || hasReplies.has(r.id)); // keep a "deleted" stub only if it has replies
  const atts = await db.attachment.findMany({ where: { targetType: 'comment', targetId: { in: visible.map((r) => r.id) } } });
  return visible.map((c) => shape(c, atts.filter((a) => a.targetId === c.id)));
}

function reactionMap(reactions) {
  const m = {};
  for (const r of reactions) (m[r.emoji] ||= []).push(r.userId);
  return m;
}

function shape(c, atts = []) {
  return {
    id: c.id, targetType: c.targetType, targetId: c.targetId, parentId: c.parentId, authorId: c.authorId,
    body: c.deletedAt ? '' : c.body, deleted: !!c.deletedAt, createdAt: c.createdAt, editedAt: c.editedAt,
    reactions: c.deletedAt ? {} : reactionMap(c.reactions || []),
    attachments: atts.map((a) => ({ id: a.id, fileName: a.fileName, mime: a.mime, sizeBytes: a.sizeBytes, url: `/api/attachments/${a.id}/download` })),
  };
}

/** Task comment counts are shown on cards, so push the refreshed task to everyone. */
async function refreshTask(db, type, id) {
  if (type !== 'task') return;
  const task = await T.loadTask(db, id);
  if (task) realtime.broadcast('task.updated', { task });
}

router.get('/comments', wrap(async (req, res) => {
  const q = parse(target, req.query);
  res.json(await loadComments(prisma, q.targetType, q.targetId));
}));

router.post('/comments', member, wrap(async (req, res) => {
  const body = parse(target.extend({ parentId: uuid.nullable().optional(), body: bodyText }), req.body);
  const out = await work(async (tx, after) => {
    const tg = await loadTarget(tx, body.targetType, body.targetId);

    // Threads are one level deep: a reply to a reply attaches to the original comment.
    let parent = null;
    if (body.parentId) {
      parent = await tx.comment.findUnique({ where: { id: body.parentId } });
      if (!parent || parent.targetType !== body.targetType || parent.targetId !== body.targetId) throw bad('Reply target not found');
      if (parent.deletedAt) throw bad('That comment was deleted');
      if (parent.parentId) parent = await tx.comment.findUnique({ where: { id: parent.parentId } });
    }

    const c = await tx.comment.create({
      data: { targetType: body.targetType, targetId: body.targetId, parentId: parent?.id ?? null, authorId: req.user.id, body: body.body },
      include: { reactions: true },
    });
    await audit(tx, req.user.id, 'comment.create', body.targetType, body.targetId, null, { commentId: c.id, reply: !!parent });
    if (body.targetType === 'task') await T.addWatcher(tx, body.targetId, req.user.id); // commenting means you follow the task

    // who hears about it: mentioned people, the person replied to, then watchers (no one twice)
    const mentioned = extractMentions(body.body);
    const told = new Set([req.user.id]);
    const base = { actorId: req.user.id, entityType: body.targetType, entityId: body.targetId, data: { commentId: c.id }, detail: excerpt(body.body) };

    await notify(tx, after, { ...base, userIds: mentioned, type: 'mention', title: `${req.user.name} mentioned you on ${tg.label}` });
    mentioned.forEach((id) => told.add(id));

    if (parent?.authorId && !told.has(parent.authorId)) {
      await notify(tx, after, { ...base, userIds: [parent.authorId], type: 'reply', title: `${req.user.name} replied to your comment on ${tg.label}` });
      told.add(parent.authorId);
    }
    if (body.targetType === 'task') {
      const w = await tx.taskWatcher.findMany({ where: { taskId: body.targetId }, select: { userId: true } });
      await notify(tx, after, { ...base, userIds: w.map((x) => x.userId).filter((id) => !told.has(id)), type: 'watched_update', title: `${req.user.name} commented on ${tg.label}` });
    }

    const comment = shape(c);
    after(() => { realtime.broadcast('comment.created', { comment }); });
    return comment;
  });
  await refreshTask(prisma, out.targetType, out.targetId);
  res.status(201).json(out);
}));

router.patch('/comments/:id', member, wrap(async (req, res) => {
  const body = parse(z.object({ body: bodyText }), req.body);
  const out = await work(async (tx, after) => {
    const cur = await tx.comment.findUnique({ where: { id: req.params.id } });
    if (!cur || cur.deletedAt) throw notFound('Comment not found');
    if (cur.authorId !== req.user.id) throw forbidden('You can only edit your own comments');
    const c = await tx.comment.update({ where: { id: cur.id }, data: { body: body.body, editedAt: new Date() }, include: { reactions: true } });
    await audit(tx, req.user.id, 'comment.edit', cur.targetType, cur.targetId, { commentId: cur.id }, { commentId: cur.id });
    // only people newly mentioned by this edit are notified
    const before = new Set(extractMentions(cur.body));
    const fresh = extractMentions(body.body).filter((id) => !before.has(id));
    if (fresh.length) {
      const tg = await loadTarget(tx, cur.targetType, cur.targetId);
      await notify(tx, after, { userIds: fresh, type: 'mention', actorId: req.user.id, entityType: cur.targetType, entityId: cur.targetId, data: { commentId: cur.id }, title: `${req.user.name} mentioned you on ${tg.label}`, detail: excerpt(body.body) });
    }
    const comment = shape(c);
    after(() => realtime.broadcast('comment.updated', { comment }));
    return comment;
  });
  res.json(out);
}));

/** Authors and admins can delete. A comment that has replies stays as a "deleted" stub so the thread still reads. */
router.delete('/comments/:id', member, wrap(async (req, res) => {
  const info = await work(async (tx, after) => {
    const cur = await tx.comment.findUnique({ where: { id: req.params.id } });
    if (!cur || cur.deletedAt) throw notFound('Comment not found');
    if (cur.authorId !== req.user.id && req.user.role !== 'admin') throw forbidden('You can only delete your own comments');
    await purgeAttachments(tx, after, { targetType: 'comment', targetId: cur.id });
    const replies = await tx.comment.count({ where: { parentId: cur.id, deletedAt: null } });
    if (replies) await tx.comment.update({ where: { id: cur.id }, data: { deletedAt: new Date(), body: '' } });
    else await tx.comment.delete({ where: { id: cur.id } });
    await audit(tx, req.user.id, 'comment.delete', cur.targetType, cur.targetId, { commentId: cur.id }, null);
    after(() => realtime.broadcast('comment.deleted', { id: cur.id, targetType: cur.targetType, targetId: cur.targetId, stub: replies > 0 }));
    return { targetType: cur.targetType, targetId: cur.targetId };
  });
  await refreshTask(prisma, info.targetType, info.targetId);
  res.json({ ok: true });
}));

/** Toggle a reaction: adds it if you have not reacted with that emoji, removes it if you have. */
router.post('/comments/:id/reactions', member, wrap(async (req, res) => {
  const { emoji: e } = parse(z.object({ emoji }), req.body);
  const reactions = await work(async (tx, after) => {
    const c = await tx.comment.findUnique({ where: { id: req.params.id } });
    if (!c || c.deletedAt) throw notFound('Comment not found');
    const key = { commentId_userId_emoji: { commentId: c.id, userId: req.user.id, emoji: e } };
    if (await tx.commentReaction.findUnique({ where: key })) await tx.commentReaction.delete({ where: key });
    else {
      const kinds = await tx.commentReaction.findMany({ where: { commentId: c.id }, distinct: ['emoji'], select: { emoji: true } });
      if (kinds.length >= 20 && !kinds.some((k) => k.emoji === e)) throw bad('This comment already has the maximum number of different reactions');
      await tx.commentReaction.create({ data: { commentId: c.id, userId: req.user.id, emoji: e } });
    }
    const map = reactionMap(await tx.commentReaction.findMany({ where: { commentId: c.id } }));
    after(() => realtime.broadcast('comment.reactions', { id: c.id, targetType: c.targetType, targetId: c.targetId, reactions: map }));
    return map;
  });
  res.json({ reactions });
}));

module.exports = router;
