const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: '1gb' }));

const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 1e9
});

class RoomManager {
    constructor() {
        this.rooms = new Map();
        this.clientToRoom = new Map();
        this.socketToClient = new Map();
        this.destructionTimeouts = new Map();
    }

    createRoom(socketId, clientId) {
        const roomId = this.generateCode();
        const room = {
            id: roomId,
            hostId: socketId,
            hostClientId: clientId,
            guests: new Map(),
            fileInfo: null,
            currentMode: 'file',
            transferState: { active: false, chunkIndex: 0, totalChunks: 0, fileId: null },
            createdAt: Date.now()
        };
        this.rooms.set(roomId, room);
        this.clientToRoom.set(clientId, roomId);
        this.socketToClient.set(socketId, clientId);
        console.log(`[ROOM] ✅ ${roomId} creata da host ${clientId}`);
        return room;
    }

    joinRoom(roomId, socketId, clientId) {
        const room = this.rooms.get(roomId);
        if (!room) return { error: 'NOT_FOUND' };
        if (room.guests.size >= 10) return { error: 'FULL' };
        room.guests.set(socketId, clientId);
        this.clientToRoom.set(clientId, roomId);
        this.socketToClient.set(socketId, clientId);
        return room;
    }

    rejoinHost(clientId, socketId) {
        const roomId = this.clientToRoom.get(clientId);
        if (!roomId) return null;
        const room = this.rooms.get(roomId);
        if (!room) return null;
        if (this.destructionTimeouts.has(roomId)) {
            clearTimeout(this.destructionTimeouts.get(roomId));
            this.destructionTimeouts.delete(roomId);
        }
        this.socketToClient.delete(room.hostId);
        room.hostId = socketId;
        this.socketToClient.set(socketId, clientId);
        return room;
    }

    rejoinGuest(clientId, socketId) {
        const roomId = this.clientToRoom.get(clientId);
        if (!roomId) return null;
        const room = this.rooms.get(roomId);
        if (!room) return null;
        for (let [oldSocket, oldClient] of room.guests.entries()) {
            if (oldClient === clientId) {
                room.guests.delete(oldSocket);
                this.socketToClient.delete(oldSocket);
                break;
            }
        }
        room.guests.set(socketId, clientId);
        this.socketToClient.set(socketId, clientId);
        return room;
    }

    startDestructionTimer(roomId) {
        if (this.destructionTimeouts.has(roomId)) return;
        const timeout = setTimeout(() => {
            const room = this.rooms.get(roomId);
            if (room) {
                console.log(`[ROOM] 💥 Stanza ${roomId} distrutta (timeout host)`);
                io.to(roomId).emit('host-disconnected');
                this.clientToRoom.delete(room.hostClientId);
                room.guests.forEach((clientId, socketId) => {
                    this.clientToRoom.delete(clientId);
                    this.socketToClient.delete(socketId);
                });
                this.rooms.delete(roomId);
                this.destructionTimeouts.delete(roomId);
            }
        }, 60000);
        this.destructionTimeouts.set(roomId, timeout);
    }

    getRoomBySocket(socketId) {
        const clientId = this.socketToClient.get(socketId);
        if (!clientId) return null;
        const roomId = this.clientToRoom.get(clientId);
        return roomId ? this.rooms.get(roomId) : null;
    }

    removeSocket(socketId) {
        const clientId = this.socketToClient.get(socketId);
        if (!clientId) return null;
        const roomId = this.clientToRoom.get(clientId);
        if (!roomId) return null;
        const room = this.rooms.get(roomId);
        if (!room) return null;
        if (room.hostId === socketId) {
            this.startDestructionTimer(roomId);
            return { isHost: true, roomId, guests: Array.from(room.guests.keys()) };
        }
        if (room.guests.has(socketId)) {
            room.guests.delete(socketId);
            this.clientToRoom.delete(clientId);
            this.socketToClient.delete(socketId);
            return { isHost: false, roomId, hostId: room.hostId, leaver: socketId };
        }
        return null;
    }

    generateCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code;
        do {
            code = '';
            for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
        } while (this.rooms.has(code));
        return code;
    }
}

const rooms = new RoomManager();

app.get('/', (req, res) => {
    res.json({ status: 'ok', rooms: rooms.rooms.size, uptime: process.uptime() });
});

app.get('/turn-credentials', (req, res) => {
    res.json({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
        ]
    });
});

io.on('connection', (socket) => {
    const clientId = socket.handshake.query.clientId;
    console.log(`[CONNECT] 🔌 ${socket.id} | client:${clientId}`);

    socket.on('create-room', (cb) => {
        const room = rooms.createRoom(socket.id, clientId);
        socket.join(room.id);
        cb({ success: true, roomId: room.id });
    });

    socket.on('join-room', (roomId, cb) => {
        const result = rooms.joinRoom(roomId, socket.id, clientId);
        if (result.error) return cb({ success: false, error: result.error });
        socket.join(roomId);
        socket.to(result.hostId).emit('guest-joined', { guestId: socket.id, count: result.guests.size });
        cb({ success: true, roomId, hostId: result.hostId, fileInfo: result.fileInfo, currentMode: result.currentMode||'file' });
    });

    socket.on('host-rejoin', ({ roomId }, cb) => {
        const room = rooms.rejoinHost(clientId, socket.id);
        if (!room) return cb({ success: false, error: 'Stanza non trovata' });
        socket.join(roomId);
        const guestList = Array.from(room.guests.keys());
        socket.emit('host-restored', { guests: guestList });
        socket.to(roomId).emit('host-back');
        cb({ success: true, fileInfo: room.fileInfo });
    });

    socket.on('guest-rejoin', ({ roomId }, cb) => {
        const room = rooms.rejoinGuest(clientId, socket.id);
        if (!room) return cb({ success: false, error: 'Stanza non trovata' });
        socket.join(roomId);
        socket.to(room.hostId).emit('guest-joined', { guestId: socket.id, count: room.guests.size });
        cb({ success: true, hostId: room.hostId, fileInfo: room.fileInfo });
    });

    socket.on('file-info', (info, cb) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room || room.hostId !== socket.id) return cb?.({ error: 'NOT_HOST' });
        room.fileInfo = info;
        socket.to(room.id).emit('file-available', info);
        cb?.({ success: true });
    });

    socket.on('transfer-state', (state, cb) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room || room.hostId !== socket.id) return;
        room.transferState = state;
        cb?.({ success: true });
    });

    socket.on('guest-ready', () => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) return;
        socket.to(room.hostId).emit('guest-ready', { guestId: socket.id });
    });

    // ----------------------------------------------------------------
    // PLAY / PAUSE - broadcast a tutta la stanza tranne il mittente
    // ----------------------------------------------------------------
    socket.on('play-command', ({ roomId, scheduledWallclock, sentAt, type }) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) return;
        console.log(`[PLAY] ▶ stanza ${room.id} scheduledWallclock:${scheduledWallclock}`);
        // Invia a tutti i guest (tutti i membri della room tranne l'host)
        socket.to(room.id).emit('play-command', { scheduledWallclock, sentAt, type });
    });

    socket.on('pause-command', ({ roomId }) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) return;
        console.log(`[PAUSE] ⏸ stanza ${room.id}`);
        socket.to(room.id).emit('pause-command');
    });

    // ----------------------------------------------------------------
    // GUEST -> HOST: audio sbloccato e file pronto
    // ----------------------------------------------------------------
    socket.on('guest-audio-unlocked', ({ roomId }) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) return;
        console.log(`[AUDIO] 🔊 guest ${socket.id} audio unlocked in ${room.id}`);
        socket.to(room.hostId).emit('guest-audio-unlocked', { guestId: socket.id });
    });

    socket.on('guest-ready-for-play', ({ roomId }) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) return;
        console.log(`[READY] ✅ guest ${socket.id} pronto in ${room.id}`);
        socket.to(room.hostId).emit('guest-ready-for-play', { guestId: socket.id });
    });

    // ----------------------------------------------------------------
    // SIGNALING WebRTC (offer/answer/ice + play-command diretto)
    // ----------------------------------------------------------------
    socket.on('signal', ({ to, type, data }) => {
        socket.to(to).emit('signal', { from: socket.id, type, data });
    });

    // ----------------------------------------------------------------
    // SOUNDCLOUD SYNC EVENTS
    // ----------------------------------------------------------------
    socket.on('sc-load', ({ roomId, url }) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) return;
        socket.to(room.id).emit('sc-load', { url });
    });

    socket.on('sc-play-command', ({ roomId, scheduledWallclock, sentAt, position, url }) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) return;
        socket.to(room.id).emit('sc-play-command', { scheduledWallclock, sentAt, position, url });
    });

    socket.on('sc-pause', ({ roomId }) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) return;
        socket.to(room.id).emit('sc-pause');
    });

    socket.on('stem-mode', ({ roomId, mode }) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) return;
        socket.to(room.id).emit('stem-mode', { mode });
    });

    socket.on('mode-switch', ({ roomId, mode }) => {
        const room = rooms.getRoomBySocket(socket.id);
        if (!room) return;
        room.currentMode = mode; // persiste la modalità per i guest che entrano dopo
        socket.to(room.id).emit('mode-switch', { mode });
    });

    // ----------------------------------------------------------------
    // RELAY CHUNK (fallback quando WebRTC non disponibile)
    // ----------------------------------------------------------------
    socket.on('relay-chunk', ({ roomId, chunk, index, total, isLast }) => {
        socket.to(roomId).emit('relay-chunk', { from: socket.id, chunk, index, total, isLast });
    });

    // ----------------------------------------------------------------
    // DISCONNECT
    // ----------------------------------------------------------------
    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] ❌ ${socket.id}`);
        const result = rooms.removeSocket(socket.id);
        if (!result) return;
        if (result.isHost) {
            io.to(result.roomId).emit('host-away');
            console.log(`[ROOM] ⏳ Host away stanza ${result.roomId}`);
        } else {
            io.to(result.hostId).emit('guest-left', {
                guestId: result.leaver,
                remaining: rooms.rooms.get(result.roomId)?.guests.size || 0
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] 🚀 P2P Cinema - Porta ${PORT}`);
});
