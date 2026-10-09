import React from 'react';
import { Box, Typography, Paper } from '@mui/material';

const RigVisualizer = ({
    blockPosition = 0,
    slipsIn = false,
    slipInRaw = 0,
    slipOutRaw = 0,
    height = { xs: 520, md: 'clamp(500px, 52vh, 620px)' }
}) => {
    const slipInActive = Number(slipInRaw) > 0;
    const slipOutActive = Number(slipOutRaw) > 0;
    const slipStatusText = slipInActive ? 'IN' : (slipOutActive ? 'OUT' : '--');
    const slipStatusActive = slipInActive || slipOutActive || slipsIn;

    // blockPosition is expected to be 0 to 40000 mm.
    // Parse the raw position, fallback to 0
    const rawPos = Number(blockPosition) || 0;

    // The physical movement range in mm
    const minMm = 1400;
    const maxMm = 14000;

    // Clamp value for visual rendering so it doesn't break out of bounds
    const clampedPos = Math.max(minMm, Math.min(maxMm, rawPos));

    // Calculate percentage (0 = bottom, 1 = top)
    const percent = (clampedPos - minMm) / (maxMm - minMm);
    
    // Use the full height of the tall ACS card while keeping the travelling
    // block below the colored crown-saver zones.
    const blockY = 490 - (percent * (490 - 180));

    // Saver conditions
    const showCrownSaver = rawPos >= 14700;
    const showBottomSaver = rawPos <= 1100;

    return (
        <Paper
            sx={{
                p: 1.5,
                pt: 1,
                pb: 1,
                bgcolor: 'rgba(15, 23, 42, 0.6)',
                backdropFilter: 'blur(12px)',
                border: '1px solid rgba(56, 189, 248, 0.2)',
                borderRadius: 3,
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
                color: 'white',
                height: height,
                minHeight: height === '100%' ? 0 : { xs: 560, md: 560 },
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                position: 'relative',
                overflow: 'hidden',
                transition: 'all 0.2s',
            }}
        >
            {/* Header */}
            <Typography 
                variant="subtitle2" 
                sx={{ 
                    color: '#38bdf8',
                    fontWeight: '800',
                    mb: 0.5,
                    letterSpacing: 1.5,
                    textAlign: 'center',
                    textShadow: '0 0 10px rgba(56, 189, 248, 0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 1
                }}
            >
                ACS
            </Typography>

            <Box
                sx={{
                    position: 'relative',
                    width: 'min(100%, 360px)',
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: 0
                }}
            >
                {/* SVG Schematic Layer */}
                <svg width="100%" height="100%" viewBox="-20 20 260 540" preserveAspectRatio="xMidYMid meet" style={{ flex: 1, maxHeight: '100%', minHeight: 200 }}>
                    <defs>
                        <linearGradient id="derrick-bg" x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#1e293b" />
                            <stop offset="100%" stopColor="#0f172a" />
                        </linearGradient>
                    </defs>

                    {/* Derrick Silhouette Background */}
                    <polygon points="30,40 190,40 230,540 -10,540" fill="url(#derrick-bg)" />
                    <polygon points="30,40 190,40 230,540 -10,540" fill="none" stroke="#334155" strokeWidth="4" />

                    {/* Horizontal Bracing Lines */}
                    <line x1="21" y1="150" x2="199" y2="150" stroke="#334155" strokeWidth="2" />
                    <line x1="12" y1="270" x2="208" y2="270" stroke="#334155" strokeWidth="2" />
                    <line x1="2" y1="390" x2="218" y2="390" stroke="#334155" strokeWidth="2" />
                    <line x1="-8" y1="510" x2="228" y2="510" stroke="#334155" strokeWidth="2" />

                    {/* Color Zones */}
                    {/* Top Red Zone */}
                    <polygon points="30,40 190,40 197,130 23,130" fill="#ef4444" opacity="0.9" />
                    {/* Top Yellow Zone */}
                    <polygon points="23,130 197,130 201,175 19,175" fill="#f59e0b" opacity="0.9" />
                    {/* Bottom Yellow Zone */}
                    <polygon points="-8,510 228,510 230,540 -10,540" fill="#f59e0b" opacity="0.9" />
                    <text
                        x="110"
                        y="530"
                        textAnchor="middle"
                        fill="#075985"
                        fontSize="14"
                        fontWeight="900"
                        letterSpacing="1.4"
                    >
                        BLK POS
                    </text>

                    {/* Crown Block */}
                    <rect x="50" y="25" width="120" height="15" fill="#334155" stroke="#475569" strokeWidth="2" rx="4" />
                    <circle cx="75" cy="32" r="4" fill="#cbd5e1" />
                    <circle cx="145" cy="32" r="4" fill="#cbd5e1" />

                    {/* Floor Base */}
                    <rect x="-20" y="550" width="260" height="8" fill="#1e293b" rx="2" />
                    {/* Static Ropes from Crown down to the lower travel position. */}
                    <line x1="75" y1="35" x2="75" y2="490" stroke="#0f172a" strokeWidth="3" />
                    <line x1="145" y1="35" x2="145" y2="490" stroke="#0f172a" strokeWidth="3" />

                    {/* ANIMATED TRAVELLING BLOCK inside main SVG */}
                    <g style={{ transform: `translate(110px, ${blockY}px)`, transition: 'transform 0.5s ease-out' }}>
                        {/* White connecting clips (top) */}
                        <line x1="-35" y1="-3" x2="-35" y2="3" stroke="#ffffff" strokeWidth="4" />
                        <line x1="35" y1="-3" x2="35" y2="3" stroke="#ffffff" strokeWidth="4" />

                        {/* Traveling Block Box */}
                        <rect x="-70" y="-12" width="140" height="68" rx="8" fill="#f59e0b" stroke="#fbbf24" strokeWidth="3" />
                        <rect x="-62" y="-4" width="124" height="52" rx="6" fill="#07111d" stroke="#38bdf8" strokeWidth="3" />

                        <text x="0" y="34" textAnchor="middle" fill="#ffffff" fontSize="34" fontWeight="900" letterSpacing="0" style={{ filter: 'drop-shadow(0px 0px 7px rgba(56,189,248,1))' }}>
                            {Math.round(rawPos)}
                        </text>
                    </g>
                </svg>

                {/* Popups for Saver Conditions */}
                {showCrownSaver && (
                    <Box sx={{
                        position: 'absolute', top: '15%', left: '50%', transform: 'translateX(-50%)',
                        bgcolor: '#ef4444', color: 'white', px: 2, py: 0.5, borderRadius: 1,
                        fontWeight: 'bold', zIndex: 20, boxShadow: '0 0 10px #ef4444',
                        animation: 'flash 1s infinite alternate',
                        textAlign: 'center', whiteSpace: 'nowrap', lineHeight: 1.2,
                        '@keyframes flash': { '0%': { opacity: 1 }, '100%': { opacity: 0.5 } }
                    }}>
                        CROWN SAVER<br/>ON
                    </Box>
                )}

                {showBottomSaver && (
                    <Box sx={{
                        position: 'absolute', bottom: '15%', left: '50%', transform: 'translateX(-50%)',
                        bgcolor: '#ef4444', color: 'white', px: 2, py: 0.5, borderRadius: 1,
                        fontWeight: 'bold', zIndex: 20, boxShadow: '0 0 10px #ef4444',
                        animation: 'flash 1s infinite alternate',
                        textAlign: 'center', whiteSpace: 'nowrap', lineHeight: 1.2
                    }}>
                        BOTTOM SAVER<br/>ON
                    </Box>
                )}
            </Box>

            {/* SLIPS Indicator at the very bottom */}
            <Box sx={{
                mt: 0.5,
                width: 'min(100%, 360px)', // Match the exact width of the derrick container above
                bgcolor: '#064e3b',
                border: '1px solid #059669',
                borderRadius: 2,
                py: 1,
                px: 3,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                boxSizing: 'border-box'
            }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Box sx={{ 
                        width: 14, 
                        height: 14, 
                        borderRadius: '50%', 
                        bgcolor: slipStatusActive ? '#34d399' : '#10b981',
                        boxShadow: slipStatusActive ? '0 0 10px #34d399' : 'none',
                        opacity: slipStatusActive ? 1 : 0.3,
                        mt: '1px' // optical alignment fix
                    }} />
                    <Typography sx={{ color: '#a7f3d0', fontWeight: 800, letterSpacing: 2, fontSize: '0.85rem', lineHeight: 1 }}>
                        SLIPS
                    </Typography>
                </Box>
                <Typography sx={{ color: '#34d399', fontWeight: 900, letterSpacing: 2, fontSize: '1.2rem', lineHeight: 1 }}>
                    {slipStatusText}
                </Typography>
            </Box>
        </Paper>
    );
};

export default RigVisualizer;
