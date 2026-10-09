'use strict';
// Single source of truth: maps S7/Modbus tag names -> { measurement, field }.
// Shared by server.js (live decode) and lib/variables.js (the source-mapping registry).
const FIELD_MAP = {
    // DAS (Data Acquisition System)
    "Total Active Tank Volume-m^3": { meas: "fluid", field: "total_tank_volume" },
    "Active Tank Volume Gain/Loss -m^3": { meas: "fluid", field: "tank_gain_loss" },
    "Trip Tank Active Mud Volume -m^3": { meas: "fluid", field: "trip_tank" },
    "Active TripTank Volume Gain/Loss -%": { meas: "fluid", field: "trip_tank_percentage" },
    "Mud Tank 1 Volume -m^3": { meas: "fluid", field: "tank_1" },
    "Mud Tank 2 Volume -m^3": { meas: "fluid", field: "tank_2" },
    "Mud Tank 3 Volume -m^3": { meas: "fluid", field: "tank_3" },
    "Mud Tank 4 Volume -m^3": { meas: "fluid", field: "tank_4" },
    "Mud Return Flow -%": { meas: "mudpump", field: "flow_out" },
    "Mud Pump Inlet Flow-Lt/min": { meas: "mudpump", field: "flow_in" },
    "Mud Pumps Total SPM-SPM": { meas: "mudpump", field: "spm" },
    "SpeedFdbk_SPM": { meas: "mudpump", field: "spm" },
    "Mud Pumps Total SPM Backup-SPM": { meas: "mudpump", field: "spm" },
    "Mud Pumps Total SPM DB166-SPM": { meas: "mudpump", field: "spm" },
    "Mud Pump SPM": { meas: "mudpump", field: "spm" },
    "Mud Pump SPM-SPM": { meas: "mudpump", field: "spm" },
    "Mud Pumps Totals Strokes-Count": { meas: "mudpump", field: "total_spm" },
    "Mud Pumps Total Strokes-Count": { meas: "mudpump", field: "total_spm" },

    // Drilling
    "Weight on Hook -Ton": { meas: "drawworks", field: "hook_load" },
    "WOB -Ton": { meas: "drilling", field: "wob" },
    "Weight on Bit -Ton": { meas: "drilling", field: "wob" },
    "Bit Depth-m": { meas: "drilling", field: "bit_depth" }, // meters
    "TOTAL BIT Depth-m": { meas: "drilling", field: "hole_depth" }, // meters
    "SPP-Bar": { meas: "mudpump", field: "pressure" },
    "Delta SPP-Bar": { meas: "mudpump", field: "delta_pressure" },

    // Wellhead / well-service pressures (workover)
    "Tubing Pressure-Bar": { meas: "wellhead", field: "tubing_pressure" },
    "Casing Pressure-Bar": { meas: "wellhead", field: "casing_pressure" },
    "Wellhead Pressure-Bar": { meas: "wellhead", field: "wellhead_pressure" },

    // Safety status — READ-ONLY PLC digital inputs (monitoring only; never actuated).
    // Surfaced as P1 alarms on the top alarm strip.
    "Emergency Stop-0=NORMAL, 1=ESD ACTIVE": { meas: "safety", field: "esd_active" },
    "Equipment Lockout-0=NORMAL, 1=LOCKED OUT": { meas: "safety", field: "lockout_active" },
    "ROP-m/h": { meas: "drilling", field: "rop" },
    "Ropes Wear-ton/km": { meas: "drawworks", field: "rope_wear" },
    "Delta Torque-daN*m": { meas: "drilling", field: "delta_torque" },
    "Drill String Speed-RPM": { meas: "drilling", field: "rpm" },
    "Drill String Torque-daN*m": { meas: "drilling", field: "torque" },
    "Operation-1=DRILLING, 2=TRIP IN, 3=TRIP OUT, 4=CASING": { meas: "drilling", field: "operation_mode" },

    // CAT (Caterpillar Engine)
    "CAT status- -1=UNKNOWN, 0=READY, 1=IN PROGRESS, 2=STATUS DONE, 3=EMERGENCY NOT OK, 4=NOT READY, 5=FAULT, 6 = RUNNING + FAULT, 7=STOP FORCED ": { meas: "cat_engine", field: "status" },
    "CAT Sourcecmd-0=NONE, 1=LOCAL, 2=REMOTE, 3=MANUAL, 4=AUTO, 5=DCC, 6=---": { meas: "cat_engine", field: "source_cmd" },
    "CAT RunHours": { meas: "cat_engine", field: "run_hours" },
    "CAT Engine speed RPM": { meas: "cat_engine", field: "rpm" },
    "CAT Engine TorquePercentage": { meas: "cat_engine", field: "load" },
    "CAT Engine TotalHoursOperation": { meas: "cat_engine", field: "total_hours" },
    "CAT Engine TotalFuelUsed": { meas: "cat_engine", field: "total_fuel" },
    "CAT Engine CoolantTemperature": { meas: "cat_engine", field: "coolant_temp" },
    "CAT Engine FuelTemperature": { meas: "cat_engine", field: "fuel_temp" },
    "CAT Engine FuelDeliveryPressure": { meas: "cat_engine", field: "fuel_pressure" },
    "CAT Engine OilPressure": { meas: "cat_engine", field: "oil_pressure" },
    "CAT Engine CoolantLevelPercentage": { meas: "cat_engine", field: "coolant_level" },
    "CAT Engine FuelRate": { meas: "cat_engine", field: "fuel_rate" },
    "CAT Engine ElectricalPotential": { meas: "cat_engine", field: "battery_voltage" },
    "CAT Engine ACCELERATION PEDAL POSITION": { meas: "cat_engine", field: "pedal_position" },
    "CAT Engine1 StatusCode": { meas: "cat_engine", field: "engine1_status" },
    "CAT CMD Enable": { meas: "cat_engine", field: "cmd_enable" },
    "CAT CMD LSR": { meas: "cat_engine", field: "cmd_lsr" },
    "CAT CMD HSR": { meas: "cat_engine", field: "cmd_hsr" },
    "CAT Protect Lamp": { meas: "cat_engine", field: "protect_lamp" },
    "CAT Amber Warning Lamp": { meas: "cat_engine", field: "amber_warning_lamp" },
    "CAT Red Stop Lamp": { meas: "cat_engine", field: "red_stop_lamp" },
    "CAT RunHours SEC": { meas: "cat_engine", field: "run_hours_sec" },
    "CAT RunHours MIN": { meas: "cat_engine", field: "run_hours_min" },
    "CAT AT Next Regeneration": { meas: "cat_engine", field: "next_regeneration" },
    "CAT AT Fluid Tank Temperature": { meas: "cat_engine", field: "def_temp" },
    "CAT AT Fluid Tank Level": { meas: "cat_engine", field: "def_level" },
    "CAT AT Filter Intake Temperature": { meas: "cat_engine", field: "dpf_intake_temp" },
    "CAT AT Filter Outlet Temperature": { meas: "cat_engine", field: "dpf_outlet_temp" },
    "CAT AT SCR Intake Temperature": { meas: "cat_engine", field: "scr_intake_temp" },
    "CAT AT SCR Outlet Temperature": { meas: "cat_engine", field: "scr_outlet_temp" },
    "CAT AT DPF Lamp": { meas: "cat_engine", field: "dpf_lamp" },
    "CAT AT HEST Lamp": { meas: "cat_engine", field: "hest_lamp" },

    // ACS (Automatic Control System)
    "ACS status-0=UNKNONE, 1=ON, 2=OFF, 3=DISABLE ": { meas: "acs", field: "status" },
    "ACS Actual Block Position": { meas: "drawworks", field: "block_position" },
    "ACS Crownsaver in mm": { meas: "acs", field: "crownsaver" },
    "ACS floorsaver in mm": { meas: "acs", field: "floorsaver" },
    "ACS Bottomsaver in mm": { meas: "acs", field: "bottomsaver" },
    "ACS Calibration status--1=UNKNOWN, 1=SEQ IN PROGRESS, 2=NOT CALIBRATED, 3=CALIBRATED,10=MOVE UP TO CROWN, 10=MOVE UP TO CROWN, 11=MOVE DOWN TO TAG LOW ": { meas: "acs", field: "calibration_status" },
    "ACS UPPERTAG POSITION mm": { meas: "acs", field: "upper_tag" },
    "ACS Lowertag position in mm": { meas: "acs", field: "lower_tag" },
    "SLIP IN": { meas: "acs", field: "slip_in" },
    "SLIP OUT": { meas: "acs", field: "slip_out" },

    // HPU (Hydraulic Power Unit)
    "HPU status-0 = OFF, 1 = ON in IDLE, 2 = ON ": { meas: "hpu", field: "status" },
    "HPU RUN HOURS": { meas: "hpu", field: "run_hours" },
    "HPU Auxilary line pressure in bar": { meas: "hpu", field: "aux_pressure" },
    "HPU Discharge line pressure in bar": { meas: "hpu", field: "discharge_pressure" },
    "HPU Oprmode-0 = Unknown, 1 = Drilling 2 = RigUp": { meas: "hpu", field: "op_mode" },
    "HPU Oil temp-0=Temp. OK, 1=Temp. Low, 2=Temp. High, 3=Temp. High-High": { meas: "hpu", field: "oil_temp_status" },
    "HPU ActTemp in c": { meas: "hpu", field: "oil_temp" },
    "HPU Oil level-0=Level OK, 1=Level Low, 2=Level Low-Low, 3=Level High, 4= Level High-High": { meas: "hpu", field: "oil_level_status" },
    "HPU ActOil level in %": { meas: "hpu", field: "oil_level" },
    "HPU Pilot status-0=OFF, 1=ON, 2=FAULT": { meas: "hpu", field: "pilot_status" },
    "HPU Pilot ActLSPress bar": { meas: "hpu", field: "pilot_pressure" },
    "HPU Gate valve-1=OPEN, 0=CLOSE": { meas: "hpu", field: "gate_valve" },

    // HPU Additional Parameters requested
    "HPU Oil filter:1-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_1" },
    "HPU Oil filter:2-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_2" },
    "HPU Oil filter:3-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_3" },
    "HPU Oil filter:4-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_4" },
    "HPU Oil filter:5-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_5" },
    "HPU Oil filter:6-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_6" },
    "HPU Oil filter:7-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_7" },
    "HPU Oil filter:8-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_8" },

    "HPU HydrPumpPDW status-0=NOT READY, 1=READY, 2=ENABLE": { meas: "hpu", field: "pdw_pump_status" },
    "HPU HydrPumpPDW actual flow set point": { meas: "hpu", field: "pdw_pump_flow_sp" },
    "HPU HydrPumpPDW actual flow %": { meas: "hpu", field: "pdw_pump_flow" },
    "HPU HydrPumpPDW actual pressure set point": { meas: "hpu", field: "pdw_pump_press_sp" },
    "HPU HydrPumpPDW Actual Press bar": { meas: "hpu", field: "pdw_pump_press" },

    "HPU HydrPumpHTD pump1 status-0=NOT READY, 1=READY, 2=ENABLE": { meas: "hpu", field: "htd_pump1_status" },
    "HPU HydrPumpHTD pump1 flow set point": { meas: "hpu", field: "htd_pump1_flow_sp" },
    "HPU HydrPumpHTD pump1 actual flow %": { meas: "hpu", field: "htd_pump1_flow" },
    "HPU HydrPumpHTD pump1 pressure set point": { meas: "hpu", field: "htd_pump1_press_sp" },
    "HPU HydrPumpHTD pump1 Actual Press bar": { meas: "hpu", field: "htd_pump1_press" },

    "HPU HydrPumpHTD pump2 status-0=NOT READY, 1=READY, 2=ENABLE": { meas: "hpu", field: "htd_pump2_status" },
    "HPU HydrPumpHTD pump2 flow set point": { meas: "hpu", field: "htd_pump2_flow_sp" },
    "HPU HydrPumpHTD pump2 actual flow %": { meas: "hpu", field: "htd_pump2_flow" },
    "HPU HydrPumpHTD pump2 pressure set point": { meas: "hpu", field: "htd_pump2_press_sp" },
    "HPU HydrPumpHTD pump2 Actual Press bar": { meas: "hpu", field: "htd_pump2_press" },

    // HTD (Horizontal Top Drive)
    "HTD status-0 = OFF, 1 = ON in IDLE, 2 = ON ": { meas: "htd", field: "status" },
    "HTD workmode-0 = Unknown, 1 = Drill, 2 = Spin, 3 = Torque": { meas: "htd", field: "work_mode" },
    "HTD opmode-0 = Unknown, 1 = Dolly 2 = Link": { meas: "htd", field: "op_mode" },
    "HTD Rotation Status-0 = Stand still, 1 = Rotation FWD, 2 = Rotation BWD, 3 = Neutral": { meas: "htd", field: "rotation_status" },
    "HTD rpm": { meas: "htd", field: "rpm" },
    "HTD rpm Request": { meas: "htd", field: "rpm_request" },
    "HTD rpm COMMAND": { meas: "htd", field: "rpm_command" },
    "HTD torque Request": { meas: "htd", field: "torque_request" },
    "HTD torque COMMAND": { meas: "htd", field: "torque_command" },
    "HTD TORQUE DaNm": { meas: "htd", field: "torque" },
    "HTD Lube Status-0=OFF, 1=CMD RUN, 2=RUNNING, 3 = FAULT": { meas: "htd", field: "lube_status" },
    "HTD Brake Status-0=Unknown, 1 = Closing, 2 = Closed, 3 = Opening, 4 = Open, 5 = Fault": { meas: "htd", field: "brake_status" },
    "HTD Elevator Status-0= Uncknown, 1 = Opening, 2 = Closing, 3 = Open, 4 = Close, 5 = Fault": { meas: "htd", field: "elevator_status" },
    "HTD IBOP Status-0= Uncknown, 1 = Opening, 2 = Closing, 3 = Open, 4 = Close, 5 = Fault": { meas: "htd", field: "ibop_status" },
    "HTD Link Tilt status-0 = None, 1 = Float ON, 2 = Vertical, 3 = Float OFF, 4 = Extend, 5 = Retract, 6 = Fault": { meas: "htd", field: "tilt_status" },
    "HTD Inclination angle in %": { meas: "htd", field: "inclination" },
    "HTD suspensions Status-0=none, 1= in push, 2= in pull": { meas: "htd", field: "suspension_status" },
    "HTD vertical speed": { meas: "htd", field: "vertical_speed" },
    "HTD WORKING HOURS": { meas: "htd", field: "working_hours" },
    "HTD working hours": { meas: "htd", field: "working_hours" },
    "HTD WORKING MINUTES": { meas: "htd", field: "working_minutes" },
    "HTD working minutes": { meas: "htd", field: "working_minutes" },
    "HTD Link rotation Status-0= Uncknown, 1 = Unlocking, 2 = Unlocked, 3 = Rot. Fwd, 4 = Rot. Bwd, 5 = Locking, 6 = Locked ,  7 = Fault": { meas: "htd", field: "link_rotation_status" },
    "HTD Tilt status-1= Tilting IN, 2=Tilt IN, 3=Tilting OUT, 4=Tilt OUT, 5=Half Way, 6=Stand Still": { meas: "htd", field: "tilt_status_db65" },
    "HTD Inclination status-1= Inclination IN in progress, 2=Inclination IN, 3=Inclination OUT in progress, 4=Inclinated OUT, 5=Half Way, 6=Stand Still, 7=Tilted In, 8=Tilted Out": { meas: "htd", field: "inclination_status" },
    "HTD GEAR status--2=UNKNOWN, -1=FAULT, 1=GEAR 1, 2=GEAR 2, 3=GEAR 3, 4=GEAR 4. 5= GEAR 1 REGENERATIVE, 6= GEAR 2 REGENERATIVE, 7=GEAR 3 REGENERATIVE, 8= GEAR 4 REGENERATIVE": { meas: "htd", field: "gear_status" },

    // CWK (Catwalk)
    "CWK status-0= NOT IN PARK POSITION, 1=PARK POSITION ": { meas: "cwk", field: "status" },
    "CWK Indexer DX-1=UP, 2=DOWN, 3=FAULT": { meas: "cwk", field: "indexer_dx" },
    "CWK Indexer SX-1=UP, 2=DOWN, 3=FAULT": { meas: "cwk", field: "indexer_sx" },
    "CWK Kickers DX-1=EXTEND, 2=RETRACT, 3=FAULT": { meas: "cwk", field: "kickers_dx" },
    "CWK Kickers SX-1=EXTEND, 2=RETRACT, 3=FAULT": { meas: "cwk", field: "kickers_sx" },
    "CWK Skate-1=IDLE, 2=PARKING POSITION, 3=FWD CMD, 4=BWD CMD, 5=FAULT": { meas: "cwk", field: "skate_status" },
    "CWK Slide-1=IDLE, 2=PARKING POSITION, 3=FWD CMD, 4=BWD CMD, 5=FAULT": { meas: "cwk", field: "slide_status" },
    "CWK Carrier-1= STOP, 2=PARKING POSITION, 3= WORK POSITION, 4= LIFTING, 5=LOWERING, 6=FAULT": { meas: "cwk", field: "carrier_status" },
    "CWK Carrier angle": { meas: "cwk", field: "carrier_angle" },
    "CWK Clamp-0=NONE, 1=OPENING, 2=CLOSING, 3=IS OPEN, 4=IS CLOSE, 5=FAULT": { meas: "cwk", field: "clamp_status" },
    "CWK Clamp close pressure": { meas: "cwk", field: "clamp_pressure" },
    "CWK Clamp close pressure OK": { meas: "cwk", field: "clamp_pressure_ok" },
    "CWK Clamp Actcloseforce": { meas: "cwk", field: "clamp_force" },
    "CWK Clamp Actcloeforce ok": { meas: "cwk", field: "clamp_force_ok" },
    "CWK sourcecmd-0 = UNKNOWN, 1 = DCC, 2 = RADIOCONTROL": { meas: "cwk", field: "source_cmd" },

    // PCT (Power Casing Tong)
    "PCT Operation mode-0 = UNKNOWN, 1 = NORMAL, 2 = MANUAL": { meas: "pct", field: "op_mode" },
    "PCT STATUS-0 = OFF, 1 = ON in IDLE, 2 = ON": { meas: "pct", field: "status" },
    "PCT DOLLY UP DOWN-0=NO CMD ACTIVE, 1=MOVE UP, 2=MOVE DOWN": { meas: "pct", field: "dolly_direction" },
    "PCT DollyWorkPark-0=NONE, 1=OUT PARK. POS, 2=MOVE WORK, 3=MOVE PARK, 4=IN PARK, 5=FAULT, 6=in work": { meas: "pct", field: "dolly_status" },
    "PCT Spinner Rotation-0=NO CMD ACTIVE, 1=FULLY UP, 2=FULLY DOWN, 3=MAKE-UP, 4= BREAK-OUT. 10=SPINNER NOT MOUNTED": { meas: "pct", field: "spinner_rotation_status" },
    "PCT SPINNER GRIPPER-0=NONE, 1=OPENING, 2=CLOSING, 3=OPEN, 4=CLOSE, 5=FAULT, 10=SPINNER NOT MOUNTED": { meas: "pct", field: "spinner_gripper_status" },
    "PCT SPINNER FLOATING-0=OFF, 1=ON, 10=SPINNER NOT MOUNTED": { meas: "pct", field: "spinner_floating" },
    "PCT SpinnerActMakeUpTorque-daN*m": { meas: "pct", field: "spinner_makeup_torque" },
    "PCT SpinnerActBOutTorque-daN*m": { meas: "pct", field: "spinner_breakout_torque" },
    "PCT ClampUp-0=NONE, 1=OPENING, 2=CLOSING, 3=IS OPEN, 4=IS CLOSE, 5=FAULT": { meas: "pct", field: "clamp_up_status" },
    "PCT ROTATION ActMakeUpPress": { meas: "pct", field: "rotation_makeup_pressure" },
    "PCT ROTATION ActBOutPress": { meas: "pct", field: "rotation_breakout_pressure" },
    "PCT Clamp up close pressure": { meas: "pct", field: "clamp_up_pressure" },
    "PCT Clamp up close pressure ok": { meas: "pct", field: "clamp_up_pressure_ok" },
    "PCT Clamp up ActCloseForce": { meas: "pct", field: "clamp_up_force" },
    "PCT Clamp up ActCloseForce ok": { meas: "pct", field: "clamp_up_force_ok" },
    "PCT Clamp up open pressure ok": { meas: "pct", field: "clamp_up_open_ok" },
    "PCT Clamplow-0=NONE, 1=OPENING, 2=CLOSING, 3=IS OPEN, 4=IS CLOSE, 5=FAULT": { meas: "pct", field: "clamp_low_status" },
    "PCT Clamp low close pressure": { meas: "pct", field: "clamp_low_pressure" },
    "PCT Clamp low close pressure ok": { meas: "pct", field: "clamp_low_pressure_ok" },
    "PCT Clamp low ActCloseForce": { meas: "pct", field: "clamp_low_force" },
    "PCT Clamp low ActCloseForce ok": { meas: "pct", field: "clamp_low_force_ok" },
    "PCT Clamp low open pressure ok": { meas: "pct", field: "clamp_low_open_ok" },
    "PCT Clamp Roatation-0=NONE, 1=NOT ALLIGNED, 2=ALLIGNED, 3=MAKE-UP, 4=BREAK-OUT, 5=FAULT": { meas: "pct", field: "clamp_rotation_status" },
    "PCT Makeup Torque-daN*m": { meas: "pct", field: "makeup_torque" },
    "PCT ClampLastMakeUpTorque-daN*m": { meas: "pct", field: "last_makeup_torque" },
    "PCT Sequence-0=OFF, 1=MAKE-UP, 2=BREAK-OUT, 3=RESET, 4=FAULT": { meas: "pct", field: "sequence" },
};

// DB119 catalogue is shared with the HPU screen and administration template.
for (const tag of require('../../shared/db119Catalog.json')) {
    FIELD_MAP[tag.name] = { meas: tag.measurement, field: tag.field };
}

const normalizeTagName = (value) => String(value || '')
    .toLowerCase()
    .replace(/\^3/g, '3')
    .replace(/m³/g, 'm3')
    .replace(/lt\/min/g, 'lmin')
    .replace(/l\/min/g, 'lmin')
    .replace(/litre|min|liter/g, '')
    .replace(/totals/g, 'total')
    .replace(/strokes/g, 'stroke')
    .replace(/[^a-z0-9]+/g, '');

const NORMALIZED_FIELD_MAP = Object.entries(FIELD_MAP).reduce((acc, [tag, mapping]) => {
    acc[normalizeTagName(tag)] = mapping;
    return acc;
}, {});

const getFieldMapping = (tag) => FIELD_MAP[tag] || NORMALIZED_FIELD_MAP[normalizeTagName(tag)];

module.exports = { FIELD_MAP, getFieldMapping };
