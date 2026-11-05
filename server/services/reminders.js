const { prisma } = require('../db');
const S = require('./serialize');
const { work } = require('./core');
const { notify } = require('./notify');

const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return S.iso(x); };

/**
 * Remind assignees about tasks due today/tomorrow ("due_soon") and tasks that slipped past their
 * date ("overdue", looking back two weeks). Each task gets one reminder of each kind per due date,
 * so running this repeatedly never repeats a notification.
 * Returns the number of reminders sent.
 */
async function runReminders(now = new Date()) {
  const today = S.iso(now);
  const soon = [today, addDays(today, 1)];
  const tasks = await prisma.task.findMany({
    where: {
      assigneeId: { not: null }, status: { category: { not: 'done' } },
      OR: [
        { dueDate: { in: soon.map(S.day) } },
        { dueDate: { lt: S.day(today), gte: S.day(addDays(today, -14)) } },
      ],
    },
    include: { project: { select: { key: true } } },
  });

  let sent = 0;
  for (const t of tasks) {
    const due = S.iso(t.dueDate);
    const type = due >= today ? 'due_soon' : 'overdue';
    const key = `${t.project.key}-${t.num}`;
    const already = await prisma.notification.findFirst({
      where: { userId: t.assigneeId, type, entityType: 'task', entityId: t.id, data: { path: ['dueDate'], equals: due } },
    });
    if (already) continue;
    const title = type === 'overdue'
      ? `${key} is overdue (was due ${due})`
      : `${key} is due ${due === today ? 'today' : 'tomorrow'}`;
    await work((tx, after) => notify(tx, after, {
      userIds: [t.assigneeId], type, actorId: null, entityType: 'task', entityId: t.id, data: { dueDate: due }, title, detail: t.title,
    }));
    sent++;
  }
  return sent;
}

/** Check shortly after start-up, then hourly. */
function start() {
  const tick = () => runReminders().catch((e) => console.error('[reminders]', e.message));
  setTimeout(tick, 30e3).unref();
  setInterval(tick, 3600e3).unref();
}

module.exports = { runReminders, start };
