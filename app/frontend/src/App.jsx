import { Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout/Layout';
import { lazyWithRetry } from './lazyWithRetry';
const RigOverview = lazyWithRetry(() => import('./components/RigOverview/RigOverview'), 'rig-overview');
const RigConsoleOverview = lazyWithRetry(() => import('./components/RigOverview/RigConsoleOverview'), 'rig-console-overview');
const WellControlDashboard = lazyWithRetry(() => import('./components/WellControl/WellControlDashboard'), 'well-control');
const EdrDashboard = lazyWithRetry(() => import('./components/EDR/EdrDashboard'), 'edr');
const FishingDashboard = lazyWithRetry(() => import('./components/Fishing/FishingDashboard'), 'fishing');
const EquipmentHub = lazyWithRetry(() => import('./components/Dashboards/EquipmentHub'), 'equipment');
const ActivityPage = lazyWithRetry(() => import('./components/Activity/ActivityPage'), 'activity');
const AlarmsPage = lazyWithRetry(() => import('./components/Alarms/AlarmsPage'), 'alarms');
const WorkoverPage = lazyWithRetry(() => import('./components/Workover/WorkoverPage'), 'workover');
const ReportsPage = lazyWithRetry(() => import('./components/Reports/ReportsPage'), 'reports');
const MaintenancePage = lazyWithRetry(() => import('./components/Maintenance/MaintenancePage'), 'maintenance');
const EfficiencyPage = lazyWithRetry(() => import('./components/Efficiency/EfficiencyPage'), 'efficiency');
const VariablesPage = lazyWithRetry(() => import('./components/Variables/VariablesPage'), 'variables');
const EdgeSyncPage = lazyWithRetry(() => import('./components/Sync/EdgeSyncPage'), 'edge-sync');
const OperationsPage = lazyWithRetry(() => import('./components/Operations/OperationsPage'), 'operations');
const WellPage = lazyWithRetry(() => import('./components/Well/WellPage'), 'well');
const SettingsPage = lazyWithRetry(() => import('./components/Settings/SettingsPage'), 'settings');

const PRELOAD_ROUTES = [
    RigConsoleOverview,
    EquipmentHub,
    EdrDashboard,
    MaintenancePage,
    WellPage,
    EfficiencyPage,
    AlarmsPage,
    ActivityPage,
    WorkoverPage,
    WellControlDashboard,
    ReportsPage,
    VariablesPage,
    EdgeSyncPage,
    OperationsPage,
    FishingDashboard,
    RigOverview,
    SettingsPage
];

import { ThemeModeProvider } from './context/ThemeModeContext';
import { AuthProvider } from './context/AuthContext';
import { AlarmProvider } from './context/AlarmContext';
import Login from './components/Auth/Login';
import ProtectedRoute from './components/Auth/ProtectedRoute';
import RoleRoute from './components/Auth/RoleRoute';
import { useAuth } from './context/AuthContext';

import { ErrorBoundary } from './components/ErrorBoundary';

const screen = (Component) => (
    <ErrorBoundary>
        <Suspense fallback={<div style={{ padding: 24, color: '#94a3b8' }}>Loading...</div>}>
            <Component />
        </Suspense>
    </ErrorBoundary>
);

function RoutePreloader() {
    const { token } = useAuth();
    useEffect(() => {
        if (!token) return undefined;
        const timer = setTimeout(() => {
            PRELOAD_ROUTES.forEach((Component) => {
                Component.preload?.().catch(() => {});
            });
        }, 800);
        return () => clearTimeout(timer);
    }, [token]);
    return null;
}

function App() {
    return (
        <ThemeModeProvider>
            <AuthProvider>
                <RoutePreloader />
                <AlarmProvider>
                    <BrowserRouter>
                        <Routes>
                            <Route path="/login" element={<Login />} />

                            <Route element={<ProtectedRoute />}>
                                <Route path="/" element={<Layout />}>
                                <Route index element={screen(RigConsoleOverview)} />
                                <Route path="overview-classic" element={screen(RigOverview)} />
                                <Route path="engine" element={<Navigate to="/equipment" replace />} />
                                <Route path="wellcontrol" element={screen(WellControlDashboard)} />
                                <Route path="fishing" element={screen(FishingDashboard)} />
                                <Route path="edr" element={screen(EdrDashboard)} />
                                <Route path="equipment" element={screen(EquipmentHub)} />
                                <Route path="activity" element={screen(ActivityPage)} />
                                <Route path="alarms" element={screen(AlarmsPage)} />
                                <Route path="operations" element={screen(OperationsPage)} />
                                <Route path="well" element={screen(WellPage)} />
                                <Route path="workover" element={screen(WorkoverPage)} />
                                <Route path="reports" element={screen(ReportsPage)} />
                                <Route path="maintenance" element={screen(MaintenancePage)} />
                                <Route path="efficiency" element={screen(EfficiencyPage)} />
                                <Route path="variables" element={screen(VariablesPage)} />
                                <Route path="sync" element={screen(EdgeSyncPage)} />
                                <Route element={<RoleRoute allow={['admin']} />}>
                                    <Route path="settings" element={screen(SettingsPage)} />
                                </Route>
                                <Route path="admin" element={<Navigate to="/settings" replace />} />
                                <Route path="*" element={screen(RigOverview)} />
                                </Route>
                            </Route>
                        </Routes>
                    </BrowserRouter>
                </AlarmProvider>
            </AuthProvider>
        </ThemeModeProvider>
    );
}

export default App;
