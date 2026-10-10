# What this edge's data can be exchanged as WITSML

Scope: which data held by the AHWR-150 edge (TimescaleDB historian + operating
records) can be represented in Energistics WITSML for exchange with operators,
service companies and the CMF, which WITSML object fits each, and what the
current `/api/witsml/*` export gets wrong. Element names marked *verify* should
be checked against the XSDs before implementation.

## Versions to target

| Standard | Status | Notes |
|---|---|---|
| WITSML **1.4.1.1** | last 1.x release; 27 data objects; SOAP store API (`WMLS_*`) | still the most widely deployed in drilling contractors' and operators' stores |
| WITSML **2.1** (May 2022) | current; new development should target it | objects are top-level with UUIDs; Log → Log + ChannelSet + Channel; carried over ETP |
| ETP **v1.2** (Sept 2021) | the API for WITSML 2.1 | WebSocket + Avro; **not** backward-compatible with ETP v1.1. Binary Avro is the default encoding; JSON is optional and not every server supports it (stated for v1.1 — confirm in the v1.2 spec) |

There is no "ETP 2.0". The edge publisher (`lib/etp.js`) and the CMF
standards note call it that, but use the `etp12.energistics.org` subprotocol with
hand-made JSON messages: it should be named ETP v1.2 and conformance-tested
against a real ETP v1.2 server before anyone relies on it.

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

## Problems in the current export (`lib/witsml.js`, `/api/witsml/*`)

1. `<wellbore>` is nested inside `<well>`. In 1.4.1.1 a wellbore is its own object
   that references its well (`uidWell`), so the `wells` document is not
   schema-valid.
2. The wellbore uid and name are the **rig** name.
3. `jobNo` is written to `numLicense` (the well licence number).
4. Wrong units on three of eleven channels: block position is exported as `ft`
   but stored in mm; torque as `N.m` but stored in daN·m; hook load/WOB as `t`,
   which is not an Energistics symbol (`Mgf`).
5. Hard-coded defaults (`ONGC`, `Ankleshwar`) appear when fields are empty.
6. The log comes from an in-memory ring (≤ 10 minutes); with TimescaleDB it can
   cover any window, or a whole well from `well_1m`.
7. Only 11 channels.

Data-quality item to settle before any exchange: standpipe pressure comes from
the PLC tag `SPP-Bar` but the EDR catalog labels `mudpump.pressure` as **psi**,
and the export labels it **bar**. Confirm the unit in the PLC program and make
the catalog, the `tags` table and the export agree.

## Suggested next steps

1. Fix the export: separate `wellbores` document, wellbore ≠ rig, correct units
   (`Mgf`, `mm`, `daN.m`), no invented defaults; read logs from TimescaleDB
   (`telemetry` for raw, `well_1m` for a well) and validate the output against
   the WITSML 1.4.1.1 XSDs in a test.
2. Add `message` export from `events` and an `opsReport` per day from the
   activity log, daily report and fuel deltas.
3. Fill the `tags` table with a standard mnemonic per metric (e.g. HKLD, WOB,
   SPPA, DBTM, DMEA, ROPA, TQA, RPMA, SPM1, TVA) so every export uses the same
   names as the CMF.
4. Leave WITSML 2.1 / ETP v1.2 serving to the CMF; rename and conformance-test the
   edge ETP publisher, or retire it in favour of the CMF sync.

## Sources

* [WITSML v1.4.1.1 data schema overview](https://energistics.org/sites/default/files/witsml_data_schema_overview.html)
* [WITSML 2.0: data object mapping from v1.4.1.1](https://docs.energistics.org/WITSML/WITSML_TOPICS/WITSML-000-015-0-C-sv2000.html)
* [WITSML 2.0: Ops Report](https://docs.energistics.org/WITSML/WITSML_TOPICS/WITSML-000-149-0-C-sv2000.html) and [Drill Report](https://docs.energistics.org/WITSML/WITSML_TOPICS/WITSML-000-146-0-C-sv2000.html) data objects
* [WITSML 2.0: Log data object](https://docs.energistics.org/WITSML/WITSML_TOPICS/WITSML-000-048-0-C-sv2000.html)
* [ETP v1.2 release announcement](https://energistics.org/node/383)
* [ETP Avro serialization (binary and JSON encodings)](https://docs.energistics.org/ETP/ETP_TOPICS/ETP-000-012-0-C-sv1100.html)
* [Energistics common: ForceUom](https://docs.energistics.org/COM/COM_TOPICS/COM-000-630-0-R-sv2100.html), [MomentOfForceUom](https://docs.energistics.org/COM/COM_TOPICS/COM-000-732-0-R-sv2100.html), [AngularVelocityUom](https://docs.energistics.org/COM/COM_TOPICS/COM-000-532-0-R-sv2100.html)
