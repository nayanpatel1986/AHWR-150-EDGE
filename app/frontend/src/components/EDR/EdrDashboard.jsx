import React from 'react';
import { Box, Typography, Chip } from '@mui/material';
import { Activity } from 'lucide-react';
import EdrView from './EdrView';

const DEFAULT_STRIPS = [
    {
        title: 'Hookload / WOB',
        pens: [
            { channelId: 'drilling.wob', color: '#38bdf8', min: 0, max: 100, enabled: true },
            { channelId: 'drilling.hook_load', color: '#fbbf24', min: 0, max: 500, enabled: true },
            { channelId: 'drawworks.block_position', color: '#4ade80', min: 0, max: 50, enabled: true }
        ]
    },
    {
        title: 'Rotary',
        pens: [
            { channelId: 'drilling.rop', color: '#f472b6', min: 0, max: 80, enabled: true }
        ]
    },
    {
        title: 'Pump',
        pens: [
            { channelId: 'mudpump.spm', color: '#fb7185', min: 0, max: 200, enabled: true },
            { channelId: 'mudpump.pressure', color: '#38bdf8', min: 0, max: 7500, scaleUnit: 'psi', enabled: true },
            { channelId: 'mudpump.flow_in', color: '#f97316', min: 0, max: 3000, enabled: true }
        ]
    },
    {
        title: 'Mud Volumes',
        pens: [
            { channelId: 'fluid.total_tank_volume', color: '#4ade80', min: 0, max: 500, enabled: true },
            { channelId: 'fluid.tank_gain_loss', color: '#fbbf24', min: -50, max: 50, enabled: true },
            { channelId: 'fluid.trip_tank', color: '#a78bfa', min: 0, max: 50, enabled: true }
        ]
    }
];

const TOP_READOUTS = [
    'mudpump.pressure',
    'mudpump.spm',
    'drilling.rop',
    'drilling.hook_load'
];

export default function EdrStandalonePage() {
    return (
        <Box sx={{ height: 'calc(100vh - 100px)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5, flexWrap: 'wrap' }}>
                <Activity size={22} />
                <Typography variant="h5" sx={{ fontWeight: 'bold' }}>
                    Electronic Drilling Recorder (EDR)
                </Typography>
                <Chip
                    size="small"
                    label="Strip-chart log"
                    sx={{ fontWeight: 800 }}
                    color="primary"
                    variant="outlined"
                />
            </Box>
            <Box sx={{ flex: '1 1 auto', minHeight: 0 }}>
                <EdrView
                    mode="full"
                    storageKey="edr-main"
                    defaultStrips={DEFAULT_STRIPS}
                    rightReadouts={TOP_READOUTS}
                />
            </Box>
        </Box>
    );
}
