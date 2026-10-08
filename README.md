# Queryroom — Text-to-SQL agent

Ask questions about a PostgreSQL, MySQL or SQLite database in plain language. An LLM drafts a
read-only SQL query, you review (and optionally edit) it, and it only runs after you approve it.

## Getting started

```bash
bun install
cp .env.example .env.local   # optional settings, see below
bun dev
```

Open <http://localhost:3000> for the product overview, or go straight to
<http://localhost:3000/workspace>. Enter the database and model details, test both connections,
and choose a passphrase. Connection details and chat history are encrypted in your browser with that
passphrase.

## How a question is answered

1. The server reads the database schema (cached for one minute) and sends it, along with your
   question, the optional database description from setup, and the earlier questions and SQL of
   the same conversation (never query results), to the model (any OpenAI-compatible endpoint).
   Foreign keys are included; for databases without them, likely joins are inferred from column
   names such as `role_id`.
2. The draft SQL goes through the safety check in `lib/security/sql-policy.ts`. If it fails, the
   model gets the errors and up to two attempts to correct it.
3. You see the SQL and approve, edit or reject it. Edited SQL is checked again, and problems are
   shown on the approval card.
4. The approved query runs in a read-only transaction with a statement timeout, capped at the
   configured row and response-size limits.

Pasting SQL directly (optionally in a ` ```sql ` fence) skips the model and goes straight to
approval.

## Safety model

- **Use a read-only database user.** This is the primary protection. The SQL checks are a second
  layer on top of it.
- Only a single `SELECT`/`WITH` statement is accepted. Mutations, locking clauses, comments and
  administration or file functions (`pg_*`, `set_config`, `sleep`, `load_file`, `load_extension`,
  …) are rejected after parsing the query.
- The outermost query always gets a `LIMIT` no larger than the configured maximum rows.
- The server is stateless: a pending approval lives in the browser (in the encrypted chat history).
  Approve or Edit sends the SQL and connection back, and the server validates the SQL again before
  running anything. This works on serverless hosts such as Vercel and survives restarts.
- Chat history, including result rows, is stored encrypted in `localStorage`. Credentials are
  stored in a passphrase vault (PBKDF2-SHA256, 600k iterations, AES-GCM).

## Configuration

All settings are optional environment variables (see `.env.example`):

| Variable              | Purpose                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `APP_BASIC_AUTH`      | `user:password` — require HTTP Basic auth for the app and all API routes |
| `ALLOWED_DB_HOSTS`    | Comma-separated hosts that PostgreSQL/MySQL connections may use          |
| `ALLOWED_MODEL_HOSTS` | Comma-separated hosts that custom model base URLs may use                |
| `SQLITE_ALLOWED_DIRS` | Comma-separated directories that SQLite files must be inside             |

Without them the server will connect to any host or file a client sends. That is fine on
localhost, but set all four before exposing the app to anyone else.

## Scripts

| Command             | Description                          |
| ------------------- | ------------------------------------ |
| `bun dev`           | Start the development server         |
| `bun run build`     | Production build (standalone output) |
| `bun test`          | Unit tests                           |
| `bun run typecheck` | TypeScript check                     |
| `bun run lint`      | ESLint (includes Prettier)           |
| `bun run verify`    | Typecheck, format, lint and build    |

## Project layout

```
app/                Pages: home (/) and workspace (/workspace)
app/api/            Route handlers (agent run/resume, health checks, schema)
features/home       Home page and animated product demo
features/query-room Workspace UI: setup, unlock and chat screens
features/shared     Logo, theme store and toggle, motion settings
lib/security/       SQL policy and browser vault encryption
lib/server/agent/   Question handling, approvals, prompts, model calls
lib/server/db.ts    Database drivers, schema introspection, read-only execution
proxy.ts            Optional Basic auth
```

## Known limitations

- Only OpenAI-compatible model providers are supported.
