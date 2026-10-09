import React, { Suspense, useMemo, useState } from 'react';
import { Box, Tabs, Tab } from '@mui/material';
import { Cable, ShieldCheck } from 'lucide-react';
import { ErrorBoundary } from '../ErrorBoundary';
import { lazyWithRetry } from '../../lazyWithRetry';
import { useAuth } from '../../context/AuthContext';

// Settings workspace — Variables mapping for everyone (read-only unless admin),
// and Administration (users / PLC config / system) for admins only.
const VariablesPage = lazyWithRetry(() => import('../Variables/VariablesPage'), 'settings-variables');
const AdminPanel = lazyWithRetry(() => import('../Admin/AdminPanel'), 'settings-admin');

export default function SettingsPage() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'admin';

    const tabs = useMemo(() => {
        const t = [{ key: 'variables', label: 'Variables', icon: <Cable size={18} />, Comp: VariablesPage }];
        if (isAdmin) t.push({ key: 'admin', label: 'Administration', icon: <ShieldCheck size={18} />, Comp: AdminPanel });
        return t;
    }, [isAdmin]);

    const [tab, setTab] = useState(0);
    const safeTab = Math.min(tab, tabs.length - 1);

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Box sx={{ borderBottom: 1, borderColor: 'divider', flex: '0 0 auto' }}>
                <Tabs value={safeTab} onChange={(_e, v) => setTab(v)} variant="scrollable" allowScrollButtonsMobile>
                    {tabs.map((t) => (
                        <Tab key={t.key} icon={t.icon} iconPosition="start" label={t.label} sx={{ minHeight: 48, textTransform: 'none', fontWeight: 600 }} />
                    ))}
                </Tabs>
            </Box>
            <Box sx={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
                {tabs.map((t, i) => (
                    <Box key={t.key} sx={{ display: safeTab === i ? 'block' : 'none', height: '100%' }}>
                        <ErrorBoundary>
                            <Suspense fallback={<Box sx={{ p: 3, color: 'text.secondary' }}>Loading…</Box>}>
                                <t.Comp />
                            </Suspense>
                        </ErrorBoundary>
                    </Box>
                ))}
            </Box>
        </Box>
    );
}
