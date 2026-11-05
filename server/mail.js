const nodemailer = require('nodemailer');
const config = require('./config');
const { prisma } = require('./db');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let transport = null;
function getTransport() {
  if (!config.smtp.host) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f3f5f7;font-family:Inter,Segoe UI,Arial,sans-serif;color:#1f2933">
  <div style="max-width:560px;margin:24px auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e4e9ee">
    <div style="font-weight:700;font-size:18px;color:#0f9d92;margin-bottom:16px">Forge</div>
    <h2 style="margin:0 0 12px;font-size:18px">${esc(title)}</h2>${bodyHtml}
  </div></body></html>`;
}

const button = (url, label) =>
  `<p style="margin:20px 0"><a href="${esc(url)}" style="background:#0f9d92;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">${esc(label)}</a></p>`;

/** Queue an email. `db` is a Prisma client or transaction (so it commits with the change that caused it). */
async function enqueue(db, { to, userId = null, kind = 'transactional', subject, text = '', html = '', payload = {}, delaySec = 0 }) {
  await (db || prisma).emailQueue.create({
    data: { toEmail: to, userId, kind, subject, textBody: text, htmlBody: html, payload, sendAfter: new Date(Date.now() + delaySec * 1000) },
  });
}

async function deliver(msg) {
  const t = getTransport();
  if (!t) return { skipped: true };
  await t.sendMail({ from: config.smtp.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  return { sent: true };
}

/**
 * Send right away (used for sign-in codes, where waiting for the queue tick would feel broken).
 * If delivery fails, the message falls back to the retrying queue.
 */
async function sendNow(msg) {
  try {
    await deliver(msg);
  } catch (err) {
    console.error('[mail] immediate send failed, queued for retry:', err.message);
    await enqueue(null, { to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  }
}

/** Combine several notification rows for one person into a single email. */
function digest(rows) {
  const items = rows.flatMap((r) => r.payload.items || []);
  const subject = items.length === 1 ? items[0].title : `${items.length} updates on Forge`;
  const lis = items.map((i) => `<li style="margin:6px 0"><a href="${esc(i.url)}" style="color:#0f9d92;text-decoration:none">${esc(i.title)}</a>${i.detail ? `<div style="color:#64748b;font-size:13px">${esc(i.detail)}</div>` : ''}</li>`).join('');
  const text = items.map((i) => `- ${i.title}${i.detail ? ` (${i.detail})` : ''}\n  ${i.url}`).join('\n');
  return { subject, text, html: layout('Recent activity for you', `<ul style="padding-left:18px;margin:0">${lis}</ul>${button(config.appUrl, 'Open Forge')}`) };
}

let working = false;
/** Send due emails. Rows are leased first (sendAfter pushed out) so two workers never double-send. */
async function processQueue() {
  if (working) return;
  working = true;
  try {
    const due = await prisma.emailQueue.findMany({
      where: { status: 'pending', sendAfter: { lte: new Date() } }, orderBy: { createdAt: 'asc' }, take: 50,
    });
    if (!due.length) return;
    const lease = await prisma.emailQueue.updateMany({
      where: { id: { in: due.map((r) => r.id) }, status: 'pending', sendAfter: { lte: new Date() } },
      data: { sendAfter: new Date(Date.now() + 5 * 60e3) },
    });
    if (lease.count !== due.length) return; // another worker took some; try again next tick

    const groups = new Map();
    for (const r of due) {
      const key = r.kind === 'notification' ? `n:${r.toEmail}` : `t:${r.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    for (const group of groups.values()) {
      const first = group[0];
      const msg = first.kind === 'notification'
        ? { to: first.toEmail, ...digest(group) }
        : { to: first.toEmail, subject: first.subject, text: first.textBody, html: first.htmlBody };
      const ids = group.map((g) => g.id);
      try {
        await deliver(msg);
        await prisma.emailQueue.updateMany({ where: { id: { in: ids } }, data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 } } });
      } catch (err) {
        const failed = first.attempts + 1 >= 5;
        await prisma.emailQueue.updateMany({
          where: { id: { in: ids } },
          data: { attempts: { increment: 1 }, lastError: String(err.message).slice(0, 300), status: failed ? 'failed' : 'pending' },
        });
        console.error('[mail] send failed:', err.message);
      }
    }
  } catch (err) {
    console.error('[mail] queue error:', err.message);
  } finally {
    working = false;
  }
}

function startWorker() {
  if (!config.smtp.host) console.log('[mail] SMTP not configured: emails are marked sent without delivery.');
  setInterval(processQueue, 15000).unref();
}

module.exports = { enqueue, sendNow, processQueue, startWorker, layout, button, esc };
