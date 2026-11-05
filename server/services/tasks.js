const { Prisma } = require('../db');
const realtime = require('../realtime');
const S = require('./serialize');
const { audit, diff, extractMentions } = require('./core');
const { notify } = require('./notify');
const { removeTargets } = require('./cleanup');
const { bad, notFound, conflict } = require('../http');

/** The single project this workspace tracks. */
async function getProject(db) {
  const p = await db.project.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!p) throw notFound('Project not set up yet');
  return p;
}

// ---------------------------------------------------------------- loading
const countMap = (rows, key, pick) => new Map(rows.map((r) => [r[key], pick(r)]));

/** Serialize task rows, adding child/time/comment/attachment counters in a few batched queries. */
async function decorate(db, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [kids, kidsDone, time, comments, atts] = await Promise.all([
    db.task.groupBy({ by: ['parentId'], where: { parentId: { in: ids } }, _count: { _all: true } }),
    db.task.groupBy({ by: ['parentId'], where: { parentId: { in: ids }, status: { category: 'done' } }, _count: { _all: true } }),
    db.timeLog.groupBy({ by: ['taskId'], where: { taskId: { in: ids } }, _sum: { minutes: true } }),
    db.comment.groupBy({ by: ['targetId'], where: { targetType: 'task', targetId: { in: ids }, deletedAt: null }, _count: { _all: true } }),
    db.attachment.groupBy({ by: ['targetId'], where: { targetType: 'task', targetId: { in: ids } }, _count: { _all: true } }),
  ]);
  const k = countMap(kids, 'parentId', (r) => r._count._all);
  const kd = countMap(kidsDone, 'parentId', (r) => r._count._all);
  const tl = countMap(time, 'taskId', (r) => r._sum.minutes);
  const cm = countMap(comments, 'targetId', (r) => r._count._all);
  const at = countMap(atts, 'targetId', (r) => r._count._all);
  return rows.map((r) => S.task(r, {
    childCount: k.get(r.id), childDone: kd.get(r.id), loggedMin: tl.get(r.id),
    commentCount: cm.get(r.id), attachmentCount: at.get(r.id),
  }));
}

async function loadTasks(db, where = {}) {
  const rows = await db.task.findMany({ where, include: S.TASK_INCLUDE, orderBy: [{ rank: 'asc' }, { num: 'asc' }] });
  return decorate(db, rows);
}

async function loadTask(db, id) {
  const row = await db.task.findUnique({ where: { id }, include: S.TASK_INCLUDE });
  return row ? (await decorate(db, [row]))[0] : null;
}

// ---------------------------------------------------------------- helpers
// Fields a client may change.
const FIELDS = ['title', 'description', 'type', 'statusId', 'priority', 'assigneeId', 'parentId', 'sprintId',
  'milestoneId', 'points', 'estimateMin', 'startDate', 'dueDate', 'recurrence', 'rank'];

/** API patch -> Prisma data (dates to Date, '' to null, JSON null handling). */
function toData(patch) {
  const d = {};
  for (const k of FIELDS) {
    if (!(k in patch)) continue;
    let v = patch[k] === '' ? null : patch[k];
    if (k === 'startDate' || k === 'dueDate') v = S.day(v);
    if (k === 'recurrence' && v === null) v = Prisma.DbNull;
    d[k] = v;
  }
  return d;
}

async function subtreeIds(db, id) {
  const rows = await db.$queryRaw`
    WITH RECURSIVE d AS (
      SELECT id FROM "Task" WHERE id = ${id}::uuid
      UNION ALL SELECT t.id FROM "Task" t JOIN d ON t."parentId" = d.id)
    SELECT id FROM d`;
  return rows.map((r) => r.id);
}

/** Ensures nesting `taskId` under `parentId` creates no cycle and stays within the depth limit. */
async function checkParent(db, project, taskId, parentId) {
  if (!parentId) return;
  if (taskId && (await subtreeIds(db, taskId)).includes(parentId)) throw bad('A task cannot be nested under itself or its own subtask');
  const max = project.settings?.maxSubtaskDepth ?? 3;
  const [anc] = await db.$queryRaw`
    WITH RECURSIVE a AS (
      SELECT id, "parentId", 1 AS lvl FROM "Task" WHERE id = ${parentId}::uuid
      UNION ALL SELECT t.id, t."parentId", a.lvl + 1 FROM "Task" t JOIN a ON t.id = a."parentId")
    SELECT max(lvl)::int AS depth FROM a`;
  if (!anc?.depth) throw bad('Parent task not found');
  let height = 1;
  if (taskId) {
    const [h] = await db.$queryRaw`
      WITH RECURSIVE d AS (
        SELECT id, 1 AS lvl FROM "Task" WHERE id = ${taskId}::uuid
        UNION ALL SELECT t.id, d.lvl + 1 FROM "Task" t JOIN d ON t."parentId" = d.id)
      SELECT max(lvl)::int AS h FROM d`;
    height = h.h;
  }
  if (anc.depth + height > max) throw bad(`Tasks can only be nested ${max} levels deep`);
}

async function statusCategory(db, statusId) {
  const s = await db.status.findUnique({ where: { id: statusId } });
  if (!s) throw bad('Unknown status');
  return s.category;
}

const addWatcher = async (db, taskId, userId) => {
  if (userId) await db.taskWatcher.upsert({ where: { taskId_userId: { taskId, userId } }, create: { taskId, userId }, update: {} });
};

async function setLabels(db, taskId, labelIds) {
  await db.taskLabel.deleteMany({ where: { taskId } });
  const ids = [...new Set(labelIds)];
  if (ids.length) await db.taskLabel.createMany({ data: ids.map((labelId) => ({ taskId, labelId })), skipDuplicates: true });
}

async function notifyMentions(tx, after, actor, task, oldText, newText) {
  const old = new Set(extractMentions(oldText));
  const fresh = extractMentions(newText).filter((id) => !old.has(id));
  if (!fresh.length) return;
  await notify(tx, after, {
    userIds: fresh, type: 'mention', actorId: actor.id, entityType: 'task', entityId: task.id,
    title: `${actor.name} mentioned you in ${task.key}`, detail: task.title,
  });
}

// ---------------------------------------------------------------- create
/** Create a task, optionally from a template (which can also create subtasks). */
async function createTask(tx, after, actor, input) {
  const project = await getProject(tx);
  let data = { ...input };
  let subtasks = [];

  if (input.templateId) {
    const tpl = await tx.taskTemplate.findUnique({ where: { id: input.templateId } });
    if (!tpl) throw bad('Template not found');
    const t = tpl.data || {};
    data = { type: t.type, priority: t.priority, description: t.description, labelIds: t.labelIds, points: t.points, ...input };
    if (!data.title) data.title = t.title || tpl.name;
    subtasks = t.subtasks || [];
  }

  if (!data.statusId) {
    const first = await tx.status.findFirst({ where: { projectId: project.id, category: 'todo' }, orderBy: { position: 'asc' } });
    data.statusId = first.id;
  }
  await checkParent(tx, project, null, data.parentId);
  const cat = await statusCategory(tx, data.statusId);

  const bumped = await tx.project.update({ where: { id: project.id }, data: { nextTaskNum: { increment: 1 } } });
  const maxRank = await tx.task.aggregate({ where: { projectId: project.id }, _max: { rank: true } });

  const created = await tx.task.create({
    data: {
      projectId: project.id, num: bumped.nextTaskNum - 1, title: data.title, description: data.description ?? '',
      type: data.type ?? 'task', statusId: data.statusId, priority: data.priority ?? 'medium',
      assigneeId: data.assigneeId ?? null, reporterId: actor.id, parentId: data.parentId ?? null,
      sprintId: data.sprintId ?? null, milestoneId: data.milestoneId ?? null, points: data.points ?? null,
      estimateMin: data.estimateMin ?? null, startDate: S.day(data.startDate), dueDate: S.day(data.dueDate),
      rank: data.rank ?? (maxRank._max.rank ?? 0) + 1000, recurrence: data.recurrence ?? undefined,
      completedAt: cat === 'done' ? new Date() : null,
    },
  });

  if (data.labelIds?.length) await setLabels(tx, created.id, data.labelIds);
  await addWatcher(tx, created.id, actor.id);
  await addWatcher(tx, created.id, data.assigneeId);

  for (const [i, st] of subtasks.entries()) {
    const title = typeof st === 'string' ? st : st.title;
    if (title) await createTask(tx, after, actor, { title, parentId: created.id, rank: (i + 1) * 1000, sprintId: data.sprintId ?? null, milestoneId: data.milestoneId ?? null });
  }

  const task = await loadTask(tx, created.id);
  await audit(tx, actor.id, 'task.create', 'task', task.id, null, { key: task.key, title: task.title, assigneeId: task.assigneeId, sprintId: task.sprintId });
  await notify(tx, after, {
    userIds: [data.assigneeId], type: 'assigned', actorId: actor.id, entityType: 'task', entityId: task.id,
    title: `${actor.name} assigned you ${task.key}`, detail: task.title,
  });
  await notifyMentions(tx, after, actor, task, '', task.description);

  after(() => realtime.broadcast('task.created', { task }));
  return task;
}

// ---------------------------------------------------------------- recurrence
function nextDate(base, rec) {
  const d = base ? new Date(`${base}T00:00:00Z`) : new Date(`${S.today()}T00:00:00Z`);
  const n = rec.every || 1;
  if (rec.unit === 'day') d.setUTCDate(d.getUTCDate() + n);
  else if (rec.unit === 'week') d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (rec.unit === 'month') d.setUTCMonth(d.getUTCMonth() + n);
  else if (rec.unit === 'year') d.setUTCFullYear(d.getUTCFullYear() + n);
  return S.iso(d);
}

/** When a recurring task is completed, create the next copy (due date shifted by the rule). */
async function spawnRecurrence(tx, after, actor, task) {
  const rec = task.recurrence;
  const project = await getProject(tx);
  const first = await tx.status.findFirst({ where: { projectId: project.id, category: 'todo' }, orderBy: { position: 'asc' } });
  const shift = (d) => (d ? nextDate(d, rec) : null);
  const copy = await createTask(tx, after, actor, {
    title: task.title, description: task.description, type: task.type, priority: task.priority,
    statusId: first.id, assigneeId: task.assigneeId, parentId: task.parentId, milestoneId: task.milestoneId,
    points: task.points, estimateMin: task.estimateMin, labelIds: task.labelIds, recurrence: rec,
    dueDate: shift(task.dueDate) ?? nextDate(null, rec), startDate: shift(task.startDate),
  });
  await tx.task.update({ where: { id: task.id }, data: { recurrence: Prisma.DbNull } }); // the new copy carries the rule on
  await audit(tx, actor.id, 'task.recur', 'task', task.id, null, { nextTaskId: copy.id });
  return copy;
}

// ---------------------------------------------------------------- update
/**
 * Update a task. `patch` uses API field names (plus `labelIds`). When `version` is given and the
 * task has changed since, a 409 with the current task is returned instead of overwriting.
 */
async function updateTask(tx, after, actor, id, patch, version) {
  const cur = await tx.task.findUnique({ where: { id } });
  if (!cur) throw notFound('Task not found');
  const project = await getProject(tx);
  if (version != null && cur.version !== version) {
    throw conflict('This task was changed by someone else', { current: await loadTask(tx, id) });
  }
  const before = await loadTask(tx, id);

  const data = toData(patch);
  if ('parentId' in patch) await checkParent(tx, project, id, patch.parentId);

  let becameDone = false;
  if ('statusId' in patch) {
    const cat = await statusCategory(tx, patch.statusId);
    const wasDone = before.statusCategory === 'done';
    if (cat === 'done' && !wasDone) { data.completedAt = new Date(); becameDone = true; }
    if (cat !== 'done' && wasDone) data.completedAt = null;
  }

  if (Object.keys(data).length) {
    // The version guard makes a concurrent edit fail loudly instead of silently overwriting it.
    const r = await tx.task.updateMany({
      where: { id, version: cur.version },
      data: { ...data, version: { increment: 1 }, updatedAt: new Date() },
    });
    if (!r.count) throw conflict('This task was changed by someone else', { current: await loadTask(tx, id) });
  }
  if (patch.labelIds) await setLabels(tx, id, patch.labelIds);

  const task = await loadTask(tx, id);
  const keys = FIELDS.filter((k) => k !== 'rank').concat('labelIds');
  const d = diff(before, task, keys);

  if (d.changed.length) {
    await audit(tx, actor.id, 'task.update', 'task', id, d.before, d.after);

    if (d.changed.includes('assigneeId') && task.assigneeId) {
      await addWatcher(tx, id, task.assigneeId);
      await notify(tx, after, {
        userIds: [task.assigneeId], type: 'assigned', actorId: actor.id, entityType: 'task', entityId: id,
        title: `${actor.name} assigned you ${task.key}`, detail: task.title,
      });
    }
    if (d.changed.includes('description')) await notifyMentions(tx, after, actor, task, before.description, task.description);

    const others = d.changed.filter((c) => !['assigneeId', 'description'].includes(c));
    if (others.length) {
      let what = others.map((c) => c.replace(/Id$/, '').replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ');
      if (d.changed.includes('statusId')) {
        const s = await tx.status.findUnique({ where: { id: task.statusId } });
        what = `status to ${s.name}`;
      }
      const watchers = await tx.taskWatcher.findMany({ where: { taskId: id }, select: { userId: true } });
      await notify(tx, after, {
        userIds: watchers.map((w) => w.userId), type: 'watched_update', actorId: actor.id, entityType: 'task', entityId: id,
        title: `${actor.name} changed ${what} on ${task.key}`, detail: task.title,
      });
    }
  }

  let spawned = null;
  if (becameDone && task.recurrence) {
    spawned = await spawnRecurrence(tx, after, actor, task);
    task.recurrence = null;
  }

  after(() => realtime.broadcast('task.updated', { task }));
  return { task, spawned };
}

// ---------------------------------------------------------------- delete
async function deleteTask(tx, after, actor, id) {
  const t = await loadTask(tx, id);
  if (!t) throw notFound('Task not found');
  const subtree = await subtreeIds(tx, id);
  await removeTargets(tx, after, 'task', subtree); // comments, attachments (and files), favorites...
  await tx.task.delete({ where: { id } }); // child tasks cascade
  await audit(tx, actor.id, 'task.delete', 'task', id, { key: t.key, title: t.title }, null);
  after(() => realtime.broadcast('task.deleted', { ids: subtree }));
}

module.exports = { getProject, loadTasks, loadTask, createTask, updateTask, deleteTask, addWatcher, subtreeIds };
