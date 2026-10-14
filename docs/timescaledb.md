# TimescaleDB historian (CMF canonical schema)

The edge historian is PostgreSQL + TimescaleDB, database `ahwr_edge`. It stores
data in the **same tables and columns as the Central Monitoring Facility (CMF)**
(`central/db/init.sql`), so edge rows can be copied to, replayed into or compared
with the CMF without transformation. The operating records (users, work orders,
logbook, alarm settings, …) are in the same database. InfluxDB is no longer used
at run time; a one-time tool migrates its history.

Monitoring-only is unchanged: nothing in the database, Telegraf or the backend
writes to a PLC.

## Data flow

```
S7 / Modbus PLC ──read──▶ Telegraf ──(Starlark: tag → CMF metric)──▶ telemetry ◀── backend: derived depth/WOB
VersaMax BOP (OPC UA) ─▶ collector.py ─▶ Telegraf :8186 (loopback) ─┘          │
                                                                                ├─▶ telemetry_1m (1-minute rollup, kept forever)
backend: alarms, connections, well lifecycle ─▶ events, connections, wells, well_runs
backend: users, work orders, logbook, settings ─▶ app.documents (operating records)
backend live view (1 Hz) ◀── latest value per metric over the last 10 s
```

* **Telegraf** owns ingestion. `telegraf.d/plc.conf` is written by the backend from
  `plc_config.json`: the PLC inputs, the `rig_id` global tag (from `DEVICE_ID`) and
  a Starlark processor. The processor (map in `telegraf.d/ahwr-telemetry.star`)
  turns every field into a `(ts, rig_id, metric, value)` row: mapped PLC tags get
  the backend's metric names (`drawworks.hook_load`), unmapped tags keep their raw
  name under their group (`AHWR.<tag>`), booleans become 1/0, the configured
  scale is applied, NaN/±Inf are dropped. Telegraf buffers up to 100 000 metrics
  while the database is unavailable.
* **Duplicates**: when several configured tags map to one metric (e.g. primary
  and backup SPM), the one listed first in `fieldmap.js` wins; the others are
  stored under their raw names. Under InfluxDB the winner was whichever row the
  query returned last.
* **The backend** reads the latest value of every metric each second, turns PLC
  bit metrics back into booleans for the screens, derives depth/WOB when the PLC
  does not supply them (stored as telemetry, not while the feed is stale), and
  writes every event it queues for the CMF into `events` (and `connections`).
* **The BOP collector** no longer holds database credentials: it posts line
  protocol to Telegraf's loopback listener (`TELEGRAF_LISTENER_URL`). It keeps
  one OPC UA session open and reads all configured nodes in one request per
  cycle, reconnecting with back-off.
* **Operating records** — the former JSON files in `DATA_DIR` (users, work
  orders, logbook, overhauls, PM, calibrations, instruments, alarm settings and
  alarm history, activity/downtime logs, run hours, well registry, dashboard
  layout, PLC and BOP configuration) — are rows of `app.documents`, one per file
  name. `server.js` loads them before the application starts and waits, retrying
  every 5 s, while the database is unreachable, so the edge never starts on empty
  or stale records. On the first start existing `*.json` files are imported and
  moved to `DATA_DIR/imported-to-database-<time>/`. Writes are coalesced (2 s;
  10 s for documents over 256 KB) and retried until the database accepts them;
  shutdown flushes them. `plc_config.json` and `bop_config.json` are still
  mirrored as files, because the BOP collector reads its configuration from disk.
  `PERSIST_BACKEND=file` keeps the old file store (tests and development only).

## Schema (`app/sql`)

| Object | Definition | Edge policy |
|---|---|---|
| `rigs` | CMF | one row: this rig (`DEVICE_ID`) |
| `telemetry (ts, rig_id, metric, value)` | CMF hypertable, long format | 6-hour chunks, compressed after 12 h (segment by `rig_id, metric`), **90-day retention** |
| `telemetry_1m (bucket, rig_id, metric, avg, min, max)` | CMF continuous aggregate (real-time) | **no retention** — the permanent record; refreshed every minute 2 days back; compressed after 7 days |
| `events`, `connections` | CMF hypertables + replay-dedup unique indexes | 5-year retention |
| `tags (metric, label, unit, group_name, …)` | CMF | seeded from the EDR catalog and field map at start |
| `wells`, `well_runs` | CMF (`well_id` = well name) | written through from the edge well registry; `well_runs.edge_well_ref` links a run to `wells.json` |
| `well_1m` (view) | edge | `telemetry_1m_all` within each run window — the per-well 1-minute record |
| `telemetry_import`, `telemetry_imports` | edge | imported CSV/JSON history, never mixed with live data |
| `telemetry_1m_legacy`, `telemetry_1m_all` (view) | edge | 1-minute history migrated from InfluxDB for periods with no raw data |
| `app.documents (name, body jsonb, version, updated_at)` | edge | operating records, one row per former JSON file; daily backup (below) |

Differences from the CMF are deliberate: retention/compression sized for one PC,
and **no UNIQUE index on `telemetry`** (replay de-duplication is the CMF's job; a
unique violation would make Telegraf drop a whole batch).

Roles (`01-roles.sql`): `telegraf_writer` — INSERT on `telemetry` only;
`ahwr_app` — the backend (read telemetry/rollups, write derived telemetry,
events, wells/runs, tags, imports, operating records); `postgres` — schema only.

## Versions

The edge runs **PostgreSQL 18.6 + TimescaleDB 2.30.2** (both the latest releases
on 2026-10-13). The schema, rollups, policies, records store and backup/restore
were re-tested on it: all six background jobs succeed and the live pipeline
reaches 519 metrics/s. The measurements below were taken earlier on PostgreSQL
15 + TimescaleDB 2.28.3.

The CMF (`central/`) still runs `timescale/timescaledb:2.28.3-pg15`. The tables
are the same, so sync and replay are unaffected, but TimescaleDB releases after
2.28 no longer support PostgreSQL 15: move the CMF to PostgreSQL 18 when it is
next upgraded (dump and restore, or `pg_upgrade`).

Docker: the PostgreSQL 18 images keep data in `/var/lib/postgresql/18/docker`, so
the `pgdata` volume is mounted at `/var/lib/postgresql` (not `.../data`).

## Measured on the test stack (Docker Desktop, Apple Silicon)

| | |
|---|---|
| Live pipeline | 519 metrics/s from the 523-field rig map, no write errors over 29 h |
| One rig-day, 540 metrics at 1 Hz | 46.7 M rows; 7.4 GB uncompressed; 59 MB per 2.3 GB compressed (39.6×, noisy test data) |
| Expected disk use | ≈ 190 MB/day compressed → ≈ 17 GB for 90 days, plus ≤ 18 h uncompressed (≈ 5.5 GB) |
| Live view query (latest per metric, 10 s) | 17–23 ms on the current chunk |
| History: 15 min raw / 24 h from rollup | 5 ms / 27 ms (29 ms / 136 ms on compressed chunks) |
| Describe a 24 h well run; 1 h full-rate export slice | 108 ms; 352 ms |

## Deployment

### Windows, portable folder (`Start-AHWR-EDGE.ps1`)

`PG_MODE` in `settings.env` selects how PostgreSQL runs:

* `bundled` — `runtime\pgsql` holds PostgreSQL 18 for Windows (the EDB binaries
  zip) with the TimescaleDB 2.30.2 files (`timescaledb-postgresql-18-windows-amd64.zip`)
  copied into `lib` and `share\extension`. On first start the
  script runs `initdb` into `data\pgdata` (scram-sha-256, `listen_addresses =
  '127.0.0.1'`, `shared_preload_libraries = 'timescaledb'`, telemetry off), starts
  it with `pg_ctl`, and applies `app\sql` (idempotent) on every start.
  `Stop-AHWR-EDGE.ps1 -All` stops it cleanly, after the backend.
* `service` — an installed PostgreSQL service per the Edge Installation Guide;
  the script waits for it and applies `app\sql` when `PG_SUPERUSER_PASSWORD` is
  set and `psql` is found.

An InfluxDB-edition `settings.env` is upgraded in place: the script appends the
missing `DEVICE_ID` (asked once), `PG_*` and password settings and keeps the
`INFLUX_*` keys for the migration.

`Stop-AHWR-EDGE.bat` stops collection (Telegraf, BOP collector) and leaves the
dashboard and PostgreSQL running, so records can still be saved;
`Stop-AHWR-EDGE.ps1 -All` stops everything. The backend is asked to stop through
`run\backend.stop` and saves pending records before it exits.

### Windows services: start at boot, restart on failure

After a first successful start, run once in an elevated PowerShell:

```
Install-AHWR-EDGE-Services.ps1 [-ServiceUser .\svc-ahwr] [-BackupTime 02:30]
```

It needs `nssm.exe` (NSSM 2.24, win64) in `runtime\nssm\` and registers:

| Service | Runs | Depends on |
|---|---|---|
| `AHWR-PostgreSQL` | bundled PostgreSQL (`pg_ctl register`, NetworkService, data `data\pgdata`, logs `data\pgdata\log`); restarted by Windows on failure | — |
| `AHWR-Telegraf` | `telegraf.exe` with `telegraf.conf` + `telegraf.d` | PostgreSQL |
| `AHWR-Backend` | `node server.js` | PostgreSQL |
| `AHWR-BOP-Collector` | `python collector.py` | Telegraf |

With `PG_MODE=service` the installed PostgreSQL service is used instead (name
from `PG_SERVICE_NAME`, default `postgresql-x64-18`) and set to automatic start.

All services start at boot without anyone signing in and are restarted 5 s after
they stop. They run as the built-in low-privilege `LocalService` account
(`-ServiceUser` for a local account), which gets read access to the folder and
write access only to `data\app`, `logs` and `app\telegraf\telegraf.d`. Stopping a
service sends Ctrl+C and allows 15 s, so the backend flushes its records. Logs are
`logs\AHWR-*.log`, rotated at 10 MB.

The backend and the collector read `settings.env` themselves when they start
(`SETTINGS_FILE`), so secrets are not copied into the service registry and an
edited `settings.env` applies at the next service restart; Telegraf receives only
its insert-only database password. Afterwards `Start-AHWR-EDGE.bat` applies
schema upgrades, starts any stopped service and opens the dashboard;
`Remove-AHWR-EDGE-Services.ps1` returns to the portable launcher (data kept).

**Telegraf and an unreachable PLC.** Telegraf 1.29–1.31 exits when a PLC input
cannot connect at start (1.31 accepts the option below but s7comm still exits).
From **Telegraf 1.32** the backend writes `startup_error_behavior = "retry"`
into each PLC input of `plc.conf`, so Telegraf keeps running and connects when
the PLC comes up; the scripts detect the version (`TELEGRAF_STARTUP_RETRY`
overrides it). Ship Telegraf 1.32 or later in `runtime\telegraf` (tested with
1.36.4, the Docker image). Under the services an older Telegraf is restarted
every 5 s instead.

### Docker (`docker-compose.yml`)

`docker compose up -d --build` with a `.env` (see the file header). The database
is initialised by `app/sql/docker-init.sh`; the backend and Telegraf share the
`telegraf.d` volume. Telegraf is 1.36.4 with startup retry: on the test stack it
ran with the PLC unreachable and collected 519 metrics/s within 10 s of the PLC
coming up, without a restart.

### Edge Installation Guide (TimescaleDB, without Docker) — what changed

| Guide section | This implementation |
|---|---|
| 3.3 schema `raw`, one hypertable per measurement created by Telegraf | One CMF `telemetry` table in `public`. Wide per-measurement tables cannot hold this rig map: 20 PLC tag names exceed PostgreSQL's 63-byte column-name limit (longest 173 bytes), and dynamically added columns cannot feed a continuous aggregate. |
| 3.3 `well_1m` continuous aggregate | `telemetry_1m` (CMF continuous aggregate) + view `well_1m` over `well_runs` windows |
| 3.3 compress after 1 day, 1-day chunks | 6-hour chunks, compress after 12 h — a long-format rig-day is 7.4 GB uncompressed |
| 3.3 schema `app` (users, work orders, logbook, …) | Schema `app`, table `app.documents`: one JSONB row per former JSON file (the application's record format is unchanged) |
| 4.5 `01-roles.sql` creates schemas `raw`/`app` | `app/sql/01-roles.sql` + `02-schema.sql`; `telegraf_writer` gets INSERT on `telemetry` only, no CREATE |
| 5.2 `create_templates` | Telegraf only inserts (`create_templates = []`, `add_column_templates = []`, `timestamp_column_name = "ts"`, timestamptz) |
| 5.2 / 7.3 hand-edit the `rig` tag in telegraf.conf | `rig_id` is written into `plc.conf` from `DEVICE_ID`; no hand edit |
| 4.x PostgreSQL 16 | **PostgreSQL 18** (latest stable; 19 is in beta) + **TimescaleDB 2.30.2** (latest), Docker image `timescale/timescaledb:2.30.2-pg18`; Windows: PostgreSQL 18 with `timescaledb-postgresql-18-windows-amd64.zip`. TimescaleDB 2.30 supports PostgreSQL 16–18 only. |
| 8 checks: jobs per `raw` table; `SELECT max(time) FROM raw.<m>` | Jobs: `telemetry` compression + retention, `telemetry_1m` refresh + compression; fresh data: `SELECT max(ts) FROM telemetry WHERE rig_id = '<DEVICE_ID>'` |

| NSSM Windows services | `Install-AHWR-EDGE-Services.ps1` (above): same service layout, secrets read from `settings.env`, low-privilege account, daily records backup |

## Migrating InfluxDB-edition history

Run once, after the TimescaleDB edition is running (collection can continue):

```
Migrate-AHWR-EDGE-InfluxDB.ps1 [-RawDays 90] [-DryRun]
```

It starts the old `influxd` read-only on 127.0.0.1:8086 and runs
`app/backend/scripts/migrate-influx-to-timescale.js`:

1. **rollup** — raw points older than `RawDays` → 1-minute mean/min/max (computed
   inside InfluxDB) in `telemetry_1m_legacy`;
2. **raw** — the last `RawDays` at full rate → `telemetry`, mapped exactly like
   Telegraf maps live data, one transaction per hour, then `telemetry_1m` is
   refreshed for that hour;
3. **wells** — per-well archive buckets (`well_*`) for periods older than the raw
   bucket → `telemetry_1m_legacy` (re-stamped from minute end to minute start);
4. **imports** — `import_*` buckets → `telemetry_import`.

It only copies time before the first sample already in TimescaleDB (fixed on
the first run), keeps progress in `edge_migration_progress` and resumes. Expect
hours for 90 days of full-rate data (≈ 47 M rows per rig-day); use a smaller
`-RawDays` to finish sooner with older data kept at 1-minute resolution.
Restart the backend afterwards so it back-fills `well_runs` from `wells.json`.

## Backups

The telemetry is copied to the CMF; the operating records exist only here.
`Backup-AHWR-EDGE-Records.ps1` dumps `app.*`, `wells`, `well_runs`, `rigs`,
`tags` and `telemetry_imports` (`pg_dump -Fc`, as `ahwr_app`) to
`backups\records-<time>.dump` and keeps 14 days. `Install-AHWR-EDGE-Services.ps1`
schedules it daily (task "AHWR-EDGE records backup"). Copy `backups\` off the PC
with the rest of the site backups.

Restore with PostgreSQL running and the backend stopped (it holds the records in
memory), as `postgres`:

```
Stop-Service AHWR-BOP-Collector, AHWR-Backend
psql -h 127.0.0.1 -U postgres -d ahwr_edge -c "TRUNCATE app.documents, wells, well_runs, rigs, tags, telemetry_imports"
pg_restore -h 127.0.0.1 -U postgres -d ahwr_edge --data-only --disable-triggers --exit-on-error backups\records-<time>.dump
Start-Service AHWR-Backend, AHWR-BOP-Collector
```

(Tested on PostgreSQL 18.6 + TimescaleDB 2.30.2 and on 15 + 2.28.3: all
documents, wells, runs, tags and the run id sequence restored into a freshly
initialised database.)

## Operations

```sql
-- data is arriving (run as ahwr_app or postgres)
SELECT count(DISTINCT metric), max(ts) FROM telemetry WHERE rig_id = '<DEVICE_ID>' AND ts > now() - interval '1 minute';
-- background jobs healthy
SELECT j.hypertable_name, j.proc_name, s.last_run_status, s.total_failures
FROM timescaledb_information.jobs j JOIN timescaledb_information.job_stats s USING (job_id);
-- disk use and compression
SELECT pg_size_pretty(hypertable_size('telemetry'));
SELECT pg_size_pretty(sum(before_compression_total_bytes)) AS before, pg_size_pretty(sum(after_compression_total_bytes)) AS after FROM chunk_compression_stats('telemetry');
-- one well's 1-minute record
SELECT bucket, metric, avg, min, max FROM well_1m WHERE well_id = 'GS-11#4' AND metric = 'drawworks.hook_load' ORDER BY bucket;
```

Retention/chunking are `psql` variables of `02-schema.sql`
(`-v telemetry_retention='120 days'`); existing policies are not changed by a
re-run — use `remove_retention_policy`/`add_retention_policy` to change them.
