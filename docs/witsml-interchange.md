# What this edge's data can be exchanged as WITSML

Scope: which data held by the AHWR-150 edge (TimescaleDB historian + operating
records) can be represented in Energistics WITSML for exchange with operators,
service companies and the CMF, which WITSML object fits each, what the
`/api/witsml/*` export produces, and the edge's ETP v1.2 publisher. Element names
marked *verify* in the mapping table are for objects the edge does not export yet.

## Versions to target

| Standard | Status | Notes |
|---|---|---|
| WITSML **1.4.1.1** | last 1.x release; 27 data objects; SOAP store API (`WMLS_*`) | still the most widely deployed in drilling contractors' and operators' stores |
| WITSML **2.1** (May 2022) | current; new development should target it | objects are top-level with UUIDs; Log → Log + ChannelSet + Channel; carried over ETP |
| ETP **v1.2** (Sept 2021) | latest ETP release; the API for WITSML 2.1 | WebSocket + Avro; **not** backward-compatible with ETP v1.1. Production implementations must use binary Avro; JSON encoding is for internal testing and debugging only (v1.2 spec, §3.8) |

There is no "ETP 2.0" or "ETP 2.2": v1.2 is the current ETP release. The edge
publisher and its screen were labelled "ETP 2.0" and sent hand-made JSON; they now
implement ETP v1.2 (below).

Recommendation: export **WITSML 1.4.1.1 files** (wells, wellbores, logs,
messages, opsReports) from the edge for offline hand-over, and let the **CMF**
serve WITSML 2.1 / ETP v1.2 to external consumers from its TimescaleDB (its
`crmf-etp-witsml` contract), since the edge now stores the same telemetry model.

## Mapping

Legend: ✅ fits directly · 🟡 fits with mapping or extra data · ❌ no WITSML home

| Edge data (where it lives) | WITSML 1.4.1.1 | WITSML 2.1 | Fit | Notes |
|---|---|---|---|---|
| Well registry: name, UWI, field, operator, country, location, spud date, planned TD, status (`wells.json`, `wells`) | `well` | Well | ✅ | name, field, country, operator, spud date, status map directly; UWI to the government/API number field (*verify*). Today `jobNo` is wrongly written to `numLicense` (the licence number). |
| The hole being worked (bit/hole depth) | `wellbore` (separate object, `uidWell` reference) | Wellbore | 🟡 | The edge has no wellbore entity: one wellbore per well is a safe default; current measured depth = `drilling.hole_depth`. |
| Rig on a well over time (`well_runs`: rig, job no, start/end) | `rig` linked to the wellbore, with operating dates (*verify*) | Rig + **RigUtilization** | ✅ (2.1) | RigUtilization is exactly a well run. |
| Rig equipment: BOP stack (annular, pipe/blind/shear rams), mud pumps, top drive (HTD), engines, HPU | `rig` (BOP + BOP components, pumps, top-drive fields) | Rig | 🟡 | WITSML expects static ratings (sizes, working pressures, pump liners/strokes) that the edge does not store; must be entered once per rig. |
| 1 Hz telemetry, ≈ 540 channels (`telemetry`) | `log`, time-indexed, one `logCurveInfo` per channel | Log + ChannelSet + Channel; live via ETP ChannelStreaming | ✅ | Numeric channels map 1:1. PLC bits are 0/1 numeric curves. Channel label/unit come from the `tags` table. 523 PLC tags → split into logs per equipment group (drilling, pumps, well control, HTD, PCT/CWK, CAT engines, HPU) to keep logs manageable. |
| 1-minute mean/min/max (`telemetry_1m`, `well_1m`) | `log` (time-indexed, 60 s interval, three curves per channel) | Log/ChannelSet | ✅ | The natural hand-over format for a completed well. |
| Activity / NPT log (activity code, start/end, duration, productive vs NPT, depth) | `opsReport` activities; `drillReport` activities for regulator DDRs | OpsReport, DrillReport | 🟡 | App codes (DRILLING, TRIP_IN, MAKE_UP, FISHING …) are proprietary: map to IADC/operator codes and send the app code as the proprietary code. |
| Daily report header and totals (well, rig, operator, job, depth, productive/NPT hours) | `opsReport` | OpsReport | ✅ | One report per 24 h period. |
| Fuel and engine hours per well (`cat_engine.total_fuel`, `run_hours`) | `opsReport` daily fields where the schema has them (*verify*), else log curves | OpsReport | 🟡 | Totaliser deltas per day are already computed for the well report. |
| Pump operation (SPM, pressure, flow) | log curves + `opsReport` pump operations section (*verify*) | Log / OpsReport | ✅ | |
| Pit / trip-tank volumes, gain/loss, flow in/out | log curves | Log | ✅ | Mud properties (density, rheology) are not measured by the edge, so `fluidsReport` does not apply unless mud checks are added. |
| Well control: ram states, accumulator/manifold/annular pressures (live) | log curves | Log | ✅ | |
| Well-control incidents, BOP tests, kill sheet | `opsReport` HSE / control-incident sections (*verify*) | OpsReport (HSE events) | 🟡 | The edge records alarms but not incident or BOP-test records; the kill sheet is a calculator, not stored data. |
| Alarms and events (raise/ack/return-to-normal, priority, value vs limit) (`events`) | **`message`** (type alarm/event/warning, time, depth, severity, text) | — not in the 2.0 object mapping | ✅ / ❌ | Clean fit in 1.4.1.1. In 2.x carry alarms in OpsReport HSE events, as ETP notifications, or as an extension. |
| Connections / torque-turn (joint no., peak torque, duration, PASS/FAIL, torque samples) (`connections`) | — | — | ❌ / 🟡 | No WITSML object for make-up results. Store each make-up's torque samples as a short log (elapsed-time index) or an `attachment`; the joint tally and string description belong in `tubular`. |
| String run (joints, string make-up) | `tubular`; `bhaRun` for fishing/workover BHAs | Tubular, BhaRun | 🟡 | The edge counts joints but does not hold component specs (OD/ID, grade, length). |
| Fishing jobs | `opsReport` activities + `bhaRun`/`tubular` for the fishing string | same | 🟡 | No fishing-specific object. |
| Completion equipment touched by a workover | completion objects (1.4.1.x) | WellCompletion / WellboreCompletion | ❌ today | The edge does not record completion components. |
| Maintenance / CMMS (work orders, overhauls, PM, run hours, calibration, downtime) | — | — | ❌ | Outside WITSML. Run hours can be log curves; maintenance records fit ISO 14224 (reliability data) or the CMF `maintenance_record` table. |
| Users, roles, dashboards, sync state | — | — | ❌ | Not well-site data. |

## Units

Map app units to Energistics UOM symbols when exporting:

| App unit | Energistics symbol | Note |
|---|---|---|
| t (tonne-force: hook load, WOB) | `Mgf` | megagram-force = 1 metric tonne-force; there is no bare `tonf` (only `tonf[US]`, `tonf[UK]`) |
| daN·m (torque) | `daN.m` | |
| bar, psi | `bar`, `psi` | confirm SPP's source unit first (see below) |
| rpm | `rpm` | |
| m, mm, m/h | `m`, `mm`, `m/h` | |
| m³, L/min, L/h | `m3`, `L/min`, `L/h` | |
| °C | `degC` | |
| % | `%` | |
| spm (pump strokes/min) | *verify* | pick the UOM-dictionary rate symbol used by the target store |

## WITSML 1.4.1.1 export (`lib/witsml.js`, `/api/witsml/*`)

All endpoints need a signed-in user; `?well=<id>` selects a well from the registry
(default: the active well).

| Endpoint | Object | Content |
|---|---|---|
| `/api/witsml/well` | `wells` | name, government number (UWI), field, country, time zone, operator, spud date, status (`working over` while the well is active) |
| `/api/witsml/wellbore` | `wellbores` | separate object, `uidWell` reference, uid `<well uid>-wb1`; measured depth, bit depth and planned depth in `m` |
| `/api/witsml/log` | `logs` | time-indexed log from TimescaleDB: `tier=raw` (`telemetry`) or `tier=1m` (`telemetry_1m`; `envelope=1` adds min/max curves); window `start`/`stop`, the well's run when `well` is given, else the last `minutes` (1–60, default 2); `metrics=a,b` or the 22 headline channels; at most `WITSML_MAX_ROWS` rows (default 50 000) |
| `/api/witsml/messages` | `messages` | alarm history (raise/ack/clear) as `alarm`/`event` messages; P1 → `major`, P2/P3 → `minor`; `limit` ≤ 5000 |
| `/api/witsml/opsreport` | `opsReports` | one day (`date=YYYY-MM-DD`): activities with start/end/duration, `planned` vs `downtime` class, the app activity code as `proprietaryCode` (naming system `AHWR-EDGE`), job number as `numAFE`, 24-hour totals |

What changed from the earlier export: the wellbore is its own object and no
longer the rig; the job number is no longer written to the licence number;
units are Energistics symbols — hook load/WOB `Mgf` (tonne-force), block
position `mm`, torque `daN.m`; no invented defaults (`ONGC`, `Ankleshwar`);
logs read any window from TimescaleDB instead of a 10-minute memory ring; any
channel can be exported. Headline channels use standard mnemonics (HKLA, BPOS,
WOBA, ROPA, DMEA, DBTM, RPMA, TQA, STQA, SPPA, SPMT, MFIA, MFOP, TVA, TVGL, TTVA,
TBGP, CSGP, WHP, ACCP, MANP, ANNP); other metrics get a unique mnemonic of at most
32 characters derived from the metric name.

Every document type is validated against the official WITSML 1.4.1.1 XSDs in
`test/witsml.test.cjs` when `WITSML_XSD_DIR` points at the schemas (the earlier
export fails that validation).

Data-quality item to settle before any exchange: standpipe pressure comes from
the PLC tag `SPP-Bar` but the EDR catalog labels `mudpump.pressure` as **psi**,
and the export follows the catalog. Confirm the unit in the PLC program and make
the catalog, the `tags` table and the export agree.

## ETP v1.2 publisher (`lib/etp.js`)

The edge can stream live telemetry to an ETP v1.2 store (Settings > Edge Sync >
ETP; `ETP_ENABLED`, `ETP_URL`, `ETP_STREAM_SECONDS`). It is a **ChannelStreaming
(Protocol 1) producer**:

* WebSocket subprotocol `etp12.energistics.org`, header `etp-encoding: binary`;
  messages are binary Avro encoded with the official v1.2 schemas
  (`lib/etp12/schemas.json`, extracted from the Apache-2.0 `etptypes` package
  by `test/tools/etp12-extract-schemas.py`). `wss://` is required except on
  loopback or with `ALLOW_INSECURE_TRANSPORT=true`.
* Session: `RequestSession` asking for Protocol 1 with the server in the
  `consumer` role → `OpenSession`; non-zero, even, increasing message ids; the
  FIN flag on every message; `Ping` is answered with `Pong`; `CloseSession` on
  disconnect.
* Streaming starts when the consumer sends `StartStreaming`: `ChannelMetadata`
  (one channel per metric, deterministic name-based UUIDs, the WITSML mnemonic as
  channel name, Energistics units, time index in UTC microseconds) and then
  `ChannelData` every `ETP_STREAM_SECONDS`. New metrics are announced before
  their first value; `StopStreaming` stops it.
* Read-only by design: the edge produces data and never accepts writes.

Conformance: an independent consumer written against the same schemas with
`fastavro` (`test/tools/etp12-consumer.py`) checks the session, ids, flags,
metadata-before-data and every value; against the test stack it received 544
channels and 3 264 points with no violations. `test/etp.test.cjs` covers the same
sequence in CI. Testing against a commercial ETP v1.2 store is still advisable
before production use.

## Suggested next steps

1. Fill the `tags` table with the standard mnemonic per metric so the CMF and
   the edge exports use the same names.
2. WITSML 2.1 objects and ETP Store/Discovery protocols for external consumers
   belong at the CMF, which holds the same telemetry model for all rigs.
3. Rig equipment ratings (BOP, pumps, top drive) and string components would
   allow `rig`, `tubular` and `bhaRun` exports; they are not stored today.

## Sources

* [WITSML v1.4.1.1 data schema overview](https://energistics.org/sites/default/files/witsml_data_schema_overview.html)
* [WITSML 2.0: data object mapping from v1.4.1.1](https://docs.energistics.org/WITSML/WITSML_TOPICS/WITSML-000-015-0-C-sv2000.html)
* [WITSML 2.0: Ops Report](https://docs.energistics.org/WITSML/WITSML_TOPICS/WITSML-000-149-0-C-sv2000.html) and [Drill Report](https://docs.energistics.org/WITSML/WITSML_TOPICS/WITSML-000-146-0-C-sv2000.html) data objects
* [WITSML 2.0: Log data object](https://docs.energistics.org/WITSML/WITSML_TOPICS/WITSML-000-048-0-C-sv2000.html)
* [ETP v1.2 release announcement](https://energistics.org/node/383) and the ETP v1.2 specification (Energistics, 2021)
* [etptypes 1.2.0](https://pypi.org/project/etptypes/) (Geosiris, Apache-2.0): the ETP v1.2 Avro schemas used by the edge
* [ETP Avro serialization (binary and JSON encodings)](https://docs.energistics.org/ETP/ETP_TOPICS/ETP-000-012-0-C-sv1100.html)
* [Energistics common: ForceUom](https://docs.energistics.org/COM/COM_TOPICS/COM-000-630-0-R-sv2100.html), [MomentOfForceUom](https://docs.energistics.org/COM/COM_TOPICS/COM-000-732-0-R-sv2100.html), [AngularVelocityUom](https://docs.energistics.org/COM/COM_TOPICS/COM-000-532-0-R-sv2100.html)
