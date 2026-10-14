-- =====================================================================
-- AHWR-150 EDGE — historian schema on TimescaleDB (run as postgres, in ahwr_edge)
--
--   psql -U postgres -d ahwr_edge -f 02-schema.sql
--   optional: -v telemetry_retention='90 days' -v telemetry_chunk='6 hours'
--             -v telemetry_compress_after='12 hours'
--
-- The tables shared with the Central Monitoring Facility (CMF) use the CMF's
-- canonical definitions (central/db/init.sql) column-for-column, so edge rows
-- can be copied to / compared with the CMF without transformation:
--   rigs, telemetry, telemetry_1m, events, connections, tags, wells, well_runs
-- Retention, chunking and compression are sized for a single rig PC instead.
--
-- Idempotent: safe to re-run on every upgrade.
-- Monitoring-only: nothing in this database is ever written back to a PLC.
-- =====================================================================
\set ON_ERROR_STOP on
\if :{?telemetry_retention}
\else
\set telemetry_retention '90 days'
\endif
\if :{?telemetry_chunk}
\else
\set telemetry_chunk '6 hours'
\endif
\if :{?telemetry_compress_after}
\else
\set telemetry_compress_after '12 hours'
\endif

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------
-- Rig master (CMF definition). The edge holds one row: its own DEVICE_ID.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rigs (
    rig_id          TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    section         TEXT,
    asset_unit      TEXT,
    field           TEXT,
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    commissioned_at DATE,
    device_token    TEXT,                             -- unused on the edge (kept for parity)
    schema_version  TEXT,
    status          TEXT    NOT NULL DEFAULT 'pending',
    last_data_at    TIMESTAMPTZ,
    last_seq        BIGINT,
    sync_lag_sec    INTEGER,
    health_score    INTEGER DEFAULT 0,
    metric_count    INTEGER DEFAULT 0,
    active_job      TEXT,
    active_activity TEXT,
    alarm_active    INTEGER DEFAULT 0,
    alarm_unack     INTEGER DEFAULT 0,
    alarm_p1        INTEGER DEFAULT 0,
    alarm_p2        INTEGER DEFAULT 0,
    alarm_p3        INTEGER DEFAULT 0,
    alarm_highest   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Telemetry (CMF definition, long format). metric = "measurement.field"
-- using the backend's mapped names (e.g. drawworks.hook_load); PLC tags with
-- no mapping keep their raw name under "AHWR.<tag name>". Booleans are 1/0.
-- Written by Telegraf (PLC + BOP) and by the backend (derived depth/WOB).
-- No UNIQUE index here: replay de-duplication is the CMF's job, and a unique
-- violation would make Telegraf drop a whole batch.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry (
    ts      TIMESTAMPTZ      NOT NULL,
    rig_id  TEXT             NOT NULL,
    metric  TEXT             NOT NULL,
    value   DOUBLE PRECISION NOT NULL
);
SELECT create_hypertable('telemetry', 'ts', if_not_exists => TRUE,
                         chunk_time_interval => :'telemetry_chunk'::interval);
CREATE INDEX IF NOT EXISTS telemetry_rig_metric_ts ON telemetry (rig_id, metric, ts DESC);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.hypertables
                   WHERE hypertable_name = 'telemetry' AND compression_enabled) THEN
        ALTER TABLE telemetry SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'rig_id, metric',
            timescaledb.compress_orderby   = 'ts DESC'
        );
    END IF;
END $$;
SELECT add_compression_policy('telemetry', :'telemetry_compress_after'::interval, if_not_exists => TRUE);
SELECT add_retention_policy('telemetry', :'telemetry_retention'::interval, if_not_exists => TRUE);

-- 1-minute rollup (CMF definition). On the edge it has NO retention policy: it
-- is the permanent record that outlives the raw window. Refreshing two days
-- back covers Telegraf's buffer replay after a database outage; the refresh
-- window must stay well inside the raw retention.
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 minute', ts) AS bucket,
       rig_id, metric,
       avg(value) AS avg, min(value) AS min, max(value) AS max
FROM telemetry
GROUP BY bucket, rig_id, metric
WITH NO DATA;
SELECT add_continuous_aggregate_policy('telemetry_1m',
    start_offset      => INTERVAL '2 days',
    end_offset        => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists     => TRUE);
ALTER MATERIALIZED VIEW telemetry_1m SET (timescaledb.materialized_only = false);
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM timescaledb_information.continuous_aggregates
                   WHERE view_name = 'telemetry_1m' AND compression_enabled) THEN
        ALTER MATERIALIZED VIEW telemetry_1m SET (timescaledb.compress = true);
    END IF;
END $$;
SELECT add_compression_policy('telemetry_1m', compress_after => INTERVAL '7 days', if_not_exists => TRUE);

-- ---------------------------------------------------------------------
-- Events and connection records (CMF definitions). The backend writes the
-- same events it queues for the CMF (alarm, connection, well.*, ...).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id       BIGSERIAL,
    ts       TIMESTAMPTZ NOT NULL,
    rig_id   TEXT        NOT NULL,
    type     TEXT        NOT NULL,
    payload  JSONB       NOT NULL DEFAULT '{}'::jsonb
);
SELECT create_hypertable('events', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '7 days');
CREATE INDEX IF NOT EXISTS events_rig_ts  ON events (rig_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_type_ts ON events (type, ts DESC);
CREATE UNIQUE INDEX IF NOT EXISTS events_rig_ts_type_uniq
    ON events (rig_id, ts, type, md5(payload::text));
SELECT add_retention_policy('events', INTERVAL '5 years', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS connections (
    id          BIGSERIAL,
    ts          TIMESTAMPTZ NOT NULL,
    rig_id      TEXT NOT NULL,
    peak_torque DOUBLE PRECISION,
    result      TEXT,
    joint       INTEGER,
    payload     JSONB,
    PRIMARY KEY (id, ts)
);
SELECT create_hypertable('connections', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '7 days');
CREATE INDEX IF NOT EXISTS connections_rig_ts ON connections (rig_id, ts DESC);
CREATE UNIQUE INDEX IF NOT EXISTS connections_rig_ts_uniq
    ON connections (rig_id, ts, md5(payload::text));
SELECT add_retention_policy('connections', INTERVAL '5 years', if_not_exists => TRUE);

-- ---------------------------------------------------------------------
-- Tag dictionary (CMF definition): label/unit/group for each metric.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
    metric        TEXT PRIMARY KEY,
    label         TEXT,
    unit          TEXT,
    group_name    TEXT,
    sample_hz     DOUBLE PRECISION DEFAULT 1,
    expected      BOOLEAN DEFAULT TRUE
);

-- ---------------------------------------------------------------------
-- Wells and runs (CMF definitions). well_id = well name, as at the CMF.
-- A run is this rig working a well over [started_at, ended_at).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wells (
    well_id        TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    uwi            TEXT,
    well_type      TEXT,
    status         TEXT NOT NULL DEFAULT 'planned',
    field          TEXT,
    asset_unit     TEXT,
    latitude       DOUBLE PRECISION,
    longitude      DOUBLE PRECISION,
    spud_date      DATE,
    td_date        DATE,
    total_depth    DOUBLE PRECISION,
    operator       TEXT,
    block_lease    TEXT,
    current_rig_id TEXT REFERENCES rigs(rig_id) ON DELETE SET NULL,
    notes          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS well_runs (
    id          BIGSERIAL PRIMARY KEY,
    well_id     TEXT REFERENCES wells(well_id) ON DELETE CASCADE,
    rig_id      TEXT REFERENCES rigs(rig_id) ON DELETE SET NULL,
    job_no      TEXT,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at    TIMESTAMPTZ,
    summary     TEXT
);
CREATE INDEX IF NOT EXISTS well_runs_well ON well_runs (well_id, started_at DESC);
CREATE INDEX IF NOT EXISTS well_runs_rig_active ON well_runs (rig_id) WHERE ended_at IS NULL;
-- Edge-only: link a run to the edge well record that created it.
ALTER TABLE well_runs ADD COLUMN IF NOT EXISTS edge_well_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS well_runs_edge_ref ON well_runs (edge_well_ref) WHERE edge_well_ref IS NOT NULL;

-- ---------------------------------------------------------------------
-- Edge-only tables
-- ---------------------------------------------------------------------
-- History imported from exported CSV/JSON files. Kept apart from live telemetry.
CREATE TABLE IF NOT EXISTS telemetry_import (
    ts           TIMESTAMPTZ      NOT NULL,
    import_label TEXT             NOT NULL,
    rig_id       TEXT,
    metric       TEXT             NOT NULL,
    value        DOUBLE PRECISION NOT NULL
);
SELECT create_hypertable('telemetry_import', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '30 days');
CREATE INDEX IF NOT EXISTS telemetry_import_label_metric_ts ON telemetry_import (import_label, metric, ts DESC);

CREATE TABLE IF NOT EXISTS telemetry_imports (
    import_label TEXT PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    rows_in      INTEGER,
    points       INTEGER,
    first_ts     TIMESTAMPTZ,
    last_ts      TIMESTAMPTZ
);

-- 1-minute history migrated from InfluxDB for periods whose raw samples no
-- longer exist (older than the raw window, or InfluxDB per-well archives).
-- Same columns as telemetry_1m; never overlaps periods covered by telemetry.
CREATE TABLE IF NOT EXISTS telemetry_1m_legacy (
    bucket  TIMESTAMPTZ NOT NULL,
    rig_id  TEXT        NOT NULL,
    metric  TEXT        NOT NULL,
    avg     DOUBLE PRECISION,
    min     DOUBLE PRECISION,
    max     DOUBLE PRECISION,
    source  TEXT
);
SELECT create_hypertable('telemetry_1m_legacy', 'bucket', if_not_exists => TRUE, chunk_time_interval => INTERVAL '30 days');
CREATE UNIQUE INDEX IF NOT EXISTS telemetry_1m_legacy_uniq ON telemetry_1m_legacy (rig_id, metric, bucket);

-- All 1-minute history (rollup + migrated legacy), and the same per well run.
CREATE OR REPLACE VIEW telemetry_1m_all AS
    SELECT bucket, rig_id, metric, avg, min, max FROM telemetry_1m
    UNION ALL
    SELECT bucket, rig_id, metric, avg, min, max FROM telemetry_1m_legacy;

CREATE OR REPLACE VIEW well_1m AS
    SELECT r.id AS run_id, r.well_id, r.job_no, a.bucket, a.rig_id, a.metric, a.avg, a.min, a.max
    FROM well_runs r
    JOIN telemetry_1m_all a
      ON a.rig_id = r.rig_id
     AND a.bucket >= r.started_at
     AND a.bucket <  COALESCE(r.ended_at, 'infinity'::timestamptz);

-- ---------------------------------------------------------------------
-- Energistics identity (WITSML 2.1 / ETP v1.2). Name-based UUIDs computed the
-- same way at the edge and the CMF (backend lib/ids.js), stored for lookup.
-- channels: one row per recorded metric with the metadata a WITSML 2.1 Channel
-- and an ETP ChannelMetadataRecord need (mnemonic, Energistics unit of the
-- presented values, PWLS property kind). Same table at the CMF, all rigs.
-- ---------------------------------------------------------------------
ALTER TABLE rigs ADD COLUMN IF NOT EXISTS uuid UUID UNIQUE;
ALTER TABLE wells ADD COLUMN IF NOT EXISTS uuid UUID UNIQUE;
ALTER TABLE well_runs ADD COLUMN IF NOT EXISTS uuid UUID UNIQUE;

CREATE TABLE IF NOT EXISTS wellbores (
    uuid        UUID PRIMARY KEY,
    well_id     TEXT NOT NULL REFERENCES wells(well_id) ON DELETE CASCADE ON UPDATE CASCADE,
    name        TEXT NOT NULL,
    number      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (well_id, name)
);

CREATE TABLE IF NOT EXISTS channels (
    rig_id             TEXT NOT NULL,
    metric             TEXT NOT NULL,
    uuid               UUID NOT NULL UNIQUE,
    mnemonic           TEXT NOT NULL,
    label              TEXT,
    group_name         TEXT,
    stored_unit        TEXT,                              -- unit of the values in telemetry
    uom                TEXT NOT NULL,                     -- Energistics unit of presented values
    factor             DOUBLE PRECISION NOT NULL DEFAULT 1, -- presented = stored * factor
    data_kind          TEXT NOT NULL DEFAULT 'double',
    property_kind_uuid UUID NOT NULL,                     -- Energistics PWLS property kind
    property_kind      TEXT NOT NULL,
    unit_source        TEXT,
    logging_company    TEXT,                              -- WITSML Channel LoggingCompany (default: the rig)                              -- how the unit was determined
    first_ts           TIMESTAMPTZ,                       -- data extent in telemetry (maintained
    last_ts            TIMESTAMPTZ,                       --   by the backend; NULL = no data)
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (rig_id, metric)
);
-- Columns added after the table first shipped (idempotent upgrades).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS logging_company TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS first_ts TIMESTAMPTZ;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS last_ts TIMESTAMPTZ;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------
-- Operating records (schema app): users, work orders, logbook, calibrations,
-- alarm settings/events, well registry, dashboard layout, sync state, ...
-- One JSON document per record set (lib/persist.js), loaded into memory by
-- the backend at start and written back in order. Plain tables: backed up with
-- pg_dump (Backup-AHWR-EDGE-Records.ps1).
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;
CREATE TABLE IF NOT EXISTS app.documents (
    name       TEXT PRIMARY KEY,                 -- e.g. users.json, cmms_work_orders.json
    body       JSONB NOT NULL,
    version    BIGINT NOT NULL DEFAULT 1,        -- incremented on every write
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration bookkeeping (InfluxDB -> TimescaleDB tool) and schema version.
CREATE TABLE IF NOT EXISTS edge_migration_progress (
    source      TEXT PRIMARY KEY,
    done_until  TIMESTAMPTZ,
    rows_copied BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS edge_schema (
    version    INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO edge_schema (version) VALUES (1), (2), (3) ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Least-privilege grants
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO telegraf_writer, ahwr_app;
GRANT INSERT ON telemetry TO telegraf_writer;

GRANT SELECT, INSERT ON telemetry TO ahwr_app;
GRANT SELECT ON telemetry_1m, telemetry_1m_legacy, telemetry_1m_all, well_1m TO ahwr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    rigs, events, connections, tags, wells, well_runs, wellbores, channels,
    telemetry_import, telemetry_imports
    TO ahwr_app;
GRANT SELECT ON edge_schema, edge_migration_progress TO ahwr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ahwr_app;
GRANT USAGE ON SCHEMA app TO ahwr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.documents TO ahwr_app;
