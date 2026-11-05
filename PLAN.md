# Forge Project Management - Plan (v2)

Deployment: your VPS, PostgreSQL already installed. Users: you and your group members.

## 1. V1 scope

### Accounts and access
- **Passwordless sign-in (decided)**: no passwords. You enter your email, get a 6-digit code (valid 10 minutes, single use, 5 wrong guesses kills it), and stay signed in for **30 days, renewed whenever you use the app**. Admin can end anyone's sessions, and can generate a one-time sign-in link (valid 1 hour) as a fallback if email is down. Without SMTP configured (dev), codes print in the server log.
- No public sign-up: **an Admin invites people** by email. The invite contains a single-use, expiring link where the person confirms their email with a code, sets their name, and joins with the role the Admin chose. Admin can revoke pending invites, resend them, deactivate users, and change roles. First run creates the initial Admin.
- Roles: **Admin** (manage members, settings), **Member** (create/edit everything), **Viewer** (read only, comment optional).
- Enforced on the server, not just hidden in the UI.

### Tasks
- Fields: title, markdown description, type (task / story / bug / improvement / epic), status, priority, assignee, reporter, labels, story points, estimate and logged time, start/due dates, sprint, milestone.
- **Subtask hierarchy**: epic > task > subtask, any depth you allow (default 3 levels). Parent shows progress rolled up from children.
- **Task links**: blocks / blocked by, relates to, duplicates.
- **Attachments**: files and pasted images on tasks, comments and pages. Stored on the VPS disk, metadata in Postgres, size and type limits.
- **Watchers**: follow a task; watchers are notified of changes. Assignees and commenters watch automatically.
- **Recurring tasks**: daily / weekly / monthly / custom rule. The next copy is created when the current one is completed (or on schedule).
- **Task templates**: saved presets (type, labels, checklist, subtasks, description) used when creating a task.
- **Bulk edit**: multi-select in list/backlog/board to change status, assignee, sprint, milestone, labels, priority, or delete.
- **Comments**: threaded replies, emoji reactions, **@mentions** with a member picker, edit/delete own comments.
- Per-task activity history (from the audit log).

### Planning
- **Backlog**: ranked, drag and drop into sprints.
- **Sprints**: name, goal, duration (1-4 weeks or custom, end auto-calculated), one active at a time. Start, complete (unfinished work goes to backlog or next sprint), burndown, velocity.
- **Milestones**: tasks roll up into milestone progress (points-weighted), status on track / overdue / complete.
- **Views**: Board (Kanban), List (sortable, filters, saved filters, CSV export), Timeline (Gantt-style), Calendar.

### Pages (project documentation)
- Nested page tree, icons, markdown editor with live preview, tables, checklists, code blocks.
- `[[Page links]]`, `FORGE-12` task references, @mentions, attachments.
- Templates: project docs, meeting notes, requirements, decision record, retrospective.

### Collaboration
- **Real-time updates** over WebSockets: board moves, edits, comments and presence appear live for everyone.
- **Notifications**: in-app inbox (bell + unread count) **and email**. Triggers: mentioned, assigned, watched task changed, replied to your comment, due-soon/overdue reminders, invites and password resets.
  - Per-user preferences: choose in-app / email / both per trigger type.
  - Emails are batched (short delay) so rapid edits do not flood inboxes; each email links straight to the task or page.
  - Sent through SMTP (any provider: your VPS mail, Resend, Mailgun, SES, etc.), configured by environment variables. If SMTP is not configured, email is skipped and in-app still works.
- **Audit log**: who changed what and when, filterable by user, task, date. Admin-visible global log.
- Global search and command palette (Ctrl+K), keyboard shortcuts.
- **Home (Notion-style, replaces a dashboard)**: a calm landing page, no charts.
  - Greeting and quick actions (new task, new page).
  - **Recently visited**: cards for the pages, tasks, sprints and milestones you opened lately.
  - **Favorites**: pin any page, task, sprint or milestone; they also appear in the sidebar.
  - **My tasks**: tasks assigned to you, grouped Overdue / Today / Upcoming / No date, with inline status change.
  - **Mentions and updates**: your latest @mentions, assignments and changes on watched tasks.
  - **Active sprint** banner: name, days left, simple progress bar, link to the board.
  - **Upcoming milestones**: short list with due dates.
- **Reports** (separate page, not home): burndown, velocity, workload, status breakdown, created vs resolved.
- Settings: project name/key, workflow statuses, labels, templates, theme, data export (JSON/CSV).

### Not in V1 (later)
Releases/versions, custom fields, capacity planning, risk register, retrospectives, workflow automation rules, Jira import, public API/webhooks, backups (you handle these on the VPS).

## 2. Architecture

```
Browser (SPA)  <--HTTPS-->  nginx (TLS, static files, reverse proxy)
                               |
                         Node.js server
                          |- REST API  (/api/...)     auth, validation, permissions
                          |- WebSocket (/ws)           live events to connected clients
                          |- Uploads   (disk: /var/forge/uploads)
                          |- Scheduler (recurring tasks)
                               |
                         PostgreSQL
```

- **Backend**: Node.js + Express, **Prisma ORM** on PostgreSQL (schema in `prisma/schema.prisma`, versioned migrations applied with `prisma migrate deploy` on deploy), `ws` for real-time, `multer` for uploads, emailed one-time codes + 30-day session cookies for auth (no passwords). Credentials and secrets come only from the `.env` file on the server.
- **Real-time**: every write goes through one service layer that (1) checks permission, (2) runs the change in a transaction, (3) writes an audit row, (4) creates notifications, (5) broadcasts an event over WebSocket. Clients apply the event to local state.
- **Concurrency**: tasks carry a version number, so a stale edit is rejected instead of silently overwriting someone else's change.
- **Frontend**: SPA with a hash/history router. Framework to be decided once I see your front-end sample (React + Vite is my default recommendation for an app this size).
- **Deploy**: nginx + Let's Encrypt for HTTPS, run Node under systemd or PM2, config via environment variables (DB URL, session secret, upload dir).

## 3. Database (PostgreSQL tables)

| Table | Purpose |
|---|---|
| users | name, email, role, color, active, notification prefs |
| login_tokens | emailed sign-in codes (hashed, attempt-limited) and admin fallback links |
| invites | email, role, token hash, invited_by, expires_at, accepted_at, revoked_at |
| email_queue | recipient, subject, body, status, attempts, send_after (batched delivery with retries) |
| projects | name, key, description, next_task_num, settings (workflow, default sprint length) |
| statuses | per-project workflow columns, category (todo/doing/done), position |
| labels | name, color |
| sprints | name, goal, start, end, status, snapshot at completion |
| milestones | name, description, due, status |
| tasks | key number, title, description, type, status, priority, assignee, reporter, parent_id, sprint_id, milestone_id, points, estimate, dates, rank, version, recurrence rule, completed_at |
| task_labels, task_watchers | many-to-many |
| task_links | from_task, to_task, link type |
| checklist_items | optional lightweight checklist per task |
| task_templates | saved presets |
| time_logs | user, task, minutes, date |
| comments | task or page target, parent_id (threads), author, body, edited_at |
| comment_reactions | comment, user, emoji |
| attachments | file name, mime, size, storage path, uploader, attached to task/comment/page |
| pages | title, icon, parent_id, content, position, updated_by |
| notifications | user, type, entity, read_at |
| saved_filters | user, name, filter JSON |
| favorites | user, entity type/id, position (pins for Home and sidebar) |
| recent_visits | user, entity type/id, last visited at (feeds "Recently visited") |
| audit_log | actor, action, entity type/id, before/after JSON, timestamp |

## 4. Build order
1. Repo scaffold, Postgres schema + migrations, auth, roles
2. Service layer: tasks, sprints, milestones with audit log and WebSocket events
3. Frontend foundation (after your sample): shell, router, live store
4. Backlog, board, list, bulk edit, task drawer (subtasks, links, watchers, attachments)
5. Comments: threads, reactions, @mentions, notifications inbox
6. Sprints, milestones, timeline, calendar
7. Pages editor and templates, task templates, recurring tasks
8. Home page, reports, search, audit log viewer, settings
9. VPS deployment guide (nginx, systemd, env, migrations)

## 5. Design direction (from your two samples)

**Sample 1 - ChronoTask** (board + task side panel)
- Left sidebar: workspace switcher, a prominent Create button, General nav (Home, My Tasks, Inbox with unread count, Reporting...), a "My workspace" list of projects/pages with emoji icons.
- Board columns with a count, cards showing colored category tag, title, short description, optional cover image, assignee avatars and a circular progress ring. "Add task" at the bottom of each column.
- **Task detail opens as a right-hand slide-over panel** over a dimmed page: title, then property rows (priority, status, dates, progress bar, assignees with Invite), description box, attachments as file cards with Download All, and tabs for Subtasks / Comments / Activities. Subtasks are checkboxes with a nested description and author/date.
- Header tabs on a page: List / Board / Calendar / Files.

**Sample 2 - LunarDesk** (table/list view)
- Clean white page on a light gray canvas, rounded cards, soft borders, small type, generous whitespace.
- Top bar: page title + subtitle, global search with shortcut hint, icon buttons, user avatar and name.
- Toolbar: search tasks, Filter, view switcher (List / Kanban / Calendar), primary "Add Task" button.
- List view grouped by status in collapsible sections (colored status label, count, "View All"), each a table: ID, name, assignee avatar+name, progress %, deadline, priority pill (Low / Medium / High colors), row actions menu.
- Sidebar: grouped nav with collapsible items and nested sub-items; teal active state.

**What I will adopt**
- Layout: LunarDesk-style app shell (sidebar + top bar with search) and its grouped, collapsible list view with priority pills. ChronoTask-style board cards and the right-hand task slide-over with Subtasks / Comments / Activities tabs and attachment cards.
- Home page in the Notion style we agreed, using the same cards and spacing.
- Light theme first, dark theme afterwards. One accent color, soft shadows, 8-12px radii, small neutral type (Inter or similar).
- Sidebar: Home, Inbox (notifications), My Tasks, Backlog, Sprints, Board, Timeline, Calendar, Milestones, Reports, Pages tree, Team, Settings.

**Accent color: teal (decided)**, with colored status/priority tags.

## 6. Decisions so far
- Frontend samples received; accent color teal.
- Domain available for the VPS (HTTPS via nginx + Let's Encrypt).
- Notifications: in-app + email. Accounts: Admin invites, invitee signs up via link.

## 7. Deployment details
- Domain: **msforge.denzelchiu.me** (DNS A record to the VPS, nginx + Let's Encrypt). Configured at the end; `APP_URL` drives all email links.
- Email: **Google SMTP** (smtp.gmail.com). Needs a Google App Password (2-Step Verification on); Gmail caps sending at roughly 500 messages/day for personal accounts (2,000 for Workspace), which is plenty for a small team. The queue batches notification emails to stay well under that.
- Still needed at deploy time, kept in environment variables and never in the repo: Postgres connection string for the VPS, the Gmail address and app password, session secret.
- For local testing I need a connection string to a local Postgres database (a Postgres 17 service is already running on this machine, I just don't have its credentials).
