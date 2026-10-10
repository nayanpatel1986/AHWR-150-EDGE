-- =====================================================================
-- AHWR-150 EDGE — database, roles and extension (run as the postgres superuser)
--
--   psql -U postgres -v tg_pw="<TELEGRAF_DB_PASSWORD>" -v app_pw="<APP_DB_PASSWORD>" -f 01-roles.sql
--
-- Idempotent: re-running updates the two role passwords and re-applies grants.
-- Monitoring-only: nothing in this database is ever written back to a PLC.
-- =====================================================================
\set ON_ERROR_STOP on
\if :{?db}
\else
\set db ahwr_edge
\endif
\if :{?tg_pw}
\else
DO $$ BEGIN RAISE EXCEPTION 'pass the Telegraf writer password with -v tg_pw=...'; END $$;
\endif
\if :{?app_pw}
\else
DO $$ BEGIN RAISE EXCEPTION 'pass the application password with -v app_pw=...'; END $$;
\endif

-- telegraf_writer: Telegraf only. INSERT into telemetry, nothing else.
SELECT 'CREATE ROLE telegraf_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegraf_writer') \gexec
SELECT format('ALTER ROLE telegraf_writer WITH LOGIN PASSWORD %L', :'tg_pw') \gexec
-- PLC samples only: after a sudden power loss at most the last fraction of a
-- second of telemetry is lost; operating records keep full durability.
ALTER ROLE telegraf_writer SET synchronous_commit = off;

-- ahwr_app: the backend. Reads telemetry, writes derived metrics, events,
-- connections, wells/runs, the tag dictionary and imported history.
SELECT 'CREATE ROLE ahwr_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ahwr_app') \gexec
SELECT format('ALTER ROLE ahwr_app WITH LOGIN PASSWORD %L', :'app_pw') \gexec

SELECT format('CREATE DATABASE %I', :'db')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec

\connect :db
CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO telegraf_writer, ahwr_app', :'db') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO telegraf_writer, ahwr_app;
