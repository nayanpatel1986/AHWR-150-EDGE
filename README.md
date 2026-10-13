# AHWR-150 EDGE

Portable edge-server application for rig monitoring and synchronization to the
Central Monitoring Facility (CMF). Monitoring only: it never writes to a PLC.

## Included in this repository

- React frontend source and production build
- Node.js backend and user-management implementation
- Telegraf S7 read-only collection configuration (`app/telegraf`)
- CAT ENG-1, CAT ENG-2, HPU and remaining PLC database mappings
- TimescaleDB historian in the CMF canonical schema, with the operating records
  in the same database (`app/sql`, `docs/timescaledb.md`)
- One-time InfluxDB → TimescaleDB history migration (`Migrate-AHWR-EDGE-InfluxDB.ps1`)
- Windows start/stop/health-check scripts, Windows services that start at boot
  and restart on failure (`Install-AHWR-EDGE-Services.ps1`), a daily records
  backup (`Backup-AHWR-EDGE-Records.ps1`) and a Docker stack (`docker-compose.yml`)
- Energistics interoperability (`docs/witsml-interchange.md`): WITSML 1.4.1.1 and
  WITSML 2.1 exports validated against the official schemas, a channel dictionary
  with Energistics units and PWLS property kinds, and an ETP v1.2 client that loads
  the CMF store without loss (Store + ChannelDataLoad) or streams as a
  ChannelStreaming producer

## Deliberately excluded

The live `settings.env`, password records, connection credentials, device
tokens, logs, rig history, synchronization buffer and database files
(`data/pgdata`, `data/influx`) are excluded from Git. They contain deployment
secrets or live operational data. Create users through the Administration UI or
use `data/app/users.example.json` as a schema reference.

The bundled `runtime` directory is also excluded because third-party binaries
exceed GitHub's normal file-size limits. Keep it in the secured offline transfer
image: `runtime\node`, `runtime\python`, `runtime\telegraf` (1.32 or later, so
Telegraf keeps retrying a PLC that is unreachable at start; 1.29+ still runs),
`runtime\nssm\nssm.exe` (NSSM 2.24, win64, for the Windows services) and, for
`PG_MODE=bundled`, `runtime\pgsql` (PostgreSQL 18 for Windows with the
TimescaleDB 2.30.2 files from `timescaledb-postgresql-18-windows-amd64.zip`).
For `PG_MODE=service`, install PostgreSQL 18 + TimescaleDB as described in the
Edge Installation Guide instead.

## First deployment

1. Copy the repository and the separately secured `runtime` directory.
2. Run `Start-AHWR-EDGE.bat`. On first run it asks for the admin account,
   the rig `DEVICE_ID` (exactly as registered at the CMF) and the KEPServerEX
   endpoint, generates the database passwords into `settings.env`, initialises
   TimescaleDB and applies `app\sql`.
3. Confirm the PLC address and DB mappings in Administration > S7 PLC.
4. Open `http://localhost:8080` and verify the administrator account.
5. Run `Install-AHWR-EDGE-Services.ps1` in an elevated PowerShell so the edge
   starts at boot, restarts after a failure and backs up its records daily
   (see `docs/timescaledb.md`).

Upgrading an InfluxDB-edition install: run `Start-AHWR-EDGE.bat` (it adds the
new settings and keeps the old ones), then `Migrate-AHWR-EDGE-InfluxDB.ps1` once
to copy the history. See `docs/timescaledb.md`.

Operating records are now stored in the database; existing JSON files in
`data\app` are imported on the first start of this version. Back up with
`Backup-AHWR-EDGE-Records.ps1` (scheduled by the services installer).

Do not reuse `settings.env` or user databases between rigs. Each rig must have
its own database passwords, JWT secret, device id/token and central-server identity.
