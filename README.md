# thugilcreationbackend-server

Node.js (Express) API for the Thugil Creation admin: designs, orders, clients, students, courses and certificates.
Data lives in PostgreSQL; design images are stored in S3.

## Getting started

```bash
npm install
cp .env.example .env     # then fill in the real values
npm run dev              # http://localhost:3001  (Swagger docs at /docs)
```

The server runs any new SQL files in `migrations/` every time it starts, so the database is always up to date.

## Environment

| Variable | What it is |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | Port to listen on (default 3001) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Only used by the one-off import scripts (they only read from Supabase) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_BUCKET_NAME`, `AWS_REGION` | S3 bucket for design images and course thumbnails |

`.env` is git-ignored. Never commit real keys.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-restart |
| `npm start` | Start |
| `npm test` | Run the tests (they use the configured database and clean up after themselves) |
| `npm run migrate` | Apply pending migrations |
| `npm run import:supabase` | Users from Supabase (customers and course users) |
| `npm run import:designs` | Designs, one table per saree style |
| `npm run import:designers` | Designers (clients) |
| `npm run import:orders` | Design orders and their items |
| `npm run import:courses` | Courses, enrollments, certificates, video progress |
| `npm run import:course-content` | Course sections, videos, files, software, reviews |

Every import script is a dry run unless you add `-- --commit`, and is safe to run again.

## Layout

```
migrations/   numbered SQL files, applied in order
src/routes/   one file per area (designs, orders, courses, ...)
src/scripts/  one-off imports
tests/        API tests
```

## Notes

- The API has no login check yet: put it behind authentication before exposing it publicly.
