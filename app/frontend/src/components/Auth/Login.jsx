import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Paper, TextField, Button, Typography, Alert, Container, ToggleButtonGroup, ToggleButton } from '@mui/material';
import { User, Lock, Activity } from 'lucide-react';
import axios from '../../api';
import { useAuth } from '../../context/AuthContext';

const Login = () => {
    const [credentials, setCredentials] = useState({ username: '', password: '' });
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const navigate = useNavigate();
    const { login, user } = useAuth();
    const [authInfo, setAuthInfo] = useState(null);
    const [provider, setProvider] = useState('local');   // 'local' | 'domain'

    const domainMode = !!authInfo?.ldapEnabled && provider === 'domain';
    const userLabel = domainMode ? `${authInfo?.domain || 'DOMAIN'}\\username` : 'User ID';

    useEffect(() => {
        axios.get('/api/auth/info').then((r) => setAuthInfo(r.data)).catch(() => {});
    }, []);

    // Already authenticated -> skip the login form.
    useEffect(() => {
        if (user) navigate('/', { replace: true });
    }, [user, navigate]);

    const handleChange = (e) => {
        setCredentials({ ...credentials, [e.target.name]: e.target.value });
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            // Use relative path which will be proxied by Vite
            const API_URL = '';
            // In domain mode, qualify a bare username with the domain (DOMAIN\user).
            let username = credentials.username;
            if (domainMode && username && !username.includes('\\') && !username.includes('@') && authInfo?.domain) {
                username = `${authInfo.domain}\\${username}`;
            }
            const res = await axios.post(`${API_URL}/api/login`, { ...credentials, username });

            if (res.data.success) {
                login(res.data.user, res.data.token);
                navigate('/');
            }
        } catch (err) {
            setError(err.response?.data?.message || 'Failed to login. Please check server connection.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Box
            sx={{
                width: '100vw',
                height: '100vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: '#0f172a',
                backgroundImage: 'radial-gradient(circle at 50% 50%, #1e293b 0%, #0f172a 100%)'
            }}
        >
            <Container maxWidth="xs">
                <Paper
                    elevation={24}
                    sx={{
                        p: 4,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        bgcolor: 'rgba(30, 41, 59, 0.8)',
                        backdropFilter: 'blur(10px)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: 4
                    }}
                >
                    <Box sx={{ mb: 3, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <Activity size={48} color="#38bdf8" />
                        <Typography variant="h4" sx={{ mt: 2, fontWeight: 'bold', color: '#fff', letterSpacing: 1 }}>
                            AHWR-150 Twin
                        </Typography>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8' }}>
                            Digital Twin Access
                        </Typography>
                    </Box>

                    {authInfo?.ldapEnabled && (
                        <Box sx={{ width: '100%', mb: 1 }}>
                            <ToggleButtonGroup
                                value={provider}
                                exclusive
                                fullWidth
                                size="small"
                                onChange={(_e, v) => { if (v) setProvider(v); }}
                                sx={{
                                    '& .MuiToggleButton-root': { color: '#94a3b8', borderColor: '#475569', textTransform: 'none', py: 0.75 },
                                    '& .Mui-selected': { color: '#fff !important', bgcolor: 'rgba(56,189,248,0.18) !important', borderColor: '#38bdf8 !important' }
                                }}
                            >
                                <ToggleButton value="local">Local account</ToggleButton>
                                <ToggleButton value="domain">Windows Domain</ToggleButton>
                            </ToggleButtonGroup>
                            {domainMode && (
                                <Typography variant="caption" sx={{ display: 'block', color: '#64748b', mt: 0.5, textAlign: 'center' }}>
                                    Sign in with your {authInfo.domain || 'domain'} account
                                </Typography>
                            )}
                        </Box>
                    )}

                    {error && (
                        <Alert severity="error" sx={{ width: '100%', mb: 2, bgcolor: 'rgba(239, 68, 68, 0.1)', color: '#fca5a5' }}>
                            {error}
                        </Alert>
                    )}

                    <Box component="form" onSubmit={handleSubmit} sx={{ width: '100%' }}>
                        <TextField
                            margin="normal"
                            required
                            fullWidth
                            id="username"
                            label={userLabel}
                            name="username"
                            autoComplete="username"
                            autoFocus
                            value={credentials.username}
                            onChange={handleChange}
                            InputProps={{
                                startAdornment: <User size={20} color="#94a3b8" style={{ marginRight: 10 }} />,
                            }}
                            sx={{
                                '& .MuiOutlinedInput-root': {
                                    color: '#fff',
                                    '& fieldset': { borderColor: '#475569' },
                                    '&:hover fieldset': { borderColor: '#94a3b8' },
                                    '&.Mui-focused fieldset': { borderColor: '#38bdf8' },
                                },
                                '& .MuiInputLabel-root': { color: '#94a3b8' },
                                '& .MuiInputLabel-root.Mui-focused': { color: '#38bdf8' }
                            }}
                        />
                        <TextField
                            margin="normal"
                            required
                            fullWidth
                            name="password"
                            label="Password"
                            type="password"
                            id="password"
                            autoComplete="current-password"
                            value={credentials.password}
                            onChange={handleChange}
                            InputProps={{
                                startAdornment: <Lock size={20} color="#94a3b8" style={{ marginRight: 10 }} />,
                            }}
                            sx={{
                                '& .MuiOutlinedInput-root': {
                                    color: '#fff',
                                    '& fieldset': { borderColor: '#475569' },
                                    '&:hover fieldset': { borderColor: '#94a3b8' },
                                    '&.Mui-focused fieldset': { borderColor: '#38bdf8' },
                                },
                                '& .MuiInputLabel-root': { color: '#94a3b8' },
                                '& .MuiInputLabel-root.Mui-focused': { color: '#38bdf8' }
                            }}
                        />
                        <Button
                            type="submit"
                            fullWidth
                            variant="contained"
                            disabled={loading}
                            sx={{
                                mt: 3,
                                mb: 2,
                                py: 1.5,
                                bgcolor: '#38bdf8',
                                '&:hover': { bgcolor: '#0284c7' },
                                fontWeight: 'bold'
                            }}
                        >
                            {loading ? 'Authenticating...' : 'Sign In'}
                        </Button>
                    </Box>
                </Paper>
            </Container>
        </Box>
    );
};

export default Login;
