# TimescaleDB historian (CMF canonical schema)

The edge historian is PostgreSQL + TimescaleDB, database `ahwr_edge`. It stores
data in the **same tables and columns as the Central Monitoring Facility (CMF)**
(`central/db/init.sql`), so edge rows can be copied to, replayed into or compared
with the CMF without transformation. InfluxDB is no longer used at run time; a
one-time tool migrates its history.

Monitoring-only is unchanged: nothing in the database, Telegraf or the backend
writes to a PLC.

## Data flow

```
S7 / Modbus PLC ──read──▶ Telegraf ──(Starlark: tag → CMF metric)──▶ telemetry ◀── backend: derived depth/WOB
VersaMax BOP (OPC UA) ─▶ collector.py ─▶ Telegraf :8186 (loopback) ─┘          │
                                                                                ├─▶ telemetry_1m (1-minute rollup, kept forever)
backend: alarms, connections, well lifecycle ─▶ events, connections, wells, well_runs
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
  protocol to Telegraf's loopback listener (`TELEGRAF_LISTENER_URL`).

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

Differences from the CMF are deliberate: retention/compression sized for one PC,
and **no UNIQUE index on `telemetry`** (replay de-duplication is the CMF's job; a
unique violation would make Telegraf drop a whole batch).

Roles (`01-roles.sql`): `telegraf_writer` — INSERT on `telemetry` only;
`ahwr_app` — the backend (read telemetry/rollups, write derived telemetry,
events, wells/runs, tags, imports); `postgres` — schema only.

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

* `bundled` — `runtime\pgsql` holds PostgreSQL 15/16 for Windows with the
  TimescaleDB files copied into `lib` and `share\extension`. On first start the
  script runs `initdb` into `data\pgdata` (scram-sha-256, `listen_addresses =
  '127.0.0.1'`, `shared_preload_libraries = 'timescaledb'`, telemetry off), starts
  it with `pg_ctl`, and applies `app\sql` (idempotent) on every start.
  `Stop-AHWR-EDGE.ps1` stops it cleanly.
* `service` — an installed PostgreSQL service per the Edge Installation Guide;
  the script waits for it and applies `app\sql` when `PG_SUPERUSER_PASSWORD` is
  set and `psql` is found.

An InfluxDB-edition `settings.env` is upgraded in place: the script appends the
missing `DEVICE_ID` (asked once), `PG_*` and password settings and keeps the
`INFLUX_*` keys for the migration.

### Docker (`docker-compose.yml`)

`docker compose up -d --build` with a `.env` (see the file header). The database
is initialised by `app/sql/docker-init.sh`; the backend and Telegraf share the
`telegraf.d` volume.

### Edge Installation Guide (TimescaleDB, without Docker) — what changed

| Guide section | This implementation |
|---|---|
| 3.3 schema `raw`, one hypertable per measurement created by Telegraf | One CMF `telemetry` table in `public`. Wide per-measurement tables cannot hold this rig map: 20 PLC tag names exceed PostgreSQL's 63-byte column-name limit (longest 173 bytes), and dynamically added columns cannot feed a continuous aggregate. |
| 3.3 `well_1m` continuous aggregate | `telemetry_1m` (CMF continuous aggregate) + view `well_1m` over `well_runs` windows |
| 3.3 compress after 1 day, 1-day chunks | 6-hour chunks, compress after 12 h — a long-format rig-day is 7.4 GB uncompressed |
| 3.3 schema `app` (users, work orders, logbook, …) | **Not yet**: operating records are still JSON files in `DATA_DIR`. Back up `DATA_DIR` as well as the database. |
| 4.5 `01-roles.sql` creates schemas `raw`/`app` | `app/sql/01-roles.sql` + `02-schema.sql`; `telegraf_writer` gets INSERT on `telemetry` only, no CREATE |
| 5.2 `create_templates` | Telegraf only inserts (`create_templates = []`, `add_column_templates = []`, `timestamp_column_name = "ts"`, timestamptz) |
| 5.2 / 7.3 hand-edit the `rig` tag in telegraf.conf | `rig_id` is written into `plc.conf` from `DEVICE_ID`; no hand edit |
| 4.x PostgreSQL 16 | Tested on PostgreSQL 15 + TimescaleDB 2.28.3 (the CMF's versions); match the CMF's TimescaleDB version |
| 8 checks: jobs per `raw` table; `SELECT max(time) FROM raw.<m>` | Jobs: `telemetry` compression + retention, `telemetry_1m` refresh + compression; fresh data: `SELECT max(ts) FROM telemetry WHERE rig_id = '<DEVICE_ID>'` |

Telegraf 1.29.5 exits if the PLC is unreachable when it starts; under the
guide's NSSM services it is restarted automatically, under the portable launcher
it is not.

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
