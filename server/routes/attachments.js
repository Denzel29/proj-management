const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { prisma } = require('../db');
const realtime = require('../realtime');
const { audit } = require('../services/core');
const T = require('../services/tasks');
const H = require('../http');

const { z, uuid, wrap, parse, bad, notFound, forbidden, requireRole } = H;
const router = express.Router();
const member = requireRole('member');

fs.mkdirSync(config.uploadDir, { recursive: true });

// Files are stored under a random id, never under the uploaded name, so names cannot collide or traverse paths.
const upload = multer({
  storage: multer.diskStorage({ destination: config.uploadDir, filename: (req, file, cb) => cb(null, crypto.randomUUID()) }),
  limits: { fileSize: config.maxUploadBytes, files: 10 },
});

const MAX_PER_TARGET = 50;
// Only these are ever shown inline in the browser; everything else is forced to download.
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

const view = (a) => ({
  id: a.id, targetType: a.targetType, targetId: a.targetId, fileName: a.fileName, mime: a.mime,
  sizeBytes: a.sizeBytes, uploaderId: a.uploaderId, createdAt: a.createdAt, url: `/api/attachments/${a.id}/download`,
});

/** The thing a file is attached to must exist (and a comment can only be attached to by its author). */
async function checkTarget(db, type, id, user) {
  if (type === 'task') { if (!(await db.task.findUnique({ where: { id }, select: { id: true } }))) throw notFound('Task not found'); }
  else if (type === 'page') { if (!(await db.page.findUnique({ where: { id }, select: { id: true } }))) throw notFound('Page not found'); }
  else {
    const c = await db.comment.findUnique({ where: { id } });
    if (!c || c.deletedAt) throw notFound('Comment not found');
    if (c.authorId !== user.id) throw forbidden('You can only attach files to your own comments');
  }
}

async function announce(a) {
  realtime.broadcast('attachment.changed', { targetType: a.targetType, targetId: a.targetId });
  if (a.targetType === 'task') {
    const task = await T.loadTask(prisma, a.targetId);
    if (task) realtime.broadcast('task.updated', { task });
  }
}

router.get('/attachments', wrap(async (req, res) => {
  const q = parse(z.object({ targetType: z.enum(['task', 'page', 'comment']), targetId: uuid }), req.query);
  const rows = await prisma.attachment.findMany({ where: q, orderBy: { createdAt: 'asc' } });
  res.json(rows.map(view));
}));

/** Multipart upload: fields targetType + targetId, files in `files` (up to 10 at once). */
router.post('/attachments', member, upload.array('files', 10), wrap(async (req, res) => {
  const files = req.files || [];
  const discard = () => Promise.all(files.map((f) => fsp.unlink(f.path).catch(() => {})));
  try {
    const { targetType, targetId } = parse(z.object({ targetType: z.enum(['task', 'page', 'comment']), targetId: uuid }), req.body);
    if (!files.length) throw bad('No file was uploaded');
    await checkTarget(prisma, targetType, targetId, req.user);
    const existing = await prisma.attachment.count({ where: { targetType, targetId } });
    if (existing + files.length > MAX_PER_TARGET) throw bad(`At most ${MAX_PER_TARGET} files can be attached to one item`);

    const rows = await prisma.$transaction(async (tx) => {
      const out = [];
      for (const f of files) {
        // multer reads names as latin1; restore UTF-8 and strip any path
        const name = path.basename(Buffer.from(f.originalname, 'latin1').toString('utf8')).slice(0, 200) || 'file';
        out.push(await tx.attachment.create({
          data: { targetType, targetId, fileName: name, mime: f.mimetype || 'application/octet-stream', sizeBytes: f.size, storageKey: f.filename, uploaderId: req.user.id },
        }));
      }
      await audit(tx, req.user.id, 'attachment.add', targetType, targetId, null, { files: out.map((o) => o.fileName) });
      return out;
    });
    await announce(rows[0]);
    res.status(201).json(rows.map(view));
  } catch (err) {
    await discard(); // never leave orphaned files behind
    throw err;
  }
}));

router.get('/attachments/:id/download', wrap(async (req, res) => {
  const a = await prisma.attachment.findUnique({ where: { id: req.params.id } });
  if (!a) throw notFound('File not found');
  const file = path.join(config.uploadDir, a.storageKey);
  if (!fs.existsSync(file)) throw notFound('File is missing from storage');
  const inline = req.query.inline === '1' && INLINE.has(a.mime);
  res.set({
    'Content-Type': inline ? a.mime : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, max-age=3600',
  });
  res.sendFile(file);
}));

router.delete('/attachments/:id', member, wrap(async (req, res) => {
  const a = await prisma.attachment.findUnique({ where: { id: req.params.id } });
  if (!a) throw notFound('File not found');
  if (a.uploaderId !== req.user.id && req.user.role !== 'admin') throw forbidden('Only the uploader or an admin can remove this file');
  await prisma.$transaction(async (tx) => {
    await tx.attachment.delete({ where: { id: a.id } });
    await audit(tx, req.user.id, 'attachment.remove', a.targetType, a.targetId, { file: a.fileName }, null);
  });
  fsp.unlink(path.join(config.uploadDir, a.storageKey)).catch(() => {});
  await announce(a);
  res.json({ ok: true });
}));

module.exports = router;
