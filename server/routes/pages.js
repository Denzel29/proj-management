const express = require('express');
const { prisma } = require('../db');
const realtime = require('../realtime');
const { work, audit, extractMentions } = require('../services/core');
const { notify } = require('../services/notify');
const { removeTargets } = require('../services/cleanup');
const T = require('../services/tasks');
const PT = require('../services/pageTemplates');
const H = require('../http');

const { z, uuid, wrap, parse, bad, notFound, conflict, requireRole } = H;
const router = express.Router();
const member = requireRole('member');

const MAX_CHARS = 500000;

/** List/tree shape: everything except the (possibly large) content. */
const meta = (p) => ({ id: p.id, title: p.title, icon: p.icon, parentId: p.parentId, position: p.position, createdBy: p.createdBy, updatedBy: p.updatedBy, createdAt: p.createdAt, updatedAt: p.updatedAt });
const full = (p) => ({ ...meta(p), content: p.content });

async function subtreeIds(db, id) {
  const rows = await db.$queryRaw`
    WITH RECURSIVE d AS (
      SELECT id FROM "Page" WHERE id = ${id}::uuid
      UNION ALL SELECT p.id FROM "Page" p JOIN d ON p."parentId" = d.id)
    SELECT id FROM d`;
  return rows.map((r) => r.id);
}

router.get('/page-templates', (req, res) => res.json(PT.list()));

router.get('/pages', wrap(async (req, res) => {
  const rows = await prisma.page.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, icon: true, parentId: true, position: true, createdBy: true, updatedBy: true, createdAt: true, updatedAt: true } });
  res.json(rows.map(meta));
}));

router.get('/pages/:id', wrap(async (req, res) => {
  const p = await prisma.page.findUnique({ where: { id: req.params.id } });
  if (!p) throw notFound('Page not found');
  res.json(full(p));
}));

router.post('/pages', member, wrap(async (req, res) => {
  const body = parse(z.object({
    title: z.string().trim().min(1).max(200).optional(), icon: z.string().trim().min(1).max(16).optional(),
    parentId: uuid.nullable().optional(), content: z.string().max(MAX_CHARS).optional(),
    template: z.string().max(30).optional(),
  }), req.body);
  const tpl = body.template ? PT.TEMPLATES[body.template] : null;
  if (body.template && !tpl) throw bad('Unknown page template');

  const page = await work(async (tx, after) => {
    const project = await T.getProject(tx);
    if (body.parentId && !(await tx.page.findUnique({ where: { id: body.parentId }, select: { id: true } }))) throw bad('Parent page not found');
    const max = await tx.page.aggregate({ where: { parentId: body.parentId ?? null }, _max: { position: true } });
    const p = await tx.page.create({
      data: {
        projectId: project.id, parentId: body.parentId ?? null, createdBy: req.user.id, updatedBy: req.user.id,
        title: body.title ?? tpl?.title ?? 'Untitled', icon: body.icon ?? tpl?.icon ?? '📄',
        content: body.content ?? tpl?.content ?? '', position: (max._max.position ?? 0) + 1000,
      },
    });
    await audit(tx, req.user.id, 'page.create', 'page', p.id, null, { title: p.title, parentId: p.parentId });
    after(() => realtime.broadcast('page.created', { page: full(p) }));
    return p;
  });
  res.status(201).json(full(page));
}));

/**
 * Edit a page. Send `baseUpdatedAt` (the updatedAt you loaded) to be told if someone else saved
 * in the meantime (409 with their version) instead of silently overwriting them.
 */
router.patch('/pages/:id', member, wrap(async (req, res) => {
  const body = parse(z.object({
    title: z.string().trim().min(1).max(200), icon: z.string().trim().min(1).max(16),
    content: z.string().max(MAX_CHARS), parentId: uuid.nullable(), position: z.number(),
  }).partial().extend({ baseUpdatedAt: z.string().optional() }), req.body);
  const { baseUpdatedAt, ...patch } = body;

  const page = await work(async (tx, after) => {
    const cur = await tx.page.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound('Page not found');
    if (baseUpdatedAt && new Date(baseUpdatedAt).getTime() !== cur.updatedAt.getTime()) {
      throw conflict('This page was changed by someone else', { current: full(cur) });
    }
    if ('parentId' in patch && patch.parentId) {
      if ((await subtreeIds(tx, cur.id)).includes(patch.parentId)) throw bad('A page cannot be moved inside itself');
      if (!(await tx.page.findUnique({ where: { id: patch.parentId }, select: { id: true } }))) throw bad('Parent page not found');
    }
    const p = await tx.page.update({ where: { id: cur.id }, data: { ...patch, updatedAt: new Date(), updatedBy: req.user.id } });

    // audit stores metadata changes and the content size, not the whole document
    const b = {}, a = {};
    for (const k of ['title', 'icon', 'parentId']) if (k in patch && patch[k] !== cur[k]) { b[k] = cur[k]; a[k] = p[k]; }
    if ('content' in patch && patch.content !== cur.content) { b.contentChars = cur.content.length; a.contentChars = p.content.length; }
    if (Object.keys(a).length) await audit(tx, req.user.id, 'page.update', 'page', p.id, b, a);

    if ('content' in patch) {
      const old = new Set(extractMentions(cur.content));
      const fresh = extractMentions(p.content).filter((id) => !old.has(id));
      if (fresh.length) await notify(tx, after, { userIds: fresh, type: 'mention', actorId: req.user.id, entityType: 'page', entityId: p.id, title: `${req.user.name} mentioned you in ${p.title}`, detail: '' });
    }
    after(() => realtime.broadcast('page.updated', { page: full(p) }));
    return p;
  });
  res.json(full(page));
}));

router.delete('/pages/:id', member, wrap(async (req, res) => {
  await work(async (tx, after) => {
    const cur = await tx.page.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound('Page not found');
    const ids = await subtreeIds(tx, cur.id);
    await removeTargets(tx, after, 'page', ids);
    await tx.page.delete({ where: { id: cur.id } }); // child pages cascade
    await audit(tx, req.user.id, 'page.delete', 'page', cur.id, { title: cur.title, subpages: ids.length - 1 }, null);
    after(() => realtime.broadcast('page.deleted', { ids }));
  });
  res.json({ ok: true });
}));

module.exports = router;
