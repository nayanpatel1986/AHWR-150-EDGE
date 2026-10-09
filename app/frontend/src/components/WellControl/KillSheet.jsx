import React, { useState, useEffect } from 'react';
import { Box, Typography, Paper, Grid, TextField, Button, Divider, Alert } from '@mui/material';
import { Calculator, Save } from 'lucide-react';

const KillSheet = () => {
    // Inputs
    const [inputs, setInputs] = useState({
        sidpp: 500,       // psi
        sicp: 750,        // psi
        omw: 10.0,        // ppg (Original Mud Weight)
        tvd: 10000,       // ft
        pl: 600,          // psi (Pump Pressure @ Slow Circulating Rate)
        shoeTvd: 4000,    // ft (Casing Shoe TVD)
        maxLot: 13.5      // ppg (Max Leak-off Test / Fracture Gradient)
    });

    // Outputs
    const [results, setResults] = useState({
        kmw: 0,
        icp: 0,
        fcp: 0,
        maasp: 0
    });

    // Calculation Logic
    useEffect(() => {
        const { sidpp, sicp, omw, tvd, pl, shoeTvd, maxLot } = inputs;

        // 1. Kill Mud Weight (ppg)
        // KMW = OMW + (SIDPP / (0.052 * TVD))
        const kmwVal = Number(omw) + (Number(sidpp) / (0.052 * Number(tvd)));

        // 2. Initial Circulating Pressure (psi)
        // ICP = SIDPP + PL
        const icpVal = Number(sidpp) + Number(pl);

        // 3. Final Circulating Pressure (psi)
        // FCP = PL * (KMW / OMW)
        const fcpVal = Number(pl) * (kmwVal / Number(omw));

        // 4. MAASP (psi)
        // MAASP = (Max LOT - Current MW) * 0.052 * Shoe TVD
        const maaspVal = (Number(maxLot) - Number(omw)) * 0.052 * Number(shoeTvd);

        setResults({
            kmw: isFinite(kmwVal) ? kmwVal.toFixed(2) : 0,
            icp: isFinite(icpVal) ? icpVal.toFixed(2) : 0,
            fcp: isFinite(fcpVal) ? fcpVal.toFixed(2) : 0,
            maasp: isFinite(maaspVal) ? maaspVal.toFixed(2) : 0
        });
    }, [inputs]);

    const handleChange = (e) => {
        const { name, value } = e.target;
        setInputs(prev => ({ ...prev, [name]: value }));
    };

    return (
        <Paper sx={{ p: { xs: 2, md: 4 }, bgcolor: '#121620', color: 'white', borderRadius: 4, border: 'none', boxShadow: 'none' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 4 }}>
                <Calculator size={24} color="#fbbf24" />
                <Typography variant="h6" sx={{ fontWeight: 900, letterSpacing: 1, textTransform: 'uppercase' }}>Well Control Kill Sheet (API RP 59)</Typography>
            </Box>

            <Grid container spacing={4}>
                {/* --- INPUT SECTION --- */}
                <Grid item xs={12} md={6}>
                    <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2, textTransform: 'uppercase', letterSpacing: 1 }}>
                        Input Data
                    </Typography>

                    <Grid container spacing={2}>
                        <Grid item xs={12}>
                            <TextField
                                label="SIDPP (psi)" name="sidpp" type="number"
                                value={inputs.sidpp} onChange={handleChange}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white', bgcolor: '#1a2235', borderRadius: 2 }, '& .MuiOutlinedInput-notchedOutline': { borderColor: '#334155' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <TextField
                                label="SICP (psi)" name="sicp" type="number"
                                value={inputs.sicp} onChange={handleChange}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white', bgcolor: '#1a2235', borderRadius: 2 }, '& .MuiOutlinedInput-notchedOutline': { borderColor: '#334155' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <TextField
                                label="Original MW (ppg)" name="omw" type="number"
                                value={inputs.omw} onChange={handleChange}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white', bgcolor: '#1a2235', borderRadius: 2 }, '& .MuiOutlinedInput-notchedOutline': { borderColor: '#334155' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <TextField
                                label="True Vertical Depth (ft)" name="tvd" type="number"
                                value={inputs.tvd} onChange={handleChange}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white', bgcolor: '#1a2235', borderRadius: 2 }, '& .MuiOutlinedInput-notchedOutline': { borderColor: '#334155' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <TextField
                                label="Pump Pressure @ SCR (psi)" name="pl" type="number"
                                value={inputs.pl} onChange={handleChange}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white', bgcolor: '#1a2235', borderRadius: 2 }, '& .MuiOutlinedInput-notchedOutline': { borderColor: '#334155' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                        </Grid>
                        <Grid item xs={12}>
                            {/* Spacer or additional input like Shoe Depth */}
                            <TextField
                                label="Casing Shoe TVD (ft)" name="shoeTvd" type="number"
                                value={inputs.shoeTvd} onChange={handleChange}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white', bgcolor: '#1a2235', borderRadius: 2 }, '& .MuiOutlinedInput-notchedOutline': { borderColor: '#334155' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <TextField
                                label="Max LOT (ppg)" name="maxLot" type="number"
                                value={inputs.maxLot} onChange={handleChange}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white', bgcolor: '#1a2235', borderRadius: 2 }, '& .MuiOutlinedInput-notchedOutline': { borderColor: '#334155' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                        </Grid>
                    </Grid>
                </Grid>

                {/* --- OUTPUT SECTION --- */}
                <Grid item xs={12} md={6}>
                    <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2, textTransform: 'uppercase', letterSpacing: 1 }}>
                        Calculated Data
                    </Typography>

                    <Grid container spacing={2}>
                        {/* KMW */}
                        <Grid item xs={12}>
                            <Box sx={{ p: 3, bgcolor: '#1a2235', borderRadius: 2, border: '1px solid #1e293b', borderLeft: '4px solid #ef4444', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Box>
                                    <Typography variant="caption" sx={{ color: '#94a3b8' }}>KILL MUD WEIGHT (KMW)</Typography>
                                    <Typography variant="h4" sx={{ color: '#ef4444', fontWeight: 'bold' }}>{results.kmw} <span style={{ fontSize: '0.6em' }}>ppg</span></Typography>
                                </Box>
                                <Box sx={{ textAlign: 'right' }}>
                                    <Typography variant="caption" sx={{ color: '#64748b' }}>Increase Requirement</Typography>
                                    <Typography variant="body2" sx={{ color: '#94a3b8' }}>+{(results.kmw - inputs.omw).toFixed(2)} ppg</Typography>
                                </Box>
                            </Box>
                        </Grid>

                        {/* ICP & FCP */}
                        <Grid item xs={6}>
                            <Box sx={{ p: 3, bgcolor: '#1a2235', borderRadius: 2, border: '1px solid #1e293b', borderLeft: '4px solid #06b6d4' }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8' }}>ICP (Initial Circ. Press)</Typography>
                                <Typography variant="h5" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{results.icp} <span style={{ fontSize: '0.6em' }}>psi</span></Typography>
                            </Box>
                        </Grid>
                        <Grid item xs={6}>
                            <Box sx={{ p: 3, bgcolor: '#1a2235', borderRadius: 2, border: '1px solid #1e293b', borderLeft: '4px solid #06b6d4' }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8' }}>FCP (Final Circ. Press)</Typography>
                                <Typography variant="h5" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{results.fcp} <span style={{ fontSize: '0.6em' }}>psi</span></Typography>
                            </Box>
                        </Grid>

                        {/* MAASP */}
                        <Grid item xs={12}>
                            <Box sx={{ p: 3, bgcolor: '#1a2235', borderRadius: 2, border: '1px solid #1e293b', borderLeft: '4px solid #eab308' }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8' }}>MAASP (Max Allowable Annular Surface Pressure)</Typography>
                                <Typography variant="h5" sx={{ color: '#eab308', fontWeight: 'bold' }}>{results.maasp} <span style={{ fontSize: '0.6em' }}>psi</span></Typography>
                                <Typography variant="caption" sx={{ color: '#64748b' }}>DO NOT EXCEED during kill operation</Typography>
                            </Box>
                        </Grid>
                    </Grid>
                </Grid>
            </Grid>

            <Divider sx={{ my: 3, bgcolor: '#334155' }} />

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
                <Button variant="outlined" sx={{ color: '#94a3b8', borderColor: '#475569' }}>Print / Export</Button>
                <Button variant="contained" startIcon={<Save size={18} />} sx={{ bgcolor: '#3b82f6' }}>Save Calculation</Button>
            </Box>
        </Paper>
    );
};

export default KillSheet;
