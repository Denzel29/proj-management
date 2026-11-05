const express = require('express');
const { prisma } = require('../db');
const H = require('../http');

const { z, uuid, wrap, parse } = H;
const router = express.Router();

const ENTITY = z.enum(['page', 'task', 'sprint', 'milestone']);

// ---------------- notifications ----------------
const notifView = (n) => ({ id: n.id, type: n.type, actorId: n.actorId, entityType: n.entityType, entityId: n.entityId, data: n.data, readAt: n.readAt, createdAt: n.createdAt });

router.get('/notifications', wrap(async (req, res) => {
  const { unread, limit } = parse(z.object({ unread: z.enum(['1', '0']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  const where = { userId: req.user.id, ...(unread === '1' ? { readAt: null } : {}) };
  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
    prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
  ]);
  res.json({ notifications: rows.map(notifView), unreadCount });
}));

/** Mark some (ids) or all notifications as read. */
router.post('/notifications/read', wrap(async (req, res) => {
  const body = parse(z.object({ ids: z.array(uuid).optional(), all: z.boolean().optional() }), req.body);
  const where = { userId: req.user.id, readAt: null, ...(body.all ? {} : { id: { in: body.ids || [] } }) };
  await prisma.notification.updateMany({ where, data: { readAt: new Date() } });
  res.json({ unreadCount: await prisma.notification.count({ where: { userId: req.user.id, readAt: null } }) });
}));

// ---------------- favorites ----------------
router.get('/favorites', wrap(async (req, res) => {
  res.json(await prisma.favorite.findMany({ where: { userId: req.user.id }, orderBy: { position: 'asc' } }));
}));

router.put('/favorites', wrap(async (req, res) => {
  const b = parse(z.object({ entityType: ENTITY, entityId: uuid }), req.body);
  const max = await prisma.favorite.aggregate({ where: { userId: req.user.id }, _max: { position: true } });
  const key = { userId_entityType_entityId: { userId: req.user.id, entityType: b.entityType, entityId: b.entityId } };
  await prisma.favorite.upsert({ where: key, create: { userId: req.user.id, ...b, position: (max._max.position ?? 0) + 1 }, update: {} });
  res.json({ ok: true });
}));

router.delete('/favorites/:entityType/:entityId', wrap(async (req, res) => {
  await prisma.favorite.deleteMany({ where: { userId: req.user.id, entityType: req.params.entityType, entityId: req.params.entityId } });
  res.json({ ok: true });
}));

// ---------------- recently visited ----------------
router.get('/recent', wrap(async (req, res) => {
  res.json(await prisma.recentVisit.findMany({ where: { userId: req.user.id }, orderBy: { visitedAt: 'desc' }, take: 12 }));
}));

router.post('/recent', wrap(async (req, res) => {
  const b = parse(z.object({ entityType: ENTITY, entityId: uuid }), req.body);
  const key = { userId_entityType_entityId: { userId: req.user.id, entityType: b.entityType, entityId: b.entityId } };
  await prisma.recentVisit.upsert({ where: key, create: { userId: req.user.id, ...b }, update: { visitedAt: new Date() } });
  res.json({ ok: true });
}));

// ---------------- saved filters ----------------
router.get('/filters', wrap(async (req, res) => {
  res.json(await prisma.savedFilter.findMany({ where: { userId: req.user.id }, orderBy: { name: 'asc' } }));
}));

router.post('/filters', wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(80), scope: z.string().max(30).default('tasks'), filter: z.record(z.any()) }), req.body);
  res.status(201).json(await prisma.savedFilter.create({ data: { userId: req.user.id, ...b } }));
}));

router.delete('/filters/:id', wrap(async (req, res) => {
  await prisma.savedFilter.deleteMany({ where: { id: req.params.id, userId: req.user.id } });
  res.json({ ok: true });
}));

module.exports = router;
