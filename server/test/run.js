// Runs the API tests against a throwaway schema in your database, then drops it.
// Your real data (schema "public") is never touched.
//   npm test
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set in .env'); process.exit(1); }

const schema = `forge_test_${Date.now().toString(36)}`;
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set('schema', schema);
const uploadDir = path.join(os.tmpdir(), schema); // uploaded test files never touch your real uploads folder
const env = { ...process.env, DATABASE_URL: url.toString(), SMTP_HOST: '', NODE_ENV: 'test', UPLOAD_DIR: uploadDir, PRISMA_HIDE_UPDATE_MESSAGE: '1' };
const root = path.join(__dirname, '..', '..');

function run(cmd, args) {
  // npx is a .cmd file on Windows and needs a shell; node itself must not use one (path has spaces)
  const needsShell = process.platform === 'win32' && cmd === 'npx';
  return spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit', shell: needsShell });
}

let code = 1;
try {
  console.log(`[test] using temporary schema ${schema}`);
  if (run('npx', ['prisma', 'migrate', 'deploy']).status !== 0) throw new Error('migration failed');
  code = run(process.execPath, ['--test', '--test-concurrency=1', path.join(__dirname, 'api.test.js')]).status ?? 1;
} catch (e) {
  console.error('[test]', e.message);
} finally {
  fs.rmSync(uploadDir, { recursive: true, force: true });
  // drop the temporary schema
  Object.assign(process.env, env);
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  p.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    .then(() => console.log(`[test] dropped ${schema}`))
    .catch((e) => console.error('[test] cleanup failed:', e.message))
    .finally(() => p.$disconnect().then(() => process.exit(code)));
}
