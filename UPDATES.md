# Forge PM - Build Updates

A running log of what has been built and how. Newest entries at the bottom.

---

## 1. Planning and design (done)
**What:** Agreed scope, architecture and look before writing code.
**How:**
- Wrote `PLAN.md` (features, architecture, tables, build order, design direction).
- Reviewed the two Dribbble samples: LunarDesk (grouped list view, app shell) and ChronoTask (board cards, right-hand task slide-over). Decided to combine them, with a **teal** accent.
- Decisions: PostgreSQL on the VPS, login with Admin / Member / Viewer roles, Admin invites people by email link, real-time updates (WebSockets), audit log, in-app + email notifications via Google SMTP, domain `msforge.denzelchiu.me` (configured at the end), Notion-style Home page, no backups in scope.

## 2. Backend scaffold (done, being ported to Prisma)
**What:** Express server skeleton and supporting modules.
**How:**
- `package.json`, `.gitignore`, `.env.example` (all credentials come from `.env` on the server, never committed).
- `server/config.js` reads the environment (port, `APP_URL`, upload dir, SMTP).
- `server/sessions.js`: random 32-byte session tokens in an HttpOnly, SameSite=Lax cookie; only the SHA-256 hash is stored.
- `server/realtime.js`: WebSocket endpoint `/ws`, authenticated by the session cookie, broadcasts events and online presence, drops dead connections with ping/pong.
- `server/mail.js`: email queue with retries (up to 5), notification emails batched into a single digest per recipient, Google SMTP via nodemailer, skipped safely when SMTP is not configured.
- `server/http.js`: `HttpError` helpers, zod validation, role middleware (viewer < member < admin), same-origin check for write requests, small login rate limiter, error handler.
- `server/services/core.js`: transaction helper whose side effects (WebSocket broadcasts) only fire after commit, audit-log writer, `@[Name](user:id)` mention parser, diff helper.
- `server/services/notify.js`: creates in-app notifications and queues emails per each user's preferences, never notifying the person who made the change.
- `server/routes/auth.js`: first-run admin setup, login/logout, forgot/reset password, invites (create, resend, revoke, accept), user list and role/deactivate (cannot remove the last admin), own profile and password change.
- `server/services/tasks.js` + `server/routes/tasks.js`: create (including from templates), update with version-conflict detection, delete, bulk edit, subtask nesting with cycle and depth checks, task links, watchers, time logging, recurring tasks (next copy created when completed), mentions, audit entries, notifications.

## 3. Switch to Prisma ORM (done)
**What:** The first pass used raw SQL through `pg`. You asked for an ORM, so the whole data layer now uses **Prisma** (v6).
**How:**
- `package.json` uses `@prisma/client` + `prisma`. Scripts: `db:generate`, `db:migrate` (apply on the server), `db:migrate:dev` (create migrations locally), `db:studio` (browse data).
- `prisma/schema.prisma` defines all 26 tables and the enums (roles, statuses, task types, priorities, link types...). Validated with `prisma validate`.
- `prisma/migrations/20261105000000_init/migration.sql` was generated offline from the schema (`prisma migrate diff`), then extended with SQL Prisma cannot express: a partial unique index so only **one sprint per project can be active**, plus check constraints (a task cannot be its own parent, a task cannot link to itself, time logs must be positive).
- Credentials: the app reads `DATABASE_URL` and all secrets from `.env` (see `.env.example`). `.env` is git-ignored.
- Design choices: dates stay `YYYY-MM-DD` strings in the API (`server/services/serialize.js` converts); user references (assignee, author...) are plain ids rather than relations because users are deactivated, never deleted; comments/attachments/mentions point at tasks or pages by id and are cleaned up in code when the target is deleted.
- `server/db.js` exports one shared Prisma client. `server/services/core.js` wraps `prisma.$transaction`, so realtime broadcasts only fire after a successful commit.
- Raw SQL (`$queryRaw`) is used only for the recursive subtask queries (cycle check and nesting depth).
- Removed the old hand-written SQL migration and runner.

## 4. Backend API (written, syntax-checked, not yet run against a database)
**What:** Every endpoint the web app needs so far.
**How (files in `server/routes` and `server/services`):**
- **Auth** (`routes/auth.js`): first-run setup creates the admin + project (statuses To Do / In Progress / In Review / Done and starter labels); login with rate limiting; logout; forgot/reset password by emailed link; invites (create, list, resend, revoke, look up, accept); user list; admin role/deactivate (never removes the last admin); own profile and password change.
- **Tasks** (`routes/tasks.js`, `services/tasks.js`): list, get (with subtasks, links, time logs, activity), create (optionally from a template, which can create subtasks), update, delete, bulk edit (set fields, add/remove labels, delete), links (blocks / relates / duplicates), watchers, time logging. Updates use a version number: a stale edit returns 409 with the current task instead of overwriting. Subtask nesting is checked for cycles and a depth limit (default 3). Completing a recurring task creates the next copy.
- **Planning** (`routes/planning.js`): sprints (create with duration, edit, start, complete with "move unfinished to backlog or next sprint" and a points snapshot, delete, burndown data); milestones with points-weighted progress; labels; workflow statuses (admin: add, rename, reorder, delete with task move); task templates; project settings.
- **Personal** (`routes/me.js`): notifications inbox (list, mark read), favorites, recently visited, saved filters.
- **Meta** (`routes/meta.js`): `/api/bootstrap` (everything the app needs on load), audit log (entity history for everyone, global log for admins), quick search.
- **Realtime**: every change broadcasts over `/ws` after commit (`task.created/updated/deleted`, `sprint.*`, `milestone.*`, notifications to the specific user, online presence).
- **Audit**: every create/update/delete writes an `AuditLog` row with before/after values of the fields that changed.
- **Notifications**: assigned, mentioned (`@[Name](user:id)` in text), watched-task change; in-app and/or email per user preference, emails batched into one digest.
- `server/index.js` wires it together: security headers, same-origin check on writes, JSON body limit, API under `/api`, serves the frontend from `public/` (SPA fallback), graceful shutdown.

**Not done yet in the backend:** comments (threads, reactions, mentions), attachments (upload/download), pages, due-soon reminders, plus testing against a real database.

## 5. Passwordless sign-in with emailed codes (done)
**What:** You chose email codes instead of passwords, with sessions lasting a month. Everything else stays as it was.
**How:**
- **Schema:** removed `User.passwordHash` and the `PasswordReset` table; added `LoginToken` (kind `code` or `link`, hashed token, attempt counter, expiry, used-at). Because nothing had been applied to a database yet, the initial migration was regenerated instead of adding a second one. Dropped the `bcryptjs` dependency.
- **Sign-in flow** (`server/routes/auth.js`):
  - `POST /api/auth/request-code {email}` emails a 6-digit code (generated with `crypto.randomInt`). It always answers "ok", so it cannot reveal who has an account.
  - `POST /api/auth/verify {email, code}` checks it and starts a session.
  - Only a hash of `email:code` is stored. A code works for 10 minutes, once, and is thrown away after 5 wrong guesses. A new request cancels older codes. Hash comparison is constant-time and consuming a code is atomic, so it cannot be used twice. Requests are rate limited per IP and per email.
  - Codes are emailed straight away (`mail.sendNow`), falling back to the retry queue if SMTP fails. With no SMTP configured, the code is printed in the server log.
- **First-run setup:** `POST /api/auth/setup/request-code`, then `POST /api/auth/setup {name, email, code, projectName, projectKey}`. The first admin proves their email with a code too, and setup only works while there are no users.
- **Invites:** the emailed invite link opens a join page. `POST /api/invites/request-code {token}` emails a code to the invited address, then `POST /api/invites/accept {token, name, code}` creates the account.
- **Sessions:** 30 days, renewed each time a session has used a day (`sessions.renewIfNeeded`, called from the auth middleware), so active people are never logged out. HttpOnly, SameSite=Lax, Secure in production, and only a hash of the token is stored.
- **Safety nets:**
  - An admin can generate a one-time sign-in link for someone, valid 1 hour (`POST /api/users/:id/signin-link`), for when email is down.
  - Admin can end all of a user's sessions (`DELETE /api/users/:id/sessions`), and anyone can sign out their other devices (`POST /api/auth/logout-others`).
  - The last active admin still cannot be demoted or deactivated.
- **Removed:** forgot/reset password, change password, and the password fields in `PATCH /api/me`.
- **Email credentials:** to be provided later. Until `SMTP_*` is set in `.env`, codes appear in the server log.

## 6. Database applied and backend tested (done)
**What:** The migration is applied to your local Postgres and the whole backend so far is covered by an automated test suite. All 28 tests pass.
**How:**
- `npx prisma migrate deploy` applied `20261105000000_init` to your database (26 tables created).
- `server/index.js` now exports `start({port})` so tests can boot a real server on a free port.
- `npm test` (`server/test/run.js`) creates a **temporary schema** (`forge_test_xxxx`) in your database, applies the migration there, runs the tests, then drops the schema. Your real data in `public` is never touched, and the first-run setup stays available.
- `server/test/api.test.js` drives the real HTTP API and a real WebSocket. It covers:
  - **Auth:** first-run setup by emailed code, wrong code refused, code single-use and locked after 5 wrong guesses, no information leak for unknown emails, cross-origin writes blocked, invite → code → account, one-time invite, viewer is read-only, members cannot invite, last admin protected, admin fallback sign-in link (works once), sign out of other devices, deactivated users locked out.
  - **Tasks:** create/update with version conflict (409), assignment and @mention notifications (in-app + queued email), subtask nesting with cycle and depth limits, cascade delete, links (duplicate and self-link refused), watchers, time logging, bulk edit and bulk delete, recurring tasks, templates with subtasks.
  - **Planning:** sprint durations, only one active sprint, completion with "move unfinished to next sprint" and points snapshot, burndown, milestone progress (points-weighted) and unlinking on delete, workflow status editing with task move.
  - **Other:** favorites, recent visits, saved filters, audit log (entity history for everyone, global log for admins), search, and live WebSocket events (including that anonymous sockets are refused).
- Prisma's own error logging is turned off (expected conflicts are answered as 4xx); set `PRISMA_LOG=1` to see queries while debugging.

## 7. Comments, attachments, pages and reminders (done)
**What:** The rest of the backend. The suite grew from 28 to **40 tests, all passing**.
**How:**
- **Migration 002** (`20261105010000_drop_mention`): the `Mention` table was never needed (notifications already cover mentions), so it was removed. It was generated with `prisma migrate diff --from-schema-datasource`, which compares your live database with the schema, then applied with `migrate deploy`. This is the same workflow to use on the VPS for future changes.
- **Comments** (`routes/comments.js`):
  - Threaded replies, one level deep (a reply to a reply attaches to the original comment; replies must belong to the same task or page).
  - Emoji reactions that toggle on and off (max 20 different emojis per comment).
  - @mentions use `@[Name](user:id)` in the text.
  - Notifications, with nobody told twice: mentioned people first, then the person replied to, then task watchers. Commenting on a task makes you a watcher.
  - Editing is author-only and only newly added mentions notify. Delete is author or admin; a comment with replies stays as a "deleted" stub so the thread still reads.
  - Viewers can read but not comment or react. Task cards get their comment count updated live.
- **Attachments** (`routes/attachments.js`):
  - Multipart upload (up to 10 files at once, 50 per item, size limit from `MAX_UPLOAD_MB`) to tasks, pages or your own comments.
  - Files are stored under random ids in `UPLOAD_DIR`, never under the uploaded name, so names cannot collide or escape the folder (`../../evil.txt` is stored as `evil.txt`). Rejected uploads leave no orphan files.
  - Downloads require a session. Everything is forced to download except png, jpeg, gif, webp and pdf, which can show inline; all responses carry `nosniff` and a sandbox policy so an uploaded file can never run as a page.
  - Only the uploader or an admin can delete a file. Deleting a task, comment or page also deletes its files from disk (`services/cleanup.js`).
- **Pages** (`routes/pages.js`):
  - Nested tree with `position` ordering, move with cycle protection, and six templates (blank, project documentation, meeting notes, requirements, decision record, retrospective) in `services/pageTemplates.js`.
  - Pages carry an `updatedAt`. Send it back as `baseUpdatedAt` when saving and a concurrent edit returns 409 with the other person's version instead of overwriting it.
  - Mentions in page text notify only newly mentioned people. The audit log records title/icon/location changes and content size, never the page text. Deleting a page removes its subpages, comments and files.
  - The page tree comes with the startup request (`/api/bootstrap`); content loads when a page is opened. Search now covers page titles and text.
- **Reminders** (`services/reminders.js`): hourly, assignees get "due today/tomorrow" and "overdue" (looking back 2 weeks) notifications, once per task per due date, never for finished tasks. Honors each person's notification preferences, and email goes through the normal batching.
- **Test harness:** uploads in tests go to a temporary folder that is deleted afterwards, in addition to the temporary database schema.

**Backend status:** feature complete for V1. Remaining backend work is only polish found while building the frontend, plus deployment.

## 8. Frontend (done, tested in a browser)
**What:** The whole web app, built from your two Dribbble samples (LunarDesk shell and grouped list, ChronoTask board cards and task slide-over) with the teal accent. Light and dark themes, and it works on a phone.
**How:**
- **No build step.** Plain JavaScript modules in `public/`, served by the same Node server. Open `http://localhost:3000` once `npm start` is running. Views load on demand.
- **Safe by default:** every screen is built with a tiny `h\`...\`` template helper that HTML-escapes all values, so a task title or comment can never inject script. Markdown (`public/js/md.js`) escapes first, then adds only the supported syntax and blocks `javascript:` links.
- **Live:** `public/js/store.js` loads everything in one request, then applies WebSocket events (tasks, sprints, comments, notifications, presence) as they arrive, reconnects automatically and catches up after a drop. Task edits appear instantly on your screen and are sent in order, with the version check turning a clash into "someone else just changed this" instead of an overwrite.
- **Screens:**
  - *Sign in:* emailed 6-digit code, first-run setup, invite page, admin sign-in link.
  - *Home* (Notion-style): greeting, quick actions, active sprint banner, recently visited, favorites, my tasks by urgency, mentions and updates, upcoming milestones.
  - *My Tasks* and *Inbox* (read/unread, mark all read, click to jump to the item).
  - *List* (LunarDesk style): collapsible groups by status, assignee, priority, sprint or milestone; sortable; inline status change; bulk edit; saved filters; CSV export; drag a row into another group to change it.
  - *Board* (ChronoTask style): columns from your workflow, cards with labels, avatar, progress ring, due date, counts; drag between columns and reorder; quick add per column; scope to the active sprint, any sprint, or backlog.
  - *Backlog:* a card per sprint plus the backlog, drag tasks in and out, start/complete/edit/delete sprints, quick add.
  - *Task slide-over:* every property, markdown description with tick-boxes and @mentions, attachments (upload, drop, paste a screenshot), subtasks, links, comments (threads, reactions, edit, delete), time logging, activity history, watch, favorite, copy link.
  - *Sprints* (burndown and velocity charts), *Milestones* (progress rings, linked tasks), *Timeline* (roadmap bars, zoom), *Calendar* (due dates, milestones, sprint ends), *Reports* (status, priority, workload, created vs resolved).
  - *Pages:* nested tree in the sidebar, markdown editor with toolbar, live preview, autosave, edit-conflict banner, image upload, subpages, templates, comments and files.
  - *Team* (invite by email, pending invites, roles, sign-in links, deactivate) and *Settings* (profile and notification choices, project, workflow editor, labels, task templates, audit log).
  - Global search and command palette (`Ctrl+K` or `/`), `c` to create a task.
- **Roles in the UI:** viewers see no create buttons, cannot drag, and every field is disabled. The server enforces the same rule.
- **How it was tested:** a disposable demo workspace (`npm run sandbox`) with its own temporary schema, email off, and demo data (4 people, 22 tasks, 3 sprints, 2 milestones, pages, comments). I signed in as admin and viewer, opened every screen, created a task, wrote a comment with an @mention, dragged a task between sprints, edited a page in split view (autosave verified on the server), and checked dark mode and phone width. Bugs found and fixed along the way: a CSS name clash that stretched unassigned avatars, a bad import that stopped the slide-over, blank chart output, timeline bars too small to read, mobile list alignment, and a refresh scheduler that stalled in background tabs.
- **Email:** Google SMTP login was verified (authentication only, no mail sent).

**What is left:** point DNS at the server, switch on HTTPS for msforge.denzelchiu.me, and do a first real run: create your admin account, invite the team.

## 9. Deployment to the VPS (app running, public address pending DNS)
**What:** The code lives on GitHub (`Denzel29/proj-management`) and runs on the VPS in Docker.
**How:**
- **Git:** the local project is a Git repo with `origin` set to the GitHub URL, and the code is pushed to `main`. `.env`, uploads and `node_modules` are ignored, so no secrets are in the repo. A `.gitattributes` keeps LF line endings so shell scripts work on Linux. The server cloned it into `~/forge`.
- **What I found on the server (read-only first):** Ubuntu 24.04, Docker, no Node and no nginx, and no passwordless sudo. Ports 80 and 443 already belong to a Caddy container from your other app (apptracker, in `~/apptracker/Deploy`).
- **Decision (yours):** run Forge in Docker with its own Postgres container, behind that existing Caddy. This needed no sudo, left your host Postgres and apptracker untouched, and lets Caddy handle HTTPS certificates.
- **Files added:**
  - `Dockerfile`: Node 22 image, installs dependencies, runs as the non-root `node` user, applies database migrations then starts the server.
  - `docker-compose.yml`: `forge` and `db` (Postgres 16) with persistent volumes for the database and uploaded files, health checks, memory limits, log rotation. The database has no published port. The app joins Caddy's network (`deploy_default`) under the alias `forge-app`.
  - `.env.production.example`: the settings to fill in on the server.
  - `deploy/update.sh`: `git pull` + rebuild + restart for future updates.
  - `deploy/Caddyfile.snippet`: the block to add to Caddy for `msforge.denzelchiu.me`.
  - `package.json`: `prisma` moved to runtime dependencies so the container can run migrations.
- **On the server:** `.env` was created with a generated database password (mode 600, never shown or committed). Containers were built and started: both healthy, migrations `init` and `drop_mention` applied, and the app answers on `forge-app:3000` from inside the Caddy container. The apptracker containers kept running throughout.
- **Going live:**
  - **DNS (Namecheap):** an `A` record `msforge` to `62.171.178.11`. It sits beside the existing `apptracker` record with no conflict: Caddy picks the app by hostname.
  - **Caddy:** the Forge block was appended to `~/apptracker/Deploy/Caddyfile` after a timestamped backup (`Caddyfile.bak-...`), validated, then reloaded gracefully. Let's Encrypt issued the certificate for `msforge.denzelchiu.me`. apptracker's two addresses answered the same before and after.
  - **Verified over HTTPS:** health check OK, HTTP redirects to HTTPS, the WebSocket endpoint refuses anonymous connections.
  - **Email:** SMTP settings are in the server `.env`; a login test from inside the container succeeded (authentication only, no mail sent). The first code email arrived but showed the Gmail login account as sender: Gmail ignores `MAIL_FROM` unless that address is a verified "Send mail as" alias. The `MSForge <msforge@denzelchiu.me>` alias already existed in Gmail, so `MAIL_FROM` was set to it and the next email showed the right sender (confirmed). First-run setup was allowed for the CMU address by setting `SETUP_EMAIL` to it.
  - **Setup safeguard:** new `SETUP_EMAIL` setting (code in `server/config.js` and `server/routes/auth.js`, covered by a test; 41 tests pass). Only that address can complete first-run setup, so nobody can claim the admin account during the window before you do. On the server it is set to the same address as `SMTP_USER`.
- **Next:** open https://msforge.denzelchiu.me, create the admin account with the emailed code, then invite the team.

## 13. New members choose their notifications first (done)
**What:** Anyone who joins is taken straight to **Settings, Profile & notifications** before anything else, to decide how much email they want.
**How:**
- New accounts (invite sign-up, and a brand-new workspace's first admin) are created with `prefs.onboarded = false` and a quieter default: **email for every change on a watched task is off** (it still appears in the Inbox). Constant `NEW_USER_PREFS` in `server/routes/auth.js`.
- On load (`public/js/main.js`), a signed-in person with `onboarded === false` is sent to `#/settings/profile`. They stay redirected on every visit until they press **Continue to Forge**, so closing the tab mid-way does not skip it, and it follows them across devices because the flag is stored on their account.
- The Settings page shows a **Welcome** card with three one-click starting points: **Quiet** (email only for mentions, replies and assignments), **Balanced** (also due dates, but not every change on watched tasks), **Everything**. The notification table below can be fine-tuned, and **Continue to Forge** saves `onboarded = true` and opens Home. In-app notifications stay on for everything in all presets.
- Existing accounts have no flag, so they are never redirected.
- **Tests:** 1 new test and 3 new checks (47 passing): new accounts carry the flag and quieter defaults, finishing flips only the flag, and a watched-task change reaches the Inbox without queuing an email. Also tried the real invite flow on the demo workspace: invite, join with a code, land on the welcome card, pick Quiet, Continue, reload stays on Home.

## 12. Milestones complete and reopen automatically (done)
**What:** A milestone is **complete** when it has tasks and every one of them (subtasks included) is done. If a task moves back out of done, a new open task is added, or an open task is linked, the milestone goes back to **open**.
**How:**
- New `server/services/milestones.js` holds the rule (`syncMilestones`) and the progress maths. It runs inside the same database transaction as the task change, so the two can never disagree, and writes a `milestone.auto_status` audit entry and a live `milestone.updated` event when the status flips.
- It is triggered by: changing a task's status, linking or unlinking a milestone (both the old and new milestone are re-checked), creating a task (including the next copy of a recurring task), deleting a task or its subtasks, bulk edits, deleting a workflow status with its tasks moved, and changing a status's category. The server also re-checks all milestones at start-up, so anything set under the old manual behaviour is corrected.
- Status is no longer set by hand: the API ignores `status` on milestone edits and the manual **Mark complete / Reopen** menu item is gone.
- In the browser the status flips instantly using the same rule (`public/js/store.js`), and a new task can still be added to a completed milestone (it shows as "complete, will reopen").
- **Tests:** 2 new (46 passing): the full lifecycle (partial, complete, move back, add, delete, unlink, subtask, manual attempt ignored, audit entry) and bulk edits and workflow changes. Also checked on the demo workspace: finishing all 7 tasks of a milestone moved it to Completed, moving one back reopened it at 6/7.

## 11. Flicker fix: screens update in place (done)
**What:** After editing a task, the slide-over flashed several times.
**Why:** each save triggered a few quick refreshes (your change, the server reply, a live echo, a history reload) and every refresh rebuilt the whole panel, which replays its slide-in animation.
**How:**
- New `public/js/morph.js`: instead of replacing the HTML, it compares the new markup with what is on screen and changes only what differs. Elements stay in place, so nothing blinks, animations do not restart, images do not reload, and scroll position, focus and half-typed text are kept (fields being typed in are never overwritten). Used for the sidebar, top bar, page content and the slide-over. Switching to a different screen still starts from a clean slate.
- The slide-in animation lives on the elements (`.enter`) and so runs only when the panel is created.
- Refreshes are skipped when nothing is new: the live echo of your own save, repeated history/comment/file reloads (also coalesced into one), and saving page text (only the edited-time changes).
- **Measured on the demo workspace:** after editing a field, 0 nodes were removed or added, the panel and its scroll position stayed the same, a half-written comment kept its text and focus through a live update from someone else, drag and drop, filters and the page editor still work, and every screen renders without errors.

## 10. Add and remove people from the Team page (done)
**What:** Admins can add members and remove them from the project for good, both from **Team**.
**How:**
- **Add:** a new **Add member** button (top right of Team) opens a dialog for email and role, and sends the same emailed invite as the box on the page. Re-inviting someone who was deactivated now says to reactivate them instead of the old confusing "already has an account".
- **Remove:** each member's menu has **Remove from project...** (admins only, never yourself) beside the reversible **Deactivate**. The confirmation says how many assigned tasks will become unassigned. On removal (`DELETE /api/users/:id`, one database transaction):
  - their account is deleted, they are signed out at once and their live connection is closed;
  - their tasks become unassigned, they stop watching tasks, and their notifications, favorites, recent items, saved filters and pending emails are deleted;
  - their comments, files, time entries and audit history stay, shown as "Former member";
  - the last active admin can never be removed, and the same address can be invited again afterwards.
- **Live:** everyone else's Team list and task assignees update immediately (`user.removed` event). Deactivating someone now also closes their open connections.
- **Tests:** 3 new tests (44 passing): permissions and self-removal, work kept and access revoked and re-invite, the admin safeguards and messages. Checked in the browser on the demo workspace, including the confirmation text and the live update.
