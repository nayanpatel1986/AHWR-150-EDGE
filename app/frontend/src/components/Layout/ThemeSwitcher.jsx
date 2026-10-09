import React, { useState } from 'react';
import { Box, IconButton, Menu, MenuItem, ListItemIcon, ListItemText, Tooltip, Typography } from '@mui/material';
import { Palette, Check } from 'lucide-react';
import { useThemeMode } from '../../context/ThemeModeContext';

// Theme switcher: a Palette icon button in the AppBar that opens a Menu listing
// the available themes with the active one checked. Selecting applies + persists
// immediately (persistence handled by ThemeModeContext).
export default function ThemeSwitcher() {
    const { themeName, setThemeName, themes } = useThemeMode();
    const [anchorEl, setAnchorEl] = useState(null);
    const open = Boolean(anchorEl);

    const handleOpen = (e) => setAnchorEl(e.currentTarget);
    const handleClose = () => setAnchorEl(null);

    const handleSelect = (name) => {
        setThemeName(name);
        handleClose();
    };

    return (
        <>
            <Tooltip title="Change theme">
                <IconButton
                    onClick={handleOpen}
                    aria-label="Change theme"
                    aria-haspopup="true"
                    aria-expanded={open ? 'true' : undefined}
                    sx={{ color: '#94a3b8', '&:hover': { color: '#38bdf8', bgcolor: 'rgba(56,189,248,0.1)' } }}
                >
                    <Palette size={20} />
                </IconButton>
            </Tooltip>
            <Menu
                anchorEl={anchorEl}
                open={open}
                onClose={handleClose}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                PaperProps={{
                    sx: { minWidth: 245, maxHeight: 430 }
                }}
            >
                <Typography variant="caption" sx={{ display: 'block', px: 2, pt: 1.2, pb: 0.6, color: 'text.secondary', fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase' }}>
                    Select Theme
                </Typography>
                {themes.map((t) => {
                    const selected = t.name === themeName;
                    const primary = t.theme.palette.primary.main;
                    const paper = t.theme.palette.background.paper;
                    return (
                        <MenuItem key={t.name} selected={selected} onClick={() => handleSelect(t.name)}>
                            <ListItemIcon sx={{ minWidth: 32 }}>
                                {selected ? <Check size={16} /> : null}
                            </ListItemIcon>
                            <Box sx={{ width: 34, height: 20, borderRadius: 1, mr: 1.25, border: '1px solid', borderColor: 'divider', bgcolor: paper, overflow: 'hidden' }}>
                                <Box sx={{ width: '45%', height: '100%', bgcolor: primary }} />
                            </Box>
                            <ListItemText primary={t.label} primaryTypographyProps={{ fontWeight: selected ? 800 : 600 }} />
                        </MenuItem>
                    );
                })}
            </Menu>
        </>
    );
}
