const express = require('express');
const { prisma } = require('../db');
const realtime = require('../realtime');
const S = require('../services/serialize');
const { work, audit } = require('../services/core');
const T = require('../services/tasks');
const { milestoneStats, withStats, syncMilestones, syncAllMilestones } = require('../services/milestones');
const H = require('../http');

const { z, uuid, date, wrap, parse, bad, notFound, requireRole } = H;
const router = express.Router();
const member = requireRole('member');
const admin = requireRole('admin');

const addDays = (isoDate, n) => { const d = new Date(`${isoDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return S.iso(d); };

// ============================================================ project settings
router.patch('/project', admin, wrap(async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(1).max(100).optional(), description: z.string().max(5000).optional(),
    settings: z.object({ sprintWeeks: z.number().int().min(1).max(8), maxSubtaskDepth: z.number().int().min(1).max(6) }).partial().optional(),
  }), req.body);
  const p = await work(async (tx, after) => {
    const cur = await T.getProject(tx);
    const updated = await tx.project.update({
      where: { id: cur.id },
      data: { name: body.name, description: body.description, settings: body.settings ? { ...cur.settings, ...body.settings } : undefined },
    });
    await audit(tx, req.user.id, 'project.update', 'project', cur.id, { name: cur.name, settings: cur.settings }, { name: updated.name, settings: updated.settings });
    after(() => realtime.broadcast('project.updated', { project: updated }));
    return updated;
  });
  res.json(p);
}));

// ============================================================ sprints
const sprintFields = {
  name: z.string().trim().min(1).max(100), goal: z.string().max(2000),
  startDate: date.nullable(), endDate: date.nullable(),
};

router.get('/sprints', wrap(async (req, res) => {
  res.json((await prisma.sprint.findMany({ orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }] })).map(S.sprint));
}));

router.post('/sprints', member, wrap(async (req, res) => {
  const body = parse(z.object({ ...sprintFields, weeks: z.number().int().min(1).max(8).optional() }).partial({ goal: true, startDate: true, endDate: true, weeks: true }), req.body);
  const sprint = await work(async (tx, after) => {
    const project = await T.getProject(tx);
    let end = body.endDate ?? null;
    if (body.startDate && !end) end = addDays(body.startDate, (body.weeks ?? project.settings?.sprintWeeks ?? 2) * 7 - 1);
    if (body.startDate && end && end < body.startDate) throw bad('End date must be after the start date');
    const s = await tx.sprint.create({ data: { projectId: project.id, name: body.name, goal: body.goal ?? '', startDate: S.day(body.startDate), endDate: S.day(end) } });
    await audit(tx, req.user.id, 'sprint.create', 'sprint', s.id, null, { name: s.name });
    after(() => realtime.broadcast('sprint.created', { sprint: S.sprint(s) }));
    return S.sprint(s);
  });
  res.status(201).json(sprint);
}));

router.patch('/sprints/:id', member, wrap(async (req, res) => {
  const body = parse(z.object(sprintFields).partial(), req.body);
  const sprint = await work(async (tx, after) => {
    const cur = await tx.sprint.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound('Sprint not found');
    const start = 'startDate' in body ? body.startDate : S.iso(cur.startDate);
    const end = 'endDate' in body ? body.endDate : S.iso(cur.endDate);
    if (start && end && end < start) throw bad('End date must be after the start date');
    const s = await tx.sprint.update({
      where: { id: cur.id },
      data: { name: body.name, goal: body.goal, startDate: 'startDate' in body ? S.day(body.startDate) : undefined, endDate: 'endDate' in body ? S.day(body.endDate) : undefined },
    });
    await audit(tx, req.user.id, 'sprint.update', 'sprint', s.id, S.sprint(cur), S.sprint(s));
    after(() => realtime.broadcast('sprint.updated', { sprint: S.sprint(s) }));
    return S.sprint(s);
  });
  res.json(sprint);
}));

router.post('/sprints/:id/start', member, wrap(async (req, res) => {
  const sprint = await work(async (tx, after) => {
    const cur = await tx.sprint.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound('Sprint not found');
    if (cur.status !== 'planned') throw bad('Only a planned sprint can be started');
    const active = await tx.sprint.findFirst({ where: { projectId: cur.projectId, status: 'active' } });
    if (active) throw bad(`"${active.name}" is already active. Complete it before starting another sprint.`);
    const project = await T.getProject(tx);
    const start = S.iso(cur.startDate) ?? S.today();
    const end = S.iso(cur.endDate) ?? addDays(start, (project.settings?.sprintWeeks ?? 2) * 7 - 1);
    const s = await tx.sprint.update({ where: { id: cur.id }, data: { status: 'active', startedAt: new Date(), startDate: S.day(start), endDate: S.day(end) } });
    await audit(tx, req.user.id, 'sprint.start', 'sprint', s.id, null, { startDate: start, endDate: end });
    after(() => realtime.broadcast('sprint.updated', { sprint: S.sprint(s) }));
    return S.sprint(s);
  });
  res.json(sprint);
}));

/** Complete the sprint; unfinished tasks go to the backlog or to another sprint (`moveTo`). */
router.post('/sprints/:id/complete', member, wrap(async (req, res) => {
  const body = parse(z.object({ moveTo: z.union([z.literal('backlog'), uuid]).default('backlog') }), req.body);
  const sprint = await work(async (tx, after) => {
    const cur = await tx.sprint.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound('Sprint not found');
    if (cur.status !== 'active') throw bad('Only the active sprint can be completed');
    let target = null;
    if (body.moveTo !== 'backlog') {
      target = await tx.sprint.findUnique({ where: { id: body.moveTo } });
      if (!target || target.status !== 'planned') throw bad('Choose a planned sprint to move unfinished tasks into');
    }
    const tasks = await tx.task.findMany({ where: { sprintId: cur.id }, include: { status: { select: { category: true } } } });
    const done = tasks.filter((t) => t.status.category === 'done');
    const open = tasks.filter((t) => t.status.category !== 'done');
    const sum = (arr) => arr.reduce((a, t) => a + (t.points || 0), 0);
    const snapshot = { committedPoints: sum(tasks), completedPoints: sum(done), tasks: tasks.length, doneTasks: done.length, movedTasks: open.length, movedTo: target ? target.name : 'backlog' };
    if (open.length) {
      await tx.task.updateMany({ where: { id: { in: open.map((t) => t.id) } }, data: { sprintId: target ? target.id : null, version: { increment: 1 }, updatedAt: new Date() } });
    }
    const s = await tx.sprint.update({ where: { id: cur.id }, data: { status: 'completed', completedAt: new Date(), snapshot } });
    await audit(tx, req.user.id, 'sprint.complete', 'sprint', s.id, null, snapshot);
    after(() => { realtime.broadcast('sprint.updated', { sprint: S.sprint(s) }); realtime.broadcast('tasks.refresh'); });
    return S.sprint(s);
  });
  res.json(sprint);
}));

router.delete('/sprints/:id', member, wrap(async (req, res) => {
  await work(async (tx, after) => {
    const cur = await tx.sprint.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound('Sprint not found');
    if (cur.status === 'active') throw bad('Complete the active sprint before deleting it');
    await tx.favorite.deleteMany({ where: { entityType: 'sprint', entityId: cur.id } });
    await tx.recentVisit.deleteMany({ where: { entityType: 'sprint', entityId: cur.id } });
    await tx.sprint.delete({ where: { id: cur.id } }); // its tasks fall back to the backlog (FK SET NULL)
    await audit(tx, req.user.id, 'sprint.delete', 'sprint', cur.id, { name: cur.name }, null);
    after(() => { realtime.broadcast('sprint.deleted', { id: cur.id }); realtime.broadcast('tasks.refresh'); });
  });
  res.json({ ok: true });
}));

/** Burndown: remaining work per day vs the ideal line. Uses points, or task counts if no points are set. */
router.get('/sprints/:id/burndown', wrap(async (req, res) => {
  const s = await prisma.sprint.findUnique({ where: { id: req.params.id } });
  if (!s) throw notFound('Sprint not found');
  if (!s.startDate || !s.endDate) return res.json({ days: [], unit: 'points' });
  const tasks = await prisma.task.findMany({ where: { sprintId: s.id }, select: { points: true, completedAt: true } });
  const usePoints = tasks.some((t) => t.points);
  const w = (t) => (usePoints ? t.points || 0 : 1);
  const snap = s.snapshot;
  const total = s.status === 'completed' && snap ? (usePoints ? snap.committedPoints : snap.tasks) : tasks.reduce((a, t) => a + w(t), 0);
  const start = S.iso(s.startDate), end = S.iso(s.endDate), today = S.today();
  const days = [];
  const n = Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 864e5);
  for (let i = 0; i <= n; i++) {
    const d = addDays(start, i);
    const point = { date: d, ideal: Math.max(0, total - (total * i) / Math.max(n, 1)) };
    if (d <= today || s.status === 'completed') {
      const doneBy = tasks.filter((t) => t.completedAt && S.iso(t.completedAt) <= d).reduce((a, t) => a + w(t), 0);
      point.remaining = Math.max(0, total - doneBy);
    }
    days.push(point);
  }
  res.json({ days, total, unit: usePoints ? 'points' : 'tasks' });
}));

// ============================================================ milestones
// A milestone's status is automatic: complete when it has tasks and all are done (see services/milestones.js).

router.get('/milestones', wrap(async (req, res) => {
  const rows = await prisma.milestone.findMany({ orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }] });
  const stats = await milestoneStats(prisma, rows.map((m) => m.id));
  res.json(rows.map((m) => withStats(m, stats.get(m.id))));
}));

const msFields = { name: z.string().trim().min(1).max(150), description: z.string().max(5000), dueDate: date.nullable(), status: z.enum(['open', 'completed']) };

router.post('/milestones', member, wrap(async (req, res) => {
  const body = parse(z.object(msFields).partial({ description: true, dueDate: true, status: true }), req.body);
  const m = await work(async (tx, after) => {
    const project = await T.getProject(tx);
    const row = await tx.milestone.create({ data: { projectId: project.id, name: body.name, description: body.description ?? '', dueDate: S.day(body.dueDate), status: 'open' } });
    await audit(tx, req.user.id, 'milestone.create', 'milestone', row.id, null, { name: row.name, dueDate: body.dueDate ?? null });
    const out = withStats(row, { total: 0, done: 0, weight: 0, weightDone: 0 });
    after(() => realtime.broadcast('milestone.created', { milestone: out }));
    return out;
  });
  res.status(201).json(m);
}));

router.patch('/milestones/:id', member, wrap(async (req, res) => {
  const body = parse(z.object(msFields).partial(), req.body);
  const m = await work(async (tx, after) => {
    const cur = await tx.milestone.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound('Milestone not found');
    const row = await tx.milestone.update({
      where: { id: cur.id },
      // status is deliberately not editable: it follows the milestone's tasks
      data: { name: body.name, description: body.description, dueDate: 'dueDate' in body ? S.day(body.dueDate) : undefined },
    });
    await audit(tx, req.user.id, 'milestone.update', 'milestone', row.id, S.milestone(cur), S.milestone(row));
    await syncMilestones(tx, after, req.user, [row.id]); // also repairs a milestone whose status had drifted
    const fresh = await tx.milestone.findUnique({ where: { id: row.id } });
    const out = withStats(fresh, (await milestoneStats(tx, [row.id])).get(row.id));
    after(() => realtime.broadcast('milestone.updated', { milestone: out }));
    return out;
  });
  res.json(m);
}));

router.delete('/milestones/:id', member, wrap(async (req, res) => {
  await work(async (tx, after) => {
    const cur = await tx.milestone.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound('Milestone not found');
    await tx.favorite.deleteMany({ where: { entityType: 'milestone', entityId: cur.id } });
    await tx.recentVisit.deleteMany({ where: { entityType: 'milestone', entityId: cur.id } });
    await tx.milestone.delete({ where: { id: cur.id } }); // tasks keep existing, just unlinked
    await audit(tx, req.user.id, 'milestone.delete', 'milestone', cur.id, { name: cur.name }, null);
    after(() => { realtime.broadcast('milestone.deleted', { id: cur.id }); realtime.broadcast('tasks.refresh'); });
  });
  res.json({ ok: true });
}));

// ============================================================ labels
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

router.post('/labels', member, wrap(async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(40), color: hex.default('#0f9d92') }), req.body);
  const l = await work(async (tx, after) => {
    const project = await T.getProject(tx);
    const row = await tx.label.create({ data: { projectId: project.id, ...body } });
    after(() => realtime.broadcast('label.upserted', { label: row }));
    return row;
  });
  res.status(201).json(l);
}));

router.patch('/labels/:id', member, wrap(async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(40), color: hex }).partial(), req.body);
  const l = await prisma.label.update({ where: { id: req.params.id }, data: body });
  realtime.broadcast('label.upserted', { label: l });
  res.json(l);
}));

router.delete('/labels/:id', member, wrap(async (req, res) => {
  await prisma.label.delete({ where: { id: req.params.id } });
  realtime.broadcast('label.deleted', { id: req.params.id });
  realtime.broadcast('tasks.refresh');
  res.json({ ok: true });
}));

// ============================================================ workflow statuses (admin)
const statusShape = z.object({ name: z.string().trim().min(1).max(40), category: z.enum(['todo', 'doing', 'done']), color: hex });

async function broadcastStatuses(db) {
  realtime.broadcast('statuses.updated', { statuses: await db.status.findMany({ orderBy: { position: 'asc' } }) });
}

router.post('/statuses', admin, wrap(async (req, res) => {
  const body = parse(statusShape.partial({ color: true }), req.body);
  const project = await T.getProject(prisma);
  const max = await prisma.status.aggregate({ where: { projectId: project.id }, _max: { position: true } });
  const s = await prisma.status.create({ data: { projectId: project.id, name: body.name, category: body.category, color: body.color ?? '#64748b', position: (max._max.position ?? -1) + 1 } });
  await audit(prisma, req.user.id, 'status.create', 'status', s.id, null, { name: s.name });
  await broadcastStatuses(prisma);
  res.status(201).json(s);
}));

router.patch('/statuses/:id', admin, wrap(async (req, res) => {
  const body = parse(statusShape.partial(), req.body);
  const out = await work(async (tx, after) => {
    const cur = await tx.status.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound('Status not found');
    if (body.category && body.category !== cur.category) {
      const same = await tx.status.count({ where: { projectId: cur.projectId, category: cur.category, id: { not: cur.id } } });
      if (!same && (cur.category === 'todo' || cur.category === 'done')) throw bad('The workflow needs at least one "todo" and one "done" status');
    }
    const s = await tx.status.update({ where: { id: cur.id }, data: body });
    await audit(tx, req.user.id, 'status.update', 'status', s.id, { name: cur.name, category: cur.category }, { name: s.name, category: s.category });
    if (s.category !== cur.category) await syncAllMilestones(tx, after, req.user); // what counts as "done" changed
    return s;
  });
  await broadcastStatuses(prisma);
  res.json(out);
}));

/** Reorder: body { ids: [all status ids in the new order] } */
router.put('/statuses/order', admin, wrap(async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(uuid).min(1) }), req.body);
  await prisma.$transaction(ids.map((id, i) => prisma.status.update({ where: { id }, data: { position: i } })));
  await broadcastStatuses(prisma);
  res.json({ ok: true });
}));

router.delete('/statuses/:id', admin, wrap(async (req, res) => {
  const { moveTo } = parse(z.object({ moveTo: uuid.optional() }), req.query);
  await work(async (tx, after) => {
    const cur = await tx.status.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound('Status not found');
    const same = await tx.status.count({ where: { projectId: cur.projectId, category: cur.category, id: { not: cur.id } } });
    if (!same && (cur.category === 'todo' || cur.category === 'done')) throw bad('The workflow needs at least one "todo" and one "done" status');
    const inUse = await tx.task.count({ where: { statusId: cur.id } });
    if (inUse) {
      if (!moveTo) throw bad(`${inUse} task(s) use this status. Choose a status to move them to.`);
      if (moveTo === cur.id) throw bad('Choose a different status');
      const dest = await tx.status.findUnique({ where: { id: moveTo } });
      if (!dest) throw bad('Destination status not found');
      await tx.task.updateMany({ where: { statusId: cur.id }, data: { statusId: dest.id, version: { increment: 1 }, updatedAt: new Date(), completedAt: dest.category === 'done' ? new Date() : null } });
    }
    await tx.status.delete({ where: { id: cur.id } });
    await audit(tx, req.user.id, 'status.delete', 'status', cur.id, { name: cur.name }, null);
    await syncAllMilestones(tx, after, req.user); // moved tasks may have become done (or not)
    after(() => realtime.broadcast('tasks.refresh'));
  });
  await broadcastStatuses(prisma);
  res.json({ ok: true });
}));

// ============================================================ task templates
const tplData = z.object({
  title: z.string().max(300).optional(), type: z.enum(['task', 'story', 'bug', 'improvement', 'epic']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(), description: z.string().max(100000).optional(),
  points: z.number().min(0).max(1000).nullable().optional(), labelIds: z.array(uuid).optional(),
  subtasks: z.array(z.union([z.string().max(300), z.object({ title: z.string().max(300) })])).max(50).optional(),
});
const tplView = (t) => ({ id: t.id, name: t.name, data: t.data, createdBy: t.createdBy, createdAt: t.createdAt });

router.get('/templates', wrap(async (req, res) => {
  res.json((await prisma.taskTemplate.findMany({ orderBy: { name: 'asc' } })).map(tplView));
}));

router.post('/templates', member, wrap(async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(100), data: tplData }), req.body);
  const project = await T.getProject(prisma);
  const t = await prisma.taskTemplate.create({ data: { projectId: project.id, name: body.name, data: body.data, createdBy: req.user.id } });
  await audit(prisma, req.user.id, 'template.create', 'template', t.id, null, { name: t.name });
  realtime.broadcast('template.upserted', { template: tplView(t) });
  res.status(201).json(tplView(t));
}));

router.patch('/templates/:id', member, wrap(async (req, res) => {
  const body = parse(z.object({ name: z.string().trim().min(1).max(100), data: tplData }).partial(), req.body);
  const t = await prisma.taskTemplate.update({ where: { id: req.params.id }, data: body });
  realtime.broadcast('template.upserted', { template: tplView(t) });
  res.json(tplView(t));
}));

router.delete('/templates/:id', member, wrap(async (req, res) => {
  await prisma.taskTemplate.delete({ where: { id: req.params.id } });
  realtime.broadcast('template.deleted', { id: req.params.id });
  res.json({ ok: true });
}));

module.exports = router;
