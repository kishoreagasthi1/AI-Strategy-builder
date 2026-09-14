# Cloud SQL Backup & Restore Runbook

Automated backups plus point-in-time recovery (PITR) for the `vyne-sql`
Postgres instance, and — the part that actually matters — a drill that
*proves* a restore works, not just that backups exist. An unverified backup
is a belief, not a safety net.

This can't be run or verified from this sandbox: it needs `gcloud` authenticated
against the real GCP project, and creating/deleting Cloud SQL instances costs
real money and takes real minutes. Everything below is written to be run by
hand, copy-paste, against `vyne-platform-prod` (or whichever project is
live) — the same way `deploy/deploy.sh` and `WHITE_LABEL_RUNBOOK.md` already
work in this repo.

Shorthand used throughout:

    PROJECT_ID=vyne-platform-prod
    REGION=us-central1
    SQL_INSTANCE=vyne-sql

## 0. Why this exists

The deploy history for this platform already includes one close call: a
`gcloud sql users set-password` mistake during a migration troubleshooting
session (see the deploy log in this repo's session history) — recoverable
because it was a password reset, not data loss, but it's exactly the kind
of operator error backups exist for. Cloud SQL backups were never
explicitly configured or verified before this runbook. "Cloud SQL has
backups by default" is not something to assume — automated backups and
PITR are both **opt-in** settings on the instance, and even once enabled,
a backup you've never test-restored is unverified.

## 1. One-time setup: enable automated backups + PITR

```bash
gcloud sql instances patch "$SQL_INSTANCE" \
  --project="$PROJECT_ID" \
  --backup-start-time=03:00 \
  --enable-point-in-time-recovery \
  --retained-backups-count=14 \
  --retained-transaction-log-days=7
```

- `--backup-start-time=03:00` — daily automated backup window, in UTC. Pick
  a low-traffic hour; adjust if the firm's usage pattern skews non-US.
- `--enable-point-in-time-recovery` — turns on write-ahead log archiving, so
  you can restore to *any second* within the retention window, not just to
  the moment of last night's backup. This is what limits real data loss in
  an incident to seconds/minutes instead of up-to-24-hours.
- `--retained-backups-count=14` — keep 14 daily backups (~2 weeks).
- `--retained-transaction-log-days=7` — PITR window; must be ≤ how far back
  your oldest retained backup goes, since PITR replays logs forward from a
  base backup.

This command takes effect immediately but doesn't take a backup itself —
the first automated backup happens at the next `backup-start-time`. To
confirm what's configured (don't guess):

```bash
gcloud sql instances describe "$SQL_INSTANCE" --project="$PROJECT_ID" \
  --format="yaml(settings.backupConfiguration)"
```

Expect to see `enabled: true`, `pointInTimeRecoveryEnabled: true`, and
your `startTime`/retention values echoed back.

## 2. Take an on-demand backup before anything risky

Do this before any production migration (`npm run migrate` against the
real DB) or bulk data operation — belt-and-suspenders on top of the nightly
automated one, so a same-day mistake still has a backup taken *seconds*
before it, not up to 24 hours before.

```bash
gcloud sql backups create --instance="$SQL_INSTANCE" --project="$PROJECT_ID" \
  --description="pre-migration $(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

List backups (confirm it landed, note the `ID` for restore):

```bash
gcloud sql backups list --instance="$SQL_INSTANCE" --project="$PROJECT_ID"
```

## 3. The verification drill — prove a restore actually works

Run this after initial setup, and periodically thereafter (see §5 for
cadence). It restores into a **separate, throwaway instance** — never
restore in place onto the live `vyne-sql` instance as your first attempt at
a real incident; that's how a botched restore turns a partial outage into a
total one.

```bash
DRILL_INSTANCE="vyne-sql-restore-drill-$(date +%Y%m%d)"

# 3a. Pick a backup to restore from (or use the on-demand one from §2).
gcloud sql backups list --instance="$SQL_INSTANCE" --project="$PROJECT_ID" --limit=1
BACKUP_ID="<id from the list above>"

# 3b. Restore that backup into a brand-new instance — NOT vyne-sql itself.
gcloud sql instances create "$DRILL_INSTANCE" \
  --project="$PROJECT_ID" --region="$REGION" \
  --database-version=POSTGRES_16 --tier=db-g1-small
gcloud sql backups restore "$BACKUP_ID" \
  --restore-instance="$DRILL_INSTANCE" \
  --backup-instance="$SQL_INSTANCE" \
  --project="$PROJECT_ID"
```

The restore itself can take several minutes. Poll with:

```bash
gcloud sql operations list --instance="$DRILL_INSTANCE" --project="$PROJECT_ID" --limit=1
```

### 3c. Verify the data is actually real, not just that the instance booted

An instance that starts up is not proof the restore worked — connect and
check real rows. From Cloud Shell (has `psql` preinstalled — see the
session's earlier deploy log for why Cloud Shell is the reliable fallback
when local tooling is missing):

```bash
gcloud sql connect "$DRILL_INSTANCE" --user=postgres --project="$PROJECT_ID"
```

Then, inside `psql`:

```sql
\c vyne
SELECT count(*) FROM tenants;
SELECT count(*) FROM interviews;
SELECT id, name, created_at FROM tenants ORDER BY created_at DESC LIMIT 5;
SELECT max(created_at) FROM usage_events;  -- sanity check: how recent is this backup?
```

Compare row counts and the most-recent timestamps against what you'd
expect from the live instance at backup time. If `tenants`/`interviews`
counts are zero or wildly off, the backup or restore process is broken —
that is exactly what this drill exists to catch, on a Tuesday afternoon
instead of during a real incident.

### 3d. Tear down the drill instance

Cloud SQL instances bill continuously — don't leave this running.

```bash
gcloud sql instances delete "$DRILL_INSTANCE" --project="$PROJECT_ID" --quiet
```

## 4. Point-in-time recovery drill (restore to a specific timestamp)

Same idea as §3, but restoring to an exact moment rather than a nightly
backup — this is the path for "an operator ran a bad UPDATE at 2:14pm,
restore to 2:13pm":

```bash
DRILL_INSTANCE="vyne-sql-pitr-drill-$(date +%Y%m%d)"
RESTORE_TIME="2026-08-01T14:13:00Z"   # RFC3339, UTC

gcloud sql instances create "$DRILL_INSTANCE" \
  --project="$PROJECT_ID" --region="$REGION" \
  --database-version=POSTGRES_16 --tier=db-g1-small

gcloud sql instances clone "$SQL_INSTANCE" "$DRILL_INSTANCE" \
  --project="$PROJECT_ID" \
  --point-in-time="$RESTORE_TIME"
```

Verify with the same `psql` checks as §3c (row counts, most-recent
timestamps should land right around `RESTORE_TIME`, not later), then tear
down the same way as §3d.

## 5. Recommended cadence

- **Automated backups + PITR (§1)**: configure once, immediately — this is
  the actual safety net and should not wait for a "someday" task.
- **On-demand backup (§2)**: before every production migration or bulk
  data operation.
- **Verification drill (§3)**: once at initial setup (do this now, not
  later — an unverified backup is unverified until you've actually run a
  restore), then quarterly, and again after any change to the backup
  configuration or Postgres major version.
- **PITR drill (§4)**: at initial setup, then whenever the retention
  window changes.

## 6. In a real incident

1. **Do not restore onto the live instance first.** Restore into a new
   instance (§3b/§4), verify (§3c), *then* decide: point the API's
   `DATABASE_URL` at the restored instance (fastest path back up, but
   changes the instance's connection name/IP — update the Cloud Run env var
   and, if using the Cloud SQL Auth Proxy, its instance connection name),
   or use the restored instance purely to recover specific rows/tables and
   merge them back into the live instance with targeted `INSERT`/`UPDATE`
   statements.
2. Rotate the `vyne_app`/`vyne` passwords after any incident that involved
   credential exposure (see this repo's deploy history for the exact
   `gcloud sql users set-password` command already used once).
3. Update `frontend/about.html`'s expectations and notify affected tenants
   only after confirming what data (if any) was actually lost — the PITR
   window in §1 makes "zero data loss, seconds of downtime" the realistic
   outcome for anything caught within the retention window.
