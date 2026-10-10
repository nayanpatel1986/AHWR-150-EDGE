# AHWR-150 EDGE

Portable edge-server application for rig monitoring and synchronization to the
Central Monitoring Facility (CMF). Monitoring only: it never writes to a PLC.

## Included in this repository

- React frontend source and production build
- Node.js backend and user-management implementation
- Telegraf S7 read-only collection configuration (`app/telegraf`)
- CAT ENG-1, CAT ENG-2, HPU and remaining PLC database mappings
- TimescaleDB historian in the CMF canonical schema (`app/sql`, `docs/timescaledb.md`)
- One-time InfluxDB → TimescaleDB history migration (`Migrate-AHWR-EDGE-InfluxDB.ps1`)
- Windows start/stop/health-check scripts and a Docker stack (`docker-compose.yml`)
- WITSML interchange analysis (`docs/witsml-interchange.md`)

## Deliberately excluded

The live `settings.env`, password records, connection credentials, device
tokens, logs, rig history, synchronization buffer and database files
(`data/pgdata`, `data/influx`) are excluded from Git. They contain deployment
secrets or live operational data. Create users through the Administration UI or
use `data/app/users.example.json` as a schema reference.

The bundled `runtime` directory is also excluded because third-party binaries
exceed GitHub's normal file-size limits. Keep it in the secured offline transfer
image: `runtime\node`, `runtime\python`, `runtime\telegraf` (1.29 or later) and,
for `PG_MODE=bundled`, `runtime\pgsql` (PostgreSQL 15/16 for Windows with the
TimescaleDB files matching the CMF's version). For `PG_MODE=service`, install
PostgreSQL + TimescaleDB as described in the Edge Installation Guide instead.

## First deployment

1. Copy the repository and the separately secured `runtime` directory.
2. Run `Start-AHWR-EDGE.bat`. On first run it asks for the admin account,
   the rig `DEVICE_ID` (exactly as registered at the CMF) and the KEPServerEX
   endpoint, generates the database passwords into `settings.env`, initialises
   TimescaleDB and applies `app\sql`.
3. Confirm the PLC address and DB mappings in Administration > S7 PLC.
4. Open `http://localhost:8080` and verify the administrator account.

Upgrading an InfluxDB-edition install: run `Start-AHWR-EDGE.bat` (it adds the
new settings and keeps the old ones), then `Migrate-AHWR-EDGE-InfluxDB.ps1` once
to copy the history. See `docs/timescaledb.md`.

Do not reuse `settings.env` or user databases between rigs. Each rig must have
its own database passwords, JWT secret, device id/token and central-server identity.
