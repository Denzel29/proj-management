const realtime = require('../realtime');
const S = require('./serialize');
const { audit } = require('./core');

/** Progress per milestone from its linked tasks, weighted by points (1 when unestimated). */
async function milestoneStats(db, ids) {
  const tasks = await db.task.findMany({ where: { milestoneId: { in: ids } }, select: { milestoneId: true, points: true, status: { select: { category: true } } } });
  const out = new Map(ids.map((id) => [id, { total: 0, done: 0, weight: 0, weightDone: 0 }]));
  for (const t of tasks) {
    const o = out.get(t.milestoneId); const w = t.points || 1;
    o.total++; o.weight += w;
    if (t.status.category === 'done') { o.done++; o.weightDone += w; }
  }
  return out;
}

const withStats = (m, st) => ({
  ...S.milestone(m), taskCount: st.total, doneCount: st.done,
  progress: st.weight ? Math.round((st.weightDone / st.weight) * 100) : 0,
});

/**
 * A milestone is complete exactly when it has tasks and every one of them is done. Call this whenever
 * tasks change (status, milestone link, create, delete) and it flips the milestone's status to match,
 * with an audit entry and a live update. `ids` may contain nulls and duplicates.
 */
async function syncMilestones(tx, after, actor, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return;
  const rows = await tx.milestone.findMany({ where: { id: { in: list } } });
  const stats = await milestoneStats(tx, rows.map((m) => m.id));
  for (const m of rows) {
    const st = stats.get(m.id);
    const want = st.total > 0 && st.done === st.total ? 'completed' : 'open';
    if (want === m.status) continue;
    const updated = await tx.milestone.update({ where: { id: m.id }, data: { status: want } });
    await audit(tx, actor?.id ?? null, 'milestone.auto_status', 'milestone', m.id, { status: m.status }, { status: want });
    after(() => realtime.broadcast('milestone.updated', { milestone: withStats(updated, st) }));
  }
}

/** Re-check every milestone (used at start-up and when the workflow changes what counts as done). */
async function syncAllMilestones(tx, after, actor) {
  const all = await tx.milestone.findMany({ select: { id: true } });
  await syncMilestones(tx, after, actor, all.map((m) => m.id));
}

module.exports = { milestoneStats, withStats, syncMilestones, syncAllMilestones };
