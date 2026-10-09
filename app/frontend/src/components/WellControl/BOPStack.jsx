import React from 'react';
import { Box, Typography, Paper } from '@mui/material';

const RamIndicator = ({ label, active }) => (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Box
            sx={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                bgcolor: active ? '#ef4444' : '#1e293b',
                border: active ? '2px solid #f87171' : '2px solid #475569',
                boxShadow: active ? '0 0 8px #ef4444' : 'none',
                transition: 'all 0.3s'
            }}
        />
        <Typography variant="caption" sx={{ color: active ? 'white' : '#64748b', fontWeight: active ? 'bold' : 'normal' }}>
            {label}
        </Typography>
    </Box>
);

const BOPStack = ({ rams, live = true, accumulatorPressure, children }) => {
    const status = live ? {
        annular: rams?.annular || { open: false, close: false },
        pipe: rams?.pipe || { open: false, close: false },
        blind: rams?.blind || { open: false, close: false },
        shear: rams?.shear || false
    } : {
        annular: { open: false, close: false },
        pipe: { open: false, close: false },
        blind: { open: false, close: false },
        shear: false
    };

    const RamPopup = ({ text, color, top }) => (
        <Box
            sx={{
                position: 'absolute',
                top,
                left: '50%',
                transform: 'translateX(-50%)',
                bgcolor: color === 'red' ? 'rgba(239, 68, 68, 0.95)' : 'rgba(34, 197, 94, 0.95)',
                px: 1.5,
                py: 0.5,
                borderRadius: 1,
                border: `2px solid ${color === 'red' ? '#fca5a5' : '#86efac'}`,
                boxShadow: `0 0 15px ${color === 'red' ? 'rgba(239, 68, 68, 0.6)' : 'rgba(34, 197, 94, 0.6)'}`,
                zIndex: 10,
                textAlign: 'center',
                pointerEvents: 'none',
                animation: 'pulseGlowBOP 1s ease-in-out infinite alternate',
                '@keyframes pulseGlowBOP': {
                    '0%': { opacity: 1, transform: 'translateX(-50%) scale(1)' },
                    '100%': { opacity: 0.85, transform: 'translateX(-50%) scale(1.05)' }
                }
            }}
        >
            <Typography variant="caption" sx={{ color: 'white', fontWeight: 'bold', fontSize: 10, letterSpacing: 1 }}>
                {text}
            </Typography>
        </Box>
    );

    return (
        <Paper
            sx={{
                p: { xs: 2, md: 3 },
                bgcolor: '#121620',
                color: 'white',
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                gap: { xs: 2, md: 4 },
                alignItems: 'center',
                justifyContent: 'flex-start',
                borderRadius: 4,
                border: 'none',
                boxShadow: 'none',
                overflow: 'hidden'
            }}
        >
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: { xs: 2, md: 4 }, width: '100%', justifyContent: 'center' }}>
            <Box
                sx={{
                    position: 'relative',
                    flex: '0 0 auto',
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'center',
                    height: 320,
                    width: 140
                }}
            >
                <Box sx={{ width: '100%', height: '100%' }}>
                    <svg width="100%" height="100%" viewBox="0 0 200 500" style={{ display: 'block' }}>
                        <defs>
                            <linearGradient id="bop-metal" x1="0%" y1="0%" x2="100%" y2="0%">
                                <stop offset="0%" stopColor="#1e293b" />
                                <stop offset="50%" stopColor="#334155" />
                                <stop offset="100%" stopColor="#1e293b" />
                            </linearGradient>
                            <linearGradient id="ram-active" x1="0%" y1="0%" x2="100%" y2="0%">
                                <stop offset="0%" stopColor="#ef4444" />
                                <stop offset="50%" stopColor="#dc2626" />
                                <stop offset="100%" stopColor="#ef4444" />
                            </linearGradient>
                        </defs>

                        <rect x="90" y="0" width="20" height="500" fill="url(#bop-metal)" stroke="#38bdf8" strokeWidth="1" />

                        <path d="M 50 20 L 150 20 L 160 80 L 150 120 L 50 120 L 40 80 Z" fill="url(#bop-metal)" stroke="#38bdf8" strokeWidth="2" style={{ filter: 'drop-shadow(0 0 10px rgba(56, 189, 248, 0.2))' }} />
                        <rect x="60" y="40" width="80" height="60" rx="6" fill={status.annular.close ? 'url(#ram-active)' : '#0f172a'} stroke="#38bdf8" strokeWidth="2" />
                        <text x="100" y="75" textAnchor="middle" fill="#bae6fd" fontSize="11" fontWeight="bold" letterSpacing="1">ANNULAR</text>

                        <g transform="translate(0, 160)">
                            <rect x="40" y="0" width="120" height="80" rx="8" fill="url(#bop-metal)" stroke="#38bdf8" strokeWidth="2" style={{ filter: 'drop-shadow(0 0 10px rgba(56, 189, 248, 0.2))' }} />
                            <rect x="45" y="20" width={status.pipe.close ? '55' : '30'} height="40" rx="4" fill={status.pipe.close ? 'url(#ram-active)' : '#0f172a'} stroke="#38bdf8" strokeWidth="2" style={{ transition: 'all 0.5s' }} />
                            <rect x={status.pipe.close ? '100' : '125'} y="20" width={status.pipe.close ? '55' : '30'} height="40" rx="4" fill={status.pipe.close ? 'url(#ram-active)' : '#0f172a'} stroke="#38bdf8" strokeWidth="2" style={{ transition: 'all 0.5s' }} />
                            <text x="100" y="45" textAnchor="middle" fill="#bae6fd" fontSize="11" fontWeight="bold" letterSpacing="1">PIPE RAM</text>
                        </g>
                        <rect x="60" y="140" width="80" height="20" fill="url(#bop-metal)" stroke="#38bdf8" strokeWidth="1" />

                        <g transform="translate(0, 260)">
                            <rect x="40" y="0" width="120" height="80" rx="8" fill="url(#bop-metal)" stroke="#38bdf8" strokeWidth="2" style={{ filter: 'drop-shadow(0 0 10px rgba(56, 189, 248, 0.2))' }} />
                            <rect x="45" y="20" width={status.blind.close ? '55' : '30'} height="40" rx="4" fill={status.blind.close ? 'url(#ram-active)' : '#0f172a'} stroke="#38bdf8" strokeWidth="2" style={{ transition: 'all 0.5s' }} />
                            <rect x={status.blind.close ? '100' : '125'} y="20" width={status.blind.close ? '55' : '30'} height="40" rx="4" fill={status.blind.close ? 'url(#ram-active)' : '#0f172a'} stroke="#38bdf8" strokeWidth="2" style={{ transition: 'all 0.5s' }} />
                            <text x="100" y="45" textAnchor="middle" fill="#bae6fd" fontSize="11" fontWeight="bold" letterSpacing="1">BLIND RAM</text>
                        </g>
                        <rect x="60" y="240" width="80" height="20" fill="url(#bop-metal)" stroke="#38bdf8" strokeWidth="1" />

                        <g transform="translate(0, 360)">
                            <rect x="40" y="0" width="120" height="80" rx="8" fill="url(#bop-metal)" stroke="#38bdf8" strokeWidth="2" style={{ filter: 'drop-shadow(0 0 10px rgba(56, 189, 248, 0.2))' }} />
                            <rect x="45" y="20" width={status.shear ? '55' : '30'} height="40" rx="4" fill={status.shear ? 'url(#ram-active)' : '#0f172a'} stroke="#38bdf8" strokeWidth="2" style={{ transition: 'all 0.5s' }} />
                            <rect x={status.shear ? '100' : '125'} y="20" width={status.shear ? '55' : '30'} height="40" rx="4" fill={status.shear ? 'url(#ram-active)' : '#0f172a'} stroke="#38bdf8" strokeWidth="2" style={{ transition: 'all 0.5s' }} />
                            <text x="100" y="45" textAnchor="middle" fill="#bae6fd" fontSize="11" fontWeight="bold" letterSpacing="1">SHEAR RAM</text>
                        </g>
                        <rect x="60" y="340" width="80" height="20" fill="url(#bop-metal)" stroke="#38bdf8" strokeWidth="1" />

                        <path d="M 60 460 L 140 460 L 150 500 L 50 500 Z" fill="url(#bop-metal)" stroke="#38bdf8" strokeWidth="2" style={{ filter: 'drop-shadow(0 0 10px rgba(56, 189, 248, 0.2))' }} />
                    </svg>
                </Box>

                {status.annular.open && <RamPopup text="ANNULAR OPEN" color="green" top="10%" />}
                {status.annular.close && <RamPopup text="ANNULAR CLOSE" color="red" top="10%" />}
                {status.pipe.open && <RamPopup text="PIPE RAM OPEN" color="green" top="36%" />}
                {status.pipe.close && <RamPopup text="PIPE RAM CLOSE" color="red" top="36%" />}
                {status.blind.open && <RamPopup text="BLIND RAM OPEN" color="green" top="56%" />}
                {status.blind.close && <RamPopup text="BLIND RAM CLOSE" color="red" top="56%" />}
            </Box>

            <Box sx={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <Typography variant="caption" sx={{ color: '#64748b', mb: 1.5, fontWeight: 800, letterSpacing: 1 }}>
                    RAM STATUS
                </Typography>

                {!live && (
                    <Typography variant="caption" sx={{ color: '#ef4444', fontWeight: 'bold', display: 'block', mb: 1 }}>
                        NO LIVE DATA - RAM POSITIONS UNKNOWN
                    </Typography>
                )}

                <RamIndicator label="ANNULAR PREVENTER" active={status.annular.close} />
                <RamIndicator label="PIPE RAMS" active={status.pipe.close} />
                <RamIndicator label="BLIND RAMS" active={status.blind.close} />
                <RamIndicator label="SHEAR RAMS" active={status.shear} />

                <Box sx={{ mt: 4 }}>
                    <Typography variant="caption" sx={{ color: '#64748b', display: 'block', mb: 0.5, fontWeight: 800, letterSpacing: 1 }}>
                        SYSTEM PRESSURE
                    </Typography>
                    {live && Number.isFinite(Number(accumulatorPressure)) ? (
                        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                            <Typography sx={{ color: '#06b6d4', fontWeight: 900, fontSize: '2.5rem', lineHeight: 1 }}>
                                {Number(accumulatorPressure).toFixed(2)}
                            </Typography>
                            <Typography sx={{ color: '#06b6d4', fontWeight: 700, fontSize: '1rem' }}>
                                PSI
                            </Typography>
                        </Box>
                    ) : (
                        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                            <Typography sx={{ color: '#64748b', fontWeight: 900, fontSize: '2.5rem', lineHeight: 1 }}>
                                -
                            </Typography>
                            <Typography sx={{ color: '#64748b', fontWeight: 700, fontSize: '1rem' }}>
                                NO DATA
                            </Typography>
                        </Box>
                    )}
                </Box>
            </Box>
            </Box>

            {children && (
                <Box sx={{ mt: 'auto', width: '100%' }}>
                    {children}
                </Box>
            )}
        </Paper>
    );
};

export default BOPStack;
