# Deploy openGym on Vercel Hobby + Supabase

One origin serves the static app and `/api/*`. Passkeys need that, and they need HTTPS on the exact hostname you set as `RP_ID` / `ORIGIN`. The Docker stack is unchanged: it still uses JSON files under `DATA_DIR` until `DATABASE_URL` is set.

Supabase free tier is the database (500 MB) and, optionally, the place uploaded photos and videos go. The API connects with the **service role** / database owner. The browser never sees that key. Row level security is on and the Data API roles are denied, so the anon key cannot read the tables.

## 1. Supabase project

1. Create a project at [supabase.com](https://supabase.com). Free tier is enough for one person.
2. In **Project Settings → Database**, copy the **connection string** (URI). Use the **pooler** (port 6543, transaction mode, or port 5432 session mode). This app sets `prepare: false`, so both modes work. Put the database password in the URI.
3. In **Project Settings → API**, copy the project URL and the **service_role** key. Do not put the service role key in the frontend, in git, or in a `VITE_` variable.

Apply the migration. From a machine with the repo and [psql](https://www.postgresql.org/docs/current/app-psql.html) (or the Supabase SQL editor, pasting the file):

```bash
psql "$DATABASE_URL" -f supabase/migrations/20261022183055_opengym_persistence.sql
```

The Supabase CLI does the same thing after `supabase link`:

```bash
npx supabase db push
```

That file is the only migration. It creates the tables, enables RLS, and adds a policy that denies `anon` and `authenticated`. Do not add a policy that opens those tables, and do not turn on **Force RLS** (the server connects as the owner and would lock itself out).

### Storage (photos and videos)

In **Storage**, you can leave the bucket alone: the API creates a private bucket named `opengym-media` on its first database ping when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set.

The browser uploads and downloads large files **directly** with a signed URL. Add `https://YOUR_DOMAIN` (the same value as `ORIGIN`, no trailing slash) under **Project Settings → API → CORS allowed origins**. Storage is a separate service: if the dashboard has a Storage CORS list, allow that origin for `GET` and `PUT`, and allow the headers `authorization`, `content-type`, and `x-upsert`.

If the browser still blocks the signed URL, the app sends the file through the API in parts instead. Those parts land in Postgres (`bytea`), which is fine for photos and will fill the 500 MB database if you store many videos. Without the two Storage env vars, that part path is the only one used for files over about 3.5 MB, and smaller files still use `PUT /api/media/{hash}`.

## 2. Vercel project

Hobby can import a personal GitHub repo. Import `sakylmusa1/openGym`. The repo's `vercel.json` builds the frontend, copies exercise media into the output with `scripts/catalogue/stage-media.mjs`, and publishes one Node function for `/api/*` via the Build Output API. Do not set an Output Directory in the dashboard; that would drop the function.

Framework preset: **Other**. Node 22. **Root Directory: the repository root.** Leave it empty. Setting it to a subfolder still loads this root `vercel.json`, and the install then looks for `frontend/` and `server/` in the wrong place.

The Node source is `server/`, not a root `api/` directory. Vercel turns every `.js` file under a root `api/` directory into its own Serverless Function and counts those on top of anything the Build Output API emitted. Hobby allows 12 functions, and this server is one file plus about a hundred modules, so that detection rejects the deploy. The build copies `server/` into a single `.vercel/output/functions/api.func`, which is what the browser calls at `/api/*`. Do not rename `server/` back to `api/`.

### Environment variables

Set these on the Vercel project (Production, and Preview if you use it). A preview URL is a different host, so passkeys on a preview will not match production `RP_ID`.

| Variable | Required | What it is |
| --- | --- | --- |
| `DATABASE_URL` | yes | Supabase pooler URI. This is what turns Postgres mode on. Without it the function has nowhere to write. |
| `SUPABASE_URL` | for Storage | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | for Storage | service role key. Server only. |
| `RP_ID` | yes | Hostname only, no scheme and no port. `gym.example.com` |
| `ORIGIN` | yes | Exact origin, `https://gym.example.com` |
| `RP_NAME` | no | Shown in the passkey prompt. Default `openGym`. |
| `CRON_SECRET` | yes | Long random string. `openssl rand -hex 32`. Vercel sends it as `Authorization: Bearer …` on its cron. cron-job.org may send the same header or `?secret=`. |
| `SESSION_SECRET` | recommended | Long random string. If unset, the server generates one and stores it in `app_kv`. Setting it here means a database restore does not sign every device out, as long as you keep the same value. |
| `VAPID_PUBLIC_KEY` | recommended | From `npx web-push generate-vapid-keys`. If unset, a pair is generated once into `app_kv`. |
| `VAPID_PRIVATE_KEY` | with the public key | Both or neither. |
| `VAPID_SUBJECT` | no | `mailto:you@example.com`. Default is `ORIGIN` on HTTPS. |
| `TRUST_PROXY` | automatic | The function sets this itself on Vercel so the client address is the last `X-Forwarded-For` hop. You can also set `TRUST_PROXY=1`. |
| `FIRST_USER_ADMIN` | first boot | `1` so the first account becomes admin. Turn it off after that account exists, or leave it: it only applies when the instance has no profiles. |
| `SESSION_DAYS` | no | Default 90. |
| `INVITE_ONLY` | no | `1` to require an invite code. |
| `ALLOW_GUEST` | no | Default on. `0` hides "continue without an account". |
| `PASSWORD_LOGIN` | no | `1` to allow name-and-password beside passkeys. |
| `DEFAULT_LANG` | no | A tag such as `en` or `pt-BR`. |
| `MEDIA_UPLOADS` | no | Default on. `0` disables photo/video upload. |
| `MEDIA_QUOTA_MB` | no | Default 200. `0` is no cap. |
| `MEDIA_IMAGE_MAX_MB` | no | Default 2. |
| `MEDIA_GIF_MAX_MB` | no | Default 8. |
| `MEDIA_VIDEO_MAX_MB` | no | Default 40. |
| `MEDIA_VIDEO_MAX_SEC` | no | Default 60. |
| `MEDIA_GC_GRACE_DAYS` | no | Default 14. |
| `MEDIA_UPLOADS_PER_HOUR` | no | Default 600. |
| `AUDIT_LOG` | no | Default on. `0` disables it. |
| `AUDIT_MAX` | no | Default 5000 rows. `0` is no count cap. |
| `AUDIT_DAYS` | no | Default 90. `0` is no age cap. |
| `AUDIT_IP` | no | Default off. `net` stores a prefix, `full` stores the address. |
| `COACH_DISABLED` | no | `1` forces the Coach off. |
| `COACH_JOB_TIMEOUT_MS` | no | On Vercel this is capped at 240000 so the job finishes inside the 300s limit. |
| `DATABASE_SSL` | local only | `disable` for a Postgres on localhost. Leave unset for Supabase (TLS is the default). |

Do not set `DATA_DIR` on Vercel. Do not commit `.env`.

Coach provider keys are **not** env vars. After you are signed in as admin, open the admin screen and connect an HTTP provider (Anthropic, OpenAI, Gemini, or an OpenAI-compatible API). The key is encrypted with the session secret and stored in Postgres.

## 3. Domain

Add your domain in the Vercel project and point DNS at Vercel. `RP_ID` and `ORIGIN` must be that hostname. Passkeys registered on another host will not log in here.

Redeploy after the env vars are set. Open `https://YOUR_DOMAIN/api/health`. You want `{ "ok": true, "writable": true }`.

## 4. cron-job.org

Vercel Hobby runs a cron **once a day**. That is not enough for a reminder that has to land in a 15-minute window, or for a rest timer. Use a free scheduler to call the tick every minute.

1. Create a job at [cron-job.org](https://cron-job.org).
2. URL: `https://YOUR_DOMAIN/api/cron/tick?secret=YOUR_CRON_SECRET`  
   Prefer a header if the scheduler allows it: `Authorization: Bearer YOUR_CRON_SECRET`, and then the query string can be omitted.
3. Schedule: every minute.
4. Expect HTTP 200 and `{ "ok": true }`. 401 means the secret does not match.

`vercel.json` also registers `GET /api/cron/daily` at 04:00 UTC. Vercel sends `Authorization: Bearer $CRON_SECRET` when that env var exists. The daily job repeats the tick and runs the Coach's scheduled reviews. If cron-job.org is down, reminders only fire if they fall inside the 15 minutes before that daily run.

## 5. First account

With `FIRST_USER_ADMIN=1` and an empty database, register a passkey on the site. That profile is the admin (`user.admin`). From the admin screen you can turn on invites (`INVITE_ONLY=1` plus a redeploy, then create codes), connect the Coach, and read the audit log.

You can instead leave `FIRST_USER_ADMIN` unset, register, copy the user id from the `documents` row `db` (or the register response), set `ADMIN_UIDS` to that id, and redeploy.

## 6. What is different on the free tier

- **Reminders** need the minutely ping. The daily Vercel cron is only a backstop.
- **Rest-timer push** is exact on screen (the app's own timer, and the phone's local notification). The server push is the backup for a backgrounded tab. On Vercel a rest of up to about 4 minutes is also scheduled inside the request (`waitUntil`) when `@vercel/functions` is available. Longer rests are sent by the minute tick, so the push can be up to about a minute late. The tick and the in-request timer claim the same row, so only one is sent.
- **Coach** jobs run inside the request that started them and must finish in about 4 minutes. A timeout is a failed job; start it again. The Claude Agent SDK and the Codex CLI are not in the Vercel function (they spawn local processes). Use an HTTP API key. A weekly review that nobody asks for by hand runs on the daily cron, so it can be many hours after the evening you picked.
- **Rate limits** (password attempts) live in the memory of one instance and reset when that instance goes cold.
- **The MCP server** still reads JSON files in `DATA_DIR`. It does not talk to Supabase.
- **Large media downloads** use a signed Storage URL when Storage is configured (allow the site origin on CORS, above). If that URL is blocked, or Storage is not configured, the app downloads the file in ranges through `/api/media/{hash}`.
- **Sync** of a profile over ~3.5 MB is gzipped, then split into parts if it is still too big. Each request stays under the 4.5 MB platform limit.
- Supabase free egress, storage, and the 500 MB database cap still apply. A few long videos belong in Storage, not in `bytea`.

## 7. Local API against Postgres

```bash
# Postgres already running, database and user created
export DATABASE_URL=postgres://opengym:opengym@127.0.0.1:5432/opengym
export DATABASE_SSL=disable
export SESSION_SECRET=$(openssl rand -hex 32)
export CRON_SECRET=$(openssl rand -hex 32)
export RP_ID=localhost
export ORIGIN=http://localhost:8080
psql "$DATABASE_URL" -f supabase/migrations/20261022183055_opengym_persistence.sql
cd server && node server.js
```

`GET /api/cron/tick?secret=$CRON_SECRET` runs reminders and cleanups once. Unset `DATABASE_URL` and the same process is the file-backed server Docker uses.

The API test `server/test/pg-vercel.test.js` applies the migration itself and skips when that URL is down. It does not read `DATABASE_URL` from the environment of the rest of the suite, so `cd server && npm test` stays on files unless Postgres is actually listening.
