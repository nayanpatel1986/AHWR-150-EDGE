import React, { useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Badge,
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    Paper,
    Stack,
    TextField,
    Typography
} from '@mui/material';
import { Bell, CheckCircle2, History, Send, X } from 'lucide-react';
import axios from '../../api';
import { socket } from '../../socket';

const byNewest = (messages = []) => [...messages].sort((a, b) => Date.parse(b.sentAt || 0) - Date.parse(a.sentAt || 0));

function playBeep() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.value = 0.05;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        setTimeout(() => { osc.stop(); ctx.close(); }, 180);
    } catch { /* browser may block sound until user interaction */ }
}

export default function CentralMessages() {
    const [messages, setMessages] = useState([]);
    const [popup, setPopup] = useState(null);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [error, setError] = useState('');
    const [replyDrafts, setReplyDrafts] = useState({});

    const unreadCount = useMemo(() => messages.filter((m) => !m.acknowledgedAt).length, [messages]);
    const load = () => {
        axios.get('/api/central-messages')
            .then(({ data }) => setMessages(byNewest(data?.messages || [])))
            .catch((e) => setError(e?.response?.data?.error || 'Failed to load central messages'));
    };

    useEffect(() => {
        load();
        const onUpdate = (snapshot) => setMessages(byNewest(snapshot?.messages || []));
        const onMessage = (message) => {
            setPopup(message);
            setMessages((prev) => byNewest([message, ...prev.filter((m) => m.messageId !== message.messageId)]));
            playBeep();
        };
        socket.on('central_messages_update', onUpdate);
        socket.on('central_message', onMessage);
        return () => {
            socket.off('central_messages_update', onUpdate);
            socket.off('central_message', onMessage);
        };
    }, []);

    const acknowledge = async (messageId) => {
        try {
            const { data } = await axios.post(`/api/central-messages/${encodeURIComponent(messageId)}/ack`);
            setMessages((prev) => byNewest([data, ...prev.filter((m) => m.messageId !== data.messageId)]));
            if (popup?.messageId === messageId) setPopup(null);
        } catch (e) {
            setError(e?.response?.data?.error || 'Acknowledge failed');
        }
    };

    const dismiss = async (messageId) => {
        try { await axios.post(`/api/central-messages/${encodeURIComponent(messageId)}/dismiss`); }
        catch { /* close locally even if backend update fails */ }
        if (popup?.messageId === messageId) setPopup(null);
    };

    const sendReply = async (messageId) => {
        const text = (replyDrafts[messageId] || '').trim();
        if (!text) return;
        try {
            const { data } = await axios.post(`/api/central-messages/${encodeURIComponent(messageId)}/reply`, { text });
            setMessages((prev) => byNewest([data, ...prev.filter((m) => m.messageId !== data.messageId)]));
            if (popup?.messageId === messageId) setPopup(data);
            setReplyDrafts((prev) => ({ ...prev, [messageId]: '' }));
        } catch (e) {
            setError(e?.response?.data?.error || 'Reply failed');
        }
    };

    const renderMessage = (m) => (
        <Paper key={m.messageId} variant="outlined" sx={{ p: 1.25, bgcolor: '#0f172a', borderColor: 'rgba(56,189,248,.25)' }}>
            <Stack direction="row" justifyContent="space-between" spacing={1}>
                <Typography fontWeight={900} color="#38bdf8">{m.messageType || 'General'} · Central Control Room</Typography>
                <Typography variant="caption" color="text.secondary">{m.sentAt ? new Date(m.sentAt).toLocaleString() : '--'}</Typography>
            </Stack>
            <Typography sx={{ my: 1 }}>{m.messageText}</Typography>
            <Typography variant="caption" color="text.secondary">
                From {m.senderDisplay || m.senderUsername || 'Central'} · Rig {m.targetRigName || m.targetRigId}
                {m.acknowledgedAt ? ` · ACK by ${m.acknowledgedBy || 'edge'}` : ''}
            </Typography>
            {(m.replies || []).length > 0 && (
                <Stack spacing={0.5} sx={{ mt: 1 }}>
                    {(m.replies || []).map((r) => (
                        <Box key={r.replyId || r.repliedAt} sx={{ borderLeft: '3px solid #22c55e', pl: 1, color: '#d1fae5' }}>
                            <Typography variant="caption" fontWeight={800}>Reply by {r.repliedBy || 'edge'} ? {r.repliedAt ? new Date(r.repliedAt).toLocaleString() : '--'}</Typography>
                            <Typography variant="body2">{r.replyText}</Typography>
                        </Box>
                    ))}
                </Stack>
            )}
            <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center">
                <TextField
                    size="small"
                    fullWidth
                    placeholder="Type reply to Central Message Centre"
                    value={replyDrafts[m.messageId] || ''}
                    onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [m.messageId]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') sendReply(m.messageId); }}
                    inputProps={{ maxLength: 1000 }}
                    sx={{
                        '& .MuiInputBase-root': { bgcolor: '#020617', color: 'white' },
                        '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(56,189,248,.35)' },
                    }}
                />
                <Button size="small" variant="contained" startIcon={<Send size={15} />} onClick={() => sendReply(m.messageId)}>
                    Reply
                </Button>
            </Stack>
            {!m.acknowledgedAt && (
                <Box sx={{ mt: 1 }}>
                    <Button size="small" variant="contained" startIcon={<CheckCircle2 size={16} />} onClick={() => acknowledge(m.messageId)}>Acknowledge</Button>
                </Box>
            )}
        </Paper>
    );

    return (
        <>
            <Box sx={{
                position: 'fixed',
                left: { xs: 18, md: 42 },
                bottom: 18,
                zIndex: 1600,
            }}>
                <Badge badgeContent={unreadCount} color="error">
                    <Button
                        variant="contained"
                        startIcon={<History size={18} />}
                        onClick={() => setHistoryOpen(true)}
                        sx={{ bgcolor: '#0ea5e9', fontWeight: 900, px: 2.2, minWidth: 210, justifyContent: 'flex-start' }}
                    >
                        Central Messages
                    </Button>
                </Badge>
            </Box>
            <Dialog open={!!popup} onClose={() => dismiss(popup?.messageId)} maxWidth="sm" fullWidth PaperProps={{ sx: { bgcolor: '#172235', color: 'white', border: '1px solid #38bdf8' } }}>
                {popup && (
                    <>
                        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, color: '#38bdf8', fontWeight: 900 }}>
                            <Bell size={22} /> Message from Central Control Room
                            <IconButton onClick={() => dismiss(popup.messageId)} sx={{ ml: 'auto', color: '#94a3b8' }}><X size={18} /></IconButton>
                        </DialogTitle>
                        <DialogContent>{renderMessage(popup)}</DialogContent>
                        <DialogActions>
                            <Button onClick={() => dismiss(popup.messageId)}>Close</Button>
                            <Button variant="contained" startIcon={<CheckCircle2 size={18} />} onClick={() => acknowledge(popup.messageId)}>Acknowledge</Button>
                        </DialogActions>
                    </>
                )}
            </Dialog>
            <Dialog open={historyOpen} onClose={() => setHistoryOpen(false)} maxWidth="md" fullWidth PaperProps={{ sx: { bgcolor: '#172235', color: 'white' } }}>
                <DialogTitle sx={{ color: '#38bdf8', fontWeight: 900 }}>Central Message History</DialogTitle>
                <DialogContent>
                    {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
                    <Stack spacing={1}>{messages.length ? messages.map(renderMessage) : <Typography color="text.secondary">No central messages received.</Typography>}</Stack>
                </DialogContent>
                <DialogActions><Button onClick={() => setHistoryOpen(false)}>Close</Button></DialogActions>
            </Dialog>
        </>
    );
}
