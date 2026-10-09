import React, { Suspense, useState } from 'react';
import { Box, Tabs, Tab } from '@mui/material';
import { ShieldAlert, Anchor, Wrench } from 'lucide-react';
import { ErrorBoundary } from '../ErrorBoundary';
import { lazyWithRetry } from '../../lazyWithRetry';

// Operations workspace — groups the well-service operation screens under one
// tabbed page (Well Control / Fishing / Workover). Panels are the existing
// dashboards, lazy-loaded and kept mounted once opened.
const WellControlDashboard = lazyWithRetry(() => import('../WellControl/WellControlDashboard'), 'operations-well-control');
const FishingDashboard = lazyWithRetry(() => import('../Fishing/FishingDashboard'), 'operations-fishing');
const WorkoverPage = lazyWithRetry(() => import('../Workover/WorkoverPage'), 'operations-workover');

const TABS = [
    { key: 'wellcontrol', label: 'Well Control', icon: <ShieldAlert size={18} />, Comp: WellControlDashboard },
    { key: 'fishing', label: 'Fishing', icon: <Anchor size={18} />, Comp: FishingDashboard },
    { key: 'workover', label: 'Workover', icon: <Wrench size={18} />, Comp: WorkoverPage },
];

export default function OperationsPage() {
    const [tab, setTab] = useState(0);
    const [seen, setSeen] = useState(() => new Set([0])); // keep visited tabs mounted

    const onChange = (_e, v) => { setTab(v); setSeen((s) => new Set(s).add(v)); };

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Box sx={{ borderBottom: 1, borderColor: 'divider', flex: '0 0 auto' }}>
                <Tabs value={tab} onChange={onChange} variant="scrollable" allowScrollButtonsMobile>
                    {TABS.map((t) => (
                        <Tab key={t.key} icon={t.icon} iconPosition="start" label={t.label} sx={{ minHeight: 48, textTransform: 'none', fontWeight: 600 }} />
                    ))}
                </Tabs>
            </Box>
            <Box sx={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
                {TABS.map((t, i) => (
                    seen.has(i) ? (
                        <Box key={t.key} sx={{ display: tab === i ? 'block' : 'none', height: '100%' }}>
                            <ErrorBoundary>
                                <Suspense fallback={<Box sx={{ p: 3, color: 'text.secondary' }}>Loading…</Box>}>
                                    <t.Comp />
                                </Suspense>
                            </ErrorBoundary>
                        </Box>
                    ) : null
                ))}
            </Box>
        </Box>
    );
}
