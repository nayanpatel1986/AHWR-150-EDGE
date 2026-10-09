'use strict';
const { io: ioClient } = require('socket.io-client');
const { readJson, writeJsonSync } = require('./persist');
const sync = require('./sync');

const STORE_FILE = 'central_messages.json';
const MAX_HISTORY = 500;
let localIo = null;
let centralSocket = null;
let reconnectTimer = null;
let currentKey = '';
let store = readJson(STORE_FILE, { messages: [] }) || { messages: [] };

function persist() {
    store.messages = (store.messages || [])
        .sort((a, b) => Date.parse(b.sentAt || 0) - Date.parse(a.sentAt || 0))
        .slice(0, MAX_HISTORY);
    writeJsonSync(STORE_FILE, store);
}

function safeMessage(row) {
    if (!row?.messageId) return null;
    return {
        messageId: String(row.messageId),
        targetRigId: String(row.targetRigId || ''),
        targetRigName: String(row.targetRigName || row.targetRigId || ''),
        messageType: String(row.messageType || 'General'),
        messageText: String(row.messageText || '').slice(0, 1000),
        senderUsername: String(row.senderUsername || ''),
        senderDisplay: String(row.senderDisplay || row.senderUsername || 'Central Control Room'),
        sentAt: row.sentAt || new Date().toISOString(),
        status: row.status || 'delivered',
        deliveredAt: row.deliveredAt || null,
        acknowledgedAt: row.acknowledgedAt || null,
        acknowledgedBy: row.acknowledgedBy || null,
        dismissedAt: row.dismissedAt || null,
        replies: Array.isArray(row.replies) ? row.replies.slice(-50) : [],
    };
}

function snapshot() {
    const messages = [...(store.messages || [])].sort((a, b) => Date.parse(b.sentAt || 0) - Date.parse(a.sentAt || 0));
    return {
        connected: !!centralSocket?.connected,
        unreadCount: messages.filter((m) => !m.acknowledgedAt).length,
        messages,
    };
}

function emitAll() {
    if (localIo) localIo.emit('central_messages_update', snapshot());
}

function sendDelivered(messageId) {
    if (centralSocket?.connected) centralSocket.emit('edge_message_delivered', { messageId });
}

function sendOutgoingState() {
    if (!centralSocket?.connected) return;
    for (const msg of store.messages || []) {
        if (!msg?.messageId) continue;
        centralSocket.emit('edge_message_delivered', { messageId: msg.messageId });
        if (msg.acknowledgedAt) {
            centralSocket.emit('edge_message_ack', {
                messageId: msg.messageId,
                acknowledgedBy: msg.acknowledgedBy || 'edge',
            });
        }
        for (const row of Array.isArray(msg.replies) ? msg.replies : []) {
            centralSocket.emit('edge_message_reply', row);
        }
    }
}

function upsertIncoming(row, { popup = true } = {}) {
    const msg = safeMessage(row);
    if (!msg) return null;
    const existingIndex = store.messages.findIndex((m) => m.messageId === msg.messageId);
    if (existingIndex >= 0) {
        store.messages[existingIndex] = { ...store.messages[existingIndex], ...msg };
        persist();
        sendDelivered(msg.messageId);
        emitAll();
        return store.messages[existingIndex];
    }
    msg.status = 'delivered';
    msg.deliveredAt = msg.deliveredAt || new Date().toISOString();
    store.messages.unshift(msg);
    persist();
    sendDelivered(msg.messageId);
    emitAll();
    if (popup && localIo) localIo.emit('central_message', msg);
    return msg;
}

function receiveBatch(rows) {
    for (const row of Array.isArray(rows) ? rows : []) upsertIncoming(row, { popup: true });
}

function connect() {
    const cfg = sync.getStatus();
    if (!cfg.enabled || !cfg.centralUrl || !cfg.deviceId) return;
    const savedToken = readJson('sync_config.json', {})?.deviceToken || '';
    const token = savedToken || process.env.DEVICE_TOKEN || '';
    const nextKey = `${cfg.centralUrl}|${cfg.deviceId}|${token ? 'token' : 'no-token'}`;
    if (centralSocket && currentKey === nextKey) return;
    currentKey = nextKey;
    if (centralSocket) centralSocket.disconnect();
    centralSocket = ioClient(cfg.centralUrl, {
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 15000,
        auth: { edge: true, deviceId: cfg.deviceId, token },
    });
    centralSocket.on('connect', () => {
        console.log(`[central-messages] connected to ${cfg.centralUrl} as ${cfg.deviceId}`);
        sendOutgoingState();
        emitAll();
    });
    centralSocket.on('disconnect', (reason) => {
        console.warn(`[central-messages] disconnected: ${reason}`);
        emitAll();
    });
    centralSocket.on('central_message', (row) => upsertIncoming(row, { popup: true }));
    centralSocket.on('central_messages:batch', receiveBatch);
    centralSocket.on('connect_error', (err) => {
        if (err?.message) console.warn('[central-messages] connect error:', err.message);
        emitAll();
    });
}

function reconnectNow() {
    currentKey = '';
    connect();
}

function start(ioRef) {
    localIo = ioRef;
    connect();
    reconnectTimer = setInterval(connect, 30000);
}

function stop() {
    if (reconnectTimer) clearInterval(reconnectTimer);
    if (centralSocket) centralSocket.disconnect();
}

function dismiss(messageId) {
    const msg = store.messages.find((m) => m.messageId === messageId);
    if (!msg) return null;
    msg.dismissedAt = new Date().toISOString();
    persist();
    emitAll();
    return msg;
}

function acknowledge(messageId, user) {
    const msg = store.messages.find((m) => m.messageId === messageId);
    if (!msg) return null;
    msg.acknowledgedAt = msg.acknowledgedAt || new Date().toISOString();
    msg.acknowledgedBy = user?.display || user?.username || 'edge';
    msg.status = 'acknowledged';
    persist();
    if (centralSocket?.connected) {
        console.log(`[central-messages] sending ack ${messageId}`);
        centralSocket.emit('edge_message_ack', { messageId, acknowledgedBy: msg.acknowledgedBy });
    }
    emitAll();
    return msg;
}

function reply(messageId, text, user) {
    const msg = store.messages.find((m) => m.messageId === messageId);
    if (!msg) return null;
    const replyText = String(text || '').trim().slice(0, 1000);
    if (!replyText) throw Object.assign(new Error('Reply text is required'), { status: 400 });
    const row = {
        replyId: `${messageId}-${Date.now()}`,
        messageId,
        replyText,
        repliedAt: new Date().toISOString(),
        repliedBy: user?.display || user?.username || 'edge',
        deviceId: sync.getStatus()?.deviceId || '',
    };
    msg.replies = [...(msg.replies || []), row].slice(-50);
    msg.status = 'replied';
    persist();
    if (centralSocket?.connected) {
        console.log(`[central-messages] sending reply ${row.replyId} for ${messageId}`);
        centralSocket.emit('edge_message_reply', row);
    } else {
        console.warn(`[central-messages] queued reply ${row.replyId} for ${messageId}; central socket is offline`);
    }
    sync.enqueueEvent('central_message.reply', row);
    emitAll();
    return msg;
}

module.exports = { start, stop, snapshot, dismiss, acknowledge, reply, reconnectNow };
