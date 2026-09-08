# VYNE — Operations Runbook

_v5.32.74 · GCP project `vyne-platform-prod` · region `us-central1`_

Everything needed to deploy, verify and recover the platform. Written for
someone doing it at 6am without this conversation to hand.

---

## Standing facts

| Thing | Value |
|---|---|
| Cloud Run service | `vyne-api` |
| Cloud SQL instance | `vyne-platform-prod:us-central1:vyne-sql` |
| Frontend | Firebase Hosting → `https://vyne-platform-prod.web.app` |
| Deploy tree | `~/vyne-saas-deploy/vyne-saas` |
| App DB role | `vyne_app` (no SUPERUSER, no BYPASSRLS) |

---

## 1. Deploy

```bash
export PROJECT_ID=vyne-platform-prod
cd ~/vyne-saas-deploy
unzip -o ~/Downloads/vyne-saas-v<VERSION>.zip

cd ~/vyne-saas-deploy/vyne-saas
grep "VERSION = " backend/src/version.ts
```

**Check that version before going further.** A deploy from a tree you did not
actually extract into will succeed and change nothing, and the Firebase output
says "Deploy complete!" either way.

```bash
./deploy/deploy.sh api
./deploy/deploy.sh frontend
curl -s https://vyne-platform-prod.web.app/api/version; echo
```

The version endpoint is the only confirmation that counts.

### Two rules that come from real incidents

**Always `--update-secrets` / `--update-env-vars`, never `--set-`.** `--set-`
replaces rather than merges, and once wiped every environment variable on the
production service. `deploy.sh` does this correctly — the note it prints about
optional env vars being left alone is the merge behaviour working.

**`PROJECT_ID` must be exported.** The script falls back to whatever project
`gcloud` is pointed at and prints which one it chose, so an unexpected project is
visible rather than silent.

---

## 2. Migrations

Only when a release adds files under `backend/src/db/migrations/`.

```bash
~/cloud-sql-proxy --port 5433 vyne-platform-prod:us-central1:vyne-sql &
cd ~/vyne-saas-deploy/vyne-saas/backend
read -rs OWNER_PW && export OWNER_PW
DATABASE_URL="postgres://vyne:${OWNER_PW}@localhost:5433/vyne" npm run migrate
```

**Port 5433, never 5432.** 5432 is your local Postgres. Migrating there succeeds,
reports success, and leaves production untouched — the worst kind of failure,
because it looks like the good kind.

### If 5433 is already in use

```
bind: address already in use
```

means something is already listening there — usually a proxy from an earlier
deploy, because the invocation above ends in `&` and survives the terminal. Find
out **what** before doing anything else:

```bash
lsof -nP -iTCP:5433 -sTCP:LISTEN
ps -p <PID> -o command=
```

A proxy already pointed at `vyne-platform-prod:us-central1:vyne-sql` is fine —
use it, do not start a second. A proxy pointed at a DIFFERENT instance, or a
local Postgres somebody moved to 5433, is the dangerous case: the migration would
run, report `Applied: …`, and land in the wrong database. Kill it and start your
own:

```bash
kill <PID>
```

### Confirm the connection is production BEFORE migrating

`Applied: …` looks identical whichever database it reached, so the only moment
this is checkable is before. Run from `backend/`:

```bash
read -rs OWNER_PW && export OWNER_PW
node -e "const{Client}=require('pg');const c=new Client({connectionString:'postgres://vyne:'+process.env.OWNER_PW+'@localhost:5433/vyne'});c.connect().then(()=>c.query(\"SELECT current_database() db, substring(version() from 1 for 60) server, (SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1) latest, (SELECT count(*) FROM tenants) tenants\")).then(r=>{console.table(r.rows);return c.end()}).catch(e=>{console.error('FAILED:',e.message);return c.end()})"
```

Three things to read, and all three have to agree:

| | production | your laptop |
|---|---|---|
| `server` | a Linux build string | contains `apple-darwin` |
| `latest` | the migration BEFORE the one you are about to apply | anything else |
| `tenants` | the real firm count | 0, or a test fixture count |

A `latest` that already names the migration you are about to apply means either
it is done or you are somewhere else entirely — either way, stop and find out
which.

**Do NOT use `inet_server_addr()` for this.** The first version of this check
did, on the reasoning that production would show the instance's IP and a local
database would show `127.0.0.1`. Against the real proxy it returns **NULL**:
`inet_server_addr()` reports the address only when the backend sees a TCP
connection, and the Cloud SQL connector terminates on a socket at the instance
end. So the column reads NULL for production and `127.0.0.1/32` for a local
Postgres over TCP — the opposite way round from the way it was documented, and
NULL was listed as the laptop case. A check whose two outcomes are labelled
backwards is worse than no check. The `ps` output above is the decisive evidence
of what you are connected to; this query corroborates it.

Verify what actually ran. Must be run from `backend/`, because it resolves `pg`
from `backend/node_modules`:

```bash
node -e "const{Client}=require('pg');const c=new Client({connectionString:'postgres://vyne:'+process.env.OWNER_PW+'@localhost:5433/vyne'});c.connect().then(()=>c.query('SELECT filename, applied_at FROM schema_migrations ORDER BY filename DESC LIMIT 3')).then(r=>{console.table(r.rows);return c.end()}).catch(e=>{console.error('FAILED:',e.message);return c.end()})"
```

v5.32.83: this selected `name`, and the column is `filename` (see
`src/db/migrate.ts`, which creates the table). Run as written it raised
`column "name" does not exist` — and with no `.catch()` on the promise chain
that surfaced as an unhandled rejection, so the check whose only job is to say
which migrations landed could not answer, in a way easy to read as noise. Fixed,
and a `.catch` added so a future failure says what it was.

---

## 3. Preflight

```bash
cd ~/vyne-saas-deploy/vyne-saas/backend
../deploy/preflight.sh
```

Six checks. What each failure means:

**1. The `vyne_app` password.** FAIL means the migration default still works and
anyone reaching the database can set `app.tenant_id` themselves — the entire
tenant boundary. Fix today: `./deploy/deploy.sh rotate-db-password`. Needs a
proxy on 5433 to run at all.

**2. Error reporting.** PASS means the running revision writes to Cloud Error
Reporting. FAIL means the revision predates v5.32.70 and reports to nobody, which
includes lost-billing alerts. Console:
`https://console.cloud.google.com/errors?project=vyne-platform-prod`

**3. Client addresses and forensics.** Infrastructure addresses in the
distribution are expected behind Firebase Hosting and are harmless — authenticated
limits key on user ID, not address. What matters is that the `X-Forwarded-For`
chain is being recorded. A WARN here often just means every request in the window
arrived without one, which is normal on the Firebase path; the check prints a
curl against the Cloud Run URL to confirm.

**4. Rate limiting.** 429s on `/api/llm/*` or `/api/voice/*` at 60/min is the
system working. 429s on `/api/me` or `/api/engagements` are not, and are worth
reporting.

**5. Lost billing rows.** Anything listed here is usage spent and never recorded.

**6. Backups.** Checks the automated-backup *setting* and the age of the newest
backup, not merely that a list is non-empty. "unparseable" means the timestamp
could not be read — check the dates by eye rather than trusting a number.

---

## 4. Backups

Enable (no downtime):

```bash
gcloud sql instances patch vyne-sql --project vyne-platform-prod \
  --backup-start-time=03:00 --retained-backups-count=14 \
  --enable-point-in-time-recovery --retained-transaction-log-days=7
```

Verify — want `True True 03:00`:

```bash
gcloud sql instances describe vyne-sql --project vyne-platform-prod \
  --format='value(settings.backupConfiguration.enabled,
                  settings.backupConfiguration.pointInTimeRecoveryEnabled,
                  settings.backupConfiguration.startTime)'
```

Point-in-time recovery is the half that matters most. Without it the furthest you
can rewind is the last nightly, so a bad migration at 4pm costs a full day of
consultant work.

**Rehearse a restore against a throwaway clone, never the live instance.** Full
procedure in `BACKUP_RESTORE_RUNBOOK.md`. A backup nobody has restored is a
hypothesis.

---

## 5. Rotating the database password

The single most security-relevant routine operation.

```bash
cd ~/vyne-saas-deploy/vyne-saas
export PROJECT_ID=vyne-platform-prod
./deploy/deploy.sh rotate-db-password
```

Then re-run preflight check 1 and confirm it reads "the default password is gone".

---

## 6. Reading errors

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="vyne-api" AND severity>=ERROR' \
  --project vyne-platform-prod --freshness 1d --limit 20 \
  --format='value(timestamp, jsonPayload.message)'
```

Grouped view: `https://console.cloud.google.com/errors?project=vyne-platform-prod`

Request logs, including the forwarding chain:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="vyne-api" AND jsonPayload.req.url:*' \
  --project vyne-platform-prod --freshness 1h --limit 20 \
  --format='value(jsonPayload.req.method, jsonPayload.req.url, jsonPayload.req.remoteAddress, jsonPayload.req.xff)'
```

---

## 7. Rollback

```bash
gcloud run revisions list --service vyne-api --region us-central1 \
  --project vyne-platform-prod --limit 5 \
  --format='value(metadata.name, status.conditions[0].lastTransitionTime)'

gcloud run services update-traffic vyne-api --region us-central1 \
  --project vyne-platform-prod --to-revisions <REVISION>=100
```

Traffic moves in seconds. **A rollback does not undo a migration** — migrations
are forward-only, so an older revision meets a newer schema. If the release
included one, check that the old code tolerates the new columns before rolling
back, and prefer rolling forward with a fix.

---

## 8. Running the tests

```bash
cd backend && npx vitest run                 # ~680 tests
for f in ../frontend/test/*.mjs; do node "$f"; done   # ~285 assertions
npx tsc --noEmit -p tsconfig.json
```

The frontend suites need `playwright` and `ws` resolvable from the repo root; CI
installs both.

**The house rule:** every fix ships with a test, and that test is verified by
backing the fix out and watching it fail. A test that passes with the bug
restored is worse than no test, because it reports the property as held. This has
happened here more than once and is caught only by actually performing the
revert.
