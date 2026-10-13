'use strict';
// Stored vs presented units.
//
// The historian keeps values as the PLC delivers them, which is also what the
// CMF stores: standpipe pressure in bar (PLC tags "SPP-Bar", "Delta SPP-Bar").
// Operators work in psi, so every screen, alarm and interchange format (WITSML,
// ETP) presents these metrics in psi.
const PSI_PER_BAR = 14.5037738;

const PRESENTED = {
    'mudpump.pressure': { stored: 'bar', unit: 'psi', factor: PSI_PER_BAR },
    'mudpump.delta_pressure': { stored: 'bar', unit: 'psi', factor: PSI_PER_BAR },
};

// Units of PLC-mapped metrics the EDR catalog does not list (from the PLC tag
// names "Weight on Hook -Ton" and "Drill String Torque-daN*m").
const FIELD_UNITS = {
    'drawworks.hook_load': 't',
    'drilling.torque': 'daN.m',
};

/** { stored, unit, factor } when the metric is presented in another unit, else null. */
const presentation = (metric) => PRESENTED[metric] || null;

/** The unit values of this metric are stored in (null: the catalog unit applies). */
const storedUnit = (metric) => (PRESENTED[metric] ? PRESENTED[metric].stored : FIELD_UNITS[metric] || null);

/** A stored value in the presented unit (non-numbers pass through). */
const present = (metric, value) => {
    const p = PRESENTED[metric];
    if (!p || value === null || value === undefined || value === '' || typeof value === 'boolean') return value;
    const n = Number(value);
    return Number.isFinite(n) ? n * p.factor : value;
};

module.exports = { PSI_PER_BAR, presentation, storedUnit, present };
