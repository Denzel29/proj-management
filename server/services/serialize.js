// Converts Prisma rows into the JSON shapes the frontend uses.

/** @db.Date columns come back as JS Dates at UTC midnight; the API uses 'YYYY-MM-DD'. */
const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);
/** 'YYYY-MM-DD' -> Date at UTC midnight (for @db.Date columns). */
const day = (s) => (s ? new Date(`${s}T00:00:00.000Z`) : null);
const today = () => iso(new Date());

const user = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, color: u.color, active: u.active, prefs: u.prefs, createdAt: u.createdAt, lastSeenAt: u.lastSeenAt });

const sprint = (s) => ({
  id: s.id, name: s.name, goal: s.goal, startDate: iso(s.startDate), endDate: iso(s.endDate), status: s.status,
  snapshot: s.snapshot, startedAt: s.startedAt, completedAt: s.completedAt, createdAt: s.createdAt,
});

const milestone = (m) => ({ id: m.id, name: m.name, description: m.description, dueDate: iso(m.dueDate), status: m.status, createdAt: m.createdAt });

/** Relations a task row must be loaded with to be serialized. */
const TASK_INCLUDE = {
  labels: { select: { labelId: true } },
  watchers: { select: { userId: true } },
  status: { select: { category: true } },
  project: { select: { key: true } },
};

/** `stats` = per-task counters computed in batch by the tasks service. */
function task(t, stats = {}) {
  return {
    id: t.id, key: `${t.project.key}-${t.num}`, num: t.num, title: t.title, description: t.description,
    type: t.type, statusId: t.statusId, statusCategory: t.status.category, priority: t.priority,
    assigneeId: t.assigneeId, reporterId: t.reporterId, parentId: t.parentId, sprintId: t.sprintId,
    milestoneId: t.milestoneId, points: t.points, estimateMin: t.estimateMin,
    startDate: iso(t.startDate), dueDate: iso(t.dueDate), rank: t.rank, version: t.version,
    recurrence: t.recurrence, completedAt: t.completedAt, createdAt: t.createdAt, updatedAt: t.updatedAt,
    labelIds: t.labels.map((l) => l.labelId).sort(), watcherIds: t.watchers.map((w) => w.userId).sort(),
    childCount: stats.childCount || 0, childDone: stats.childDone || 0, loggedMin: stats.loggedMin || 0,
    commentCount: stats.commentCount || 0, attachmentCount: stats.attachmentCount || 0,
  };
}

module.exports = { iso, day, today, user, sprint, milestone, task, TASK_INCLUDE };
