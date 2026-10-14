# What this edge's data can be exchanged as WITSML

Scope: which data held by the AHWR-150 edge (TimescaleDB historian + operating
records) can be represented in Energistics WITSML for exchange with operators,
service companies and the CMF, which WITSML object fits each, what the WITSML
1.4.1.1 and 2.1 exports produce, and the edge's ETP v1.2 client. Element names
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

How the pieces fit:

* The edge keeps the Energistics **identity** of everything it records (below) and
  exports **WITSML 1.4.1.1** files (wells, wellbores, logs, messages, opsReports)
  and **WITSML 2.1** objects for offline hand-over.
* The edge **loads the CMF** over ETP v1.2 (Store + ChannelDataLoad, lossless) and/or
  the HTTP sync, which now carries the channel dictionary.
* The **CMF** serves WITSML 2.1 over ETP v1.2 to external consumers
  (`central/etp-witsml`: Discovery, Store, ChannelSubscribe, ChannelDataFrame).

## Energistics identity and channel metadata (`lib/ids.js`, `lib/channels.js`)

Every object has an RFC 4122 version-5 UUID computed the same way at the edge and
the CMF, so both refer to the same rig, well, run and channel without exchanging
identifiers: `uuid5(NAMESPACE, "<kind>:<key>")`, NAMESPACE =
`uuid5(NAMESPACE_URL, "urn:ahwr:energyml")` = `0c778a8a-d94f-55c2-9951-37777e6d4d11`;
keys: `rig:<rig>`, `well:<well>`, `wellbore:<well>:1`,
`rigutilization|log|channelset:<rig>:<well>:<run start>`, `channel:<rig>:<metric>`,
`businessassociate:<name>`.

The channel dictionary (table `channels`, `GET /api/channels`) gives each recorded
metric (≈ 580: the EDR catalog, the PLC field map and unmapped PLC tags):

| Field | |
|---|---|
| mnemonic | standard drilling mnemonic (HKLA, SPPA, TQA, …) or a unique one ≤ 32 characters |
| uom | Energistics unit symbol of the presented values (validated against the common v2.3 unit list) |
| storedUnit, factor | the historian's unit, presented = stored × factor (standpipe pressure: bar → psi) |
| propertyKind | Energistics PWLS property kind (uuid, title) from the official PropertyKindDictionary v2.3 (`lib/propertyKinds.json`, built by `test/tools/pwls-extract.py`) |
| unitSource | how the unit was found: `catalog`, `plc-bit` (S7 `.X` addresses, Modbus coils, BOP limit switches → `Euc`, property kind *flag*), `plc-enum-flag` / `status` (enumerations in the PLC tag name, e.g. `0=NORMAL, 1=ESD ACTIVE`), `label` (a unit written in the PLC tag name, e.g. `-bar`, `in mm`), or `unknown` |

With the shipped PLC configuration (578 channels): 95 catalog units, 261 PLC bits,
79 units written in tag names, 70 status codes, 12 two-state enumerations and
**61 unknown**. Unknown units are published as
`Euc` with the PWLS property kind *unknown* rather than guessed; list them with
`GET /api/channels?unitSource=unknown` and add the unit to the EDR catalog.

PWLS assigns every torque kind to the *energy* quantity class and stroke rate to
*frequency*; the edge keeps the physical units `daN.m` (moment of force) and
`1/min` (reciprocal time), both valid Energistics symbols of the same dimension.

## WITSML 2.1 export (`lib/witsml21.js`, `/api/witsml21/*`)

| Endpoint | Object |
|---|---|
| `/api/witsml21/well`, `wellbore` | Well (UWI as NumGovt, field, country, time zone, operator as BusinessAssociate, status, spud) and its Wellbore (measured/bit/planned depth) |
| `/api/witsml21/rig`, `rigutilization` | the Rig, and the run of the well on this rig (start/end, Wellbore and Rig references) |
| `/api/witsml21/channel?metric=` | one Channel: mnemonic, global mnemonic, data kind, Energistics unit, PWLS ChannelPropertyKind, LoggingCompany (`WITSML_LOGGING_COMPANY`, default the rig), time index with the channel's data extent |
| `/api/witsml21/log`, `channelset?data=1` | the run's Log (a ChannelSet with every channel) or the ChannelSet with its data in the WITSML JSON row form, presented units, `null` for missing values (`start`/`stop`/`metrics`, at most `WITSML_MAX_ROWS`) |
| `/api/witsml21/objects`, `object/<uuid>` | every published object, and any one by uuid (PropertyKind, BusinessAssociate included) |

`test/witsml21.test.cjs` validates every object type against the official WITSML
2.1 / common 2.3 XSDs (`WITSML21_XSD_DIR`); on the test stack all 630 objects
(578 channels) and a ChannelSet with live data validated.

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
| bar, psi | `bar`, `psi` | standpipe pressure is exported in psi (below) |
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

**Standpipe pressure is in psi.** The PLC delivers it in bar (tags `SPP-Bar`,
`Delta SPP-Bar`), and the historian stores it in bar, as the CMF does; the `tags`
table says `bar`. Everything presented to people or other systems converts to psi
(× 14.5037738): every screen, the SPP alarm (default HI 3480 / HIHI 4350 psi;
limits saved earlier in bar are converted once to the same thresholds), the
maintenance view, the WITSML log (`mudpump.pressure` and `delta_pressure`
curves, including 1-minute min/max) and the ETP stream (`lib/units.js`).

## ETP v1.2 client (`lib/etp.js`)

Settings > Edge Sync > ETP (`ETP_ENABLED`, `ETP_URL`, `ETP_MODE`, `ETP_AUTH`,
`ETP_BACKFILL_HOURS`, `ETP_STREAM_SECONDS`). WebSocket subprotocol
`etp12.energistics.org`, header `etp-encoding: binary`, binary Avro with the
official v1.2 schemas (`lib/etp12/schemas.json`: Core, ChannelStreaming,
ChannelDataFrame, Discovery, Store, ChannelSubscribe, ChannelDataLoad, extracted
from the Apache-2.0 `etptypes` package by `test/tools/etp12-extract-schemas.py`).
Client message ids are non-zero, even and increasing; every message carries FIN;
`wss://` is required except on loopback or with `ALLOW_INSECURE_TRANSPORT=true`.
Authorization: `Basic <DEVICE_ID>:<token>` (the CMF's per-rig credential) or
`Bearer <token>`.

**Store mode (default, for the CMF).** The ETP v1.2 spec reserves ChannelStreaming
for "simple streamers" without delivery guarantees and requires ChannelSubscribe /
ChannelDataLoad when data must not be lost. In store mode the edge is the
*customer* of a store:

1. Store (Protocol 4) `PutDataObjects`: the rig's BusinessAssociates, PWLS
   PropertyKinds, Rig, Wells, Wellbores, RigUtilizations and Channels (Channel
   resources carry `metric`, `storedUnit` and `factor` in customData); repeated
   every 10 minutes for new wells, runs and channels.
2. ChannelDataLoad (Protocol 22) `OpenChannels`: the store returns each channel's
   last index; the edge sends everything after it from the historian (at most
   `ETP_BACKFILL_HOURS` back when the store has nothing), oldest first, then new
   data as it is written. Points are sent once they are at least
   `ETP_TAIL_LAG_SECONDS` (5 s) old, because Telegraf commits one second's points in
   several writes; a read that ends part-way through a timestamp re-reads it.
3. After any outage the next session resumes from the store's last index.

Verified end to end against the CMF server (`central/etp-witsml`): 628 objects put,
578 channels opened, a 2-hour backfill (2.89 M points) in about 45 s, then live
tailing; every channel, timestamp and value in the backfilled hour and in the
live-tailed window matched the edge historian exactly.

**Producer mode.** ChannelStreaming (Protocol 1) for third-party simple consumers:
on `StartStreaming` the edge sends `ChannelMetadata` (canonical channel URI
`eml:///witsml21.Channel(<uuid>)`, mnemonic, Energistics unit, PWLS
`channelClassUri`, time index in UTC microseconds) before the first data of each
channel, then `ChannelData`; `StopStreaming` stops it. No resume after a disconnect.

`test/etp.test.cjs` covers the codec, identifiers and both modes, including resume
after the store's last index and catch-up reads cut part-way through a timestamp.

The CMF server was checked with an independent ETP v1.2 implementation (Geosiris
`etpproto` 1.0.7: Core, Discovery, Store, ChannelSubscribe, ChannelDataFrame, no
problems); see `central/etp-witsml`.

## Suggested next steps

1. Confirm the units of the 61 channels listed as unknown (`/api/channels?unitSource=unknown`)
   and add them to the EDR catalog.
2. Rig equipment ratings (BOP, pumps, top drive) and string components would
   allow `rig` details, `tubular` and `bhaRun` objects; they are not stored today.
3. Test against a commercial ETP v1.2 store before relying on interoperability
   with third-party products.

## Sources

* [WITSML v1.4.1.1 data schema overview](https://energistics.org/sites/default/files/witsml_data_schema_overview.html)
* [WITSML 2.0: data object mapping from v1.4.1.1](https://docs.energistics.org/WITSML/WITSML_TOPICS/WITSML-000-015-0-C-sv2000.html)
* [WITSML 2.0: Ops Report](https://docs.energistics.org/WITSML/WITSML_TOPICS/WITSML-000-149-0-C-sv2000.html) and [Drill Report](https://docs.energistics.org/WITSML/WITSML_TOPICS/WITSML-000-146-0-C-sv2000.html) data objects
* [WITSML 2.0: Log data object](https://docs.energistics.org/WITSML/WITSML_TOPICS/WITSML-000-048-0-C-sv2000.html)
* [ETP v1.2 release announcement](https://energistics.org/node/383) and the ETP v1.2 specification (Energistics, 2021)
* [etptypes 1.2.0](https://pypi.org/project/etptypes/) (Geosiris, Apache-2.0): the ETP v1.2 Avro schemas used by the edge
* Energistics WITSML v2.1 and common v2.3 schemas and the PropertyKindDictionary v2.3 (Energistics Product License Agreement), used to validate the output and to take the PWLS property kinds
* [etpproto 1.0.7](https://pypi.org/project/etpproto/) (Geosiris, Apache-2.0): independent ETP v1.2 implementation used for the conformance check
* [ETP Avro serialization (binary and JSON encodings)](https://docs.energistics.org/ETP/ETP_TOPICS/ETP-000-012-0-C-sv1100.html)
* [Energistics common: ForceUom](https://docs.energistics.org/COM/COM_TOPICS/COM-000-630-0-R-sv2100.html), [MomentOfForceUom](https://docs.energistics.org/COM/COM_TOPICS/COM-000-732-0-R-sv2100.html), [AngularVelocityUom](https://docs.energistics.org/COM/COM_TOPICS/COM-000-532-0-R-sv2100.html)
