import React from 'react';
import { Box, Paper } from '@mui/material';

export const gaugeCardBaseSx = {
    p: { xs: 1.5, md: 2 },
    bgcolor: '#1e293b',
    border: '1px solid #334155',
    color: 'white',
    height: '100%',
    minHeight: { xs: 280, sm: 300, lg: 340 },
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
};

export default function GaugeCard({ children, footer, sx, contentSx, opacity = 1 }) {
    const sxList = Array.isArray(sx) ? sx : [sx];

    return (
        <Paper sx={[gaugeCardBaseSx, { opacity }, ...sxList]}>
            <Box
                sx={[
                    {
                        width: '100%',
                        flex: '1 1 auto',
                        minHeight: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    },
                    ...(Array.isArray(contentSx) ? contentSx : [contentSx])
                ]}
            >
                {children}
            </Box>
            {footer}
        </Paper>
    );
}
