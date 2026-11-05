const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { prisma } = require('./db');
const realtime = require('./realtime');
const mail = require('./mail');
const H = require('./http');

const app = express();
if (config.isProd) app.set('trust proxy', 1); // behind nginx

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    ...(config.isProd ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  });
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// ---------------- API ----------------
const api = express.Router();
api.use(H.sameOrigin);
api.get('/health', H.wrap(async (req, res) => { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true }); }));
api.use(require('./routes/auth'));            // public + admin routes guard themselves
api.use(H.requireAuth);                        // everything below needs a signed-in user
api.use(require('./routes/meta'));
api.use(require('./routes/me'));
api.use(require('./routes/tasks'));
api.use(require('./routes/planning'));
api.use(require('./routes/comments'));
api.use(require('./routes/attachments'));
api.use(require('./routes/pages'));
api.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use('/api', api);

// ---------------- frontend ----------------
if (fs.existsSync(config.publicDir)) {
  // No build step means no hashed file names, so browsers must re-check on every load (cheap 304s)
  // or people would see the old app for up to an hour after an update.
  app.use(express.static(config.publicDir, { index: 'index.html', maxAge: 0, etag: true, lastModified: true }));
  app.get('*', (req, res) => res.sendFile(path.join(config.publicDir, 'index.html')));
}

app.use(H.errorHandler);

// ---------------- start ----------------
/** Build the HTTP + WebSocket server. `port` 0 picks a free port (used by tests). */
async function start({ port = config.port, background = true } = {}) {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  await prisma.$connect();
  const server = http.createServer(app);
  realtime.attach(server);
  if (background) { mail.startWorker(); require('./services/reminders').start(); }
  await new Promise((resolve) => server.listen(port, resolve));
  return server;
}

async function main() {
  const server = await start();
  console.log(`[forge] listening on ${config.appUrl} (port ${config.port})`);
  const stop = async () => { server.close(); await prisma.$disconnect(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main().catch((e) => { console.error('[forge] failed to start:', e.message); process.exit(1); });

module.exports = { app, start };
