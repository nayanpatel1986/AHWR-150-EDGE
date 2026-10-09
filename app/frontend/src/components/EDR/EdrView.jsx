import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Box,
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControl,
    Grid,
    IconButton,
    ListItemText,
    ListSubheader,
    MenuItem,
    Paper,
    Select,
    TextField,
    ToggleButton,
    ToggleButtonGroup,
    Tooltip as MuiTooltip,
    Typography,
    useTheme
} from '@mui/material';
import {
    ChevronsDown,
    ChevronsUp,
    Clock,
    Download,
    FileSpreadsheet,
    FileText,
    Gauge,
    Image as ImageIcon,
    Minus,
    Plus,
    Radio,
    Ruler,
    Settings,
    SlidersHorizontal,
    Trash2,
    X
} from 'lucide-react';
import axios from '../../api';
import { getLatestRigData, getRecentRigDataSamples, socket } from '../../socket';
import edrCatalog from '../../../../shared/edrMetrics.json';
import * as XLSX from 'xlsx';

/*
 * EdrView — reusable, self-contained strip-chart Electronic Drilling Recorder.
 *
 * Rendering is a hand-rolled SVG strip renderer (no recharts) so we control the
 * strip look exactly: shared vertical index axis (time OR depth), multiple pens
 * per strip each on its OWN horizontal [min,max] scale + color, light gridlines,
 * a thin current-value marker, and a FIXED-HEIGHT bottom "variables" block whose
 * content adaptively compacts so every strip's block is the same height and the
 * blocks line up on a shared baseline regardless of pen count.
 *
 * Data plumbing reuses the shared authenticated axios (/api/history seed +
 * /api/rig/latest) and the shared socket (`rig_data`) — no new instances.
 */

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

const RETIRED_CHANNELS = new Set(['drawworks.hook_load']);
const METRIC_OPTIONS = edrCatalog.categories.flatMap(category => (
    category.fields.map(field => ({
        id: `${category.id}.${field.id}`,
        label: field.label,
        unit: field.unit || '',
        precision: field.precision ?? 1,
        defaultMin: field.defaultMin ?? 0,
        defaultMax: field.defaultMax ?? 1,
        categoryId: category.id,
        categoryLabel: category.label
    }))
)).filter(metric => !RETIRED_CHANNELS.has(metric.id));
const METRIC_LOOKUP = new Map(METRIC_OPTIONS.map(o => [o.id, o]));
const ALL_METRIC_IDS = METRIC_OPTIONS.map(o => o.id);

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const PEN_COLORS = ['#38bdf8', '#fbbf24', '#4ade80', '#f472b6', '#a78bfa', '#fb7185', '#22d3ee', '#f97316'];
const MAX_PENS = 3;
const MAX_READOUTS = 6;
const DEPTH_INDEX_METRIC = 'drilling.hole_depth';
const DEPTH_BIN_M = 0.5;
const PSI_PER_BAR = 14.50377;
const MAX_TIME_RANGE_STEPS = 288;
const BAR_TO_PSI_CHANNELS = new Set(['mudpump.pressure', 'mudpump.delta_pressure']);
const CANONICAL_CHANNELS = {
    'drawworks.hook_load': 'drilling.hook_load'
};
const CHANNEL_ALIASES = {
    'drilling.hook_load': ['drawworks.hook_load'],
    'drawworks.block_position': ['acs.block_position']
};

// Always-on left-band depth readouts (full mode only).
const HOLE_DEPTH_METRIC = 'drilling.hole_depth';
const BIT_DEPTH_METRIC = 'drilling.bit_depth';

const channelLabel = (id) => METRIC_LOOKUP.get(id)?.label || id.replace(/[._]/g, ' ');
const channelUnit = (id) => METRIC_LOOKUP.get(id)?.unit || '';
const channelPrecision = (id) => METRIC_LOOKUP.get(id)?.precision ?? 1;
const channelCategory = (id) => METRIC_LOOKUP.get(id)?.categoryLabel || '';
const channelDisplayValue = (id, value) => {
    if (!BAR_TO_PSI_CHANNELS.has(id)) return value;
    if (value == null || value === '' || !Number.isFinite(Number(value))) return value;
    return Number(value) * PSI_PER_BAR;
};
const channelValue = (values, id) => {
    if (!values || typeof values !== 'object') return undefined;
    const canonicalId = canonicalChannelId(id);
    if (canonicalId !== id) return channelValue(values, canonicalId);
    if (values[canonicalId] != null && values[canonicalId] !== '') return values[canonicalId];
    const aliases = CHANNEL_ALIASES[canonicalId] || [];
    for (const alias of aliases) {
        if (values[alias] != null && values[alias] !== '') return values[alias];
    }
    return undefined;
};
const expandChannelsWithAliases = (ids) => {
    const out = new Set(ids);
    ids.forEach(id => (CHANNEL_ALIASES[id] || []).forEach(alias => out.add(alias)));
    return Array.from(out);
};
const applyChannelAliases = (values) => {
    Object.entries(CHANNEL_ALIASES).forEach(([target, aliases]) => {
        if (values[target] == null || values[target] === '') {
            const aliasValue = aliases.map(alias => values[alias]).find(value => value != null && value !== '');
            if (aliasValue != null && aliasValue !== '') values[target] = aliasValue;
        }
    });
    return values;
};
function canonicalChannelId(id) {
    return CANONICAL_CHANNELS[id] || id;
}

const fmtValue = (value, precision) => {
    if (value == null || value === '' || !Number.isFinite(Number(value))) return '--';
    return Number(value).toFixed(precision);
};

const fmtScale = (value) => {
    if (value == null || value === '') return '--';
    const n = Number(value);
    if (!Number.isFinite(n)) return '--';
    return String(Math.round(n * 100) / 100);
};

const clampCustomMinutes = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_CUSTOM_TIME_MINUTES;
    return Math.max(1, Math.min(MAX_CUSTOM_TIME_MINUTES, Math.round(n)));
};

const formatAxisTime = (value, spanMs) => {
    const options = spanMs >= 12 * 60 * 60 * 1000
        ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }
        : spanMs >= 60 * 60 * 1000
            ? { hour: '2-digit', minute: '2-digit', hour12: false }
            : { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
    return new Date(value).toLocaleString([], options);
};

const toDateTimeLocal = (value) => {
    const d = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const fromDateTimeLocal = (value) => {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? new Date(time).toISOString() : '';
};

const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const csvEscape = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const buildExportRows = (rows, metrics) => rows.map(row => {
    const out = {
        Time: Number.isFinite(Number(row.timestamp))
            ? new Date(Number(row.timestamp)).toISOString()
            : '',
        'Hole Depth': row[HOLE_DEPTH_METRIC] ?? row['drilling.hole_depth'] ?? '',
        'Bit Depth': row[BIT_DEPTH_METRIC] ?? row['drilling.bit_depth'] ?? ''
    };
    metrics.forEach(id => {
        out[channelLabel(id)] = channelDisplayValue(id, row[id]) ?? '';
    });
    return out;
});

const exportRowsAsCsv = (rows, filename) => {
    const headers = Object.keys(rows[0] || { Time: '' });
    const csv = [
        headers.map(csvEscape).join(','),
        ...rows.map(row => headers.map(h => csvEscape(row[h])).join(','))
    ].join('\n');
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename);
};

const exportRowsAsXlsx = (rows, filename) => {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'EDR Data');
    const data = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
};

const xmlEscape = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const exportRowsAsPng = async (historyRows, metrics, filename) => {
    const width = 1400;
    const height = 820;
    const pad = { left: 72, right: 40, top: 72, bottom: 82 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const rows = historyRows
        .filter(row => Number.isFinite(Number(row.timestamp)))
        .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    const t0 = rows[0]?.timestamp ?? Date.now() - 1;
    const t1 = rows[rows.length - 1]?.timestamp ?? Date.now();
    const span = Math.max(1, t1 - t0);
    const selected = metrics.slice(0, 8);
    const paths = selected.map((metric, index) => {
        const meta = METRIC_LOOKUP.get(metric);
        const min = Number(meta?.defaultMin ?? 0);
        const max = Number(meta?.defaultMax ?? 1);
        const range = max > min ? max - min : 1;
        const color = PEN_COLORS[index % PEN_COLORS.length];
        const points = rows
            .map(row => {
                const val = Number(channelDisplayValue(metric, row[metric]));
                if (!Number.isFinite(val)) return null;
                const x = pad.left + ((Number(row.timestamp) - t0) / span) * plotW;
                const y = pad.top + (1 - Math.max(0, Math.min(1, (val - min) / range))) * plotH;
                return `${x.toFixed(2)},${y.toFixed(2)}`;
            })
            .filter(Boolean);
        return points.length > 1
            ? `<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
            : '';
    }).join('');
    const grid = Array.from({ length: 7 }, (_, i) => {
        const y = pad.top + (i / 6) * plotH;
        return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y}" y2="${y}" stroke="#263241" stroke-width="1"/>`;
    }).join('') + Array.from({ length: 9 }, (_, i) => {
        const x = pad.left + (i / 8) * plotW;
        return `<line y1="${pad.top}" y2="${height - pad.bottom}" x1="${x}" x2="${x}" stroke="#263241" stroke-width="1"/>`;
    }).join('');
    const legend = selected.map((metric, index) => {
        const x = pad.left + (index % 4) * 300;
        const y = height - 48 + Math.floor(index / 4) * 24;
        const color = PEN_COLORS[index % PEN_COLORS.length];
        return `<rect x="${x}" y="${y - 10}" width="12" height="12" rx="2" fill="${color}"/><text x="${x + 20}" y="${y}" fill="#e5eefb" font-size="16" font-weight="700">${xmlEscape(channelLabel(metric))}</text>`;
    }).join('');
    const subtitle = rows.length
        ? `${new Date(t0).toLocaleString()} - ${new Date(t1).toLocaleString()}`
        : 'No data';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <rect width="100%" height="100%" fill="#05070b"/>
        <text x="${pad.left}" y="38" fill="#ffffff" font-size="28" font-weight="900">Electronic Drilling Recorder Export</text>
        <text x="${pad.left}" y="62" fill="#94a3b8" font-size="15">${xmlEscape(subtitle)}</text>
        <rect x="${pad.left}" y="${pad.top}" width="${plotW}" height="${plotH}" fill="#020407" stroke="#334155"/>
        ${grid}
        ${paths}
        ${legend}
    </svg>`;
    const img = new window.Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (blob) downloadBlob(blob, filename);
};

// ---------------------------------------------------------------------------
// Time window presets
// ---------------------------------------------------------------------------

const TIME_WINDOWS = [
    { label: '1m', ms: 1 * 60 * 1000, range: '-1m' },
    { label: '5m', ms: 5 * 60 * 1000, range: '-5m' },
    { label: '15m', ms: 15 * 60 * 1000, range: '-15m' },
    { label: '30m', ms: 30 * 60 * 1000, range: '-30m' },
    { label: '1H', ms: 60 * 60 * 1000, range: '-1h' },
    { label: '2H', ms: 2 * 60 * 60 * 1000, range: '-2h' },
    { label: '4H', ms: 4 * 60 * 60 * 1000, range: '-4h' },
    { label: '6H', ms: 6 * 60 * 60 * 1000, range: '-6h' },
    { label: '12H', ms: 12 * 60 * 60 * 1000, range: '-12h' },
    { label: '24H', ms: 24 * 60 * 60 * 1000, range: '-24h' }
];
const COMPACT_HIDDEN_TIME_WINDOW_RANGES = new Set(['-1m', '-15m', '-2h', '-4h', '-24h']);
const CUSTOM_TIME_KEY = 'custom';
const DEFAULT_CUSTOM_TIME_MINUTES = 60;
const MAX_CUSTOM_TIME_MINUTES = 24 * 60;
const HISTORY_CACHE_TTL_MS = 2 * 60 * 1000; // 2 min — keeps switching between windows fast
const HISTORY_SCROLLBACK_BUCKET_MS = 5 * 60 * 1000;
const HISTORY_LIVE_PADDING_MS = 10 * 1000;
const MAX_TIME_SCROLLBACK_MS = 30 * 24 * 60 * 60 * 1000;
const LIVE_DATA_GRACE_MS = 60 * 1000;
const GLOBAL_EDR_PREFS_KEY = 'edr-global-preferences';
const EDR_DATA_CACHE_PREFIX = 'edr-data-cache:';
const EDR_DATA_CACHE_MAX_ROWS = 20000;
const EDR_DATA_SESSION_MAX_ROWS = 5000;
const EDR_DATA_SESSION_SAVE_INTERVAL_MS = 5000;
const EDR_HISTORY_FETCH_DEBOUNCE_MS = 50;
const edrDataCache = new Map();
const edrDataCachePersistAt = new Map();
const EXPORT_RANGES = [
    { key: '-15m', label: 'LAST 15 MIN' },
    { key: '-1h', label: 'LAST 1 HOUR' },
    { key: '-6h', label: 'LAST 6 HOURS' },
    { key: '-12h', label: 'LAST 12 HOURS' },
    { key: '-24h', label: 'LAST 24 HOURS' },
    { key: '-3d', label: 'LAST 3 DAYS' },
    { key: '-7d', label: 'LAST 7 DAYS' },
    { key: '-30d', label: 'LAST 30 DAYS' }
];
const DEPTH_SPANS = [
    { label: '25m', m: 25 },
    { label: '50m', m: 50 },
    { label: '100m', m: 100 },
    { label: '250m', m: 250 },
    { label: '500m', m: 500 }
];
const historyCache = new Map();

const getTimeWindowIndexByRange = (range, fallbackIndex = 1) => {
    const idx = TIME_WINDOWS.findIndex(opt => opt.range === range);
    return idx >= 0 ? idx : fallbackIndex;
};

const getVisibleTimeWindowIndexes = (isCompact) => (
    TIME_WINDOWS
        .map((opt, index) => ({ opt, index }))
        .filter(({ opt }) => !isCompact || !COMPACT_HIDDEN_TIME_WINDOW_RANGES.has(opt.range))
        .map(({ index }) => index)
);

const normalizeTimeWindowIndex = (idx, isCompact, fallbackIndex = 1) => {
    if (idx === CUSTOM_TIME_KEY) return CUSTOM_TIME_KEY;
    const visible = getVisibleTimeWindowIndexes(isCompact);
    return visible.includes(idx) ? idx : (visible.includes(fallbackIndex) ? fallbackIndex : visible[0] ?? 0);
};

const getDepthSpanIndexByMeters = (meters, fallbackIndex = 2) => {
    const idx = DEPTH_SPANS.findIndex(opt => opt.m === meters);
    return idx >= 0 ? idx : fallbackIndex;
};

const normalizeCustomTimeRange = (value) => {
    if (!value || typeof value !== 'object') return null;
    const start = new Date(value.start).getTime();
    const stop = new Date(value.stop).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return null;
    return {
        start: new Date(start).toISOString(),
        stop: new Date(stop).toISOString()
    };
};

const toHistoryRows = (rows, neededChannels) => rows.map(row => {
    const values = {};
    neededChannels.forEach(id => {
        const value = channelValue(row, id);
        if (value != null && value !== '') values[id] = value;
    });
    return {
        timestamp: Number(row.timestamp),
        depth: Number(row[DEPTH_INDEX_METRIC] ?? row['drilling.bit_depth']),
        values
    };
}).filter(r => Number.isFinite(r.timestamp));

const mergeSampleRows = (existing, incoming) => {
    const bySecond = new Map();
    [...existing, ...incoming].forEach(point => {
        if (!Number.isFinite(point?.timestamp)) return;
        const key = Math.floor(point.timestamp / 1000);
        const prev = bySecond.get(key);
        bySecond.set(key, {
            timestamp: point.timestamp,
            depth: Number.isFinite(point.depth) ? point.depth : prev?.depth,
            values: { ...(prev?.values || {}), ...(point.values || {}) }
        });
    });
    return Array.from(bySecond.values()).sort((a, b) => a.timestamp - b.timestamp);
};

const loadCachedDataRows = (storageKey) => {
    if (!storageKey) return [];
    const inMemory = edrDataCache.get(storageKey);
    if (Array.isArray(inMemory) && inMemory.length) return inMemory;
    try {
        const rows = JSON.parse(sessionStorage.getItem(`${EDR_DATA_CACHE_PREFIX}${storageKey}`) || '[]');
        return Array.isArray(rows) ? rows.filter(r => Number.isFinite(Number(r?.timestamp))) : [];
    } catch {
        return [];
    }
};

const saveCachedDataRows = (storageKey, rows) => {
    if (!storageKey || !Array.isArray(rows)) return;
    const trimmed = rows.slice(-EDR_DATA_CACHE_MAX_ROWS);
    edrDataCache.set(storageKey, trimmed);
    const now = Date.now();
    const lastPersist = edrDataCachePersistAt.get(storageKey) || 0;
    if (now - lastPersist < EDR_DATA_SESSION_SAVE_INTERVAL_MS) return;
    edrDataCachePersistAt.set(storageKey, now);
    try {
        sessionStorage.setItem(`${EDR_DATA_CACHE_PREFIX}${storageKey}`, JSON.stringify(trimmed.slice(-EDR_DATA_SESSION_MAX_ROWS)));
    } catch {
        /* best effort */
    }
};

const getLatestTimestamp = (rows) => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const timestamp = Number(rows[i]?.timestamp);
        if (Number.isFinite(timestamp)) return timestamp;
    }
    return null;
};

const getAdjacentTimeWindowIndex = (currentKey, currentMs, direction, fallbackIndex) => {
    if (!TIME_WINDOWS.length) return fallbackIndex;
    const activeIndex = currentKey === CUSTOM_TIME_KEY
        ? -1
        : getTimeWindowIndexByRange(currentKey, fallbackIndex);
    if (activeIndex >= 0) {
        return Math.max(0, Math.min(TIME_WINDOWS.length - 1, activeIndex + direction));
    }
    if (direction < 0) {
        for (let i = TIME_WINDOWS.length - 1; i >= 0; i -= 1) {
            if (TIME_WINDOWS[i].ms < currentMs) return i;
        }
        return 0;
    }
    for (let i = 0; i < TIME_WINDOWS.length; i += 1) {
        if (TIME_WINDOWS[i].ms > currentMs) return i;
    }
    return TIME_WINDOWS.length - 1;
};

// ---------------------------------------------------------------------------
// Config normalization / persistence
// ---------------------------------------------------------------------------

const normalizePen = (pen, fallbackColorIndex, channels) => {
    const src = pen && typeof pen === 'object' ? pen : {};
    const requestedChannelId = canonicalChannelId(src.channelId);
    let channelId = METRIC_LOOKUP.has(requestedChannelId) ? requestedChannelId : ALL_METRIC_IDS[0];
    if (channels && channels.length > 0 && !channels.includes(channelId)) {
        channelId = channels[0];
    }
    const meta = METRIC_LOOKUP.get(channelId);
    let min = Number.isFinite(Number(src.min)) ? Number(src.min) : (meta?.defaultMin ?? 0);
    let max = Number.isFinite(Number(src.max)) ? Number(src.max) : (meta?.defaultMax ?? 1);
    let scaleUnit = src.scaleUnit;
    if (BAR_TO_PSI_CHANNELS.has(channelId)) {
        if (scaleUnit !== 'psi' && max <= 1000) {
            min *= PSI_PER_BAR;
            max *= PSI_PER_BAR;
        }
        scaleUnit = 'psi';
    }
    if (max <= min) max = min + 1;
    return {
        channelId,
        min,
        max,
        scaleUnit,
        color: COLOR_RE.test(src.color || '') ? src.color : PEN_COLORS[fallbackColorIndex % PEN_COLORS.length],
        enabled: src.enabled !== false
    };
};

const normalizeStrips = (strips, channels) => {
    if (!Array.isArray(strips)) return [];
    return strips.map((strip, si) => ({
        title: typeof strip?.title === 'string' && strip.title ? strip.title : `Track ${si + 1}`,
        pens: (Array.isArray(strip?.pens) ? strip.pens : [])
            .slice(0, MAX_PENS)
            .map((pen, pi) => normalizePen(pen, si + pi, channels))
    }));
};

const normalizeReadouts = (ids, channels) => {
    if (!Array.isArray(ids)) return [];
    const out = [];
    const seen = new Set();
    for (const rawId of ids) {
        const id = canonicalChannelId(rawId);
        if (!seen.has(id) && (!channels || channels.includes(id))) {
            seen.add(id);
            out.push(id);
        }
    }
    return out.slice(0, MAX_READOUTS);
};

const loadPersisted = (storageKey, defaultStrips, defaultReadouts, isCompact, channels) => {
    const fallbackTimeWinIdx = isCompact ? 1 : 1;
    const fallback = {
        strips: normalizeStrips(defaultStrips, channels),
        indexMode: 'time',
        readouts: normalizeReadouts(defaultReadouts, channels),
        timeWinIdx: fallbackTimeWinIdx,
        customTimeMinutes: DEFAULT_CUSTOM_TIME_MINUTES,
        customTimeRange: null,
        depthSpanIdx: 2
    };
    try {
        const localParsed = storageKey ? JSON.parse(localStorage.getItem(storageKey) || 'null') : null;
        const globalParsed = JSON.parse(localStorage.getItem(GLOBAL_EDR_PREFS_KEY) || 'null');
        let localStrips = null;
        if (Array.isArray(localParsed)) localStrips = localParsed;
        else if (localParsed?.strips) localStrips = localParsed.strips;
        
        const strips = normalizeStrips(localStrips, channels);

        const prefParsed = isCompact ? (localParsed || globalParsed) : globalParsed;

        const readouts = Array.isArray(prefParsed?.readouts)
            ? normalizeReadouts(prefParsed.readouts, channels)
            : fallback.readouts;

        return {
            strips: strips.length ? strips : fallback.strips,
            indexMode: prefParsed?.indexMode === 'depth' ? 'depth' : 'time',
            readouts,
            timeWinIdx: normalizeTimeWindowIndex(
                prefParsed?.timeWindowKey === CUSTOM_TIME_KEY
                    ? CUSTOM_TIME_KEY
                    : getTimeWindowIndexByRange(prefParsed?.timeWindowKey, fallbackTimeWinIdx),
                isCompact,
                fallbackTimeWinIdx
            ),
            customTimeMinutes: clampCustomMinutes(prefParsed?.customTimeMinutes),
            customTimeRange: normalizeCustomTimeRange(prefParsed?.customTimeRange),
            depthSpanIdx: getDepthSpanIndexByMeters(prefParsed?.depthSpanM, fallback.depthSpanIdx)
        };
    } catch (e) {
        return fallback;
    }
};

// ---------------------------------------------------------------------------
// Channel select (grouped by category)
// ---------------------------------------------------------------------------

function ChannelSelect({ value, onChange, channels, sx }) {
    const allowed = channels && channels.length
        ? new Set(channels)
        : null;
    const groups = edrCatalog.categories
        .map(cat => ({
            cat,
            fields: cat.fields.filter(f => !allowed || allowed.has(`${cat.id}.${f.id}`))
        }))
        .filter(g => g.fields.length);
    return (
        <Select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            size="small"
            MenuProps={{ PaperProps: { sx: { maxHeight: 360 } } }}
            sx={sx}
        >
            {groups.flatMap(({ cat, fields }) => [
                <ListSubheader key={`h-${cat.id}`} sx={{ fontWeight: 800, lineHeight: '30px', fontSize: '0.72rem', letterSpacing: 0.4 }}>
                    {cat.label.toUpperCase()}
                </ListSubheader>,
                ...fields.map(f => (
                    <MenuItem key={`${cat.id}.${f.id}`} value={`${cat.id}.${f.id}`} sx={{ fontSize: '0.82rem' }}>
                        {f.label}{f.unit ? ` (${f.unit})` : ''}
                    </MenuItem>
                ))
            ])}
        </Select>
    );
}

// ---------------------------------------------------------------------------
// Readouts config (multi-select from the catalog, grouped by category)
// ---------------------------------------------------------------------------

function ReadoutsConfig({ value, onChange, channels, surface, border, text, subText, accent }) {
    const allowed = channels && channels.length ? new Set(channels) : null;
    const groups = edrCatalog.categories
        .map(cat => ({
            cat,
            fields: cat.fields.filter(f => !allowed || allowed.has(`${cat.id}.${f.id}`))
        }))
        .filter(g => g.fields.length);

    const handleChange = (e) => {
        const next = typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value;
        onChange(normalizeReadouts(next, channels));
    };

    return (
        <FormControl size="small">
            <Select
                multiple
                displayEmpty
                value={value}
                onChange={handleChange}
                MenuProps={{ PaperProps: { sx: { maxHeight: 380, bgcolor: surface, color: text } } }}
                IconComponent={() => null}
                renderValue={() => (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, color: subText }}>
                        <SlidersHorizontal size={15} />
                        <Box component="span" sx={{ fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                            Readouts
                        </Box>
                    </Box>
                )}
                sx={{
                    color: text,
                    bgcolor: surface,
                    '& .MuiSelect-select': { py: 0.45, pl: 1, pr: '10px !important' },
                    '& .MuiOutlinedInput-notchedOutline': { borderColor: border },
                    '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: accent }
                }}
            >
                <ListSubheader sx={{ bgcolor: surface, color: subText, fontWeight: 800, fontSize: '0.66rem', lineHeight: '26px', letterSpacing: 0.4 }}>
                    PICK READOUTS ({value.length}/{MAX_READOUTS})
                </ListSubheader>
                {groups.flatMap(({ cat, fields }) => [
                    <ListSubheader key={`h-${cat.id}`} sx={{ bgcolor: surface, fontWeight: 800, lineHeight: '28px', fontSize: '0.7rem', letterSpacing: 0.4, color: subText }}>
                        {cat.label.toUpperCase()}
                    </ListSubheader>,
                    ...fields.map(f => {
                        const id = `${cat.id}.${f.id}`;
                        const checked = value.includes(id);
                        const atCap = !checked && value.length >= MAX_READOUTS;
                        return (
                            <MenuItem key={id} value={id} disabled={atCap} sx={{ py: 0.25, fontSize: '0.82rem' }}>
                                <Checkbox size="small" checked={checked} sx={{ p: 0.5, mr: 0.5, color: subText, '&.Mui-checked': { color: accent } }} />
                                <ListItemText
                                    primary={`${f.label}${f.unit ? ` (${f.unit})` : ''}`}
                                    primaryTypographyProps={{ sx: { fontSize: '0.82rem' } }}
                                />
                            </MenuItem>
                        );
                    })
                ])}
            </Select>
        </FormControl>
    );
}

// ---------------------------------------------------------------------------
// Big numeric readout tile (top row + left depth band share this look)
// ---------------------------------------------------------------------------

function ReadoutTile({ id, value, surface, border, text, subText, accent, valueColor, valueSize = '1.85rem', minWidth = 132, showCategory = true }) {
    const displayValue = channelDisplayValue(id, value);
    return (
        <Paper
            elevation={0}
            sx={{
                flex: '1 1 0',
                minWidth,
                bgcolor: surface,
                border: `1px solid ${border}`,
                borderRadius: 1.5,
                px: 1.5,
                py: 0.85,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: 0.1,
                position: 'relative',
                overflow: 'hidden'
            }}
        >
            <Box sx={{ position: 'absolute', left: 0, top: 6, bottom: 6, width: 3, borderRadius: 2, bgcolor: accent, opacity: 0.85 }} />
            <Typography sx={{ color: subText, fontSize: '0.62rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {channelLabel(id)}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5 }}>
                <Typography sx={{ color: valueColor || text, fontSize: valueSize, fontWeight: 900, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtValue(displayValue, channelPrecision(id))}
                </Typography>
                <Typography sx={{ color: subText, fontSize: '0.72rem', fontWeight: 700 }}>{channelUnit(id)}</Typography>
            </Box>
            {showCategory && (
                <Typography sx={{ color: subText, fontSize: '0.54rem', opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {channelCategory(id)}
                </Typography>
            )}
        </Paper>
    );
}

// ---------------------------------------------------------------------------
// Vertical scroll rail (up/down) — placed on BOTH left and right edges
// ---------------------------------------------------------------------------

function ScrollRail({ onUp, onDown, onHoldUp, onHoldDown, onHoldStop, upTip, downTip, downDisabled, text, border, top, bottom }) {
    const btnSx = {
        color: text,
        border: `1px solid ${border}`,
        borderRadius: 1,
        p: 0.35
    };
    // Press-and-hold: start a repeating scroll on pointer-down, stop on up/leave.
    // The onClick still fires for a quick tap = exactly one step.
    const holdProps = (onHold) => ({
        onPointerDown: (e) => { if (e.button === 0) onHold?.(); },
        onPointerUp: onHoldStop,
        onPointerLeave: onHoldStop,
        onPointerCancel: onHoldStop
    });
    return (
        <Box
            sx={{
                flex: '0 0 auto',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                alignItems: 'center',
                mt: `${top}px`,
                mb: `${bottom}px`
            }}
        >
            <MuiTooltip title={upTip} placement="left">
                <span><IconButton size="small" onClick={onUp} {...holdProps(onHoldUp)} sx={btnSx}><ChevronsUp size={16} /></IconButton></span>
            </MuiTooltip>
            <MuiTooltip title={downTip} placement="left">
                <span><IconButton size="small" onClick={onDown} disabled={downDisabled} {...(downDisabled ? {} : holdProps(onHoldDown))} sx={btnSx}><ChevronsDown size={16} /></IconButton></span>
            </MuiTooltip>
        </Box>
    );
}

// ---------------------------------------------------------------------------
// SVG strip chart
// ---------------------------------------------------------------------------

function StripChart({
    strip,
    samples,
    indexMode,
    indexDomain,
    accentColor,
    gridColor,
    axisTextColor,
    surface,
    border,
    subText,
    textColor,
    cursorFrac,
    onCursorMove
}) {
    const ref = useRef(null);
    const [size, setSize] = useState({ w: 240, h: 260 });
    // Hovered cursor position, in fractional [0..1] of chart height (null = no hover).
    // We keep only this lightweight state and recompute the tooltip contents on
    // render — updates are throttled via requestAnimationFrame in the move handler.

    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(entries => {
            const cr = entries[0]?.contentRect;
            if (cr) setSize({ w: Math.max(40, cr.width), h: Math.max(40, cr.height) });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const enabledPens = strip.pens.filter(p => p.enabled);
    const { w, h } = size;
    const padX = 6;
    const innerW = Math.max(1, w - padX * 2);
    const strokeWidth = 1.6;
    const padY = 0;
    const innerH = Math.max(1, h - padY * 2);

    // Vertical gridlines (5 columns).
    const vLines = [0.25, 0.5, 0.75].map(f => padX + f * innerW);
    // Horizontal gridlines map to the shared index domain.
    const [d0, d1] = indexDomain;
    const span = d1 - d0 || 1;
    const yFor = (idx) => Math.max(0, Math.min(h, padY + ((idx - d0) / span) * innerH));

    const hTickCount = Math.max(2, Math.min(8, Math.round(h / 48)));
    const hLines = Array.from({ length: hTickCount + 1 }, (_, i) => (i / hTickCount));

    // --- Hover crosshair / tooltip plumbing ---
    // Pointer Y -> fraction of height, scheduled on rAF so mousemove can't thrash.
    const handleMove = (e) => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (!rect.height) return;
        const frac = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        onCursorMove?.(frac);
    };

    // Index value under the cursor (timestamp in time mode, depth in depth mode).
    const cursorIndex = cursorFrac == null ? null : d0 + cursorFrac * span;

    // Nearest sample to the cursor index (linear scan — samples are sorted by
    // timestamp/depth; cheap for the ~window-sized buffers we hold).
    const nearestSample = useMemo(() => {
        if (cursorIndex == null || !samples.length) return null;
        const key = indexMode === 'depth' ? 'depth' : 'timestamp';
        let best = null;
        let bestDist = Infinity;
        for (let i = 0; i < samples.length; i += 1) {
            const iv = samples[i][key];
            if (!Number.isFinite(iv)) continue;
            const dist = Math.abs(iv - cursorIndex);
            if (dist < bestDist) { bestDist = dist; best = samples[i]; }
        }
        const span = indexDomain[1] - indexDomain[0] || 1;
        if (bestDist / span > 0.015) return null; // Only snap if within 1.5% of visible window
        return best;
    }, [cursorIndex, samples, indexMode, indexDomain]);

    const fmtIndex = (v) => (
        indexMode === 'depth'
            ? `${fmtScale(v)} m`
            : new Date(v).toLocaleString([], {
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            })
    );

    // Tooltip box geometry — clamp inside the strip and flip side near edges.
    const showTooltip = cursorFrac != null && nearestSample && enabledPens.length > 0;
    const tipRows = showTooltip
        ? enabledPens.map(pen => ({
            color: pen.color,
            name: channelLabel(pen.channelId),
            unit: channelUnit(pen.channelId),
            value: fmtValue(channelDisplayValue(pen.channelId, channelValue(nearestSample.values, pen.channelId)), channelPrecision(pen.channelId))
        }))
        : [];

    const buildPath = (pen) => {
        const range = pen.max - pen.min || 1;
        let dStr = '';
        let started = false;
        let prevIdx = null;
        let firstPoint = null;
        let lastPoint = null;
        for (let i = 0; i < samples.length; i += 1) {
            const s = samples[i];
            const raw = channelValue(s.values, pen.channelId);
            const idx = indexMode === 'depth' ? s.depth : s.timestamp;
            
            const isInvalidValue = raw == null || raw === '' || !Number.isFinite(Number(raw));
            const isInvalidIdx = idx == null || !Number.isFinite(Number(idx));
            
            if (isInvalidValue || isInvalidIdx) {
                started = false; // break the line over bad data
                continue;
            }

            if (prevIdx != null) {
                if (indexMode === 'time') {
                    const span = indexDomain[1] - indexDomain[0] || 1;
                    // Mirror backend's getHistoryWindowPeriod logic to calculate the exact expected interval
                    let expectedIntervalMs = 1000;
                    if (span <= 60 * 1000) expectedIntervalMs = 1000;
                    else if (span <= 5 * 60 * 1000) expectedIntervalMs = 2000;
                    else if (span <= 15 * 60 * 1000) expectedIntervalMs = 5000;
                    else if (span <= 30 * 60 * 1000) expectedIntervalMs = 15000;
                    else if (span <= 60 * 60 * 1000) expectedIntervalMs = 60000;
                    else if (span <= 2 * 60 * 60 * 1000) expectedIntervalMs = 2 * 60000;
                    else if (span <= 4 * 60 * 60 * 1000) expectedIntervalMs = 5 * 60000;
                    else if (span <= 6 * 60 * 60 * 1000) expectedIntervalMs = 10 * 60000;
                    else if (span <= 12 * 60 * 60 * 1000) expectedIntervalMs = 15 * 60000;
                    else if (span <= 24 * 60 * 60 * 1000) expectedIntervalMs = 30 * 60000;
                    else if (span <= 3 * 24 * 60 * 60 * 1000) expectedIntervalMs = 60 * 60000;
                    else if (span <= 7 * 24 * 60 * 60 * 1000) expectedIntervalMs = 2 * 60 * 60000;
                    else if (span <= 30 * 24 * 60 * 60 * 1000) expectedIntervalMs = 6 * 60 * 60000;
                    else expectedIntervalMs = 24 * 60 * 60000;

                    // Allow PLC/socket jitter without breaking short-range lines.
                    const gapThreshold = Math.max(expectedIntervalMs * 6, 15 * 1000);
                    if (idx - prevIdx > gapThreshold) started = false;
                } else if (indexMode === 'depth' && Math.abs(idx - prevIdx) > 0.5) {
                    started = false; // gap > 0.5m
                }
            }
            prevIdx = idx;

            const displayValue = channelDisplayValue(pen.channelId, raw);
            const clamped = Math.max(pen.min, Math.min(pen.max, Number(displayValue)));
            const x = padX + ((clamped - pen.min) / range) * innerW;
            const y = yFor(idx);
            if (!firstPoint) firstPoint = { x, idx };
            lastPoint = { x, idx };
            dStr += `${started ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
            started = true;
        }
        if (firstPoint && Math.abs(firstPoint.idx - d0) / span <= 0.04) {
            dStr = `M${firstPoint.x.toFixed(2)},0.00L${firstPoint.x.toFixed(2)},${yFor(firstPoint.idx).toFixed(2)}${dStr.replace(/^M[^L]+/, '')}`;
        }
        if (lastPoint && Math.abs(d1 - lastPoint.idx) / span <= 0.04) {
            dStr += `L${lastPoint.x.toFixed(2)},${h.toFixed(2)}`;
        }
        return dStr;
    };

    // Current value position for the thin marker (latest sample with a value).
    const markerFor = (pen) => {
        for (let i = samples.length - 1; i >= 0; i -= 1) {
            const raw = channelValue(samples[i].values, pen.channelId);
            if (raw != null && raw !== '' && Number.isFinite(Number(raw))) {
                const range = pen.max - pen.min || 1;
                const displayValue = channelDisplayValue(pen.channelId, raw);
                const clamped = Math.max(pen.min, Math.min(pen.max, Number(displayValue)));
                return padX + ((clamped - pen.min) / range) * innerW;
            }
        }
        return null;
    };

    return (
        <Box
            ref={ref}
            onPointerMove={handleMove}
            sx={{ position: 'relative', width: '100%', height: '100%' }}
        >
            <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
                {/* horizontal index gridlines */}
                {hLines.map((f, i) => (
                    <line key={`h${i}`} x1={0} x2={w} y1={f * h} y2={f * h} stroke={gridColor} strokeWidth={0.5} />
                ))}
                {/* vertical scale gridlines */}
                {vLines.map((x, i) => (
                    <line key={`v${i}`} x1={x} x2={x} y1={0} y2={h} stroke={gridColor} strokeWidth={0.5} />
                ))}
                {/* pens */}
                {enabledPens.map((pen, i) => (
                    <path
                        key={`p${i}`}
                        d={buildPath(pen)}
                        fill="none"
                        stroke={pen.color}
                        strokeWidth={strokeWidth}
                        strokeLinejoin="round"
                        strokeLinecap="butt"
                        vectorEffect="non-scaling-stroke"
                        style={{ transition: 'opacity 160ms ease-out' }}
                    />
                ))}
                {/* thin current-value markers */}
                {indexMode === 'depth' && enabledPens.map((pen, i) => {
                    const mx = markerFor(pen);
                    if (mx == null) return null;
                    return (
                        <line
                            key={`m${i}`}
                            x1={mx}
                            x2={mx}
                            y1={0}
                            y2={h}
                            stroke={pen.color}
                            strokeWidth={0.75}
                            strokeDasharray="2 3"
                            opacity={0.5}
                            vectorEffect="non-scaling-stroke"
                        />
                    );
                })}
                {/* hover crosshair (thin horizontal cursor line at the hovered index) */}
                {cursorFrac != null && (
                    <line
                        x1={0}
                        x2={w}
                        y1={cursorFrac * h}
                        y2={cursorFrac * h}
                        stroke={accentColor}
                        strokeWidth={1}
                        opacity={0.85}
                        pointerEvents="none"
                        vectorEffect="non-scaling-stroke"
                    />
                )}
            </svg>
            {/* hover tooltip — index value + per-pen color/name/value at nearest sample */}
            {showTooltip && (
                <Box
                    sx={{
                        position: 'absolute',
                        left: cursorFrac > 0.5 ? 4 : 'auto',
                        right: cursorFrac > 0.5 ? 'auto' : 4,
                        // place near the cursor but keep the box on-screen vertically
                        top: cursorFrac > 0.6 ? 'auto' : `${Math.max(2, cursorFrac * 100)}%`,
                        bottom: cursorFrac > 0.6 ? `${Math.max(2, (1 - cursorFrac) * 100)}%` : 'auto',
                        zIndex: 5,
                        pointerEvents: 'none',
                        bgcolor: surface,
                        border: `1px solid ${border}`,
                        borderRadius: 1,
                        boxShadow: 3,
                        px: 0.85,
                        py: 0.6,
                        maxWidth: '92%',
                        minWidth: 0
                    }}
                >
                    <Typography sx={{ color: subText, fontSize: '0.6rem', fontWeight: 800, letterSpacing: 0.3, mb: 0.35, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                        {fmtIndex(cursorIndex)}
                    </Typography>
                    {tipRows.map((r, i) => (
                        <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, lineHeight: 1.25 }}>
                            <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: r.color, flex: '0 0 auto' }} />
                            <Typography component="span" sx={{ color: textColor, fontSize: '0.62rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 }}>
                                {r.name}
                            </Typography>
                            <Typography component="span" sx={{ color: r.color, fontSize: '0.66rem', fontWeight: 900, ml: 'auto', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                                {r.value}{r.unit ? <Box component="span" sx={{ color: subText, fontSize: '0.85em', fontWeight: 700, ml: 0.25 }}>{r.unit}</Box> : null}
                            </Typography>
                        </Box>
                    ))}
                </Box>
            )}
            {enabledPens.length === 0 && (
                <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
                    <Typography sx={{ color: axisTextColor, fontSize: '0.7rem', opacity: 0.6 }}>No pens</Typography>
                </Box>
            )}
        </Box>
    );
}

const MemoStripChart = React.memo(StripChart);

// ---------------------------------------------------------------------------
// Fixed-height bottom "variables" block — the critical requirement.
//
// Always exactly BOTTOM_H tall. Content adapts to pen count so 1 pen is
// comfortable and 3 pens still fit the SAME height. Compaction order as the
// per-row height shrinks: (1) smaller font, (2) drop min…max scale, (3) drop
// NAME (keep unit), (4) keep only the color-coded VALUE.
// ---------------------------------------------------------------------------

function StripVariables({ strip, latest, compact, surface, border, subText }) {
    const BOTTOM_H = compact ? 64 : 96;
    const enabledPens = strip.pens.filter(p => p.enabled);
    const n = Math.max(1, enabledPens.length);
    const rowH = BOTTOM_H / Math.max(n, compact ? 2 : 1); // reserve at least 2 slots in compact

    // Compaction thresholds keyed off available per-row height.
    const fontValue = rowH >= 40 ? '1.15rem' : rowH >= 30 ? '0.98rem' : rowH >= 22 ? '0.86rem' : '0.78rem';
    const fontMeta = rowH >= 30 ? '0.62rem' : '0.58rem';
    const showScale = rowH >= 30;     // (2) drop scale first
    const showName = rowH >= 24;      // (3) then name (keep unit)

    return (
        <Box
            sx={{
                flex: `0 0 ${BOTTOM_H}px`,
                height: BOTTOM_H,
                mt: 0.5,
                bgcolor: surface,
                border: `1px solid ${border}`,
                borderRadius: 1,
                px: 0.75,
                py: 0.5,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-evenly',
                overflow: 'hidden'
            }}
        >
            {enabledPens.length === 0 ? (
                <Typography sx={{ color: subText, fontSize: '0.7rem', textAlign: 'center', alignSelf: 'center' }}>—</Typography>
            ) : enabledPens.map((pen, i) => {
                const unit = channelUnit(pen.channelId);
                const value = channelDisplayValue(pen.channelId, channelValue(latest, pen.channelId));
                // Full-detail tooltip so a compacted row (unit-only / value-only) is
                // still identifiable on hover: Name (unit) · min…max · current value.
                const tipTitle = `${channelLabel(pen.channelId)}${unit ? ` (${unit})` : ''} · ${fmtScale(pen.min)}…${fmtScale(pen.max)} · ${fmtValue(value, channelPrecision(pen.channelId))}${unit ? ` ${unit}` : ''}`;
                return (
                    <MuiTooltip key={i} title={tipTitle} placement="top" arrow>
                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.6,
                            minWidth: 0,
                            lineHeight: 1.05,
                            cursor: 'default'
                        }}
                    >
                        <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: pen.color, flex: '0 0 auto' }} />
                        <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                            <Typography
                                component="div"
                                sx={{
                                    color: subText,
                                    fontSize: fontMeta,
                                    fontWeight: 700,
                                    textTransform: 'uppercase',
                                    letterSpacing: 0.2,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                }}
                            >
                                {/* compaction (3): drop NAME, keep unit */}
                                {showName
                                    ? `${channelLabel(pen.channelId)}${unit ? ` (${unit})` : ''}`
                                    : (unit || channelLabel(pen.channelId))}
                                {/* compaction (2): drop min…max scale first */}
                                {showScale && (
                                    <Box component="span" sx={{ opacity: 0.7, ml: 0.5 }}>
                                        · {fmtScale(pen.min)}…{fmtScale(pen.max)}
                                    </Box>
                                )}
                            </Typography>
                        </Box>
                        <Typography
                            sx={{
                                color: pen.color,
                                fontSize: fontValue,
                                fontWeight: 900,
                                fontVariantNumeric: 'tabular-nums',
                                whiteSpace: 'nowrap',
                                flex: '0 0 auto'
                            }}
                        >
                            {fmtValue(value, channelPrecision(pen.channelId))}
                            {/* compaction (4): when name+unit are dropped from the meta line, keep unit beside the value */}
                            {!showName && unit ? (
                                <Box component="span" sx={{ fontSize: '0.6em', ml: 0.3, color: subText, fontWeight: 700 }}>{unit}</Box>
                            ) : null}
                        </Typography>
                    </Box>
                    </MuiTooltip>
                );
            })}
        </Box>
    );
}

// ---------------------------------------------------------------------------
// Depth track — the leftmost EDR column.
//
// Reuses the EXACT same row metrics as a pen strip (header height, chart band,
// fixed bottom-block height) so it is header-aligned and baseline-aligned with
// every other strip. The chart band hosts the shared depth/time axis: the same
// horizontal gridlines the strips draw (same hTickCount formula keyed off the
// measured chart height) plus tick labels sitting ON those gridlines, so a
// viewer reads the index across all strips on the same rows. A thin hole-depth
// trace is drawn in depth mode where the bin data supports it. The fixed bottom
// block holds the live HOLE DEPTH + BIT DEPTH readouts on the shared baseline.
//
// Drag-to-scroll on the chart band mirrors the old standalone axis behaviour.
// ---------------------------------------------------------------------------

function DepthAxisChart({
    indexMode,
    indexDomain,
    axisTicks,
    samples,
    maxDepth,
    gridColor,
    subText,
    accent,
    onPointerDown,
    onPointerMove,
    onPointerUp
}) {
    const ref = useRef(null);
    const [size, setSize] = useState({ w: 60, h: 260 });

    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(entries => {
            const cr = entries[0]?.contentRect;
            if (cr) setSize({ w: Math.max(20, cr.width), h: Math.max(40, cr.height) });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const { w, h } = size;

    // SAME horizontal gridline math as StripChart so labels land on the exact
    // rows the strips draw their gridlines.
    const hTickCount = Math.max(2, Math.min(8, Math.round(h / 48)));
    const hLines = Array.from({ length: hTickCount + 1 }, (_, i) => (i / hTickCount));

    // Thin hole-depth trace (depth mode only — the index IS depth, so the trace
    // is a monotonic diagonal that visually ties depth to the gridlines).
    const [d0, d1] = indexDomain;
    const span = d1 - d0 || 1;
    const depthTracePath = useMemo(() => {
        if (indexMode !== 'depth' || !samples.length) return '';
        // In depth mode the y-position already encodes depth; draw a guide line
        // from the top of the visible window down to the current max depth so the
        // operator sees how much of the window holds real (drilled) hole.
        const yMax = Math.max(0, Math.min(1, (maxDepth - d0) / span)) * h;
        if (yMax <= 0) return '';
        const x = w * 0.5;
        return `M${x.toFixed(2)},0L${x.toFixed(2)},${yMax.toFixed(2)}`;
    }, [indexMode, samples.length, maxDepth, d0, span, h, w]);

    return (
        <Box
            ref={ref}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            sx={{ position: 'relative', width: '100%', height: '100%', cursor: 'ns-resize', userSelect: 'none', touchAction: 'none' }}
        >
            <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
                {/* SAME horizontal gridlines as the strips */}
                {hLines.map((f, i) => (
                    <line key={`h${i}`} x1={0} x2={w} y1={f * h} y2={f * h} stroke={gridColor} strokeWidth={0.5} />
                ))}
                {/* thin hole-depth guide trace (depth mode) */}
                {depthTracePath && (
                    <path
                        d={depthTracePath}
                        fill="none"
                        stroke="#22d3ee"
                        strokeWidth={2}
                        strokeLinecap="round"
                        opacity={0.85}
                        vectorEffect="non-scaling-stroke"
                    />
                )}
            </svg>
            {/* axis unit caption */}
            <Typography sx={{ position: 'absolute', top: 4, left: 0, right: 0, textAlign: 'center', fontSize: '0.6rem', fontWeight: 800, color: subText, textTransform: 'uppercase', pointerEvents: 'none' }}>
                {indexMode === 'depth' ? 'm' : 'time'}
            </Typography>
            {/* tick labels pinned to the gridline fractions (axisTicks share the same domain) */}
            {axisTicks.map((t, i) => (
                <Box key={i} sx={{ position: 'absolute', left: 0, right: 0, top: `${(t.labelFrac ?? t.frac) * 100}%`, transform: 'translateY(-50%)', px: 0.25, pointerEvents: 'none' }}>
                    <Typography sx={{ fontSize: '0.62rem', color: subText, textAlign: 'center', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {t.label}
                    </Typography>
                </Box>
            ))}
        </Box>
    );
}

function DepthTrack({
    indexMode,
    indexDomain,
    axisTicks,
    samples,
    maxDepth,
    holeDepthVal,
    bitDepthVal,
    headerH,
    bottomH,
    chartBg,
    panelBg,
    border,
    gridColor,
    text,
    subText,
    accent,
    onPointerDown,
    onPointerMove,
    onPointerUp
}) {
    // HOLE / BIT depth as the bottom block, on the SAME baseline + height as the
    // strips' StripVariables block. We mirror StripVariables' geometry (fixed
    // BOTTOM_H, mt: 0.5) exactly rather than hardcoding divergent values.
    const rows = [
        { id: HOLE_DEPTH_METRIC, value: holeDepthVal, color: '#22d3ee' },
        { id: BIT_DEPTH_METRIC, value: bitDepthVal, color: '#fbbf24' }
    ];
    return (
        <Box sx={{ flex: '0 0 132px', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {/* header — same height/style as a strip header, titled DEPTH */}
            <Box sx={{ height: headerH, display: 'flex', alignItems: 'center', gap: 0.5, mb: '4px' }}>
                <Gauge size={14} color={subText} style={{ flex: '0 0 auto' }} />
                <Typography sx={{ flex: 1, minWidth: 0, color: text, fontSize: '0.74rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    Depth
                </Typography>
            </Box>
            {/* chart band — same chartTop..chartBottom band as the strips; hosts the depth axis */}
            <Box sx={{ flex: '1 1 auto', minHeight: 0, bgcolor: chartBg, border: `1px solid ${border}`, borderRadius: 1, overflow: 'hidden' }}>
                <DepthAxisChart
                    indexMode={indexMode}
                    indexDomain={indexDomain}
                    axisTicks={axisTicks}
                    samples={samples}
                    maxDepth={maxDepth}
                    gridColor={gridColor}
                    subText={subText}
                    accent={accent}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                />
            </Box>
            {/* fixed-height bottom block — mirrors StripVariables geometry for an exact baseline match */}
            <Box
                sx={{
                    flex: `0 0 ${bottomH}px`,
                    height: bottomH,
                    mt: 0.5,
                    bgcolor: panelBg,
                    border: `1px solid ${border}`,
                    borderRadius: 1,
                    px: 0.75,
                    py: 0.5,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-evenly',
                    overflow: 'hidden'
                }}
            >
                {rows.map((r) => {
                    const unit = channelUnit(r.id);
                    return (
                        <Box key={r.id} sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.05 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
                                <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: r.color, flex: '0 0 auto' }} />
                                <Typography sx={{ color: subText, fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {channelLabel(r.id)}
                                </Typography>
                            </Box>
                            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.4, pl: 1.4 }}>
                                <Typography sx={{ color: text, fontSize: '1.35rem', fontWeight: 900, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>
                                    {fmtValue(r.value, channelPrecision(r.id))}
                                </Typography>
                                <Typography sx={{ color: subText, fontSize: '0.66rem', fontWeight: 700 }}>{unit}</Typography>
                            </Box>
                        </Box>
                    );
                })}
            </Box>
        </Box>
    );
}

// ---------------------------------------------------------------------------
// Per-strip config dialog
// ---------------------------------------------------------------------------

function StripConfigDialog({ open, onClose, strip, stripIndex, onSave, channels, surface, border, text, subText }) {
    const [draft, setDraft] = useState(strip);
    useEffect(() => { if (open) setDraft(JSON.parse(JSON.stringify(strip))); }, [open, strip]);

    const updatePen = (pi, patch) => {
        setDraft(prev => ({
            ...prev,
            pens: prev.pens.map((p, i) => (i === pi ? { ...p, ...patch } : p))
        }));
    };
    const onChannel = (pi, channelId) => {
        const meta = METRIC_LOOKUP.get(channelId);
        updatePen(pi, {
            channelId,
            min: meta?.defaultMin ?? 0,
            max: meta?.defaultMax ?? 1
        });
    };
    const addPen = () => {
        setDraft(prev => ({
            ...prev,
            pens: [...prev.pens, normalizePen({ channelId: (channels && channels[0]) || ALL_METRIC_IDS[0] }, prev.pens.length, channels)]
        }));
    };
    const removePen = (pi) => {
        setDraft(prev => ({ ...prev, pens: prev.pens.filter((_, i) => i !== pi) }));
    };

    const fieldSx = { '& .MuiInputBase-root': { color: text }, '& .MuiOutlinedInput-notchedOutline': { borderColor: border } };

    return (
        <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ sx: { bgcolor: surface, color: text, border: `1px solid ${border}` } }}>
            <DialogTitle sx={{ fontWeight: 900, borderBottom: `1px solid ${border}`, fontSize: '1rem' }}>
                Configure “{strip.title}”
            </DialogTitle>
            <DialogContent dividers sx={{ borderColor: border }}>
                <TextField
                    label="Track title"
                    value={draft.title}
                    onChange={(e) => setDraft(prev => ({ ...prev, title: e.target.value }))}
                    size="small"
                    fullWidth
                    sx={{ ...fieldSx, mb: 2 }}
                />
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                    {draft.pens.map((pen, pi) => (
                        <Paper key={pi} sx={{ p: 1.25, bgcolor: 'transparent', border: `1px solid ${border}`, borderRadius: 1 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                <IconButton
                                    size="small"
                                    onClick={() => updatePen(pi, { enabled: !pen.enabled })}
                                    sx={{ color: pen.enabled ? pen.color : subText }}
                                    title={pen.enabled ? 'Pen on' : 'Pen off'}
                                >
                                    <Box sx={{ width: 14, height: 14, borderRadius: '3px', bgcolor: pen.enabled ? pen.color : 'transparent', border: `2px solid ${pen.color}` }} />
                                </IconButton>
                                <FormControl size="small" fullWidth>
                                    <ChannelSelect
                                        value={pen.channelId}
                                        onChange={(v) => onChannel(pi, v)}
                                        channels={channels}
                                        sx={{ color: text, '& .MuiOutlinedInput-notchedOutline': { borderColor: border } }}
                                    />
                                </FormControl>
                                <IconButton size="small" onClick={() => removePen(pi)} sx={{ color: subText }} title="Remove pen">
                                    <Trash2 size={16} />
                                </IconButton>
                            </Box>
                            <Grid container spacing={1}>
                                <Grid item xs={4}>
                                    <TextField
                                        label="Min" type="number" size="small" fullWidth sx={fieldSx}
                                        value={pen.min}
                                        onChange={(e) => updatePen(pi, { min: Number(e.target.value) })}
                                    />
                                </Grid>
                                <Grid item xs={4}>
                                    <TextField
                                        label="Max" type="number" size="small" fullWidth sx={fieldSx}
                                        value={pen.max}
                                        onChange={(e) => updatePen(pi, { max: Number(e.target.value) })}
                                    />
                                </Grid>
                                <Grid item xs={4}>
                                    <TextField
                                        label="Color" type="color" size="small" fullWidth
                                        sx={{ ...fieldSx, '& input': { height: 23, p: '4px' } }}
                                        value={COLOR_RE.test(pen.color) ? pen.color : '#38bdf8'}
                                        onChange={(e) => updatePen(pi, { color: e.target.value })}
                                    />
                                </Grid>
                            </Grid>
                        </Paper>
                    ))}
                </Box>
                <Button
                    startIcon={<Plus size={16} />}
                    onClick={addPen}
                    disabled={draft.pens.length >= MAX_PENS}
                    sx={{ mt: 1.5, color: text, borderColor: border }}
                    variant="outlined"
                    size="small"
                >
                    Add pen ({draft.pens.length}/{MAX_PENS})
                </Button>
            </DialogContent>
            <DialogActions sx={{ borderTop: `1px solid ${border}`, p: 1.5 }}>
                <Button onClick={onClose} sx={{ color: subText }}>Cancel</Button>
                <Button
                    variant="contained"
                    onClick={() => { onSave(stripIndex, normalizeStrips([draft], channels)[0]); onClose(); }}
                >
                    Apply
                </Button>
            </DialogActions>
        </Dialog>
    );
}

function CustomTimeDialog({ open, onClose, value, onApply, surface, border, text, subText, accent }) {
    const now = Date.now();
    const [draft, setDraft] = useState(() => ({
        start: toDateTimeLocal(value?.start || now - 60 * 60 * 1000),
        stop: toDateTimeLocal(value?.stop || now)
    }));

    useEffect(() => {
        if (!open) return;
        const freshNow = Date.now();
        setDraft({
            start: toDateTimeLocal(value?.start || freshNow - 60 * 60 * 1000),
            stop: toDateTimeLocal(value?.stop || freshNow)
        });
    }, [open, value]);

    const valid = new Date(draft.stop).getTime() > new Date(draft.start).getTime();
    const fieldSx = {
        '& .MuiInputBase-root': { color: text },
        '& .MuiInputLabel-root': { color: subText },
        '& .MuiOutlinedInput-notchedOutline': { borderColor: border },
        '& input': { colorScheme: 'dark' }
    };

    return (
        <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth PaperProps={{ sx: { bgcolor: surface, color: text, border: `1px solid ${border}` } }}>
            <DialogTitle sx={{ fontWeight: 900, borderBottom: `1px solid ${border}` }}>Custom Time Range</DialogTitle>
            <DialogContent sx={{ pt: 2.5 }}>
                <Grid container spacing={2}>
                    <Grid item xs={12}>
                        <TextField
                            fullWidth
                            size="small"
                            type="datetime-local"
                            label="From"
                            value={draft.start}
                            onChange={(e) => setDraft(prev => ({ ...prev, start: e.target.value }))}
                            InputLabelProps={{ shrink: true }}
                            sx={fieldSx}
                        />
                    </Grid>
                    <Grid item xs={12}>
                        <TextField
                            fullWidth
                            size="small"
                            type="datetime-local"
                            label="To"
                            value={draft.stop}
                            onChange={(e) => setDraft(prev => ({ ...prev, stop: e.target.value }))}
                            InputLabelProps={{ shrink: true }}
                            sx={fieldSx}
                        />
                    </Grid>
                </Grid>
                {!valid && (
                    <Typography sx={{ color: '#fb7185', fontSize: '0.78rem', mt: 1.5, fontWeight: 700 }}>
                        To time must be after From time.
                    </Typography>
                )}
            </DialogContent>
            <DialogActions sx={{ borderTop: `1px solid ${border}`, p: 1.5 }}>
                <Button onClick={onClose} sx={{ color: subText }}>Cancel</Button>
                <Button
                    variant="contained"
                    disabled={!valid}
                    onClick={() => {
                        onApply({
                            start: new Date(draft.start).getTime(),
                            stop: new Date(draft.stop).getTime()
                        });
                        onClose();
                    }}
                    sx={{ bgcolor: accent, fontWeight: 900 }}
                >
                    Apply
                </Button>
            </DialogActions>
        </Dialog>
    );
}

function EdrExportDialog({ open, onClose, defaultMetrics, fetchRows, surface, border, text, subText, accent }) {
    const [format, setFormat] = useState('xlsx');
    const [selected, setSelected] = useState(() => new Set(defaultMetrics));
    const [range, setRange] = useState('-1h');
    const [custom, setCustom] = useState(() => ({
        start: toDateTimeLocal(Date.now() - 60 * 60 * 1000),
        stop: toDateTimeLocal(Date.now())
    }));
    const [useCustom, setUseCustom] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!open) return;
        setSelected(new Set(defaultMetrics));
        setError('');
    }, [open, defaultMetrics]);

    const selectedMetrics = Array.from(selected);
    const toggleMetric = (id) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };
    const setAll = (enabled) => {
        setSelected(enabled ? new Set(METRIC_OPTIONS.map(o => o.id)) : new Set());
    };
    const fieldSx = {
        '& .MuiInputBase-root': { color: text, bgcolor: 'rgba(15,23,42,0.45)' },
        '& .MuiInputLabel-root': { color: subText },
        '& .MuiOutlinedInput-notchedOutline': { borderColor: border },
        '& input': { colorScheme: 'dark' }
    };
    const activeRangeLabel = useCustom
        ? `${custom.start || 'from'} to ${custom.stop || 'to'}`
        : EXPORT_RANGES.find(r => r.key === range)?.label?.toLowerCase() || range;

    const runExport = async () => {
        if (!selectedMetrics.length) {
            setError('Select at least one parameter.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            const historyRows = await fetchRows({
                metrics: selectedMetrics,
                range: useCustom ? null : range,
                start: useCustom ? fromDateTimeLocal(custom.start) : null,
                stop: useCustom ? fromDateTimeLocal(custom.stop) : null
            });
            if (!historyRows.length) throw new Error('No data found for selected range.');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            if (format === 'png') {
                await exportRowsAsPng(historyRows, selectedMetrics, `edr-export-${stamp}.png`);
            } else {
                const rows = buildExportRows(historyRows, selectedMetrics);
                if (format === 'csv') exportRowsAsCsv(rows, `edr-export-${stamp}.csv`);
                else exportRowsAsXlsx(rows, `edr-export-${stamp}.xlsx`);
            }
        } catch (err) {
            setError(err?.message || 'Export failed.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" PaperProps={{ sx: { bgcolor: '#334155', color: text, border: `1px solid ${border}`, backgroundImage: 'none' } }}>
            <DialogTitle sx={{ fontWeight: 900, fontSize: '1.5rem', display: 'flex', alignItems: 'center', gap: 1, borderBottom: `1px solid ${border}` }}>
                <Download size={26} color="#fbbf24" /> Export Data
                <IconButton onClick={onClose} sx={{ ml: 'auto', color: subText }}><X size={22} /></IconButton>
            </DialogTitle>
            <DialogContent sx={{ pt: 2.5 }}>
                <Typography sx={{ color: subText, fontSize: '0.78rem', fontWeight: 900, letterSpacing: 2, mb: 1.25 }}>
                    EXPORT FORMAT
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1.5, mb: 3 }}>
                    {[
                        { id: 'xlsx', label: 'EXCEL (.XLSX)', icon: <FileSpreadsheet size={20} /> },
                        { id: 'csv', label: 'CSV (.CSV)', icon: <FileText size={20} /> },
                        { id: 'png', label: 'GRAPH (.PNG)', icon: <ImageIcon size={20} /> }
                    ].map(opt => (
                        <Button
                            key={opt.id}
                            variant={format === opt.id ? 'contained' : 'outlined'}
                            onClick={() => setFormat(opt.id)}
                            startIcon={opt.icon}
                            sx={{
                                height: 56,
                                justifyContent: 'center',
                                fontWeight: 900,
                                color: format === opt.id ? '#061018' : text,
                                bgcolor: format === opt.id ? '#22c55e' : 'transparent',
                                borderColor: border,
                                '&:hover': { bgcolor: format === opt.id ? '#22c55e' : 'rgba(148,163,184,0.12)' }
                            }}
                        >
                            {opt.label}
                        </Button>
                    ))}
                </Box>

                <Typography sx={{ color: subText, fontSize: '0.78rem', fontWeight: 900, letterSpacing: 2, mb: 1.25 }}>
                    SELECT PARAMETERS TO EXPORT
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, mb: 1.25 }}>
                    <Button size="small" onClick={() => setAll(true)} sx={{ bgcolor: 'rgba(148,163,184,0.16)', color: text, fontWeight: 800 }}>Select All</Button>
                    <Button size="small" onClick={() => setAll(false)} sx={{ bgcolor: 'rgba(148,163,184,0.16)', color: text, fontWeight: 800 }}>Deselect All</Button>
                </Box>
                <Box sx={{ maxHeight: 220, overflow: 'auto', bgcolor: '#1f2937', borderRadius: 1, border: `1px solid ${border}`, p: 1, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 0.75 }}>
                    {METRIC_OPTIONS.map(metric => {
                        const checked = selected.has(metric.id);
                        return (
                            <Button
                                key={metric.id}
                                onClick={() => toggleMetric(metric.id)}
                                startIcon={<Checkbox checked={checked} sx={{ p: 0, color: subText, '&.Mui-checked': { color: '#fbbf24' } }} />}
                                sx={{
                                    justifyContent: 'flex-start',
                                    textTransform: 'none',
                                    color: checked ? '#fbbf24' : subText,
                                    border: `1px solid ${checked ? '#fbbf24' : 'transparent'}`,
                                    bgcolor: checked ? 'rgba(251,191,36,0.14)' : 'transparent',
                                    fontWeight: 800,
                                    overflow: 'hidden'
                                }}
                            >
                                <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{metric.label}</Box>
                            </Button>
                        );
                    })}
                </Box>

                <Typography sx={{ color: subText, fontSize: '0.78rem', fontWeight: 900, letterSpacing: 2, mt: 3, mb: 1.25 }}>
                    QUICK SELECT
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2.5 }}>
                    {EXPORT_RANGES.map(opt => (
                        <Button
                            key={opt.key}
                            onClick={() => { setRange(opt.key); setUseCustom(false); }}
                            variant={!useCustom && range === opt.key ? 'contained' : 'outlined'}
                            sx={{
                                minWidth: 138,
                                color: !useCustom && range === opt.key ? '#111827' : text,
                                bgcolor: !useCustom && range === opt.key ? '#fbbf24' : 'transparent',
                                borderColor: border,
                                fontWeight: 900
                            }}
                        >
                            {opt.label}
                        </Button>
                    ))}
                </Box>

                <Typography sx={{ color: subText, fontSize: '0.78rem', fontWeight: 900, letterSpacing: 2, mb: 1.25 }}>
                    CUSTOM DATE RANGE
                </Typography>
                <Grid container spacing={2}>
                    <Grid item xs={12} md={6}>
                        <TextField
                            fullWidth
                            type="datetime-local"
                            label="From"
                            value={custom.start}
                            onFocus={() => setUseCustom(true)}
                            onChange={(e) => { setCustom(prev => ({ ...prev, start: e.target.value })); setUseCustom(true); }}
                            InputLabelProps={{ shrink: true }}
                            sx={fieldSx}
                        />
                    </Grid>
                    <Grid item xs={12} md={6}>
                        <TextField
                            fullWidth
                            type="datetime-local"
                            label="To"
                            value={custom.stop}
                            onFocus={() => setUseCustom(true)}
                            onChange={(e) => { setCustom(prev => ({ ...prev, stop: e.target.value })); setUseCustom(true); }}
                            InputLabelProps={{ shrink: true }}
                            sx={fieldSx}
                        />
                    </Grid>
                </Grid>

                <Paper sx={{ mt: 2.5, p: 2, bgcolor: '#111827', color: text, border: `1px solid ${border}` }}>
                    <Typography sx={{ fontWeight: 700 }}>
                        Will export <Box component="span" sx={{ color: '#fbbf24', fontWeight: 900 }}>{activeRangeLabel}</Box> data for{' '}
                        <Box component="span" sx={{ color: accent, fontWeight: 900 }}>{selectedMetrics.length} selected parameters</Box>.
                    </Typography>
                    {error && <Typography sx={{ color: '#fb7185', mt: 1, fontWeight: 800 }}>{error}</Typography>}
                </Paper>
            </DialogContent>
            <DialogActions sx={{ p: 2, borderTop: `1px solid ${border}` }}>
                <Button onClick={onClose} sx={{ color: subText, fontWeight: 900 }}>Cancel</Button>
                <Button
                    onClick={runExport}
                    disabled={busy || selectedMetrics.length === 0}
                    startIcon={<Download size={18} />}
                    variant="contained"
                    sx={{ bgcolor: '#22c55e', color: '#061018', fontWeight: 900, minWidth: 180 }}
                >
                    {busy ? 'EXPORTING...' : `DOWNLOAD ${format.toUpperCase()}`}
                </Button>
            </DialogActions>
        </Dialog>
    );
}

// ---------------------------------------------------------------------------
// EdrView main
// ---------------------------------------------------------------------------

export default function EdrView({
    mode = 'full',
    storageKey,
    defaultStrips = [],
    rightReadouts = [],
    channels = null
}) {
    const theme = useTheme();
    const isCompact = mode === 'compact';

    // Theme-derived tokens (work across all 4 themes).
    const isDark = theme.palette.mode === 'dark';
    const panelBg = theme.palette.background.paper;
    const chartBg = isDark ? 'rgba(0,0,0,0.55)' : 'rgba(15,23,42,0.04)';
    const border = isDark ? 'rgba(148,163,184,0.28)' : 'rgba(15,23,42,0.18)';
    const gridColor = isDark ? 'rgba(148,163,184,0.18)' : 'rgba(15,23,42,0.12)';
    const text = theme.palette.text.primary;
    const subText = theme.palette.text.secondary || (isDark ? '#94a3b8' : '#475569');
    const accent = theme.palette.primary.main;

    // Local state combining UI preferences + data viewport
    const [config, setConfig] = useState(() => loadPersisted(storageKey, defaultStrips, rightReadouts, isCompact, channels));
    const initial = config;
    const { strips, indexMode } = config;
    const [readouts, setReadouts] = useState(initial.readouts);

    const [timeWinIdx, setTimeWinIdx] = useState(initial.timeWinIdx);
    const [toolbarTimeWinIdx, setToolbarTimeWinIdx] = useState(initial.timeWinIdx);
    const [customTimeMinutes, setCustomTimeMinutes] = useState(initial.customTimeMinutes);
    const [customTimeRange, setCustomTimeRange] = useState(initial.customTimeRange);
    const [depthSpanIdx, setDepthSpanIdx] = useState(initial.depthSpanIdx);
    const [scrollOffset, setScrollOffset] = useState(0); // ms back in time, or m up in depth
    const [timeRangeSteps, setTimeRangeSteps] = useState(1);
    const [configStrip, setConfigStrip] = useState(null);
    const [customTimeOpen, setCustomTimeOpen] = useState(false);
    const [exportOpen, setExportOpen] = useState(false);
    const [sharedCursorFrac, setSharedCursorFrac] = useState(null);
    const [nowTick, setNowTick] = useState(() => Date.now());
    const [timeScrollAnchor, setTimeScrollAnchor] = useState(() => Date.now());
    const [liveClock, setLiveClock] = useState(() => ({ sampleTs: null, receivedAt: Date.now() }));

    const [data, setData] = useState(() => loadCachedDataRows(storageKey)); // [{ timestamp, depth, values:{channelId:value} }]
    const dragRef = useRef(null);
    const cursorRafRef = useRef(0);
    const pendingCursorFracRef = useRef(null);
    const scrollOffsetRef = useRef(0);
    const rangeApplyRafRef = useRef(0);
    const safeCustomMinutes = clampCustomMinutes(customTimeMinutes);
    const [liveFeed, setLiveFeed] = useState(() => {
        const meta = getLatestRigData()?._meta || {};
        return meta.connected === true && meta.source !== 'none' && meta.stale !== true;
    });

    useEffect(() => { scrollOffsetRef.current = scrollOffset; }, [scrollOffset]);

    useEffect(() => {
        setToolbarTimeWinIdx(timeWinIdx);
    }, [timeWinIdx]);

    useEffect(() => {
        if (indexMode !== 'time') return undefined;
        const id = setInterval(() => {
            setNowTick(Date.now());
        }, 1000);
        return () => clearInterval(id);
    }, [indexMode]);

    // Persist per-page strip layout separately from shared EDR preferences.
    // IMPORTANT: Only the full-mode (non-compact) EDR writes shared prefs.
    // Compact instances on equipment pages must NOT overwrite readouts/time prefs.
    useEffect(() => {
        try {
            if (storageKey) {
                localStorage.setItem(storageKey, JSON.stringify({
                    strips,
                    indexMode,
                    readouts,
                    timeWindowKey: timeWinIdx === CUSTOM_TIME_KEY
                        ? CUSTOM_TIME_KEY
                        : (TIME_WINDOWS[timeWinIdx]?.range ?? TIME_WINDOWS[isCompact ? 0 : 1]?.range),
                    customTimeMinutes: safeCustomMinutes,
                    customTimeRange: normalizeCustomTimeRange(customTimeRange),
                    depthSpanM: DEPTH_SPANS[depthSpanIdx]?.m ?? DEPTH_SPANS[2]?.m
                }));
            }
            if (!isCompact) {
                localStorage.setItem(GLOBAL_EDR_PREFS_KEY, JSON.stringify({
                    indexMode,
                    readouts,
                    timeWindowKey: timeWinIdx === CUSTOM_TIME_KEY
                        ? CUSTOM_TIME_KEY
                        : (TIME_WINDOWS[timeWinIdx]?.range ?? TIME_WINDOWS[isCompact ? 0 : 1]?.range),
                    customTimeMinutes: safeCustomMinutes,
                    customTimeRange: normalizeCustomTimeRange(customTimeRange),
                    depthSpanM: DEPTH_SPANS[depthSpanIdx]?.m ?? DEPTH_SPANS[2]?.m
                }));
            }
        } catch (e) { /* best effort */ }
    }, [storageKey, strips, indexMode, readouts, timeWinIdx, safeCustomMinutes, customTimeRange, depthSpanIdx, isCompact]);

    // Set of channels we need to fetch (all pens + readouts + depth band).
    const neededChannels = useMemo(() => {
        const set = new Set([HOLE_DEPTH_METRIC, BIT_DEPTH_METRIC]);
        strips.forEach(s => s.pens.forEach(p => set.add(p.channelId)));
        if (!isCompact) readouts.forEach(id => set.add(id));
        return Array.from(set);
    }, [strips, readouts, isCompact]);
    const queryChannels = useMemo(() => expandChannelsWithAliases(neededChannels), [neededChannels]);

    const selectedTimeWindow = timeWinIdx === CUSTOM_TIME_KEY
        ? (customTimeRange?.start && customTimeRange?.stop
            ? {
                label: 'Custom',
                ms: Math.max(60 * 1000, customTimeRange.stop - customTimeRange.start),
                start: new Date(customTimeRange.start).toISOString(),
                stop: new Date(customTimeRange.stop).toISOString()
            }
            : {
                label: 'Custom',
                ms: safeCustomMinutes * 60 * 1000,
                range: `-${safeCustomMinutes}m`
            })
        : (TIME_WINDOWS[timeWinIdx] || TIME_WINDOWS[1] || TIME_WINDOWS[0]);
    const baseTimeWindowMs = selectedTimeWindow.ms;
    const timeWindowMs = selectedTimeWindow.start && selectedTimeWindow.stop
        ? baseTimeWindowMs
        : baseTimeWindowMs * timeRangeSteps;
    const timeRange = selectedTimeWindow.range;
    const sorted = data; // already time-sorted
    const liveTimeAnchor = useMemo(() => {
        const sampleTs = Number(liveClock.sampleTs);
        const receivedAt = Number(liveClock.receivedAt);
        if (liveFeed && Number.isFinite(sampleTs) && Number.isFinite(receivedAt) && (nowTick - receivedAt) <= LIVE_DATA_GRACE_MS) {
            return sampleTs;
        }
        return nowTick;
    }, [liveFeed, liveClock.sampleTs, liveClock.receivedAt, nowTick]);
    const getLiveAnchorNow = useCallback(() => liveTimeAnchor || Date.now(), [liveTimeAnchor]);

    const historyRequestWindow = useMemo(() => {
        if (selectedTimeWindow.start && selectedTimeWindow.stop) {
            return { start: selectedTimeWindow.start, stop: selectedTimeWindow.stop };
        }
        if (indexMode !== 'time') return null;
        const now = scrollOffset > 1000 ? timeScrollAnchor : liveTimeAnchor;
        const bottom = now - Math.max(0, scrollOffset);
        const top = bottom - timeWindowMs;
        const padding = scrollOffset > 1000
            ? Math.min(5 * 60 * 1000, Math.max(30 * 1000, timeWindowMs * 0.1))
            : HISTORY_LIVE_PADDING_MS;
        const start = Math.floor((top - padding) / HISTORY_SCROLLBACK_BUCKET_MS) * HISTORY_SCROLLBACK_BUCKET_MS;
        const stop = scrollOffset > 1000
            ? Math.ceil((bottom + padding) / HISTORY_SCROLLBACK_BUCKET_MS) * HISTORY_SCROLLBACK_BUCKET_MS
            : bottom + padding;
        return {
            start: new Date(start).toISOString(),
            stop: new Date(stop).toISOString()
        };
    }, [indexMode, selectedTimeWindow.start, selectedTimeWindow.stop, timeWindowMs, scrollOffset, liveTimeAnchor, timeScrollAnchor]);
    const historyRequestKey = useMemo(() => (
        historyRequestWindow?.start && historyRequestWindow?.stop
            ? `start=${historyRequestWindow.start}&stop=${historyRequestWindow.stop}`
            : `range=${timeRange || '-1h'}`
    ), [historyRequestWindow?.start, historyRequestWindow?.stop, timeRange]);

    // ---- History seed (time mode) ----
    const historyReq = useRef(0);
    const historyAbortRef = useRef(null);
    const fetchHistory = useCallback(async () => {
        const reqId = ++historyReq.current;
        if (historyAbortRef.current) historyAbortRef.current.abort();
        const aborter = new AbortController();
        historyAbortRef.current = aborter;
        try {
            const params = new URLSearchParams();
            if (historyRequestWindow?.start && historyRequestWindow?.stop) {
                params.set('start', historyRequestWindow.start);
                params.set('stop', historyRequestWindow.stop);
            } else {
                params.set('range', timeRange);
            }
            params.set('metrics', queryChannels.join(','));
            const requestKey = params.toString();
            const cached = historyCache.get(requestKey);
            if (cached && (Date.now() - cached.at) <= HISTORY_CACHE_TTL_MS) {
                const nextRows = toHistoryRows(cached.rows, neededChannels);
                if (nextRows.length) setData(prev => {
                    const baseRows = selectedTimeWindow.start && selectedTimeWindow.stop ? [] : prev;
                    const merged = mergeSampleRows(baseRows, nextRows);
                    saveCachedDataRows(storageKey, merged);
                    return merged;
                });
                return;
            }
            const res = await axios.get(`/api/history?${requestKey}`, { timeout: 4500, signal: aborter.signal });
            if (reqId !== historyReq.current) return;
            const rows = Array.isArray(res.data) ? res.data : [];
            historyCache.set(requestKey, { at: Date.now(), rows });
            const nextRows = toHistoryRows(rows, neededChannels);
            if (nextRows.length) setData(prev => {
                const baseRows = selectedTimeWindow.start && selectedTimeWindow.stop ? [] : prev;
                const merged = mergeSampleRows(baseRows, nextRows);
                saveCachedDataRows(storageKey, merged);
                return merged;
            });
        } catch (err) {
            if (reqId !== historyReq.current) return;
            if (err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError') return;
            console.error('EdrView: failed to load history', err);
        } finally {
            if (historyAbortRef.current === aborter) historyAbortRef.current = null;
        }
    }, [neededChannels, queryChannels, historyRequestKey, historyRequestWindow?.start, historyRequestWindow?.stop, selectedTimeWindow.start, selectedTimeWindow.stop, timeRange, storageKey]);

    const payloadToPoint = useCallback((payload) => {
        const meta = payload?._meta || {};
        const isLiveSample = meta.connected === true && meta.source !== 'none' && meta.stale !== true;
        if (!isLiveSample) return null;
        const tsStr = payload?._meta?.ts;
        const ts = tsStr ? new Date(tsStr).getTime() : Date.now();
        if (!Number.isFinite(ts)) return null;
        if (timeWinIdx === CUSTOM_TIME_KEY && customTimeRange?.start && customTimeRange?.stop) {
            if (!Number.isFinite(ts) || ts < customTimeRange.start || ts > customTimeRange.stop) {
                return null;
            }
        }
        const values = {};
        Object.keys(payload || {}).forEach(measurement => {
            const block = payload[measurement];
            if (block && typeof block === 'object') {
                Object.keys(block).forEach(field => {
                    values[`${measurement}.${field}`] = block[field];
                });
            }
        });
        applyChannelAliases(values);
        const depth = Number(values[DEPTH_INDEX_METRIC] ?? values['drilling.bit_depth']);
        return { timestamp: ts, depth, values };
    }, [customTimeRange?.start, customTimeRange?.stop, timeWinIdx]);

    // ---- Live point ingestion (shared socket) ----
    const ingest = useCallback((payload) => {
        const meta = payload?._meta || {};
        const isLiveSample = meta.connected === true && meta.source !== 'none' && meta.stale !== true;
        setLiveFeed(isLiveSample);
        const point = payloadToPoint(payload);
        if (!point) return;
        const receivedAt = Date.now();
        setLiveClock({ sampleTs: point.timestamp, receivedAt });
        setNowTick(receivedAt);
        setData(prev => {
            const sorted = mergeSampleRows(prev, [point]);
            // Cap buffer to the largest time window + headroom for scrolling.
            const maxPresetWindowMs = TIME_WINDOWS[TIME_WINDOWS.length - 1].ms;
            const cutoff = point.timestamp - (Math.max(maxPresetWindowMs, timeWindowMs + Math.max(0, scrollOffsetRef.current)) * 1.5);
            const trimmed = sorted.filter(p => (p.timestamp || 0) >= cutoff);
            saveCachedDataRows(storageKey, trimmed);
            return trimmed;
        });
    }, [payloadToPoint, timeWindowMs, storageKey]);

    useEffect(() => {
        const cached = getLatestRigData();
        const latestIsLive = cached?._meta?.connected === true && cached?._meta?.source !== 'none' && cached?._meta?.stale !== true;
        if (latestIsLive) {
            const recentPoints = getRecentRigDataSamples(3600).map(payloadToPoint).filter(Boolean);
            if (recentPoints.length) {
                const latestPointTs = recentPoints[recentPoints.length - 1].timestamp;
                const receivedAt = Date.now();
                setLiveClock({ sampleTs: latestPointTs, receivedAt });
                setNowTick(receivedAt);
                setData(prev => {
                    const merged = mergeSampleRows(prev, recentPoints);
                    const maxPresetWindowMs = TIME_WINDOWS[TIME_WINDOWS.length - 1].ms;
                    const cutoff = latestPointTs - (Math.max(maxPresetWindowMs, timeWindowMs + Math.max(0, scrollOffsetRef.current)) * 1.5);
                    const trimmed = merged.filter(p => (p.timestamp || 0) >= cutoff);
                    saveCachedDataRows(storageKey, trimmed);
                    return trimmed;
                });
            }
        }
        if (cached && Object.keys(cached).length) ingest(cached);
        axios.get('/api/rig/latest', { timeout: 3000 })
            .then(({ data: latest }) => {
                if (latest && Object.keys(latest).length) ingest(latest);
            })
            .catch(() => { /* non-fatal */ });
        const handler = (d) => ingest(d);
        socket.on('rig_data', handler);
        return () => socket.off('rig_data', handler);
    }, [ingest, payloadToPoint, timeWindowMs, storageKey]);

    useEffect(() => {
        if (indexMode !== 'time') return undefined;
        const timer = setTimeout(() => {
            fetchHistory();
        }, EDR_HISTORY_FETCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [fetchHistory, indexMode]);

    // Reset scroll when switching index modes.
    useEffect(() => {
        setScrollOffset(0);
        setTimeRangeSteps(1);
    }, [indexMode, timeWinIdx, customTimeMinutes, customTimeRange, depthSpanIdx]);

    const updateSharedCursor = useCallback((frac) => {
        pendingCursorFracRef.current = frac;
        if (cursorRafRef.current) return;
        cursorRafRef.current = requestAnimationFrame(() => {
            cursorRafRef.current = 0;
            setSharedCursorFrac(pendingCursorFracRef.current);
        });
    }, []);

    const clearSharedCursor = useCallback(() => {
        if (cursorRafRef.current) {
            cancelAnimationFrame(cursorRafRef.current);
            cursorRafRef.current = 0;
        }
        pendingCursorFracRef.current = null;
        setSharedCursorFrac(null);
    }, []);

    useEffect(() => () => {
        if (cursorRafRef.current) cancelAnimationFrame(cursorRafRef.current);
        if (rangeApplyRafRef.current) cancelAnimationFrame(rangeApplyRafRef.current);
        if (historyAbortRef.current) historyAbortRef.current.abort();
    }, []);

    // ---- Compute index domain + samples for the SVG ----
    const maxDepth = useMemo(() => sorted.reduce((m, p) => (
        Number.isFinite(p.depth) ? Math.max(m, p.depth) : m
    ), 0), [sorted]);

    const { indexDomain, samples } = useMemo(() => {
        if (indexMode === 'depth') {
            // Bin samples into depth buckets; keep last sample per bin.
            const bins = new Map();
            sorted.forEach(p => {
                if (!Number.isFinite(p.depth)) return;
                const key = Math.round(p.depth / DEPTH_BIN_M);
                bins.set(key, { depth: key * DEPTH_BIN_M, timestamp: p.timestamp, values: p.values });
            });
            const binned = Array.from(bins.values()).sort((a, b) => a.depth - b.depth);
            const span = DEPTH_SPANS[depthSpanIdx]?.m ?? 100;
            // Bottom of window = deepest minus scroll; depth increases downward.
            const bottom = Math.max(span, maxDepth - scrollOffset);
            const top = bottom - span;
            return { indexDomain: [top, bottom], samples: binned };
        }
        // Time mode: newest at the BOTTOM.
        const now = customTimeRange?.stop && timeWinIdx === CUSTOM_TIME_KEY
            ? customTimeRange.stop
            : (scrollOffset > 1000 ? timeScrollAnchor : liveTimeAnchor);
        const bottom = now - scrollOffset;
        const top = bottom - timeWindowMs;
        return { indexDomain: [top, bottom], samples: sorted };
    }, [indexMode, sorted, depthSpanIdx, maxDepth, scrollOffset, timeWindowMs, liveTimeAnchor, timeScrollAnchor, customTimeRange?.stop, timeWinIdx]);

    const liveAtBottom = scrollOffset <= (indexMode === 'depth' ? 0.01 : 1000);
    const latestValues = useMemo(() => (sorted.length ? sorted[sorted.length - 1].values : {}), [sorted]);
    const visibleSamples = useMemo(() => {
        const [start, stop] = indexDomain;
        const key = indexMode === 'depth' ? 'depth' : 'timestamp';
        return samples.filter(sample => {
            const value = sample?.[key];
            return Number.isFinite(value) && value >= start && value <= stop;
        });
    }, [samples, indexDomain, indexMode]);
    const visibleLatestValues = useMemo(() => (
        visibleSamples.length ? visibleSamples[visibleSamples.length - 1].values : latestValues
    ), [visibleSamples, latestValues]);
    const showLiveValues = liveFeed || !liveAtBottom || (timeWinIdx === CUSTOM_TIME_KEY && customTimeRange?.start && customTimeRange?.stop);
    const displayLatestValues = showLiveValues ? latestValues : {};
    const displayVisibleLatestValues = showLiveValues ? visibleLatestValues : {};

    // ---- Index axis ticks ----
    const axisTicks = useMemo(() => {
        const [a, b] = indexDomain;
        const count = 6;
        const showDate = indexMode === 'time' && (timeWinIdx === CUSTOM_TIME_KEY || (b - a) >= 24 * 60 * 60 * 1000);
        return Array.from({ length: count + 1 }, (_, i) => {
            const frac = i / count;
            const v = a + frac * (b - a);
            const labelFrac = Math.min(0.96, Math.max(0.075, frac));
            const label = indexMode === 'depth'
                ? `${Math.round(v)}`
                : (showDate
                    ? new Date(v).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
                    : formatAxisTime(v, b - a));
            return { frac, labelFrac, label };
        });
    }, [indexDomain, indexMode, timeWinIdx]);

    // ---- Scroll handlers ----
    // One "page" of the visible window; a single rail click moves a half-window.
    const windowLen = indexMode === 'depth'
        ? (DEPTH_SPANS[depthSpanIdx]?.m ?? 100)
        : timeWindowMs;
    const scrollStep = windowLen * 0.5;            // single rail click = half window
    // Smaller increments for continuous (wheel / press-and-hold) scrolling so the
    // motion is smooth rather than jumpy.
    const wheelStep = windowLen * 0.12;            // per wheel notch
    const holdStep = windowLen * 0.06;             // per rAF tick while a button is held

    // Clamp helper: offset can never go below 0 — that is the live edge, so we
    // never scroll into the future. Time mode supports long historical paging.
    const clampOffset = useCallback((next) => {
        const min = 0;
        const max = indexMode === 'time' ? MAX_TIME_SCROLLBACK_MS : Number.POSITIVE_INFINITY;
        return Math.min(max, Math.max(min, next));
    }, [indexMode]);

    const scrollByAmount = useCallback((delta) => {
        // delta > 0 = back into history (older/shallower); < 0 = toward live.
        setScrollOffset(o => {
            if (indexMode === 'time' && o <= 1000 && delta > 0) {
                const now = getLiveAnchorNow();
                setNowTick(now);
                setTimeScrollAnchor(now);
            }
            const next = clampOffset(o + delta);
            if (indexMode === 'time' && next <= 1000) setTimeScrollAnchor(getLiveAnchorNow());
            return next;
        });
    }, [clampOffset, getLiveAnchorNow, indexMode]);

    const scrollBack = useCallback(() => scrollByAmount(scrollStep), [scrollByAmount, scrollStep]);   // older / shallower
    const scrollFwd = useCallback(() => scrollByAmount(-scrollStep), [scrollByAmount, scrollStep]);    // newer / deeper

    // --- Mouse-wheel continuous scroll (non-passive so we can preventDefault) ---
    const stripAreaRef = useRef(null);
    const wheelStepRef = useRef(wheelStep);
    wheelStepRef.current = wheelStep;
    useEffect(() => {
        const el = stripAreaRef.current;
        if (!el) return undefined;
        const onWheel = (e) => {
            // Block the page from scrolling while the pointer is over the strips.
            e.preventDefault();
            // wheel up (deltaY < 0) => back into history; wheel down => toward live.
            const dir = e.deltaY < 0 ? 1 : -1;
            setScrollOffset(o => {
                if (indexMode === 'time' && o <= 1000 && dir > 0) {
                    const now = getLiveAnchorNow();
                    setNowTick(now);
                    setTimeScrollAnchor(now);
                }
                const next = clampOffset(o + dir * wheelStepRef.current);
                if (indexMode === 'time' && next <= 1000) setTimeScrollAnchor(getLiveAnchorNow());
                return next;
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [clampOffset, getLiveAnchorNow, indexMode]);

    // --- Press-and-hold continuous scroll on the rail buttons ---
    // While held, repeat a small step each animation frame; a plain click still
    // performs exactly one half-window step (handled by the rail's onClick).
    const holdRafRef = useRef(0);
    const heldMovedRef = useRef(false); // did the hold actually scroll continuously?
    const holdStepRef = useRef(holdStep);
    holdStepRef.current = holdStep;
    const startHold = useCallback((dir) => {
        if (holdRafRef.current) return;
        heldMovedRef.current = false;
        let frames = 0;
        const tick = () => {
            frames += 1;
            // brief grace period so a quick click is handled solely by onClick
            if (frames > 12) {
                heldMovedRef.current = true;
                scrollByAmount(dir * holdStepRef.current);
            }
            holdRafRef.current = requestAnimationFrame(tick);
        };
        holdRafRef.current = requestAnimationFrame(tick);
    }, [scrollByAmount]);
    const stopHold = useCallback(() => {
        if (holdRafRef.current) { cancelAnimationFrame(holdRafRef.current); holdRafRef.current = 0; }
    }, []);
    useEffect(() => () => { if (holdRafRef.current) cancelAnimationFrame(holdRafRef.current); }, []);

    // Rail click = one step, BUT swallow the click that ends a press-and-hold so
    // releasing after a continuous scroll doesn't tack on an extra half-window jump.
    const clickBack = useCallback(() => {
        if (heldMovedRef.current) { heldMovedRef.current = false; return; }
        scrollBack();
    }, [scrollBack]);
    const clickFwd = useCallback(() => {
        if (heldMovedRef.current) { heldMovedRef.current = false; return; }
        scrollFwd();
    }, [scrollFwd]);

    // Drag on the axis to scroll.
    const onAxisPointerDown = (e) => {
        if (indexMode === 'time' && scrollOffset <= 1000) {
            const now = getLiveAnchorNow();
            setNowTick(now);
            setTimeScrollAnchor(now);
        }
        dragRef.current = { y: e.clientY, offset: scrollOffset };
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.height) {
            const frac = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
            updateSharedCursor(frac);
        }
    };
    const onAxisPointerMove = (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.height) {
            const frac = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
            updateSharedCursor(frac);
        }
        if (!dragRef.current) return;
        const dy = e.clientY - dragRef.current.y;
        const el = e.currentTarget;
        const pxH = el.clientHeight || 1;
        const [a, b] = indexDomain;
        const perPx = (b - a) / pxH;
        // dragging DOWN reveals older data (increase offset)
        const next = dragRef.current.offset + dy * perPx;
        setScrollOffset(clampOffset(next));
    };
    const onAxisPointerUp = () => { dragRef.current = null; };

    const setIndexMode = useCallback((mode) => {
        setConfig(prev => ({ ...prev, indexMode: mode }));
    }, []);

    const updateStrip = useCallback((index, nextStrip) => {
        setConfig(prev => ({
            ...prev,
            strips: prev.strips.map((s, i) => (i === index ? normalizeStrips([nextStrip], channels)[0] : s))
        }));
    }, [channels]);

    const defaultExportMetrics = useMemo(() => {
        const ids = new Set([HOLE_DEPTH_METRIC, BIT_DEPTH_METRIC]);
        strips.forEach(strip => strip.pens.forEach(pen => ids.add(pen.channelId)));
        readouts.forEach(id => ids.add(id));
        return Array.from(ids).filter(id => METRIC_LOOKUP.has(id));
    }, [strips, readouts]);

    const fetchExportRows = useCallback(async ({ metrics, range, start, stop }) => {
        const params = new URLSearchParams();
        if (start && stop) {
            params.set('start', start);
            params.set('stop', stop);
        } else {
            params.set('range', range || '-1h');
        }
        params.set('metrics', metrics.join(','));
        const res = await axios.get(`/api/history?${params.toString()}`, { timeout: 15000 });
        return Array.isArray(res.data) ? res.data : [];
    }, []);

    const jumpToLive = useCallback(() => {
        const now = getLiveAnchorNow();
        setNowTick(now);
        setTimeScrollAnchor(now);
        setScrollOffset(0);
    }, [getLiveAnchorNow]);

    // ---------------- Render ----------------

    const axisWidth = isCompact ? 44 : 56;
    const bottomH = isCompact ? 64 : 96;          // fixed variables-block height
    const headerH = isCompact ? 22 : 26;          // per-strip header row height
    // Top/bottom offsets so the index axis, scroll rails and left depth band line
    // up with the chart area: top offset = strip header height, bottom = variables block.
    const railTop = headerH + 4;
    const railBottom = bottomH + 4;
    const showLeftDepth = !isCompact;
    const showTopReadouts = !isCompact && readouts.length > 0;
    const holeDepthVal = displayLatestValues?.[HOLE_DEPTH_METRIC];
    const bitDepthVal = displayLatestValues?.[BIT_DEPTH_METRIC];
    const visibleTimeWindowIndexes = useMemo(() => getVisibleTimeWindowIndexes(isCompact), [isCompact]);
    const stepSelectedTimeRange = useCallback((direction) => {
        if (indexMode !== 'time') return;
        const now = getLiveAnchorNow();
        setScrollOffset(0);
        setNowTick(now);
        setTimeScrollAnchor(now);
        setTimeRangeSteps(prev => Math.max(1, Math.min(MAX_TIME_RANGE_STEPS, prev + direction)));
    }, [getLiveAnchorNow, indexMode]);

    const selectTimeWindow = useCallback((index) => {
        const now = getLiveAnchorNow();
        setToolbarTimeWinIdx(index);
        if (rangeApplyRafRef.current) cancelAnimationFrame(rangeApplyRafRef.current);
        rangeApplyRafRef.current = 0;
        setScrollOffset(0);
        setTimeRangeSteps(1);
        setNowTick(now);
        setTimeScrollAnchor(now);
        setTimeWinIdx(index);
    }, [getLiveAnchorNow]);

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {/* Toolbar */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
                {!isCompact && (
                    <ToggleButtonGroup
                        size="small"
                        exclusive
                        value={indexMode}
                        onChange={(_, v) => v && setIndexMode(v)}
                        sx={{
                            '& .MuiToggleButton-root': { color: subText, borderColor: border, px: 1.25, py: 0.4, textTransform: 'none', fontWeight: 800 },
                            '& .Mui-selected': { color: `${accent} !important`, bgcolor: `${accent}22 !important` }
                        }}
                    >
                        <ToggleButton value="time" title="Time"><Clock size={15} style={{ marginRight: 6 }} /> Time</ToggleButton>
                        <ToggleButton value="depth" title="Depth"><Ruler size={15} style={{ marginRight: 6 }} /> Depth</ToggleButton>
                    </ToggleButtonGroup>
                )}

                <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                    {indexMode === 'time' && (
                        <>
                            <MuiTooltip title="Decrease visible time range">
                                <span>
                                    <IconButton
                                        size="small"
                                        onClick={() => stepSelectedTimeRange(-1)}
                                        disabled={indexMode !== 'time' || timeRangeSteps <= 1}
                                        sx={{ color: subText, border: `1px solid ${border}`, borderRadius: 1 }}
                                    >
                                        <Plus size={15} />
                                    </IconButton>
                                </span>
                            </MuiTooltip>
                            <MuiTooltip title="Increase visible time range">
                                <span>
                                    <IconButton
                                        size="small"
                                        onClick={() => stepSelectedTimeRange(1)}
                                        disabled={indexMode !== 'time' || timeRangeSteps >= MAX_TIME_RANGE_STEPS}
                                        sx={{ color: subText, border: `1px solid ${border}`, borderRadius: 1 }}
                                    >
                                        <Minus size={15} />
                                    </IconButton>
                                </span>
                            </MuiTooltip>
                        </>
                    )}
                    {(indexMode === 'time'
                        ? TIME_WINDOWS.map((opt, i) => ({ opt, i })).filter(({ i }) => visibleTimeWindowIndexes.includes(i))
                        : DEPTH_SPANS.map((opt, i) => ({ opt, i }))
                    ).map(({ opt, i }) => {
                        const active = indexMode === 'time' ? i === toolbarTimeWinIdx : i === depthSpanIdx;
                        return (
                            <Button
                                key={opt.label}
                                size="small"
                                onClick={() => (indexMode === 'time' ? selectTimeWindow(i) : setDepthSpanIdx(i))}
                                sx={{
                                    minWidth: 36, px: 0.75, textTransform: 'none', fontWeight: 800,
                                    color: active ? theme.palette.getContrastText(accent) : subText,
                                    bgcolor: active ? accent : 'transparent',
                                    border: `1px solid ${border}`,
                                    '&:hover': { bgcolor: active ? accent : `${accent}18` }
                                }}
                            >
                                {opt.label}
                            </Button>
                        );
                    })}
                    {indexMode === 'time' && (
                        <Button
                            size="small"
                            startIcon={<Clock size={14} />}
                            onClick={() => setCustomTimeOpen(true)}
                            sx={{
                                minWidth: 82, px: 1, textTransform: 'none', fontWeight: 900,
                                color: toolbarTimeWinIdx === CUSTOM_TIME_KEY ? theme.palette.getContrastText(accent) : subText,
                                bgcolor: toolbarTimeWinIdx === CUSTOM_TIME_KEY ? accent : 'transparent',
                                border: `1px solid ${border}`,
                                '&:hover': { bgcolor: toolbarTimeWinIdx === CUSTOM_TIME_KEY ? accent : `${accent}18` }
                            }}
                        >
                            Custom
                        </Button>
                    )}
                </Box>

                <Box sx={{ flex: 1 }} />

                {/* LIVE indicator + jump-to-live affordance. Scrolling lives on the side rails. */}
                {liveAtBottom ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                        <Radio size={13} color="#22c55e" />
                        <Typography sx={{ color: '#22c55e', fontSize: '0.72rem', fontWeight: 900, letterSpacing: 0.5 }}>LIVE</Typography>
                    </Box>
                ) : (
                    <MuiTooltip title="Jump to live">
                        <Button
                            size="small"
                            onClick={jumpToLive}
                            startIcon={<Radio size={13} />}
                            sx={{
                                textTransform: 'none', fontWeight: 800, py: 0.2, px: 1,
                                color: subText, border: `1px solid ${border}`,
                                '&:hover': { color: '#22c55e', borderColor: '#22c55e' }
                            }}
                        >
                            {indexMode === 'depth'
                                ? `${Math.round(indexDomain[0])}–${Math.round(indexDomain[1])} m · live`
                                : 'Scrolled back · live'}
                        </Button>
                    </MuiTooltip>
                )}
                {!isCompact && (
                    <Button
                        size="small"
                        startIcon={<Download size={15} />}
                        onClick={() => setExportOpen(true)}
                        sx={{
                            textTransform: 'none',
                            fontWeight: 900,
                            color: text,
                            border: `1px solid ${border}`,
                            py: 0.35,
                            '&:hover': { borderColor: accent, color: accent }
                        }}
                    >
                        Export
                    </Button>
                )}
            </Box>

            {/* Top band (full mode): left depth tiles spacer + configurable readout row. */}
            {showTopReadouts && (
                <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 0.75, mb: 1 }}>
                    {showLeftDepth && (
                        /* Spacer aligning the top readout row with the strips column:
                           depth track (132) + gap + left scroll rail (~30) + gap. */
                        <Box sx={{ flex: '0 0 176px', display: 'flex', alignItems: 'center', gap: 0.6, pl: 0.5 }}>
                            <Gauge size={16} color={subText} />
                            <Typography sx={{ color: subText, fontSize: '0.66rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                                Depth
                            </Typography>
                        </Box>
                    )}
                    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'stretch', gap: 0.75, overflowX: 'auto' }}>
                        {readouts.map((id) => (
                            <ReadoutTile
                                key={id}
                                id={id}
                                value={channelValue(displayLatestValues, id)}
                                surface={panelBg}
                                border={border}
                                text={text}
                                subText={subText}
                                accent={accent}
                            />
                        ))}
                    </Box>
                    <Box sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center' }}>
                        <ReadoutsConfig
                            value={readouts}
                            onChange={setReadouts}
                            channels={channels}
                            surface={panelBg}
                            border={border}
                            text={text}
                            subText={subText}
                            accent={accent}
                        />
                    </Box>
                </Box>
            )}
            {/* When no readouts selected, still expose the config control (full mode). */}
            {!isCompact && readouts.length === 0 && (
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
                    <ReadoutsConfig
                        value={readouts}
                        onChange={setReadouts}
                        channels={channels}
                        surface={panelBg}
                        border={border}
                        text={text}
                        subText={subText}
                        accent={accent}
                    />
                </Box>
            )}

            {/* Strip area */}
            <Box
                ref={stripAreaRef}
                onPointerLeave={clearSharedCursor}
                sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex', gap: 0.75 }}
            >
                {/* Leftmost DEPTH track (full mode): header + depth-axis chart band + HOLE/BIT
                    depth bottom block, all sharing the strips' row metrics so it aligns exactly.
                    The depth/time axis is folded into this track's chart band. */}
                {showLeftDepth ? (
                    <DepthTrack
                        indexMode={indexMode}
                        indexDomain={indexDomain}
                        axisTicks={axisTicks}
                        samples={samples}
                        maxDepth={maxDepth}
                        holeDepthVal={holeDepthVal}
                        bitDepthVal={bitDepthVal}
                        headerH={headerH}
                        bottomH={bottomH}
                        chartBg={chartBg}
                        panelBg={panelBg}
                        border={border}
                        gridColor={gridColor}
                        text={text}
                        subText={subText}
                        accent={accent}
                        onPointerDown={onAxisPointerDown}
                        onPointerMove={onAxisPointerMove}
                        onPointerUp={onAxisPointerUp}
                    />
                ) : (
                    /* Compact mode: keep the slim standalone index axis (no depth track). */
                    <Box
                        onPointerDown={onAxisPointerDown}
                        onPointerMove={onAxisPointerMove}
                        onPointerUp={onAxisPointerUp}
                        onPointerLeave={onAxisPointerUp}
                        sx={{
                            flex: `0 0 ${axisWidth}px`,
                            bgcolor: panelBg,
                            border: `1px solid ${border}`,
                            borderRadius: 1,
                            position: 'relative',
                            cursor: 'ns-resize',
                            userSelect: 'none',
                            touchAction: 'none',
                            mt: `${railTop}px`,
                            mb: `${railBottom}px`
                        }}
                    >
                        {axisTicks.map((t, i) => (
                            <Box key={i} sx={{ position: 'absolute', left: 0, right: 0, top: `${(t.labelFrac ?? t.frac) * 100}%`, transform: 'translateY(-50%)', px: 0.25 }}>
                                <Typography sx={{ fontSize: '0.55rem', color: subText, textAlign: 'center', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                                    {t.label}
                                </Typography>
                            </Box>
                        ))}
                    </Box>
                )}

                {/* LEFT scroll rail */}
                <ScrollRail
                    onUp={clickBack}
                    onDown={clickFwd}
                    onHoldUp={() => startHold(1)}
                    onHoldDown={() => startHold(-1)}
                    onHoldStop={stopHold}
                    upTip={indexMode === 'depth' ? 'Shallower' : 'Older'}
                    downTip={indexMode === 'depth' ? 'Deeper' : 'Newer'}
                    downDisabled={liveAtBottom}
                    text={text}
                    border={border}
                    top={railTop}
                    bottom={railBottom}
                />

                {/* Strips */}
                <Box sx={{ flex: 1, minWidth: 0, display: 'flex', gap: 0.75 }}>
                    {strips.map((strip, si) => (
                        <Box key={si} sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                            {/* header */}
                            <Box sx={{ height: headerH, display: 'flex', alignItems: 'center', gap: 0.5, mb: '4px' }}>
                                <Typography sx={{ flex: 1, minWidth: 0, color: text, fontSize: isCompact ? '0.66rem' : '0.74rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {strip.title}
                                </Typography>
                                <IconButton size="small" onClick={() => setConfigStrip(si)} sx={{ color: subText, p: 0.25 }} title="Configure track">
                                    <Settings size={isCompact ? 13 : 15} />
                                </IconButton>
                            </Box>
                            {/* chart */}
                            <Box sx={{ flex: '1 1 auto', minHeight: 0, bgcolor: chartBg, border: `1px solid ${border}`, borderRadius: 1, overflow: 'hidden' }}>
                                <MemoStripChart
                                    key={si}
                                    strip={strip}
                                    samples={visibleSamples}
                                    indexMode={indexMode}
                                    indexDomain={indexDomain}
                                    accentColor={accent}
                                    gridColor={gridColor}
                                    axisTextColor={subText}
                                    surface={panelBg}
                                    border={border}
                                    subText={subText}
                                    textColor={text}
                                    cursorFrac={sharedCursorFrac}
                                    onCursorMove={updateSharedCursor}
                                />
                            </Box>
                            {/* fixed-height variables block */}
                            <StripVariables
                                strip={strip}
                                latest={displayVisibleLatestValues}
                                compact={isCompact}
                                surface={panelBg}
                                border={border}
                                subText={subText}
                            />
                        </Box>
                    ))}
                </Box>

                {/* RIGHT scroll rail (mirror of the left) — full mode only; compact keeps a single control. */}
                {!isCompact && (
                    <ScrollRail
                        onUp={clickBack}
                        onDown={clickFwd}
                        onHoldUp={() => startHold(1)}
                        onHoldDown={() => startHold(-1)}
                        onHoldStop={stopHold}
                        upTip={indexMode === 'depth' ? 'Shallower' : 'Older'}
                        downTip={indexMode === 'depth' ? 'Deeper' : 'Newer'}
                        downDisabled={liveAtBottom}
                        text={text}
                        border={border}
                        top={railTop}
                        bottom={railBottom}
                    />
                )}
            </Box>

            {/* Per-strip config dialog */}
            {configStrip != null && (
                <StripConfigDialog
                    open={configStrip != null}
                    onClose={() => setConfigStrip(null)}
                    strip={strips[configStrip]}
                    stripIndex={configStrip}
                    onSave={updateStrip}
                    channels={channels}
                    surface={panelBg}
                    border={border}
                    text={text}
                    subText={subText}
                />
            )}
            {customTimeOpen && (
                <CustomTimeDialog
                    open={customTimeOpen}
                    onClose={() => setCustomTimeOpen(false)}
                    value={customTimeRange}
                    onApply={(range) => {
                        const now = getLiveAnchorNow();
                        setToolbarTimeWinIdx(CUSTOM_TIME_KEY);
                        setScrollOffset(0);
                        setTimeRangeSteps(1);
                        setNowTick(now);
                        setTimeScrollAnchor(now);
                        setCustomTimeRange(range);
                        setTimeWinIdx(CUSTOM_TIME_KEY);
                        setIndexMode('time');
                    }}
                    surface={panelBg}
                    border={border}
                    text={text}
                    subText={subText}
                    accent={accent}
                />
            )}
            {exportOpen && (
                <EdrExportDialog
                    open={exportOpen}
                    onClose={() => setExportOpen(false)}
                    defaultMetrics={defaultExportMetrics}
                    fetchRows={fetchExportRows}
                    surface={panelBg}
                    border={border}
                    text={text}
                    subText={subText}
                    accent={accent}
                />
            )}
        </Box>
    );
}
