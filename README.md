# Forge

Project management for the Forge team: tasks, sprints, milestones, backlog, timeline, pages, comments, live updates.
Node + Express, PostgreSQL (Prisma), plain JavaScript frontend. No build step.

## Run it

```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL and the SMTP_* values
npm run db:migrate          # creates the tables
npm start                   # http://localhost:3000
```

The first visit shows **setup**: enter your name, email and project name. A 6-digit code is emailed to confirm
the address, and you become the admin. After that, invite the team from **Team**.

## Everyday commands

| Command | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with auto-restart on file changes |
| `npm test` | Run the API tests in a throwaway schema (your data is untouched) |
| `npm run sandbox` | Try the app with demo data on http://localhost:3100 (email off, prints sign-in links, Ctrl+C cleans up) |
| `npm run db:migrate` | Apply new database migrations (use this on the server too) |
| `npm run db:migrate:dev` | Create a migration after editing `prisma/schema.prisma` |
| `npm run db:studio` | Browse the database |

## Configuration (`.env`)

See `.env.example`. Secrets live only in `.env` on the machine that runs the server, never in git.
If `SMTP_HOST` is empty, no email is sent and sign-in codes are printed in the server log instead.

## Where things are

- `server/` API, realtime, auth, mail, notifications, reminders
- `prisma/` database schema and migrations
- `public/` the web app (`js/views/` has one file per screen group)
- `PLAN.md` what Forge does and why, `UPDATES.md` what was built and how
