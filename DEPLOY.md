# Deploying the Engineering Planning Tracker

The point of deploying is that the team stops emailing the workbook around.
Everyone opens one URL and sees one set of data.

Three routes below. **Render** is the quickest way to get a link to send round;
**Docker** is what to use once it holds work you cannot lose.

---

## The three settings that matter

Whichever route you take, set these. A deployment missing them is worse than
running it on one laptop, because it *looks* shared.

| Setting | Without it |
|---|---|
| `DATABASE_URL` | Data goes to a JSON file inside the container. On Render that file is destroyed on every deploy and every wake from sleep. |
| `SESSION_SECRET` | Generated fresh on each boot, so everybody is signed out several times a day and blames the app. |
| `ACCESS_CODE` | The first person to open the URL claims the administrator account. On a public URL that is whoever finds it first. |

Generate the secret with:

```bash
openssl rand -hex 32
```

Also set `TZ` to the plant's timezone (`Asia/Riyadh`). Without it "due today"
means today in UTC, and anything looked at between midnight and 03:00 local is
working from yesterday's date.

---

## 1. Render — free, quickest

[`render.yaml`](render.yaml) is a blueprint, so this is mostly clicking.

**Get a database first.** The blueprint does not create one — see *Why the
blueprint does not create a database* below. Either:

- **Neon** ([neon.tech](https://neon.tech)) — free, and it persists. Create a
  project and copy the connection string. This is the one to pick.
- **An existing Render Postgres** — open it and copy the **Internal Database
  URL**. Sharing it with another application is safe: these tables are created
  in their own `planning` schema.

Then:

1. Go to **[dashboard.render.com/blueprints](https://dashboard.render.com/blueprints) → New Blueprint Instance**.
2. Connect this repository. Render reads `render.yaml` and offers one web
   service, `engineering-planning-tracker`.
3. Give the blueprint a name, then fill in the values marked `sync: false`:
   - **`DATABASE_URL`** — required. The connection string from above.
   - **`ACCESS_CODE`** — required. Anything the team can be told once.
   - `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` — optional. Set them and
     the administrator exists on first boot; leave them blank and the first
     visitor creates it through the setup screen using the access code.
4. **Apply**. `SESSION_SECRET` is generated for you and stays stable across
   deploys.
5. Open the URL. Create the administrator, then **Import workbook**.

### Why the blueprint does not create a database

Render allows **one free Postgres per account**. A blueprint that creates its
own therefore fails outright for anybody who already has one — the sync stops
with

```
Create database planning-db
  ✗ cannot have more than one active free tier database
Create web service engineering-planning-tracker
  ✗ (canceled: another action failed)
```

and nothing is deployed. Asking for a connection string instead works whether
the database is new or already there, on Render or off it, free or paid — and
it steers you towards a database that does not evaporate after thirty days.

`DATABASE_SSL` is set to `no-verify` in the blueprint because managed Postgres
presents a certificate this app does not chain-verify. Neon and Render both need
it. Only a server with TLS switched off entirely — a local container — needs
`disable` instead, which is what `docker-compose.yml` sets.

The blueprint uses the **Frankfurt** region, the closest Render offers to Saudi
Arabia. Change `region:` in both entries if that is wrong — they must match, or
the app reaches the database over the public internet instead of Render's
private network.

### Two free-tier limits, before the team relies on it

**Services sleep after 15 minutes idle** and take about 50 seconds to wake. That
wait shows Render's own "service waking up" page, served before this app is
running, so it cannot be styled or skipped from here.

[`.github/workflows/keep-awake.yml`](.github/workflows/keep-awake.yml) pings
`/api/health` every five minutes, every day, **06:00–22:55 local**, so nobody
meets that screen during the hours anybody is using it. It needs no setup — the
URL is in the workflow file, because it is printed on the service's own page and
there is nothing secret about it. Set a `TRACKER_URL` repository secret only if
you want to override it without editing the file.

**It stops overnight deliberately, and cannot cover the whole day.** The free
tier allows 750 instance-hours a month per workspace. The 17-hour window is
about 517 of them, leaving roughly 230 for the service's own real traffic.
Awake around the clock is about 730 — which would spend the entire allowance and
**suspend the service until the first of the next month**. A fifty-second wait at
six in the morning is a far better outcome than a dead URL for the last week of
every month, so the window is the practical limit without paying.

Between 23:00 and 06:00 the first visitor still meets Render's waking screen.
That page is served by Render before this app is running, so it cannot be styled
or skipped from here — the only complete fix is a paid instance, which never
sleeps.

**Render's own free database is deleted after 30 days.** This is the one that
will bite, and it is why the blueprint points you at Neon instead. If you did
use a Render free database, move before it holds anything you cannot lose:

1. Create a project at [neon.tech](https://neon.tech) and copy the connection
   string.
2. **Export all** from the running app first — that workbook is your data.
3. In the Render service → **Environment**, replace `DATABASE_URL` with the Neon
   string. Leave `DATABASE_SSL=no-verify` as it is.
4. Redeploy. The tables are created on boot, empty — then import the workbook
   you exported in step 2.

---

## 2. Docker — a VM, or a machine on the plant network

Nothing sleeps, nothing is deleted after thirty days, and the data stays inside
your network.

```bash
git clone https://github.com/abdulrahmansankyu-glitch/Yusuf.git
cd Yusuf
cp .env.example .env
```

Edit `.env` and set at least:

```
SESSION_SECRET=<openssl rand -hex 32>
ACCESS_CODE=<something the team is told once>
POSTGRES_PASSWORD=<anything long>
```

Then:

```bash
docker compose up -d           # http://<that machine>:4200
docker compose logs -f app     # watch it start
```

The app waits for Postgres to pass its health check before starting, so a slow
first boot is not a crash loop. Data lives in the `db-data` volume and survives
`docker compose down`; `docker compose down -v` deletes it.

To update:

```bash
git pull && docker compose up -d --build
```

**Back it up.** A volume on one machine is not a backup:

```bash
docker compose exec db pg_dump -U planning planning > planning-$(date +%F).sql
```

Or press **Export all** in the app — that gives you the workbook, which is the
backup the team can actually read.

---

## 3. Bare Node

Behind whatever already serves you:

```bash
npm ci --omit=dev
DATABASE_URL=postgres://... SESSION_SECRET=... ACCESS_CODE=... TZ=Asia/Riyadh npm start
```

Node 20 or newer. Put it behind nginx or Caddy for TLS; the app speaks plain
HTTP on `PORT` (default 4200) and binds all interfaces.

---

## Checking it worked

```bash
curl https://your-url/api/health
```

```json
{"ok":true,"storage":"postgres","today":"2026-08-20"}
```

`"storage"` is the one to read. If it says **`file`**, `DATABASE_URL` did not
reach the process — the app is running against a JSON file that the next deploy
will destroy, and everything else will look completely normal until it does.

---

## What was verified, and where

Run against a real PostgreSQL 16 before this was written: schema creation on
boot, importing all fifteen sheets (77 records, 11 legend rows rejected), the
dashboard figures, create/update/delete, document numbering, Excel export, and
the activity log. Data and sessions both survive a restart, and the tables are
created in their own `planning` schema with nothing in `public` — so a migration
tool pointed at another application in the same database cannot reach them.

The **Docker image has not been built** anywhere yet. The sandbox this was
written in blocks Docker Hub, so `docker build` could not run. The Dockerfile is
short and conventional, but treat the first `docker compose up` as the thing
that proves it, not as a formality.
