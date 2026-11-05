const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const env = process.env;
const root = path.join(__dirname, '..');

module.exports = {
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT) || 3000,
  databaseUrl: env.DATABASE_URL || '',
  appUrl: (env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  uploadDir: path.resolve(root, env.UPLOAD_DIR || './uploads'),
  maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 25) * 1024 * 1024,
  sessionDays: 30,
  inviteDays: 7,
  // If set, only this email can complete first-run setup (stops a stranger claiming the admin account).
  setupEmail: (env.SETUP_EMAIL || '').trim().toLowerCase(),
  codeMinutes: 10,       // how long an emailed sign-in code works
  codeMaxAttempts: 5,     // wrong guesses before a code is thrown away
  signinLinkMinutes: 60,  // admin-generated fallback sign-in link
  publicDir: path.join(root, 'public'),
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 587,
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'Forge <no-reply@localhost>',
  },
};
