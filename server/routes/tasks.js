const express = require('express');
const { prisma } = require('../db');
const realtime = require('../realtime');
const S = require('../services/serialize');
const { work, audit } = require('../services/core');
const T = require('../services/tasks');
const { notify } = require('../services/notify');
const H = require('../http');

const { z, uuid, date, wrap, parse, bad, notFound, requireRole } = H;
const router = express.Router();
const member = requireRole('member');

const recurrence = z.object({
  every: z.number().int().min(1).max(365),
  unit: z.enum(['day', 'week', 'month', 'year']),
}).nullable();

const fields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(100000),
  type: z.enum(['task', 'story', 'bug', 'improvement', 'epic']),
  statusId: uuid,
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  assigneeId: uuid.nullable(),
  parentId: uuid.nullable(),
  sprintId: uuid.nullable(),
  milestoneId: uuid.nullable(),
  points: z.number().min(0).max(1000).nullable(),
  estimateMin: z.number().int().min(0).max(1e6).nullable(),
  startDate: date.nullable(),
  dueDate: date.nullable(),
  recurrence,
  rank: z.number(),
  labelIds: z.array(uuid).max(50),
};
const createSchema = z.object(fields).partial().extend({ templateId: uuid.optional() })
  .refine((d) => d.title || d.templateId, { message: 'title is required' });
const patchSchema = z.object(fields).partial().extend({ version: z.number().int().optional() });

const linkView = (l) => ({ id: l.id, type: l.type, fromTaskId: l.fromTaskId, toTaskId: l.toTaskId });

// ---- list / read ----
router.get('/tasks', wrap(async (req, res) => {
  res.json(await T.loadTasks(prisma));
}));

router.get('/tasks/:id', wrap(async (req, res) => {
  const task = await T.loadTask(prisma, req.params.id);
  if (!task) throw notFound('Task not found');
  const [children, links, time, activity] = await Promise.all([
    T.loadTasks(prisma, { parentId: task.id }),
    prisma.taskLink.findMany({ where: { OR: [{ fromTaskId: task.id }, { toTaskId: task.id }] } }),
    prisma.timeLog.findMany({ where: { taskId: task.id }, orderBy: [{ loggedOn: 'desc' }, { createdAt: 'desc' }] }),
    prisma.auditLog.findMany({ where: { entityType: 'task', entityId: task.id }, orderBy: { id: 'desc' }, take: 100 }),
  ]);
  res.json({
    task, children, links: links.map(linkView),
    time: time.map((t) => ({ id: t.id, userId: t.userId, minutes: t.minutes, note: t.note, loggedOn: S.iso(t.loggedOn), createdAt: t.createdAt })),
    activity: activity.map((a) => ({ id: a.id, actorId: a.actorId, action: a.action, before: a.before, after: a.after, createdAt: a.createdAt })),
  });
}));

// ---- create / update / delete ----
router.post('/tasks', member, wrap(async (req, res) => {
  const body = parse(createSchema, req.body);
  const task = await work((tx, after) => T.createTask(tx, after, req.user, body));
  res.status(201).json(task);
}));

router.patch('/tasks/:id', member, wrap(async (req, res) => {
  const { version, ...patch } = parse(patchSchema, req.body);
  const out = await work((tx, after) => T.updateTask(tx, after, req.user, req.params.id, patch, version));
  res.json(out);
}));

router.delete('/tasks/:id', member, wrap(async (req, res) => {
  await work((tx, after) => T.deleteTask(tx, after, req.user, req.params.id));
  res.json({ ok: true });
}));

/** Bulk edit: { ids, patch, labelAdd, labelRemove } or { ids, delete: true } */
router.post('/tasks/bulk', member, wrap(async (req, res) => {
  const body = parse(z.object({
    ids: z.array(uuid).min(1).max(200),
    patch: z.object(fields).partial().optional(),
    labelAdd: z.array(uuid).optional(), labelRemove: z.array(uuid).optional(),
    delete: z.boolean().optional(),
  }), req.body);
  const updated = await work(async (tx, after) => {
    let n = 0;
    for (const id of body.ids) {
      if (body.delete) {
        try { await T.deleteTask(tx, after, req.user, id); n++; } catch (e) { if (e.status !== 404) throw e; }
        continue;
      }
      const patch = { ...(body.patch || {}) };
      if (body.labelAdd?.length || body.labelRemove?.length) {
        const cur = await T.loadTask(tx, id);
        if (!cur) continue;
        const set = new Set(cur.labelIds);
        body.labelAdd?.forEach((l) => set.add(l));
        body.labelRemove?.forEach((l) => set.delete(l));
        patch.labelIds = [...set];
      }
      if (Object.keys(patch).length) { await T.updateTask(tx, after, req.user, id, patch); n++; }
    }
    await audit(tx, req.user.id, 'task.bulk', 'task', null, null, { count: body.ids.length, delete: !!body.delete, patch: body.patch || null });
    return n;
  });
  res.json({ updated });
}));

// ---- links ----
router.post('/tasks/:id/links', member, wrap(async (req, res) => {
  const body = parse(z.object({ toTaskId: uuid, type: z.enum(['blocks', 'relates', 'duplicates']) }), req.body);
  if (body.toTaskId === req.params.id) throw bad('A task cannot link to itself');
  const link = await work(async (tx, after) => {
    const l = await tx.taskLink.create({ data: { fromTaskId: req.params.id, toTaskId: body.toTaskId, type: body.type, createdBy: req.user.id } });
    await audit(tx, req.user.id, 'task.link', 'task', req.params.id, null, { toTaskId: body.toTaskId, type: body.type });
    after(() => realtime.broadcast('task.linked', { link: linkView(l) }));
    return linkView(l);
  });
  res.status(201).json(link);
}));

router.delete('/links/:id', member, wrap(async (req, res) => {
  await work(async (tx, after) => {
    const l = await tx.taskLink.findUnique({ where: { id: req.params.id } });
    if (!l) throw notFound('Link not found');
    await tx.taskLink.delete({ where: { id: l.id } });
    await audit(tx, req.user.id, 'task.unlink', 'task', l.fromTaskId, { toTaskId: l.toTaskId, type: l.type }, null);
    after(() => realtime.broadcast('task.unlinked', { id: l.id }));
  });
  res.json({ ok: true });
}));

// ---- watchers ----
async function setWatching(req, res, userId, on) {
  await work(async (tx, after) => {
    const task = await T.loadTask(tx, req.params.id);
    if (!task) throw notFound('Task not found');
    if (on) await T.addWatcher(tx, task.id, userId);
    else await tx.taskWatcher.deleteMany({ where: { taskId: task.id, userId } });
    const w = await tx.taskWatcher.findMany({ where: { taskId: task.id }, select: { userId: true } });
    after(() => realtime.broadcast('task.watchers', { taskId: task.id, watcherIds: w.map((x) => x.userId).sort() }));
    if (on && userId !== req.user.id) {
      await notify(tx, after, {
        userIds: [userId], type: 'watched_update', actorId: req.user.id, entityType: 'task', entityId: task.id,
        title: `${req.user.name} added you as a watcher on ${task.key}`, detail: task.title,
      });
    }
  });
  res.json({ ok: true });
}
router.post('/tasks/:id/watch', member, wrap((req, res) => setWatching(req, res, req.user.id, true)));
router.delete('/tasks/:id/watch', member, wrap((req, res) => setWatching(req, res, req.user.id, false)));
router.post('/tasks/:id/watchers', member, wrap((req, res) => setWatching(req, res, parse(z.object({ userId: uuid }), req.body).userId, true)));
router.delete('/tasks/:id/watchers/:userId', member, wrap((req, res) => setWatching(req, res, req.params.userId, false)));

// ---- time logging ----
router.post('/tasks/:id/time', member, wrap(async (req, res) => {
  const body = parse(z.object({ minutes: z.number().int().min(1).max(1440), note: z.string().max(500).default(''), loggedOn: date.optional() }), req.body);
  const row = await work(async (tx, after) => {
    const l = await tx.timeLog.create({
      data: { taskId: req.params.id, userId: req.user.id, minutes: body.minutes, note: body.note, loggedOn: S.day(body.loggedOn) ?? S.day(S.today()) },
    });
    await audit(tx, req.user.id, 'task.time', 'task', req.params.id, null, { minutes: body.minutes });
    const task = await T.loadTask(tx, req.params.id);
    after(() => realtime.broadcast('task.updated', { task }));
    return { id: l.id, userId: l.userId, minutes: l.minutes, note: l.note, loggedOn: S.iso(l.loggedOn), createdAt: l.createdAt };
  });
  res.status(201).json(row);
}));

router.delete('/time/:id', member, wrap(async (req, res) => {
  await work(async (tx, after) => {
    const l = await tx.timeLog.findUnique({ where: { id: req.params.id } });
    if (!l || (l.userId !== req.user.id && req.user.role !== 'admin')) throw notFound('Time entry not found');
    await tx.timeLog.delete({ where: { id: l.id } });
    const task = await T.loadTask(tx, l.taskId);
    after(() => realtime.broadcast('task.updated', { task }));
  });
  res.json({ ok: true });
}));

module.exports = router;
