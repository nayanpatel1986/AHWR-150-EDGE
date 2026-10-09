import React, { createContext, useContext, useMemo, useState, useCallback } from 'react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';

// Persisted theme system. The chosen theme name lives in localStorage under
// `romii_theme`; the provider supplies the matching MUI theme to MUI's
// ThemeProvider and drives the page <body> background via CssBaseline overrides.
//
// Scope note: only the MUI palette + the CssBaseline body background are
// swapped here. The shell (Layout) reads theme.palette.background.* so its
// surfaces honor the theme; a per-component reskin of every dashboard page is
// intentionally out of scope.

const STORAGE_KEY = 'romii_theme';

// Shared typography for every theme.
const TYPOGRAPHY = { fontFamily: 'Inter, sans-serif' };

// Build a theme whose CssBaseline forces the page background to match the
// palette so switching themes visibly changes the page background.
function makeTheme(palette) {
    return createTheme({
        palette,
        typography: TYPOGRAPHY,
        components: {
            MuiCssBaseline: {
                styleOverrides: {
                    body: {
                        backgroundColor: palette.background.default,
                        color: palette.text?.primary,
                    },
                },
            },
        },
    });
}

// 1) control-dark — the CURRENT look. Default.
const controlDark = makeTheme({
    mode: 'dark',
    primary: { main: '#38bdf8' },
    secondary: { main: '#a78bfa' },
    background: { default: '#0f172a', paper: '#1e293b' },
    divider: '#334155',
    text: { primary: '#f8fafc', secondary: '#94a3b8' },
});

// 2) hp-hmi — ISA-101 high-performance HMI: desaturated gray base, low chroma.
//    The calm operator theme; color is reserved for the alarm strip.
const hpHmi = makeTheme({
    mode: 'dark',
    primary: { main: '#7d93a8' },
    secondary: { main: '#b6c2cc' },
    background: { default: '#262b2e', paper: '#30363b' },
    divider: '#4b5560',
    text: { primary: '#d6dbdf', secondary: '#9aa3aa' },
});

// 3) light — light mode.
const light = makeTheme({
    mode: 'light',
    primary: { main: '#0284c7' },
    secondary: { main: '#7c3aed' },
    background: { default: '#f1f5f9', paper: '#ffffff' },
    divider: '#cbd5e1',
    text: { primary: '#0f172a', secondary: '#475569' },
});

// 4) high-contrast — sunlight / accessibility.
const highContrast = makeTheme({
    mode: 'dark',
    primary: { main: '#00e5ff' },
    secondary: { main: '#ffea00' },
    background: { default: '#000000', paper: '#0a0a0a' },
    divider: '#475569',
    text: { primary: '#ffffff', secondary: '#cbd5e1' },
});

// 5) ocean-blue - cool offshore / control-room blue.
const oceanBlue = makeTheme({
    mode: 'dark',
    primary: { main: '#22d3ee' },
    secondary: { main: '#60a5fa' },
    background: { default: '#061826', paper: '#0b2942' },
    divider: '#164e63',
    text: { primary: '#e0f7ff', secondary: '#93c5fd' },
});

// 6) amber-night - dark theme with warm amber accents.
const amberNight = makeTheme({
    mode: 'dark',
    primary: { main: '#f59e0b' },
    secondary: { main: '#fb7185' },
    background: { default: '#18120a', paper: '#241a0f' },
    divider: '#4a3417',
    text: { primary: '#fff7ed', secondary: '#f8c471' },
});

// 7) green-terminal - black/green SCADA-style theme.
const greenTerminal = makeTheme({
    mode: 'dark',
    primary: { main: '#22c55e' },
    secondary: { main: '#84cc16' },
    background: { default: '#06120b', paper: '#0b1f13' },
    divider: '#14532d',
    text: { primary: '#dcfce7', secondary: '#86efac' },
});

// 8) violet-control - purple/cyan command-centre look.
const violetControl = makeTheme({
    mode: 'dark',
    primary: { main: '#a78bfa' },
    secondary: { main: '#22d3ee' },
    background: { default: '#111027', paper: '#1d1b3a' },
    divider: '#373065',
    text: { primary: '#f5f3ff', secondary: '#c4b5fd' },
});

// 9) graphite - low-glare neutral dark.
const graphite = makeTheme({
    mode: 'dark',
    primary: { main: '#94a3b8' },
    secondary: { main: '#38bdf8' },
    background: { default: '#111827', paper: '#1f2937' },
    divider: '#374151',
    text: { primary: '#f3f4f6', secondary: '#cbd5e1' },
});

// 10) sand-light - softer light theme for office/report use.
const sandLight = makeTheme({
    mode: 'light',
    primary: { main: '#b45309' },
    secondary: { main: '#0f766e' },
    background: { default: '#f8f1e7', paper: '#fffaf0' },
    divider: '#d6c2a8',
    text: { primary: '#1f2937', secondary: '#6b4f2a' },
});

// 11) marine - deep sea blue with green live-data accents.
const marine = makeTheme({
    mode: 'dark',
    primary: { main: '#06b6d4' },
    secondary: { main: '#34d399' },
    background: { default: '#071923', paper: '#0f2a35' },
    divider: '#155e75',
    text: { primary: '#ecfeff', secondary: '#a5f3fc' },
});

// 12) steel - industrial blue-gray with clear contrast.
const steel = makeTheme({
    mode: 'dark',
    primary: { main: '#60a5fa' },
    secondary: { main: '#fbbf24' },
    background: { default: '#121820', paper: '#202b38' },
    divider: '#415066',
    text: { primary: '#f8fafc', secondary: '#bac7d6' },
});

// 13) night-red - dark alarm-room theme with red accent.
const nightRed = makeTheme({
    mode: 'dark',
    primary: { main: '#ef4444' },
    secondary: { main: '#f97316' },
    background: { default: '#130b0d', paper: '#211114' },
    divider: '#4c1d22',
    text: { primary: '#fff1f2', secondary: '#fecdd3' },
});

// 14) emerald - green operator theme for low-light rooms.
const emerald = makeTheme({
    mode: 'dark',
    primary: { main: '#10b981' },
    secondary: { main: '#38bdf8' },
    background: { default: '#07150f', paper: '#10251b' },
    divider: '#166534',
    text: { primary: '#ecfdf5', secondary: '#a7f3d0' },
});

// 15) daylight-blue - bright office theme with blue controls.
const daylightBlue = makeTheme({
    mode: 'light',
    primary: { main: '#2563eb' },
    secondary: { main: '#0891b2' },
    background: { default: '#eaf2ff', paper: '#ffffff' },
    divider: '#bfdbfe',
    text: { primary: '#0f172a', secondary: '#334155' },
});

// 16) slate-amber - balanced dark slate with amber highlights.
const slateAmber = makeTheme({
    mode: 'dark',
    primary: { main: '#fbbf24' },
    secondary: { main: '#38bdf8' },
    background: { default: '#0f141d', paper: '#1b2430' },
    divider: '#3b4556',
    text: { primary: '#f8fafc', secondary: '#cbd5e1' },
});

// Ordered list so the switcher renders deterministically.
export const THEMES = [
    { name: 'control-dark', label: 'Control Dark', theme: controlDark },
    { name: 'hp-hmi', label: 'HP-HMI (ISA-101)', theme: hpHmi },
    { name: 'light', label: 'Light', theme: light },
    { name: 'high-contrast', label: 'High Contrast', theme: highContrast },
    { name: 'ocean-blue', label: 'Ocean Blue', theme: oceanBlue },
    { name: 'amber-night', label: 'Amber Night', theme: amberNight },
    { name: 'green-terminal', label: 'Green Terminal', theme: greenTerminal },
    { name: 'violet-control', label: 'Violet Control', theme: violetControl },
    { name: 'graphite', label: 'Graphite', theme: graphite },
    { name: 'sand-light', label: 'Sand Light', theme: sandLight },
    { name: 'marine', label: 'Marine', theme: marine },
    { name: 'steel', label: 'Steel', theme: steel },
    { name: 'night-red', label: 'Night Red', theme: nightRed },
    { name: 'emerald', label: 'Emerald', theme: emerald },
    { name: 'daylight-blue', label: 'Daylight Blue', theme: daylightBlue },
    { name: 'slate-amber', label: 'Slate Amber', theme: slateAmber },
];

const THEME_MAP = THEMES.reduce((acc, t) => { acc[t.name] = t; return acc; }, {});
const DEFAULT_THEME = 'control-dark';

const ThemeModeContext = createContext(null);

function readStoredTheme() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && THEME_MAP[stored]) return stored;
    } catch (e) {
        // localStorage unavailable (private mode / SSR) — fall back to default.
    }
    return DEFAULT_THEME;
}

export const ThemeModeProvider = ({ children }) => {
    const [themeName, setThemeNameState] = useState(readStoredTheme);

    const setThemeName = useCallback((name) => {
        if (!THEME_MAP[name]) return;
        setThemeNameState(name);
        try {
            localStorage.setItem(STORAGE_KEY, name);
        } catch (e) {
            // Persisting is best-effort.
        }
    }, []);

    const activeTheme = THEME_MAP[themeName]?.theme || controlDark;

    const value = useMemo(() => ({
        themeName,
        setThemeName,
        themes: THEMES,
    }), [themeName, setThemeName]);

    return (
        <ThemeModeContext.Provider value={value}>
            <ThemeProvider theme={activeTheme}>
                <CssBaseline />
                {children}
            </ThemeProvider>
        </ThemeModeContext.Provider>
    );
};

export const useThemeMode = () => {
    const ctx = useContext(ThemeModeContext);
    if (!ctx) {
        throw new Error('useThemeMode must be used within a ThemeModeProvider');
    }
    return ctx;
};
