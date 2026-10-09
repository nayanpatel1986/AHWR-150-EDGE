# AHWR-150 EDGE

Portable edge-server application for rig monitoring and synchronization.

## Included in this repository

- Current React frontend source and production build
- Node.js backend and user-management implementation
- Telegraf S7 read-only collection configuration
- CAT ENG-1, CAT ENG-2, HPU and remaining PLC database mappings
- InfluxDB integration, startup, migration and restore tooling
- Windows start/stop and health-check scripts

## Deliberately excluded

The live `settings.env`, password records, connection credentials, device
tokens, logs, rig history, synchronization buffer and raw InfluxDB engine
directory are excluded from Git. They contain deployment secrets or live
operational data. Copy `settings.env.example` to `settings.env` and provision
unique secrets on each rig. Create users through the Administration UI or use
`data/app/users.example.json` as a schema reference.

The bundled `runtime` directory is also excluded because third-party binaries
exceed GitHub's normal file-size limits. Keep it in the secured offline transfer
image or install the matching Node.js, InfluxDB, Telegraf and Python runtimes on
the destination PC.

## First deployment

1. Copy the repository and the separately secured `runtime` directory.
2. Copy `settings.env.example` to `settings.env` and enter unique credentials.
3. Confirm the PLC address and DB mappings in Administration > S7 PLC.
4. Run `Start-AHWR-EDGE.bat`.
5. Open `http://localhost:8080` and create or verify administrator accounts.

Do not reuse `settings.env` or user databases between rigs. Each rig must have
its own Influx token, JWT secret, device token and central-server identity.

