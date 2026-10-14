AHWR-150 EDGE - single-click installer
======================================

Installs the AHWR-150 EDGE (TimescaleDB edition) on one edge PC: database,
data collector, application and Windows services, then checks its own work.
No internet, Docker or manual set-up of components is needed.
Monitoring only: the edge only reads from the PLC. ESD and lockout appear
only as read-only alarms.

BEFORE YOU START
 1. If this folder came as a zip: right-click the zip, Properties, tick
    Unblock, OK, then extract it (for example to C:\Install\).
 2. Fill in rig-settings.ini (Notepad). Replace every <...> value.
 3. Put the ONGC CA certificate in certs\ as ongc-ca.crt.

INSTALL
 4. Double-click Install.bat and accept the administrator prompt.
 5. Each stage shows [n/10] and OK, WARNING or FAILED. Do not close the
    window or restart the PC while it runs. At the end it shows
    INSTALLATION SUCCESSFUL and opens D:\AHWR\logs\install-report.html.
 6. Move AHWR-credentials-<DeviceId>.txt from the desktop into the asset
    password safe, then delete it.
 If a stage fails, fix what it names and run Install.bat again. A second
 run repairs an installed PC and keeps its database, records and settings.

AFTER INSTALLATION
 - From a rig-LAN machine open http://<edge PC IP>:8080, sign in as admin
   with the password from the credentials file and change it.
 - Check the PLC tags under Settings > PLC config; compare five live values
   with the rig's gauges.
 - Edge Sync page: link up, batches acknowledged, buffer near zero.
 - Tools in C:\AHWR\tools:
     Apply-Settings.bat        after editing C:\AHWR\config\rig-settings.ini
     Check-Health.bat          repeats the self-test
     Backup-Now.bat            backs up the operating records now
     Restore-Records.bat <f>   restores a records backup (replacement PC)
     Collect-Logs.bat          zips logs for support (no passwords)
     Uninstall.bat [/purge]    removes the edge; keeps D:\AHWR unless /purge
 - Updates: run Update.bat from the NEW version's installer folder. It backs
   up the records, installs, self-tests and rolls back by itself on failure.

WHAT IS WHERE
 C:\AHWR\            programs, settings.env (administrators only), tools\
 D:\AHWR\data\       database (pgdata), operating records, upload buffer
 D:\AHWR\logs\       install report, service logs
 D:\AHWR\backups\    daily records backups (02:30, last 14 kept)
 Services            AHWR-PostgreSQL, AHWR-Telegraf, AHWR-Backend, AHWR-BOP-Collector
 Ports               8080 HMI (rig LAN only); 5432, 8888, 8186 this PC only

DIFFERENCES FROM THE EDGE INSTALLATION GUIDE (9 Oct 2026)
 - PostgreSQL 18.6 with TimescaleDB 2.30.2 (the guide says PostgreSQL 16).
 - The database service is AHWR-PostgreSQL (guide: postgresql-x64-16). This
   edition has no AHWR-MCP service; its fourth service is AHWR-BOP-Collector
   (KEPServerEX OPC UA). Port 8186 (local) is used instead of 8765.
 - Services run as the built-in LocalService and NetworkService accounts, so
   there is no svc-ahwr password to manage.
 - The database is in D:\AHWR\data\pgdata. Raw data is compressed after
   12 hours and kept 90 days; 1-minute data per well is kept indefinitely.
 - rig-settings.ini has optional extra entries: [CMF] EtpUrl, [Domain]
   ViewerGroup, [BOP] and [Install] Checks.
 - If a group policy allows only signed PowerShell scripts, ask IT for an
   exception for this folder and C:\AHWR\tools.

BUNDLED COMPONENTS (components\, verified against SHA256SUMS.txt)
 PostgreSQL 18.6, EnterpriseDB binaries      PostgreSQL License
 TimescaleDB 2.30.2                          Apache 2.0 and Timescale License
 Telegraf 1.36.4                             MIT
 Node.js 22.23.3                             MIT
 Python 3.12.10 embeddable, asyncua 1.1.5    PSF; LGPL-3.0 (asyncua); MIT/BSD/Apache
 NSSM 2.24                                   public domain
 Versions, sources and checksums: components\components.json.
