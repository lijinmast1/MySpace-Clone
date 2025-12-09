# MySpace Clone (Course Project)

## Quick start (local)
1. Install Node & Postgres.
2. Copy `.env.example` to `.env` and edit `DATABASE_URL` and `SESSION_SECRET`.
3. `npm install`
4. `npm run setup`  # creates tables and sample users
5. `npm run start`
6. Visit `http://localhost:3000`

## Deployment
- App uses Node/Express and a Postgres DB.
- For cloud deployment, configure environment variables like `DATABASE_URL`, `SESSION_SECRET`, and `UPLOAD_DIR`.
- Example: deploy to Fly.io or Render with a Postgres addon.

## What to include with contract review
- Deployed URL (or local instructions if not deployed).
- Checklist of contract items, marked Done / Not Done (see contract review instructions). See `Project contract review` page for required format. :contentReference[oaicite:18]{index=18}

## Notes
- The WebSocket DM uses a minimal auth pattern for demo; for the instructor, if you want to run locally, open the site and register two users then connect both in different browsers.
