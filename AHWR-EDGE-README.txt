AHWR-EDGE — native Windows build (no Docker)
===========================================

START
1. Extract the complete AHWR-EDGE folder to a permanent location on a 64-bit Windows PC.
2. Double-click Start-AHWR-EDGE.bat.
3. On first launch, choose a local AHWR admin username/password and enter the local
   KEPServerEX OPC UA endpoint and optional credentials. Keep those credentials private.
4. Open http://localhost:8080. From another PC on the same LAN, use the LAN URL shown
   in the launcher. Allow access on Windows Firewall's Private network if prompted.

The launcher starts PostgreSQL + TimescaleDB (bundled runtime\pgsql, or an installed
PostgreSQL service when PG_MODE=service), Telegraf (Siemens S7 collector), the AHWR backend
and the VersaMax/KEPServerEX OPC UA collector. Processes run in the background; logs are in
logs\*.log and logs\*.err.log. Stop them with Stop-AHWR-EDGE.bat.

PLC CONFIGURATION
- Configure the actual S7 PLC IP/rack/slot and tag addresses in Settings > Administration.
- Configure actual KEPServerEX OPC UA Node IDs in Settings > Administration > OPC UA / BOP.
- For VersaMax credentials, set them in settings.env (KEPWARE_OPCUA_USERNAME and
  KEPWARE_OPCUA_PASSWORD), then restart using Stop-AHWR-EDGE.bat and Start-AHWR-EDGE.bat.
- The default KEPServerEX endpoint is opc.tcp://localhost:49320. Change it during first
  setup or in settings.env if the OPC UA server is on another computer.

DATA AND SECURITY
- Application configuration/users/wells are stored in data\app.
- The historian is PostgreSQL + TimescaleDB (database ahwr_edge, CMF canonical schema).
  In bundled mode its files are in data\pgdata. Back up data\app and the database
  (pg_dump, or data\pgdata while services are stopped).
- History from an InfluxDB-edition install is copied once with
  Migrate-AHWR-EDGE-InfluxDB.ps1 (needs runtime\influx and data\influx).
- settings.env contains the database passwords, JWT secret and OPC UA credentials.
  Do not share it publicly.
- Do not delete data\pgdata or data\app to update program files; those contain your data.
- Windows x64 is required.

BUILD DETAILS
Build-AHWR-EDGE.ps1 in the AHWR source project downloads the Windows PostgreSQL/TimescaleDB and
Telegraf runtimes, bundles Node.js and Python from the build PC, builds the dashboard, and assembles
this directory. Building needs internet access; the completed folder is intended to be
copied to the other PC offline.
