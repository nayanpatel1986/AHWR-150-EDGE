# DB119 HPU Analytics update

The existing HPU screen remains at `/equipment?tab=hpu`, with Overview, Pressure Network, Pump Groups and Cooling & Health internal tabs. No extra PLC collector, route or equipment navigation entry was added.

## Acquisition and administration

`data/app/plc_config.json`, its installation default and the existing managed Telegraf configuration now contain CAT ENG-1 (40 fields), CAT ENG-2 (33 fields), HPU (318 fields). The supplied source configuration is retained here as `DB119-engine1-engine2-hpu-source.conf` for reference only; do not run it as another collector.

All 391 source names and addresses are retained. Discharge is DB119.R12, auxiliary DB119.R18, engine 1 RPM DB119.R314 and engine 2 RPM DB119.R428. These supersede the older conflicting DB119 layout. The existing project PLC endpoint 192.168.0.13:102 and local InfluxDB output are preserved. The attachment's PLC endpoint is 192.168.0.11:102; change the device endpoint in Administration if that is the intended installation address.

The shared catalogue `app/shared/db119Catalog.json` drives live/history field mappings and the administration default template. Existing historical field aliases remain readable. New sensor-quality bits must be present in the selected time bucket before new HPU analytics use a historical analog value.

## Configuration and units

Settings → Administration → PLC & S7 Configuration includes HPU pressure setpoints, rated flow capacities and health weights. Save & Apply stores these with the existing PLC configuration. Empty values deliberately do not receive screenshot defaults.

The supplied pump and ESCH flow names specify percent. Pump tables and ESCH trends retain %. L/min totals require a rated flow for every contributing channel: channel % × rated L/min / 100. No partial totals are presented. Fan current unit is not specified by the source; it is shown as PLC units. Fan 5 current and analog cooling temperatures have no supplied addresses and are not fabricated. Cooling hot/cold inputs remain BOOL switches.

Mode/command and cooling fan status enums without documented labels display their raw CODE. This avoids claiming AUTO or HEALTHY from an undocumented byte.

## Calculations and quality

- Each live field must have a valid source timestamp no older than 10 seconds, a connected/non-stale feed, a valid number or BOOL, and its associated valid sensor OK bit. Optional `hpuAnalytics.ranges` in the configuration can constrain analog ranges.
- Pressure utilization = PV / configured positive SP × 100. Deviation = PV − SP. Tracking error = |PV − SP| / |SP| × 100; zero or missing SP produces no calculated result.
- Pressure stability = max(0, 100 − CV), where CV = population standard deviation / |mean| × 100. At least 10 valid samples and a nonzero mean are required. Overall pressure stability requires all 12 lines.
- Utilization is time in PLC RUN state 2 / valid observed time. At least 80% of the selected window must be covered; large gaps and unknown states are excluded. Pressure is not used to infer RUN.
- Pump group flow totals include all 4 PDW, 4 HTD or 2 SRV pumps. Group pressure is the arithmetic mean of all valid physical pump pressures, never the sum. A missing member invalidates the aggregate.
- Fan availability = ready fans with no fault/warning / six configured fans. All six diagnostic sets must be available.
- Pump tracking health = max(0, 100 − mean(flow tracking error, pressure tracking error)); every pump's valid status and feedback are required.
- Oil component = valid sensor bits plus normal oil temperature and level status, divided by seven checks. This indicates feedback/PLC condition, not a laboratory oil-life estimate.
- HPU health is a weighted average of pressure stability, pump tracking, oil condition, cooling availability and emergency-stop feedback. All five positive weights must be explicitly configured and all components valid. Otherwise the gauge is unavailable.

PLC diagnostic bits are integrated into the existing alarm engine (87 rules), preserving existing configurable analog limits and alarm history. HPU event tables read the existing authenticated alarm history endpoint. Rules do not create invented pressure or temperature limits.

## Verification

Run `npm test` in `app/backend` for mapping, source integrity, stale/quality, null, time coverage and aggregation regression tests. Run `npm run build` in `app/frontend` for the production build. The isolated development preview uses synthetic test values only, is located under `app/frontend/test`, and is not part of the production build.
