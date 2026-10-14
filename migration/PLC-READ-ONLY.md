# Rig PLC read-only collection

Checked 2026-10-03.

The project uses Telegraf 1.29.5 inputs.s7comm to read Siemens DB addresses.
The matching upstream plugin collects data using AGReadMulti; its configuration
exposes no PLC-write operation and no read_only switch.

Startup loads app/telegraf/telegraf.conf and the .conf files in
app/telegraf/telegraf.d. The plugins are the S7 and internal inputs, a loopback
InfluxDB-protocol listener for the BOP collector, the Starlark telemetry-mapping
processor, the TimescaleDB (PostgreSQL) historian output and localhost health
output. (Updated for the TimescaleDB edition.) Command-named tags such as CMD_Start are read, not executed.
The backend S7 configuration API edits local read mappings; it does not
connect to the PLC to write values.

The added comments document existing behavior. They do not create a security
boundary or hardware write lock. Restricting writes by other software or users
requires protection enforced by the PLC or an appropriately configured
industrial gateway. No PLC program, DB values, access permissions, or network
policy were changed. No live PLC probe or collector start was used for this check.

Version-matched source:
https://github.com/influxdata/telegraf/blob/v1.29.5/plugins/inputs/s7comm/s7comm.go
