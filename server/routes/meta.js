const express = require('express');
const { prisma } = require('../db');
const S = require('../services/serialize');
const T = require('../services/tasks');
const H = require('../http');

const { z, uuid, wrap, parse, requireRole } = H;
const router = express.Router();

/** Everything the app needs on load, in one request. */
router.get('/bootstrap', wrap(async (req, res) => {
  const project = await T.getProject(prisma);
  const [statuses, labels, users, tasks, sprints, milestones, templates, favorites, unread, pages] = await Promise.all([
    prisma.status.findMany({ orderBy: { position: 'asc' } }),
    prisma.label.findMany({ orderBy: { name: 'asc' } }),
    prisma.user.findMany({ orderBy: { name: 'asc' } }),
    T.loadTasks(prisma),
    prisma.sprint.findMany({ orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }] }),
    prisma.milestone.findMany({ orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }] }),
    prisma.taskTemplate.findMany({ orderBy: { name: 'asc' } }),
    prisma.favorite.findMany({ where: { userId: req.user.id }, orderBy: { position: 'asc' } }),
    prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
    prisma.page.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, icon: true, parentId: true, position: true, updatedAt: true } }),
  ]);

  // milestone progress from the already-loaded tasks (points-weighted, 1 when unestimated)
  const ms = milestones.map((m) => {
    const own = tasks.filter((t) => t.milestoneId === m.id);
    const weight = own.reduce((a, t) => a + (t.points || 1), 0);
    const done = own.filter((t) => t.statusCategory === 'done');
    const wdone = done.reduce((a, t) => a + (t.points || 1), 0);
    return { ...S.milestone(m), taskCount: own.length, doneCount: done.length, progress: weight ? Math.round((wdone / weight) * 100) : 0 };
  });

  res.json({
    me: S.user(req.user), project: { id: project.id, name: project.name, key: project.key, description: project.description, settings: project.settings },
    statuses, labels, users: users.map(S.user), tasks, sprints: sprints.map(S.sprint), milestones: ms,
    templates: templates.map((t) => ({ id: t.id, name: t.name, data: t.data })), favorites, unreadCount: unread,
    pages, // tree metadata only; content is loaded when a page is opened
  });
}));

/** Audit log. Anyone can read an entity's history; the global log is admin-only. */
router.get('/audit', wrap(async (req, res) => {
  const q = parse(z.object({
    entityType: z.string().max(30).optional(), entityId: uuid.optional(), actorId: uuid.optional(),
    action: z.string().max(60).optional(), before: z.coerce.number().int().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }), req.query);
  if (!q.entityId && req.user.role !== 'admin') throw H.forbidden('Only admins can view the full audit log');
  const rows = await prisma.auditLog.findMany({
    where: {
      entityType: q.entityType, entityId: q.entityId, actorId: q.actorId,
      action: q.action ? { startsWith: q.action } : undefined, id: q.before ? { lt: q.before } : undefined,
    },
    orderBy: { id: 'desc' }, take: q.limit,
  });
  res.json(rows.map((a) => ({ id: a.id, actorId: a.actorId, action: a.action, entityType: a.entityType, entityId: a.entityId, before: a.before, after: a.after, createdAt: a.createdAt })));
}));

/** Quick search across tasks, pages (title and text), milestones and sprints. */
router.get('/search', wrap(async (req, res) => {
  const { q } = parse(z.object({ q: z.string().trim().min(1).max(100) }), req.query);
  const project = await T.getProject(prisma);
  const num = /^[A-Za-z0-9]+-(\d+)$/.exec(q);
  const [tasks, milestones, sprints, pages] = await Promise.all([
    prisma.task.findMany({
      where: { OR: [{ title: { contains: q, mode: 'insensitive' } }, ...(num ? [{ num: Number(num[1]) }] : [])] },
      select: { id: true, num: true, title: true }, take: 10, orderBy: { updatedAt: 'desc' },
    }),
    prisma.milestone.findMany({ where: { name: { contains: q, mode: 'insensitive' } }, select: { id: true, name: true }, take: 5 }),
    prisma.sprint.findMany({ where: { name: { contains: q, mode: 'insensitive' } }, select: { id: true, name: true }, take: 5 }),
    prisma.page.findMany({
      where: { OR: [{ title: { contains: q, mode: 'insensitive' } }, { content: { contains: q, mode: 'insensitive' } }] },
      select: { id: true, title: true, icon: true }, take: 8, orderBy: { updatedAt: 'desc' },
    }),
  ]);
  res.json({
    tasks: tasks.map((t) => ({ id: t.id, key: `${project.key}-${t.num}`, title: t.title })),
    milestones, sprints, pages,
  });
}));

module.exports = router;
